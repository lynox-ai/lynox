import Database from 'better-sqlite3';
import { basename, join, dirname } from 'node:path';
import { renameSync } from 'node:fs';
import { hkdfSync, randomBytes, createCipheriv, createHash, createHmac } from 'node:crypto';
import { getLynoxDir } from './config.js';
import { CRYPTO_ALGORITHM, CRYPTO_KEY_LENGTH, CRYPTO_IV_LENGTH, CRYPTO_TAG_LENGTH } from './crypto-constants.js';
import { ENCRYPTED_PREFIX, strictDecrypt, type StrictDecryptResult } from './strict-decrypt.js';
import { ensureDirSync } from './atomic-write.js';
import { SQLITE_BUSY_TIMEOUT_MS, corruptFileLeftInPlace, isCorruptionError, scrubFreedPages, zeroDeletedContent } from './sqlite-constants.js';
import { MANDATE_TAG_PREFIX } from './request-principal.js';
import { epochStartByTimeSql } from './grant-ledger.js';

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
/** Separate label for the keyed-digest subkey: the MAC never shares a key with AES-GCM. */
const ENGINE_HASH_HKDF_INFO = 'lynox-engine-keyed-hash';
/**
 * Label for the store-binding subkey ({@link EngineDb.storeBindingDigest}). Its own, not the
 * keyed-hash one: a store binding must not be computable from any other digest this file
 * stores.
 */
const STORE_BINDING_HKDF_INFO = 'lynox-engine-store-binding';

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
     is_self       INTEGER NOT NULL DEFAULT 0, -- 1 = the operator's OWN side: an OWN firm (organization, MULTIPLE allowed) OR the operator themselves (the reserved self-PERSON, singleton — S4a task assignee='user')
     parent_id     TEXT REFERENCES subjects(id) ON DELETE SET NULL,
     status        TEXT,
     owner_user_id TEXT NOT NULL DEFAULT 'system',
     embedding     BLOB,
     archived_at   TEXT,
     created_at    TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
   );
   -- Canonical dedup guard the legacy 'entities' table never had — scoped to the
   -- IDENTITY-BY-NAME kinds (person/organization/product/service: a tenant's
   -- catalogue holds one 'Widget Pro', so a product/service is name-identified like
   -- an org). An engagement's identity is provider×client×period (not its name) and
   -- 'other' is unstructured, so those two stay non-deduped; a genuine same-name
   -- collision among the dedup kinds routes to merge-review (like two real
   -- "Schmidt GmbH"). NOTE: 'name' MUST stay PLAINTEXT (never enc()'d) — this index
   -- is on LOWER(name), and random-IV GCM ciphertext would defeat dedup (one
   -- customer would slip through as N rows). S1 encrypts only non-indexed sensitive
   -- columns (people.email/phone, memories.text). This predicate MUST match
   -- SubjectStore.NAME_DEDUP_KINDS + findCanonical's kind-IN list.
   CREATE UNIQUE INDEX idx_subjects_canonical
     ON subjects(LOWER(name), kind, owner_user_id)
     WHERE archived_at IS NULL AND kind IN ('person','organization','product','service');
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
     segments_json TEXT,
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

   -- FIRE: dormant source·condition·target·effect. 'source' = what FIRES it
   -- (cron/watch/webhook/inbox_event/manual), a field NOT collapsed into one typed
   -- thing. 'effect' (added in v3) = what it DOES: run_workflow/run_agent MINT a Run
   -- (→ managed money gate/debit); backup/notify are deterministic side-effects that
   -- mint NO Run. Money-vs-deterministic boundary = the effect axis, in the schema.
   -- INVARIANT (enforced from P3, when webhook/inbox_event are wired): an inbound
   -- source (webhook/inbox_event) ⟺ source_connection_id IS NOT NULL.
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

  // v2 (S3e): the money-path `getDueTriggers` read cuts over to engine.db. The
  // only trigger index is `idx_triggers_enabled(enabled, next_run_at)`, but the
  // due query's leading `enabled != 0` is a non-seekable inequality, so that index
  // serves neither the `next_run_at <= ?` range nor the `ORDER BY next_run_at`.
  // Restore the dedicated `next_run_at` index the legacy history.db had, so the
  // ~60s scheduler poll seeks instead of full-scanning + sorting every tick.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (2);
   CREATE INDEX IF NOT EXISTS idx_triggers_next_run ON triggers(next_run_at);`,

  // v3 (S3-behaviour-a): split the conflated legacy `task_type` (which S3 stored
  // VERBATIM in `source` — the real values written were scheduled|pipeline|watch|
  // reminder|backup|manual) into the clean two-axis primitive — `source` = what
  // FIRES it, NEW `effect` = what it DOES. `effect` is a REAL column (not derivable):
  // backup/notify/run_agent are all cron+target-null → indistinguishable without an
  // explicit discriminator, and it makes the money-vs-deterministic boundary legible
  // in the schema (run_* mint a Run; backup/notify never do). The remap is EXHAUSTIVE
  // + explicit — every row gets an effect via a matching UPDATE, so no row leans on
  // the `DEFAULT 'run_agent'` backstop (a missed backup/reminder stranding at the
  // money-spending default is the hazard we design out). `effect` is derived FIRST
  // (keyed off the OLD source + target presence), THEN `source` is cleaned onto the
  // new axis (order matters — the source rewrite would otherwise erase the
  // discriminator the effect derivation reads).
  //
  // effect mirrors the LEGACY WorkerLoop dispatch, which routed to executePipeline on
  // `task_type='pipeline' OR pipeline_id` — so a target-bound row (target_workflow_id
  // NOT NULL) becomes run_workflow even if its source wasn't 'pipeline' (a legacy raw
  // create() could bind a workflow without task_type='pipeline'); dropping that half
  // would send it to run_agent → an autonomous money run of the title.
  //
  // source is recovered from the CONDITION SHAPE, not the legacy label, for every
  // value that isn't already clean — so 'scheduled'/'pipeline'/'standard'/unknown all
  // map to their real firing mechanism (json_valid guards a corrupt blob → 'manual').
  `INSERT OR IGNORE INTO schema_version (version) VALUES (3);
   ALTER TABLE triggers ADD COLUMN effect TEXT NOT NULL DEFAULT 'run_agent';

   -- 1. effect ← OLD source + target presence (exhaustive + explicit; no default reliance)
   UPDATE triggers SET effect = 'backup' WHERE source = 'backup';
   UPDATE triggers SET effect = 'notify' WHERE source = 'reminder';
   UPDATE triggers SET effect = 'run_workflow'
     WHERE source = 'pipeline'
        OR (target_workflow_id IS NOT NULL AND source NOT IN ('backup', 'reminder'));
   UPDATE triggers SET effect = 'run_agent'
     WHERE source NOT IN ('backup', 'reminder', 'pipeline') AND target_workflow_id IS NULL;

   -- 2. source ← cleaned onto the {cron,watch,webhook,inbox_event,manual} axis.
   --    backup/reminder are cron-scheduled built-ins; everything not already clean
   --    (legacy 'pipeline'/'scheduled'/'standard'/unknown) is derived from the
   --    condition shape so the real firing mechanism is recovered from any label.
   --    'watch'/'manual'/'cron'/'webhook'/'inbox_event' are already clean and skipped.
   UPDATE triggers SET source = 'cron' WHERE source IN ('backup', 'reminder');
   UPDATE triggers SET source = CASE
       WHEN json_valid(condition_json) AND json_extract(condition_json, '$.schedule_cron') IS NOT NULL THEN 'cron'
       WHEN json_valid(condition_json) AND json_extract(condition_json, '$.watch_config')  IS NOT NULL THEN 'watch'
       ELSE 'manual' END
     WHERE source NOT IN ('cron', 'watch', 'webhook', 'inbox_event', 'manual');`,

  // v4 (S5b): the memory RECALL reads cut over to engine.db. Both hot-path reads
  // (findSimilarRecall / listRecentActiveRecall) end in `ORDER BY created_at DESC
  // LIMIT`, but the baseline schema indexed only subject/scope/active/thread — the
  // created_at sort would filesort the whole matching set every chat turn. Restore
  // the `created_at` index the legacy agent-memory.db had (idx_memories_created),
  // so recall seeks the newest-N instead of scan+sort. Same fix class as v2
  // (idx_triggers_next_run) — a read cutover exposing a missing legacy index.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (4);
   CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);`,

  // v5 (B1 self-heal): the exactly-once gate for the boot-time verb-graph backfill.
  // mig v44 (history.db) is now NON-destructive — the legacy `triggers` + planned-
  // pipeline rows stay dormant — and the engine copies them into engine.db at boot
  // (engine.ts) so a v1.22.0→v2.0.0 upgrade never loses a trigger/workflow. This
  // one-row marker makes that copy run ONCE (on the upgrade boot, or after an
  // engine.db recreate) instead of every boot, so a definition DELETED post-upgrade
  // is never resurrected from the still-present legacy rows. `done=0` until the
  // backfill succeeds; a fresh v2 tenant (no legacy rows) flips it to 1 on a no-op.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (5);
   CREATE TABLE IF NOT EXISTS verb_backfill_marker (
     id   INTEGER PRIMARY KEY CHECK (id = 1),
     done INTEGER NOT NULL DEFAULT 0
   );
   INSERT OR IGNORE INTO verb_backfill_marker (id, done) VALUES (1, 0);`,

  // v6 (triggers-consent): a human first-run-confirm gate on the `run_agent`
  // effect (the SEC leg of the Triggers primitive). An agent-created `run_agent`
  // trigger — a scheduled/watch autonomous agent turn — can be steered by injected
  // content and then fires unattended under the weaker autonomous bash guard: an
  // injection-amplification hole `run_workflow` does NOT have (it gates on the
  // workflow's own `confirmedAt`). A `run_agent` trigger now needs an explicit
  // human `confirmed_at` before it is due / dispatched; anything created by other
  // than an explicit human action lands unconfirmed (fail-closed — the store
  // default is NULL, the human HTTP route stamps, the agent tool never does).
  // GRANDFATHER (owner decision): every EXISTING run_agent trigger predates the
  // gate and was operator-created (pre-customer, no injected schedules) → stamp it
  // confirmed so the one-time behaviour change never pauses the operator's own live
  // schedules; the gate protects only NEW agent-created triggers. Scoped to
  // `run_agent` — confirmed_at is read for no other effect, so stamping only the
  // gated rows keeps the column meaningful.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (6);
   ALTER TABLE triggers ADD COLUMN confirmed_at TEXT;
   UPDATE triggers SET confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE effect = 'run_agent';`,

  // v7 (PR-C subject-dedup): the retroactive-merge redirect pointer. When two rows
  // turn out to be the same real subject (Ada ⊂ Dr. Ada Lovelace), SubjectStore.mergeSubjects
  // repoints every FK from the duplicate onto the canonical, soft-archives the dup,
  // and stamps `merged_into = <canonical id>` so a stale id still held anywhere
  // (a soft `source_run_id`-carried ref, a cached UI id, a DataStore cell mid-flight)
  // resolves forward via `resolveActiveSubject` instead of dangling. A real self-FK
  // (mirrors `parent_id`) ON DELETE SET NULL: a hard subject purge nulls the pointer
  // rather than orphaning it; the merge path itself only soft-archives, never deletes.
  // Nullable, no default → the ALTER is SQLite-legal (an FK column added by ALTER must
  // default NULL). The index serves the reverse "who merged into X" read the rollback
  // uses to find the dup(s) of a canonical.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (7);
   ALTER TABLE subjects ADD COLUMN merged_into TEXT REFERENCES subjects(id) ON DELETE SET NULL;
   CREATE INDEX IF NOT EXISTS idx_subjects_merged_into ON subjects(merged_into);`,

  // v8 (Memory Wave 1 — evidence): the untrusted signal + the write channel, the two
  // DERIVATION INPUTS (PRD §1/§3) that make `source_type` a re-derivable pure function
  // instead of the only thing stored. Additive ALTER — NEVER edit the v1 CREATE (a column
  // there would collide with this ALTER on a fresh DB; SQLite ADD COLUMN has no IF NOT
  // EXISTS). `source_channel` NULLABLE (pre-evidence rows keep NULL + their stamped
  // source_type; a batch re-derive skips NULL-channel rows per §3 rule 5). `source_untrusted`
  // DEFAULT 0. `embedding_model` (§1.7) records the vector-space identity so a silent
  // embedding-default change (no re-embed path) is detectable per row — the Wave-2 floor
  // binds to it. Mirrors agent-memory.db v6 so the two stores stay column-symmetric — the
  // trap §1 names is a legacy-only evidence column the engine.db-primary fleet would never see.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (8);
   ALTER TABLE memories ADD COLUMN source_channel TEXT;
   ALTER TABLE memories ADD COLUMN source_untrusted INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE memories ADD COLUMN embedding_model TEXT;`,

  // v9 (Durable Knowledge Substrate — DK.1): the two user-owned Know tables. NEW
  // tables via CREATE (not ALTER) — additive, so a fresh DB and an upgraded DB get
  // the identical shape, and the v1 CREATE is NEVER edited (an added column there
  // would collide with a future ALTER on a fresh DB; ADD COLUMN has no IF NOT EXISTS).
  // These tables exist unconditionally (engine.db is always opened) but are read/written
  // ONLY when `durable_memory_enabled` is on — flag-OFF stays byte-identical.
  //
  //   knowledge_entries — the archival, DURABLE store: no byte-cap, no oldest-first
  //   trim, no TTL (contrast memory-file.ts). Only explicit transitions: supersede
  //   (tier-gated), reject (user), delete (user/GDPR — deleteAllData auto-enumerates it).
  //   `text` is enc()'d at rest by KnowledgeStore; `subject_hint` stays PLAINTEXT (a
  //   surface name, like subjects.name — used to link on approval, never minted). The
  //   provenance evidence columns (source_channel/source_untrusted/source_type) make the
  //   tier a re-derivable pure function (provenance.ts), never the only thing stored.
  //
  //   H6 (pin is a STORE INVARIANT, not a prompt convention): the CHECK forbids
  //   pinned=1 unless the row is active AND its tier is not external_unverified — so an
  //   injected/untrusted `remember({pin:true})` write can never ride into the every-turn
  //   `focus` block, and approval can never inherit an attacker-set pin. Defense in depth
  //   alongside the KnowledgeStore write/approval guard.
  //
  //   memory_blocks — the always-loaded working set: only 'profile' + 'playbook' are
  //   STORED (the 'focus' block is DERIVED per turn, never persisted). char_limit is the
  //   loud-error bound (no silent trim); over-limit is a tool error, not an eviction.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (9);
   CREATE TABLE knowledge_entries (
     id               TEXT PRIMARY KEY,
     subject_id       TEXT REFERENCES subjects(id) ON DELETE SET NULL,
     subject_hint     TEXT,                       -- surface name when unmatched (NEVER minted); PLAINTEXT
     kind             TEXT NOT NULL DEFAULT 'fact'
                        CHECK (kind IN ('fact','preference','rule','event','block_edit')),
     text             TEXT NOT NULL,              -- enc()'d at rest by KnowledgeStore
     pinned           INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
     importance       INTEGER NOT NULL DEFAULT 1 CHECK (importance IN (0,1,2)),
     status           TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','pending_review','rejected','superseded')),
     source_channel   TEXT,                       -- provenance evidence (re-derivable tier input)
     source_untrusted INTEGER NOT NULL DEFAULT 0, -- provenance evidence (routes untrusted → pending_review)
     source_type      TEXT NOT NULL DEFAULT 'agent_inferred'
                        CHECK (source_type IN ('user_asserted','tool_verified','agent_inferred','external_unverified')),
     source_thread_id TEXT,                       -- soft ref → history.db threads (audit only; a
                                                  -- REAL FK to engine.db threads would FK-fail
                                                  -- since live threads stay in history.db pre-S2)
     source_run_id    TEXT,                       -- soft ref → history.db runs
     superseded_by    TEXT,                       -- soft pointer to the retiring entry
     reviewed_at      TEXT,
     review_action    TEXT,                       -- approve|edit_approve|reject (audit)
     created_at       TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
     -- H6: pin is a store invariant. Only an active, non-external_unverified row may pin.
     CHECK (pinned = 0 OR (status = 'active' AND source_type != 'external_unverified'))
   );
   CREATE INDEX idx_knowledge_subject_status ON knowledge_entries(subject_id, status);
   CREATE INDEX idx_knowledge_status         ON knowledge_entries(status);
   CREATE INDEX idx_knowledge_pinned         ON knowledge_entries(pinned);

   CREATE TABLE memory_blocks (
     id         TEXT PRIMARY KEY CHECK (id IN ('profile','playbook')),
     content    TEXT NOT NULL DEFAULT '',
     char_limit INTEGER NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // v10 (Onboarding Wave 1 — Layer-1 foundation): the server-side, cross-device
  // onboarding state that fixes the localStorage-local flow (PRD-ONBOARDING §1/§2.1).
  // NEW table via CREATE (not ALTER) — additive, so a fresh DB and an upgraded DB
  // get the identical shape, and the v1 CREATE is NEVER edited (a column added there
  // would collide with a future ALTER on a fresh DB; ADD COLUMN has no IF NOT EXISTS).
  //
  //   A tiny key-value store, one row per (owner_user_id, flag). The composite PK is
  //   the upsert key. `value` is an opaque non-secret TEXT — NEVER enc()'d (no
  //   sensitive material lands here) and per-flag typed at the store/endpoint layer,
  //   not by a DB CHECK (the flag axis differs per key):
  //     · knowledge_done   → the onboarding THREAD-ID (RF-IRR1): completion + the
  //                          durable link that makes every onboarding-written DK entry
  //                          identifiable later (mass-repair by source_thread_id).
  //     · skipped          → the skip timestamp (presence = skipped).
  //     · push_nudge       → 'asked_once' | 'declined' (Wave 2, S4/RF-IRR3 nudge state).
  //     · first_session_at → the first intro-card render-ack timestamp (DC4; written
  //                          in Wave 1, consumed by the Wave-3 session-1-vs-2 rule).
  //
  //   owner_user_id follows the `subjects` precedent (`DEFAULT 'system'`, engine-db.ts
  //   v1): engine.db has no users table, so the instance is single-operator today and
  //   the key is user-scoped by shape — a future multi-user engine needs no migration
  //   (D8). onboarding_flags is auto-wiped by deleteAllData() (GDPR Art. 17, enumerated
  //   from sqlite_master) and rides the engine.db migration-export set — both structural,
  //   no per-table plumbing (S2).
  //
  //   The `flag` CHECK is deliberately FORWARD-COMPLETE — it lists all four values the
  //   schema will ever use, including the Wave-2 (push_nudge) and Wave-3-consumed
  //   (first_session_at) keys, even though this wave only writes knowledge_done/skipped/
  //   first_session_at. SQLite cannot ALTER a CHECK in place (it needs a table rebuild —
  //   the exact pain the pending_prompts twin carries), so enumerating the full set now
  //   trades nothing and avoids a later rebuild; a typo'd flag still fails loud.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (10);
   CREATE TABLE onboarding_flags (
     owner_user_id TEXT NOT NULL DEFAULT 'system',
     flag          TEXT NOT NULL
                     CHECK (flag IN ('knowledge_done','skipped','push_nudge','first_session_at')),
     value         TEXT NOT NULL DEFAULT '',
     updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (owner_user_id, flag)
   );`,

  // ── v11: don't show a first-run onboarding to someone who is not on their first run ──
  //
  //   v10 created onboarding_flags EMPTY, and the UI dismisses the stepper only on a
  //   knowledge_done/skipped row (`ChatView.svelte`: `if (data.knowledgeDone ||
  //   data.skipped) onboardingDismissed = true`). An instance that has been in use for
  //   months therefore reads as brand new the moment W1 reaches it, and every existing
  //   operator is walked through a first-run flow. v10 cannot be edited to fix this — it
  //   is already applied on the canary, and an edited applied migration never re-runs.
  //
  //   The predicate is "does engine.db already hold durable content?" — and it must lead
  //   with the FLAG-FREE tables. `subjects` / `memories` fill only behind
  //   `subject_graph_enabled` and `knowledge_entries` only behind `durable_memory_enabled`,
  //   both default OFF, so a fleet-default instance in use for months has all three EMPTY
  //   and keeps its real content in agent-memory.db / history.db. Keying on those alone
  //   made this migration a no-op for the exact state it exists for, firing only on the
  //   flag-ON canaries. `workflows` / `triggers` / `tasks` are written unconditionally:
  //   `setVerbGraph` (run-history.ts) is called with no flag check (`engine.ts:942`) and
  //   the first two are the SOLE authority for their writes, the third an additive mirror
  //   — only the assignee→subject resolution is flag-coupled.
  //   All six are empty in a freshly created db and nothing is seeded at first boot, so a
  //   genuinely new instance running v1..v11 in one go still matches nothing and keeps its
  //   onboarding. ⚠️ That last property is load-bearing: if a later wave seeds starter
  //   tasks/workflows into a NEW instance, this predicate starts marking new operators and
  //   must be re-cut. Thread history would be the most direct signal but lives in the
  //   run-history db, which a migration here cannot reach.
  //
  //   Direction of the risk, stated deliberately: over-marking is repairable (the
  //   `backfill:` value makes it a one-line DELETE), under-marking is NOT — the operator's
  //   own reaction to the bug writes a genuine `skipped` row (`ChatView.svelte`), so a
  //   later migration can no longer tell "v11 missed me" from "I chose to skip". The
  //   symptom destroys the evidence, which is why the predicate errs wide.
  //
  //   Recorded as `skipped` because that is the only forward-declared flag that means
  //   "do not show this" without also claiming the operator COMPLETED a flow they never
  //   saw — and the CHECK cannot gain a fifth value without a table rebuild (see v10).
  //   The provenance goes in \`value\` instead, which nothing parses (the status derives
  //   booleans from row PRESENCE, `onboarding-flag-store.ts`), so the onboarding funnel
  //   can still tell a backfill apart from a real user skip rather than counting it.
  //
  //   The guard is "no DISMISSING row yet" — knowledge_done or skipped — not "no row at
  //   all". `first_session_at` is a render-ack, not a completion: the UI dismisses on
  //   `knowledgeDone || skipped` only. Guarding on any row would let a single app open
  //   during the window between W1 and this migration reaching a tenant write
  //   `first_session_at` and permanently block the backfill, leaving that operator with a
  //   first-run stepper forever. That window is open on the canary right now.
  //   Idempotent either way: re-running is a no-op and a genuine completion is never
  //   overwritten (and the PK is per-flag, so a first_session_at row does not collide).
  //   The guard filters `owner_user_id` to match the row it inserts — engine.db has no
  //   users table today, but an unfiltered guard would let a future second owner's skip
  //   suppress the system owner's backfill.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (11);
   INSERT INTO onboarding_flags (owner_user_id, flag, value)
   SELECT 'system', 'skipped', 'backfill:pre-w1:' || strftime('%Y-%m-%dT%H:%M:%SZ','now')
   WHERE NOT EXISTS (
       SELECT 1 FROM onboarding_flags
       WHERE owner_user_id = 'system' AND flag IN ('knowledge_done','skipped'))
     AND (EXISTS (SELECT 1 FROM workflows)
       OR EXISTS (SELECT 1 FROM triggers)
       OR EXISTS (SELECT 1 FROM tasks)
       OR EXISTS (SELECT 1 FROM subjects)
       OR EXISTS (SELECT 1 FROM knowledge_entries)
       OR EXISTS (SELECT 1 FROM memories));`,

  // v12 (durable wait state, PRD-DURABLE-WAIT-STATE §0 E4a): how long a trigger
  // that parked on an unanswered question may keep waiting. NULL on every existing
  // row and on every trigger that is not parked — the column is written only by the
  // park and read only by the expiry sweep, so an instance that never parks a
  // trigger behaves exactly as before.
  //
  // ⚠ ADD COLUMN on the LIVE `triggers` table — the one this ladder creates in v1.
  // A second table of the same name exists in the history.db ladder
  // (run-history.ts v42) and that one carries `CHECK(status IN (...))`; which of
  // the two a search shows first depends on the tool. This table has no CHECK on
  // `status`, which is why the new `waiting` status needs no table rebuild, and
  // ADD COLUMN here has two precedents (v3 `effect`, v6 `confirmed_at`).
  //
  // NOT indexed, and the honest reason is that there is nothing to measure yet.
  // The sweep filters `status` and `waiting_until`, neither of which any index
  // covers, so it scans the WHOLE `triggers` table — not just the parked rows.
  // What is bounded by the number of simultaneously unanswered questions is how
  // many rows it MATCHES, which is a different quantity and does not justify
  // skipping an index. What justifies it here is that this migration ships no
  // caller: the query is wired to the WorkerLoop in a later slice, and the cost
  // is a scan per tick over a table whose size is an instance's whole trigger
  // list. Revisit it there, with a number. An index is a forward migration and
  // cheap to add; the COLUMN is the part that is hard to take back, since this
  // ladder is forward-only and has no down path.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (12);
   ALTER TABLE triggers ADD COLUMN waiting_until TEXT;`,

  // v13 (bulk changes, reversible — PRD bulk-changes-reversible §3.1): the ledger of a
  // run that applies one rule to N targets. One row per run, one per target, the
  // before-image of each target taken at dry-run time. `before`/`after_planned` are
  // customer data and are written through `enc()` like every other content column;
  // no reader hands them to the model (`bulk_status` returns counters only).
  //
  // Deliberately WITHOUT the `atomic` column PRD §3.1 lists: its meaning depended on a
  // primitive decision still open then (PRD §9 question 1). v14 adds it — an ADD COLUMN
  // is cheap, a column this forward-only ladder cannot take back is not.
  //
  // The approval/contract columns ship here, first read in v14's apply path, because
  // they are the run's own shape (§3.1); leaving them out would mean a second rebuild
  // of the same table for one feature. `change` is per target and decided at dry-run
  // time: what the rule would do to it, so a preview and a later apply agree on it.
  //
  // `target_key` is encrypted too — a data-store key can be an e-mail address, and
  // SubjectStore encrypts those. That is why the table is keyed on (run_id, seq)
  // rather than §3.1's (run_id, target_key): a unique index over a randomly-IV'd
  // ciphertext enforces nothing, and a deterministic column would hold the key in
  // clear. Uniqueness of the key within a run is enforced where the plan is built.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (13);
   CREATE TABLE bulk_runs (
     id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     created_by TEXT,
     rule_hash TEXT NOT NULL,
     target_system TEXT NOT NULL,
     undo TEXT NOT NULL CHECK (undo IN ('restorable','compensatable','none','mixed')),
     phase TEXT NOT NULL CHECK (phase IN ('planned','previewed','approved','writing','done','aborted','undone')),
     contract_json TEXT,
     approved_by TEXT,
     approved_at TEXT,
     approval_checksum TEXT,
     max_targets INTEGER,
     expires_at TEXT,
     targets_total INTEGER NOT NULL DEFAULT 0,
     targets_applied INTEGER NOT NULL DEFAULT 0,
     targets_failed INTEGER NOT NULL DEFAULT 0,
     halt_reason TEXT
   );
   CREATE INDEX idx_bulk_runs_created ON bulk_runs(created_at);
   CREATE TABLE bulk_targets (
     run_id TEXT NOT NULL REFERENCES bulk_runs(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     target_key TEXT NOT NULL,
     change TEXT NOT NULL CHECK (change IN ('update','create','unchanged','invalid')),
     undo TEXT CHECK (undo IN ('restorable','compensatable','none')),
     before TEXT,
     after_planned TEXT,
     applied_at TEXT,
     result TEXT,
     error TEXT,
     undone_at TEXT,
     PRIMARY KEY (run_id, seq)
   );`,

  // v14 (bulk changes, reversible — apply and undo, PRD §3.4/§3.5): what applying a run
  // and taking it back need on top of the dry-run ledger.
  // - `atomic` (§3.1, §9 question 1): 1 = the run is written whole
  //   or rolled back, and only a fully applied run can be undone; 0 = independent
  //   targets, an undo takes back the applied ones.
  // - `kind` + `source_run_id`: an undo is its own run over the applied targets of
  //   another (a second approval, §3.5), not a mode of the first.
  // - `target_collection`: the data-store collection a run writes; the dry run only
  //   hashed it into `rule_hash`, and applying has to know it.
  // `bulk_targets` is rebuilt rather than altered because its `change` CHECK needs
  // `delete` — an undo of a created target removes it — and SQLite cannot alter a
  // CHECK. `claimed_at` is the per-target claim a concurrent or restarted effect loop
  // tests before writing (§3.4); `source_seq` ties an undo target to the target it
  // takes back. The rebuild copies every row: the table so far only holds dry runs.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (14);
   ALTER TABLE bulk_runs ADD COLUMN atomic INTEGER NOT NULL DEFAULT 0 CHECK (atomic IN (0,1));
   ALTER TABLE bulk_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'apply' CHECK (kind IN ('apply','undo'));
   ALTER TABLE bulk_runs ADD COLUMN source_run_id TEXT REFERENCES bulk_runs(id) ON DELETE SET NULL;
   ALTER TABLE bulk_runs ADD COLUMN target_collection TEXT;
   CREATE TABLE bulk_targets_v14 (
     run_id TEXT NOT NULL REFERENCES bulk_runs(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     target_key TEXT NOT NULL,
     change TEXT NOT NULL CHECK (change IN ('update','create','delete','unchanged','invalid')),
     undo TEXT CHECK (undo IN ('restorable','compensatable','none')),
     before TEXT,
     after_planned TEXT,
     claimed_at TEXT,
     applied_at TEXT,
     result TEXT,
     error TEXT,
     undone_at TEXT,
     source_seq INTEGER,
     PRIMARY KEY (run_id, seq)
   );
   INSERT INTO bulk_targets_v14 (run_id, seq, target_key, change, undo, before, after_planned, applied_at, result, error, undone_at)
     SELECT run_id, seq, target_key, change, undo, before, after_planned, applied_at, result, error, undone_at FROM bulk_targets;
   DROP TABLE bulk_targets;
   ALTER TABLE bulk_targets_v14 RENAME TO bulk_targets;`,

  // v15 (bulk changes, external targets — build plan B §2): what an external target held
  // right after the run wrote it, read back with a GET and projected onto the fields the
  // run writes. A shop normalises what it is sent ("12" → "12.00"), so the undo has to
  // expect what is there, not what was sent. Customer data, written through `enc()`.
  // `bulk_host_probes`: a host, write verb and kind of resource (the target path without
  // its last segment) whose effect on the fields a write does NOT send the owner has
  // checked on one real target. No provider documents it, and a verb
  // that replaces the whole resource would wipe every other field of N targets — so until
  // a probe is confirmed, an external run is approved for one target only.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (15);
   ALTER TABLE bulk_targets ADD COLUMN after_actual TEXT;
   CREATE TABLE bulk_host_probes (
     host TEXT NOT NULL,
     method TEXT NOT NULL,
     kind TEXT NOT NULL,
     run_id TEXT NOT NULL,
     confirmed_by TEXT,
     confirmed_at TEXT NOT NULL,
     PRIMARY KEY (host, method, kind)
   );`,

  // v16 (trigger run lease): a run in progress is recorded in the row itself, not only in
  // the WorkerLoop's in-memory map, so a second engine process on the same file — or the
  // same process after a restart — does not start it again while its lease holds.
  // `lease_holder` names the loop that holds it; `lease_until` is renewed by that run's
  // heartbeat and lapses when the holder dies; `lease_since` is when the run took it, which
  // tells a lapsed lease of a run that never recorded its result (the occurrence it ran is
  // still the due one) from one whose run was settled by someone else meanwhile. All NULL:
  // nobody is running it.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (16);
   ALTER TABLE triggers ADD COLUMN lease_until TEXT;
   ALTER TABLE triggers ADD COLUMN lease_holder TEXT;
   ALTER TABLE triggers ADD COLUMN lease_since TEXT;`,

  // v17 (bulk run families): a run's undos, and theirs, are found by `source_run_id`, and
  // every approve or resume walks that family inside its write transaction
  // (`BulkLedger.openInFamily`). Without an index SQLite builds an automatic one over
  // `bulk_runs` on every walk — a full scan per call, of a table that only grows. IF NOT
  // EXISTS: tests that rewind past v16 keep the table.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (17);
   CREATE INDEX IF NOT EXISTS idx_bulk_runs_source ON bulk_runs(source_run_id);`,

  // v18 (bulk write sent): whether a target's write verb may have reached it — set just
  // before the request goes out, and never cleared. `error` cannot carry it: a resume clears
  // every retryable error, a redirect or a crash leaves none, and the target then looked as
  // if nothing had been sent to it. Two rules read it: an approval for N targets bounds how
  // many DIFFERENT targets receive the verb, not how many writes landed; and an undo takes
  // back every target that may hold a write. Backfilled from the failures still recorded
  // that may follow a write; one a resume already cleared is not recoverable from this table.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (18);
   ALTER TABLE bulk_targets ADD COLUMN write_sent INTEGER NOT NULL DEFAULT 0;
   UPDATE bulk_targets SET write_sent = 1 WHERE error IN ('write_failed', 'redirect');`,

  // v19 (trigger created untrusted): what the session that created a trigger had taken in, as
  // its untrusted-content cause (`marker` / `external-tool` / `conversation`), or NULL when it
  // had taken in nothing. A workflow run the trigger starts has no session of its own to read
  // this from, so it is seeded from here. Existing rows stay NULL: what their creators had
  // seen was never recorded and cannot be recovered.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (19);
   ALTER TABLE triggers ADD COLUMN created_untrusted TEXT;`,

  // v20 (who wrote a trigger): the principal that created it, last changed it from a
  // request, and stamped it — `owner` or `mandate:<address>` (request-principal.ts). A
  // schedule a mandate created or changed is due only once the owner stamped it, for
  // every effect; the engine's own writes (status, next run, lease) set none of these.
  // Rows from before carry no creator and no editor: nothing a mandate wrote can exist
  // yet, so NULL means "not a mandate". A stamp already on a row was the owner's, since
  // before this version only the owner could stamp.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (20);
   ALTER TABLE triggers ADD COLUMN created_by TEXT;
   ALTER TABLE triggers ADD COLUMN edited_by TEXT;
   ALTER TABLE triggers ADD COLUMN confirmed_by TEXT;
   UPDATE triggers SET confirmed_by = 'owner' WHERE confirmed_at IS NOT NULL;`,

  // v21 (trigger model tier): the model tier the user chose for this trigger's runs —
  // `fast` / `balanced` / `deep` — or NULL for no choice, in which case a run picks its
  // model the way it did before this column existed. Existing rows stay NULL.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (21);
   ALTER TABLE triggers ADD COLUMN model_tier TEXT;`,

  // v22 (actor trail): who did what through a mandate (PRD customer-granted-operator-access
  // §3.6) — the actor, the act and its target, never its content. A write leaves two rows
  // joined by `correlation_id`: an `attempt` before it runs and its `outcome` (done, refused,
  // error) after, so a write that was refused shows as refused and one whose outcome never
  // arrived shows as only attempted. Rows are never changed: the trigger refuses an UPDATE.
  // They are not exempt from the owner's erasure (`deleteAllData` empties this table too):
  // the trail is a record for the owner, and erasing the instance erases it.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (22);
   CREATE TABLE IF NOT EXISTS audit_log (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     ts             TEXT NOT NULL,
     actor_kind     TEXT NOT NULL,
     actor_email    TEXT,
     actor_display  TEXT,
     mandate_id     TEXT,
     action         TEXT NOT NULL,
     target         TEXT,
     phase          TEXT NOT NULL,
     correlation_id TEXT NOT NULL,
     run_id         TEXT,
     request_id     TEXT
   );
   CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
   BEGIN SELECT RAISE(ABORT, 'audit_log rows are never changed'); END;`,

  // v23: the to-do mirror carries who created a to-do (history.db v58), so the read side of a
  // subject-graph tenant answers "whose is this" as the legacy table does. An ALTER is safe on
  // every population: no CREATE of `tasks` ever had the column, and no later version rebuilds it.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (23);
   ALTER TABLE tasks ADD COLUMN created_by TEXT;`,

  // v24: when each mandate ends (mandate-ends.ts). A mandate's session cookie lasts minutes, so
  // the end a stamped run checks long after the mandate's last request has to be stored.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (24);
   CREATE TABLE IF NOT EXISTS mandate_ends (
     mandate_id TEXT PRIMARY KEY,
     ends_at INTEGER NOT NULL,
     issued_at INTEGER NOT NULL,
     revoked_at INTEGER,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // v25: when the owner was told that an unconfirmed `run_agent` trigger came due. `getDue`
  // holds such a trigger back without touching it, so nothing else would ever say it is
  // waiting. Set once per unconfirmed phase; a write that stamps the trigger or takes a stamp
  // away clears it, so consent given and then taken back earns exactly one new reminder,
  // while edits to a trigger that was never stamped do not (each would otherwise re-announce
  // it). Existing rows stay NULL: a
  // trigger already waiting is reminded once, the first time the engine sees it due.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (25);
   ALTER TABLE triggers ADD COLUMN consent_reminded_at TEXT;`,

  // v26: whether the last escalation of a trigger reached anyone. An escalation (a failed
  // scheduled workflow, a watch finding) opens a thread and sends a wakeup; without this the
  // case could not tell "escalated" from "escalated and nobody was told". `at` is when the
  // escalation started; `outcome` is `unconfirmed` from then until the channels answer, then one
  // of `delivered` · `not_delivered` · `no_channel` (`summarizeDelivery`). Additive and nullable:
  // a trigger that never escalated has neither.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (26);
   ALTER TABLE triggers ADD COLUMN last_escalation_at TEXT;
   ALTER TABLE triggers ADD COLUMN last_escalation_outcome TEXT;`,

  // v27: which of the owner's vault names a profile a mandate wrote may read
  // (secret-releases.ts). A request is what the profile asked for when the mandate saved it; a
  // release is the owner's answer. Two tables rather than a status column: only the owner's
  // gesture writes a release, and no update of a request can turn into one. Both are keyed by
  // profile, author and name, and a release also names the grant it was given to, so a later
  // mandate for the same address, or another author under the same id, finds nothing.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (27);
   CREATE TABLE IF NOT EXISTS secret_release_requests (
     profile_id      TEXT NOT NULL,
     profile_author  TEXT NOT NULL,
     name            TEXT NOT NULL,
     binding         TEXT NOT NULL,
     mandate_id      TEXT NOT NULL,
     requested_at    TEXT NOT NULL,
     PRIMARY KEY (profile_id, profile_author, name)
   );
   CREATE TABLE IF NOT EXISTS secret_releases (
     profile_id      TEXT NOT NULL,
     profile_author  TEXT NOT NULL,
     name            TEXT NOT NULL,
     binding         TEXT NOT NULL,
     mandate_id      TEXT NOT NULL,
     released_at     TEXT NOT NULL,
     PRIMARY KEY (profile_id, profile_author, name)
   );`,

  // v28: when the conversation a durable entry came from was deleted. Deleting a chat keeps
  // what was learned in it; `source_thread_id` keeps the id, and this says the transcript
  // behind it is gone. NULL means the chat still exists or the entry never had one.
  // Mirrors agent-memory.db v7.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (28);
   ALTER TABLE knowledge_entries ADD COLUMN source_thread_deleted_at TEXT;`,

  // v29: where each durable entry came from, per source, and which entry seeded a `profile` line.
  //
  // `entry_sources`: one row per conversation that said a fact. The write path folds a
  // restatement into the entry it restates, so an entry can carry several conversations, and
  // `knowledge_entries.source_thread_id` names only the first. Each row keeps the wording that
  // source used (enc()'d like the entry), because the entry's own text is the first source's
  // and can hold detail a later source never said. Private mode removes a conversation's
  // source rows; an entry with sources left takes the earliest remaining source's wording.
  // A source also keeps its own evidence (channel, untrusted flag) and whether it pinned the
  // entry: an entry that takes a remaining source's wording takes that source's trust and pin
  // with it, never the removed one's.
  // Fed by the provenance primitive once it exists (thread_id/run_id then come from its
  // context). Backfilled with one row per existing entry, `thread_id` NULL included, so an
  // entry that never had a conversation is not removed when a restatement's goes.
  //
  // `profile_seeds`: the entry a `profile` line was seeded from. Removing an entry removes its
  // line only when this row exists, never by text equality alone. `profile_seed_backfill` is
  // the one-time marker for seeding it from existing blocks, which needs the decrypted text.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (29);
   CREATE TABLE IF NOT EXISTS entry_sources (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     entry_id          TEXT NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
     thread_id         TEXT,
     run_id            TEXT,
     text              TEXT NOT NULL,
     source_channel    TEXT,
     source_untrusted  INTEGER NOT NULL DEFAULT 0,
     pinned            INTEGER NOT NULL DEFAULT 0,
     added_at          TEXT NOT NULL DEFAULT (datetime('now')),
     thread_deleted_at TEXT
   );
   CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_sources_entry_thread ON entry_sources(entry_id, thread_id);
   CREATE INDEX IF NOT EXISTS idx_entry_sources_thread ON entry_sources(thread_id);
   INSERT INTO entry_sources (entry_id, thread_id, run_id, text, source_channel, source_untrusted, pinned, added_at, thread_deleted_at)
     SELECT k.id, k.source_thread_id, k.source_run_id, k.text, k.source_channel, k.source_untrusted, k.pinned, k.created_at, k.source_thread_deleted_at
     FROM knowledge_entries k
     WHERE NOT EXISTS (SELECT 1 FROM entry_sources s WHERE s.entry_id = k.id);
   CREATE TABLE IF NOT EXISTS profile_seeds (
     entry_id  TEXT PRIMARY KEY REFERENCES knowledge_entries(id) ON DELETE CASCADE,
     seeded_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE IF NOT EXISTS profile_seed_backfill (
     id   INTEGER PRIMARY KEY CHECK (id = 1),
     done INTEGER NOT NULL DEFAULT 0
   );
   INSERT OR IGNORE INTO profile_seed_backfill (id, done) VALUES (1, 0);`,

  // v30: the subjects a conversation's writes created. Private mode removes such a subject once
  // nothing holds it any more; a subject that existed before the conversation named it is not
  // the conversation's to remove. Keyed by subject, not by entry: a write can create a subject
  // and still fold into an entry about another one.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (30);
   CREATE TABLE IF NOT EXISTS subject_mints (
     subject_id TEXT PRIMARY KEY,
     thread_id  TEXT NOT NULL,
     minted_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_subject_mints_thread ON subject_mints(thread_id);`,

  // v31: who planned a bulk run, and under which grant (PRD customer-granted-operator-access
  // §3.13 B7). `principal` is the planner's tag, written on every new run, so NULL means a run
  // from before this version; `mandate_id` is the grant a mandate's run ends with.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (31);
   ALTER TABLE bulk_runs ADD COLUMN principal TEXT;
   ALTER TABLE bulk_runs ADD COLUMN mandate_id TEXT;`,

  // v32: an external run whose targets come from a paginated GET list (PRD bulk-loop §3.2).
  // `list_source` is what the planner asked for — path, filters, id field, verb, after-state —
  // encrypted like a target key; NULL on every other run. `list_state` is plain so a guard can
  // read it: 'pending' while the list is read, 'done' once its targets and write contract
  // stand. `list_page`, `list_calls` and `list_bytes` are the read's progress — the last page
  // taken, the requests sent, the bytes read — kept so a tick that ends goes on from there.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (32);
   ALTER TABLE bulk_runs ADD COLUMN list_source TEXT;
   ALTER TABLE bulk_runs ADD COLUMN list_state TEXT;
   ALTER TABLE bulk_runs ADD COLUMN list_page INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE bulk_runs ADD COLUMN list_calls INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE bulk_runs ADD COLUMN list_bytes INTEGER NOT NULL DEFAULT 0;`,

  // v33: the grant ledger (PRD connection-attribution A1). One row per grant an `api`
  // connection was given: on its creation, on a new consent, on a change of the credentials
  // it is configured with, and on the boot backfill. Deliberately no foreign key to
  // `connections`: a grant outlives its connection row, so that whatever was stamped with it
  // still names the connection after a reconnect or a delete. `reason` says which of those
  // minted it.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (33);
   CREATE TABLE IF NOT EXISTS connection_grants (
     grant_id      TEXT PRIMARY KEY,
     connection_id TEXT NOT NULL,
     kind          TEXT NOT NULL,
     reason        TEXT NOT NULL,
     minted_at     TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_connection_grants_connection ON connection_grants(connection_id);`,

  // v34 (control-plane trail, PRD cp-admin-line §3.3): when a row was written, beside `ts`, when
  // its act happened. The same for every row but one written late, after the log could not be
  // written at the time; `recorded_at ≠ ts` marks that one. NULL on rows from before.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (34);
   ALTER TABLE audit_log ADD COLUMN recorded_at TEXT;`,

  // v35: what a bulk run spent on model calls, and the most it may spend (PRD bulk-loop §3.3).
  // `cost_usd` is booked spend in USD — what the calls were charged at, not the estimate made
  // before each call (a model without a registered price is charged at the fallback rate,
  // so on such a model the booking is itself an estimate); 0 on every run that called no model,
  // which is every run before the judge. `cost_cap_usd` is the owner's limit, set when a run
  // with a judge is started; NULL means none was set.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (35);
   ALTER TABLE bulk_runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
   ALTER TABLE bulk_runs ADD COLUMN cost_cap_usd REAL;`,

  // v36: a run whose after-states a model decides, one target at a time (PRD bulk-loop §3.1,
  // `bulk_judge`). On `bulk_runs`: `judge_rule` — the rule text, the output schema and the tier,
  // encrypted with `enc()` like the images; `judge_rule_hash` — an HMAC over it under the same
  // subkey as `rule_hash`, which the start and the approval present; `judge_started_at` — when
  // the owner started the judge, from which an unapproved judged run's retention counts. On
  // `bulk_targets`: `judged_at` — the target's verdict is recorded (read and unjudged is
  // `before IS NOT NULL AND judged_at IS NULL`); `judge_claimed_at` + `judge_claim_token` — the
  // claim a judge loop takes before it pays for a call, so a second loop after a lost lease
  // does not pay for the same target, and a verdict is written only under its own token.
  // All NULL on every run without a judge.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (36);
   ALTER TABLE bulk_runs ADD COLUMN judge_rule TEXT;
   ALTER TABLE bulk_runs ADD COLUMN judge_rule_hash TEXT;
   ALTER TABLE bulk_runs ADD COLUMN judge_started_at TEXT;
   ALTER TABLE bulk_targets ADD COLUMN judged_at TEXT;
   ALTER TABLE bulk_targets ADD COLUMN judge_claimed_at TEXT;
   ALTER TABLE bulk_targets ADD COLUMN judge_claim_token TEXT;`,

  // v37: one row per accepted workflow grant (workflow grant attribution), written once and never changed. The stamp
  // on the workflow is overwritten by the next acceptance; this row is what still says which
  // contract was shown, who accepted it, when, and for which schedule, after that. A run
  // names its row by `id` (history.db `pipeline_runs.workflow_grant_id`).
  // ⚠ `workflow_id` is a soft reference, no `REFERENCES`: this file runs with foreign keys on,
  // and a foreign key would either block deleting the workflow, or (CASCADE / SET NULL) delete
  // or change a row that is meant never to change. The owner's erasure empties the table like
  // every other (`deleteAllData` enumerates `sqlite_master`): the grant is the owner's
  // configuration and goes with it.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (37);
   CREATE TABLE IF NOT EXISTS workflow_grants (
     id                TEXT PRIMARY KEY,
     workflow_id       TEXT NOT NULL,
     contract_json     TEXT NOT NULL,
     accepted_by       TEXT NOT NULL,
     name              TEXT,
     accepted_at       TEXT NOT NULL,
     checksum          TEXT NOT NULL,
     binding           TEXT NOT NULL,
     trigger_id        TEXT NOT NULL,
     cron              TEXT NOT NULL,
     bound_params_json TEXT NOT NULL,
     after_untrusted   INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_workflow_grants_workflow ON workflow_grants(workflow_id);`,

  // v38: the engine's own record that the control plane cleared this instance for an exact
  // (Shopify) connection (PRD-SHOPIFY-CONTAINMENT-ERASURE Appendix B, B7). One row, written once
  // before the first store pass after the first ok, and never changed: no code updates or
  // deletes it. Only the owner's erasure empties it (`deleteAllData` enumerates every table),
  // and the store profiles go with it then. While it is set and the control plane reports
  // `exact_held: false`, the managed hook asks the exact-attach route again.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (38);
   CREATE TABLE IF NOT EXISTS exact_marker (
     id          INTEGER PRIMARY KEY CHECK (id = 1),
     first_ok_at TEXT NOT NULL
   );`,

  // v39: whether a bulk target failed in any pass of its run (`failed_once`, 1 once it has).
  // `targets_failed` counts one pass and a resume sets it back; this is never set back, so a
  // page can show how many targets failed over all passes before the owner lets the run go on.
  // A run approved before this version may have had passes nobody recorded: its targets keep
  // NULL, and the status then reports no total rather than one made up. A run not yet approved
  // has written nothing and starts at 0, like a new one.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (39);
   ALTER TABLE bulk_targets ADD COLUMN failed_once INTEGER DEFAULT 0;
   UPDATE bulk_targets SET failed_once = NULL
     WHERE run_id IN (SELECT id FROM bulk_runs WHERE approved_at IS NOT NULL);`,

  // v40: which containers (a chat thread, a bulk run) a store connection's credential was
  // attached for (`containment.ts`). One row per container and connection, written before the
  // request it governs and never changed: the trigger refuses every UPDATE, so `first_at` is
  // the first attach's. Nothing in the code deletes a row; only the owner's erasure empties the
  // table (`deleteAllData` enumerates every table), and the threads and runs go with it then.
  // ⚠ `container_id` is a soft reference: threads live in history.db, and a bulk run's row is
  // written before its `bulk_runs` row in the same transaction.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (40);
   CREATE TABLE IF NOT EXISTS contained (
     container_kind TEXT NOT NULL CHECK (container_kind IN ('thread', 'bulk_run')),
     container_id   TEXT NOT NULL,
     kind           TEXT NOT NULL,
     connection_id  TEXT NOT NULL,
     first_at       TEXT NOT NULL,
     PRIMARY KEY (container_kind, container_id, kind, connection_id)
   );
   CREATE TRIGGER IF NOT EXISTS contained_written_once BEFORE UPDATE ON contained
   BEGIN SELECT RAISE(ABORT, 'contained rows are written once'); END;`,
  // v41: where each of the owner's vault secrets may go (vault-name-bindings.ts). One row per
  // name: the destinations it is bound to (a sorted JSON array of origins and token endpoints),
  // and whether the boot migration or the owner's answer at a save bound it. The second table
  // records that the one-time boot migration ran; the owner's erasure keeps it (like
  // `verb_backfill_marker`), so a profile stored after an erasure is bound only by the owner's
  // answer, never by a second migration.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (41);
   CREATE TABLE IF NOT EXISTS vault_name_bindings (
     name       TEXT PRIMARY KEY,
     endpoints  TEXT NOT NULL,
     origin     TEXT NOT NULL CHECK (origin IN ('migration', 'confirmed')),
     bound_at   TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS vault_name_binding_migration (
     migrated_at TEXT NOT NULL
   );`,
  // v42: the hosts of each grant, as snapshots (PRD connection-attribution A4). A row is the
  // grant's FULL host set (`credentialHosts`: the base URL's host and the token endpoint's, as
  // a sorted JSON array) from `from_at` on; the grant's next row ends it. Written at the mint, on
  // a save that changes the set, and at boot when the recomputed set differs (a preset whose
  // endpoints an upgrade moved). Removing the connection writes nothing: its newest snapshot does
  // not say when it ended. `id` orders the snapshots: an INTEGER PRIMARY KEY keeps its values through a
  // VACUUM, which a plain rowid does not promise. No foreign key, like `connection_grants`: a
  // snapshot outlives the connection row. The owner's erasure empties it with every other table.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (42);
   CREATE TABLE IF NOT EXISTS connection_grant_hosts (
     id         INTEGER PRIMARY KEY,
     grant_id   TEXT NOT NULL,
     hosts_json TEXT NOT NULL,
     from_at    TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_connection_grant_hosts_grant ON connection_grant_hosts(grant_id);`,
  // v43: the connection and grant whose credential each bulk target's requests carried (PRD
  // connection-attribution A7), per target rather than per run, because a re-consent can land
  // mid-run. `read_*`: the requests that read the before-image (the preview); for an undo target,
  // both sides of its source target merged when the undo is planned. `write_*`: the requests of the
  // apply stage — the check, the write and its read-back (noted as the write leaves, and again when
  // the target is recorded). A target whose requests disagree keeps the first id and a NULL grant
  // (`mergeConnections`), which a reader counts as unknown. NULL throughout means no credential was
  // recorded: every local target, and every row from before this version — including the half of
  // a run in flight at the upgrade, whose later half the ledger then records with an unknown grant
  // where it meets the earlier one (a write first sent before, an undo of a target read before).
  // On `bulk_runs` (`first_*`) the first connection a target's read or write recorded for the run, as a summary
  // only (an undo run's comes from its first write, not from the read sides copied at planning). Ids are stored
  // in clear like `connection_grants`' (they name no account data), and unindexed: nothing selects
  // by them yet, and a run holds at most `BULK_MAX_TARGETS` rows.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (43);
   ALTER TABLE bulk_targets ADD COLUMN read_connection_id TEXT;
   ALTER TABLE bulk_targets ADD COLUMN read_grant_id TEXT;
   ALTER TABLE bulk_targets ADD COLUMN write_connection_id TEXT;
   ALTER TABLE bulk_targets ADD COLUMN write_grant_id TEXT;
   ALTER TABLE bulk_runs ADD COLUMN first_connection_id TEXT;
   ALTER TABLE bulk_runs ADD COLUMN first_grant_id TEXT;`,
  // v44: which mandate set a trigger up and which mandate changed it last, with the mandate's id
  // (PRD customer-granted-operator-access §3.9). A plan a mandate made runs as that mandate, and a
  // mandate is only live under its id (`principalHasEnded`): the tag alone (`created_by`,
  // `edited_by`) names a person, not the grant. `created_mandate_id` is set once, with the creator
  // tag. `mandate_editor[_id]` is the last MANDATE that changed the trigger, kept apart from
  // `edited_by` because the owner's stamp writes itself there (`TriggerStore.setConfirmedAt`);
  // neither the stamp nor an owner's edit touches it. A row from before this version keeps NULL
  // ids, and a mandate without an id counts as ended: its plan waits for the owner, never runs on
  // as the owner. No lookup by email: the same person can hold a second mandate.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (44);
   ALTER TABLE triggers ADD COLUMN created_mandate_id TEXT;
   ALTER TABLE triggers ADD COLUMN mandate_editor TEXT;
   ALTER TABLE triggers ADD COLUMN mandate_editor_id TEXT;
   UPDATE triggers SET mandate_editor = edited_by WHERE substr(edited_by, 1, ${MANDATE_TAG_PREFIX.length}) = '${MANDATE_TAG_PREFIX}';`,
  // v45: the same for workflows, and when a mandate last changed either.
  // `workflows.created_by` is the creating request's tag (NULL for
  // the owner and the engine, as on triggers made by the agent tool), set only by the INSERT: a
  // later save never touches it, so a mandate that edits the owner's workflow becomes its editor,
  // not its creator. `mandate_editor[_id]` and `mandate_edited_at` are the last MANDATE that
  // changed it, written by a mandate's save or rename only. `mandate_edited_at` is the time a
  // mandate's plan is compared against; without an edit, `created_at` is, when `created_by` is a
  // mandate. No backfill: nothing stored names a workflow's author, and a trigger edit from before
  // this version has no time. Such a trigger has a mandate editor without an id, which already
  // counts as ended.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (45);
   ALTER TABLE workflows ADD COLUMN created_by TEXT;
   ALTER TABLE workflows ADD COLUMN created_mandate_id TEXT;
   ALTER TABLE workflows ADD COLUMN mandate_editor TEXT;
   ALTER TABLE workflows ADD COLUMN mandate_editor_id TEXT;
   ALTER TABLE workflows ADD COLUMN mandate_edited_at TEXT;
   ALTER TABLE triggers ADD COLUMN mandate_edited_at TEXT;`,
  // v46: a target found already holding its planned value, to which this run never sent its
  // write verb (`found_unsent`). It takes no place of the cap on targets that receive the verb,
  // is no probe, and is not taken back by an undo: the run did not change it. Only a run created
  // from this version on can tell (`unsent_tracked`): in a run from before `write_sent` (v18) a
  // loop may have sent the verb and died unrecorded, leaving `write_sent = 0`, so a run that
  // exists at this migration keeps counting such a target as sent.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (46);
   ALTER TABLE bulk_runs ADD COLUMN unsent_tracked INTEGER NOT NULL DEFAULT 1;
   UPDATE bulk_runs SET unsent_tracked = 0;
   ALTER TABLE bulk_targets ADD COLUMN found_unsent INTEGER NOT NULL DEFAULT 0;`,
  // v47: inbound webhooks. A trigger's route token is kept only as its SHA-256
  // (`route_token_hash`), found by exact match through a unique index before a body byte is
  // read. `inbound_events` is the ledger of verified deliveries: `dedup_key` comes from the
  // signed bytes and is unique per instance, so one signed body is recorded once, whichever
  // trigger it reaches. A row keeps the delivery's evidence headers, never the body. No boot
  // sweep touches it.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (47);
   ALTER TABLE triggers ADD COLUMN route_token_hash TEXT;
   CREATE UNIQUE INDEX idx_triggers_route_token ON triggers(route_token_hash) WHERE route_token_hash IS NOT NULL;
   CREATE TABLE inbound_events (
     id           TEXT PRIMARY KEY,
     trigger_id   TEXT NOT NULL,
     dedup_key    TEXT NOT NULL UNIQUE,
     received_at  TEXT NOT NULL,
     state        TEXT NOT NULL CHECK (state IN ('received', 'running', 'done', 'failed', 'dropped')),
     reason       TEXT,
     run_id       TEXT,
     values_json  TEXT,
     headers_json TEXT NOT NULL DEFAULT '{}',
     updated_at   TEXT NOT NULL
   );
   CREATE INDEX idx_inbound_events_trigger ON inbound_events(trigger_id, state, received_at);`,
  // v48: the approval queue (`core/approval-store.ts`). An entry is a mail a run nobody watches
  // handed to its owner; `payload_json` is customer data, written through `enc()`, and has no
  // UPDATE path, nor have `origin_json` and `checksum`. `dedup_key` and `family_key` are keyed
  // hashes, because the plain keys hold recipients and subjects. The partial unique index makes
  // two concurrent filings of the same mail one while either is waiting, running or of unknown
  // outcome. `origin_json`'s source has no CHECK: a new source needs no migration, and a row
  // with a source this engine does not know is read but never executed. The trigger holds what
  // an entry binds — kind, payload, origin, checksum, keys, creator and lifetime — against any
  // UPDATE; its one exception is the tombstone, which empties the payload of an `unknown` entry
  // and keeps the rest (`tombstoned_at`).
  `INSERT OR IGNORE INTO schema_version (version) VALUES (48);
   CREATE TABLE approval_entries (
     id             TEXT PRIMARY KEY,
     kind           TEXT NOT NULL CHECK (kind IN ('mail_reply', 'mail_send')),
     payload_json   TEXT NOT NULL,
     origin_json    TEXT NOT NULL,
     dedup_key      TEXT NOT NULL,
     family_key     TEXT,
     checksum       TEXT NOT NULL,
     binding        TEXT NOT NULL CHECK (binding IN ('keyed', 'unkeyed')),
     created_by     TEXT,
     mandate_id     TEXT,
     status         TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'executing', 'done', 'failed', 'unknown', 'rejected', 'expired')),
     held_reason    TEXT,
     held_at        TEXT,
     created_at     TEXT NOT NULL,
     expires_at     TEXT NOT NULL,
     decided_at     TEXT,
     decided_by     TEXT,
     decided_reason TEXT,
     claimed_at     TEXT,
     executed_at    TEXT,
     attempts       INTEGER NOT NULL DEFAULT 0,
     result_json    TEXT,
     purge_after    TEXT,
     tombstoned_at  TEXT
   );
   CREATE UNIQUE INDEX idx_approval_entries_active ON approval_entries(dedup_key)
     WHERE status IN ('pending', 'approved', 'executing', 'unknown');
   CREATE INDEX idx_approval_entries_dedup ON approval_entries(dedup_key, status);
   CREATE INDEX idx_approval_entries_family ON approval_entries(family_key, status) WHERE family_key IS NOT NULL;
   CREATE INDEX idx_approval_entries_status ON approval_entries(status, created_at);
   CREATE INDEX idx_approval_entries_purge ON approval_entries(purge_after) WHERE purge_after IS NOT NULL;
   CREATE TRIGGER approval_entries_written_once BEFORE UPDATE ON approval_entries
   WHEN OLD.id IS NOT NEW.id OR OLD.kind IS NOT NEW.kind OR OLD.origin_json IS NOT NEW.origin_json
     OR OLD.checksum IS NOT NEW.checksum OR OLD.binding IS NOT NEW.binding
     OR OLD.dedup_key IS NOT NEW.dedup_key OR OLD.family_key IS NOT NEW.family_key
     OR OLD.created_by IS NOT NEW.created_by OR OLD.mandate_id IS NOT NEW.mandate_id
     OR OLD.created_at IS NOT NEW.created_at OR OLD.expires_at IS NOT NEW.expires_at
     OR (OLD.payload_json IS NOT NEW.payload_json
         AND NOT (NEW.payload_json = '' AND OLD.status = 'unknown' AND NEW.status = 'unknown' AND NEW.tombstoned_at IS NOT NULL))
   BEGIN SELECT RAISE(ABORT, 'approval entries bind what was filed: it is written once'); END;`,
  // v49: erasure by connection, cut 1 (PRD-SOURCE-CONNECTION revision 8, E2).
  // `connections.first_grant_id` is the grant the row was created with: set by the INSERT, and
  // by an update only while it is still NULL, so a `new` grant minted later on the same row (the
  // corrected save of a profile the boot held back) does not start a new epoch. A row from before
  // this version takes its connection's latest `new` or `backfill` grant. That can be later than
  // the grant the row was created with, when a held-back profile was saved again before this
  // version: its earlier grants then fall outside, and are not erased. Taking an earlier grant
  // instead could reach a connection removed earlier under the same id, whose rows are not this
  // one's. A row with neither stays NULL and covers nothing.
  // `connection_records` holds one row per removed `api` connection, written in the delete's
  // transaction: `erasure` from the `api_setup` delete, `closing` from every other. An erasure
  // record fixes the grants it covers (`covered_grants_json`); every record keeps the grants the
  // removal ended (`ended_grants_json`), so a connection brought back with one of them covers
  // nothing and no earlier record reaches its rows. `history_state` is the run-history
  // store's state, and only `done` is ever shown as erased. `runs_active_json` is the runs that
  // were active at its first sweep, NULL until then. `label` is the connection's name, blanked
  // when a closing record is written and when an erasure record is done. `wal_scrub_pending` is
  // set when a store becomes done and cleared once a WAL checkpoint went through, so a blocked
  // checkpoint is tried again by the next pass. No foreign key: a record
  // outlives the connection row it names. The owner's erasure empties it with every other table.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (49);
   ALTER TABLE connections ADD COLUMN first_grant_id TEXT;
   UPDATE connections SET first_grant_id = (
     SELECT g.grant_id FROM connection_grants g
      WHERE g.connection_id = connections.id AND g.kind = 'api' AND g.reason IN ('new', 'backfill')
      ORDER BY g.rowid DESC LIMIT 1
   ) WHERE kind = 'api';
   CREATE TABLE connection_records (
     id                  INTEGER PRIMARY KEY,
     kind                TEXT NOT NULL CHECK (kind IN ('erasure', 'closing')),
     connection_id       TEXT NOT NULL,
     label               TEXT,
     covered_grants_json TEXT NOT NULL DEFAULT '[]',
     ended_grants_json   TEXT NOT NULL DEFAULT '[]',
     runs_active_json    TEXT,
     history_state       TEXT NOT NULL CHECK (history_state IN ('pending', 'done', 'not reached', 'failed', 'late')),
     created_at          TEXT NOT NULL,
     deadline            TEXT NOT NULL,
     done_at             TEXT,
     wal_scrub_pending   INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX idx_connection_records_connection ON connection_records(connection_id);`,
  // v50: where a connection's epoch starts, by time (supersedes v49's fill, which took the latest
  // beginning grant). The rule is `epochStartByTimeSql`, the one the store's write reads too.
  // It recomputes every `api` row: a row written since v49 got its start in the INSERT's
  // transaction, which this rule finds again (unless an earlier connection under the same id began
  // within two seconds of it: then it stays empty); a row from before v49 that took a later grant (a
  // held-back profile saved again) gets the grant it was created with; a start this ledger does not
  // hold for the id (a file copied from another engine) gives way to the row's own beginning, or to
  // empty until the boot gives it one.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (50);
   UPDATE connections SET first_grant_id = ${epochStartByTimeSql('connections.id', 'connections.created_at', 'connections.config_json')}
   WHERE kind = 'api';`,
  // v51 — the connections the owner's stamp of a plan lists (`plan-stamp.ts`). Empty for every
  // stamp written before: such a plan uses none of a member's own connections, as before.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (51);
   ALTER TABLE triggers ADD COLUMN stamp_connections TEXT;`,
  // v52: a removal record says what started it. `cause` is `owner_delete` for every record a
  // delete wrote (all records before this version) and `provider_revoked` for one a provider's
  // refusal of the stored grant wrote; `revoked_grant` is that grant. A provider's erasure is held
  // until `hold_until` (the sweep does not read it before), and the owner can cancel it while it is
  // held (`cancelled`, `cancelled_at`). `kept_after_hold` counts, without content, the calls of the
  // covered grants from runs after the hold that the erasure leaves (NULL until its first pass).
  // SQLite cannot alter a CHECK, so the table is rebuilt with
  // every row. One live provider erasure per refused grant: a cancelled one does not count, and a
  // `closing` record does not block a later erasure.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (52);
   CREATE TABLE connection_records_v52 (
     id                  INTEGER PRIMARY KEY,
     kind                TEXT NOT NULL CHECK (kind IN ('erasure', 'closing')),
     connection_id       TEXT NOT NULL,
     label               TEXT,
     covered_grants_json TEXT NOT NULL DEFAULT '[]',
     ended_grants_json   TEXT NOT NULL DEFAULT '[]',
     runs_active_json    TEXT,
     history_state       TEXT NOT NULL CHECK (history_state IN ('pending', 'done', 'not reached', 'failed', 'late', 'cancelled')),
     created_at          TEXT NOT NULL,
     deadline            TEXT NOT NULL,
     done_at             TEXT,
     wal_scrub_pending   INTEGER NOT NULL DEFAULT 0,
     cause               TEXT NOT NULL DEFAULT 'owner_delete' CHECK (cause IN ('owner_delete', 'provider_revoked')),
     hold_until          TEXT,
     cancelled_at        TEXT,
     revoked_grant       TEXT,
     kept_after_hold     INTEGER
   );
   INSERT INTO connection_records_v52 (id, kind, connection_id, label, covered_grants_json, ended_grants_json, runs_active_json, history_state, created_at, deadline, done_at, wal_scrub_pending)
     SELECT id, kind, connection_id, label, covered_grants_json, ended_grants_json, runs_active_json, history_state, created_at, deadline, done_at, wal_scrub_pending FROM connection_records;
   DROP TABLE connection_records;
   ALTER TABLE connection_records_v52 RENAME TO connection_records;
   CREATE INDEX idx_connection_records_connection ON connection_records(connection_id);
   CREATE UNIQUE INDEX idx_connection_records_provider_erasure ON connection_records(connection_id, revoked_grant)
     WHERE kind = 'erasure' AND cause = 'provider_revoked' AND history_state <> 'cancelled';`,
  // v53 — the last id a Shopify list read has recorded (`bulk-shopify.ts`). Its pages are asked
  // for by id (`id:>N`), not by page number, so a read that goes on in a later tick starts after
  // it. 0 before the first page, and on every other run.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (53);
   ALTER TABLE bulk_runs ADD COLUMN list_last_id INTEGER NOT NULL DEFAULT 0;`,

  // v54: how many sends to a bulk target ended without a clear answer (`unknown_sends`). Each
  // send adds one before it leaves, and only that send's own refusal takes it back, so one
  // unclear send keeps the target from being sent to again. A target sent to before this
  // version and not written has an answer nobody recorded: it counts as one unclear send. That
  // includes a target v18 marked sent for a `write_failed` from before v18, which may have failed
  // before anything left; counting it unclear errs towards not sending twice.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (54);
   ALTER TABLE bulk_targets ADD COLUMN unknown_sends INTEGER NOT NULL DEFAULT 0;
   UPDATE bulk_targets SET unknown_sends = 1 WHERE write_sent = 1 AND applied_at IS NULL;`,

  // v55 (owner's view of the actor trail): `plan_run` is the key a plan's run shares with every row
  // written within it (the correlation id of its `plan:run` rows), so the view shows a run as one
  // entry. `trail_form` is set on every row written from now on; the view shows only those, since
  // a row from before could name a person for a read made after that person's access had ended.
  // Existing rows keep both NULL: nothing is backfilled, and the update trigger stays.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (55);
   ALTER TABLE audit_log ADD COLUMN plan_run TEXT;
   ALTER TABLE audit_log ADD COLUMN trail_form INTEGER;`,
];

export interface EngineDbOptions {
  /**
   * What a database that looks corrupt gets. `throw` (the default): the failure is thrown with
   * what the operator can do, the handle closed and the file left where it is. Any opener but the
   * boot edits a database something else then uses (a script against a live data directory, a
   * restore), where an empty one in its place would pass for the real one. `recreate`: it is set
   * aside as `<path>.corrupt-<ms>` and an empty one is opened in its place — only for the boot,
   * which must start.
   */
  onCorruption?: 'recreate' | 'throw' | undefined;
}

/**
 * Low-level SQLite wrapper for the consolidated engine.db (subject graph).
 * All methods are synchronous (better-sqlite3 is sync). Mirrors the RunHistory
 * constructor + corruption-recovery + encryption pattern.
 */
export class EngineDb {
  private db: Database.Database;
  private readonly dbPath: string;
  private readonly _encKey: Buffer | null;
  private readonly _hashKey: Buffer | null;
  private readonly _bindKey: Buffer | null;
  private _decWarnedNoKey = false;
  private _decWarnedFailCount = 0;

  constructor(dbPath?: string | undefined, encryptionKey?: string | undefined, options: EngineDbOptions = {}) {
    const path = dbPath ?? getDefaultDbPath();
    this.dbPath = path;
    ensureDirSync(dirname(path));
    this.db = null!; // assigned by _openOrRecreate
    this._openOrRecreate(path, options.onCorruption ?? 'throw');

    // Derive engine-db encryption key via HKDF from the vault key (D2: parity
    // with history.db). Distinct salt+info so engine.db and history.db never
    // share a derived key.
    const vaultKey = encryptionKey ?? process.env['LYNOX_VAULT_KEY'] ?? '';
    if (vaultKey) {
      this._encKey = Buffer.from(hkdfSync('sha256', vaultKey, 'lynox-engine', ENGINE_HKDF_INFO, CRYPTO_KEY_LENGTH));
      this._hashKey = Buffer.from(hkdfSync('sha256', vaultKey, 'lynox-engine', ENGINE_HASH_HKDF_INFO, CRYPTO_KEY_LENGTH));
      this._bindKey = Buffer.from(hkdfSync('sha256', vaultKey, 'lynox-engine', STORE_BINDING_HKDF_INFO, CRYPTO_KEY_LENGTH));
    } else {
      this._encKey = null;
      this._hashKey = null;
      this._bindKey = null;
    }
  }

  get path(): string { return this.dbPath; }

  /** Raw connection — S1 store classes (SubjectStore, etc.) share this. */
  getDb(): Database.Database { return this.db; }

  /** True once the boot-time verb-graph backfill (B1 self-heal) has run for this
   *  engine.db. Gates the copy to exactly-once so a deleted definition is never
   *  resurrected from the still-present legacy rows (see verb_backfill_marker / v5). */
  isVerbBackfillDone(): boolean {
    const row = this.db.prepare('SELECT done FROM verb_backfill_marker WHERE id = 1').get() as
      | { done: number }
      | undefined;
    return row?.done === 1;
  }

  /** Mark the boot-time verb-graph backfill complete (idempotent). */
  markVerbBackfillDone(): void {
    this.db.prepare('UPDATE verb_backfill_marker SET done = 1 WHERE id = 1').run();
  }

  /** Drop the free pages and empty the WAL; see `scrubFreedPages` in `sqlite-constants.ts`. */
  scrubFreedPages(): void {
    scrubFreedPages(this.db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * GDPR Art. 17 (Right to Erasure): delete every user-data row in engine.db,
   * leaving only the schema_version + verb_backfill_marker bookkeeping (so the
   * schema stays intact and is NOT re-migrated on next open, AND the erasure is not
   * silently UNDONE by the boot verb-graph backfill re-populating from the still-
   * present legacy history.db). Tables are enumerated from sqlite_master so any table
   * a later sprint (S3–S6) adds is wiped automatically — a hardcoded list would
   * silently leak PII the day a new table lands. `defer_foreign_keys` postpones every
   * FK check to COMMIT, by which point all rows are gone, so the delete order is
   * irrelevant and a future RESTRICT/CASCADE edge can't fail mid-wipe. Table names
   * come from sqlite_master (schema identifiers, never user input) — the
   * interpolation is injection-safe.
   */
  deleteAllData(): void {
    const tables = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_version', 'verb_backfill_marker', 'vault_name_binding_migration') AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    this.db.transaction(() => {
      this.db.pragma('defer_foreign_keys = ON');
      for (const { name } of tables) {
        // name is a sqlite_master identifier (never user input); quoted anyway
        // as defense-in-depth so a future dynamic table can't break the statement.
        this.db.prepare(`DELETE FROM "${name}"`).run();
      }
    })();
  }

  /**
   * True when at-rest encryption is active (a vault key was available).
   * @internal — posture introspection; not a public API.
   */
  get isEncrypted(): boolean { return this._encKey !== null; }

  /**
   * Open the SQLite database. ONLY a failed `integrity_check` (genuine file
   * corruption) may rename the file aside and start fresh. Schema migration runs
   * AFTER that decision, OUTSIDE the corruption-catch, and fails LOUD (propagates,
   * keeps the file): a migration error — a transient SQLITE_BUSY/disk-full/IO fault
   * mid-ALTER, or a deterministic migration bug — must NEVER be mistaken for
   * corruption and trigger the wipe-and-recreate path, which would silently destroy
   * the real subject-graph data of a reads-ON tenant while the engine boots "healthy".
   */
  private _openOrRecreate(path: string, onCorruption: 'recreate' | 'throw'): void {
    let db = new Database(path);
    let reported = false;
    try {
      const result = db.pragma('integrity_check') as { integrity_check: string }[];
      if (result[0]?.integrity_check !== 'ok') {
        reported = true;
        throw new Error(`integrity_check: ${result[0]?.integrity_check ?? 'unknown'}`);
      }
    } catch (err) {
      // Only what corruption looks like is set aside: the check reporting a fault, or SQLite
      // finding no database or a malformed image. Anything else (a file another process holds
      // past the wait, an I/O fault) fails the open loud and keeps the file.
      if (!(reported || isCorruptionError(err))) {
        try { db.close(); } catch { /* best-effort */ }
        throw err;
      }
      if (onCorruption === 'throw') {
        try { db.close(); } catch { /* best-effort */ }
        throw corruptFileLeftInPlace(basename(path), err);
      }
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
    }
    // Common path for both the healthy open and the freshly-recreated DB. The
    // busy_timeout absorbs transient cross-process lock contention (e.g. the
    // operator subject-sweep opening a second handle against the live engine)
    // instead of throwing an instant SQLITE_BUSY — which mid-migration would be
    // the very fault that used to trigger the wipe. Migration runs here (not in
    // the corruption-catch above) so any failure surfaces loud, file intact —
    // closing the handle first so a caught boot failure (engine.ts keeps running
    // with engineDb=null) doesn't leak the fd + WAL lock for the process lifetime.
    try {
      db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      db.pragma('journal_mode = WAL');
      zeroDeletedContent(db);
      db.pragma('foreign_keys = ON');
      this.db = db;
      this._ensureSchemaVersion();
      this._migrate();
    } catch (err) {
      try { db.close(); } catch { /* best-effort */ }
      throw err;
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

  /** Whether {@link keyedHash} is an HMAC (a vault key is set) or plain SHA-256. A
   *  caller whose digest is meant to BIND something must say which one it got. */
  get hashIsKeyed(): boolean {
    return this._hashKey !== null;
  }

  /**
   * A digest of `parts` that, with a vault key, cannot be dictionary-attacked from a copy
   * of the file:
   * HMAC-SHA256 under a subkey derived from the same vault key as `enc()`'s (own HKDF
   * label), so recomputing it needs that vault key. Without a key it falls back to plain SHA-256 — the same mixed mode as `enc()`,
   * which stores plaintext then. Parts are fed one at a time, length-prefixed, so a
   * large input is never joined into one string and no two part lists collide.
   * @internal — see {@link enc}.
   */
  keyedHash(parts: Iterable<string>): string {
    const h = this._hashKey ? createHmac('sha256', this._hashKey) : createHash('sha256');
    for (const p of parts) h.update(`${String(Buffer.byteLength(p, 'utf8'))}:`).update(p);
    return h.digest('hex');
  }

  /**
   * The binding of a store connection's token to its profile and store (Appendix B, B4): an
   * HMAC under a subkey of the vault key with its own label, over the profile id, the store
   * origin and the token, length-prefixed. `null` without a vault key: an unkeyed digest
   * would be forgeable by anyone who can write the profile record, so there is no binding,
   * and the attach refuses.
   */
  storeBindingDigest(profileId: string, origin: string, value: string): string | null {
    if (this._bindKey === null) return null;
    const h = createHmac('sha256', this._bindKey);
    for (const p of [profileId, origin, value]) h.update(`${String(Buffer.byteLength(p, 'utf8'))}:`).update(p);
    return h.digest('hex');
  }

  /** Whether the exact marker is set. Throws when it cannot be read (B7: no statement then). */
  exactMarkerSet(): boolean {
    return this.db.prepare('SELECT 1 FROM exact_marker WHERE id = 1').get() !== undefined;
  }

  /** Set the exact marker; a second call keeps the first stamp. Throws when it cannot be written. */
  setExactMarker(): void {
    this.db.prepare("INSERT OR IGNORE INTO exact_marker (id, first_ok_at) VALUES (1, datetime('now'))").run();
  }

  /** Same as `AgentMemoryDb.setSecureDelete`, for engine.db. Returns the previous setting. */
  setSecureDelete(on: boolean): boolean {
    const before = this.db.pragma('secure_delete', { simple: true }) === 1;
    this.db.pragma(`secure_delete = ${on ? 'ON' : 'OFF'}`);
    return before;
  }

  /** Fold the write-ahead log into the file and truncate it. False when a reader kept it from finishing. */
  checkpointTruncate(): boolean {
    const r = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    return r[0]?.busy === 0;
  }

  /**
   * Decrypt text from storage, or `null` when it is encrypted and cannot be read (no key, wrong
   * key, corrupted). {@link dec} returns the ciphertext in that case, which a text search reads
   * as "no match": the person erasure would then report nothing found while the rows stay.
   * @internal — see {@link enc}.
   */
  tryDec(text: string): string | null {
    if (!text) return text;
    const r = this.decStrict(text);
    if (!r.ok) this._warnUndecryptable(r.kind);
    return r.ok ? r.text : null;
  }

  /**
   * Decrypt text from storage and say whether it worked ({@link strictDecrypt}). For a reader that
   * passes the text on: unlike {@link dec}, a value it cannot read never comes back as its text.
   * @internal — see {@link enc}.
   */
  decStrict(text: string): StrictDecryptResult {
    return strictDecrypt(text, this._encKey);
  }

  /**
   * Decrypt text from storage. Handles both encrypted and plaintext (mixed mode).
   * @internal — see {@link enc}.
   */
  dec(text: string): string {
    // A NULL column read at run time passes through, as it always has.
    if (!text) return text;
    const r = this.decStrict(text);
    if (r.ok) return r.text;
    this._warnUndecryptable(r.kind);
    return text;
  }

  private _warnUndecryptable(kind: 'no_key' | 'failed'): void {
    if (kind === 'no_key') {
      if (!this._decWarnedNoKey) {
        this._decWarnedNoKey = true;
        process.stderr.write('⚠ Engine: encrypted data found but no encryption key set — data unreadable\n');
      }
    } else if (this._decWarnedFailCount < 3) {
      this._decWarnedFailCount++;
      process.stderr.write('⚠ Engine: decryption failed for encrypted record — wrong key or corrupted data\n');
    }
  }
}

/**
 * A stored text a search must read could not be decrypted ({@link EngineDb.tryDec}). Thrown
 * instead of treating the row as "no match", so a search over encrypted rows never reports a
 * clean result it could not check.
 */
export class UndecryptableTextError extends Error {
  constructor(where: string) {
    super(`Stored text in ${where} cannot be decrypted with the current key`);
    this.name = 'UndecryptableTextError';
  }
}
