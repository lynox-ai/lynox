import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import { TaskStore, taskRecordToRow } from './task-store.js';
import { getAllTasks } from './run-history-persistence.js';

/**
 * Foundation Rework v2 — the verb-layer TASK backfill.
 *
 * Replays the legacy history.db user-TASK rows into the engine.db verb-graph so a
 * tenant's task history is present in engine.db. Tasks are the ONE verb primitive
 * still legacy-authoritative + mirrored after the S3f write-cutover — their legacy
 * free-text `assignee` has no engine.db home until subjects exist (S4). Workflows +
 * triggers already cut over to engine.db-direct writes (S3f) and their legacy
 * storage was dropped in mig v44, so there is nothing left to backfill for them.
 * (The PRE-S3f full three-type backfill lives in the v1.22.0 image, which the
 * per-tenant deploy playbook runs BEFORE cutting over.)
 *
 * Because this reads ONLY the legacy `tasks` table — which v44 never touches — it
 * is safe to run on the S3f image too (unlike the retired trigger/workflow passes,
 * whose legacy sources v44 removes).
 *
 * Reuses the SAME store primitive the live mirror uses (`taskRecordToRow` +
 * `TaskStore.upsert`) so the field mapping + FK-guards stay single-sourced. Writes
 * DIRECTLY via its own store, NOT through the `RunHistory._verbMirror` swallow-
 * wrapper, so a backfill failure surfaces (the CLI aborts) rather than degrading.
 *
 * Two-pass parent re-link (`parent_task_id` → tasks): pass-1 upserts every row (a
 * child ordered before its parent gets its link NULLed by the FK-guard); pass-2
 * re-upserts every row now that ALL exist, so every legacy parent resolves at any
 * subtree depth. One re-pass suffices because pass-1 inserted every row.
 *
 * Atomic: the whole run is ONE engine.db transaction (a mid-run failure leaves
 * engine.db untouched). Idempotent: every write is an ON CONFLICT DO UPDATE upsert,
 * and the preserved legacy timestamps make a re-run land byte-identical rows.
 */

export interface VerbBackfillCounts {
  tasks: number;
  /** engine.db tasks WITH a non-NULL parent link AFTER the backfill (a re-link
   *  sanity signal: 0 with subtasks present ⇒ the two-pass failed). Post-backfill
   *  table total, so on a mirror-ON tenant it also counts rows the live mirror
   *  wrote before the backfill — not exclusively the backfill's own re-links. */
  taskParentLinks: number;
}

export class VerbGraphBackfill {
  private readonly tasks: TaskStore;

  constructor(
    private readonly engineDb: EngineDb,
    private readonly historyDb: Database.Database,
  ) {
    this.tasks = new TaskStore(engineDb);
  }

  run(): VerbBackfillCounts {
    const counts: VerbBackfillCounts = { tasks: 0, taskParentLinks: 0 };
    const db = this.engineDb.getDb();

    db.transaction(() => {
      const taskRows = getAllTasks(this.historyDb);
      // pass-1 (parent_task_id may NULL for a child ordered before its parent).
      for (const rec of taskRows) {
        this.tasks.upsert(taskRecordToRow(rec), { createdAt: rec.created_at, updatedAt: rec.updated_at });
        counts.tasks++;
      }
      // pass-2: re-upsert so every existing legacy parent re-links.
      for (const rec of taskRows) {
        this.tasks.upsert(taskRecordToRow(rec), { createdAt: rec.created_at, updatedAt: rec.updated_at });
      }
    })();

    counts.taskParentLinks =
      (db.prepare('SELECT COUNT(*) n FROM tasks WHERE parent_task_id IS NOT NULL').get() as { n: number }).n;
    return counts;
  }
}
