import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { WorkflowStore } from './workflow-store.js';
import { TriggerStore } from './trigger-store.js';
import { TaskStore } from './task-store.js';

/**
 * S3a — the RunHistory → engine.db workflow-definition dual-write mirror. Proves:
 * flag OFF is inert, flag ON dual-writes with a real is_template column, and a
 * mirror failure never breaks the authoritative legacy history.db write.
 */
describe('RunHistory verb-graph mirror (Foundation Rework v2 — S3a)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  function make(enabled: boolean, key = ''): { history: RunHistory; engine: EngineDb; reader: WorkflowStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-vm-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), key);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    histories.push(history);
    engines.push(engine);
    history.setVerbGraph(engine, enabled);
    return { history, engine, reader: new WorkflowStore(engine) };
  }

  afterEach(() => {
    // Close in afterEach so a mid-test throw still releases both handles.
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
    steps: [],
    reasoning: 'saved from session run-x',
    estimatedCost: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    template: over.template ?? true,
  });

  it('flag OFF → legacy write only, NO engine.db row', () => {
    const { history, engine, reader } = make(false);
    history.insertPlannedPipeline(planned());
    expect(history.getPlannedPipeline('wf-1')).toBeDefined(); // legacy authoritative
    expect(reader.get('wf-1')).toBeUndefined();               // mirror inert
    engine.close();
    history.close();
  });

  it('flag ON → dual-write; engine.db carries is_template + the same definition blob', () => {
    const { history, engine, reader } = make(true, 'vault-key');
    history.insertPlannedPipeline(planned({ template: true }));
    const legacy = history.getPlannedPipeline('wf-1');
    const mirror = reader.get('wf-1');
    expect(mirror).toBeDefined();
    expect(mirror!.isTemplate).toBe(true);
    // The mirrored definition blob equals the legacy manifest_json byte-for-byte
    // (same object → same JSON.stringify), and survives the enc()/dec() round-trip.
    expect(mirror!.definitionJson).toBe(legacy!.manifest_json);
    engine.close();
    history.close();
  });

  it('flag ON → is_template=false for a one-shot plan', () => {
    const { history, engine, reader } = make(true);
    history.insertPlannedPipeline(planned({ template: false }));
    expect(reader.get('wf-1')!.isTemplate).toBe(false);
    engine.close();
    history.close();
  });

  it('flag ON → rename propagates to the mirror', () => {
    const { history, engine, reader } = make(true, 'k');
    history.insertPlannedPipeline(planned({ name: 'Old' }));
    history.renamePlannedPipeline('wf-1', 'New');
    expect(reader.get('wf-1')!.name).toBe('New');
    expect((JSON.parse(reader.get('wf-1')!.definitionJson) as { name: string }).name).toBe('New');
    engine.close();
    history.close();
  });

  it('flag ON → delete removes the mirror row', () => {
    const { history, engine, reader } = make(true);
    history.insertPlannedPipeline(planned());
    history.deletePlannedPipeline('wf-1');
    expect(reader.get('wf-1')).toBeUndefined();
    engine.close();
    history.close();
  });

  it('flag ON → markPipelineExecuted drops the one-shot def from the mirror', () => {
    const { history, engine, reader } = make(true);
    history.insertPlannedPipeline(planned({ template: false }));
    history.markPipelineExecuted('wf-1');
    expect(reader.get('wf-1')).toBeUndefined();
    engine.close();
    history.close();
  });

  it('flag ON → setWorkflowConfirmedAt stamps the mirror blob', () => {
    const { history, engine, reader } = make(true, 'k');
    history.insertPlannedPipeline(planned());
    history.setWorkflowConfirmedAt('wf-1', '2026-07-01T12:00:00Z');
    expect((JSON.parse(reader.get('wf-1')!.definitionJson) as { confirmedAt: string }).confirmedAt)
      .toBe('2026-07-01T12:00:00Z');
    engine.close();
    history.close();
  });

  it('mirror failure is isolated — a closed engine.db never breaks the legacy write', () => {
    const { history, engine } = make(true);
    engine.close(); // every subsequent WorkflowStore op now throws
    // legacy write must still succeed, no throw propagates
    expect(() => history.insertPlannedPipeline(planned())).not.toThrow();
    expect(history.getPlannedPipeline('wf-1')).toBeDefined();
    history.close();
  });

  it('setVerbGraph(false) after ON reverts to legacy-only', () => {
    const { history, engine, reader } = make(true);
    history.setVerbGraph(engine, false);
    history.insertPlannedPipeline(planned());
    expect(history.getPlannedPipeline('wf-1')).toBeDefined();
    expect(reader.get('wf-1')).toBeUndefined();
    engine.close();
    history.close();
  });
});

/**
 * S3b — the RunHistory → engine.db TRIGGER dual-write mirror. The engine.db
 * `triggers` table is a REDESIGN (not a 1:1 of legacy), so each write re-projects
 * the full mapped legacy row. Proves: flag OFF inert, flag ON re-projects every
 * write path (insert/update/setEnabled/runResult/watchConfig/delete), the FK-guard
 * resolves/nulls target_workflow_id, and a mirror failure never breaks the legacy
 * write or (by extension) the WorkerLoop money-path that reads the legacy row.
 */
describe('RunHistory verb-graph mirror — triggers (Foundation Rework v2 — S3b)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  function make(enabled: boolean, key = ''): { history: RunHistory; engine: EngineDb; reader: TriggerStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-tvm-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), key);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    histories.push(history);
    engines.push(engine);
    history.setVerbGraph(engine, enabled);
    return { history, engine, reader: new TriggerStore(engine) };
  }

  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const h of histories) { try { h.close(); } catch { /* already closed */ } }
    engines.length = 0;
    histories.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function trig(over: {
    id?: string; title?: string; taskType?: string; scheduleCron?: string;
    nextRunAt?: string; pipelineId?: string; pipelineParams?: string; watchConfig?: string;
  } = {}) {
    return {
      id: over.id ?? 'tr-1',
      title: over.title ?? 'Daily report',
      status: 'open',
      scopeType: 'project',
      scopeId: '',
      taskType: over.taskType ?? 'cron',
      scheduleCron: over.scheduleCron ?? '0 9 * * *',
      nextRunAt: over.nextRunAt ?? '2026-07-02T09:00:00Z',
      pipelineId: over.pipelineId,
      pipelineParams: over.pipelineParams ?? '{"tone":"brief"}',
      watchConfig: over.watchConfig,
    };
  }

  /** Mirror a workflow into engine.db so a trigger's target_workflow_id FK resolves. */
  function seedMirroredWorkflow(history: RunHistory, id: string): void {
    history.insertPlannedPipeline({
      id, name: 'W', goal: 'g', steps: [], reasoning: 'r',
      estimatedCost: 0, createdAt: '2026-07-01T00:00:00.000Z', template: true,
    });
  }

  it('flag OFF → legacy trigger write only, NO engine.db row', () => {
    const { history, engine, reader } = make(false);
    history.insertTrigger(trig());
    expect(history.getTrigger('tr-1')).toBeDefined(); // legacy authoritative
    expect(reader.get('tr-1')).toBeUndefined();        // mirror inert
    engine.close();
    history.close();
  });

  it('flag ON → insertTrigger re-projects the mapped row (source, condition_json, params_json)', () => {
    const { history, engine, reader } = make(true, 'vault-key');
    history.insertTrigger(trig({ taskType: 'cron', scheduleCron: '0 9 * * *', pipelineParams: '{"x":1}' }));
    const mirror = reader.get('tr-1');
    expect(mirror).toBeDefined();
    expect(mirror!.source).toBe('cron');                          // task_type → source (verbatim)
    expect(JSON.parse(mirror!.conditionJson).schedule_cron).toBe('0 9 * * *');
    expect(mirror!.paramsJson).toBe('{"x":1}');                   // pipeline_params → params_json
    expect(mirror!.targetWorkflowId).toBeNull();                  // no workflow mirrored → orphan nulled
    engine.close();
    history.close();
  });

  it('flag ON → FK-guard resolves target_workflow_id when the workflow was mirrored', () => {
    const { history, engine, reader } = make(true);
    seedMirroredWorkflow(history, 'wf-9');
    history.insertTrigger(trig({ taskType: 'pipeline', pipelineId: 'wf-9' }));
    expect(reader.get('tr-1')!.targetWorkflowId).toBe('wf-9');
    engine.close();
    history.close();
  });

  it('flag ON → updateTrigger re-projects the change AND preserves fields it did not touch', () => {
    const { history, engine, reader } = make(true, 'k');
    const wc = '{"url":"https://x.test"}';
    history.insertTrigger(trig({ scheduleCron: '0 9 * * *', watchConfig: wc }));
    // updateTrigger touches only scheduleCron. Because the mirror RE-PROJECTS the
    // full legacy row (not a per-field json_set), the untouched watch_config must
    // survive in condition_json — a regression to per-field patching would drop it.
    history.updateTrigger('tr-1', { scheduleCron: '30 6 * * 1' });
    const cond = JSON.parse(reader.get('tr-1')!.conditionJson) as { schedule_cron: string; watch_config: string };
    expect(cond.schedule_cron).toBe('30 6 * * 1'); // changed field re-projected
    expect(cond.watch_config).toBe(wc);            // untouched field preserved (proves re-project ≠ patch)
    engine.close();
    history.close();
  });

  it('flag ON → setTriggerEnabled flips the mirror kill-switch', () => {
    const { history, engine, reader } = make(true);
    history.insertTrigger(trig());
    expect(reader.get('tr-1')!.enabled).toBe(true);
    history.setTriggerEnabled('tr-1', false);
    expect(reader.get('tr-1')!.enabled).toBe(false);
    engine.close();
    history.close();
  });

  it('flag ON → updateTriggerRunResult re-projects last_run_* + retry_count', () => {
    const { history, engine, reader } = make(true);
    history.insertTrigger(trig());
    history.updateTriggerRunResult('tr-1', {
      lastRunAt: '2026-07-02T09:00:00Z', lastRunResult: 'ok', lastRunStatus: 'completed', retryCount: 1,
    });
    const mirror = reader.get('tr-1')!;
    expect(mirror.lastRunResult).toBe('ok');
    expect(mirror.lastRunStatus).toBe('completed');
    expect(mirror.retryCount).toBe(1);
    engine.close();
    history.close();
  });

  it('flag ON → updateTriggerWatchConfig re-projects the raw watch_config into condition_json', () => {
    const { history, engine, reader } = make(true);
    history.insertTrigger(trig({ id: 'tr-w', taskType: 'watch' }));
    const wc = '{"url":"https://x.test","selector":".price"}';
    history.updateTriggerWatchConfig('tr-w', wc);
    expect(JSON.parse(reader.get('tr-w')!.conditionJson).watch_config).toBe(wc);
    engine.close();
    history.close();
  });

  it('flag ON → deleteTrigger removes the mirror row', () => {
    const { history, engine, reader } = make(true);
    history.insertTrigger(trig());
    expect(reader.get('tr-1')).toBeDefined();
    history.deleteTrigger('tr-1');
    expect(reader.get('tr-1')).toBeUndefined();
    engine.close();
    history.close();
  });

  it('mirror failure is isolated — legacy write AND the WorkerLoop money-path read are unperturbed', () => {
    const { history, engine } = make(true);
    engine.close(); // every subsequent TriggerStore op now throws
    // A due trigger (past next_run_at) so getDueTriggers — the WorkerLoop's actual
    // read on the money-path — would select it.
    expect(() => history.insertTrigger(trig({ nextRunAt: '2020-01-01T00:00:00Z' }))).not.toThrow();
    expect(history.getTrigger('tr-1')).toBeDefined();                       // legacy read authoritative
    expect(history.getDueTriggers().some(t => t.id === 'tr-1')).toBe(true); // money-path read intact
    history.close();
  });

  it('flag ON → a write to a non-existent trigger re-projects nothing (raced-delete no-op)', () => {
    const { history, engine, reader } = make(true);
    // updateTrigger matches no row → _reprojectTrigger reads back undefined → the
    // `if (rec)` guard makes it a no-op (no throw, no phantom mirror row).
    expect(() => history.updateTrigger('ghost', { status: 'completed' })).not.toThrow();
    expect(reader.get('ghost')).toBeUndefined();
    engine.close();
    history.close();
  });

  it('setVerbGraph(false) after ON reverts trigger writes to legacy-only', () => {
    const { history, engine, reader } = make(true);
    history.setVerbGraph(engine, false);
    history.insertTrigger(trig());
    expect(history.getTrigger('tr-1')).toBeDefined();
    expect(reader.get('tr-1')).toBeUndefined();
    engine.close();
    history.close();
  });
});

/**
 * S3c — the RunHistory → engine.db TASK dual-write mirror (human TODOs; fires
 * nothing, so no money-path). Proves: flag OFF inert, flag ON re-projects every
 * write path (insert/update/delete), the free-text `assignee` is dropped, the
 * self-FK parent_task_id resolves, deleteTask replicates the legacy subtask
 * cascade in engine.db (not the schema's ON DELETE SET NULL orphaning), and a
 * mirror failure never breaks the authoritative legacy write/read.
 */
describe('RunHistory verb-graph mirror — tasks (Foundation Rework v2 — S3c)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  function make(enabled: boolean, key = ''): { history: RunHistory; engine: EngineDb; reader: TaskStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-kvm-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), key);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    histories.push(history);
    engines.push(engine);
    history.setVerbGraph(engine, enabled);
    return { history, engine, reader: new TaskStore(engine) };
  }

  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const h of histories) { try { h.close(); } catch { /* already closed */ } }
    engines.length = 0;
    histories.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function task(over: {
    id?: string; title?: string; status?: string; priority?: string;
    scopeType?: string; scopeId?: string; dueDate?: string; tags?: string;
    parentTaskId?: string; assignee?: string;
  } = {}) {
    return {
      id: over.id ?? 'kk-1',
      title: over.title ?? 'Call the accountant',
      description: 'about the Q3 filing',
      status: over.status ?? 'open',
      priority: over.priority ?? 'high',
      assignee: over.assignee,
      scopeType: over.scopeType ?? 'project',
      scopeId: over.scopeId ?? '',
      dueDate: over.dueDate ?? '2026-07-10',
      tags: over.tags ?? '["finance"]',
      parentTaskId: over.parentTaskId,
    };
  }

  it('flag OFF → legacy task write only, NO engine.db row', () => {
    const { history, engine, reader } = make(false);
    history.insertTask(task());
    expect(history.getTask('kk-1')).toBeDefined(); // legacy authoritative
    expect(reader.get('kk-1')).toBeUndefined();     // mirror inert
    engine.close();
    history.close();
  });

  it('flag ON → insertTask re-projects the mapped row; free-text assignee is dropped', () => {
    const { history, engine, reader } = make(true, 'vault-key');
    history.insertTask(task({ assignee: 'Britta', tags: '["finance"]' }));
    const mirror = reader.get('kk-1');
    expect(mirror).toBeDefined();
    expect(mirror!.title).toBe('Call the accountant');
    expect(mirror!.status).toBe('open');
    expect(mirror!.priority).toBe('high');
    expect(mirror!.tags).toBe('["finance"]');
    expect(mirror!.dueDate).toBe('2026-07-10');
    // assignee is legacy free-text with no engine.db string column → never mirrored.
    const raw = engine.getDb().prepare("SELECT assignee_subject_id FROM tasks WHERE id = 'kk-1'")
      .get() as { assignee_subject_id: string | null };
    expect(raw.assignee_subject_id).toBeNull();
    engine.close();
    history.close();
  });

  it('flag ON → self-FK parent_task_id resolves when the parent was mirrored', () => {
    const { history, engine, reader } = make(true);
    history.insertTask(task({ id: 'parent' }));
    history.insertTask(task({ id: 'child', parentTaskId: 'parent' }));
    expect(reader.get('child')!.parentTaskId).toBe('parent');
    engine.close();
    history.close();
  });

  it('flag ON → updateTask re-projects the change AND preserves fields it did not touch', () => {
    const { history, engine, reader } = make(true, 'k');
    history.insertTask(task({ tags: '["finance"]' }));
    // updateTask touches only status/completedAt. Because the mirror RE-PROJECTS the
    // full legacy row, the untouched tags must survive — a per-field patch would drop them.
    history.updateTask('kk-1', { status: 'completed', completedAt: '2026-07-05' });
    const mirror = reader.get('kk-1')!;
    expect(mirror.status).toBe('completed');          // changed field re-projected
    expect(mirror.completedAt).toBe('2026-07-05');
    expect(mirror.tags).toBe('["finance"]');          // untouched field preserved
    engine.close();
    history.close();
  });

  it('flag ON → deleteTask cascades subtasks in engine.db (matches legacy, no orphans)', () => {
    const { history, engine, reader } = make(true);
    history.insertTask(task({ id: 'p1' }));
    history.insertTask(task({ id: 'c1', parentTaskId: 'p1' }));
    history.insertTask(task({ id: 'c2', parentTaskId: 'p1' }));
    expect(reader.get('c1')).toBeDefined();
    history.deleteTask('p1');
    // parent + subtasks all gone in engine.db — deleteTask captures legacy's child
    // ids and the store removes them explicitly (the schema's ON DELETE SET NULL
    // would instead leave orphaned c1/c2).
    expect(reader.get('p1')).toBeUndefined();
    expect(reader.get('c1')).toBeUndefined();
    expect(reader.get('c2')).toBeUndefined();
    const n = engine.getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    expect(n.n).toBe(0);
    engine.close();
    history.close();
  });

  it('flag ON → deleteTask removes a child whose parent predates the flag (no phantom orphan)', () => {
    const { history, engine, reader } = make(false); // start flag OFF
    history.insertTask(task({ id: 'p-old' }));         // parent created pre-flag → never mirrored
    expect(reader.get('p-old')).toBeUndefined();
    history.setVerbGraph(engine, true);                // flip flag ON
    history.insertTask(task({ id: 'c-new', parentTaskId: 'p-old' }));
    // The child mirrors, but the FK-guard nulls its mirror parent (p-old absent) —
    // so a cascade keyed on the mirror's own parent_task_id would MISS it on delete.
    expect(reader.get('c-new')!.parentTaskId).toBeNull();
    history.deleteTask('p-old');
    // Legacy cascades c-new; the mirror removes it too, driven by the legacy
    // child-id capture (NOT the nulled mirror link) → no phantom survives.
    expect(reader.get('c-new')).toBeUndefined();
    engine.close();
    history.close();
  });

  it('mirror failure is isolated — legacy task write + read are unperturbed', () => {
    const { history, engine } = make(true);
    engine.close(); // every subsequent TaskStore op now throws
    expect(() => history.insertTask(task())).not.toThrow();
    expect(history.getTask('kk-1')).toBeDefined();                    // legacy read authoritative
    expect(history.getTasks().some(t => t.id === 'kk-1')).toBe(true); // list read intact
    history.close();
  });

  it('mirror failure is isolated on the DELETE path — legacy cascade + child capture unperturbed', () => {
    const { history, engine } = make(true);
    history.insertTask(task({ id: 'p1' }));
    history.insertTask(task({ id: 'c1', parentTaskId: 'p1' }));
    engine.close(); // TaskStore.remove now throws; getTaskChildIds still runs on the open history.db
    // Exercises the S3c-unique delete path: legacy child-id capture (history.db, open)
    // + the swallowed engine.db remove (closed) — the legacy cascade must still land.
    expect(() => history.deleteTask('p1')).not.toThrow();
    expect(history.getTask('p1')).toBeUndefined(); // legacy delete authoritative
    expect(history.getTask('c1')).toBeUndefined(); // legacy subtask cascade intact
    history.close();
  });

  it('flag ON → an update to a non-existent task re-projects nothing (raced-delete no-op)', () => {
    const { history, engine, reader } = make(true);
    // updateTask matches no row → _reprojectTask reads back undefined → the
    // `if (rec)` guard makes it a no-op (no throw, no phantom mirror row).
    expect(() => history.updateTask('ghost', { status: 'completed' })).not.toThrow();
    expect(reader.get('ghost')).toBeUndefined();
    engine.close();
    history.close();
  });

  it('setVerbGraph(false) after ON reverts task writes to legacy-only', () => {
    const { history, engine, reader } = make(true);
    history.setVerbGraph(engine, false);
    history.insertTask(task());
    expect(history.getTask('kk-1')).toBeDefined();
    expect(reader.get('kk-1')).toBeUndefined();
    engine.close();
    history.close();
  });
});
