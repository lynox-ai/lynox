import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { renameSync } from 'node:fs';
import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { getLynoxDir } from './config.js';
import { CRYPTO_ALGORITHM, CRYPTO_KEY_LENGTH, CRYPTO_IV_LENGTH, CRYPTO_TAG_LENGTH } from './crypto-constants.js';
import { ensureDirSync } from './atomic-write.js';

/**
 * EngineDb — the consolidated per-tenant subject-graph store (Foundation Rework v2, S0).
 *
 * This is the NEW baseline for the "engine.db" file in the 3-file target topology
 * (engine.db + history.db + vault.db). S0 provisions the EMPTY schema only: the
 * subject-graph NOUNs (Subject/Memory/Connection/Artifact) + the verb-layer
 * (Workflow/Trigger/Task — Run stays in history.db) + conflict tracking.
 *
 * S0 invariants (do not break without re-reading PRD-FOUNDATION-REWORK-V2):
 *   - Additive: this file is created ALONGSIDE the legacy 6 DB files; nothing
 *     reads or writes it yet. S1 re-points the read/write paths; S2 does the
 *     one-time data re-map + folds the legacy files in + deletes them.
 *   - The `threads` spine (threads/thread_messages/pending_prompts) IS created
 *     here, so `memories.source_thread_id` + `artifacts.thread_id` are REAL FKs.
 *     Three reference classes stay SOFT (bare TEXT) by design, NOT FK:
 *       · `*.source_run_id` / `created_in_run_id` — `runs` lives in history.db
 *         permanently (accepted cross-file softness; runs are append-only logs);
 *       · `*.scope_type`/`scope_id` — the `scopes` axis consolidates at S2;
 *       · `memories.superseded_by` — a denormalized pointer; the `supersedes`
 *         join table is the FK'd source of truth.
 *     The legacy inbox/datastore/policy tables likewise fold in at S2 (verbatim
 *     ATTACH-copy, no re-authoring). Every OTHER reference below is an intra-file
 *     FK with real cascade.
 *   - Encryption posture mirrors RunHistory (D2): at-rest AES-256-GCM via an
 *     HKDF-derived key from the vault key. The S1 store classes that share this
 *     connection call `enc()`/`dec()` for sensitive columns.
 *
 * Migration mechanics follow AgentMemoryDb/RunHistory: a `schema_version` table,
 * txn-per-step runner, and each MIGRATIONS[i] stamps version i+1 BEFORE its DDL
 * inside one transaction (so a crash can't bump the version past un-applied DDL).
 */

const ENGINE_HKDF_INFO = 'lynox-engine-encryption';
const ENCRYPTED_PREFIX = 'enc:';

function getDefaultDbPath(): string {
  return join(getLynoxDir(), 'engine.db');
}

// ── Migration SQL ───────────────────────────────────────────────
//
// v1 = the full S0 baseline. A fresh install gets this single clean CREATE per
// table (the legacy 43/5/16-step replays collapse into one baseline). Forward
// FK references (e.g. relationships → memories) are fine in one exec(): SQLite
// defers parent-table existence to row-DML, and all tables are created together.

const MIGRATIONS: string[] = [
  // v1: Foundation Rework v2 — subject-graph baseline (subjects + verb-layer)
  `INSERT OR IGNORE INTO schema_version (version) VALUES (1);

   -- ── NOUNS: the subject graph ──────────────────────────────────
   -- Core node table. Absorbs entities/relations/CRM-contacts/inbox-senders.
   -- The canonical-UNIQUE index is the dedup guard the legacy 'entities' table never had.
   CREATE TABLE subjects (
     id            TEXT PRIMARY KEY,
     kind          TEXT NOT NULL,              -- person|organization|engagement|product|service|other
     name          TEXT NOT NULL,
     aliases       TEXT NOT NULL DEFAULT '[]', -- JSON array
     is_self       INTEGER NOT NULL DEFAULT 0, -- 1 = one of the operator's OWN firms (MULTIPLE allowed)
     parent_id     TEXT REFERENCES subjects(id) ON DELETE SET NULL,
     status        TEXT,
     owner_user_id TEXT NOT NULL DEFAULT 'system',
     embedding     BLOB,
     archived_at   TEXT,
     created_at    TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
   );
   -- Canonical dedup guard the legacy 'entities' table never had — but scoped to
   -- the IDENTITY-BY-NAME kinds. An engagement's identity is provider×client×period
   -- (not its name) and two same-named products/services can legitimately coexist;
   -- name-dedup is only correct for person/organization. NOTE: 'name' MUST stay
   -- PLAINTEXT (never enc()'d) — this index is on LOWER(name), and random-IV GCM
   -- ciphertext would defeat dedup (AquaNatura×3 would slip through). S1 encrypts
   -- only non-indexed sensitive columns (people.email/phone, memories.text).
   CREATE UNIQUE INDEX idx_subjects_canonical
     ON subjects(LOWER(name), kind, owner_user_id)
     WHERE archived_at IS NULL AND kind IN ('person','organization');
   CREATE INDEX idx_subjects_kind     ON subjects(kind);
   CREATE INDEX idx_subjects_self     ON subjects(is_self);
   CREATE INDEX idx_subjects_parent   ON subjects(parent_id);
   CREATE INDEX idx_subjects_archived ON subjects(archived_at);

   -- 1:1 detail tables (present only for the matching kind).
   CREATE TABLE people (
     subject_id TEXT PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
     email TEXT, phone TEXT, role TEXT,
     type TEXT NOT NULL DEFAULT 'contact'      -- customer|lead|partner|employee|contact|other
   );
   CREATE TABLE organizations (
     subject_id TEXT PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
     domain TEXT, vat_id TEXT, country TEXT,
     type TEXT NOT NULL DEFAULT 'other'        -- customer|lead|partner|vendor|other
   );
   -- engagement = customer × OWN-firm × time. provider/client make the
   -- multi-firm dimension EXPLICIT so a customer shared across two of the
   -- operator's firms is ONE subject with TWO engagements (no duplicate).
   -- Lifecycle lives on subjects.status (the generic, kind-specific status field) —
   -- NOT a second engagements.state, which would encode it twice with no authority.
   CREATE TABLE engagements (
     subject_id          TEXT PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
     provider_subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,  -- the is_self firm
     client_subject_id   TEXT REFERENCES subjects(id) ON DELETE SET NULL,  -- the customer
     started_at TEXT, ended_at TEXT, budget_cents INTEGER, currency TEXT,
     billing_model TEXT
   );
   CREATE INDEX idx_engagements_provider ON engagements(provider_subject_id);
   CREATE INDEX idx_engagements_client   ON engagements(client_subject_id);
   CREATE TABLE products (
     subject_id TEXT PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
     sku TEXT, price_cents INTEGER, currency TEXT
   );
   CREATE TABLE services (
     subject_id TEXT PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
     hourly_rate_cents INTEGER, currency TEXT
   );

   -- ── SPINE: threads / thread_messages / pending_prompts ─────────
   -- The durable interaction + reasoning log. Authored to match the live v43
   -- history.db shape verbatim (so the S2 data-move is a pure INSERT..SELECT),
   -- plus primary_subject_id — so the memories/artifacts → threads FKs are REAL
   -- here, not soft. Empty in S0; live threads stay in history.db until S2.
   CREATE TABLE threads (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL DEFAULT '',
     model_tier TEXT NOT NULL DEFAULT 'sonnet',
     context_id TEXT NOT NULL DEFAULT '',
     message_count INTEGER NOT NULL DEFAULT 0,
     total_tokens INTEGER NOT NULL DEFAULT 0,
     total_cost_usd REAL NOT NULL DEFAULT 0,
     summary TEXT,
     summary_up_to INTEGER NOT NULL DEFAULT 0,
     is_archived INTEGER NOT NULL DEFAULT 0,
     is_favorite INTEGER NOT NULL DEFAULT 0,
     skip_extraction INTEGER NOT NULL DEFAULT 0,
     is_unread INTEGER NOT NULL DEFAULT 0,
     primary_subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,  -- NEW: default subject for this thread's writes
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_threads_updated  ON threads(updated_at);
   CREATE INDEX idx_threads_archived ON threads(is_archived);
   CREATE INDEX idx_threads_favorite ON threads(is_favorite);
   CREATE INDEX idx_threads_subject  ON threads(primary_subject_id);

   CREATE TABLE thread_messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     role TEXT NOT NULL,
     content_json TEXT NOT NULL,
     usage_json TEXT,
     display_only INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_thread_messages_thread ON thread_messages(thread_id, seq);

   CREATE TABLE pending_prompts (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     prompt_type TEXT NOT NULL CHECK(prompt_type IN ('ask_user','ask_secret','connect_mail')),
     question TEXT NOT NULL,
     options_json TEXT,
     secret_name TEXT,
     secret_key_type TEXT,
     answer TEXT,
     answer_saved INTEGER,
     status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','expired')),
     questions_json TEXT,
     partial_answers_json TEXT,
     answer_error TEXT,
     multi_select INTEGER,
     payload_json TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     answered_at TEXT,
     expires_at TEXT NOT NULL
   );
   CREATE INDEX idx_pending_prompts_session ON pending_prompts(session_id, status);
   CREATE UNIQUE INDEX idx_pending_prompts_session_unique
     ON pending_prompts(session_id) WHERE status = 'pending';

   -- ── NOUNS: memory (provenance-stamped statement) + kg adjuncts ──
   -- subject_id is the canonical attachment. source_thread_id is a REAL FK (the
   -- spine is in this file); source_run_id stays soft (runs in history.db).
   CREATE TABLE memories (
     id TEXT PRIMARY KEY,
     text TEXT NOT NULL,
     namespace TEXT NOT NULL,
     subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
     scope_type TEXT NOT NULL,
     scope_id TEXT NOT NULL,
     source_run_id TEXT,            -- soft ref → history.db runs (permanent cross-file softness)
     source_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,  -- REAL FK (spine in-file)
     source_type TEXT NOT NULL DEFAULT 'agent_inferred',
     source_tool_name TEXT,
     provider TEXT,
     embedding BLOB,
     confidence REAL NOT NULL DEFAULT 0.75,
     is_active INTEGER NOT NULL DEFAULT 1,
     superseded_by TEXT,
     retrieval_count INTEGER NOT NULL DEFAULT 0,
     confirmation_count INTEGER NOT NULL DEFAULT 0,
     last_retrieved_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_memories_subject ON memories(subject_id);
   CREATE INDEX idx_memories_scope   ON memories(scope_type, scope_id);
   CREATE INDEX idx_memories_active  ON memories(is_active);
   CREATE INDEX idx_memories_thread  ON memories(source_thread_id);  -- FK child: thread-delete SET NULL

   -- memory_subjects replaces legacy 'mentions' (memory↔entity → memory↔subject).
   CREATE TABLE memory_subjects (
     memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
     subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
     mention_type TEXT NOT NULL DEFAULT 'direct',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (memory_id, subject_id)
   );
   -- Reverse-side index: SQLite does NOT auto-index FK children, so the
   -- "which memories mention subject X" read AND the subject-delete CASCADE would
   -- full-scan the junction without this (subject_id is the trailing PK column).
   CREATE INDEX idx_memory_subjects_subject ON memory_subjects(subject_id);

   -- subject_cooccurrences = a DERIVED materialization (the pairwise co-mention
   -- count over a memory's memory_subjects), kept as a table for graph-traversal
   -- perf like the legacy 'cooccurrences' — NOT a third semantic edge primitive
   -- (relationships is the asserted edge; this is a denormalized index of it).
   CREATE TABLE subject_cooccurrences (
     subject_a_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
     subject_b_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
     count INTEGER NOT NULL DEFAULT 1,
     last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (subject_a_id, subject_b_id)
   );
   CREATE INDEX idx_subject_cooccur_b ON subject_cooccurrences(subject_b_id);

   CREATE TABLE supersedes (
     new_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
     old_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
     reason TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (new_memory_id, old_memory_id)
   );
   CREATE INDEX idx_supersedes_old ON supersedes(old_memory_id);

   -- Typed edges between subjects. description is meant to be FILLED (the legacy
   -- relations.description='' context-free-edge gap is fixed forward in S1).
   CREATE TABLE relationships (
     id               TEXT PRIMARY KEY,
     from_subject_id  TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
     to_subject_id    TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
     kind             TEXT NOT NULL,
     description      TEXT NOT NULL DEFAULT '',
     source_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
     confidence       REAL NOT NULL DEFAULT 1.0,
     since TEXT, until TEXT, notes TEXT,
     created_at       TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_rel_from ON relationships(from_subject_id, kind);
   CREATE INDEX idx_rel_to   ON relationships(to_subject_id, kind);
   CREATE INDEX idx_rel_kind ON relationships(kind);
   CREATE INDEX idx_rel_source_memory ON relationships(source_memory_id);  -- FK child: memory-delete SET NULL

   -- ── NOUNS: Connection + Artifact ──────────────────────────────
   -- Credential-bearing capability. Absorbs api_profiles (flat JSON today),
   -- mail_accounts config, oauth-token refs, push_subscriptions. NO secrets
   -- here — secrets stay in vault.db; vault_keys holds their names.
   CREATE TABLE connections (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,                       -- api|mail|google|push|...
     name TEXT NOT NULL,
     subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
     direction TEXT,                           -- inbound|outbound|both
     config_json TEXT NOT NULL DEFAULT '{}',   -- base_url/endpoints/auth-SHAPE
     vault_keys TEXT NOT NULL DEFAULT '[]',    -- JSON array of vault.db secret names
     status TEXT NOT NULL DEFAULT 'active',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_connections_kind    ON connections(kind);
   CREATE INDEX idx_connections_subject ON connections(subject_id);

   -- Versioned GENERATED output (documents ride memory, NOT here).
   CREATE TABLE artifacts (
     id TEXT PRIMARY KEY,
     subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
     type TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     content_path TEXT,
     content_text TEXT,
     description TEXT,
     thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,  -- REAL FK (spine in-file)
     created_in_run_id TEXT,                   -- soft ref → history.db runs
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_artifacts_subject ON artifacts(subject_id);
   CREATE INDEX idx_artifacts_thread  ON artifacts(thread_id);  -- FK child: thread-delete SET NULL

   -- ── VERBS: Workflow / Trigger / Task (Run stays in history.db) ──
   -- Promotes the legacy PlannedPipeline (a pipeline_runs row, status='planned',
   -- with a manifest_json.template flag) to a first-class table + real column.
   CREATE TABLE workflows (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     definition_json TEXT NOT NULL,            -- serialized PlannedPipeline
     is_template INTEGER NOT NULL DEFAULT 0,   -- the JSON template flag → real column
     source_run_id TEXT,                       -- soft ref → history.db runs (captured-from)
     status TEXT NOT NULL DEFAULT 'active',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_workflows_template ON workflows(is_template);

   -- FIRE: dormant source·condition·target·params → mints a Run. 'source' stays a
   -- field (cron/watch/webhook/inbox_event), NOT collapsed into one typed thing.
   CREATE TABLE triggers (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT 'manual',    -- cron|watch|webhook|inbox_event|manual
     -- An INBOUND trigger's source IS a Connection (PRD §inbound): a REAL FK, not a
     -- soft pointer buried in condition_json — that would re-introduce the exact
     -- cross-ref softness this consolidation exists to kill (a second seam).
     source_connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
     condition_json TEXT NOT NULL DEFAULT '{}',-- schedule_cron / watch_config / webhook spec
     target_workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
     params_json TEXT NOT NULL DEFAULT '{}',
     subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
     scope_type TEXT,
     scope_id TEXT,
     status TEXT NOT NULL DEFAULT 'open',
     enabled INTEGER NOT NULL DEFAULT 1,
     next_run_at TEXT,
     last_run_at TEXT,
     last_run_id TEXT,                         -- soft ref → the history.db run it last minted
     last_run_result TEXT,
     last_run_status TEXT,
     notification_channel TEXT,
     max_retries INTEGER,
     retry_count INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_triggers_enabled ON triggers(enabled, next_run_at);
   CREATE INDEX idx_triggers_subject ON triggers(subject_id);
   CREATE INDEX idx_triggers_target_workflow ON triggers(target_workflow_id);     -- FK child: workflow-delete SET NULL
   CREATE INDEX idx_triggers_source_connection ON triggers(source_connection_id);  -- FK child: connection-delete SET NULL

   -- TRACK: human TODO, fires nothing. due_trigger_id captures the
   -- "Task with a due-Trigger" shape (the legacy mail_followups lifecycle).
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'open',
     priority TEXT NOT NULL DEFAULT 'medium',
     subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
     assignee_subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
     due_trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL,
     parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
     scope_type TEXT,
     scope_id TEXT,
     tags TEXT,
     -- due_date = the passive deadline (display/sort); due_trigger_id = the OPTIONAL
     -- active reminder that fires at it. When both are set, the trigger's next_run_at
     -- is the firing time and due_date mirrors it — S3 keeps them in sync.
     due_date TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     completed_at TEXT
   );
   CREATE INDEX idx_tasks_status  ON tasks(status);
   CREATE INDEX idx_tasks_subject ON tasks(subject_id);
   -- FK children (parent-delete SET NULL would otherwise full-scan tasks):
   CREATE INDEX idx_tasks_assignee     ON tasks(assignee_subject_id);
   CREATE INDEX idx_tasks_due_trigger  ON tasks(due_trigger_id);
   CREATE INDEX idx_tasks_parent       ON tasks(parent_task_id);

   -- ── Conflict tracking (populated in S6; empty baseline now) ────
   CREATE TABLE conflicts (
     id TEXT PRIMARY KEY,
     new_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
     old_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
     reason TEXT NOT NULL,
     similarity REAL,
     status TEXT NOT NULL DEFAULT 'pending',   -- pending|superseded|both_valid|dismissed
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     resolved_at TEXT,
     resolved_by TEXT
   );
   CREATE INDEX idx_conflicts_status ON conflicts(status);
   -- FK children: memory-delete CASCADE would otherwise full-scan conflicts.
   CREATE INDEX idx_conflicts_new_memory ON conflicts(new_memory_id);
   CREATE INDEX idx_conflicts_old_memory ON conflicts(old_memory_id);`,
];

/**
 * Low-level SQLite wrapper for the consolidated engine.db (subject graph).
 * All methods are synchronous (better-sqlite3 is sync). Mirrors the RunHistory
 * constructor + corruption-recovery + encryption pattern.
 */
export class EngineDb {
  private db: Database.Database;
  private readonly dbPath: string;
  private readonly _encKey: Buffer | null;
  private _decWarnedNoKey = false;
  private _decWarnedFailCount = 0;

  constructor(dbPath?: string | undefined, encryptionKey?: string | undefined) {
    const path = dbPath ?? getDefaultDbPath();
    this.dbPath = path;
    ensureDirSync(dirname(path));
    this.db = null!; // assigned by _openOrRecreate
    this._openOrRecreate(path);

    // Derive engine-db encryption key via HKDF from the vault key (D2: parity
    // with history.db). Distinct salt+info so engine.db and history.db never
    // share a derived key.
    const vaultKey = encryptionKey ?? process.env['LYNOX_VAULT_KEY'] ?? '';
    if (vaultKey) {
      this._encKey = Buffer.from(hkdfSync('sha256', vaultKey, 'lynox-engine', ENGINE_HKDF_INFO, CRYPTO_KEY_LENGTH));
    } else {
      this._encKey = null;
    }
  }

  get path(): string { return this.dbPath; }

  /** Raw connection — S1 store classes (SubjectStore, etc.) share this. */
  getDb(): Database.Database { return this.db; }

  close(): void {
    this.db.close();
  }

  /**
   * True when at-rest encryption is active (a vault key was available).
   * @internal — posture introspection; not a public API.
   */
  get isEncrypted(): boolean { return this._encKey !== null; }

  /**
   * Open the SQLite database, running an integrity check. If malformed, rename
   * the corrupt file aside and create a fresh one (mirrors RunHistory).
   */
  private _openOrRecreate(path: string): void {
    let db = new Database(path);
    try {
      const result = db.pragma('integrity_check') as { integrity_check: string }[];
      if (result[0]?.integrity_check !== 'ok') {
        throw new Error(`integrity_check: ${result[0]?.integrity_check ?? 'unknown'}`);
      }
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      this.db = db;
      this._ensureSchemaVersion();
      this._migrate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`⚠ Engine database corrupted (${msg}) — renaming to .corrupt and starting fresh\n`);
      try { db.close(); } catch { /* best-effort */ }
      const corruptPath = `${path}.corrupt-${Date.now()}`;
      try {
        renameSync(path, corruptPath);
        try { renameSync(`${path}-wal`, `${corruptPath}-wal`); } catch { /* may not exist */ }
        try { renameSync(`${path}-shm`, `${corruptPath}-shm`); } catch { /* may not exist */ }
      } catch { /* rename failed */ }
      db = new Database(path);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      this.db = db;
      this._ensureSchemaVersion();
      this._migrate();
    }
  }

  private _ensureSchemaVersion(): void {
    this.db.prepare('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)').run();
  }

  private _getVersion(): number {
    try {
      const row = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number } | undefined;
      return row?.v ?? 0;
    } catch {
      return 0;
    }
  }

  private _migrate(): void {
    const currentVersion = this._getVersion();
    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      // Atomic per-migration: the version stamp + DDL are all-or-nothing, so a
      // crash can't bump the version past un-applied schema (see AgentMemoryDb).
      this.db.transaction(() => { this.db.exec(MIGRATIONS[i]!); })();
    }
  }

  /**
   * Encrypt text for storage. Returns prefixed ciphertext, or plaintext if no key.
   * @internal — the at-rest seam for the S1 store classes that share this
   * connection via {@link getDb}; not for external callers. If S1's stores end up
   * nested rather than separate modules, fold this back to a private `_enc`.
   */
  enc(text: string): string {
    if (!this._encKey || !text) return text;
    const iv = randomBytes(CRYPTO_IV_LENGTH);
    const cipher = createCipheriv(CRYPTO_ALGORITHM, this._encKey, iv, { authTagLength: CRYPTO_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ENCRYPTED_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  /**
   * Decrypt text from storage. Handles both encrypted and plaintext (mixed mode).
   * @internal — see {@link enc}.
   */
  dec(text: string): string {
    if (!text || !text.startsWith(ENCRYPTED_PREFIX)) return text;
    if (!this._encKey) {
      if (!this._decWarnedNoKey) {
        this._decWarnedNoKey = true;
        process.stderr.write('⚠ Engine: encrypted data found but no encryption key set — data unreadable\n');
      }
      return text;
    }
    try {
      const buf = Buffer.from(text.slice(ENCRYPTED_PREFIX.length), 'base64');
      const iv = buf.subarray(0, CRYPTO_IV_LENGTH);
      const tag = buf.subarray(CRYPTO_IV_LENGTH, CRYPTO_IV_LENGTH + CRYPTO_TAG_LENGTH);
      const data = buf.subarray(CRYPTO_IV_LENGTH + CRYPTO_TAG_LENGTH);
      const decipher = createDecipheriv(CRYPTO_ALGORITHM, this._encKey, iv, { authTagLength: CRYPTO_TAG_LENGTH });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      if (this._decWarnedFailCount < 3) {
        this._decWarnedFailCount++;
        process.stderr.write('⚠ Engine: decryption failed for encrypted record — wrong key or corrupted data\n');
      }
      return text;
    }
  }
}
