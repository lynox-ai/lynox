import type Database from 'better-sqlite3';
import { MANDATE_TAG_PREFIX } from './request-principal.js';
import type { EngineDb } from './engine-db.js';
import type { TriggerRecord, TriggerSource, TriggerEffect, TriggerStatus, BulkTriggerEffect } from '../types/pipeline.js';
import type { DeliverySummary } from './notification-router.js';
import { normalizeTier, type ModelTier } from '../types/index.js';

/**
 * The parked status, as a typed constant rather than a SQL literal, so the two
 * queries that partition the table on it (`getDue` excludes it, `getExpiredWaiting`
 * selects it) are bound to {@link TriggerStatus} at compile time: dropping `waiting`
 * from that union breaks this line rather than silently leaving two string literals
 * behind that no longer name a reachable state.
 */
const WAITING: TriggerStatus = 'waiting';

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
 * so the write methods map the record fields onto the engine.db shape. Post
 * S3-behaviour-a the record carries the clean axes directly (source·effect 1:1);
 * the remaining renames are condition_json ← {schedule_cron, watch_config},
 * target_workflow_id ← pipeline_id, params_json ← pipeline_params.
 * {@link triggerRecordToRow} is the pure `TriggerRecord`→row mapping, kept as the
 * canonical documented form + its test coverage (the inverse of the read adapter
 * {@link triggerDbRowToRecord}); the live write methods build the row (via
 * {@link insert}/{@link upsert}) or patch columns directly from their params, so
 * nothing on the write path calls it after the S3f cutover.
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
  /** What FIRES it (S3-behaviour-a clean axis): cron|watch|webhook|inbox_event|manual. */
  source: TriggerSource;
  /** What it DOES when fired: run_workflow|run_agent (mint a Run) | backup|notify
   *  (deterministic, no Run). The WorkerLoop dispatches on this. */
  effect: TriggerEffect;
  /** JSON `{schedule_cron, watch_config}` — both raw. */
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
  /** Human first-run-confirm for a `run_agent` trigger (the consent gate). null =
   *  not confirmed. Fail-closed: only an explicit human action supplies it. */
  confirmedAt?: string | null | undefined;
  /** The creating session's untrusted-content cause, or null when it had taken in none. */
  createdUntrusted?: string | null | undefined;
  /** Principal tag of the creator (request-principal.ts); set once, never overwritten. */
  createdBy?: string | null | undefined;
  /** Principal tag of whoever stamped `confirmedAt`; cleared with it. */
  confirmedBy?: string | null | undefined;
}

export interface StoredTrigger {
  id: string;
  title: string;
  description: string;
  source: string;
  effect: string;
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
  confirmedAt: string | null;
}

/**
 * Pure map of a {@link TriggerRecord} onto the engine.db `triggers` row shape.
 * `source`/`effect` are the clean typed axes carried through 1:1; `condition_json`
 * carries `schedule_cron` + the raw `watch_config`. `assignee` is dropped (constant
 * 'lynox' for fired rows). engine.db columns with no record source
 * (`source_connection_id`, `subject_id`, `last_run_id`) are left for S4.
 * `targetWorkflowId` is the raw candidate; the FK-guard lives in {@link TriggerStore.upsert}.
 */
export function triggerRecordToRow(rec: TriggerRecord): TriggerRow {
  return {
    id: rec.id,
    title: rec.title,
    description: rec.description,
    source: rec.source,
    effect: rec.effect,
    conditionJson: JSON.stringify({
      schedule_cron: rec.schedule_cron ?? null,
      watch_config: rec.watch_config ?? null,
      ...(rec.bulk_run_id !== undefined ? { run_id: rec.bulk_run_id } : {}),
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
    confirmedAt: rec.confirmed_at ?? null,
    createdUntrusted: rec.created_untrusted ?? null,
    createdBy: rec.created_by ?? null,
    confirmedBy: rec.confirmed_by ?? null,
  };
}

interface TriggerDbRow {
  id: string;
  title: string;
  description: string;
  source: string;
  effect: string;
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
  confirmed_at: string | null;
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
  effect: string;
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
  confirmed_at: string | null;
  waiting_until: string | null;
  created_untrusted: string | null;
  created_by: string | null;
  edited_by: string | null;
  confirmed_by: string | null;
  model_tier: string | null;
  last_escalation_at: string | null;
  last_escalation_outcome: string | null;
}

/**
 * The new value of `consent_reminded_at` for a write that sets `confirmed_at` to `?NEW`
 * (a bound parameter or `NULL`): kept only when the row had no stamp and gets none, cleared
 * otherwise. See {@link TriggerStore.setConfirmedAt}.
 */
const KEEP_MARKER_IF_UNSTAMPED_SQL =
  "CASE WHEN COALESCE(?NEW, '') = '' AND COALESCE(confirmed_at, '') = '' THEN consent_reminded_at ELSE NULL END";

/** The full column list the S3e read methods SELECT (order matches TriggerFullDbRow). */
const TRIGGER_READ_COLS =
  `id, title, description, source, effect, condition_json, target_workflow_id, params_json,
   scope_type, scope_id, status, enabled, next_run_at, last_run_at, last_run_result,
   last_run_status, notification_channel, max_retries, retry_count, created_at, updated_at,
   confirmed_at, waiting_until, created_untrusted, created_by, edited_by, confirmed_by, model_tier,
   last_escalation_at, last_escalation_outcome`;

/**
 * Pure INVERSE of {@link triggerRecordToRow}: map an engine.db `triggers` row onto
 * a {@link TriggerRecord}. Clean row-mapper (NOT a legacy reconstruction post
 * S3-behaviour-a): `source`/`effect` are the row's own typed axes carried 1:1;
 * `pipeline_id` ← `target_workflow_id`, `pipeline_params` ← `params_json` (record
 * field names reshaped in the S4 task-cutover).
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
  let bulkRunId: string | undefined;
  try {
    const cond = JSON.parse(row.condition_json) as { schedule_cron?: string | null; watch_config?: string | null; run_id?: unknown };
    scheduleCron = cond.schedule_cron ?? undefined;
    watchConfig = cond.watch_config ?? undefined;
    bulkRunId = typeof cond.run_id === 'string' ? cond.run_id : undefined;
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
    waiting_until: row.waiting_until ?? undefined,
    source: row.source as TriggerSource,
    effect: row.effect as TriggerEffect,
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
    confirmed_at: row.confirmed_at ?? undefined,
    created_untrusted: row.created_untrusted ?? undefined,
    created_by: row.created_by ?? undefined,
    edited_by: row.edited_by ?? undefined,
    confirmed_by: row.confirmed_by ?? undefined,
    // Read through `normalizeTier`, so a value no writer can produce reads as no choice.
    model_tier: normalizeTier(row.model_tier ?? undefined),
    ...(bulkRunId !== undefined ? { bulk_run_id: bulkRunId } : {}),
    ...escalationOf(row),
  };
}

/** A value no writer produces reads as no record, so the surface never shows a guess. */
function escalationOf(row: TriggerFullDbRow): Pick<TriggerRecord, 'last_escalation_at' | 'last_escalation_outcome'> {
  const outcome = row.last_escalation_outcome;
  if (row.last_escalation_at === null || !isEscalationOutcome(outcome)) return {};
  return { last_escalation_at: row.last_escalation_at, last_escalation_outcome: outcome };
}

/** What `last_escalation_outcome` may hold: an answer, or `unconfirmed` until one arrives. */
export type EscalationOutcome = DeliverySummary | 'unconfirmed';

function isEscalationOutcome(v: string | null): v is EscalationOutcome {
  return v === 'delivered' || v === 'not_delivered' || v === 'no_channel' || v === 'unconfirmed';
}

/**
 * Escape LIKE metacharacters so a `%`/`_` in an id cannot widen the prefix match.
 * Mirrors {@link WorkflowStore}'s `likePrefix` — the engine.db reads are written
 * correctly rather than replicating the legacy bare-`LIKE '${id}%'` footgun.
 */
function likePrefix(id: string): string {
  return `${id.replace(/[\\%_]/g, '\\$&')}%`;
}

/** The trigger id of a bulk run's preview effect — its own, beside `bulk-<id>` of the
 *  write effect, so the two are never one row (build plan B §6 Q6). */
export function bulkPreviewTriggerId(runId: string): string {
  return `bulk-preview-${runId}`;
}

/** LIKE pattern for a mandate tag, built from the one prefix request-principal.ts owns. */
const MANDATE_TAG_LIKE = `${MANDATE_TAG_PREFIX}%`;

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
        id, title, description, source, effect, condition_json, target_workflow_id,
        params_json, scope_type, scope_id, status, enabled, next_run_at,
        last_run_at, last_run_result, last_run_status, notification_channel,
        max_retries, retry_count, confirmed_at, created_untrusted, created_by, confirmed_by,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        source = excluded.source,
        effect = excluded.effect,
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
        confirmed_at = excluded.confirmed_at,
        -- One way: a re-write may record a creator's taint, never clear one already recorded.
        created_untrusted = COALESCE(excluded.created_untrusted, triggers.created_untrusted),
        -- The creator is set once: a re-write never replaces it. edited_by is not
        -- written here at all; only markEditedBy writes it.
        created_by = COALESCE(triggers.created_by, excluded.created_by),
        -- Who stamped goes with the stamp: no stamp, no stamper.
        confirmed_by = CASE WHEN COALESCE(excluded.confirmed_at, '') = '' THEN NULL
                            ELSE COALESCE(excluded.confirmed_by, triggers.confirmed_by) END,
        -- The reminder marker survives only an unstamped row staying unstamped (setConfirmedAt says why).
        consent_reminded_at = CASE WHEN COALESCE(excluded.confirmed_at, '') = '' AND COALESCE(triggers.confirmed_at, '') = ''
                                   THEN triggers.consent_reminded_at ELSE NULL END,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.title,
      row.description,
      row.source,
      row.effect,
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
      row.confirmedAt ?? null,
      row.createdUntrusted ?? null,
      row.createdBy ?? null,
      row.confirmedAt ? (row.confirmedBy ?? null) : null,
      ts?.createdAt ?? null,
      ts?.updatedAt ?? null,
    );
  }

  /** Resolve `target_workflow_id` to a concrete `workflows.id` if the referenced
   *  workflow row exists (engine.db enforces the FK), else NULL — so a pre-flag
   *  orphan never throws (a FK-null then safe-skips in the worker-loop, no spend).
   *  Exact-preferring; a prefix (mirroring {@link WorkflowStore}'s short-id
   *  read/delete UX) is accepted ONLY when it is UNAMBIGUOUS. An ambiguous prefix
   *  must NOT bind the trigger to an arbitrary workflow — the money-path would then
   *  spend on the wrong one — so 0-or-many prefix matches resolve to NULL (→
   *  safe-skip) instead. Stores the ACTUAL matched id so the FK + the
   *  destructive-edit guard ({@link getByWorkflowId}, exact-match) stay consistent. */
  private _resolveTargetWorkflowId(candidate: string | null): string | null {
    if (candidate === null || candidate === '') return null;
    // Exact id wins outright (the common case: a system-generated full id) and is
    // a sargable PK lookup.
    const exact = this.db.prepare('SELECT id FROM workflows WHERE id = ? LIMIT 1')
      .get(candidate) as { id: string } | undefined;
    if (exact) return exact.id;
    // No exact row: accept a prefix ONLY if it matches exactly one workflow.
    // 0 or >1 matches → NULL (safe-skip) rather than an arbitrary wrong-spend.
    const hits = this.db.prepare("SELECT id FROM workflows WHERE id LIKE ? ESCAPE '\\' LIMIT 2")
      .all(likePrefix(candidate)) as Array<{ id: string }>;
    return hits.length === 1 ? hits[0]!.id : null;
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
   * is a plain insert). Defaults reproduced explicitly: status 'open', `source`
   * 'manual' + `effect` 'run_agent' (a bare unclassified trigger), scope
   * 'project'/'', max_retries 0, retry_count 0, enabled 1, params_json '{}'. Callers
   * set `source`/`effect` from user intent. `assignee` is NOT stored (every trigger
   * is agent-owned — const 'lynox', which the read synthesizes).
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
    source?: TriggerSource | undefined;
    effect?: TriggerEffect | undefined;
    watchConfig?: string | undefined;
    maxRetries?: number | undefined;
    notificationChannel?: string | undefined;
    pipelineId?: string | undefined;
    pipelineParams?: string | undefined;
    /** Human first-run-confirm (the `run_agent` consent gate). Absent = unconfirmed
     *  — fail-closed. Only the human HTTP create route supplies it; the agent
     *  `task_create` tool never does, so an agent-scheduled `run_agent` trigger
     *  lands unconfirmed and is neither due nor dispatched until a human confirms. */
    confirmedAt?: string | undefined;
    /** The creating session's untrusted-content cause; absent when it had taken in none. */
    createdUntrusted?: string | undefined;
    /** Principal tag of the creating request; absent for the agent tool and the engine. */
    createdBy?: string | undefined;
    /** Principal tag of whoever supplied `confirmedAt` — only the owner does. */
    confirmedBy?: string | undefined;
  }): void {
    this.upsert({
      id: params.id,
      title: params.title,
      description: params.description ?? '',
      source: params.source ?? 'manual',
      // The sole funnel (TaskManager.create → deriveSourceEffect) ALWAYS supplies
      // effect, so this default is an unreached backstop. It is a money-direction
      // value (run_agent) only because an unclassified bare trigger IS an agent run;
      // a backup/reminder always arrives with its explicit effect, never here.
      effect: params.effect ?? 'run_agent',
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
      confirmedAt: params.confirmedAt ?? null,
      createdUntrusted: params.createdUntrusted ?? null,
      createdBy: params.createdBy ?? null,
      confirmedBy: params.confirmedBy ?? null,
    });
  }

  /**
   * Arm the trigger that writes an approved bulk run (PRD bulk-changes-reversible §3.4):
   * effect `bulk_apply` or `bulk_undo` (or `bulk_preview`, which READS an external run's
   * targets, under its own id {@link bulkPreviewTriggerId}), `condition_json.run_id`, due at `nextRunAt`. One
   * trigger per run — id `bulk-<runId>` — so approving, resuming or re-approving re-arms
   * the same row instead of starting a second loop. The only path that CREATES a bulk
   * effect: {@link insert} takes its effect from `deriveSourceEffect`, which never
   * yields one, and {@link updateFields} cannot change `effect` or `run_id`.
   */
  armBulkEffect(params: { runId: string; effect: BulkTriggerEffect; title: string; nextRunAt: string }): string {
    const id = params.effect === 'bulk_preview' ? bulkPreviewTriggerId(params.runId) : `bulk-${params.runId}`;
    this.upsert({
      id,
      title: params.title,
      description: '',
      source: 'manual',
      effect: params.effect,
      conditionJson: JSON.stringify({ schedule_cron: null, watch_config: null, run_id: params.runId }),
      targetWorkflowId: null,
      paramsJson: '{}',
      scopeType: 'project',
      scopeId: '',
      status: 'open',
      enabled: true,
      nextRunAt: params.nextRunAt,
      lastRunAt: null,
      lastRunResult: null,
      lastRunStatus: null,
      notificationChannel: null,
      maxRetries: 0,
      retryCount: 0,
      confirmedAt: null,
    });
    return id;
  }

  /** S3f write-cutover: flip the cron kill-switch DIRECTLY on engine.db, mirroring
   *  the legacy `setTriggerEnabled` (exact-id). Returns false if no row matched. */
  setEnabled(id: string, enabled: boolean): boolean {
    return this.db.prepare(
      "UPDATE triggers SET enabled = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(enabled ? 1 : 0, id).changes > 0;
  }

  /** Stamp (or clear) the human first-run-confirm on a trigger — the consent
   *  surface's write. `confirmedAt` = an ISO timestamp to confirm a `run_agent`
   *  trigger for unattended execution, or null to un-confirm. Exact-id (same idiom
   *  as {@link setEnabled}); returns false if no row matched. */
  setConfirmedAt(id: string, confirmedAt: string | null, confirmedBy?: string | undefined): boolean {
    // A named stamper takes the trigger over: it becomes the last party in `edited_by`,
    // which is what the mandate gate in {@link getDue} reads. Without it, a schedule a
    // mandate set up would be held again by the owner's own later rename, forever.
    const by = confirmedAt === null ? null : (confirmedBy ?? null);
    return this.db.prepare(
      // The reminder marker survives only while a trigger stays unstamped throughout: a write
      // that stamps it, or that touches a stamp it had, clears the marker, so the next
      // unconfirmed phase is reminded once again. An edit to a trigger that was never stamped
      // keeps it, so rewriting a waiting trigger cannot make it announce itself again.
      // Asking for the OLD stamp too (SQLite reads the pre-update row on the right-hand side)
      // also covers a stamp written by a binary that predates the marker and left it set.
      `UPDATE triggers SET confirmed_at = ?, confirmed_by = ?, edited_by = COALESCE(?, edited_by), consent_reminded_at = ${KEEP_MARKER_IF_UNSTAMPED_SQL.replace('?NEW', '?')}, updated_at = datetime('now') WHERE id = ?`,
    ).run(confirmedAt, by, by, confirmedAt, id).changes > 0;
  }

  /**
   * Record that a request changed this trigger, and drop its stamp when that request
   * was not the owner's (PRD customer-granted-operator-access §3.12 point 3). Called
   * BEFORE the change it records: a crash between the two leaves a trigger that is
   * unstamped and unchanged — never one that is changed and still stamped. The engine's
   * own writes (status, next run, lease) do not come through here.
   */
  markEditedBy(id: string, editedBy: string, clearStamp: boolean): boolean {
    return this.db.prepare(
      clearStamp
        ? `UPDATE triggers SET edited_by = ?, confirmed_at = NULL, confirmed_by = NULL, consent_reminded_at = ${KEEP_MARKER_IF_UNSTAMPED_SQL.replace('?NEW', 'NULL')}, updated_at = datetime('now') WHERE id = ?`
        : "UPDATE triggers SET edited_by = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(editedBy, id).changes > 0;
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
    /** Durable wait state (§0 E4a): the parked deadline. Empty-string/null clears
     *  it, mirroring `nextRunAt` — un-parking must be able to remove the deadline,
     *  not just move it, or a trigger that resumed early would still be swept. */
    waitingUntil?: string | null | undefined;
    /** The model tier the user chose for this trigger's runs; null clears the choice. */
    modelTier?: ModelTier | null | undefined;
  }, opts?: { scopeFilter?: Array<{ type: string; id: string }> | undefined }): boolean {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (params.title !== undefined) { sets.push('title = ?'); values.push(params.title); }
    if (params.description !== undefined) { sets.push('description = ?'); values.push(params.description); }
    // Editing a trigger's INSTRUCTION (title/description) re-requires consent: an
    // edited instruction is a new instruction, so an injected edit can't repurpose
    // an already-confirmed `run_agent` trigger (mirrors update-workflow clearing the
    // workflow's confirmedAt on any step edit). For other effects it matters only on a
    // trigger a mandate last changed (the mandate gate in getDue). A schedule-only change doesn't alter WHAT runs,
    // so it does NOT clear consent. The watched ADDRESS would alter it — a watch run
    // builds its prompt from the page it fetches — but no path edits it: after creation
    // the only writer of `watch_config` is the run storing its own `last_hash`. A writer
    // that repoints a watch has to clear consent right here; `trigger-consent.test.ts`
    // pins the set of files that may name the setter, so a new one shows up red.
    if (params.title !== undefined || params.description !== undefined) {
      sets.push('confirmed_at = NULL', 'confirmed_by = NULL', `consent_reminded_at = ${KEEP_MARKER_IF_UNSTAMPED_SQL.replace('?NEW', 'NULL')}`);
    }
    if (params.status !== undefined) {
      sets.push('status = ?');
      values.push(params.status);
    }
    if (params.nextRunAt !== undefined) { sets.push('next_run_at = ?'); values.push(params.nextRunAt || null); }
    // `waiting_until` is assigned AT MOST ONCE, and that is not tidiness.
    //
    // A status write that is not `waiting` ENDS a wait as far as this row is
    // concerned, so the deadline has to go with it: `complete()`, `reopen()` and
    // `update()` write a status unconditionally and have no way to pass a
    // deadline, and without this they leave `waiting_until` set on a row that is
    // no longer parked. Nothing sweeps such a row — the sweep keys on the status —
    // so it is inert rather than dangerous, but the two columns disagree and
    // anything later keying on the deadline alone would read it as parked.
    //
    // An earlier version expressed that as a SECOND `waiting_until = NULL` in the
    // status branch, which produced `SET waiting_until = NULL, waiting_until = ?`
    // whenever a caller supplied both. SQLite applies the textually LAST clause,
    // so the clear lost — measured, not assumed. No caller combines them today, so
    // the invariant held by coincidence rather than by construction, which is the
    // kind of thing that stops being true when someone adds a caller.
    //
    // Which one wins when both are given: the clear. A deadline asked for
    // alongside a terminal status is a contradiction, and the safe reading of a
    // contradiction is the one that cannot leave a row looking parked.
    const clearsWait = params.status !== undefined && params.status !== WAITING;
    if (clearsWait || params.waitingUntil !== undefined) {
      sets.push('waiting_until = ?');
      values.push(clearsWait ? null : (params.waitingUntil || null));
    }
    if (params.scheduleCron !== undefined) {
      sets.push("condition_json = json_set(condition_json, '$.schedule_cron', ?)");
      values.push(params.scheduleCron || null);
    }
    // The tier changes which model runs the instruction and what a run costs, not what
    // it is told to do, so like a schedule change it leaves consent as it was. A
    // mandate's change is marked by the request route, as every mandate edit is.
    if (params.modelTier !== undefined) { sets.push('model_tier = ?'); values.push(params.modelTier); }
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
      `SELECT id, title, description, source, effect, condition_json, target_workflow_id,
              params_json, status, enabled, next_run_at, last_run_at,
              last_run_result, last_run_status, retry_count, created_at, confirmed_at
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
      `SELECT id, title, description, source, effect, condition_json, target_workflow_id,
              params_json, status, enabled, next_run_at, last_run_at,
              last_run_result, last_run_status, retry_count, created_at, confirmed_at
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
   *
   * CONSENT GATE (triggers-consent, engine.db v6): an unconfirmed `run_agent`
   * trigger is NOT due — `NOT (effect = 'run_agent' AND COALESCE(confirmed_at, '') = '')`.
   * An empty stamp counts as none, as it does in JS (`!confirmed_at`, e.g.
   * `mandateNeedsOwnerStamp`): the two sides must agree, and they agree on the closed side.
   * This is the PRIMARY enforcement of the human first-run-confirm on autonomous
   * agent triggers (the injection-amplification hole): an agent-created
   * `run_agent` trigger (which lands `confirmed_at = NULL`, fail-closed) is simply
   * never selected until a human confirms it — so `next_run_at` is preserved (no
   * disable / no run-result mangling) and confirming makes it due in place. The
   * WorkerLoop dispatch adds a defense-in-depth backstop. Held back this quietly, the
   * trigger would never be mentioned again; {@link getAwaitingConsentUnreminded} is the
   * other half, which the tick uses to tell the owner once that it came due. `run_workflow` keeps its
   * own {@link PlannedPipeline.confirmedAt} gate (in executePipeline);
   * `backup`/`notify` are deterministic → never gated here.
   *
   * WAIT GATE (durable wait state, §0 T3/A3): a PARKED trigger is not due. Its
   * `next_run_at` still points at the run that parked it, so without this clause
   * every tick would re-fire a trigger that is waiting for an answer — the
   * repeated-LLM-output failure. Added to the existing DENYLIST rather than
   * rewriting it as an allowlist: the `status != 'failed' OR schedule_cron` term
   * above is what keeps a failed cron trigger auto-recovering, and an allowlist of
   * the statuses we happen to remember would drop it (task-manager.test.ts covers
   * exactly that row). Bound as a parameter off {@link WAITING}, not written as a
   * SQL literal, so the query and the type cannot drift apart.
   *
   * MANDATE GATE (engine.db v20; PRD customer-granted-operator-access §3.12, §3.13): a
   * trigger that a mandate created or last changed is not due until the OWNER stamped
   * it — for EVERY effect, not only `run_agent`. A `run_workflow` schedule otherwise runs
   * on the stamp of the workflow it names, so a mandate could put an owner-stamped
   * workflow on its own cron with its own parameters and it would run unattended. The
   * owner's own triggers are unaffected: their creator and editor are `owner` or NULL.
   * What counts is the LAST party that changed the trigger or took it over: `edited_by`
   * when set, the creator otherwise. An owner's stamp takes the trigger over
   * ({@link setConfirmedAt} writes the stamper into `edited_by`), so once stamped, a later
   * change that clears the stamp without a mandate behind it (an owner's rename) does not
   * hold the schedule again — which it would if the creator counted forever.
   * The COALESCE is load-bearing: a NULL tag would make the LIKE NULL, the NOT of it NULL,
   * and the WHERE would then drop every untagged trigger — every trigger from before v20.
   * A denylist term like the two around it. The `mandate:` prefix is the tag form of
   * request-principal.ts and is bound as a parameter so the two cannot drift apart.
   *
   * LEASE GATE (engine.db v16): a trigger whose run holds a live lease is not due, in
   * this process or any other on the same file. A lapsed lease is due again, so the
   * caller's {@link claimLease} can find it and decide what the dead run means. Also
   * a denylist term, for the same reason as the wait gate.
   */
  getDue(now: string = new Date().toISOString()): TriggerRecord[] {
    const rows = this.db.prepare(
      `SELECT ${TRIGGER_READ_COLS}
       FROM triggers
       WHERE next_run_at IS NOT NULL
         AND next_run_at <= ?
         AND enabled != 0
         AND status != 'completed'
         AND status != ?
         AND (status != 'failed' OR json_extract(condition_json, '$.schedule_cron') IS NOT NULL)
         AND NOT (effect = 'run_agent' AND COALESCE(confirmed_at, '') = '')
         AND NOT (COALESCE(confirmed_at, '') = '' AND COALESCE(edited_by, created_by, '') LIKE ?)
         AND (lease_until IS NULL OR lease_until <= ?)
       ORDER BY next_run_at ASC`,
    ).all(now, WAITING, MANDATE_TAG_LIKE, now) as TriggerFullDbRow[];
    return rows.map(triggerDbRowToRecord);
  }

  /**
   * The `run_agent` triggers {@link getDue} holds back for consent and whose owner has not
   * been told yet — the input of the worker loop's reminder.
   *
   * The same predicate as `getDue` with its consent clause turned round: a trigger listed
   * here is one that would be running now if a human had confirmed it. The denylist terms
   * around it stay, so a paused, completed, parked or leased trigger is not "due" here
   * either. A trigger a mandate wrote is listed too when it is an unconfirmed `run_agent`;
   * the owner is the one who can stamp it, so telling the owner is right for both reasons
   * it waits.
   */
  getAwaitingConsentUnreminded(now: string = new Date().toISOString()): TriggerRecord[] {
    const rows = this.db.prepare(
      `SELECT ${TRIGGER_READ_COLS}
       FROM triggers
       WHERE next_run_at IS NOT NULL
         AND next_run_at <= ?
         AND enabled != 0
         AND status != 'completed'
         AND status != ?
         AND (status != 'failed' OR json_extract(condition_json, '$.schedule_cron') IS NOT NULL)
         AND effect = 'run_agent' AND COALESCE(confirmed_at, '') = ''
         AND consent_reminded_at IS NULL
         AND (lease_until IS NULL OR lease_until <= ?)
       ORDER BY next_run_at ASC`,
    ).all(now, WAITING, now) as TriggerFullDbRow[];
    return rows.map(triggerDbRowToRecord);
  }

  /**
   * Mark that an escalation of this trigger has started: `last_escalation_at` becomes the
   * start, the outcome `unconfirmed` until the channels answer. Written BEFORE the wakeup is
   * sent, so a newer escalation that never gets an answer (a stalled push endpoint, a throw
   * before the send) cannot leave the previous outcome on screen as if it were current.
   * The case shows the latest escalation, the way `last_run_status` shows the latest run.
   *
   * A fresh start always lands: it is the newest escalation by construction, and making it
   * compare against the stored value would let a stored instant from a clock that was ahead
   * (before an NTP step, across a restart) refuse every new start until wall time catches up.
   * `onlyIfLater` is for a start RETRIED after its first write failed — by then a newer
   * escalation may have begun, and the retry must not take the record back to the older one.
   * `at` is an ISO-8601 instant from `toISOString`, which compares correctly as text.
   * False when the trigger is gone, or (`onlyIfLater`) when the recorded start is not older.
   */
  startEscalation(id: string, at: string = new Date().toISOString(), onlyIfLater = false): boolean {
    if (onlyIfLater) {
      return this.db.prepare(
        "UPDATE triggers SET last_escalation_at = ?, last_escalation_outcome = 'unconfirmed' WHERE id = ? AND (last_escalation_at IS NULL OR last_escalation_at < ?)",
      ).run(at, id, at).changes > 0;
    }
    return this.db.prepare(
      "UPDATE triggers SET last_escalation_at = ?, last_escalation_outcome = 'unconfirmed' WHERE id = ?",
    ).run(at, id).changes > 0;
  }

  /**
   * Record the answer for the escalation that started at `startedAt`. Conditional on that
   * start still being the latest, so an older escalation whose channels answer late cannot
   * overwrite a newer one. Both columns survive later edits of the trigger (the upsert leaves
   * them alone), because the record is about its last escalation, not its current shape.
   * False when the trigger is gone or a newer escalation has started.
   */
  recordEscalationOutcome(id: string, outcome: DeliverySummary, startedAt: string): boolean {
    return this.db.prepare(
      'UPDATE triggers SET last_escalation_outcome = ? WHERE id = ? AND last_escalation_at = ?',
    ).run(outcome, id, startedAt).changes > 0;
  }

  /**
   * Claim the reminder for one trigger. True for exactly one caller per unconfirmed phase —
   * the stretch in which a trigger stays unstamped; edits inside it do not start a new one,
   * so rewriting a waiting trigger cannot make it announce itself again. The write is conditional on the marker still being empty and the trigger still being
   * unconfirmed, so two processes on the same file cannot both send it, and a trigger that
   * was confirmed in the meantime is not reminded about.
   */
  markConsentReminded(id: string, at: string = new Date().toISOString()): boolean {
    return this.db.prepare(
      "UPDATE triggers SET consent_reminded_at = ? WHERE id = ? AND consent_reminded_at IS NULL AND COALESCE(confirmed_at, '') = ''",
    ).run(at, id).changes > 0;
  }

  /**
   * End a wait exactly once — the only CONDITIONAL way out of `waiting`, and the
   * reason A6 needs no check in front of it.
   *
   * ⚠ Not the only way out, and an earlier version of this comment claimed it was.
   * `TaskManager.complete()` and `.update()` write a status unconditionally
   * through {@link updateFields}, which gates on nothing — so a human marking a
   * parked trigger `completed` takes it out of `waiting` without coming through
   * here. That path predates this wave (it could always end a RUNNING trigger the
   * same way) and it is left alone; what this wave adds is the deadline, and
   * `updateFields` now clears that alongside any non-`waiting` status so the two
   * columns cannot disagree. What such a bypass does NOT do is settle the pending
   * prompt — the run stays blocked until its own wait resolves.
   *
   * The `status = 'waiting'` in the WHERE is the whole mechanism. Two callers
   * race by construction: the run's own `finally`, which un-parks when its wait
   * settles, and the expiry sweep, which ends a trigger a dead process left
   * parked. Both may fire for the same row; the second one to arrive matches no
   * row and reports false. A read-then-write would have a window between the two
   * halves, and the two callers do not share a transaction — they may not even
   * share a process.
   *
   * `waiting_until` is cleared in the same statement rather than left behind: a
   * deadline outliving its status would make the row look parked to anything
   * that keys on the column alone.
   *
   * The target status excludes `waiting` at the type level, because "ending" a
   * wait into another wait is not a thing this method can mean.
   */
  endWait(id: string, to: Exclude<TriggerStatus, 'waiting'>): boolean {
    return this.db.prepare(
      "UPDATE triggers SET status = ?, waiting_until = NULL, updated_at = datetime('now') WHERE id = ? AND status = ?",
    ).run(to, id, WAITING).changes > 0;
  }

  /**
   * Take the run lease of a trigger before running it — the persistent half of the
   * double-start guard (the WorkerLoop's `activeTasks` map is the in-process half and
   * dies with the process). One immediate transaction, so two engine processes on the
   * same file cannot both win.
   *
   * `held`: a live lease belongs to someone else; do not run. `claimed`: nobody holds it,
   * or a lapsed lease belongs to a run whose occurrence is no longer the due one: a sweep
   * recorded it, or an answer re-armed its trigger (which runs the same question again,
   * by design of the durable wait), or the lost run was a manual one started before its
   * trigger's scheduled time — that scheduled occurrence then runs, and the lost manual
   * run is not reported; for a one-shot, that scheduled run repeats what the lost manual
   * run had already done (a manual run that finished would have completed the trigger).
   * `interrupted`: a lapsed
   * lease whose run never recorded a result — the occurrence it ran is still the due one,
   * so its holder died (or stopped renewing for longer than the lease) mid-run. The lease
   * is taken in every case but `held`; what an interrupted run means is the caller's call.
   */
  claimLease(id: string, holder: string, until: string, now: string): 'claimed' | 'interrupted' | 'held' | 'not_found' {
    return this.db.transaction((): 'claimed' | 'interrupted' | 'held' | 'not_found' => {
      const row = this.db.prepare('SELECT lease_holder, lease_until, lease_since, next_run_at FROM triggers WHERE id = ?')
        .get(id) as { lease_holder: string | null; lease_until: string | null; lease_since: string | null; next_run_at: string | null } | undefined;
      if (!row) return 'not_found';
      if (row.lease_until !== null && row.lease_until > now) return 'held';
      this.db.prepare('UPDATE triggers SET lease_holder = ?, lease_until = ?, lease_since = ? WHERE id = ?').run(holder, until, now, id);
      const unsettled = row.lease_holder !== null && row.lease_since !== null
        && row.next_run_at !== null && row.next_run_at <= row.lease_since;
      return unsettled ? 'interrupted' : 'claimed';
    }).immediate();
  }

  /** Extend a lease this holder still has. False when it was taken over meanwhile. */
  renewLease(id: string, holder: string, until: string): boolean {
    return this.db.prepare('UPDATE triggers SET lease_until = ? WHERE id = ? AND lease_holder = ?')
      .run(until, id, holder).changes > 0;
  }

  /** Drop the lease once the run has recorded its result. A lease another holder took is left alone. */
  releaseLease(id: string, holder: string): void {
    this.db.prepare('UPDATE triggers SET lease_holder = NULL, lease_until = NULL, lease_since = NULL WHERE id = ? AND lease_holder = ?')
      .run(id, holder);
  }

  /**
   * Every PARKED trigger, regardless of deadline (§0 A10). The expiry sweep asks
   * "whose wait ran out"; this asks "who is waiting at all", because an ANSWER
   * can end a wait long before its deadline and the tick has to notice.
   *
   * Bounded by the number of simultaneously unanswered questions, which is what
   * makes a per-row prompt lookup by the caller affordable — the two tables are
   * in different SQLite files, so there is no join to do it in one query.
   */
  getWaiting(): TriggerRecord[] {
    const rows = this.db.prepare(
      `SELECT ${TRIGGER_READ_COLS} FROM triggers WHERE status = ? ORDER BY updated_at ASC`,
    ).all(WAITING) as TriggerFullDbRow[];
    return rows.map(triggerDbRowToRecord);
  }

  /**
   * The other half of the partition {@link getDue} opens (§0 E5/A12): every PARKED
   * trigger whose wait has run out. After the wait gate above, `getDue` is blind to
   * a waiting trigger — so without this query no loop in the engine would ever see
   * one again and a parked trigger would wait forever. The caller is the WorkerLoop
   * tick, as a second query beside `getDueTriggers`.
   *
   * Deliberately NOT gated on `enabled` or on the `run_agent` consent gate, unlike
   * `getDue`. Both of those decide whether a trigger may START a run; this one only
   * decides whether a wait that already started may END. A trigger disabled (or
   * un-confirmed) while parked would otherwise stay `waiting` with no path out.
   *
   * ⚠ THAT IS ONLY SAFE WHILE THE CALLER ENDS A WAIT AND DOES NOT START A RUN. The
   * consent gate on `getDue` is the primary enforcement of the human first-run
   * confirm for `run_agent` — the injection-amplification hole. A caller that
   * dispatched off THIS query would route around it. The sweep's job is the
   * terminal write; anything that makes a trigger due again belongs on the path
   * that goes back through `getDue`, gate included.
   *
   * `waiting_until IS NOT NULL` is redundant against `<= ?` in SQLite (NULL never
   * compares true) and is kept as an explicit statement of the invariant: a row in
   * `waiting` without a deadline is a bug, and this query must not silently treat
   * it as expired.
   */
  getExpiredWaiting(now: string = new Date().toISOString()): TriggerRecord[] {
    const rows = this.db.prepare(
      `SELECT ${TRIGGER_READ_COLS}
       FROM triggers
       WHERE status = ?
         AND waiting_until IS NOT NULL
         AND waiting_until <= ?
       ORDER BY waiting_until ASC`,
    ).all(WAITING, now) as TriggerFullDbRow[];
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
   * Whether a short id names more than one trigger: no row has it exactly, and at least two
   * start with it. `getById` answers such an id with whichever row SQLite returns first,
   * which is fine for a read and wrong for an action — a caller acting on it may act on a
   * task they did not mean. Same rule as `_resolveTargetWorkflowId`: exact wins, a prefix
   * only when it is unique.
   */
  isAmbiguousId(id: string): boolean {
    if (id === '') return false;
    if (this.db.prepare('SELECT 1 FROM triggers WHERE id = ? LIMIT 1').get(id) !== undefined) return false;
    const hits = this.db.prepare("SELECT id FROM triggers WHERE id LIKE ? ESCAPE '\\' LIMIT 2").all(likePrefix(id));
    return hits.length > 1;
  }

  /**
   * Filtered trigger list. Truthy-gated `scope_type`/`scope_id`/`status`/`taskType`
   * clauses, `ORDER BY next_run_at ASC NULLS LAST, created_at DESC`, `limit` default
   * 100. Post S3-behaviour-a the legacy conflated `task_type` no longer exists as a
   * column, so the `taskType` filter matches EITHER clean axis — a source value
   * (cron|watch|manual) OR an effect value (run_workflow|run_agent|backup|notify) —
   * so a caller can filter by whichever axis its value belongs to. (A stale legacy
   * value like 'pipeline'/'scheduled'/'reminder' matches neither, which is correct —
   * those values were split away.)
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
    if (opts?.taskType) { clauses.push('(source = ? OR effect = ?)'); params.push(opts.taskType, opts.taskType); }
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
      effect: row.effect,
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
      confirmedAt: row.confirmed_at,
    };
  }
}
