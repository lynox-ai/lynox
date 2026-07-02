import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import type { TriggerRecord } from '../types/pipeline.js';

/**
 * TriggerStore — the write/read layer over the engine.db `triggers` table
 * (Foundation Rework v2, verb layer). It relocates the legacy history.db
 * `triggers` row (mig v42, run-history.ts) — the agent-fired
 * cron/watch/pipeline/reminder/backup row — onto the purpose-built engine.db
 * `triggers` table with a real `source` / `condition_json` / `target_workflow_id`
 * shape and FK-able links (`target_workflow_id` → workflows(id);
 * `tasks.due_trigger_id` → triggers(id)).
 *
 * S3f write-cutover makes this the SOLE authority for triggers: every
 * insert/update/setEnabled/runResult/watchConfig/delete writes here directly
 * (legacy history.db `triggers` is dropped in mig v44), and every read — incl.
 * the WorkerLoop money-path {@link getDue} — comes from here. There is no legacy
 * fallback left (it no longer exists). The S3a-e history: this began as an
 * additive dual-write mirror (gated on a now-removed flag) with legacy
 * authoritative; S3d backfilled pre-flag rows; S3e cut reads over; S3f cut writes
 * over and dropped legacy.
 *
 * The engine.db `triggers` table is a REDESIGN, not a 1:1 of the legacy table —
 * so the write methods map the legacy field names onto the engine.db shape
 * (source ← task_type, condition_json ← {schedule_cron, watch_config},
 * target_workflow_id ← pipeline_id, params_json ← pipeline_params).
 * {@link triggerRecordToRow} is the pure record→row form the S3d backfill still
 * uses (legacy TriggerRecord → row); the live write methods build the row (via
 * {@link insert}/{@link upsert}) or patch columns directly from their params.
 *
 * `condition_json` / `params_json` / `description` are stored PLAINTEXT — a
 * faithful relocation of the legacy plaintext columns. At-rest encryption of verb
 * free-text is a deliberate future hardening slice (shared with the S3a
 * workflow-defs), NOT smuggled into the relocation.
 */
export interface TriggerRow {
  id: string;
  title: string;
  description: string;
  /** cron|watch|webhook|inbox_event|manual|pipeline|reminder|backup — the legacy
   *  `task_type` preserved VERBATIM (the engine.db column has no CHECK). The clean
   *  source/action decomposition is S3d/S4 behaviour, NOT the mirror. */
  source: string;
  /** JSON `{schedule_cron, watch_config}` — both raw, so the round-trip back to
   *  the exact legacy columns at S3d is byte-identical. */
  conditionJson: string;
  /** Candidate FK → workflows(id) (legacy `pipeline_id`). {@link TriggerStore.upsert}
   *  nulls it when no such workflow row exists (the FK is enforced), so a pre-flag
   *  orphan degrades to a null link instead of throwing. */
  targetWorkflowId?: string | null | undefined;
  paramsJson: string;
  scopeType?: string | null | undefined;
  scopeId?: string | null | undefined;
  status: string;
  enabled: boolean;
  nextRunAt?: string | null | undefined;
  lastRunAt?: string | null | undefined;
  lastRunResult?: string | null | undefined;
  lastRunStatus?: string | null | undefined;
  notificationChannel?: string | null | undefined;
  maxRetries?: number | null | undefined;
  retryCount: number;
}

export interface StoredTrigger {
  id: string;
  title: string;
  description: string;
  source: string;
  conditionJson: string;
  targetWorkflowId: string | null;
  paramsJson: string;
  status: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunResult: string | null;
  lastRunStatus: string | null;
  retryCount: number;
  createdAt: string;
}

/**
 * Pure map of a legacy {@link TriggerRecord} (history.db row shape) onto the
 * engine.db `triggers` shape. Faithful + round-trippable: `source` keeps
 * `task_type` verbatim; `condition_json` carries both legacy `schedule_cron` and
 * the raw `watch_config` string. `assignee` is dropped (constant 'lynox' for
 * fired rows). engine.db columns with no legacy source (`source_connection_id`,
 * `subject_id`, `last_run_id`) are left for S4/S3d. `targetWorkflowId` is the raw
 * candidate; the FK-guard lives in {@link TriggerStore.upsert}.
 */
export function triggerRecordToRow(rec: TriggerRecord): TriggerRow {
  return {
    id: rec.id,
    title: rec.title,
    description: rec.description,
    source: rec.task_type ?? 'manual',
    conditionJson: JSON.stringify({
      schedule_cron: rec.schedule_cron ?? null,
      watch_config: rec.watch_config ?? null,
    }),
    targetWorkflowId: rec.pipeline_id ?? null,
    paramsJson: rec.pipeline_params ?? '{}',
    scopeType: rec.scope_type,
    scopeId: rec.scope_id,
    status: rec.status,
    // Legacy `enabled` is 0/1; absent = enabled (the legacy column defaults to 1).
    enabled: rec.enabled !== 0,
    nextRunAt: rec.next_run_at ?? null,
    lastRunAt: rec.last_run_at ?? null,
    lastRunResult: rec.last_run_result ?? null,
    lastRunStatus: rec.last_run_status ?? null,
    notificationChannel: rec.notification_channel ?? null,
    maxRetries: rec.max_retries ?? null,
    retryCount: rec.retry_count ?? 0,
  };
}

interface TriggerDbRow {
  id: string;
  title: string;
  description: string;
  source: string;
  condition_json: string;
  target_workflow_id: string | null;
  params_json: string;
  status: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_result: string | null;
  last_run_status: string | null;
  retry_count: number;
  created_at: string;
}

/**
 * The FULL engine.db `triggers` read shape (S3e read-cutover). Superset of
 * {@link TriggerDbRow}: adds the columns the S3b write-only reads didn't select
 * (`scope_type`/`scope_id`/`notification_channel`/`max_retries`/`updated_at`),
 * needed to reconstruct a legacy {@link TriggerRecord} faithfully.
 */
interface TriggerFullDbRow {
  id: string;
  title: string;
  description: string;
  source: string;
  condition_json: string;
  target_workflow_id: string | null;
  params_json: string;
  scope_type: string | null;
  scope_id: string | null;
  status: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_result: string | null;
  last_run_status: string | null;
  notification_channel: string | null;
  max_retries: number | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

/** The full column list the S3e read methods SELECT (order matches TriggerFullDbRow). */
const TRIGGER_READ_COLS =
  `id, title, description, source, condition_json, target_workflow_id, params_json,
   scope_type, scope_id, status, enabled, next_run_at, last_run_at, last_run_result,
   last_run_status, notification_channel, max_retries, retry_count, created_at, updated_at`;

/**
 * Pure INVERSE of {@link triggerRecordToRow} (S3e read-cutover): reconstruct a
 * legacy {@link TriggerRecord} from an engine.db `triggers` row so every consumer
 * that reads legacy field names (`task_type`/`pipeline_id`/`pipeline_params`/
 * `schedule_cron`/`watch_config`) sees an identical shape regardless of source.
 * - `task_type` ← `source`, `pipeline_id` ← `target_workflow_id`,
 *   `pipeline_params` ← `params_json`.
 * - `schedule_cron` / `watch_config` are parsed back out of `condition_json`
 *   (guarded — a malformed blob leaves them unset, never throws).
 * - `assignee` is the constant `'lynox'` (every fired trigger is agent-owned;
 *   the forward map drops it — this synthesize is lossless, `trigger-store.ts`
 *   doc + `task-manager.ts` set it everywhere).
 * - `enabled` stays the raw 0/1 number (legacy `TriggerRecord.enabled` is 0/1).
 * Optional columns map `null → undefined` (the legacy cast types them
 * `string | undefined`; both mean "absent" and every consumer treats them so).
 */
export function triggerDbRowToRecord(row: TriggerFullDbRow): TriggerRecord {
  let scheduleCron: string | undefined;
  let watchConfig: string | undefined;
  try {
    const cond = JSON.parse(row.condition_json) as { schedule_cron?: string | null; watch_config?: string | null };
    scheduleCron = cond.schedule_cron ?? undefined;
    watchConfig = cond.watch_config ?? undefined;
  } catch { /* malformed condition_json → schedule_cron / watch_config stay unset */ }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as TriggerRecord['status'],
    assignee: 'lynox',
    scope_type: row.scope_type ?? '',
    scope_id: row.scope_id ?? '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    schedule_cron: scheduleCron,
    next_run_at: row.next_run_at ?? undefined,
    last_run_at: row.last_run_at ?? undefined,
    last_run_result: row.last_run_result ?? undefined,
    last_run_status: row.last_run_status ?? undefined,
    task_type: row.source,
    watch_config: watchConfig,
    max_retries: row.max_retries ?? undefined,
    retry_count: row.retry_count,
    notification_channel: row.notification_channel ?? undefined,
    pipeline_id: row.target_workflow_id ?? undefined,
    // The forward map collapses an absent pipeline_params to '{}' (params_json is
    // NOT NULL DEFAULT '{}'), but legacy returned NULL. Restore that: '{}' →
    // undefined, so the money-path `if (task.pipeline_params)` (worker-loop) stays
    // falsy → runSavedWorkflow's `requireAll = params !== undefined` stays false,
    // matching a legacy paramless trigger. A stored '{}' only ever means "no bound
    // params" (a real binding carries its keys; requireAll is a no-op with zero
    // required params), so this is behaviour-lossless. The byte-faithful root fix
    // (nullable params_json in the forward map) rides the S3f write-cutover.
    pipeline_params: row.params_json === '{}' ? undefined : row.params_json,
    enabled: row.enabled,
  };
}

/**
 * Escape LIKE metacharacters so a `%`/`_` in an id cannot widen the prefix match.
 * Mirrors {@link WorkflowStore}'s `likePrefix` — the engine.db reads are written
 * correctly rather than replicating the legacy bare-`LIKE '${id}%'` footgun.
 */
function likePrefix(id: string): string {
  return `${id.replace(/[\\%_]/g, '\\$&')}%`;
}

export class TriggerStore {
  private readonly db: Database.Database;

  constructor(engine: EngineDb) {
    this.db = engine.getDb();
  }

  /**
   * Upsert a trigger (INSERT-or-update by id). Uses `ON CONFLICT DO UPDATE` —
   * NOT `INSERT OR REPLACE` — so a re-projection (a) preserves `created_at` and
   * (b) does not delete+reinsert the row (which would trip the
   * `tasks.due_trigger_id` ON DELETE SET NULL on any child task). Columns the
   * mirror does not own (`source_connection_id`/`subject_id`/`last_run_id`, filled
   * by S4/later) are left untouched on conflict rather than clobbered.
   *
   * FK-guards `target_workflow_id`: engine.db enforces `foreign_keys = ON`, so a
   * candidate pointing at a not-yet-mirrored workflow (a pre-flag orphan) is
   * stored NULL instead of throwing — keeping the mirror non-fatal; the S3d
   * backfill re-links it in dependency order (workflows before triggers).
   *
   * `ts` (S3d backfill only) preserves the legacy timestamps; the live mirror
   * omits it → both columns resolve to `datetime('now')` via COALESCE, identical
   * to the prior behaviour. See {@link WorkflowStore.upsert} for the rationale.
   */
  upsert(row: TriggerRow, ts?: { createdAt?: string | undefined; updatedAt?: string | undefined }): void {
    const targetWorkflowId = this._resolveTargetWorkflowId(row.targetWorkflowId ?? null);
    this.db.prepare(`
      INSERT INTO triggers (
        id, title, description, source, condition_json, target_workflow_id,
        params_json, scope_type, scope_id, status, enabled, next_run_at,
        last_run_at, last_run_result, last_run_status, notification_channel,
        max_retries, retry_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        source = excluded.source,
        condition_json = excluded.condition_json,
        target_workflow_id = excluded.target_workflow_id,
        params_json = excluded.params_json,
        scope_type = excluded.scope_type,
        scope_id = excluded.scope_id,
        status = excluded.status,
        enabled = excluded.enabled,
        next_run_at = excluded.next_run_at,
        last_run_at = excluded.last_run_at,
        last_run_result = excluded.last_run_result,
        last_run_status = excluded.last_run_status,
        notification_channel = excluded.notification_channel,
        max_retries = excluded.max_retries,
        retry_count = excluded.retry_count,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.title,
      row.description,
      row.source,
      row.conditionJson,
      targetWorkflowId,
      row.paramsJson,
      row.scopeType ?? null,
      row.scopeId ?? null,
      row.status,
      row.enabled ? 1 : 0,
      row.nextRunAt ?? null,
      row.lastRunAt ?? null,
      row.lastRunResult ?? null,
      row.lastRunStatus ?? null,
      row.notificationChannel ?? null,
      row.maxRetries ?? null,
      row.retryCount,
      ts?.createdAt ?? null,
      ts?.updatedAt ?? null,
    );
  }

  /** Resolve `target_workflow_id` to a concrete `workflows.id` if the referenced
   *  workflow row exists (engine.db enforces the FK), else NULL — so a pre-flag
   *  orphan never throws. Prefix-tolerant + exact-preferring, mirroring
   *  {@link WorkflowStore}'s `id = ? OR id LIKE ?` read/delete semantics: a caller
   *  may pass a short/prefix workflow id, and an exact-match resolve would null it
   *  even though the workflow exists — which then misroutes the trigger to an
   *  autonomous run and blinds the destructive-edit guard ({@link getByWorkflowId}).
   *  Stores the ACTUAL matched id so the FK holds. */
  private _resolveTargetWorkflowId(candidate: string | null): string | null {
    if (candidate === null || candidate === '') return null;
    const hit = this.db.prepare(
      "SELECT id FROM workflows WHERE id = ? OR id LIKE ? ESCAPE '\\' ORDER BY (id = ?) DESC LIMIT 1",
    ).get(candidate, likePrefix(candidate), candidate) as { id: string } | undefined;
    return hit ? hit.id : null;
  }

  /** Exact-id delete (mirrors legacy `deleteTrigger`, which is exact-id). */
  remove(id: string): boolean {
    if (id === '') return false;
    return this.db.prepare('DELETE FROM triggers WHERE id = ?').run(id).changes > 0;
  }

  /**
   * S3f write-cutover: INSERT a fresh trigger DIRECTLY into engine.db (legacy
   * history.db `triggers` is dropped in mig v44). Accepts the legacy-shaped params
   * of the old `run-history-persistence.insertTrigger` and maps them onto the
   * engine.db shape via {@link upsert} (a fresh id never conflicts, so the upsert
   * is a plain insert). Legacy defaults are reproduced explicitly: status 'open',
   * `task_type`→`source` 'manual', scope 'project'/'', max_retries 0, retry_count
   * 0, enabled 1, params_json '{}'. `assignee` is NOT stored (every trigger is
   * agent-owned — const 'lynox', which the read synthesizes).
   */
  insert(params: {
    id: string;
    title: string;
    description?: string | undefined;
    status?: string | undefined;
    scopeType?: string | undefined;
    scopeId?: string | undefined;
    scheduleCron?: string | undefined;
    nextRunAt?: string | undefined;
    taskType?: string | undefined;
    watchConfig?: string | undefined;
    maxRetries?: number | undefined;
    notificationChannel?: string | undefined;
    pipelineId?: string | undefined;
    pipelineParams?: string | undefined;
  }): void {
    this.upsert({
      id: params.id,
      title: params.title,
      description: params.description ?? '',
      source: params.taskType ?? 'manual',
      conditionJson: JSON.stringify({
        schedule_cron: params.scheduleCron ?? null,
        watch_config: params.watchConfig ?? null,
      }),
      targetWorkflowId: params.pipelineId ?? null,
      paramsJson: params.pipelineParams ?? '{}',
      scopeType: params.scopeType ?? 'project',
      scopeId: params.scopeId ?? '',
      status: params.status ?? 'open',
      enabled: true,
      nextRunAt: params.nextRunAt ?? null,
      lastRunAt: null,
      lastRunResult: null,
      lastRunStatus: null,
      notificationChannel: params.notificationChannel ?? null,
      maxRetries: params.maxRetries ?? 0,
      retryCount: 0,
    });
  }

  /** S3f write-cutover: flip the cron kill-switch DIRECTLY on engine.db, mirroring
   *  the legacy `setTriggerEnabled` (exact-id). Returns false if no row matched. */
  setEnabled(id: string, enabled: boolean): boolean {
    return this.db.prepare(
      "UPDATE triggers SET enabled = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(enabled ? 1 : 0, id).changes > 0;
  }

  /**
   * S3f write-cutover: partial field update DIRECTLY on engine.db, mirroring the
   * legacy `updateTrigger`. `title`/`description`/`status` map to columns;
   * `nextRunAt` → `next_run_at` (empty-string/null clears); `scheduleCron` →
   * `condition_json.$.schedule_cron` via `json_set` (empty-string/null clears to
   * JSON null, round-tripping to `undefined` on read). `assignee` has NO engine.db
   * column (const 'lynox') so it is not stored, but a lone assignee update still
   * counts as a touch so the `changes>0` return matches legacy. The optional
   * scope-guard is folded INTO the WHERE (atomic check-and-write, no TOCTOU window,
   * exactly as legacy). Returns false if nothing to set or no row matched.
   */
  updateFields(id: string, params: {
    title?: string | undefined;
    description?: string | undefined;
    status?: string | undefined;
    assignee?: string | undefined;
    nextRunAt?: string | null | undefined;
    scheduleCron?: string | null | undefined;
  }, opts?: { scopeFilter?: Array<{ type: string; id: string }> | undefined }): boolean {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (params.title !== undefined) { sets.push('title = ?'); values.push(params.title); }
    if (params.description !== undefined) { sets.push('description = ?'); values.push(params.description); }
    if (params.status !== undefined) { sets.push('status = ?'); values.push(params.status); }
    if (params.nextRunAt !== undefined) { sets.push('next_run_at = ?'); values.push(params.nextRunAt || null); }
    if (params.scheduleCron !== undefined) {
      sets.push("condition_json = json_set(condition_json, '$.schedule_cron', ?)");
      values.push(params.scheduleCron || null);
    }
    // `assignee` has no engine.db column (const 'lynox' for every trigger) — a
    // legacy assignee update was a no-op-in-effect. Count it as a touch so the
    // changes>0 return still matches legacy when it is the only field.
    if (sets.length === 0 && params.assignee === undefined) return false;
    sets.push("updated_at = datetime('now')");
    const where: string[] = ['id = ?'];
    values.push(id);
    const scopes = opts?.scopeFilter;
    if (scopes && scopes.length > 0) {
      where.push(`(${scopes.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ')})`);
      for (const s of scopes) { values.push(s.type, s.id); }
    }
    return this.db.prepare(`UPDATE triggers SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`).run(...values).changes > 0;
  }

  /** S3f write-cutover: record a run result DIRECTLY on engine.db, mirroring the
   *  legacy `updateTriggerRunResult`. `nextRunAt` undefined leaves it unchanged;
   *  null clears it (a one-shot reaching a terminal state). Exact-id. */
  updateRunResult(id: string, update: {
    lastRunAt: string;
    lastRunResult: string;
    lastRunStatus: string;
    nextRunAt?: string | null | undefined;
    retryCount?: number | undefined;
  }): void {
    const sets: string[] = ['last_run_at = ?', 'last_run_result = ?', 'last_run_status = ?'];
    const values: unknown[] = [update.lastRunAt, update.lastRunResult, update.lastRunStatus];
    if (update.nextRunAt !== undefined) { sets.push('next_run_at = ?'); values.push(update.nextRunAt); }
    if (update.retryCount !== undefined) { sets.push('retry_count = ?'); values.push(update.retryCount); }
    sets.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE triggers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /** S3f write-cutover: update a watch trigger's config DIRECTLY on engine.db
   *  (stored as `condition_json.$.watch_config`), mirroring the legacy
   *  `updateTriggerWatchConfig`. Exact-id. */
  updateWatchConfig(id: string, watchConfig: string): void {
    this.db.prepare(
      "UPDATE triggers SET condition_json = json_set(condition_json, '$.watch_config', ?), updated_at = datetime('now') WHERE id = ?",
    ).run(watchConfig, id);
  }

  /** Read a single trigger by exact id (test-only helper). */
  get(id: string): StoredTrigger | undefined {
    const row = this.db.prepare(
      `SELECT id, title, description, source, condition_json, target_workflow_id,
              params_json, status, enabled, next_run_at, last_run_at,
              last_run_result, last_run_status, retry_count, created_at
       FROM triggers WHERE id = ?`,
    ).get(id) as TriggerDbRow | undefined;
    if (!row) return undefined;
    return this._map(row);
  }

  /** List triggers, most-recently-touched first (test-only in S3b). An
   *  `updated_at` index rides the S3d read-cutover, same follow-up as the S3a
   *  `idx_workflows_updated_at`. */
  list(limit = 100): StoredTrigger[] {
    const rows = this.db.prepare(
      `SELECT id, title, description, source, condition_json, target_workflow_id,
              params_json, status, enabled, next_run_at, last_run_at,
              last_run_result, last_run_status, retry_count, created_at
       FROM triggers ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit) as TriggerDbRow[];
    return rows.map(r => this._map(r));
  }

  /**
   * S3e read-cutover (MONEY-PATH): triggers due to fire, as legacy
   * {@link TriggerRecord}s. SQL is the exact predicate of the legacy
   * `getDueTriggers` — `next_run_at <= now AND enabled != 0 AND status !=
   * 'completed' AND (status != 'failed' OR schedule_cron present)` — with
   * `schedule_cron` read out of `condition_json` via `json_extract`. The
   * `idx_triggers_enabled(enabled, next_run_at)` index supports it. `now` is a
   * param (default `new Date().toISOString()`, matching legacy) purely for test
   * determinism.
   */
  getDue(now: string = new Date().toISOString()): TriggerRecord[] {
    const rows = this.db.prepare(
      `SELECT ${TRIGGER_READ_COLS}
       FROM triggers
       WHERE next_run_at IS NOT NULL
         AND next_run_at <= ?
         AND enabled != 0
         AND status != 'completed'
         AND (status != 'failed' OR json_extract(condition_json, '$.schedule_cron') IS NOT NULL)
       ORDER BY next_run_at ASC`,
    ).all(now) as TriggerFullDbRow[];
    return rows.map(triggerDbRowToRecord);
  }

  /**
   * S3e read-cutover: a single trigger by id (prefix-matched, escaped), as a
   * legacy {@link TriggerRecord}. Optional `scopeFilter` mirrors the legacy
   * `getTrigger` OR-of-scope-pairs guard. A miss returns undefined (degrades to
   * not-found — never a wrong row).
   */
  getById(id: string, opts?: { scopeFilter?: Array<{ type: string; id: string }> | undefined }): TriggerRecord | undefined {
    if (id === '') return undefined;
    const params: unknown[] = [id, likePrefix(id)];
    let scopeClause = '';
    const scopes = opts?.scopeFilter;
    if (scopes && scopes.length > 0) {
      scopeClause = ` AND (${scopes.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ')})`;
      for (const s of scopes) { params.push(s.type, s.id); }
    }
    const row = this.db.prepare(
      `SELECT ${TRIGGER_READ_COLS} FROM triggers WHERE (id = ? OR id LIKE ? ESCAPE '\\')${scopeClause} LIMIT 1`,
    ).get(...params) as TriggerFullDbRow | undefined;
    return row ? triggerDbRowToRecord(row) : undefined;
  }

  /**
   * S3e read-cutover: filtered trigger list, as legacy {@link TriggerRecord}s.
   * Mirrors the legacy `getTriggers` — truthy-gated `scope_type`/`scope_id`/
   * `status`/`task_type`(→`source`) clauses, `ORDER BY next_run_at ASC NULLS
   * LAST, created_at DESC`, `limit` default 100.
   */
  listFiltered(opts?: {
    scopeType?: string | undefined;
    scopeId?: string | undefined;
    status?: string | undefined;
    taskType?: string | undefined;
    limit?: number | undefined;
  }): TriggerRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.scopeType) { clauses.push('scope_type = ?'); params.push(opts.scopeType); }
    if (opts?.scopeId) { clauses.push('scope_id = ?'); params.push(opts.scopeId); }
    if (opts?.status) { clauses.push('status = ?'); params.push(opts.status); }
    if (opts?.taskType) { clauses.push('source = ?'); params.push(opts.taskType); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(opts?.limit ?? 100);
    const rows = this.db.prepare(
      `SELECT ${TRIGGER_READ_COLS} FROM triggers ${where}
       ORDER BY next_run_at ASC NULLS LAST, created_at DESC LIMIT ?`,
    ).all(...params) as TriggerFullDbRow[];
    return rows.map(triggerDbRowToRecord);
  }

  /**
   * S3e read-cutover: triggers actively referencing a workflow (legacy
   * `getTriggersByPipelineId` — the destructive-edit guard). `target_workflow_id =
   * ? AND enabled != 0 AND status != 'completed' ORDER BY created_at DESC`.
   */
  getByWorkflowId(workflowId: string): TriggerRecord[] {
    const rows = this.db.prepare(
      `SELECT ${TRIGGER_READ_COLS} FROM triggers
       WHERE target_workflow_id = ? AND enabled != 0 AND status != 'completed'
       ORDER BY created_at DESC`,
    ).all(workflowId) as TriggerFullDbRow[];
    return rows.map(triggerDbRowToRecord);
  }

  private _map(row: TriggerDbRow): StoredTrigger {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      source: row.source,
      conditionJson: row.condition_json,
      targetWorkflowId: row.target_workflow_id,
      paramsJson: row.params_json,
      status: row.status,
      enabled: row.enabled === 1,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastRunResult: row.last_run_result,
      lastRunStatus: row.last_run_status,
      retryCount: row.retry_count,
      createdAt: row.created_at,
    };
  }
}
