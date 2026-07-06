import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import type { TriggerRecord, TaskStatus } from '../types/index.js';
import { WorkflowStore } from './workflow-store.js';
import { TriggerStore, triggerRecordToRow } from './trigger-store.js';
import { TaskStore, taskRecordToRow } from './task-store.js';
import { deriveSourceEffect } from './task-manager.js';
import {
  getAllPlannedPipelines,
  getAllTasks,
  getLegacyTriggerRows,
  type LegacyTriggerRow,
} from './run-history-persistence.js';

/**
 * Foundation Rework v2 — the verb-layer THREE-TYPE backfill (workflows + triggers +
 * tasks).
 *
 * Replays the legacy history.db verb DEFINITIONS into the engine.db verb-graph so a
 * tenant upgrading from a pre-verb-arc image (v1.22.0) keeps its full automation
 * surface after engine.db becomes the sole read authority (S3f). It is the data-
 * preservation half of the verb-layer cut: mig v44 is now NON-destructive (the legacy
 * `triggers` table + planned-pipeline rows stay DORMANT as a rollback net — the
 * deferred-DROP pattern shared with the v45 metrics move), and this backfill copies
 * them forward. The engine wires it at boot, gated exactly-once by the engine.db
 * `verb_backfill_marker` (see engine.ts), so it runs on the upgrade boot (or after an
 * engine.db recreate) and never resurrects a subsequently-deleted definition.
 *
 * Order matters — workflows FIRST (no verb FK), then triggers (`target_workflow_id`
 * → workflows, all now present), then tasks:
 *   1. workflows  — from the legacy `pipeline_runs status='planned'` rows.
 *   2. triggers   — from the legacy `triggers` table. Those rows carry the pre-#850
 *      `task_type`; the clean source/effect axes are DERIVED here via
 *      {@link deriveSourceEffect} (the read-side twin of the engine.db v3 migration
 *      remap — the two MUST agree so a backfilled legacy trigger matches a natively-
 *      created one).
 *   3. tasks      — user-TODOs, with a two-pass parent re-link (a child ordered
 *      before its parent gets its `parent_task_id` NULLed by the FK-guard in pass-1;
 *      pass-2 re-upserts every row now that ALL exist so every legacy parent resolves
 *      at any subtree depth). S4a `resolveAssignee` resolves each task's legacy free-
 *      text `assignee` → `assignee_subject_id` only on a flag-ON tenant.
 *
 * Reuses the SAME store primitives the live mirror uses (`WorkflowStore.upsert`,
 * `triggerRecordToRow`+`TriggerStore.upsert`, `taskRecordToRow`+`TaskStore.upsert`)
 * so field mapping + FK-guards stay single-sourced. Writes DIRECTLY via its own
 * stores (NOT the `_verbMirror` swallow-wrapper) so a failure surfaces.
 *
 * Atomic: the whole run is ONE engine.db transaction (a mid-run failure leaves
 * engine.db untouched → the marker stays 0 → the next boot retries). Idempotent:
 * every write is an ON CONFLICT DO UPDATE upsert and the preserved legacy timestamps
 * make a re-run land byte-identical rows.
 */

export interface VerbBackfillCounts {
  workflows: number;
  triggers: number;
  tasks: number;
  /** engine.db tasks WITH a non-NULL parent link AFTER the backfill (a re-link sanity
   *  signal: 0 with subtasks present ⇒ the two-pass failed). Post-backfill table
   *  total, so on a mirror-ON tenant it also counts rows the live mirror wrote. */
  taskParentLinks: number;
}

/**
 * Map a RAW legacy `triggers` row (v42 `task_type`) onto a {@link TriggerRecord} with
 * the clean source/effect axes derived via {@link deriveSourceEffect}. Legacy
 * `enabled` is the raw 0/1 (or absent = enabled). `assignee` is preserved for parity.
 */
function legacyTriggerToRecord(row: LegacyTriggerRow): TriggerRecord {
  const { source, effect } = deriveSourceEffect({
    taskType: row.task_type ?? undefined,
    scheduleCron: row.schedule_cron ?? undefined,
    watchConfig: row.watch_config ?? undefined,
    pipelineId: row.pipeline_id ?? undefined,
  });
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    status: row.status as TaskStatus,
    assignee: row.assignee,
    scope_type: row.scope_type ?? 'project',
    scope_id: row.scope_id ?? '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    source,
    effect,
    schedule_cron: row.schedule_cron ?? undefined,
    next_run_at: row.next_run_at ?? undefined,
    last_run_at: row.last_run_at ?? undefined,
    last_run_result: row.last_run_result ?? undefined,
    last_run_status: row.last_run_status ?? undefined,
    watch_config: row.watch_config ?? undefined,
    max_retries: row.max_retries ?? undefined,
    retry_count: row.retry_count ?? undefined,
    notification_channel: row.notification_channel ?? undefined,
    pipeline_id: row.pipeline_id ?? undefined,
    pipeline_params: row.pipeline_params ?? undefined,
    enabled: row.enabled ?? undefined,
    // Grandfather (triggers-consent, engine.db v6): a legacy trigger predates the
    // `run_agent` consent gate and was operator-created (pre-customer) → treat it
    // as confirmed so a direct v1.22→2.x upgrade whose triggers arrive via THIS
    // backfill (rather than pre-existing in engine.db, which the v6 UPDATE handles)
    // never pauses the operator's own schedules. Scoped to `run_agent` (the only
    // gated effect); deterministic `created_at`, no wall-clock. Matches the v6
    // migration's grandfather so both entry paths agree.
    confirmed_at: effect === 'run_agent' ? row.created_at : undefined,
  };
}

export class VerbGraphBackfill {
  private readonly workflows: WorkflowStore;
  private readonly triggers: TriggerStore;
  private readonly tasks: TaskStore;

  constructor(
    private readonly engineDb: EngineDb,
    private readonly historyDb: Database.Database,
  ) {
    this.workflows = new WorkflowStore(engineDb);
    this.triggers = new TriggerStore(engineDb);
    this.tasks = new TaskStore(engineDb);
  }

  run(opts?: { resolveAssignee?: boolean | undefined }): VerbBackfillCounts {
    const counts: VerbBackfillCounts = { workflows: 0, triggers: 0, tasks: 0, taskParentLinks: 0 };
    const db = this.engineDb.getDb();
    const upsertOpts = { manageAssignee: opts?.resolveAssignee === true };

    db.transaction(() => {
      // 1 — workflows (no verb FK). definitionJson is byte-identical to the live
      // mirror's JSON.stringify(planned); name/goal/template read from the manifest.
      for (const row of getAllPlannedPipelines(this.historyDb)) {
        const parsed = this._parseManifest(row.manifest_json);
        this.workflows.upsert(
          {
            id: row.id,
            name: (typeof parsed.name === 'string' && parsed.name) || row.manifest_name || row.id,
            description: typeof parsed.goal === 'string' ? parsed.goal : '',
            definitionJson: row.manifest_json,
            isTemplate: parsed.template === true,
            sourceRunId: null,
          },
          { createdAt: row.started_at, updatedAt: row.started_at },
        );
        counts.workflows++;
      }

      // 2 — triggers (target_workflow_id → workflows, all now present). Legacy rows
      // carry the pre-#850 task_type → derive source/effect.
      for (const row of getLegacyTriggerRows(this.historyDb)) {
        const rec = legacyTriggerToRecord(row);
        this.triggers.upsert(triggerRecordToRow(rec), { createdAt: rec.created_at, updatedAt: rec.updated_at });
        counts.triggers++;
      }

      // 3 — tasks. pass-1 resolves the assignee (when enabled) + upserts (a child
      // ordered before its parent gets parent_task_id NULLed by the FK-guard).
      const taskRows = getAllTasks(this.historyDb);
      for (const rec of taskRows) {
        this.tasks.upsert(taskRecordToRow(rec), { createdAt: rec.created_at, updatedAt: rec.updated_at }, upsertOpts);
        counts.tasks++;
      }
      // pass-2: re-upsert ONLY to re-link every now-present legacy parent. Assignee
      // stays unmanaged here — the pass-1 assignee_subject_id is preserved by the ON
      // CONFLICT (which omits the column when manageAssignee is false).
      for (const rec of taskRows) {
        this.tasks.upsert(taskRecordToRow(rec), { createdAt: rec.created_at, updatedAt: rec.updated_at });
      }
    })();

    counts.taskParentLinks =
      (db.prepare('SELECT COUNT(*) n FROM tasks WHERE parent_task_id IS NOT NULL').get() as { n: number }).n;
    return counts;
  }

  /** Parse a legacy planned-pipeline manifest; a malformed blob yields `{}` (the
   *  workflow still backfills with fallback name/description). */
  private _parseManifest(json: string): { name?: unknown; goal?: unknown; template?: unknown } {
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed && typeof parsed === 'object') {
        return parsed as { name?: unknown; goal?: unknown; template?: unknown };
      }
    } catch {
      /* malformed manifest — fall through to defaults */
    }
    return {};
  }
}
