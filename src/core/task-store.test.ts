import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { TaskStore, taskRecordToRow, type TaskRow } from './task-store.js';
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

  it('drops the free-text assignee (no engine.db string column)', () => {
    const row = taskRecordToRow(rec({ assignee: 'someone' }));
    expect('assignee' in row).toBe(false);
  });

  it('absent optionals map to null (tags/due_date/parent/completed)', () => {
    const row = taskRecordToRow(rec({}));
    expect(row.tags).toBeNull();
    expect(row.dueDate).toBeNull();
    expect(row.parentTaskId).toBeNull();
    expect(row.completedAt).toBeNull();
  });
});
