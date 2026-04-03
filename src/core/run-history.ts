import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { renameSync } from 'node:fs';
import { hkdfSync, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { sha256Short } from './utils.js';
import { getLynoxDir } from './config.js';
import { CRYPTO_ALGORITHM, CRYPTO_KEY_LENGTH, CRYPTO_IV_LENGTH, CRYPTO_TAG_LENGTH } from './crypto-constants.js';
import { ensureDirSync } from './atomic-write.js';
import type { TaskRecord } from '../types/index.js';
import * as analytics from './run-history-analytics.js';
import * as persistence from './run-history-persistence.js';

const HISTORY_HKDF_INFO = 'lynox-history-encryption';
const ENCRYPTED_PREFIX = 'enc:'; // Marks encrypted text in DB

function getDefaultDbPath(): string {
  return join(getLynoxDir(), 'history.db');
}

export interface RunRecord {
  id: string;
  session_id: string;
  task_hash: string;
  task_text: string;
  response_text: string;
  model_tier: string;
  model_id: string;
  prompt_hash: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost_usd: number;
  tool_call_count: number;
  duration_ms: number;
  user_wait_ms: number;
  stop_reason: string;
  status: 'running' | 'completed' | 'failed';
  run_type: 'single' | 'batch_parent' | 'batch_item';
  batch_parent_id: string | null;
  spawn_parent_id: string | null;
  spawn_depth: number;
  context_id: string;
  created_at: string;
}

export interface ToolCallRecord {
  id: string;
  run_id: string;
  tool_name: string;
  input_json: string;
  output_json: string;
  duration_ms: number;
  sequence_order: number;
}

export interface RunStats {
  total_runs: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  avg_duration_ms: number;
  cost_by_model: Array<{ model_id: string; cost_usd: number; run_count: number }>;
}

/** Per-run data for Pattern Engine analysis. */
export interface AnalysisRun {
  id: string;
  sessionId: string;
  status: string;
  toolNames: string[];
  durationMs: number;
  costUsd: number;
}

/** Thread-level aggregate for insights API. */
export interface ThreadAggregate {
  sessionId: string;
  title: string;
  runCount: number;
  successCount: number;
  failedCount: number;
  toolCounts: Record<string, number>;
  totalDurationMs: number;
  totalCostUsd: number;
  lastRunAt: string;
}

export interface PromptSnapshotRecord {
  hash: string;
  profile_name: string;
  prompt_text: string;
  first_seen_at: string;
}

function generateId(): string {
  return randomUUID();
}

export function hashTask(text: string): string {
  return sha256Short(text);
}

const MIGRATIONS: string[] = [
  // v1: Initial schema
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
   INSERT OR IGNORE INTO schema_version (version) VALUES (1);

   CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL DEFAULT '',
     task_hash TEXT NOT NULL DEFAULT '',
     task_text TEXT NOT NULL DEFAULT '',
     response_text TEXT NOT NULL DEFAULT '',
     model_tier TEXT NOT NULL DEFAULT '',
     model_id TEXT NOT NULL DEFAULT '',
     prompt_hash TEXT NOT NULL DEFAULT '',
     tokens_in INTEGER NOT NULL DEFAULT 0,
     tokens_out INTEGER NOT NULL DEFAULT 0,
     tokens_cache_read INTEGER NOT NULL DEFAULT 0,
     tokens_cache_write INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0,
     tool_call_count INTEGER NOT NULL DEFAULT 0,
     duration_ms INTEGER NOT NULL DEFAULT 0,
     stop_reason TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'running',
     run_type TEXT NOT NULL DEFAULT 'single',
     batch_parent_id TEXT,
     spawn_parent_id TEXT,
     spawn_depth INTEGER NOT NULL DEFAULT 0,
     project_dir TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );

   CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
   CREATE INDEX IF NOT EXISTS idx_runs_task_hash ON runs(task_hash);
   CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
   CREATE INDEX IF NOT EXISTS idx_runs_batch_parent ON runs(batch_parent_id);
   CREATE INDEX IF NOT EXISTS idx_runs_spawn_parent ON runs(spawn_parent_id);

   CREATE TABLE IF NOT EXISTS run_tool_calls (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     tool_name TEXT NOT NULL,
     input_json TEXT NOT NULL DEFAULT '{}',
     output_json TEXT NOT NULL DEFAULT '',
     duration_ms INTEGER NOT NULL DEFAULT 0,
     sequence_order INTEGER NOT NULL DEFAULT 0,
     FOREIGN KEY (run_id) REFERENCES runs(id)
   );

   CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON run_tool_calls(run_id);

   CREATE TABLE IF NOT EXISTS run_spawns (
     id TEXT PRIMARY KEY,
     parent_run_id TEXT NOT NULL,
     child_run_id TEXT NOT NULL,
     spawn_type TEXT NOT NULL DEFAULT 'thinker',
     depth INTEGER NOT NULL DEFAULT 0,
     FOREIGN KEY (parent_run_id) REFERENCES runs(id),
     FOREIGN KEY (child_run_id) REFERENCES runs(id)
   );

   CREATE INDEX IF NOT EXISTS idx_spawns_parent ON run_spawns(parent_run_id);`,

  // v2: Prompt snapshots
  `INSERT OR IGNORE INTO schema_version (version) VALUES (2);

   CREATE TABLE IF NOT EXISTS prompt_snapshots (
     hash TEXT PRIMARY KEY,
     profile_name TEXT NOT NULL DEFAULT 'default',
     prompt_text TEXT NOT NULL,
     first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // v3: Memory embeddings for RAG
  `INSERT OR IGNORE INTO schema_version (version) VALUES (3);

   CREATE TABLE IF NOT EXISTS memory_embeddings (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL DEFAULT '',
     namespace TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL,
     embedding BLOB NOT NULL,
     embedding_dim INTEGER NOT NULL,
     provider TEXT NOT NULL DEFAULT 'local',
     source_run_id TEXT,
     last_retrieved_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );

   CREATE INDEX IF NOT EXISTS idx_embeddings_project ON memory_embeddings(project_id);
   CREATE INDEX IF NOT EXISTS idx_embeddings_provider ON memory_embeddings(provider);`,

  // v4: Pre-approval audit trail
  `INSERT OR IGNORE INTO schema_version (version) VALUES (4);

   CREATE TABLE IF NOT EXISTS pre_approval_sets (
     id TEXT PRIMARY KEY,
     task_summary TEXT NOT NULL,
     approved_by TEXT NOT NULL,
     patterns_json TEXT NOT NULL,
     max_uses INTEGER NOT NULL,
     ttl_ms INTEGER NOT NULL,
     run_id TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     FOREIGN KEY (run_id) REFERENCES runs(id)
   );

   CREATE TABLE IF NOT EXISTS pre_approval_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     set_id TEXT NOT NULL,
     pattern_idx INTEGER NOT NULL,
     tool_name TEXT NOT NULL,
     match_string TEXT NOT NULL,
     pattern TEXT NOT NULL,
     decision TEXT NOT NULL,
     autonomy_level TEXT,
     run_id TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     FOREIGN KEY (set_id) REFERENCES pre_approval_sets(id),
     FOREIGN KEY (run_id) REFERENCES runs(id)
   );

   CREATE INDEX IF NOT EXISTS idx_pa_events_set ON pre_approval_events(set_id);
   CREATE INDEX IF NOT EXISTS idx_pa_events_run ON pre_approval_events(run_id);
   CREATE INDEX IF NOT EXISTS idx_pa_events_created ON pre_approval_events(created_at);`,

  // v5: Remove spawn_type column (developer track removed)
  `INSERT OR IGNORE INTO schema_version (version) VALUES (5);

   CREATE TABLE IF NOT EXISTS run_spawns_new (
     id TEXT PRIMARY KEY,
     parent_run_id TEXT NOT NULL,
     child_run_id TEXT NOT NULL,
     depth INTEGER NOT NULL DEFAULT 0,
     FOREIGN KEY (parent_run_id) REFERENCES runs(id),
     FOREIGN KEY (child_run_id) REFERENCES runs(id)
   );

   INSERT INTO run_spawns_new (id, parent_run_id, child_run_id, depth)
     SELECT id, parent_run_id, child_run_id, depth FROM run_spawns;

   DROP TABLE run_spawns;
   ALTER TABLE run_spawns_new RENAME TO run_spawns;

   CREATE INDEX IF NOT EXISTS idx_spawns_parent ON run_spawns(parent_run_id);`,

  // v6: Advisor query indexes
  `INSERT OR IGNORE INTO schema_version (version) VALUES (6);
   CREATE INDEX IF NOT EXISTS idx_runs_project_dir ON runs(project_dir);
   CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);`,

  // v7: Pipeline runs & step results
  `INSERT OR IGNORE INTO schema_version (version) VALUES (7);

   CREATE TABLE IF NOT EXISTS pipeline_runs (
     id TEXT PRIMARY KEY,
     manifest_name TEXT NOT NULL,
     status TEXT NOT NULL,
     manifest_json TEXT NOT NULL,
     total_duration_ms INTEGER DEFAULT 0,
     total_cost_usd REAL DEFAULT 0,
     total_tokens_in INTEGER DEFAULT 0,
     total_tokens_out INTEGER DEFAULT 0,
     step_count INTEGER DEFAULT 0,
     parent_run_id TEXT,
     error TEXT,
     started_at TEXT DEFAULT (datetime('now')),
     completed_at TEXT
   );

   CREATE TABLE IF NOT EXISTS pipeline_step_results (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     pipeline_run_id TEXT NOT NULL,
     step_id TEXT NOT NULL,
     status TEXT NOT NULL,
     result TEXT DEFAULT '',
     error TEXT,
     duration_ms INTEGER DEFAULT 0,
     tokens_in INTEGER DEFAULT 0,
     tokens_out INTEGER DEFAULT 0,
     cost_usd REAL DEFAULT 0,
     FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
   );

   CREATE INDEX IF NOT EXISTS idx_pipeline_runs_name ON pipeline_runs(manifest_name);
   CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started ON pipeline_runs(started_at);
   CREATE INDEX IF NOT EXISTS idx_pipeline_step_results_run ON pipeline_step_results(pipeline_run_id);`,

  // v8: Memory scopes — scope registry + embedding scope fields
  `INSERT OR IGNORE INTO schema_version (version) VALUES (8);

   CREATE TABLE IF NOT EXISTS scopes (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL CHECK(type IN ('global','project','user')),
     name TEXT NOT NULL,
     parent_id TEXT REFERENCES scopes(id),
     metadata TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   INSERT OR IGNORE INTO scopes (id, type, name) VALUES ('global', 'global', 'Global');

   ALTER TABLE memory_embeddings ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'project';
   ALTER TABLE memory_embeddings ADD COLUMN scope_id TEXT NOT NULL DEFAULT '';
   CREATE INDEX IF NOT EXISTS idx_embeddings_scope ON memory_embeddings(scope_type, scope_id);

   -- Backfill: empty project_id → global scope, others → project scope
   UPDATE memory_embeddings SET scope_type = 'global', scope_id = 'global' WHERE project_id = '';
   UPDATE memory_embeddings SET scope_type = 'project', scope_id = project_id WHERE project_id != '';`,

  // v9: Expand scopes CHECK constraint for organization + client types
  `INSERT OR IGNORE INTO schema_version (version) VALUES (9);

   CREATE TABLE IF NOT EXISTS scopes_new (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL CHECK(type IN ('global','organization','client','project','user')),
     name TEXT NOT NULL,
     parent_id TEXT REFERENCES scopes_new(id),
     metadata TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );

   INSERT OR IGNORE INTO scopes_new (id, type, name, parent_id, metadata, created_at, updated_at)
     SELECT id, type, name, parent_id, metadata, created_at, updated_at FROM scopes;

   DROP TABLE scopes;
   ALTER TABLE scopes_new RENAME TO scopes;`,

  // v10: Advisor suggestion persistence
  `INSERT OR IGNORE INTO schema_version (version) VALUES (10);

   CREATE TABLE IF NOT EXISTS advisor_suggestions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT,
     type TEXT NOT NULL,
     priority TEXT NOT NULL,
     title TEXT NOT NULL,
     detail TEXT NOT NULL,
     estimated_impact_json TEXT,
     project_dir TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     FOREIGN KEY (run_id) REFERENCES runs(id)
   );
   CREATE INDEX IF NOT EXISTS idx_advisor_suggestions_project ON advisor_suggestions(project_dir);
   CREATE INDEX IF NOT EXISTS idx_advisor_suggestions_created ON advisor_suggestions(created_at);`,

  // v11: Advisor dismiss tracking
  `INSERT OR IGNORE INTO schema_version (version) VALUES (11);
   ALTER TABLE advisor_suggestions ADD COLUMN dismissed_at TEXT;`,

  // v12: Task management
  `INSERT OR IGNORE INTO schema_version (version) VALUES (12);

   CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','completed')),
     priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
     scope_type TEXT NOT NULL DEFAULT 'project',
     scope_id TEXT NOT NULL DEFAULT '',
     due_date TEXT,
     tags TEXT,
     parent_task_id TEXT REFERENCES tasks(id),
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     completed_at TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
   CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks(scope_type, scope_id);
   CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
   CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);`,

  // v13: Tenant isolation
  `INSERT OR IGNORE INTO schema_version (version) VALUES (13);

   CREATE TABLE IF NOT EXISTS tenants (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     config_json TEXT NOT NULL,
     budget_usd REAL NOT NULL DEFAULT 0,
     budget_used_usd REAL NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
     expires_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

   ALTER TABLE runs ADD COLUMN tenant_id TEXT REFERENCES tenants(id);
   CREATE INDEX IF NOT EXISTS idx_runs_tenant ON runs(tenant_id);`,

  // v14: Task assignee
  `INSERT OR IGNORE INTO schema_version (version) VALUES (14);
   ALTER TABLE tasks ADD COLUMN assignee TEXT;
   CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);`,

  // v15: Archetype tracking
  `INSERT OR IGNORE INTO schema_version (version) VALUES (15);
   ALTER TABLE runs ADD COLUMN archetype_id TEXT NOT NULL DEFAULT '';
   CREATE INDEX IF NOT EXISTS idx_runs_archetype ON runs(archetype_id);`,

  // v16: Scope simplification (5 → 3: global, context, user) + project_dir → context_id
  `INSERT OR IGNORE INTO schema_version (version) VALUES (16);

   -- Rebuild scopes table with new CHECK constraint
   CREATE TABLE IF NOT EXISTS scopes_v16 (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL CHECK(type IN ('global','context','user')),
     name TEXT NOT NULL,
     parent_id TEXT REFERENCES scopes_v16(id),
     metadata TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );

   -- Migrate data: map organization/client/project → context
   INSERT OR IGNORE INTO scopes_v16 (id, type, name, parent_id, metadata, created_at, updated_at)
     SELECT id,
            CASE
              WHEN type IN ('organization','client','project') THEN 'context'
              ELSE type
            END,
            name, NULL, metadata, created_at, updated_at
     FROM scopes;

   DROP TABLE IF EXISTS scopes;
   ALTER TABLE scopes_v16 RENAME TO scopes;

   -- Rename runs.project_dir → context_id
   ALTER TABLE runs RENAME COLUMN project_dir TO context_id;
   DROP INDEX IF EXISTS idx_runs_project_dir;
   CREATE INDEX IF NOT EXISTS idx_runs_context_id ON runs(context_id);

   -- Rename advisor_suggestions.project_dir → context_id
   ALTER TABLE advisor_suggestions RENAME COLUMN project_dir TO context_id;
   DROP INDEX IF EXISTS idx_advisor_suggestions_project;
   CREATE INDEX IF NOT EXISTS idx_advisor_suggestions_context ON advisor_suggestions(context_id);

   -- Update memory_embeddings scope_type: project → context
   UPDATE memory_embeddings SET scope_type = 'context' WHERE scope_type = 'project';
   UPDATE memory_embeddings SET scope_type = 'context' WHERE scope_type IN ('organization','client');`,

  // v17: Security audit trail
  `INSERT OR IGNORE INTO schema_version (version) VALUES (17);
   CREATE TABLE IF NOT EXISTS security_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     event_type TEXT NOT NULL,
     tool_name TEXT,
     input_preview TEXT,
     decision TEXT NOT NULL,
     autonomy_level TEXT,
     agent_name TEXT,
     run_id TEXT,
     source TEXT,
     detail TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);
   CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);`,

  // v18: Process capture — structured business process extraction from run history
  `INSERT OR IGNORE INTO schema_version (version) VALUES (18);
   CREATE TABLE IF NOT EXISTS processes (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     source_run_id TEXT NOT NULL,
     steps_json TEXT NOT NULL,
     parameters_json TEXT NOT NULL DEFAULT '[]',
     promoted_to_pipeline_id TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     FOREIGN KEY (source_run_id) REFERENCES runs(id)
   );
   CREATE INDEX IF NOT EXISTS idx_processes_source ON processes(source_run_id);`,

  // v19: Drop legacy memory_embeddings table (replaced by Knowledge Graph)
  `INSERT OR IGNORE INTO schema_version (version) VALUES (19);
   DROP TABLE IF EXISTS memory_embeddings;`,

  // v20: Task scheduling + pipeline bridge — cron, watch, run tracking, retries, notifications, pipeline_id
  `INSERT OR IGNORE INTO schema_version (version) VALUES (20);
   ALTER TABLE tasks ADD COLUMN schedule_cron TEXT;
   ALTER TABLE tasks ADD COLUMN next_run_at TEXT;
   ALTER TABLE tasks ADD COLUMN last_run_at TEXT;
   ALTER TABLE tasks ADD COLUMN last_run_result TEXT;
   ALTER TABLE tasks ADD COLUMN last_run_status TEXT;
   ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'manual';
   ALTER TABLE tasks ADD COLUMN watch_config TEXT;
   ALTER TABLE tasks ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tasks ADD COLUMN notification_channel TEXT;
   ALTER TABLE tasks ADD COLUMN pipeline_id TEXT;
   CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run_at);
   CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);`,

  // v21: User wait time tracking — separate AI processing time from user interaction wait
  `INSERT OR IGNORE INTO schema_version (version) VALUES (21);
   ALTER TABLE runs ADD COLUMN user_wait_ms INTEGER NOT NULL DEFAULT 0;`,

  // v22: Persistent conversation threads
  `INSERT OR IGNORE INTO schema_version (version) VALUES (22);

   CREATE TABLE IF NOT EXISTS threads (
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
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at);
   CREATE INDEX IF NOT EXISTS idx_threads_archived ON threads(is_archived);

   CREATE TABLE IF NOT EXISTS thread_messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     role TEXT NOT NULL,
     content_json TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id, seq);`,

  // v23: Track model tier on pipeline step results for history-based cost estimation
  `INSERT OR IGNORE INTO schema_version (version) VALUES (23);
   ALTER TABLE pipeline_step_results ADD COLUMN model_tier TEXT NOT NULL DEFAULT '';`,

  // v24: Favorite/pin threads
  `INSERT OR IGNORE INTO schema_version (version) VALUES (24);
   ALTER TABLE threads ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX IF NOT EXISTS idx_threads_favorite ON threads(is_favorite);`,

  // v25: Resumable pending prompts (ask_user / ask_secret)
  `INSERT OR IGNORE INTO schema_version (version) VALUES (25);

   CREATE TABLE IF NOT EXISTS pending_prompts (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     prompt_type TEXT NOT NULL CHECK(prompt_type IN ('ask_user','ask_secret')),
     question TEXT NOT NULL,
     options_json TEXT,
     secret_name TEXT,
     secret_key_type TEXT,
     answer TEXT,
     answer_saved INTEGER,
     status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','expired')),
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     answered_at TEXT,
     expires_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_pending_prompts_session ON pending_prompts(session_id, status);`,
];

export class RunHistory {
  private db: Database.Database;
  private readonly _encKey: Buffer | null;
  private _decWarnedNoKey = false;
  private _decWarnedFailCount = 0;

  constructor(dbPath?: string | undefined, encryptionKey?: string | undefined) {
    const path = dbPath ?? getDefaultDbPath();
    ensureDirSync(dirname(path));
    this.db = null!; // assigned by _openOrRecreate
    this._openOrRecreate(path);

    // Derive history encryption key via HKDF from vault key
    const vaultKey = encryptionKey ?? process.env['LYNOX_VAULT_KEY'] ?? '';
    if (vaultKey) {
      this._encKey = Buffer.from(hkdfSync('sha256', vaultKey, 'lynox-history', HISTORY_HKDF_INFO, CRYPTO_KEY_LENGTH));
    } else {
      this._encKey = null;
    }
  }

  /**
   * Open the SQLite database, running an integrity check.
   * If the database is malformed, rename the corrupt file and create a fresh one.
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
      this._migrate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`⚠ History database corrupted (${msg}) — renaming to .corrupt and starting fresh\n`);
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
      this._migrate();
    }
  }

  /** Encrypt text for storage. Returns prefixed ciphertext or plaintext if no key. */
  private _enc(text: string): string {
    if (!this._encKey || !text) return text;
    const iv = randomBytes(CRYPTO_IV_LENGTH);
    const cipher = createCipheriv(CRYPTO_ALGORITHM, this._encKey, iv, { authTagLength: CRYPTO_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ENCRYPTED_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  /** Decrypt text from storage. Handles both encrypted and plaintext (mixed mode). */
  private _dec(text: string): string {
    if (!text || !text.startsWith(ENCRYPTED_PREFIX)) return text;
    if (!this._encKey) {
      if (!this._decWarnedNoKey) {
        this._decWarnedNoKey = true;
        process.stderr.write('⚠ History: encrypted data found but no encryption key set — data unreadable\n');
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
        process.stderr.write('⚠ History: decryption failed for encrypted record — wrong key or corrupted data\n');
      }
      return text;
    }
  }

  private _migrate(): void {
    const currentVersion = this._getVersion();
    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]!);
    }
  }

  private _getVersion(): number {
    try {
      const row = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number } | undefined;
      return row?.v ?? 0;
    } catch {
      return 0;
    }
  }

  insertRun(params: {
    sessionId?: string | undefined;
    taskText: string;
    modelTier: string;
    modelId: string;
    promptHash?: string | undefined;
    runType?: 'single' | 'batch_parent' | 'batch_item' | undefined;
    batchParentId?: string | undefined;
    spawnParentId?: string | undefined;
    spawnDepth?: number | undefined;
    contextId?: string | undefined;
    tenantId?: string | undefined;
    roleId?: string | undefined;
  }): string {
    const id = generateId();
    this.db.prepare(`
      INSERT INTO runs (id, session_id, task_hash, task_text, model_tier, model_id, prompt_hash, run_type, batch_parent_id, spawn_parent_id, spawn_depth, context_id, status, tenant_id, archetype_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      id,
      params.sessionId ?? '',
      hashTask(params.taskText),
      this._enc(params.taskText),
      params.modelTier,
      params.modelId,
      params.promptHash ?? '',
      params.runType ?? 'single',
      params.batchParentId ?? null,
      params.spawnParentId ?? null,
      params.spawnDepth ?? 0,
      params.contextId ?? '',
      params.tenantId ?? null,
      params.roleId ?? '',
    );
    return id;
  }

  updateRun(id: string, params: {
    responseText?: string | undefined;
    tokensIn?: number | undefined;
    tokensOut?: number | undefined;
    tokensCacheRead?: number | undefined;
    tokensCacheWrite?: number | undefined;
    costUsd?: number | undefined;
    toolCallCount?: number | undefined;
    durationMs?: number | undefined;
    userWaitMs?: number | undefined;
    stopReason?: string | undefined;
    status?: 'running' | 'completed' | 'failed' | undefined;
  }): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (params.responseText !== undefined) { sets.push('response_text = ?'); values.push(this._enc(params.responseText)); }
    if (params.tokensIn !== undefined) { sets.push('tokens_in = ?'); values.push(params.tokensIn); }
    if (params.tokensOut !== undefined) { sets.push('tokens_out = ?'); values.push(params.tokensOut); }
    if (params.tokensCacheRead !== undefined) { sets.push('tokens_cache_read = ?'); values.push(params.tokensCacheRead); }
    if (params.tokensCacheWrite !== undefined) { sets.push('tokens_cache_write = ?'); values.push(params.tokensCacheWrite); }
    if (params.costUsd !== undefined) { sets.push('cost_usd = ?'); values.push(params.costUsd); }
    if (params.toolCallCount !== undefined) { sets.push('tool_call_count = ?'); values.push(params.toolCallCount); }
    if (params.durationMs !== undefined) { sets.push('duration_ms = ?'); values.push(params.durationMs); }
    if (params.userWaitMs !== undefined) { sets.push('user_wait_ms = ?'); values.push(params.userWaitMs); }
    if (params.stopReason !== undefined) { sets.push('stop_reason = ?'); values.push(params.stopReason); }
    if (params.status !== undefined) { sets.push('status = ?'); values.push(params.status); }

    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  insertToolCall(params: {
    runId: string;
    toolName: string;
    inputJson: string;
    outputJson: string;
    durationMs: number;
    sequenceOrder: number;
  }): string {
    const id = generateId();
    this.db.prepare(`
      INSERT INTO run_tool_calls (id, run_id, tool_name, input_json, output_json, duration_ms, sequence_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, params.runId, params.toolName, this._enc(params.inputJson), this._enc(params.outputJson), params.durationMs, params.sequenceOrder);
    return id;
  }

  insertSpawn(params: {
    parentRunId: string;
    childRunId: string;
    depth: number;
  }): string {
    const id = generateId();
    this.db.prepare(`
      INSERT INTO run_spawns (id, parent_run_id, child_run_id, depth)
      VALUES (?, ?, ?, ?)
    `).run(id, params.parentRunId, params.childRunId, params.depth);
    return id;
  }

  // === Read Path (Sprint 4) ===

  private _decRun(r: RunRecord): RunRecord {
    r.task_text = this._dec(r.task_text);
    r.response_text = this._dec(r.response_text);
    return r;
  }

  private _decToolCall(tc: ToolCallRecord): ToolCallRecord {
    tc.input_json = this._dec(tc.input_json);
    tc.output_json = this._dec(tc.output_json);
    return tc;
  }

  getRecentRuns(limit = 20, offset = 0, filters?: { status?: string; model?: string; dateFrom?: string; dateTo?: string; sessionId?: string }): RunRecord[] {
    let sql = 'SELECT * FROM runs';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.sessionId) { conditions.push('session_id = ?'); params.push(filters.sessionId); }
    if (filters?.status) { conditions.push('status = ?'); params.push(filters.status); }
    if (filters?.model) { conditions.push('model_id = ?'); params.push(filters.model); }
    if (filters?.dateFrom) { conditions.push('created_at >= ?'); params.push(filters.dateFrom); }
    if (filters?.dateTo) { conditions.push("created_at < datetime(?, '+1 day')"); params.push(filters.dateTo); }

    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as RunRecord[];
    return rows.map(r => this._decRun(r));
  }

  searchRuns(query: string, limit = 20, offset = 0): RunRecord[] {
    // Search works on plaintext rows via LIKE; encrypted rows checked post-decrypt
    // Over-fetch to account for post-decrypt filtering, skip first `offset` matches
    const rows = this.db.prepare(
      'SELECT * FROM runs ORDER BY created_at DESC LIMIT ?'
    ).all((limit + offset) * 5) as RunRecord[];
    const results: RunRecord[] = [];
    const lowerQuery = query.toLowerCase();
    let skipped = 0;
    for (const r of rows) {
      const decrypted = this._decRun(r);
      if (decrypted.task_text.toLowerCase().includes(lowerQuery) ||
          decrypted.response_text.toLowerCase().includes(lowerQuery)) {
        if (skipped < offset) { skipped++; continue; }
        results.push(decrypted);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ? OR id LIKE ?').get(id, `${id}%`) as RunRecord | undefined;
    return row ? this._decRun(row) : undefined;
  }

  getRunToolCalls(runId: string): ToolCallRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM run_tool_calls WHERE run_id = ? ORDER BY sequence_order'
    ).all(runId) as ToolCallRecord[];
    return rows.map(tc => this._decToolCall(tc));
  }

  /** Per-run data with tool names for Pattern Engine. */
  getRunsForAnalysis(limit = 200): AnalysisRun[] {
    const rows = this.db.prepare(`
      SELECT r.id, r.session_id, r.status, r.duration_ms, r.cost_usd,
             GROUP_CONCAT(tc.tool_name) as tool_names
      FROM runs r
      LEFT JOIN run_tool_calls tc ON tc.run_id = r.id
      WHERE r.status != 'running'
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string; session_id: string; status: string;
      duration_ms: number; cost_usd: number; tool_names: string | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      status: r.status,
      toolNames: r.tool_names ? [...new Set(r.tool_names.split(','))] : [],
      durationMs: r.duration_ms,
      costUsd: r.cost_usd,
    }));
  }

  /** Thread-level aggregates for insights UI. */
  getThreadAggregates(limit = 20): ThreadAggregate[] {
    // Step 1: aggregate runs per session
    const rows = this.db.prepare(`
      SELECT r.session_id,
             COALESCE(t.title, '') as title,
             COUNT(*) as run_count,
             SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) as success_count,
             SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) as failed_count,
             COALESCE(SUM(r.duration_ms), 0) as total_duration_ms,
             COALESCE(SUM(r.cost_usd), 0) as total_cost_usd,
             MAX(r.created_at) as last_run_at
      FROM runs r
      LEFT JOIN threads t ON t.id = r.session_id
      WHERE r.session_id != '' AND r.status != 'running'
      GROUP BY r.session_id
      ORDER BY last_run_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      session_id: string; title: string; run_count: number;
      success_count: number; failed_count: number;
      total_duration_ms: number; total_cost_usd: number; last_run_at: string;
    }>;

    // Step 2: get tool counts per session (separate query to avoid GROUP_CONCAT explosion)
    return rows.map(r => {
      const toolRows = this.db.prepare(`
        SELECT tc.tool_name, COUNT(*) as cnt
        FROM run_tool_calls tc
        JOIN runs ru ON ru.id = tc.run_id
        WHERE ru.session_id = ?
        GROUP BY tc.tool_name
        ORDER BY cnt DESC
      `).all(r.session_id) as Array<{ tool_name: string; cnt: number }>;

      const toolCounts: Record<string, number> = {};
      for (const tr of toolRows) toolCounts[tr.tool_name] = tr.cnt;

      return {
        sessionId: r.session_id,
        title: r.title,
        runCount: r.run_count,
        successCount: r.success_count,
        failedCount: r.failed_count,
        toolCounts,
        totalDurationMs: r.total_duration_ms,
        totalCostUsd: r.total_cost_usd,
        lastRunAt: r.last_run_at,
      };
    });
  }

  getStats(): RunStats {
    const totals = this.db.prepare(`
      SELECT COUNT(*) as total_runs,
             COALESCE(SUM(tokens_in), 0) as total_tokens_in,
             COALESCE(SUM(tokens_out), 0) as total_tokens_out,
             COALESCE(SUM(cost_usd), 0) as total_cost_usd,
             COALESCE(AVG(duration_ms), 0) as avg_duration_ms
      FROM runs WHERE status != 'running'
    `).get() as { total_runs: number; total_tokens_in: number; total_tokens_out: number; total_cost_usd: number; avg_duration_ms: number };

    const costByModel = this.db.prepare(`
      SELECT model_id, COALESCE(SUM(cost_usd), 0) as cost_usd, COUNT(*) as run_count
      FROM runs WHERE status != 'running'
      GROUP BY model_id ORDER BY cost_usd DESC
    `).all() as Array<{ model_id: string; cost_usd: number; run_count: number }>;

    return { ...totals, cost_by_model: costByModel };
  }

  // === Cost queries (Sprint 5) ===

  getCostByDay(days: number): Array<{ day: string; cost_usd: number; run_count: number }> {
    return this.db.prepare(`
      SELECT date(created_at) as day, COALESCE(SUM(cost_usd), 0) as cost_usd, COUNT(*) as run_count
      FROM runs WHERE created_at >= datetime('now', ?) AND status != 'failed'
      GROUP BY date(created_at) ORDER BY day DESC
    `).all(`-${days} days`) as Array<{ day: string; cost_usd: number; run_count: number }>;
  }

  getCostByModel(): Array<{ model_id: string; cost_usd: number; run_count: number }> {
    return this.db.prepare(`
      SELECT model_id, COALESCE(SUM(cost_usd), 0) as cost_usd, COUNT(*) as run_count
      FROM runs GROUP BY model_id ORDER BY cost_usd DESC
    `).all() as Array<{ model_id: string; cost_usd: number; run_count: number }>;
  }

  /** Count tool calls of a specific type within the last N hours (via run timestamps). */
  getToolCallCountSince(toolName: string, hours: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM run_tool_calls tc
      JOIN runs r ON tc.run_id = r.id
      WHERE tc.tool_name = ? AND r.created_at >= datetime('now', ?)
    `).get(toolName, `-${hours} hours`) as { cnt: number };
    return row.cnt;
  }

  // === Batch queries (Sprint 11) ===

  getBatchRuns(parentId: string): RunRecord[] {
    return this.db.prepare(
      'SELECT * FROM runs WHERE batch_parent_id = ? ORDER BY created_at'
    ).all(parentId) as RunRecord[];
  }

  getBatchSummary(parentId: string): { total: number; succeeded: number; failed: number; totalCost: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as succeeded,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
             COALESCE(SUM(cost_usd), 0) as totalCost
      FROM runs WHERE batch_parent_id = ?
    `).get(parentId) as { total: number; succeeded: number; failed: number; totalCost: number };
    return row;
  }

  // === Spawn queries (Sprint 10) ===

  getSpawnTree(runId: string): Array<{ id: string; parent_run_id: string; child_run_id: string; depth: number }> {
    return this.db.prepare(`
      WITH RECURSIVE tree AS (
        SELECT * FROM run_spawns WHERE parent_run_id = ?
        UNION ALL
        SELECT s.* FROM run_spawns s JOIN tree t ON s.parent_run_id = t.child_run_id
      )
      SELECT * FROM tree
    `).all(runId) as Array<{ id: string; parent_run_id: string; child_run_id: string; depth: number }>;
  }

  getRunWithDescendants(runId: string): RunRecord[] {
    const tree = this.getSpawnTree(runId);
    const ids = [runId, ...tree.map(t => t.child_run_id)];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT * FROM runs WHERE id IN (${placeholders}) ORDER BY created_at`
    ).all(...ids) as RunRecord[];
  }

  // === Analytics delegates ===

  getRepeatTasks(contextId: string, minCount: number, days: number) {
    return analytics.getRepeatTasks(this.db, contextId, minCount, days);
  }

  getFailurePatterns(contextId: string, days: number) {
    return analytics.getFailurePatterns(this.db, contextId, days);
  }

  getCacheEfficiency(contextId: string, days: number) {
    return analytics.getCacheEfficiency(this.db, contextId, days);
  }

  getModelEfficiency(contextId: string, days: number) {
    return analytics.getModelEfficiency(this.db, contextId, days);
  }

  getPromptVariantStats(contextId: string, days: number) {
    return analytics.getPromptVariantStats(this.db, contextId, days);
  }

  getToolStats(contextId: string, days: number) {
    return analytics.getToolStats(this.db, contextId, days);
  }

  getPipelineStepStats(days: number) {
    return analytics.getPipelineStepStats(this.db, days);
  }

  getPipelineCostStats(days: number) {
    return analytics.getPipelineCostStats(this.db, days);
  }

  getAvgStepCostByModelTier(days: number) {
    return analytics.getAvgStepCostByModelTier(this.db, days);
  }

  getSessionSummaries(contextId: string, days: number) {
    return analytics.getSessionSummaries(this.db, contextId, days);
  }

  // === Persistence delegates ===

  insertPromptSnapshot(hash: string, profileName: string, promptText: string): void {
    persistence.insertPromptSnapshot(this.db, hash, profileName, promptText);
  }

  getPromptSnapshot(hash: string): PromptSnapshotRecord | undefined {
    return persistence.getPromptSnapshot(this.db, hash);
  }

  insertScope(id: string, type: string, name: string, parentId?: string | undefined): void {
    persistence.insertScope(this.db, id, type, name, parentId);
  }

  getScope(id: string): { id: string; type: string; name: string; parent_id: string | null; metadata: string | null; created_at: string; updated_at: string } | undefined {
    return persistence.getScope(this.db, id);
  }

  listScopes(type?: string | undefined): Array<{ id: string; type: string; name: string; parent_id: string | null; created_at: string }> {
    return persistence.listScopes(this.db, type);
  }

  deleteScope(id: string): boolean {
    return persistence.deleteScope(this.db, id);
  }

  getScopeChildren(parentId: string): Array<{ id: string; type: string; name: string; parent_id: string | null; created_at: string }> {
    return persistence.getScopeChildren(this.db, parentId);
  }

  getScopeTree(rootId: string): Array<{ id: string; type: string; name: string; parent_id: string | null; depth: number }> {
    return persistence.getScopeTree(this.db, rootId);
  }

  insertEmbedding(params: {
    projectId: string;
    namespace: string;
    text: string;
    embedding: Buffer;
    embeddingDim: number;
    provider: string;
    sourceRunId?: string | undefined;
    scopeType?: string | undefined;
    scopeId?: string | undefined;
  }): string {
    return persistence.insertEmbedding(this.db, params);
  }

  getEmbeddings(projectId: string): Array<{
    id: string;
    project_id: string;
    namespace: string;
    text: string;
    embedding: Buffer;
    embedding_dim: number;
    provider: string;
    source_run_id: string | null;
    last_retrieved_at: string | null;
    created_at: string;
  }> {
    return persistence.getEmbeddings(this.db, projectId);
  }

  updateEmbeddingRetrieved(id: string): void {
    persistence.updateEmbeddingRetrieved(this.db, id);
  }

  deleteOldEmbeddings(daysOld: number): number {
    return persistence.deleteOldEmbeddings(this.db, daysOld);
  }

  getStaleEmbeddings(
    scopeType: string,
    scopeId: string,
    daysOld: number,
  ): Array<{
    id: string; text: string; namespace: string;
    created_at: string; last_retrieved_at: string | null;
  }> {
    return persistence.getStaleEmbeddings(this.db, scopeType, scopeId, daysOld);
  }

  deleteEmbedding(id: string): boolean {
    return persistence.deleteEmbedding(this.db, id);
  }

  getEmbeddingsByScope(scopeType: string, scopeId: string): Array<{
    id: string; project_id: string; namespace: string; text: string;
    embedding: Buffer; embedding_dim: number; provider: string;
    source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
    scope_type: string; scope_id: string;
  }> {
    return persistence.getEmbeddingsByScope(this.db, scopeType, scopeId);
  }

  getEmbeddingsMultiScope(scopes: Array<{ type: string; id: string }>): Array<{
    id: string; project_id: string; namespace: string; text: string;
    embedding: Buffer; embedding_dim: number; provider: string;
    source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
    scope_type: string; scope_id: string;
  }> {
    return persistence.getEmbeddingsMultiScope(this.db, scopes);
  }

  getEmbeddingsFiltered(projectId: string, opts?: { namespace?: string | undefined; limit?: number | undefined }): Array<{
    id: string; project_id: string; namespace: string; text: string;
    embedding: Buffer; embedding_dim: number; provider: string;
    source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
  }> {
    return persistence.getEmbeddingsFiltered(this.db, projectId, opts);
  }

  getEmbeddingsMultiScopeFiltered(scopes: Array<{ type: string; id: string }>, opts?: { namespace?: string | undefined; limit?: number | undefined }): Array<{
    id: string; project_id: string; namespace: string; text: string;
    embedding: Buffer; embedding_dim: number; provider: string;
    source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
    scope_type: string; scope_id: string;
  }> {
    return persistence.getEmbeddingsMultiScopeFiltered(this.db, scopes, opts);
  }

  insertPreApprovalSet(params: {
    id: string;
    taskSummary: string;
    approvedBy: string;
    patternsJson: string;
    maxUses: number;
    ttlMs: number;
    runId?: string | undefined;
  }): void {
    persistence.insertPreApprovalSet(this.db, params);
  }

  insertPreApprovalEvent(params: {
    setId: string;
    patternIdx: number;
    toolName: string;
    matchString: string;
    pattern: string;
    decision: string;
    autonomyLevel?: string | undefined;
    runId?: string | undefined;
  }): void {
    persistence.insertPreApprovalEvent(this.db, params);
  }

  getPreApprovalSets(limit = 20): Array<{
    id: string; task_summary: string; approved_by: string;
    patterns_json: string; max_uses: number; ttl_ms: number;
    run_id: string | null; created_at: string;
  }> {
    return persistence.getPreApprovalSets(this.db, limit);
  }

  getPreApprovalEvents(setId: string): Array<{
    id: number; set_id: string; pattern_idx: number;
    tool_name: string; match_string: string; pattern: string;
    decision: string; autonomy_level: string | null;
    run_id: string | null; created_at: string;
  }> {
    return persistence.getPreApprovalEvents(this.db, setId);
  }

  getPreApprovalSummary(setId: string): {
    total_matches: number; total_exhausted: number; total_expired: number;
  } | undefined {
    return persistence.getPreApprovalSummary(this.db, setId);
  }

  insertPipelineRun(params: {
    id: string;
    manifestName: string;
    status: string;
    manifestJson: string;
    totalDurationMs?: number | undefined;
    totalCostUsd?: number | undefined;
    totalTokensIn?: number | undefined;
    totalTokensOut?: number | undefined;
    stepCount?: number | undefined;
    parentRunId?: string | undefined;
    error?: string | undefined;
  }): void {
    persistence.insertPipelineRun(this.db, params);
  }

  updatePipelineRun(id: string, params: {
    status?: string | undefined;
    totalDurationMs?: number | undefined;
    totalCostUsd?: number | undefined;
    error?: string | undefined;
  }): void {
    persistence.updatePipelineRun(this.db, id, params);
  }

  insertPipelineStepResult(params: {
    pipelineRunId: string;
    stepId: string;
    status: string;
    result?: string | undefined;
    error?: string | undefined;
    durationMs?: number | undefined;
    tokensIn?: number | undefined;
    tokensOut?: number | undefined;
    costUsd?: number | undefined;
    modelTier?: string | undefined;
  }): void {
    persistence.insertPipelineStepResult(this.db, params);
  }

  getRecentPipelineRuns(limit = 20): Array<{
    id: string; manifest_name: string; status: string; total_duration_ms: number;
    total_cost_usd: number; step_count: number; error: string | null; started_at: string;
  }> {
    return persistence.getRecentPipelineRuns(this.db, limit);
  }

  getPipelineRun(id: string): {
    id: string; manifest_name: string; status: string; manifest_json: string;
    total_duration_ms: number; total_cost_usd: number; total_tokens_in: number;
    total_tokens_out: number; step_count: number; parent_run_id: string | null;
    error: string | null; started_at: string; completed_at: string | null;
  } | undefined {
    return persistence.getPipelineRun(this.db, id);
  }

  getPipelineStepResults(pipelineRunId: string): Array<{
    id: number; pipeline_run_id: string; step_id: string; status: string;
    result: string; error: string | null; duration_ms: number;
    tokens_in: number; tokens_out: number; cost_usd: number;
  }> {
    return persistence.getPipelineStepResults(this.db, pipelineRunId);
  }

  insertPlannedPipeline(planned: { id: string; name: string; goal: string; steps: unknown[]; reasoning: string; estimatedCost: number; createdAt: string }): void {
    persistence.insertPlannedPipeline(this.db, planned);
  }

  getPlannedPipeline(id: string): { id: string; manifest_json: string } | undefined {
    return persistence.getPlannedPipeline(this.db, id);
  }

  markPipelineExecuted(id: string): void {
    persistence.markPipelineExecuted(this.db, id);
  }

  insertTask(params: {
    id: string;
    title: string;
    description?: string | undefined;
    status?: string | undefined;
    priority?: string | undefined;
    assignee?: string | undefined;
    scopeType?: string | undefined;
    scopeId?: string | undefined;
    dueDate?: string | undefined;
    tags?: string | undefined;
    parentTaskId?: string | undefined;
    scheduleCron?: string | undefined;
    nextRunAt?: string | undefined;
    taskType?: string | undefined;
    watchConfig?: string | undefined;
    maxRetries?: number | undefined;
    notificationChannel?: string | undefined;
    pipelineId?: string | undefined;
  }): void {
    persistence.insertTask(this.db, params);
  }

  /** Retrieve the manifest JSON for a pipeline run (by pipeline_runs.id). */
  getPipelineRunManifest(pipelineRunId: string): string | undefined {
    const row = persistence.getPipelineRun(this.db, pipelineRunId);
    return row?.manifest_json;
  }

  updateTask(id: string, params: {
    title?: string | undefined;
    description?: string | undefined;
    status?: string | undefined;
    priority?: string | undefined;
    assignee?: string | undefined;
    dueDate?: string | undefined;
    tags?: string | undefined;
    completedAt?: string | undefined;
  }): boolean {
    return persistence.updateTask(this.db, id, params);
  }

  getTask(id: string): TaskRecord | undefined {
    return persistence.getTask(this.db, id);
  }

  deleteTask(id: string): boolean {
    return persistence.deleteTask(this.db, id);
  }

  getTasks(opts?: {
    scopeType?: string | undefined;
    scopeId?: string | undefined;
    status?: string | undefined;
    assignee?: string | undefined;
    parentTaskId?: string | undefined;
    limit?: number | undefined;
  }): TaskRecord[] {
    return persistence.getTasks(this.db, opts);
  }

  getTasksDueInRange(start: string, end: string, scopes?: Array<{ type: string; id: string }> | undefined): TaskRecord[] {
    return persistence.getTasksDueInRange(this.db, start, end, scopes);
  }

  getOverdueTasks(scopes?: Array<{ type: string; id: string }> | undefined): TaskRecord[] {
    return persistence.getOverdueTasks(this.db, scopes);
  }

  getDueTasks(): TaskRecord[] {
    return persistence.getDueTasks(this.db);
  }

  updateTaskRunResult(id: string, update: {
    lastRunAt: string;
    lastRunResult: string;
    lastRunStatus: string;
    nextRunAt?: string | undefined;
    retryCount?: number | undefined;
  }): void {
    persistence.updateTaskRunResult(this.db, id, update);
  }

  /** Update the watch_config JSON for a watch task. */
  updateTaskWatchConfig(id: string, watchConfig: string): void {
    this.db.prepare('UPDATE tasks SET watch_config = ?, updated_at = ? WHERE id = ?')
      .run(watchConfig, new Date().toISOString(), id);
  }

  /**
   * Delete a single run and all associated data (tool calls, spawns).
   * Returns true if a run was deleted.
   */
  deleteRun(id: string): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM run_tool_calls WHERE run_id = ?').run(id);
      this.db.prepare('DELETE FROM run_spawns WHERE parent_run_id = ? OR child_run_id = ?').run(id, id);
      // pipeline_step_results uses pipeline_run_id (references pipeline_runs, not runs directly)
      const pipelineRunIds = this.db.prepare(
        'SELECT id FROM pipeline_runs WHERE parent_run_id = ?',
      ).all(id) as Array<{ id: number }>;
      for (const pr of pipelineRunIds) {
        this.db.prepare('DELETE FROM pipeline_step_results WHERE pipeline_run_id = ?').run(pr.id);
      }
      this.db.prepare('DELETE FROM pipeline_runs WHERE parent_run_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
      return result.changes > 0;
    });
    return tx();
  }

  /**
   * Delete all runs for a given context ID. Returns count of runs deleted.
   */
  deleteRunsByContext(contextId: string): number {
    const rows = this.db.prepare('SELECT id FROM runs WHERE context_id = ?').all(contextId) as Array<{ id: string }>;
    for (const row of rows) {
      this.deleteRun(row.id);
    }
    return rows.length;
  }

  /**
   * Delete all runs for a given tenant ID. Returns count of runs deleted.
   */
  deleteRunsByTenant(tenantId: string): number {
    const rows = this.db.prepare('SELECT id FROM runs WHERE tenant_id = ?').all(tenantId) as Array<{ id: string }>;
    for (const row of rows) {
      this.deleteRun(row.id);
    }
    return rows.length;
  }

  /**
   * VACUUM the database to reclaim space and purge deleted records from WAL.
   */
  vacuum(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.prepare('SELECT 1').get(); // force checkpoint
  }

  /**
   * Delete all run data and vacuum the database.
   * Used for clean-slate release upgrades (e.g. to eliminate mixed-mode encryption).
   * This is destructive and cannot be undone.
   */
  resetDatabase(): void {
    const tables = [
      'run_tool_calls', 'run_spawns', 'prompt_snapshots', 'memory_embeddings',
      'pre_approval_sets', 'pre_approval_events', 'pipeline_runs', 'pipeline_step_results',
      'advisor_suggestions', 'tasks', 'security_events', 'processes', 'runs',
    ];
    this.db.pragma('foreign_keys = OFF');
    for (const table of tables) {
      this.db.prepare(`DELETE FROM "${table}"`).run();
    }
    this.db.pragma('foreign_keys = ON');
    this.vacuum();
  }

  /**
   * Re-encrypt all encrypted columns with a new vault key.
   * Decrypts with the current key, then re-encrypts with a key derived from newVaultKey.
   * Returns the number of re-encrypted rows.
   */
  reEncryptAll(newVaultKey: string): number {
    if (!this._encKey) {
      throw new Error('Cannot re-encrypt: no current encryption key configured');
    }
    const newEncKey = Buffer.from(hkdfSync('sha256', newVaultKey, 'lynox-history', HISTORY_HKDF_INFO, CRYPTO_KEY_LENGTH));

    const encWithKey = (text: string, key: Buffer): string => {
      if (!text) return text;
      const iv = randomBytes(CRYPTO_IV_LENGTH);
      const cipher = createCipheriv(CRYPTO_ALGORITHM, key, iv, { authTagLength: CRYPTO_TAG_LENGTH });
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ENCRYPTED_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
    };

    let count = 0;

    // Re-encrypt runs (task_text, response_text)
    const encPrefix = `${ENCRYPTED_PREFIX}%`;
    const runs = this.db.prepare(
      `SELECT id, task_text, response_text FROM runs WHERE task_text LIKE ? OR response_text LIKE ?`,
    ).all(encPrefix, encPrefix) as Array<{ id: string; task_text: string; response_text: string }>;

    const updateRun = this.db.prepare('UPDATE runs SET task_text = ?, response_text = ? WHERE id = ?');
    for (const row of runs) {
      const taskText = this._dec(row.task_text);
      const responseText = this._dec(row.response_text);
      updateRun.run(
        taskText ? encWithKey(taskText, newEncKey) : row.task_text,
        responseText ? encWithKey(responseText, newEncKey) : row.response_text,
        row.id,
      );
      count++;
    }

    // Re-encrypt tool calls (input_json, output_json)
    const calls = this.db.prepare(
      `SELECT id, input_json, output_json FROM run_tool_calls WHERE input_json LIKE ? OR output_json LIKE ?`,
    ).all(encPrefix, encPrefix) as Array<{ id: string; input_json: string; output_json: string }>;

    const updateCall = this.db.prepare('UPDATE run_tool_calls SET input_json = ?, output_json = ? WHERE id = ?');
    for (const row of calls) {
      const inputJson = this._dec(row.input_json);
      const outputJson = this._dec(row.output_json);
      updateCall.run(
        inputJson ? encWithKey(inputJson, newEncKey) : row.input_json,
        outputJson ? encWithKey(outputJson, newEncKey) : row.output_json,
        row.id,
      );
      count++;
    }

    return count;
  }

  /** Expose database instance for shared-connection modules (e.g. ThreadStore). */
  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  insertProcess(record: import('../types/index.js').ProcessRecord): void {
    persistence.insertProcess(this.db, record);
  }

  getProcess(id: string): import('../types/index.js').ProcessRecord | undefined {
    return persistence.getProcess(this.db, id);
  }

  listProcesses(limit = 20): import('../types/index.js').ProcessRecord[] {
    return persistence.listProcesses(this.db, limit);
  }

  updateProcessPromotion(id: string, pipelineId: string): void {
    persistence.updateProcessPromotion(this.db, id, pipelineId);
  }

  deleteProcess(id: string): boolean {
    return persistence.deleteProcess(this.db, id);
  }
}
