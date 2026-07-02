import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { WorkflowStore } from './workflow-store.js';
import { TriggerStore } from './trigger-store.js';
import { TaskStore } from './task-store.js';

/**
 * S3f — the verb write-cutover. engine.db is now the SOLE authority for
 * workflow-DEFINITION reads AND writes: `insertPlannedPipeline`/rename/delete/
 * markExecuted/setConfirmedAt write engine.db directly, and the legacy history.db
 * `pipeline_runs status='planned'/'executed'` def rows are gone. There is NO legacy
 * fallback — a write to a closed engine.db throws (honest, not silently degraded);
 * a tenant with no engine.db at all degrades to empty reads / no-op writes.
 */
describe('RunHistory verb write-cutover — workflows (Foundation Rework v2 — S3f)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  function make(key = ''): { history: RunHistory; engine: EngineDb; reader: WorkflowStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-vm-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), key);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    histories.push(history);
    engines.push(engine);
    history.setVerbGraph(engine);
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

  it('insert writes DIRECTLY to engine.db; the read comes back from engine.db (no legacy row)', () => {
    const { history, engine, reader } = make('vault-key');
    history.insertPlannedPipeline(planned({ template: true }));
    // Both the RunHistory read and a direct WorkflowStore read see the same engine.db row.
    const viaHistory = history.getPlannedPipeline('wf-1');
    const viaStore = reader.get('wf-1');
    expect(viaHistory).toBeDefined();
    expect(viaStore).toBeDefined();
    expect(viaStore!.isTemplate).toBe(true);
    expect(viaStore!.definitionJson).toBe(viaHistory!.manifest_json); // one source of truth
    engine.close();
    history.close();
  });

  it('is_template=false for a one-shot plan', () => {
    const { history, engine, reader } = make();
    history.insertPlannedPipeline(planned({ template: false }));
    expect(reader.get('wf-1')!.isTemplate).toBe(false);
    engine.close();
    history.close();
  });

  it('rename propagates to the engine.db row (column + serialized name)', () => {
    const { history, engine, reader } = make('k');
    history.insertPlannedPipeline(planned({ name: 'Old' }));
    expect(history.renamePlannedPipeline('wf-1', 'New')).toBe(true);
    expect(reader.get('wf-1')!.name).toBe('New');
    expect((JSON.parse(reader.get('wf-1')!.definitionJson) as { name: string }).name).toBe('New');
    engine.close();
    history.close();
  });

  it('delete removes the engine.db row', () => {
    const { history, engine, reader } = make();
    history.insertPlannedPipeline(planned());
    expect(history.deletePlannedPipeline('wf-1')).toBe(true);
    expect(reader.get('wf-1')).toBeUndefined();
    engine.close();
    history.close();
  });

  it('markPipelineExecuted drops the one-shot def from the engine.db library', () => {
    const { history, engine, reader } = make();
    history.insertPlannedPipeline(planned({ template: false }));
    history.markPipelineExecuted('wf-1');
    expect(reader.get('wf-1')).toBeUndefined();
    engine.close();
    history.close();
  });

  it('setWorkflowConfirmedAt stamps the engine.db blob', () => {
    const { history, engine, reader } = make('k');
    history.insertPlannedPipeline(planned());
    expect(history.setWorkflowConfirmedAt('wf-1', '2026-07-01T12:00:00Z')).toBe(true);
    expect((JSON.parse(reader.get('wf-1')!.definitionJson) as { confirmedAt: string }).confirmedAt)
      .toBe('2026-07-01T12:00:00Z');
    engine.close();
    history.close();
  });

  it('getPlannedPipelines lists the engine.db definitions', () => {
    const { history, engine } = make();
    history.insertPlannedPipeline(planned({ id: 'wf-a', name: 'A' }));
    history.insertPlannedPipeline(planned({ id: 'wf-b', name: 'B' }));
    const ids = history.getPlannedPipelines(100).map(w => w.id).sort();
    expect(ids).toEqual(['wf-a', 'wf-b']);
    engine.close();
    history.close();
  });

  it('a write to a CLOSED engine.db THROWS — engine.db is the sole authority, no legacy fallback', () => {
    const { history, engine } = make();
    engine.close(); // every subsequent WorkflowStore op now throws
    // Unlike the S3a additive mirror (which swallowed), the write-cutover surfaces
    // the failure: there is no legacy row to fall back to, so silent success would
    // lose the definition.
    expect(() => history.insertPlannedPipeline(planned())).toThrow();
    history.close();
  });

  it('no engine.db (setVerbGraph never called) → writes THROW (honest, no false success), reads empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-vm-nostore-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'));
    histories.push(history);
    // engine.db is the sole authority for workflow defs — a null store has
    // nowhere to write. A WRITE must throw a clear error rather than silently
    // no-op into false success (the caller would be told "saved" while nothing
    // persisted). READS still degrade to empty (under-fires the safe direction).
    expect(() => history.insertPlannedPipeline(planned())).toThrow(/engine\.db verb store unavailable/);
    expect(() => history.renamePlannedPipeline('wf-1', 'x')).toThrow(/engine\.db verb store unavailable/);
    expect(() => history.deletePlannedPipeline('wf-1')).toThrow(/engine\.db verb store unavailable/);
    expect(history.getPlannedPipeline('wf-1')).toBeUndefined();
    expect(history.getPlannedPipelines(100)).toEqual([]);
  });
});

/**
 * S3f — the TRIGGER write-cutover. engine.db is the SOLE authority: every
 * insert/update/setEnabled/runResult/watchConfig/delete writes the engine.db
 * `triggers` table directly (via the store's native mutators), and every read —
 * incl. the WorkerLoop money-path getDueTriggers — comes from engine.db. Proves:
 * the field mapping (source/condition_json/target_workflow_id/params_json), the
 * FK-guard, partial-update fidelity (a cron-only change preserves watch_config via
 * json_set), the atomic scope-guard, the money-path selection + shape, and that a
 * closed engine.db surfaces (no legacy fallback).
 */
describe('RunHistory verb write-cutover — triggers (Foundation Rework v2 — S3f)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  function make(key = ''): { history: RunHistory; engine: EngineDb; reader: TriggerStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-tvm-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), key);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    histories.push(history);
    engines.push(engine);
    history.setVerbGraph(engine);
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
    status?: string; scopeId?: string; notificationChannel?: string; maxRetries?: number;
  } = {}) {
    return {
      id: over.id ?? 'tr-1',
      title: over.title ?? 'Daily report',
      status: over.status ?? 'open',
      scopeType: 'project',
      scopeId: over.scopeId ?? 'proj-1',
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

  /** Seed a workflow into engine.db so a trigger's target_workflow_id FK resolves. */
  function seedWorkflow(history: RunHistory, id: string): void {
    history.insertPlannedPipeline({
      id, name: 'W', goal: 'g', steps: [], reasoning: 'r',
      estimatedCost: 0, createdAt: '2026-07-01T00:00:00.000Z', template: true,
    });
  }

  it('insertTrigger writes the mapped engine.db row (source, condition_json, params_json)', () => {
    const { history, engine, reader } = make('vault-key');
    history.insertTrigger(trig({ taskType: 'cron', scheduleCron: '0 9 * * *', pipelineParams: '{"x":1}' }));
    const row = reader.get('tr-1');
    expect(row).toBeDefined();
    expect(row!.source).toBe('cron');                              // task_type → source (verbatim)
    expect(JSON.parse(row!.conditionJson).schedule_cron).toBe('0 9 * * *');
    expect(row!.paramsJson).toBe('{"x":1}');                       // pipeline_params → params_json
    expect(row!.targetWorkflowId).toBeNull();                      // no workflow → orphan nulled
    engine.close();
    history.close();
  });

  it('FK-guard resolves target_workflow_id when the workflow exists', () => {
    const { history, engine, reader } = make();
    seedWorkflow(history, 'wf-9');
    history.insertTrigger(trig({ taskType: 'pipeline', pipelineId: 'wf-9' }));
    expect(reader.get('tr-1')!.targetWorkflowId).toBe('wf-9');
    engine.close();
    history.close();
  });

  it('updateTrigger patches the changed field AND preserves the ones it did not touch (json_set)', () => {
    const { history, engine, reader } = make('k');
    const wc = '{"url":"https://x.test"}';
    history.insertTrigger(trig({ scheduleCron: '0 9 * * *', watchConfig: wc }));
    // updateTrigger touches only scheduleCron. It patches condition_json.$.schedule_cron
    // via json_set, so the untouched watch_config in the same blob must survive — a
    // regression that overwrote the whole blob would drop it.
    expect(history.updateTrigger('tr-1', { scheduleCron: '30 6 * * 1' })).toBe(true);
    const cond = JSON.parse(reader.get('tr-1')!.conditionJson) as { schedule_cron: string; watch_config: string };
    expect(cond.schedule_cron).toBe('30 6 * * 1'); // changed field
    expect(cond.watch_config).toBe(wc);            // untouched field preserved
    engine.close();
    history.close();
  });

  it('updateTrigger clears next_run_at + schedule_cron on empty-string (un-schedule)', () => {
    const { history, engine } = make();
    history.insertTrigger(trig({ scheduleCron: '0 9 * * *', nextRunAt: '2026-07-02T09:00:00Z' }));
    expect(history.updateTrigger('tr-1', { nextRunAt: '', scheduleCron: '' })).toBe(true);
    const t = history.getTrigger('tr-1')!;
    expect(t.next_run_at ?? null).toBeNull();
    expect(t.schedule_cron ?? null).toBeNull();
    engine.close();
    history.close();
  });

  it('updateTrigger scope-guard: an out-of-scope update matches nothing (atomic check-and-write)', () => {
    const { history, engine, reader } = make();
    history.insertTrigger(trig({ id: 'scoped', scopeId: 'proj-1' })); // scope project/proj-1
    // In-scope → applies.
    expect(history.updateTrigger('scoped', { status: 'completed' },
      { scopeFilter: [{ type: 'project', id: 'proj-1' }] })).toBe(true);
    expect(reader.get('scoped')!.status).toBe('completed');
    // Out-of-scope → no match, no write (the guard is folded into the WHERE).
    expect(history.updateTrigger('scoped', { status: 'open' },
      { scopeFilter: [{ type: 'global', id: 'g' }] })).toBe(false);
    expect(reader.get('scoped')!.status).toBe('completed'); // unchanged
    engine.close();
    history.close();
  });

  it('setTriggerEnabled flips the engine.db kill-switch', () => {
    const { history, engine, reader } = make();
    history.insertTrigger(trig());
    expect(reader.get('tr-1')!.enabled).toBe(true);
    expect(history.setTriggerEnabled('tr-1', false)).toBe(true);
    expect(reader.get('tr-1')!.enabled).toBe(false);
    engine.close();
    history.close();
  });

  it('updateTriggerRunResult writes last_run_* + retry_count', () => {
    const { history, engine, reader } = make();
    history.insertTrigger(trig());
    history.updateTriggerRunResult('tr-1', {
      lastRunAt: '2026-07-02T09:00:00Z', lastRunResult: 'ok', lastRunStatus: 'completed', retryCount: 1,
    });
    const row = reader.get('tr-1')!;
    expect(row.lastRunResult).toBe('ok');
    expect(row.lastRunStatus).toBe('completed');
    expect(row.retryCount).toBe(1);
    engine.close();
    history.close();
  });

  it('updateTriggerRunResult clears next_run_at on null (one-shot terminal)', () => {
    const { history, engine } = make();
    history.insertTrigger(trig({ nextRunAt: '2026-07-02T09:00:00Z' }));
    history.updateTriggerRunResult('tr-1', {
      lastRunAt: '2026-07-02T09:00:00Z', lastRunResult: 'ok', lastRunStatus: 'completed', nextRunAt: null,
    });
    expect(history.getTrigger('tr-1')!.next_run_at ?? null).toBeNull();
    engine.close();
    history.close();
  });

  it('updateTriggerWatchConfig writes the raw watch_config into condition_json', () => {
    const { history, engine, reader } = make();
    history.insertTrigger(trig({ id: 'tr-w', taskType: 'watch' }));
    const wc = '{"url":"https://x.test","selector":".price"}';
    history.updateTriggerWatchConfig('tr-w', wc);
    expect(JSON.parse(reader.get('tr-w')!.conditionJson).watch_config).toBe(wc);
    engine.close();
    history.close();
  });

  it('deleteTrigger removes the engine.db row', () => {
    const { history, engine, reader } = make();
    history.insertTrigger(trig());
    expect(reader.get('tr-1')).toBeDefined();
    expect(history.deleteTrigger('tr-1')).toBe(true);
    expect(reader.get('tr-1')).toBeUndefined();
    engine.close();
    history.close();
  });

  it('getDueTriggers (MONEY-PATH): reverse-maps every field a due trigger carries', () => {
    const { history, engine } = make();
    seedWorkflow(history, 'wf-9');
    history.insertTrigger(trig({
      id: 'tr-due', taskType: 'pipeline', pipelineId: 'wf-9',
      scheduleCron: '0 9 * * *', nextRunAt: '2020-01-01T00:00:00Z', pipelineParams: '{"tone":"brief"}',
    }));
    const t = history.getDueTriggers().find(x => x.id === 'tr-due')!;
    expect(t.task_type).toBe('pipeline');               // source → task_type
    expect(t.pipeline_id).toBe('wf-9');                 // target_workflow_id → pipeline_id
    expect(t.pipeline_params).toBe('{"tone":"brief"}'); // params_json → pipeline_params
    expect(t.schedule_cron).toBe('0 9 * * *');          // parsed back out of condition_json
    expect(t.enabled).toBe(1);                          // 0/1 number, not boolean
    expect(t.assignee).toBe('lynox');                   // synthesized constant (lossless)
    expect(t.status).toBe('open');
    engine.close();
    history.close();
  });

  it('getDueTriggers: selection + order match the legacy predicate (next_run_at ASC, exclusions)', () => {
    const { history, engine } = make();
    seedWorkflow(history, 'wf-9');
    const past = '2020-01-01T00:00:00Z';
    // due:
    history.insertTrigger(trig({ id: 'due-cron', taskType: 'cron', scheduleCron: '0 9 * * *', nextRunAt: '2020-06-01T00:00:00Z' }));
    history.insertTrigger({ id: 'due-oneshot', title: 'o', status: 'open', scopeType: 'project', scopeId: 'proj-1', taskType: 'pipeline', nextRunAt: '2019-01-01T00:00:00Z', pipelineId: 'wf-9', pipelineParams: '{"x":1}' });
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

    const ids = history.getDueTriggers().map(t => t.id);
    // next_run_at ASC: due-oneshot (2019-01) < failed-cron (2020-01) < due-cron (2020-06).
    expect(ids).toEqual(['due-oneshot', 'failed-cron', 'due-cron']);
    for (const excluded of ['x-disabled', 'x-completed', 'x-failed-oneshot', 'x-future']) {
      expect(ids).not.toContain(excluded);
    }
    engine.close();
    history.close();
  });

  it('getDue: a paramless pipeline trigger reads pipeline_params as null, NOT "{}" (requireAll parity)', () => {
    const { history, engine } = make();
    seedWorkflow(history, 'wf-9');
    // A pipeline trigger with NO bound params.
    history.insertTrigger({ id: 'tr-noparam', title: 'n', status: 'open', scopeType: 'project', scopeId: 'proj-1', taskType: 'pipeline', nextRunAt: '2020-01-01T00:00:00Z', pipelineId: 'wf-9' });
    const t = history.getDueTriggers().find(x => x.id === 'tr-noparam')!;
    // The forward map stored '{}' (params_json NOT NULL); the reverse map restores it
    // to undefined so worker-loop's `if (task.pipeline_params)` stays false ⇒
    // runSavedWorkflow requireAll=false ⇒ no spurious "Missing required parameter".
    expect(t.pipeline_params ?? null).toBeNull();
    expect(Boolean(t.pipeline_params)).toBe(false);
    engine.close();
    history.close();
  });

  it('getTriggers filtered by status returns only matching rows', () => {
    const { history, engine } = make();
    history.insertTrigger(trig({ id: 'open-1', status: 'open' }));
    history.insertTrigger(trig({ id: 'done-1', status: 'completed' }));
    expect(history.getTriggers({ status: 'open' }).map(t => t.id)).toEqual(['open-1']);
    engine.close();
    history.close();
  });

  it('getTrigger with scopeFilter: hit returns the row, miss returns undefined', () => {
    const { history, engine } = make();
    history.insertTrigger(trig({ id: 'scoped', scopeId: 'proj-1' }));
    expect(history.getTrigger('scoped', { scopeFilter: [{ type: 'project', id: 'proj-1' }] })).toBeDefined();
    expect(history.getTrigger('scoped', { scopeFilter: [{ type: 'global', id: 'g' }] })).toBeUndefined();
    engine.close();
    history.close();
  });

  it('getTriggersByPipelineId EXCLUDES disabled + completed refs (destructive-edit guard)', () => {
    const { history, engine } = make();
    seedWorkflow(history, 'wf-c');
    history.insertTrigger(trig({ id: 'active-ref', taskType: 'pipeline', pipelineId: 'wf-c' }));
    history.insertTrigger(trig({ id: 'done-ref', taskType: 'pipeline', pipelineId: 'wf-c', status: 'completed' }));
    history.insertTrigger(trig({ id: 'off-ref', taskType: 'pipeline', pipelineId: 'wf-c' }));
    history.setTriggerEnabled('off-ref', false);
    const ids = history.getTriggersByPipelineId('wf-c').map(t => t.id);
    expect(ids).toEqual(['active-ref']);
    engine.close();
    history.close();
  });

  it('getDue (MONEY-PATH): reverse-maps watch_config for a due WATCH trigger', () => {
    // The money-path test above covers the pipeline fields; watch_config is the OTHER
    // fired-config field the WorkerLoop reads (executeWatch). A regression in the
    // reverse-adapter's watch_config JSON-path would hand executeWatch a broken/absent
    // config on the due-selection path with nothing else catching it.
    const { history, engine } = make();
    const wc = '{"url":"https://x.test","selector":".price"}';
    history.insertTrigger(trig({ id: 'tr-watch-due', taskType: 'watch', watchConfig: wc, nextRunAt: '2020-01-01T00:00:00Z' }));
    const t = history.getDueTriggers().find(x => x.id === 'tr-watch-due')!;
    expect(t.task_type).toBe('watch');
    expect(t.watch_config).toBe(wc); // parsed back out of condition_json by the reverse-adapter
    engine.close();
    history.close();
  });

  it('updateTrigger with ONLY assignee still counts as a touch (changes>0 parity); missing row → false', () => {
    // assignee has no engine.db column (const 'lynox'), but legacy's updateTrigger
    // returned changes>0 for a lone assignee update. The store pushes updated_at so
    // the touch still matches on an existing row — and a non-existent row still → false.
    const { history, engine } = make();
    history.insertTrigger(trig({ id: 'tr-a' }));
    expect(history.updateTrigger('tr-a', { assignee: 'someone' })).toBe(true);
    expect(history.updateTrigger('does-not-exist', { assignee: 'someone' })).toBe(false);
    engine.close();
    history.close();
  });

  it('CORR-1: deleting a pipeline trigger\'s workflow nulls pipeline_id but KEEPS task_type=pipeline', () => {
    // engine.db triggers.target_workflow_id has an FK ON DELETE SET NULL. Deleting the
    // saved workflow nulls the trigger's target — but the routing discriminator
    // (task_type='pipeline') must survive, so the WorkerLoop still routes to
    // executePipeline's safe skip, NOT executeStandard (an autonomous run of the title
    // that spends on every cron tick). This is the store-side half of the CORR-1 fix.
    const { history, engine } = make();
    seedWorkflow(history, 'wf-9');
    history.insertTrigger(trig({ id: 'pt-1', taskType: 'pipeline', pipelineId: 'wf-9', nextRunAt: '2020-01-01T00:00:00Z' }));
    expect(history.getTrigger('pt-1')!.pipeline_id).toBe('wf-9');
    expect(history.deletePlannedPipeline('wf-9')).toBe(true); // FK nulls target_workflow_id
    const due = history.getDueTriggers().find(x => x.id === 'pt-1')!;
    expect(due.pipeline_id ?? null).toBeNull(); // FK-nulled
    expect(due.task_type).toBe('pipeline');     // discriminator survives → safe routing
    engine.close();
    history.close();
  });

  it('_resolveTargetWorkflowId resolves a UNIQUE prefix pipelineId (not nulled) + guard finds it', () => {
    // Workflow reads/deletes are prefix-tolerant (WorkflowStore short-id UX). A UNIQUE
    // prefix must still resolve — else a valid agent-supplied short id would null the
    // target and the pipeline would safe-skip. Resolve stores the concrete workflows.id
    // so the FK + the exact-match destructive-edit guard stay consistent. (Ambiguity is
    // handled in the next test.)
    const { history, engine } = make();
    seedWorkflow(history, 'wf-abc123');
    history.insertTrigger(trig({ id: 'pt-prefix', taskType: 'pipeline', pipelineId: 'wf-abc' })); // prefix, not exact
    expect(history.getTrigger('pt-prefix')!.pipeline_id).toBe('wf-abc123');
    expect(history.getTriggersByPipelineId('wf-abc123').map(t => t.id)).toContain('pt-prefix');
    engine.close();
    history.close();
  });

  it('_resolveTargetWorkflowId rejects an AMBIGUOUS prefix (→ null / safe-skip, no wrong-spend) but an exact id always wins', () => {
    // A prefix matching >1 workflow must NOT bind the trigger to an arbitrary one — the
    // money-path would then spend on the WRONG workflow. It resolves to NULL instead (the
    // FK-null safe-skips in the WorkerLoop, no spend). And an exact id must win even when a
    // longer row merely shares the prefix.
    const { history, engine } = make();
    seedWorkflow(history, 'wf-dup1');
    seedWorkflow(history, 'wf-dup2');
    // 'wf-dup' matches both → ambiguous → target nulled (safe-skip, not a wrong-spend)
    history.insertTrigger(trig({ id: 'pt-ambig', taskType: 'pipeline', pipelineId: 'wf-dup' }));
    expect(history.getTrigger('pt-ambig')!.pipeline_id ?? null).toBeNull();
    // exact preference: candidate equals an existing id even though 'wf-x-long' shares the prefix
    seedWorkflow(history, 'wf-x');
    seedWorkflow(history, 'wf-x-long');
    history.insertTrigger(trig({ id: 'pt-exact', taskType: 'pipeline', pipelineId: 'wf-x' }));
    expect(history.getTrigger('pt-exact')!.pipeline_id).toBe('wf-x');
    engine.close();
    history.close();
  });

  it('a write to a CLOSED engine.db THROWS — no legacy fallback (money-path integrity)', () => {
    const { history, engine } = make();
    engine.close(); // every subsequent TriggerStore op now throws
    expect(() => history.insertTrigger(trig())).toThrow();
    history.close();
  });

  it('no engine.db (setVerbGraph never called) → trigger writes THROW (honest), reads empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-tvm-nostore-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'));
    histories.push(history);
    // A trigger WRITE with no store must throw, not silently drop a scheduled
    // automation while the caller believes it persisted. READS stay empty:
    // getDueTriggers returning [] under-fires (safe) rather than crashing the
    // WorkerLoop poll every tick.
    expect(() => history.insertTrigger(trig())).toThrow(/engine\.db verb store unavailable/);
    expect(() => history.setTriggerEnabled('tr-1', false)).toThrow(/engine\.db verb store unavailable/);
    expect(() => history.updateTriggerRunResult('tr-1', { lastRunAt: 'x', lastRunResult: 'r', lastRunStatus: 'success' })).toThrow(/engine\.db verb store unavailable/);
    expect(history.getTrigger('tr-1')).toBeUndefined();
    expect(history.getDueTriggers()).toEqual([]);
    expect(history.getTriggers()).toEqual([]);
  });
});

/**
 * S3c/S4 — the TASK dual-write mirror (human TODOs; fires nothing, so no
 * money-path). UNLIKE triggers + workflows (which S3f cut over to engine.db-direct),
 * tasks stay LEGACY-AUTHORITATIVE + mirrored until the S4 subject resolution: the
 * legacy history.db `tasks` row is written first and stays the read source; the
 * engine.db mirror re-projects it and a mirror failure is swallowed (legacy always
 * survives). "No mirror" here means setVerbGraph was never called (stores null).
 */
describe('RunHistory verb-graph mirror — tasks (still legacy-authoritative — S3c/S4)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  function make(mirror: boolean, key = ''): { history: RunHistory; engine: EngineDb; reader: TaskStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-kvm-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), key);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    histories.push(history);
    engines.push(engine);
    if (mirror) history.setVerbGraph(engine);
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

  it('no mirror → legacy task write only, NO engine.db row', () => {
    const { history, engine, reader } = make(false);
    history.insertTask(task());
    expect(history.getTask('kk-1')).toBeDefined(); // legacy authoritative
    expect(reader.get('kk-1')).toBeUndefined();     // mirror inert
    engine.close();
    history.close();
  });

  it('mirror → insertTask re-projects the mapped row; free-text assignee is dropped', () => {
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

  it('mirror → self-FK parent_task_id resolves when the parent was mirrored', () => {
    const { history, engine, reader } = make(true);
    history.insertTask(task({ id: 'parent' }));
    history.insertTask(task({ id: 'child', parentTaskId: 'parent' }));
    expect(reader.get('child')!.parentTaskId).toBe('parent');
    engine.close();
    history.close();
  });

  it('mirror → updateTask re-projects the change AND preserves fields it did not touch', () => {
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

  it('mirror → deleteTask cascades subtasks in engine.db (matches legacy, no orphans)', () => {
    const { history, engine, reader } = make(true);
    history.insertTask(task({ id: 'p1' }));
    history.insertTask(task({ id: 'c1', parentTaskId: 'p1' }));
    history.insertTask(task({ id: 'c2', parentTaskId: 'p1' }));
    expect(reader.get('c1')).toBeDefined();
    history.deleteTask('p1');
    expect(reader.get('p1')).toBeUndefined();
    expect(reader.get('c1')).toBeUndefined();
    expect(reader.get('c2')).toBeUndefined();
    const n = engine.getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    expect(n.n).toBe(0);
    engine.close();
    history.close();
  });

  it('mirror → deleteTask removes a child whose parent predates the mirror (no phantom orphan)', () => {
    const { history, engine, reader } = make(false); // start with no mirror
    history.insertTask(task({ id: 'p-old' }));         // parent created pre-mirror → never mirrored
    expect(reader.get('p-old')).toBeUndefined();
    history.setVerbGraph(engine);                      // turn the mirror on
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
    expect(() => history.deleteTask('p1')).not.toThrow();
    expect(history.getTask('p1')).toBeUndefined(); // legacy delete authoritative
    expect(history.getTask('c1')).toBeUndefined(); // legacy subtask cascade intact
    history.close();
  });

  it('mirror → an update to a non-existent task re-projects nothing (raced-delete no-op)', () => {
    const { history, engine, reader } = make(true);
    expect(() => history.updateTask('ghost', { status: 'completed' })).not.toThrow();
    expect(reader.get('ghost')).toBeUndefined();
    engine.close();
    history.close();
  });
});

/**
 * S3f — migration v44: retire the legacy verb-def storage. Proves the DROP of the
 * legacy history.db `triggers` table and the purge of the orphaned workflow-def
 * rows from `pipeline_runs` (status='planned'/'executed'), while the run SPINE
 * (running/completed/failed/rejected) is left intact.
 */
describe('RunHistory migration v44 — legacy verb-def teardown (Foundation Rework v2 — S3f)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('a fresh RunHistory has NO legacy `triggers` table (v44 dropped it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-v44-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'));
    const db = history.getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='triggers'").get();
    expect(row).toBeUndefined();
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBeGreaterThanOrEqual(44);
    history.close();
  });

  it('v44 drops legacy triggers + purges planned/executed pipeline_runs, keeping the spine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-v44-data-'));
    tmpDirs.push(dir);
    const path = join(dir, 'history.db');
    // Build a pre-v44 (schema_version=43) DB with a legacy `triggers` table + a
    // `pipeline_runs` table carrying both def rows (planned/executed) and spine rows.
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (43);
      CREATE TABLE triggers (id TEXT PRIMARY KEY, title TEXT);
      INSERT INTO triggers (id, title) VALUES ('t-legacy', 'x');
      CREATE TABLE pipeline_runs (
        id TEXT PRIMARY KEY, manifest_name TEXT, status TEXT,
        manifest_json TEXT, step_count INTEGER,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO pipeline_runs (id, status) VALUES
        ('p-planned', 'planned'),
        ('p-exec', 'executed'),
        ('p-run', 'running'),
        ('p-done', 'completed'),
        ('p-failed', 'failed');
    `);
    raw.close();

    // Open via RunHistory → _migrate runs v44 (only, since schema_version=43).
    const history = new RunHistory(path);
    const db = history.getDb();

    // triggers table dropped:
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='triggers'").get())
      .toBeUndefined();
    // planned + executed purged; the spine kept:
    const ids = (db.prepare('SELECT id FROM pipeline_runs ORDER BY id').all() as Array<{ id: string }>)
      .map(r => r.id);
    expect(ids).toEqual(['p-done', 'p-failed', 'p-run']);
    // version bumped to 44:
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(44);

    history.close();
  });
});
