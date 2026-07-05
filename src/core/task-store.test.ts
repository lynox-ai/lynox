import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { TaskStore, taskRecordToRow, type TaskRow } from './task-store.js';
import { SubjectStore } from './subject-store.js';
import type { TaskRecord } from '../types/pipeline.js';

describe('TaskStore (Foundation Rework v2 — S3c)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];

  function make(key = ''): { store: TaskStore; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-tsk-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    engines.push(engine);
    return { store: new TaskStore(engine), engine };
  }

  /** Seed a triggers row so a task's due_trigger_id FK can resolve (minimal —
   *  title is the only NOT-NULL-without-default column). */
  function seedTrigger(engine: EngineDb, id: string): void {
    engine.getDb().prepare("INSERT INTO triggers (id, title) VALUES (?, 'T')").run(id);
  }

  function baseRow(over: Partial<TaskRow> = {}): TaskRow {
    return {
      id: 'k1',
      title: 'Call the accountant',
      description: 'about the Q3 filing',
      status: 'open',
      priority: 'high',
      scopeType: 'project',
      scopeId: 'proj-1',
      tags: '["finance"]',
      dueDate: '2026-07-10',
      ...over,
    };
  }

  afterEach(() => {
    // Close in afterEach (not at test-body end) so a mid-test throw still releases
    // the sqlite handle before rmSync — no leaked -wal/-shm or "database is locked".
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    engines.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('upsert → get round-trips a task', () => {
    const { store } = make();
    store.upsert(baseRow());
    const got = store.get('k1');
    expect(got?.title).toBe('Call the accountant');
    expect(got?.status).toBe('open');
    expect(got?.priority).toBe('high');
    expect(got?.scopeType).toBe('project');
    expect(got?.scopeId).toBe('proj-1');
    expect(got?.tags).toBe('["finance"]');
    expect(got?.dueDate).toBe('2026-07-10');
    expect(got?.completedAt).toBeNull();
    expect(got?.parentTaskId).toBeNull();
  });

  it('upsert ts (S3d backfill) preserves timestamps; no-ts defaults to now', () => {
    const { store, engine } = make();
    const ts = (id: string) => engine.getDb()
      .prepare('SELECT created_at, updated_at FROM tasks WHERE id = ?')
      .get(id) as { created_at: string; updated_at: string };

    store.upsert(baseRow({ id: 'bf' }), { createdAt: '2025-03-03T03:03:03Z', updatedAt: '2025-03-03T03:03:03Z' });
    expect(ts('bf')).toEqual({ created_at: '2025-03-03T03:03:03Z', updated_at: '2025-03-03T03:03:03Z' });

    store.upsert(baseRow({ id: 'nw' }));
    const now = ts('nw');
    expect(now.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(now.updated_at).toBe(now.created_at);

    // conflict paths: a no-ts re-upsert bumps updated_at to now; a with-ts re-upsert
    // restores it to the legacy ts (the backfill-idempotency path).
    store.upsert(baseRow({ id: 'bf' }));
    expect(ts('bf').updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    store.upsert(baseRow({ id: 'bf' }), { createdAt: '2025-03-03T03:03:03Z', updatedAt: '2025-03-03T03:03:03Z' });
    expect(ts('bf').updated_at).toBe('2025-03-03T03:03:03Z');
  });

  it('upsert is idempotent by id and preserves created_at across a re-projection', () => {
    const { store, engine } = make();
    store.upsert(baseRow({ title: 'v1' }));
    // Pin created_at to a sentinel BEFORE the re-projection: without it both upserts
    // land in the same wall-clock second, so a regression to INSERT OR REPLACE
    // (which re-defaults created_at) would still yield an identical timestamp and
    // the assertion could not fail — the sentinel makes it guard the invariant.
    engine.getDb().prepare("UPDATE tasks SET created_at = '2000-01-01 00:00:00' WHERE id = 'k1'").run();
    store.upsert(baseRow({ title: 'v2', status: 'completed', completedAt: '2026-07-05' }));
    const after = store.get('k1')!;
    expect(after.title).toBe('v2');
    expect(after.status).toBe('completed');
    expect(after.completedAt).toBe('2026-07-05');
    // ON CONFLICT DO UPDATE preserves created_at; INSERT OR REPLACE would re-default it.
    expect(after.createdAt).toBe('2000-01-01 00:00:00');
    expect(store.list()).toHaveLength(1);
  });

  it('FK-guard: parent_task_id is kept when the referenced parent task exists', () => {
    const { store } = make();
    store.upsert(baseRow({ id: 'parent' }));
    store.upsert(baseRow({ id: 'child', parentTaskId: 'parent' }));
    expect(store.get('child')?.parentTaskId).toBe('parent');
  });

  it('FK-guard: an orphan parent_task_id is stored NULL, not thrown (child before parent)', () => {
    const { store } = make();
    // engine.db enforces foreign_keys=ON, so a parent pointing at a not-yet-mirrored
    // task would REJECT the insert. The guard nulls it instead of throwing, so the
    // child degrades to a root task (S3d backfill re-links in dependency order).
    expect(() => store.upsert(baseRow({ id: 'child', parentTaskId: 'ghost' }))).not.toThrow();
    expect(store.get('child')?.parentTaskId).toBeNull();
  });

  it('remove deletes the task AND the explicit subtask ids (caller-driven cascade, D5)', () => {
    const { store, engine } = make();
    store.upsert(baseRow({ id: 'p1' }));
    store.upsert(baseRow({ id: 'c1', parentTaskId: 'p1' }));
    store.upsert(baseRow({ id: 'c2', parentTaskId: 'p1' }));
    store.upsert(baseRow({ id: 'unrelated' }));
    // The caller passes the LEGACY child-id set; the store deletes the row + those
    // ids explicitly (NOT by its own parent_task_id, which the FK-guard may have
    // nulled). engine.db's ON DELETE SET NULL would otherwise ORPHAN the subtasks.
    expect(store.remove('p1', ['c1', 'c2'])).toBe(true);
    expect(store.get('p1')).toBeUndefined();
    expect(store.get('c1')).toBeUndefined();
    expect(store.get('c2')).toBeUndefined();
    // no phantom orphaned subtask rows survive in engine.db
    const remaining = engine.getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    expect(remaining.n).toBe(1); // only the unrelated task
    expect(store.get('unrelated')?.id).toBe('unrelated'); // the RIGHT row survived, not just some row
    expect(store.remove('')).toBe(false); // empty-id no-op
  });

  it('remove without child ids deletes only the row (cascade is caller-driven)', () => {
    const { store } = make();
    store.upsert(baseRow({ id: 'solo' }));
    expect(store.remove('solo')).toBe(true);
    expect(store.get('solo')).toBeUndefined();
    expect(store.remove('solo')).toBe(false);        // already gone → changes==0
    expect(store.remove('never-existed')).toBe(false); // absent id → false, not throw
  });

  it('list orders most-recently-touched first (updated_at DESC)', () => {
    const { store, engine } = make();
    store.upsert(baseRow({ id: 'a' }));
    store.upsert(baseRow({ id: 'b' }));
    // Force a distinct updated_at (via the shared connection) so it isn't a tie.
    engine.getDb().prepare("UPDATE tasks SET updated_at = datetime('now','+1 second') WHERE id = 'a'").run();
    expect(store.list().map(t => t.id)).toEqual(['a', 'b']);
  });

  it('re-projection does NOT clobber engine.db-only columns the mirror does not own', () => {
    const { store, engine } = make();
    store.upsert(baseRow());
    // Simulate a later slice (S3-behaviour/S4) populating a column S3c does not
    // write: due_trigger_id (FK → triggers) is unowned by the task mirror.
    seedTrigger(engine, 'trg-1');
    engine.getDb().prepare("UPDATE tasks SET due_trigger_id = 'trg-1' WHERE id = 'k1'").run();
    store.upsert(baseRow({ title: 'changed' }));
    const raw = engine.getDb().prepare("SELECT due_trigger_id FROM tasks WHERE id = 'k1'").get() as { due_trigger_id: string | null };
    expect(raw.due_trigger_id).toBe('trg-1'); // untouched by the mirror upsert
  });

  it('a mapped legacy assignee never lands in engine.db (no string assignee column)', () => {
    const { store, engine } = make();
    store.upsert(taskRecordToRow(rec({ assignee: 'Britta' })));
    const raw = engine.getDb().prepare(
      "SELECT assignee_subject_id FROM tasks WHERE id = 'k1'",
    ).get() as { assignee_subject_id: string | null };
    expect(raw.assignee_subject_id).toBeNull(); // assignee dropped; subject-linking is S4
  });

  it('listBySubjectId returns a subject\'s tasks, newest-updated first; others excluded (R2b)', () => {
    const { store, engine } = make();
    const subs = new SubjectStore(engine);
    const anna = subs.findOrCreate({ kind: 'person', name: 'Anna' }).id;
    const ben = subs.findOrCreate({ kind: 'person', name: 'Ben' }).id;
    // Direct seed of the assignee link + explicit updated_at for deterministic order
    // (the S4a assignee↔subject resolution path is covered by its own suite).
    const ins = engine.getDb().prepare(
      'INSERT INTO tasks (id, title, assignee_subject_id, updated_at) VALUES (?, ?, ?, ?)',
    );
    ins.run('t-old', 'older', anna, '2026-01-01');
    ins.run('t-new', 'newer', anna, '2026-03-01');
    ins.run('t-ben', 'bens', ben, '2026-02-01');

    expect(store.listBySubjectId(anna).map(t => t.id)).toEqual(['t-new', 't-old']);
    expect(store.listBySubjectId(ben).map(t => t.id)).toEqual(['t-ben']);
    expect(store.listBySubjectId('subj-nobody')).toEqual([]);
  });
});

/** Legacy TaskRecord fixture (history.db row shape). */
function rec(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'k1', title: 'K', description: 'd', status: 'open', priority: 'medium',
    assignee: null, scope_type: 'project', scope_id: 'proj-1',
    due_date: null, tags: null, parent_task_id: null,
    created_at: 'now', updated_at: 'now', completed_at: null,
    ...over,
  };
}

describe('taskRecordToRow (legacy → engine.db mapping)', () => {
  it('maps a task faithfully (status/priority/scope/tags/due/parent/completed)', () => {
    const row = taskRecordToRow(rec({
      status: 'in_progress', priority: 'urgent', tags: '["a","b"]',
      due_date: '2026-08-01', parent_task_id: 'p9', completed_at: '2026-08-02',
    }));
    expect(row.status).toBe('in_progress');
    expect(row.priority).toBe('urgent');
    expect(row.scopeType).toBe('project');
    expect(row.scopeId).toBe('proj-1');
    expect(row.tags).toBe('["a","b"]');
    expect(row.dueDate).toBe('2026-08-01');
    expect(row.parentTaskId).toBe('p9'); // raw candidate; FK-guard is in upsert
    expect(row.completedAt).toBe('2026-08-02');
  });

  it('carries the free-text assignee (S4a: resolved by upsert when managed)', () => {
    expect(taskRecordToRow(rec({ assignee: 'someone' })).assignee).toBe('someone');
    expect(taskRecordToRow(rec({ assignee: null })).assignee).toBeNull();
  });

  it('absent optionals map to null (tags/due_date/parent/completed)', () => {
    const row = taskRecordToRow(rec({}));
    expect(row.tags).toBeNull();
    expect(row.dueDate).toBeNull();
    expect(row.parentTaskId).toBeNull();
    expect(row.completedAt).toBeNull();
  });
});

/**
 * S4a — the task read-cutover + assignee↔subject resolution. Verifies the write-side
 * (`manageAssignee`) resolution, the reverse `taskDbRowToRecord` synthesis, and that
 * the record-returning query methods match the legacy `persistence.*` semantics.
 */
describe('TaskStore S4a — assignee↔subject resolution + record reads', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];

  function make(): { store: TaskStore; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-tsk4-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    return { store: new TaskStore(engine), engine };
  }

  function row(over: Partial<TaskRow> = {}): TaskRow {
    return {
      id: 't1', title: 'Task', description: '', status: 'open', priority: 'medium',
      scopeType: 'project', scopeId: 'p1', dueDate: '2026-07-10', ...over,
    };
  }

  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    engines.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("manageAssignee resolves 'user' → the reserved self-person; read synthesizes 'user' back", () => {
    const { store, engine } = make();
    store.upsert(row({ id: 't1', assignee: 'user' }), undefined, { manageAssignee: true });
    const selves = engine.getDb().prepare(
      "SELECT id, name FROM subjects WHERE is_self = 1 AND kind = 'person'",
    ).all() as Array<{ id: string; name: string }>;
    expect(selves).toHaveLength(1);
    expect(store.getRecord('t1')?.assignee).toBe('user');
  });

  it('manageAssignee resolves a named assignee → a person subject; read synthesizes the name', () => {
    const { store, engine } = make();
    store.upsert(row({ id: 't1', assignee: 'Sarah' }), undefined, { manageAssignee: true });
    const people = engine.getDb().prepare(
      "SELECT name FROM subjects WHERE kind = 'person' AND is_self = 0",
    ).all() as Array<{ name: string }>;
    expect(people.map(p => p.name)).toEqual(['Sarah']);
    expect(store.getRecord('t1')?.assignee).toBe('Sarah');
  });

  it('the self-person is a singleton across many user-assigned tasks', () => {
    const { store, engine } = make();
    for (const id of ['a', 'b', 'c']) store.upsert(row({ id, assignee: 'user' }), undefined, { manageAssignee: true });
    const n = engine.getDb().prepare("SELECT COUNT(*) n FROM subjects WHERE is_self = 1").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('two tasks for the same named person dedupe to one subject', () => {
    const { store, engine } = make();
    store.upsert(row({ id: 'a', assignee: 'Bob' }), undefined, { manageAssignee: true });
    store.upsert(row({ id: 'b', assignee: 'Bob' }), undefined, { manageAssignee: true });
    const n = engine.getDb().prepare("SELECT COUNT(*) n FROM subjects WHERE kind='person' AND is_self=0").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('flag-OFF upsert (no manageAssignee) mints no subject + leaves assignee_subject_id NULL', () => {
    const { store, engine } = make();
    store.upsert(row({ id: 't1', assignee: 'user' }));
    const subjects = engine.getDb().prepare('SELECT COUNT(*) n FROM subjects').get() as { n: number };
    expect(subjects.n).toBe(0);
    const raw = engine.getDb().prepare("SELECT assignee_subject_id FROM tasks WHERE id='t1'").get() as { assignee_subject_id: string | null };
    expect(raw.assignee_subject_id).toBeNull();
    expect(store.getRecord('t1')?.assignee).toBeNull();
  });

  it('clearing an assignee (managed) propagates: re-upsert with null nulls the FK', () => {
    const { store, engine } = make();
    store.upsert(row({ id: 't1', assignee: 'Sarah' }), undefined, { manageAssignee: true });
    expect(store.getRecord('t1')?.assignee).toBe('Sarah');
    store.upsert(row({ id: 't1', assignee: null }), undefined, { manageAssignee: true });
    const raw = engine.getDb().prepare("SELECT assignee_subject_id FROM tasks WHERE id='t1'").get() as { assignee_subject_id: string | null };
    expect(raw.assignee_subject_id).toBeNull();
    expect(store.getRecord('t1')?.assignee).toBeNull();
  });

  it('a flag-OFF re-upsert PRESERVES a previously-resolved assignee link (no clobber)', () => {
    const { store, engine } = make();
    store.upsert(row({ id: 't1', assignee: 'Sarah', status: 'open' }), undefined, { manageAssignee: true });
    const resolvedId = (engine.getDb().prepare("SELECT assignee_subject_id sid FROM tasks WHERE id='t1'").get() as { sid: string }).sid;
    expect(resolvedId).not.toBeNull();
    // A later write with the flag OFF (manageAssignee absent) must NOT wipe the link.
    store.upsert(row({ id: 't1', assignee: 'Sarah', status: 'in_progress' }));
    const after = engine.getDb().prepare("SELECT assignee_subject_id sid, status FROM tasks WHERE id='t1'").get() as { sid: string; status: string };
    expect(after.sid).toBe(resolvedId);
    expect(after.status).toBe('in_progress');
  });

  it('listRecords assignee filter resolves the name → only that person\'s tasks', () => {
    const { store } = make();
    store.upsert(row({ id: 'a', assignee: 'Sarah' }), undefined, { manageAssignee: true });
    store.upsert(row({ id: 'b', assignee: 'Bob' }), undefined, { manageAssignee: true });
    store.upsert(row({ id: 'c', assignee: 'user' }), undefined, { manageAssignee: true });
    expect(store.listRecords({ assignee: 'Sarah' }).map(t => t.id)).toEqual(['a']);
    expect(store.listRecords({ assignee: 'user' }).map(t => t.id)).toEqual(['c']);
  });

  it('listRecords assignee filter for a non-existent assignee → no rows (legacy string-miss)', () => {
    const { store } = make();
    store.upsert(row({ id: 'a', assignee: 'Sarah' }), undefined, { manageAssignee: true });
    expect(store.listRecords({ assignee: 'Nobody' })).toEqual([]);
    expect(store.listRecords({ assignee: 'user' })).toEqual([]); // self-person never seeded
  });

  it('listRecords parentTaskId=null returns roots only (the IS NULL branch)', () => {
    const { store } = make();
    store.upsert(row({ id: 'parent' }), undefined, { manageAssignee: true });
    store.upsert(row({ id: 'child', parentTaskId: 'parent' }), undefined, { manageAssignee: true });
    expect(store.listRecords({ parentTaskId: null }).map(t => t.id)).toEqual(['parent']);
    expect(store.listRecords({ parentTaskId: 'parent' }).map(t => t.id)).toEqual(['child']);
  });

  it('listRecords orders by priority, then due_date NULLS LAST (within a priority), then created_at DESC', () => {
    const { store } = make();
    store.upsert(row({ id: 'lo', priority: 'low', dueDate: '2099-07-01' }), undefined, { manageAssignee: true });
    store.upsert(row({ id: 'urg', priority: 'urgent', dueDate: '2099-07-20' }), undefined, { manageAssignee: true });
    store.upsert(row({ id: 'hi-null', priority: 'high', dueDate: null }), undefined, { manageAssignee: true });
    store.upsert(row({ id: 'hi-dated', priority: 'high', dueDate: '2099-07-05' }), undefined, { manageAssignee: true });
    // urgent first; within high, the dated row precedes the null-due one (NULLS LAST); low last.
    expect(store.listRecords().map(t => t.id)).toEqual(['urg', 'hi-dated', 'hi-null', 'lo']);
  });

  it('dueInRange excludes completed + honors the window; overdue is < today, not completed', () => {
    // Far-future dates so the "not overdue" rows never drift into overdue() as time passes.
    const { store } = make();
    store.upsert(row({ id: 'in', dueDate: '2099-07-15', status: 'open' }), undefined, { manageAssignee: true });
    store.upsert(row({ id: 'out', dueDate: '2099-09-01', status: 'open' }), undefined, { manageAssignee: true });
    store.upsert(row({ id: 'done', dueDate: '2099-07-16', status: 'completed' }), undefined, { manageAssignee: true });
    store.upsert(row({ id: 'past', dueDate: '2000-01-01', status: 'open' }), undefined, { manageAssignee: true });
    expect(store.dueInRange('2099-07-01', '2099-07-31').map(t => t.id)).toEqual(['in']);
    expect(store.overdue().map(t => t.id)).toEqual(['past']);
  });

  it('getRecord matches by exact id or prefix, honoring a scope filter', () => {
    const { store } = make();
    store.upsert(row({ id: 'task-abc', scopeType: 'project', scopeId: 'p1' }), undefined, { manageAssignee: true });
    expect(store.getRecord('task-abc')?.id).toBe('task-abc');
    expect(store.getRecord('task-')?.id).toBe('task-abc'); // prefix
    expect(store.getRecord('task-abc', { scopeFilter: [{ type: 'project', id: 'other' }] })).toBeUndefined();
  });

  it('getRecord escapes LIKE wildcards in the id prefix (no over-match)', () => {
    const { store } = make();
    store.upsert(row({ id: 'jobX42', scopeType: 'project', scopeId: 'p1' }), undefined, { manageAssignee: true });
    store.upsert(row({ id: 'job_99', scopeType: 'project', scopeId: 'p1' }), undefined, { manageAssignee: true });

    // Adversarial: `_` must be a LITERAL, not a single-char wildcard. Pre-fix the
    // bare `${id}%` made `job_` match `jobX42` (`_`→`X`); escaped it matches only
    // ids that literally begin `job_`, i.e. `job_99` — never `jobX42`.
    expect(store.getRecord('job_')?.id).toBe('job_99');

    // Adversarial: a lone `%` must not match every row. Pre-fix `LIKE '%%'`
    // returned an arbitrary task; escaped, no id begins with a literal `%`.
    expect(store.getRecord('%')).toBeUndefined();

    // Adversarial: an empty id makes `likePrefix('')` = `'%'` (matches all rows) —
    // the guard must short-circuit to undefined, not return an arbitrary task.
    expect(store.getRecord('')).toBeUndefined();

    // Regression: a legitimate literal prefix (including the `_` char) still hits.
    expect(store.getRecord('job_9')?.id).toBe('job_99');
  });
});
