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

/**
 * S3e — the RunHistory verb-def READ-cutover (triggers + workflows). The mirror
 * (S3a-c) + backfill (S3d) make engine.db a live copy; S3e flips the READ authority
 * for triggers + workflows onto it behind `verb_graph_reads`. Proves: reads OFF ==
 * legacy (no change), reads ON == the SAME record reconstructed from engine.db
 * (money-path shape fidelity + field-for-field equivalence), a thrown engine.db
 * read degrades to legacy, and a by-id miss returns not-found WITHOUT a wrong-source
 * legacy fallthrough (D4). Tasks are NOT cut over (S4) — their getTask* stay legacy.
 */
describe('RunHistory verb-graph READ-cutover (Foundation Rework v2 — S3e)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  /** Mirror ALWAYS on; `readsEnabled` gates the read authority (the S3e flag). */
  function make(readsEnabled: boolean, key = ''): { history: RunHistory; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-rc-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), key);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    histories.push(history);
    engines.push(engine);
    history.setVerbGraph(engine, true, readsEnabled);
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

  function trig(over: {
    id?: string; title?: string; taskType?: string; scheduleCron?: string;
    nextRunAt?: string; pipelineId?: string; pipelineParams?: string; watchConfig?: string;
    status?: string; notificationChannel?: string; maxRetries?: number;
  } = {}) {
    return {
      id: over.id ?? 'tr-1',
      title: over.title ?? 'Daily report',
      status: over.status ?? 'open',
      scopeType: 'project',
      scopeId: 'proj-1',
      taskType: over.taskType ?? 'cron',
      scheduleCron: over.scheduleCron ?? '0 9 * * *',
      nextRunAt: over.nextRunAt ?? '2026-07-02T09:00:00Z',
      pipelineId: over.pipelineId,
      pipelineParams: over.pipelineParams ?? '{"tone":"brief"}',
      watchConfig: over.watchConfig,
      notificationChannel: over.notificationChannel,
      maxRetries: over.maxRetries,
    };
  }

  const planned = (over: Partial<{ id: string; name: string; goal: string; template: boolean }> = {}) => ({
    id: over.id ?? 'wf-1',
    name: over.name ?? 'Weekly report',
    goal: over.goal ?? 'compile + send the weekly report',
    steps: [{ id: 's1', task: 'do the thing' }] as unknown as [],
    reasoning: 'saved from session run-x',
    estimatedCost: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    template: over.template ?? true,
  });

  function seedMirroredWorkflow(history: RunHistory, id: string): void {
    history.insertPlannedPipeline({
      id, name: 'W', goal: 'g', steps: [], reasoning: 'r',
      estimatedCost: 0, createdAt: '2026-07-01T00:00:00.000Z', template: true,
    });
  }

  // The TriggerRecord fields to compare for legacy-vs-engine equivalence. Excludes
  // created_at/updated_at: in the LIVE mirror path both sides stamp their own
  // datetime('now') at write time (the backfill preserves them — tested in S3d), so
  // they are a write-time artifact here, not a read-cutover concern. Nullish→null so
  // a legacy `null` and an engine `undefined` (both "absent") compare equal.
  const TRIGGER_CMP_KEYS: Array<keyof import('../types/pipeline.js').TriggerRecord> = [
    'id', 'title', 'description', 'status', 'assignee', 'scope_type', 'scope_id',
    'schedule_cron', 'next_run_at', 'last_run_at', 'last_run_result', 'last_run_status',
    'task_type', 'watch_config', 'max_retries', 'retry_count', 'notification_channel',
    'pipeline_id', 'pipeline_params', 'enabled',
  ];
  function canonTrigger(rec: import('../types/pipeline.js').TriggerRecord): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const k of TRIGGER_CMP_KEYS) o[k] = rec[k] ?? null;
    return o;
  }

  // ── triggers ──

  it('reads OFF (default) → getDueTriggers reads legacy, unchanged', () => {
    const { history } = make(false);
    history.insertTrigger(trig({ nextRunAt: '2020-01-01T00:00:00Z' }));
    expect(history.getDueTriggers().some(t => t.id === 'tr-1')).toBe(true);
  });

  it('getDueTriggers (MONEY-PATH): reverse-maps every field a due trigger carries', () => {
    const { history } = make(true);
    seedMirroredWorkflow(history, 'wf-9');
    history.insertTrigger(trig({
      id: 'tr-due', taskType: 'pipeline', pipelineId: 'wf-9',
      scheduleCron: '0 9 * * *', nextRunAt: '2020-01-01T00:00:00Z', pipelineParams: '{"tone":"brief"}',
    }));
    const t = history.getDueTriggers().find(x => x.id === 'tr-due')!;
    expect(t.task_type).toBe('pipeline');            // source → task_type
    expect(t.pipeline_id).toBe('wf-9');              // target_workflow_id → pipeline_id
    expect(t.pipeline_params).toBe('{"tone":"brief"}'); // params_json → pipeline_params
    expect(t.schedule_cron).toBe('0 9 * * *');       // parsed back out of condition_json
    expect(t.enabled).toBe(1);                       // 0/1 number, not boolean
    expect(t.assignee).toBe('lynox');                // synthesized constant (lossless)
    expect(t.status).toBe('open');
  });

  it('getDueTriggers: engine read (ON) == legacy read (OFF), field-for-field + ordering', () => {
    const { history, engine } = make(false); // mirror ON, reads OFF
    seedMirroredWorkflow(history, 'wf-9');
    history.insertTrigger(trig({ id: 'a', nextRunAt: '2020-06-01T00:00:00Z', taskType: 'pipeline', pipelineId: 'wf-9' }));
    history.insertTrigger(trig({ id: 'b', nextRunAt: '2019-01-01T00:00:00Z', taskType: 'cron', maxRetries: 3 }));
    const legacy = history.getDueTriggers();
    history.setVerbGraph(engine, true, true); // reads ON
    const eng = history.getDueTriggers();
    expect(eng.map(t => t.id)).toEqual(legacy.map(t => t.id));        // next_run_at ASC → [b, a]
    expect(eng.map(canonTrigger)).toEqual(legacy.map(canonTrigger)); // every field equal
  });

  it('getTrigger by id: engine (ON) == legacy (OFF)', () => {
    const { history, engine } = make(false);
    history.insertTrigger(trig({ id: 'tr-x', maxRetries: 2, notificationChannel: 'email' }));
    const legacy = history.getTrigger('tr-x')!;
    history.setVerbGraph(engine, true, true);
    const eng = history.getTrigger('tr-x')!;
    expect(canonTrigger(eng)).toEqual(canonTrigger(legacy));
  });

  it('getTriggers filtered (status): engine (ON) == legacy (OFF)', () => {
    const { history, engine } = make(false);
    history.insertTrigger(trig({ id: 'open-1', status: 'open' }));
    history.insertTrigger(trig({ id: 'done-1', status: 'completed' }));
    const legacy = history.getTriggers({ status: 'open' });
    history.setVerbGraph(engine, true, true);
    const eng = history.getTriggers({ status: 'open' });
    expect(eng.map(t => t.id)).toEqual(legacy.map(t => t.id));
    expect(eng.map(canonTrigger)).toEqual(legacy.map(canonTrigger));
  });

  it('getTriggersByPipelineId: engine (ON) == legacy (OFF) (destructive-edit guard)', () => {
    const { history, engine } = make(false);
    seedMirroredWorkflow(history, 'wf-7');
    history.insertTrigger(trig({ id: 'ref-1', taskType: 'pipeline', pipelineId: 'wf-7' }));
    history.insertTrigger(trig({ id: 'ref-off', taskType: 'pipeline', pipelineId: 'wf-7' }));
    history.setTriggerEnabled('ref-off', false); // disabled → excluded by the guard
    const legacy = history.getTriggersByPipelineId('wf-7');
    history.setVerbGraph(engine, true, true);
    const eng = history.getTriggersByPipelineId('wf-7');
    expect(eng.map(t => t.id)).toEqual(legacy.map(t => t.id)); // only the enabled ref
    expect(eng.map(canonTrigger)).toEqual(legacy.map(canonTrigger));
  });

  it('by-id miss returns not-found WITHOUT falling back to legacy (D4)', () => {
    const { history, engine } = make(false);
    history.setVerbGraph(engine, false, false);     // mirror OFF → this insert is legacy-only
    history.insertTrigger(trig({ id: 'legacy-only' }));
    history.setVerbGraph(engine, true, true);        // mirror + reads ON; the row was never mirrored
    expect(history.getTrigger('legacy-only')).toBeUndefined(); // engine miss, no legacy fallthrough
    history.setVerbGraph(engine, true, false);       // reads OFF → legacy DOES have it (sanity)
    expect(history.getTrigger('legacy-only')).toBeDefined();
  });

  it('a thrown engine.db read falls back to legacy (no crash)', () => {
    const { history, engine } = make(true);
    history.insertTrigger(trig({ id: 'tr-fb', nextRunAt: '2020-01-01T00:00:00Z' }));
    engine.close(); // every engine.db read now throws
    expect(() => history.getDueTriggers()).not.toThrow();
    expect(history.getDueTriggers().some(t => t.id === 'tr-fb')).toBe(true); // legacy fallback served it
  });

  it('known benign gap: a trigger with no task_type reverse-maps to "manual" (never null)', () => {
    // The forward map upsamples an absent task_type → source='manual'; the reverse
    // map can't recover the legacy null. Benign: every WorkerLoop-fired trigger is
    // created via createScheduled / createPipeline / createWatch, which always set
    // an explicit task_type — a task_type-less row is not a real fired trigger.
    // Documented, not an equivalence failure.
    const { history } = make(true);
    history.insertTrigger({ id: 'tr-m', title: 'm', status: 'open', scopeType: 'project', scopeId: '', nextRunAt: '2020-01-01T00:00:00Z' });
    expect(history.getDueTriggers().find(x => x.id === 'tr-m')!.task_type).toBe('manual');
  });

  it('getDue: engine (ON) EXCLUDES the same non-due triggers as legacy (money-path exclusions)', () => {
    const { history, engine } = make(false);
    seedMirroredWorkflow(history, 'wf-9');
    const past = '2020-01-01T00:00:00Z';
    // due:
    history.insertTrigger(trig({ id: 'due-cron', taskType: 'cron', scheduleCron: '0 9 * * *', nextRunAt: past }));
    history.insertTrigger({ id: 'due-oneshot', title: 'o', status: 'open', scopeType: 'project', scopeId: 'proj-1', taskType: 'pipeline', nextRunAt: '2020-02-01T00:00:00Z', pipelineId: 'wf-9', pipelineParams: '{"x":1}' });
    // failed BUT cron → survives a failure (kept in queue):
    history.insertTrigger(trig({ id: 'failed-cron', status: 'failed', taskType: 'cron', scheduleCron: '0 9 * * *', nextRunAt: past }));
    // excluded — disabled kill-switch:
    history.insertTrigger(trig({ id: 'x-disabled', nextRunAt: past }));
    history.setTriggerEnabled('x-disabled', false);
    // excluded — completed:
    history.insertTrigger(trig({ id: 'x-completed', status: 'completed', nextRunAt: past }));
    // excluded — failed one-shot (no schedule_cron):
    history.insertTrigger({ id: 'x-failed-oneshot', title: 'f', status: 'failed', scopeType: 'project', scopeId: 'proj-1', taskType: 'pipeline', nextRunAt: past, pipelineId: 'wf-9' });
    // excluded — future next_run_at:
    history.insertTrigger(trig({ id: 'x-future', nextRunAt: '2099-01-01T00:00:00Z' }));

    const legacy = history.getDueTriggers();
    history.setVerbGraph(engine, true, true);
    const eng = history.getDueTriggers();
    expect(eng.map(t => t.id)).toEqual(legacy.map(t => t.id)); // identical selection + order
    expect(eng.map(canonTrigger)).toEqual(legacy.map(canonTrigger));
    const ids = eng.map(t => t.id);
    expect(ids).toEqual(expect.arrayContaining(['due-cron', 'due-oneshot', 'failed-cron']));
    for (const excluded of ['x-disabled', 'x-completed', 'x-failed-oneshot', 'x-future']) {
      expect(ids).not.toContain(excluded);
    }
  });

  it('getDue: a paramless pipeline trigger reads pipeline_params as legacy-null, NOT "{}" (requireAll parity)', () => {
    const { history, engine } = make(false);
    seedMirroredWorkflow(history, 'wf-9');
    // A pipeline trigger with NO bound params → legacy stores pipeline_params = NULL.
    history.insertTrigger({ id: 'tr-noparam', title: 'n', status: 'open', scopeType: 'project', scopeId: 'proj-1', taskType: 'pipeline', nextRunAt: '2020-01-01T00:00:00Z', pipelineId: 'wf-9' });
    const legacy = history.getDueTriggers().find(t => t.id === 'tr-noparam')!;
    history.setVerbGraph(engine, true, true);
    const eng = history.getDueTriggers().find(t => t.id === 'tr-noparam')!;
    // Both falsy: the forward map collapsed null→'{}', the reverse map restores it
    // to undefined, so worker-loop's `if (task.pipeline_params)` stays false ⇒
    // runSavedWorkflow requireAll=false ⇒ no spurious "Missing required parameter".
    expect(legacy.pipeline_params ?? null).toBeNull();
    expect(eng.pipeline_params ?? null).toBeNull();
    expect(Boolean(eng.pipeline_params)).toBe(false);
    // (a trigger WITH real params still round-trips verbatim — covered by the
    // money-path shape-fidelity test above, which asserts pipeline_params '{"tone":"brief"}'.)
  });

  it('listFiltered (scopeType / taskType→source / limit): engine (ON) == legacy (OFF), per clause', () => {
    const { history, engine } = make(false);
    history.insertTrigger(trig({ id: 'p-cron', taskType: 'cron' }));
    history.insertTrigger(trig({ id: 'p-watch', taskType: 'watch' }));
    history.insertTrigger({ id: 'g-cron', title: 't', status: 'open', scopeType: 'global', scopeId: 'g', taskType: 'cron', scheduleCron: '0 9 * * *', nextRunAt: '2026-07-02T09:00:00Z' });
    const cases = [{ scopeType: 'project' }, { taskType: 'watch' }, { limit: 1 }, { scopeType: 'global', taskType: 'cron' }];
    const legacy = cases.map(c => history.getTriggers(c));
    history.setVerbGraph(engine, true, true);
    cases.forEach((c, i) => {
      const eng = history.getTriggers(c);
      expect(eng.map(t => t.id)).toEqual(legacy[i]!.map(t => t.id));
      expect(eng.map(canonTrigger)).toEqual(legacy[i]!.map(canonTrigger));
    });
  });

  it('getById with scopeFilter: engine (ON) == legacy (OFF), including the scope miss', () => {
    const { history, engine } = make(false);
    history.insertTrigger(trig({ id: 'scoped' })); // scope_type project / scope_id proj-1
    const hit = { scopeFilter: [{ type: 'project', id: 'proj-1' }] };
    const miss = { scopeFilter: [{ type: 'global', id: 'g' }] };
    const legacyHit = history.getTrigger('scoped', hit);
    history.setVerbGraph(engine, true, true);
    expect(canonTrigger(history.getTrigger('scoped', hit)!)).toEqual(canonTrigger(legacyHit!));
    expect(history.getTrigger('scoped', miss)).toBeUndefined(); // scope guard excludes it on both paths
  });

  it('getByWorkflowId EXCLUDES a completed ref (engine (ON) == legacy (OFF))', () => {
    const { history, engine } = make(false);
    seedMirroredWorkflow(history, 'wf-c');
    history.insertTrigger(trig({ id: 'active-ref', taskType: 'pipeline', pipelineId: 'wf-c' }));
    history.insertTrigger(trig({ id: 'done-ref', taskType: 'pipeline', pipelineId: 'wf-c', status: 'completed' }));
    const legacy = history.getTriggersByPipelineId('wf-c');
    history.setVerbGraph(engine, true, true);
    const eng = history.getTriggersByPipelineId('wf-c');
    expect(eng.map(t => t.id)).toEqual(legacy.map(t => t.id)); // only active-ref, on both
    expect(eng.map(t => t.id)).not.toContain('done-ref');
  });

  // ── workflows ──

  it('getPlannedPipeline by id: engine (ON) == legacy (OFF), byte-identical blob', () => {
    const { history, engine } = make(false);
    history.insertPlannedPipeline(planned({ id: 'wf-x', name: 'X' }));
    const legacy = history.getPlannedPipeline('wf-x');
    history.setVerbGraph(engine, true, true);
    const eng = history.getPlannedPipeline('wf-x');
    expect(eng).toEqual(legacy); // {id, manifest_json} — definition_json IS manifest_json
  });

  it('getPlannedPipelines list: engine (ON) == legacy (OFF) for id/name/blob/step_count', () => {
    const { history, engine } = make(false);
    history.insertPlannedPipeline(planned({ id: 'wf-a', name: 'A', template: true }));
    history.insertPlannedPipeline(planned({ id: 'wf-b', name: 'B', template: false }));
    const legacy = history.getPlannedPipelines(100);
    history.setVerbGraph(engine, true, true);
    const eng = history.getPlannedPipelines(100);
    const proj = (w: { id: string; manifest_name: string; manifest_json: string; step_count: number }) =>
      [w.id, w.manifest_name, w.manifest_json, w.step_count];
    // Sort by id to avoid a same-second started_at ordering tie (started_at itself is
    // a write-time artifact, excluded — the mapper reads parsed.steps.length anyway).
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...eng].sort(byId).map(proj)).toEqual([...legacy].sort(byId).map(proj));
    expect(eng.every(w => typeof w.started_at === 'string' && w.started_at.length > 0)).toBe(true);
  });

  it('reads ON but engine.db mirror empty for workflows → list is empty, not a legacy fallthrough', () => {
    const { history, engine } = make(false);
    history.setVerbGraph(engine, false, false);   // mirror OFF → legacy-only insert
    history.insertPlannedPipeline(planned({ id: 'wf-legacy' }));
    history.setVerbGraph(engine, true, true);      // reads ON, nothing mirrored
    expect(history.getPlannedPipelines(100)).toEqual([]); // engine authoritative on read (miss ≠ fallback)
  });
});
