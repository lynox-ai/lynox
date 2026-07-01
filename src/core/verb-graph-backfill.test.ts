import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { WorkflowStore } from './workflow-store.js';
import { TriggerStore } from './trigger-store.js';
import { TaskStore } from './task-store.js';
import { VerbGraphBackfill } from './verb-graph-backfill.js';

/**
 * S3d — the verb-layer backfill. Seeds legacy history.db verb defs with the mirror
 * OFF (the real pre-flag condition), then proves the backfill relocates them into
 * engine.db faithfully: byte-identical workflow blobs, mapped triggers/tasks,
 * FK re-link in dependency order (incl. a child ordered before its parent),
 * preserved timestamps, and idempotent re-runs.
 */
describe('VerbGraphBackfill (Foundation Rework v2 — S3d)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  /** A RunHistory + EngineDb pair with the live mirror OFF — so seeding writes
   *  ONLY the legacy rows, exactly the pre-flag state the backfill exists to fix. */
  function make(): { history: RunHistory; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s3d-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), 'vk');
    const engine = new EngineDb(join(dir, 'engine.db'), 'vk');
    histories.push(history);
    engines.push(engine);
    history.setVerbGraph(engine, false); // mirror OFF: legacy-only writes
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

  const planned = (over: Partial<{ id: string; name: string; goal: string; template: boolean }> = {}) => ({
    id: over.id ?? 'wf-1',
    name: over.name ?? 'Weekly report',
    goal: over.goal ?? 'compile + send the weekly report',
    steps: [] as unknown[],
    reasoning: 'saved from session run-x',
    estimatedCost: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    template: over.template ?? true,
  });

  const trig = (over: { id?: string; taskType?: string; scheduleCron?: string; pipelineId?: string } = {}) => ({
    id: over.id ?? 'tr-1',
    title: 'Daily report',
    status: 'open',
    scopeType: 'project',
    scopeId: '',
    taskType: over.taskType ?? 'cron',
    scheduleCron: over.scheduleCron ?? '0 9 * * *',
    nextRunAt: '2026-07-02T09:00:00Z',
    pipelineId: over.pipelineId,
    pipelineParams: '{"tone":"brief"}',
  });

  const task = (over: { id?: string; title?: string; parentTaskId?: string } = {}) => ({
    id: over.id ?? 'kk-1',
    title: over.title ?? 'Call the accountant',
    description: 'about the Q3 filing',
    status: 'open',
    priority: 'high',
    scopeType: 'project',
    scopeId: '',
    dueDate: '2026-07-10',
    tags: '["finance"]',
    parentTaskId: over.parentTaskId,
  });

  const count = (engine: EngineDb, table: 'workflows' | 'triggers' | 'tasks'): number =>
    (engine.getDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

  it('backfills all three verb types; engine.db starts empty, ends equal to legacy', () => {
    const { history, engine } = make();
    history.insertPlannedPipeline(planned({ id: 'wf-1' }));
    history.insertPlannedPipeline(planned({ id: 'wf-2', name: 'Monthly' }));
    history.insertTrigger(trig({ id: 'tr-1' }));
    history.insertTask(task({ id: 'kk-1' }));
    history.insertTask(task({ id: 'kk-2' }));

    // Pre-flag: the mirror was OFF, so engine.db is empty.
    expect(count(engine, 'workflows')).toBe(0);
    expect(count(engine, 'triggers')).toBe(0);
    expect(count(engine, 'tasks')).toBe(0);

    const res = new VerbGraphBackfill(engine, history.getDb()).run();

    expect(res).toMatchObject({ workflows: 2, triggers: 1, tasks: 2 });
    expect(count(engine, 'workflows')).toBe(2);
    expect(count(engine, 'triggers')).toBe(1);
    expect(count(engine, 'tasks')).toBe(2);
  });

  it('workflow: definition_json is byte-identical to legacy manifest_json + is_template mapped', () => {
    const { history, engine } = make();
    history.insertPlannedPipeline(planned({ id: 'wf-1', template: true }));
    new VerbGraphBackfill(engine, history.getDb()).run();

    const legacy = history.getPlannedPipeline('wf-1');
    const mirror = new WorkflowStore(engine).get('wf-1');
    expect(mirror).toBeDefined();
    expect(mirror!.definitionJson).toBe(legacy!.manifest_json); // verbatim relocation
    expect(mirror!.isTemplate).toBe(true);
    expect(mirror!.name).toBe('Weekly report');
    expect(mirror!.description).toBe('compile + send the weekly report');
  });

  it('workflow: a malformed manifest_json falls back to manifest_name; blob relocated verbatim', () => {
    const { history, engine } = make();
    history.insertPlannedPipeline(planned({ id: 'wf-bad' }));
    // Corrupt the stored manifest so _parseManifest cannot extract name/goal.
    history.getDb()
      .prepare("UPDATE pipeline_runs SET manifest_json = 'not-json{', manifest_name = 'Fallback name' WHERE id = 'wf-bad'")
      .run();

    new VerbGraphBackfill(engine, history.getDb()).run();

    const mirror = new WorkflowStore(engine).get('wf-bad');
    expect(mirror!.name).toBe('Fallback name');       // manifest_name fallback (parse failed)
    expect(mirror!.description).toBe('');              // no goal parsed
    expect(mirror!.definitionJson).toBe('not-json{');  // relocated verbatim, even if garbage
  });

  it('trigger: target_workflow_id resolves to a backfilled workflow (workflows-before-triggers)', () => {
    const { history, engine } = make();
    history.insertPlannedPipeline(planned({ id: 'wf-9' }));
    history.insertTrigger(trig({ id: 'tr-p', taskType: 'pipeline', pipelineId: 'wf-9' }));

    new VerbGraphBackfill(engine, history.getDb()).run();

    const mirror = new TriggerStore(engine).get('tr-p');
    expect(mirror).toBeDefined();
    expect(mirror!.source).toBe('pipeline');
    expect(mirror!.targetWorkflowId).toBe('wf-9'); // FK resolved (workflow backfilled first)
  });

  it('trigger: a dangling legacy pipeline_id degrades to NULL (no throw)', () => {
    const { history, engine } = make();
    history.insertTrigger(trig({ id: 'tr-x', taskType: 'pipeline', pipelineId: 'wf-missing' }));

    expect(() => new VerbGraphBackfill(engine, history.getDb()).run()).not.toThrow();
    expect(new TriggerStore(engine).get('tr-x')!.targetWorkflowId).toBeNull();
  });

  it('task: a child ordered BEFORE its parent re-links via the two-pass', () => {
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

    const child = new TaskStore(engine).get('child');
    expect(child!.parentTaskId).toBe('parent'); // resolved despite child-first order
    expect(res.taskParentLinks).toBe(1);
  });

  it('task: a grandchild chain re-links at ANY depth via the single pass-2', () => {
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
  // that test; the guard's unit behaviour is pinned in task-store.test.ts. A legacy
  // TRIGGER pipeline_id is a SOFT ref (no FK), which is the dangling case covered above.

  it('preserves legacy timestamps so the post-cutover list order survives', () => {
    const { history, engine } = make();
    history.insertPlannedPipeline(planned({ id: 'wf-1' }));
    history.insertTrigger(trig({ id: 'tr-1' }));
    history.insertTask(task({ id: 'kk-1' }));
    const hdb = history.getDb();
    hdb.prepare("UPDATE pipeline_runs SET started_at = '2025-03-03T03:03:03Z' WHERE id = 'wf-1'").run();
    hdb.prepare("UPDATE triggers SET created_at = '2025-04-04T04:04:04Z' WHERE id = 'tr-1'").run();
    hdb.prepare("UPDATE tasks SET created_at = '2025-05-05T05:05:05Z' WHERE id = 'kk-1'").run();

    new VerbGraphBackfill(engine, hdb).run();

    expect(new WorkflowStore(engine).get('wf-1')!.createdAt).toBe('2025-03-03T03:03:03Z');
    expect(new TriggerStore(engine).get('tr-1')!.createdAt).toBe('2025-04-04T04:04:04Z');
    expect(new TaskStore(engine).get('kk-1')!.createdAt).toBe('2025-05-05T05:05:05Z');
  });

  it('is idempotent: a re-run adds no duplicate rows and does NOT drift updated_at to now', () => {
    const { history, engine } = make();
    history.insertPlannedPipeline(planned({ id: 'wf-1' }));
    history.insertTrigger(trig({ id: 'tr-1' }));
    history.insertTask(task({ id: 'p' }));
    history.insertTask(task({ id: 'c', parentTaskId: 'p' }));
    // Pin a legacy started_at so the re-run's updated_at can be checked against a
    // known value — the with-ts CONFLICT path (`updated_at = excluded.updated_at`)
    // is the sole reason the ts param exists; a regression to datetime('now') would
    // drift updated_at on EVERY re-run yet leave created_at (never in the SET) intact,
    // so asserting created_at alone could not catch it.
    history.getDb().prepare("UPDATE pipeline_runs SET started_at = '2025-09-09T09:09:09Z' WHERE id = 'wf-1'").run();
    const engUpdatedAt = () => (engine.getDb()
      .prepare("SELECT updated_at FROM workflows WHERE id = 'wf-1'").get() as { updated_at: string }).updated_at;

    new VerbGraphBackfill(engine, history.getDb()).run();
    expect(engUpdatedAt()).toBe('2025-09-09T09:09:09Z'); // preserved on first apply
    const res2 = new VerbGraphBackfill(engine, history.getDb()).run();

    expect(res2).toMatchObject({ workflows: 1, triggers: 1, tasks: 2 });
    expect(count(engine, 'workflows')).toBe(1);
    expect(count(engine, 'triggers')).toBe(1);
    expect(count(engine, 'tasks')).toBe(2);
    // The re-run must NOT bump updated_at to now — it stays at the legacy ts.
    expect(engUpdatedAt()).toBe('2025-09-09T09:09:09Z');
    expect(new TaskStore(engine).get('c')!.parentTaskId).toBe('p'); // link stays resolved
  });

  it('empty legacy → zero counts, no throw', () => {
    const { history, engine } = make();
    const res = new VerbGraphBackfill(engine, history.getDb()).run();
    expect(res).toEqual({ workflows: 0, triggers: 0, tasks: 0, taskParentLinks: 0 });
  });
});
