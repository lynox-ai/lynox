import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import type { TaskRecord, TaskStatus, TaskPriority } from '../types/pipeline.js';
import { SubjectStore } from './subject-store.js';

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
  /** Legacy free-text assignee (`'user'`/a name/null). Carried through from the
   *  legacy row so {@link TaskStore.upsert} can resolve it to `assignee_subject_id`
   *  when the caller opts in (`manageAssignee`, S4a). Ignored otherwise. */
  assignee?: string | null | undefined;
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
 * relocate verbatim (the engine.db columns have no CHECK). `assignee` is CARRIED
 * (S4a) — the engine.db has no string assignee column, so {@link TaskStore.upsert}
 * resolves it to `assignee_subject_id` when told to (`manageAssignee`); a caller
 * that doesn't opt in leaves the column untouched, as before. engine.db columns
 * with no legacy source (`subject_id`, `due_trigger_id`) are left unset — the
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
    assignee: rec.assignee,
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

/**
 * The engine.db `tasks` row JOINed to its assignee subject — the input to
 * {@link taskDbRowToRecord}. `assignee_name`/`assignee_is_self` come from a
 * `LEFT JOIN subjects ON assignee_subject_id = subjects.id` (all NULL when the
 * task has no assignee). The remaining columns are the task row's own.
 */
interface TaskRecordDbRow {
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
  updated_at: string;
  assignee_subject_id: string | null;
  assignee_name: string | null;
  assignee_is_self: number | null;
}

/**
 * Pure INVERSE of {@link taskRecordToRow} (S4a): map a JOINed engine.db `tasks` row
 * onto a legacy-compatible {@link TaskRecord}, synthesizing the free-text `assignee`
 * back from the subject FK — `is_self` → `'user'`, a person → its name, no FK →
 * `null`. This keeps the whole legacy consumer surface (`formatTaskLine`, the
 * briefing, the `/api/tasks` JSON) working unchanged off `TaskRecord.assignee`,
 * while the engine.db stores the clean subject link. `scope_type`/`scope_id` map
 * `null → ''` to satisfy the non-null legacy DTO (a task always carries a scope).
 */
export function taskDbRowToRecord(row: TaskRecordDbRow): TaskRecord {
  let assignee: string | null = null;
  if (row.assignee_subject_id !== null) {
    // `assignee_name ?? null` is a safe degradation for a dangling FK (id set, JOIN
    // misses) — but that is unreachable: the FK is `ON DELETE SET NULL` (a deleted
    // subject nulls assignee_subject_id, so it wouldn't be non-null here) and
    // `subjects.name` is NOT NULL (a live subject always joins a name).
    assignee = row.assignee_is_self === 1 ? 'user' : (row.assignee_name ?? null);
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    assignee,
    scope_type: row.scope_type ?? '',
    scope_id: row.scope_id ?? '',
    due_date: row.due_date,
    tags: row.tags,
    parent_task_id: row.parent_task_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

/**
 * The task columns + LEFT-JOINed assignee subject — the SELECT that feeds
 * {@link taskDbRowToRecord}. `t` = tasks, `s` = the (optional) assignee subject.
 * Column order matches {@link TaskRecordDbRow}.
 */
const TASK_RECORD_SELECT = `
  SELECT t.id, t.title, t.description, t.status, t.priority,
         t.scope_type, t.scope_id, t.tags, t.due_date, t.parent_task_id,
         t.completed_at, t.created_at, t.updated_at, t.assignee_subject_id,
         s.name AS assignee_name, s.is_self AS assignee_is_self
  FROM tasks t LEFT JOIN subjects s ON t.assignee_subject_id = s.id`;

export class TaskStore {
  private readonly db: Database.Database;
  /** For the S4a assignee↔subject resolution (write-side create, read-filter lookup). */
  private readonly subjects: SubjectStore;

  constructor(engine: EngineDb) {
    this.db = engine.getDb();
    this.subjects = new SubjectStore(engine);
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
   *
   * `manageAssignee` (S4a, gated on `subject_graph_enabled` by the caller): resolve
   * `row.assignee` → `assignee_subject_id` (minting the self-person / a named person
   * as needed) and write it AUTHORITATIVELY — including NULL, so clearing an assignee
   * propagates. When OFF (default) the column is left exactly as before: a fresh
   * INSERT gets its DEFAULT NULL, a conflict leaves the stored value untouched (a
   * flag-OFF engine.db never mints a subject). The interpolated `ON CONFLICT` fragment
   * is a constant literal (no user input).
   */
  upsert(
    row: TaskRow,
    ts?: { createdAt?: string | undefined; updatedAt?: string | undefined },
    opts?: { manageAssignee?: boolean | undefined },
  ): void {
    const parentTaskId = this._resolveParentTaskId(row.parentTaskId ?? null);
    const manageAssignee = opts?.manageAssignee === true;
    const assigneeSubjectId = manageAssignee
      ? this.subjects.resolveAssigneeToSubjectId(row.assignee ?? null)
      : null;
    const assigneeConflictSet = manageAssignee ? 'assignee_subject_id = excluded.assignee_subject_id,\n        ' : '';
    this.db.prepare(`
      INSERT INTO tasks (
        id, title, description, status, priority, scope_type, scope_id,
        tags, due_date, parent_task_id, assignee_subject_id, completed_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
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
        ${assigneeConflictSet}completed_at = excluded.completed_at,
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
      assigneeSubjectId,
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

  // ── Record reads (S4a read-cutover; gated on subject_graph_enabled by RunHistory) ──
  //
  // Each mirrors the matching legacy `persistence.*` query byte-for-byte on filters +
  // ORDER BY, differing only where engine.db must: the string `assignee` filter is
  // RESOLVED to `assignee_subject_id`, and the assignee is synthesized back on read
  // via {@link taskDbRowToRecord} — so the returned {@link TaskRecord} is equivalent
  // to legacy's for every consumer.

  /** {@link persistence.getTask} equivalent: exact-or-prefix id + optional scope filter. */
  getRecord(id: string, opts?: { scopeFilter?: Array<{ type: string; id: string }> | undefined }): TaskRecord | undefined {
    const where: string[] = ['(t.id = ? OR t.id LIKE ?)'];
    const params: unknown[] = [id, `${id}%`];
    if (opts?.scopeFilter && opts.scopeFilter.length > 0) {
      const ors = opts.scopeFilter.map(() => '(t.scope_type = ? AND t.scope_id = ?)').join(' OR ');
      where.push(`(${ors})`);
      for (const s of opts.scopeFilter) { params.push(s.type, s.id); }
    }
    const row = this.db.prepare(`${TASK_RECORD_SELECT} WHERE ${where.join(' AND ')}`)
      .get(...params) as TaskRecordDbRow | undefined;
    return row ? taskDbRowToRecord(row) : undefined;
  }

  /** {@link persistence.getTasks} equivalent: scope/status/assignee/parent filters +
   *  the exact priority-CASE / due_date-NULLS-LAST / created_at ordering + LIMIT. A
   *  given `assignee` that resolves to no subject yields no rows (legacy string-miss). */
  listRecords(opts?: {
    scopeType?: string | undefined;
    scopeId?: string | undefined;
    status?: string | undefined;
    assignee?: string | undefined;
    parentTaskId?: string | null | undefined;
    limit?: number | undefined;
  }): TaskRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.scopeType) { where.push('t.scope_type = ?'); params.push(opts.scopeType); }
    if (opts?.scopeId) { where.push('t.scope_id = ?'); params.push(opts.scopeId); }
    if (opts?.status) { where.push('t.status = ?'); params.push(opts.status); }
    if (opts?.assignee) {
      const sid = this.subjects.resolveAssigneeFilter(opts.assignee);
      if (sid === null) return [];
      where.push('t.assignee_subject_id = ?'); params.push(sid);
    }
    if (opts?.parentTaskId !== undefined) {
      if (opts.parentTaskId === null) where.push('t.parent_task_id IS NULL');
      else { where.push('t.parent_task_id = ?'); params.push(opts.parentTaskId); }
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = opts?.limit ?? 100;
    params.push(limit);
    const rows = this.db.prepare(
      `${TASK_RECORD_SELECT} ${whereClause}
       ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
                t.due_date ASC NULLS LAST, t.created_at DESC LIMIT ?`,
    ).all(...params) as TaskRecordDbRow[];
    return rows.map(taskDbRowToRecord);
  }

  /**
   * Record-on-spine R2b: tasks assigned to a subject, resolved id-DIRECTLY (the
   * footprint reader already holds the subject_id — no name round-trip). Uses
   * `idx_tasks_assignee`; most-recently-updated first. Tasks are an ADJACENT
   * (future-tense `due_date`) footprint section, not part of the occurrence timeline.
   */
  listBySubjectId(subjectId: string, limit = 50): TaskRecord[] {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.db.prepare(
      `${TASK_RECORD_SELECT} WHERE t.assignee_subject_id = ? ORDER BY t.updated_at DESC LIMIT ?`,
    ).all(subjectId, safeLimit) as TaskRecordDbRow[];
    return rows.map(taskDbRowToRecord);
  }

  /** {@link persistence.getTasksDueInRange} equivalent. */
  dueInRange(start: string, end: string, scopes?: Array<{ type: string; id: string }> | undefined): TaskRecord[] {
    const where: string[] = ["t.due_date >= ? AND t.due_date <= ? AND t.status != 'completed'"];
    const params: unknown[] = [start, end];
    if (scopes && scopes.length > 0) {
      const ors = scopes.map(() => '(t.scope_type = ? AND t.scope_id = ?)').join(' OR ');
      where.push(`(${ors})`);
      for (const s of scopes) { params.push(s.type, s.id); }
    }
    const rows = this.db.prepare(
      `${TASK_RECORD_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.due_date ASC, t.priority ASC`,
    ).all(...params) as TaskRecordDbRow[];
    return rows.map(taskDbRowToRecord);
  }

  /** {@link persistence.getOverdueTasks} equivalent (today = `toISOString().slice(0,10)`, as legacy). */
  overdue(scopes?: Array<{ type: string; id: string }> | undefined): TaskRecord[] {
    const now = new Date().toISOString().slice(0, 10);
    const where: string[] = ["t.due_date < ? AND t.status != 'completed'"];
    const params: unknown[] = [now];
    if (scopes && scopes.length > 0) {
      const ors = scopes.map(() => '(t.scope_type = ? AND t.scope_id = ?)').join(' OR ');
      where.push(`(${ors})`);
      for (const s of scopes) { params.push(s.type, s.id); }
    }
    const rows = this.db.prepare(
      `${TASK_RECORD_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.due_date ASC`,
    ).all(...params) as TaskRecordDbRow[];
    return rows.map(taskDbRowToRecord);
  }
}
