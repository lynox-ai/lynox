import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import type { TaskRecord } from '../types/pipeline.js';

/**
 * TaskStore — the S3c write/read layer over the engine.db `tasks` table
 * (Foundation Rework v2, verb layer). It relocates the legacy history.db `tasks`
 * row (mig v42, run-history.ts) — the human-TODO row that fires nothing — onto
 * the purpose-built engine.db `tasks` table with real FK-able links
 * (`parent_task_id` → tasks(id); `subject_id`/`assignee_subject_id` → subjects(id);
 * `due_trigger_id` → triggers(id)).
 *
 * TaskStore is still an ADDITIVE mirror behind the `RunHistory` facade: every
 * insert/update/delete of a legacy task dual-writes here (via `_reprojectTask`
 * inside the swallowing `_verbMirror`), while the legacy history.db `tasks` row
 * stays AUTHORITATIVE and task reads stay on legacy — UNTIL the S4 subject
 * resolution cuts tasks over the way S3f cut triggers + workflows. (Triggers +
 * workflows are already engine.db-direct; tasks lag because the legacy free-text
 * `assignee` has no engine.db home until subjects exist.) Unlike triggers, tasks
 * fire nothing, so there is no money-path — the mirror is pure bookkeeping.
 *
 * The engine.db `tasks` table is a REDESIGN of the legacy table, so
 * {@link taskRecordToRow} maps the legacy columns onto the engine.db shape. Most
 * columns relocate 1:1 (status/priority/scope/tags/due_date/parent/completed);
 * the legacy free-text `assignee` (`'user'`/name/null) is DROPPED — engine.db has
 * no string assignee column, only `assignee_subject_id` (a subject FK with no
 * legacy source). engine.db columns with no legacy source (`subject_id`,
 * `assignee_subject_id`, `due_trigger_id`) are left for S4/later — the mirror
 * neither writes nor clobbers them.
 *
 * Like the S3a/S3b stores the task free-text is stored PLAINTEXT — a faithful
 * relocation of the legacy plaintext columns. At-rest encryption of verb
 * free-text is a deliberate future hardening slice, NOT smuggled into the
 * relocation.
 */
export interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  scopeType?: string | null | undefined;
  scopeId?: string | null | undefined;
  tags?: string | null | undefined;
  dueDate?: string | null | undefined;
  /** Candidate self-FK → tasks(id) (legacy `parent_task_id`). {@link TaskStore.upsert}
   *  nulls it when no such parent row exists (the FK is enforced), so a child whose
   *  parent isn't mirrored yet degrades to a root task instead of throwing. */
  parentTaskId?: string | null | undefined;
  completedAt?: string | null | undefined;
}

export interface StoredTask {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  scopeType: string | null;
  scopeId: string | null;
  tags: string | null;
  dueDate: string | null;
  parentTaskId: string | null;
  completedAt: string | null;
  createdAt: string;
}

/**
 * Pure map of a legacy {@link TaskRecord} (history.db row shape) onto the engine.db
 * `tasks` shape. Faithful: status/priority/scope/tags/due_date/parent/completed
 * relocate verbatim (the engine.db columns have no CHECK). `assignee` is dropped
 * (no engine.db string column). engine.db columns with no legacy source
 * (`subject_id`, `assignee_subject_id`, `due_trigger_id`) are left unset — the
 * mirror does not own them. `parentTaskId` is the raw candidate; the FK-guard
 * lives in {@link TaskStore.upsert}.
 */
export function taskRecordToRow(rec: TaskRecord): TaskRow {
  return {
    id: rec.id,
    title: rec.title,
    description: rec.description,
    status: rec.status,
    priority: rec.priority,
    scopeType: rec.scope_type,
    scopeId: rec.scope_id,
    tags: rec.tags ?? null,
    dueDate: rec.due_date ?? null,
    parentTaskId: rec.parent_task_id ?? null,
    completedAt: rec.completed_at ?? null,
  };
}

interface TaskDbRow {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  scope_type: string | null;
  scope_id: string | null;
  tags: string | null;
  due_date: string | null;
  parent_task_id: string | null;
  completed_at: string | null;
  created_at: string;
}

export class TaskStore {
  private readonly db: Database.Database;

  constructor(engine: EngineDb) {
    this.db = engine.getDb();
  }

  /**
   * Upsert a task (INSERT-or-update by id). Uses `ON CONFLICT DO UPDATE` — NOT
   * `INSERT OR REPLACE` — so a re-projection (a) preserves `created_at` and (b)
   * does not delete+reinsert the row (which would trip the self-referential
   * `parent_task_id` ON DELETE SET NULL on any child task). Columns the mirror
   * does not own (`subject_id`/`assignee_subject_id`/`due_trigger_id`, filled by
   * S4/later) are left untouched on conflict rather than clobbered.
   *
   * FK-guards `parent_task_id`: engine.db enforces `foreign_keys = ON`, so a
   * candidate pointing at a not-yet-mirrored parent is stored NULL instead of
   * throwing — keeping the mirror non-fatal; the S3d backfill re-links it.
   *
   * `ts` (S3d backfill only) preserves the legacy timestamps; the live mirror
   * omits it → both columns resolve to `datetime('now')` via COALESCE, identical
   * to the prior behaviour. See {@link WorkflowStore.upsert} for the rationale.
   */
  upsert(row: TaskRow, ts?: { createdAt?: string | undefined; updatedAt?: string | undefined }): void {
    const parentTaskId = this._resolveParentTaskId(row.parentTaskId ?? null);
    this.db.prepare(`
      INSERT INTO tasks (
        id, title, description, status, priority, scope_type, scope_id,
        tags, due_date, parent_task_id, completed_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        scope_type = excluded.scope_type,
        scope_id = excluded.scope_id,
        tags = excluded.tags,
        due_date = excluded.due_date,
        parent_task_id = excluded.parent_task_id,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.title,
      row.description,
      row.status,
      row.priority,
      row.scopeType ?? null,
      row.scopeId ?? null,
      row.tags ?? null,
      row.dueDate ?? null,
      parentTaskId,
      row.completedAt ?? null,
      ts?.createdAt ?? null,
      ts?.updatedAt ?? null,
    );
  }

  /** Keep `parent_task_id` only if the referenced task row exists (engine.db
   *  enforces the self-FK), else NULL — so a child mirrored before its parent
   *  never throws (it degrades to a root task; S3d re-links). */
  private _resolveParentTaskId(candidate: string | null): string | null {
    if (candidate === null || candidate === '') return null;
    const hit = this.db.prepare('SELECT 1 FROM tasks WHERE id = ? LIMIT 1').get(candidate);
    return hit ? candidate : null;
  }

  /**
   * Delete a task and its direct subtasks from the mirror, matching legacy
   * `deleteTask` (which removes the row + its direct children). The engine.db
   * `parent_task_id` FK is `ON DELETE SET NULL` — relying on it would ORPHAN the
   * subtasks (a phantom a post-S3d read would surface), so we delete the subtask
   * rows explicitly.
   *
   * The subtask ids are passed IN by the caller (captured from LEGACY before its
   * cascade — see {@link RunHistory.deleteTask}), NOT recomputed from this store's
   * own `parent_task_id`: the FK-guard {@link _resolveParentTaskId} may have NULLed
   * a pre-flag orphan's parent link, so the mirror can't reliably rederive legacy's
   * cascade set. All deletes run in one transaction; returns whether the row itself
   * was deleted.
   */
  remove(id: string, childIds: readonly string[] = []): boolean {
    if (id === '') return false;
    const tx = this.db.transaction((taskId: string, kids: readonly string[]): boolean => {
      for (const kid of kids) {
        if (kid !== '') this.db.prepare('DELETE FROM tasks WHERE id = ?').run(kid);
      }
      return this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId).changes > 0;
    });
    return tx(id, childIds);
  }

  /** Read a single task by exact id (test-only in S3c — reads stay on legacy). */
  get(id: string): StoredTask | undefined {
    const row = this.db.prepare(
      `SELECT id, title, description, status, priority, scope_type, scope_id,
              tags, due_date, parent_task_id, completed_at, created_at
       FROM tasks WHERE id = ?`,
    ).get(id) as TaskDbRow | undefined;
    if (!row) return undefined;
    return this._map(row);
  }

  /** List tasks, most-recently-touched first (test-only in S3c). An `updated_at`
   *  index rides the S3d read-cutover, same follow-up as the S3a
   *  `idx_workflows_updated_at`. */
  list(limit = 100): StoredTask[] {
    const rows = this.db.prepare(
      `SELECT id, title, description, status, priority, scope_type, scope_id,
              tags, due_date, parent_task_id, completed_at, created_at
       FROM tasks ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit) as TaskDbRow[];
    return rows.map(r => this._map(r));
  }

  private _map(row: TaskDbRow): StoredTask {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      tags: row.tags,
      dueDate: row.due_date,
      parentTaskId: row.parent_task_id,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    };
  }
}
