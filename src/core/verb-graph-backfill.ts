import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import { WorkflowStore } from './workflow-store.js';
import { TriggerStore, triggerRecordToRow } from './trigger-store.js';
import { TaskStore, taskRecordToRow } from './task-store.js';
import { getAllPlannedPipelines, getAllTasks, getAllTriggers } from './run-history-persistence.js';

/**
 * Foundation Rework v2 — S3d verb-layer backfill.
 *
 * Replays the legacy history.db verb DEFINITIONS (planned-pipeline workflows +
 * agent-triggers + user-tasks) into the engine.db verb-graph so a tenant's full
 * history is present BEFORE reads cut over to engine.db (S3e). The S3a-c mirror
 * only dual-writes FRESH verb writes while `verb_graph_enabled` is ON; every
 * pre-flag definition is absent from engine.db until this backfill copies it.
 *
 * Reuses the SAME store primitives the live mirror uses (`WorkflowStore.upsert`,
 * `triggerRecordToRow`+`TriggerStore.upsert`, `taskRecordToRow`+`TaskStore.upsert`)
 * so the field mapping + FK-guards stay single-sourced — only the orchestration
 * differs (a global full-scan, not per-write). Writes DIRECTLY via its own stores,
 * NOT through the `RunHistory._verbMirror` swallow-wrapper, so a backfill failure
 * surfaces (the CLI aborts) rather than being silently degraded.
 *
 * Dependency order (D6) — engine.db enforces `foreign_keys = ON`, and the store
 * upserts resolve-or-NULL an unresolved FK:
 *   1. workflows first (no verb FK).
 *   2. triggers (`target_workflow_id` → workflows) — all workflows already present,
 *      so every live FK resolves in one pass.
 *   3. tasks pass-1 (`parent_task_id` → tasks) — a child ordered before its parent
 *      gets its link NULLed by the guard.
 *   4. tasks pass-2 — re-upsert every task; ALL task rows now exist, so every
 *      parent that legacy actually has resolves (correct at any subtree depth; a
 *      genuinely dangling legacy parent stays NULL, faithfully). One re-pass
 *      suffices because pass-1 has already inserted every row.
 *
 * Atomic: the whole run is ONE engine.db transaction (a mid-run failure leaves
 * engine.db untouched — the inner safety net under the cutover's cold snapshot).
 *
 * Idempotent: re-running over the same legacy snapshot is convergent — every write
 * is an `ON CONFLICT DO UPDATE` upsert, and the preserved legacy timestamps (D7)
 * make a re-run land byte-identical rows (no drift to "now").
 */

export interface VerbBackfillCounts {
  workflows: number;
  triggers: number;
  tasks: number;
  /** engine.db tasks WITH a non-NULL parent link AFTER the backfill (a re-link
   *  sanity signal: 0 with subtasks present ⇒ the two-pass failed). This is the
   *  post-backfill table total, so on a flag-ON tenant it also counts any rows the
   *  live mirror wrote before the backfill — not exclusively the backfill's own
   *  re-links. */
  taskParentLinks: number;
}

/** The subset of a serialized PlannedPipeline the workflow row derives from
 *  (definition_json is stored VERBATIM; only name/goal/template are projected out). */
interface PlannedManifest { name?: unknown; goal?: unknown; template?: unknown }

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

  run(): VerbBackfillCounts {
    const counts: VerbBackfillCounts = { workflows: 0, triggers: 0, tasks: 0, taskParentLinks: 0 };
    const db = this.engineDb.getDb();

    db.transaction(() => {
      // 1 — workflows (no verb FK).
      for (const row of getAllPlannedPipelines(this.historyDb)) {
        const parsed = this._parseManifest(row.manifest_json);
        this.workflows.upsert(
          {
            id: row.id,
            name: (typeof parsed.name === 'string' && parsed.name) || row.manifest_name || row.id,
            description: typeof parsed.goal === 'string' ? parsed.goal : '',
            definitionJson: row.manifest_json, // VERBATIM — byte-identical to the live mirror's JSON.stringify(planned)
            isTemplate: parsed.template === true,
            sourceRunId: null,
          },
          { createdAt: row.started_at, updatedAt: row.started_at },
        );
        counts.workflows++;
      }

      // 2 — triggers (target_workflow_id → workflows, all now present).
      for (const rec of getAllTriggers(this.historyDb)) {
        this.triggers.upsert(triggerRecordToRow(rec), { createdAt: rec.created_at, updatedAt: rec.updated_at });
        counts.triggers++;
      }

      // 3 — tasks pass-1 (parent_task_id may NULL for a child-before-parent).
      const taskRows = getAllTasks(this.historyDb);
      for (const rec of taskRows) {
        this.tasks.upsert(taskRecordToRow(rec), { createdAt: rec.created_at, updatedAt: rec.updated_at });
        counts.tasks++;
      }
      // 4 — tasks pass-2: re-upsert so every existing legacy parent re-links.
      for (const rec of taskRows) {
        this.tasks.upsert(taskRecordToRow(rec), { createdAt: rec.created_at, updatedAt: rec.updated_at });
      }
    })();

    counts.taskParentLinks =
      (db.prepare('SELECT COUNT(*) n FROM tasks WHERE parent_task_id IS NOT NULL').get() as { n: number }).n;
    return counts;
  }

  private _parseManifest(raw: string): PlannedManifest {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as PlannedManifest) : {};
    } catch {
      return {};
    }
  }
}
