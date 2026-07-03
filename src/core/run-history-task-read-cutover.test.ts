import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import * as persistence from './run-history-persistence.js';
import type { TaskRecord } from '../types/pipeline.js';

/**
 * S4a — the task READ-cutover. When `subject_graph_enabled` is ON, RunHistory's task
 * reads flip from legacy history.db to the engine.db `TaskStore`, and the mirror
 * resolves each task's free-text `assignee` to an `assignee_subject_id` subject FK.
 * These tests prove the engine.db read is EQUIVALENT to the legacy read (the whole
 * consumer surface keeps working off `TaskRecord.assignee`), and that flag-OFF stays
 * on legacy + mints no subjects.
 */
describe('RunHistory S4a — task read-cutover', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  function make(flagOn: boolean): { history: RunHistory; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-trc-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), 'vk');
    const engine = new EngineDb(join(dir, 'engine.db'), 'vk');
    history.setVerbGraph(engine, flagOn);
    histories.push(history);
    engines.push(engine);
    return { history, engine };
  }

  const task = (over: Partial<{ id: string; title: string; assignee: string; dueDate: string; status: string; priority: string }> = {}) => ({
    id: over.id ?? 't1',
    title: over.title ?? 'Task',
    description: '',
    status: over.status ?? 'open',
    priority: over.priority ?? 'medium',
    assignee: over.assignee,
    scopeType: 'project',
    scopeId: 'p1',
    dueDate: over.dueDate ?? '2026-07-10',
    tags: '[]',
  });

  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const h of histories) { try { h.close(); } catch { /* already closed */ } }
    engines.length = 0;
    histories.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('flag-ON: getTask reads engine.db + synthesizes the assignee back', () => {
    const { history, engine } = make(true);
    history.insertTask(task({ id: 'a', assignee: 'user' }));
    history.insertTask(task({ id: 'b', assignee: 'Sarah' }));
    history.insertTask(task({ id: 'c' })); // unassigned

    expect(history.getTask('a')?.assignee).toBe('user');
    expect(history.getTask('b')?.assignee).toBe('Sarah');
    expect(history.getTask('c')?.assignee).toBeNull();
    // proof the read is engine.db-backed: the subjects were minted there
    const n = engine.getDb().prepare("SELECT COUNT(*) n FROM subjects WHERE kind='person'").get() as { n: number };
    expect(n.n).toBe(2); // self-person + Sarah
  });

  it('flag-ON: getTasks / getOverdueTasks / getTasksDueInRange are engine.db-backed', () => {
    const { history } = make(true);
    history.insertTask(task({ id: 'due', assignee: 'user', dueDate: '2099-07-15' })); // far-future: never drifts overdue
    history.insertTask(task({ id: 'over', assignee: 'Sarah', dueDate: '2000-01-01' }));

    expect(history.getTasks({ assignee: 'user' }).map(t => t.id)).toEqual(['due']);
    expect(history.getTasks({ assignee: 'Sarah' }).map(t => t.id)).toEqual(['over']);
    expect(history.getOverdueTasks().map(t => t.id)).toEqual(['over']);
    expect(history.getTasksDueInRange('2099-07-01', '2099-07-31').map(t => t.id)).toEqual(['due']);
  });

  it('flag-ON: updateTask re-resolves a changed assignee', () => {
    const { history } = make(true);
    history.insertTask(task({ id: 'a', assignee: 'user' }));
    expect(history.getTask('a')?.assignee).toBe('user');
    history.updateTask('a', { assignee: 'Bob' });
    expect(history.getTask('a')?.assignee).toBe('Bob');
    history.updateTask('a', { assignee: '' }); // clear
    expect(history.getTask('a')?.assignee).toBeNull();
  });

  it('flag-OFF: reads stay on legacy + the mirror mints no subjects', () => {
    const { history, engine } = make(false);
    history.insertTask(task({ id: 'a', assignee: 'user' }));
    history.insertTask(task({ id: 'b', assignee: 'Sarah' }));
    // legacy read still returns the raw assignee
    expect(history.getTask('a')?.assignee).toBe('user');
    expect(history.getTask('b')?.assignee).toBe('Sarah');
    // but engine.db stayed subject-free + the mirror link is NULL
    const subjects = engine.getDb().prepare('SELECT COUNT(*) n FROM subjects').get() as { n: number };
    expect(subjects.n).toBe(0);
    const raw = engine.getDb().prepare("SELECT assignee_subject_id sid FROM tasks WHERE id='a'").get() as { sid: string | null };
    expect(raw.sid).toBeNull();
  });

  it('flag-ON and flag-OFF reads AGREE on assignee (read-equivalence)', () => {
    const on = make(true);
    const off = make(false);
    for (const a of ['user', 'Sarah', undefined]) {
      const id = `t-${a ?? 'none'}`;
      on.history.insertTask(task({ id, assignee: a }));
      off.history.insertTask(task({ id, assignee: a }));
      expect(on.history.getTask(id)?.assignee).toBe(off.history.getTask(id)?.assignee ?? null);
    }
  });
});

/**
 * DIFFERENTIAL read-equivalence: the strongest proof of the cutover. The SAME seeded
 * data is read via BOTH the legacy `persistence.*` (history.db) and the engine.db
 * `TaskStore` (through flag-ON RunHistory), and the projections must match — same
 * rows, same order, same synthesized assignee — across the filter/range matrix. Rows
 * carry DISTINCT (priority, due_date) so ORDER BY is fully determined without leaning
 * on the `created_at` tiebreak (whose value differs: the live mirror stamps now(),
 * not the legacy timestamp — the ORDER of same-key rows is the only thing that must
 * agree, and distinct keys make it deterministic).
 */
describe('RunHistory S4a — differential legacy-vs-engine read-equivalence', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  function make(): { history: RunHistory; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-diff-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), 'vk');
    const engine = new EngineDb(join(dir, 'engine.db'), 'vk');
    history.setVerbGraph(engine, true); // flag-ON: reads route to engine.db
    histories.push(history);
    engines.push(engine);
    return { history, engine };
  }

  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const h of histories) { try { h.close(); } catch { /* already closed */ } }
    engines.length = 0; histories.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  /** Compare the fields that must be equivalent (skip created_at/updated_at — the
   *  mirror stamps its own now(); order is asserted separately by the row sequence). */
  const project = (t: TaskRecord) => ({
    id: t.id, title: t.title, status: t.status, priority: t.priority, assignee: t.assignee,
    scope_type: t.scope_type, scope_id: t.scope_id, due_date: t.due_date, tags: t.tags,
    parent_task_id: t.parent_task_id, completed_at: t.completed_at,
  });
  const proj = (ts: TaskRecord[]) => ts.map(project);

  it('getTasks / dueInRange / overdue match legacy across the filter matrix', () => {
    const { history } = make();
    // distinct (priority, due_date) → deterministic order; mixed assignee + scope + status.
    history.insertTask({ id: 'a', title: 'A', priority: 'urgent', dueDate: '2026-07-05', assignee: 'user', scopeType: 'project', scopeId: 'p1', status: 'open', tags: '[]' });
    history.insertTask({ id: 'b', title: 'B', priority: 'high',   dueDate: '2026-07-10', assignee: 'Sarah', scopeType: 'project', scopeId: 'p1', status: 'open', tags: '[]' });
    history.insertTask({ id: 'c', title: 'C', priority: 'medium', dueDate: '2026-07-15', scopeType: 'project', scopeId: 'p2', status: 'in_progress', tags: '[]' });
    history.insertTask({ id: 'd', title: 'D', priority: 'low',    dueDate: '2000-01-01', assignee: 'user', scopeType: 'client', scopeId: 'c1', status: 'open', tags: '[]' });
    history.insertTask({ id: 'e', title: 'E', priority: 'high',   dueDate: '2026-07-20', assignee: 'Sarah', scopeType: 'project', scopeId: 'p1', status: 'completed', tags: '[]' });
    history.insertTask({ id: 'f', title: 'F (subtask)', priority: 'medium', dueDate: '2026-07-25', scopeType: 'project', scopeId: 'p1', status: 'open', parentTaskId: 'b', tags: '[]' });

    const db = history.getDb();
    const scenarios: Array<Parameters<RunHistory['getTasks']>[0]> = [
      undefined,
      { status: 'open' },
      { scopeType: 'project', scopeId: 'p1' },
      { assignee: 'user' },
      { assignee: 'Sarah' },
      { assignee: 'Nobody' },      // non-existent → both empty
      { parentTaskId: 'b' },
      { limit: 2 },
    ];
    for (const opts of scenarios) {
      expect(proj(history.getTasks(opts))).toEqual(proj(persistence.getTasks(db, opts)));
    }

    // range + overdue, with + without scope filter
    expect(proj(history.getTasksDueInRange('2026-07-01', '2026-07-31')))
      .toEqual(proj(persistence.getTasksDueInRange(db, '2026-07-01', '2026-07-31')));
    expect(proj(history.getTasksDueInRange('2026-07-01', '2026-07-31', [{ type: 'project', id: 'p1' }])))
      .toEqual(proj(persistence.getTasksDueInRange(db, '2026-07-01', '2026-07-31', [{ type: 'project', id: 'p1' }])));
    expect(proj(history.getOverdueTasks())).toEqual(proj(persistence.getOverdueTasks(db)));
    expect(proj(history.getOverdueTasks([{ type: 'client', id: 'c1' }])))
      .toEqual(proj(persistence.getOverdueTasks(db, [{ type: 'client', id: 'c1' }])));

    // getTask by exact id + prefix
    expect(project(history.getTask('a')!)).toEqual(project(persistence.getTask(db, 'a')!));
  });
});
