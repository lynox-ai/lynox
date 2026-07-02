import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskStore } from './task-store.js';
import { VerbGraphBackfill } from './verb-graph-backfill.js';

/**
 * The verb-layer TASK backfill. Tasks are the one verb primitive still
 * legacy-authoritative + mirrored after the S3f write-cutover (S4 cuts them over);
 * workflows + triggers already cut over and their legacy storage was dropped in mig
 * v44, so the backfill covers TASKS only. Seeds legacy history.db tasks with the
 * mirror OFF (no setVerbGraph → legacy-only writes, the real pre-mirror state),
 * then proves the backfill relocates them into engine.db faithfully: mapped rows,
 * FK re-link in dependency order (incl. a child ordered before its parent),
 * preserved timestamps, and idempotent re-runs.
 */
describe('VerbGraphBackfill — tasks (Foundation Rework v2)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  /** A RunHistory + EngineDb pair with NO task mirror (setVerbGraph never called) —
   *  so seeding writes ONLY the legacy `tasks` rows, exactly the pre-mirror state
   *  the backfill exists to relocate. */
  function make(): { history: RunHistory; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-tbf-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), 'vk');
    const engine = new EngineDb(join(dir, 'engine.db'), 'vk');
    histories.push(history);
    engines.push(engine);
    return { history, engine };
  }

  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const h of histories) { try { h.close(); } catch { /* already closed */ } }
    engines.length = 0;
    histories.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  const task = (over: { id?: string; title?: string; parentTaskId?: string; assignee?: string; tags?: string } = {}) => ({
    id: over.id ?? 'kk-1',
    title: over.title ?? 'Call the accountant',
    description: 'about the Q3 filing',
    status: 'open',
    priority: 'high',
    assignee: over.assignee,
    scopeType: 'project',
    scopeId: '',
    dueDate: '2026-07-10',
    tags: over.tags ?? '["finance"]',
    parentTaskId: over.parentTaskId,
  });

  const count = (engine: EngineDb): number =>
    (engine.getDb().prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;

  it('backfills legacy tasks; engine.db starts empty, ends equal to legacy', () => {
    const { history, engine } = make();
    history.insertTask(task({ id: 'kk-1' }));
    history.insertTask(task({ id: 'kk-2', title: 'File the return' }));

    expect(count(engine)).toBe(0); // pre-mirror: engine.db empty

    const res = new VerbGraphBackfill(engine, history.getDb()).run();

    expect(res.tasks).toBe(2);
    expect(count(engine)).toBe(2);
  });

  it('maps the row + drops the free-text assignee', () => {
    const { history, engine } = make();
    history.insertTask(task({ id: 'kk-1', assignee: 'Britta', tags: '["finance"]' }));
    new VerbGraphBackfill(engine, history.getDb()).run();

    const mirror = new TaskStore(engine).get('kk-1');
    expect(mirror).toBeDefined();
    expect(mirror!.title).toBe('Call the accountant');
    expect(mirror!.status).toBe('open');
    expect(mirror!.tags).toBe('["finance"]');
    // assignee is legacy free-text with no engine.db string column → never relocated.
    const raw = engine.getDb().prepare("SELECT assignee_subject_id FROM tasks WHERE id = 'kk-1'")
      .get() as { assignee_subject_id: string | null };
    expect(raw.assignee_subject_id).toBeNull();
  });

  it('a child ordered BEFORE its parent re-links via the two-pass', () => {
    const { history, engine } = make();
    // Seed both, then force the adversarial scan order: child.created_at < parent.created_at,
    // so getAllTasks (ORDER BY created_at ASC) returns the child first and pass-1 NULLs its
    // parent link — only the pass-2 re-upsert can resolve it.
    history.insertTask(task({ id: 'parent', title: 'Parent' }));
    history.insertTask(task({ id: 'child', parentTaskId: 'parent' }));
    const hdb = history.getDb();
    hdb.prepare("UPDATE tasks SET created_at = '2026-01-01T00:00:00Z' WHERE id = 'child'").run();
    hdb.prepare("UPDATE tasks SET created_at = '2026-06-01T00:00:00Z' WHERE id = 'parent'").run();

    const res = new VerbGraphBackfill(engine, hdb).run();

    expect(new TaskStore(engine).get('child')!.parentTaskId).toBe('parent'); // resolved despite child-first
    expect(res.taskParentLinks).toBe(1);
  });

  it('a grandchild chain re-links at ANY depth via the single pass-2', () => {
    const { history, engine } = make();
    // grandparent → parent → grandchild, seeded so the SCAN order (created_at ASC) is
    // the WORST case — grandchild first, grandparent last — so pass-1 NULLs BOTH links
    // and only pass-2 (all rows now exist) can resolve the whole chain.
    history.insertTask(task({ id: 'gp', title: 'Grandparent' }));
    history.insertTask(task({ id: 'p', title: 'Parent', parentTaskId: 'gp' }));
    history.insertTask(task({ id: 'gc', title: 'Grandchild', parentTaskId: 'p' }));
    const hdb = history.getDb();
    hdb.prepare("UPDATE tasks SET created_at = '2026-01-01T00:00:00Z' WHERE id = 'gc'").run();
    hdb.prepare("UPDATE tasks SET created_at = '2026-03-01T00:00:00Z' WHERE id = 'p'").run();
    hdb.prepare("UPDATE tasks SET created_at = '2026-06-01T00:00:00Z' WHERE id = 'gp'").run();

    const res = new VerbGraphBackfill(engine, hdb).run();

    const store = new TaskStore(engine);
    expect(store.get('gc')!.parentTaskId).toBe('p');  // grandchild → parent
    expect(store.get('p')!.parentTaskId).toBe('gp');  // parent → grandparent
    expect(store.get('gp')!.parentTaskId).toBeNull(); // root
    expect(res.taskParentLinks).toBe(2);
  });

  // NB: legacy history.db `tasks` ENFORCES the parent_task_id FK (a legacy insert of a
  // task with a non-existent parent throws), so the backfill never meets a PERMANENTLY
  // dangling parent — the two-pass above always fully resolves. The transient NULL that
  // the FK-guard produces (a child scanned before its parent in pass-1) is exercised by
  // that test; the guard's unit behaviour is pinned in task-store.test.ts.

  it('preserves legacy timestamps so the post-cutover list order survives', () => {
    const { history, engine } = make();
    history.insertTask(task({ id: 'kk-1' }));
    history.getDb().prepare("UPDATE tasks SET created_at = '2025-05-05T05:05:05Z' WHERE id = 'kk-1'").run();

    new VerbGraphBackfill(engine, history.getDb()).run();

    expect(new TaskStore(engine).get('kk-1')!.createdAt).toBe('2025-05-05T05:05:05Z');
  });

  it('is idempotent: a re-run adds no duplicate rows and does NOT drift updated_at to now', () => {
    const { history, engine } = make();
    history.insertTask(task({ id: 'p' }));
    history.insertTask(task({ id: 'c', parentTaskId: 'p' }));
    // Pin a legacy created_at so the re-run's updated_at (= the same legacy ts, via the
    // with-ts CONFLICT path `updated_at = excluded.updated_at`) can be checked against a
    // known value — a regression to datetime('now') would drift it on EVERY re-run.
    history.getDb().prepare("UPDATE tasks SET created_at = '2025-09-09T09:09:09Z', updated_at = '2025-09-09T09:09:09Z' WHERE id = 'p'").run();
    const engUpdatedAt = () => (engine.getDb()
      .prepare("SELECT updated_at FROM tasks WHERE id = 'p'").get() as { updated_at: string }).updated_at;

    new VerbGraphBackfill(engine, history.getDb()).run();
    expect(engUpdatedAt()).toBe('2025-09-09T09:09:09Z'); // preserved on first apply
    const res2 = new VerbGraphBackfill(engine, history.getDb()).run();

    expect(res2.tasks).toBe(2);
    expect(count(engine)).toBe(2);
    expect(engUpdatedAt()).toBe('2025-09-09T09:09:09Z'); // re-run does NOT bump to now
    expect(new TaskStore(engine).get('c')!.parentTaskId).toBe('p'); // link stays resolved
  });

  it('empty legacy → zero counts, no throw', () => {
    const { history, engine } = make();
    const res = new VerbGraphBackfill(engine, history.getDb()).run();
    expect(res).toEqual({ tasks: 0, taskParentLinks: 0 });
  });
});
