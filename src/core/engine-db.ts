import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { renameSync } from 'node:fs';
import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { getLynoxDir } from './config.js';
import { CRYPTO_ALGORITHM, CRYPTO_KEY_LENGTH, CRYPTO_IV_LENGTH, CRYPTO_TAG_LENGTH } from './crypto-constants.js';
import { ensureDirSync } from './atomic-write.js';
import { SQLITE_BUSY_TIMEOUT_MS } from './sqlite-constants.js';

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
  // GRANDFATHER (rafael decision): every EXISTING run_agent trigger predates the
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
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_version', 'verb_backfill_marker') AND name NOT LIKE 'sqlite_%'",
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
  private _openOrRecreate(path: string): void {
    let db = new Database(path);
    try {
      const result = db.pragma('integrity_check') as { integrity_check: string }[];
      if (result[0]?.integrity_check !== 'ok') {
        throw new Error(`integrity_check: ${result[0]?.integrity_check ?? 'unknown'}`);
      }
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
