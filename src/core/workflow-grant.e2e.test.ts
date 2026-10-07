/**
 * A saved workflow's reviewed write grant, end to end.
 *
 * Real: RunHistory + EngineDb + TaskManager, the acceptance the scheduling route calls
 * (`acceptWorkflowGrant`), WorkerLoop.executePipeline, runGuardedSavedWorkflow and its grant
 * decision, runManifest, spawnInline, the step Agent, and the real `http_request` tool with
 * its consent gate. Mocked: the LLM (it answers with the tool calls a step would make) and
 * the network below `fetchPinned` (a transport that records what was sent).
 *
 * The unit tests pin each factor; this pins the hand-offs — a contract decided by one layer
 * and never handed to the next would leave every unit green and the POST unsent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

vi.mock('node:dns/promises', () => ({ default: { lookup: vi.fn() } }));

const mockProcess = vi.fn();
vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

import dns from 'node:dns/promises';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { WorkerLoop } from './worker-loop.js';
import { createToolContext } from './tool-context.js';
import { setPinnedTransportForTests, type PinnedTransportInput } from './network-guard.js';
import { httpRequestTool } from '../tools/builtin/http.js';
import { taskCreateTool } from '../tools/builtin/task.js';
import { getPipeline, _resetPipelineStore, forgetPipeline, storePipeline } from '../tools/builtin/pipeline.js';
import { _resetTenantInvariantForTests, runGuardedSavedWorkflow } from './saved-workflow-runner.js';
import { acceptWorkflowGrant, prepareWorkflowGrant } from './workflow-grant.js';
import type { IAgent, PlannedPipeline, TriggerRecord } from '../types/index.js';
import type { Engine } from './engine.js';

const endTurn = (text: string) => ({
  content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
});
const toolUse = (name: string, input: unknown, id = 'tu_1') => ({
  content: [{ type: 'tool_use' as const, id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
});

const HOST = 'api.example.com';
const TARGET = `https://${HOST}/v1/reports`;
const CRON = '0 9 * * 1';
const ENTRY = { method: 'POST', host: HOST, paths: ['/v1/reports'] };

describe('a reviewed grant lets a scheduled workflow write, and nothing else does', () => {
  let dir: string;
  let history: RunHistory;
  let engineDb: EngineDb;
  let tm: TaskManager;
  let sent: PinnedTransportInput[];
  let restoreTransport: () => void;
  const notify = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    sent = [];
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    restoreTransport = setPinnedTransportForTests(async (input) => {
      sent.push(input);
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    dir = mkdtempSync(join(tmpdir(), 'lynox-wf-grant-'));
    history = new RunHistory(join(dir, 'history.db'));
    engineDb = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engineDb);
    tm = new TaskManager(history);
    _resetPipelineStore();
    _resetTenantInvariantForTests();
  });

  afterEach(() => {
    restoreTransport();
    try { engineDb.close(); } catch { /* closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function saveWorkflow(id = 'wf-post'): PlannedPipeline {
    history.insertPlannedPipeline({
      id, name: id, goal: 'post the weekly report', reasoning: 'r', estimatedCost: 0,
      createdAt: '2026-10-01T00:00:00.000Z', template: true,
      steps: [{ id: 's1', task: 'post the weekly report', tools: ['http_request'] }],
      ...{ mode: 'autonomous', parameters: [] },
    } as Parameters<RunHistory['insertPlannedPipeline']>[0]);
    forgetPipeline(id);
    return getPipeline(id, history)!;
  }

  function accept(planned: PlannedPipeline, afterUntrusted = false): TriggerRecord {
    const shown = prepareWorkflowGrant(planned, { ...ENTRY, params: {}, cron: CRON, afterUntrusted }, engineDb);
    if (!shown.ok) throw new Error(shown.error);
    const r = acceptWorkflowGrant(planned, { ...ENTRY, params: {}, cron: CRON, afterUntrusted, checksum: shown.checksum, name: 'Ada', title: 'Weekly' }, 'local', { history, taskManager: tm, hasher: engineDb });
    if (!r.ok) throw new Error(r.error);
    forgetPipeline(planned.id);
    return r.task;
  }

  function engine(): Engine {
    const ctx = createToolContext({});
    ctx.tools = [httpRequestTool];
    return {
      getTaskManager: () => tm,
      getUserConfig: () => ({ api_key: 'test-key' }),
      getContext: () => null,
      getHooks: () => [],
      getToolContext: () => ctx,
      getMemory: () => null,
      getRunHistory: () => history,
      getEngineDb: () => engineDb,
      getSecretStore: () => null,
      escalateToUser: () => null,
    } as unknown as Engine;
  }

  async function fire(trigger: TriggerRecord): Promise<void> {
    const loop = new WorkerLoop(engine(), { hasChannels: () => false, notify } as never, 60_000);
    await (loop as unknown as { executePipeline: (t: TriggerRecord) => Promise<void> }).executePipeline(tm.getTrigger(trigger.id)!);
  }

  const posts = (): PinnedTransportInput[] => sent.filter((s) => s.method === 'POST');
  const lastRun = (id: string): string => tm.getTrigger(id)?.last_run_result ?? '';

  it('verify-done: a workflow granted over the acceptance runs on its schedule, and the POST reaches the host', async () => {
    const trigger = accept(saveWorkflow());
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{"week":40}' })).mockResolvedValueOnce(endTurn('posted'));
    await fire(trigger);
    expect(posts().map((p) => p.url)).toEqual([TARGET]);
    expect(lastRun(trigger.id)).toContain('Pipeline completed');
  });

  it('without a grant the same POST is refused, and the owner\'s run record names verb, host and path', async () => {
    const planned = saveWorkflow();
    history.setWorkflowConfirmedAt(planned.id, '2026-10-01T00:00:00.000Z');
    forgetPipeline(planned.id);
    const trigger = tm.createPipelineTask({ title: 'Weekly', pipelineId: planned.id, scheduleCron: CRON, pipelineParams: '{}' });
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('done'));
    await fire(trigger);
    expect(posts()).toEqual([]);
    expect(lastRun(trigger.id)).toContain(`Not granted for an unattended run: POST ${TARGET}`);
    // The run completed, so it is recorded as a success: a failed status would retry the
    // whole run and flip the trigger, on instances where the grant is not even enabled.
    expect(tm.getTrigger(trigger.id)?.last_run_status).toBe('success');
  });

  it('steps changed after the acceptance by a raw blob write: the checksum differs and the run does not write', async () => {
    const planned = saveWorkflow();
    const trigger = accept(planned);
    engineDb.getDb().prepare("UPDATE workflows SET definition_json = json_set(definition_json, '$.steps[0].task', 'post something else') WHERE id = ?").run(planned.id);
    forgetPipeline(planned.id);
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('done'));
    await fire(trigger);
    expect(posts()).toEqual([]);
    expect(lastRun(trigger.id)).toMatch(/changed after the grant was accepted/);
  });

  it('a schedule the model adds with task_create runs without the grant, even with the same values', async () => {
    const planned = saveWorkflow();
    accept(planned);
    const ctx = createToolContext({});
    ctx.taskManager = tm;
    ctx.runHistory = history;
    const out = await taskCreateTool.handler(
      { title: 'model copy', assignee: 'lynox', workflow_id: planned.id, schedule: CRON },
      { name: 'creator', model: 'claude-haiku-4-5-20251001', memory: null, tools: [], onStream: null, toolContext: ctx } as unknown as IAgent,
    );
    expect(out).toContain('Workflow task created');
    const modelTrigger = tm.listTriggers().find((t) => t.title === 'model copy')!;
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('done'));
    await fire(modelTrigger);
    expect(posts()).toEqual([]);
    expect(lastRun(modelTrigger.id)).toMatch(/not the one the grant was accepted for/);
  });

  describe('after the run has read external content', () => {
    function readThenPost(): void {
      mockProcess
        .mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'GET' }, 'tu_read'))
        .mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' }, 'tu_post'))
        .mockResolvedValueOnce(endTurn('done'));
    }

    it('a grant without afterUntrusted does not lift the write', async () => {
      const trigger = accept(saveWorkflow(), false);
      readThenPost();
      await fire(trigger);
      expect(sent.map((s) => s.method)).toEqual(['GET']);
      expect(lastRun(trigger.id)).toMatch(/read external content before this call/);
    });

    it('a grant with afterUntrusted does', async () => {
      const trigger = accept(saveWorkflow(), true);
      readThenPost();
      await fire(trigger);
      expect(sent.map((s) => s.method)).toEqual(['GET', 'POST']);
    });
  });

  it('a person\'s library start runs under the grant, with the schedule\'s cron and values', async () => {
    const planned = saveWorkflow();
    accept(planned);
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('done'));
    const result = await runGuardedSavedWorkflow(engine(), planned.id, undefined, { origin: { kind: 'library' } });
    expect(result.ok).toBe(true);
    expect(posts().map((p) => p.url)).toEqual([TARGET]);
  });

  it('CONTROL: the same start without an origin (any other caller) runs without the grant', async () => {
    const planned = saveWorkflow();
    accept(planned);
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('done'));
    const result = await runGuardedSavedWorkflow(engine(), planned.id, undefined);
    expect(result.grantNote).toMatch(/does not carry one/);
    expect(posts()).toEqual([]);
  });

  it('a workflow still in the pipeline cache when it is granted runs under the grant once read back', async () => {
    // What a workflow saved in chat looks like before a restart: steps carry keys holding
    // `undefined`, which the stored blob does not have.
    const stored = saveWorkflow();
    const cached = { ...stored, steps: stored.steps.map((st) => ({ ...st, input_from: undefined })) } as PlannedPipeline;
    storePipeline(stored.id, cached);
    expect(getPipeline(stored.id, history)).toBe(cached);
    const shown = prepareWorkflowGrant(cached, { ...ENTRY, params: {}, cron: CRON, afterUntrusted: false }, engineDb);
    if (!shown.ok) throw new Error(shown.error);
    const r = acceptWorkflowGrant(cached, { ...ENTRY, params: {}, cron: CRON, afterUntrusted: false, checksum: shown.checksum, name: undefined, title: 't' }, 'local', { history, taskManager: tm, hasher: engineDb });
    if (!r.ok) throw new Error(r.error);
    forgetPipeline(stored.id);
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('done'));
    await fire(r.task);
    expect(posts().map((p) => p.url)).toEqual([TARGET]);
  });

  describe('a library start of a workflow with parameters', () => {
    // `withTaskParam`: a second parameter that reaches only the step's task text. Such a
    // value is wrapped as untrusted data in the step's prompt (`resolveTaskTemplate`), which
    // arms the run's taint — so that workflow is only used where the grant is withheld anyway.
    function grantedParamWorkflow(withTaskParam = false): void {
      history.insertPlannedPipeline({
        id: 'wf-vals', name: 'wf-vals', goal: 'g', reasoning: 'r', estimatedCost: 0, createdAt: '2026-10-01T00:00:00.000Z', template: true,
        steps: [{ id: 's1', task: withTaskParam ? 'post the week, mention {{params.note}}' : 'post the week', tools: ['http_request'], input_template: { url: TARGET, body: '{{params.week}}' } }],
        ...{ mode: 'autonomous', parameters: [
          { name: 'week', description: '', type: 'string', source: 'user_input' },
          { name: 'note', description: '', type: 'string', source: 'user_input' },
        ] },
      } as Parameters<RunHistory['insertPlannedPipeline']>[0]);
      forgetPipeline('wf-vals');
      const wf = getPipeline('wf-vals', history)!;
      const values: Record<string, string> = withTaskParam ? { week: '40', note: 'as agreed' } : { week: '40', note: 'unused' };
      const shown = prepareWorkflowGrant(wf, { ...ENTRY, params: values, cron: CRON, afterUntrusted: false }, engineDb);
      if (!shown.ok) throw new Error(shown.error);
      const r = acceptWorkflowGrant(wf, { ...ENTRY, params: values, cron: CRON, afterUntrusted: false, checksum: shown.checksum, name: undefined, title: 't' }, 'local', { history, taskManager: tm, hasher: engineDb });
      if (!r.ok) throw new Error(r.error);
      forgetPipeline('wf-vals');
    }

    it('without values runs with the schedule\'s values, under the grant', async () => {
      grantedParamWorkflow();
      mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '40' })).mockResolvedValueOnce(endTurn('done'));
      const result = await runGuardedSavedWorkflow(engine(), 'wf-vals', undefined, { origin: { kind: 'library' } });
      expect(result.grantNote).toBeUndefined();
      expect(posts().map((p) => p.url)).toEqual([TARGET]);
    });

    it('with another value for a parameter no constraint pins (task text only) runs without the grant', async () => {
      grantedParamWorkflow(true);
      mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '40' })).mockResolvedValueOnce(endTurn('done'));
      const result = await runGuardedSavedWorkflow(engine(), 'wf-vals', { week: '40', note: 'something else' }, { origin: { kind: 'library' } });
      expect(result.grantNote).toMatch(/other values than the ones the grant was accepted with/);
      expect(posts()).toEqual([]);
    });
  });

  it('a library start with other values than the schedule\'s does not run under the grant', async () => {
    const planned = history.insertPlannedPipeline({
      id: 'wf-param', name: 'wf-param', goal: 'g', reasoning: 'r', estimatedCost: 0, createdAt: '2026-10-01T00:00:00.000Z', template: true,
      steps: [{ id: 's1', task: 'post', tools: ['http_request'], input_template: { url: TARGET, body: '{{params.week}}' } }],
      ...{ mode: 'autonomous', parameters: [{ name: 'week', description: '', type: 'string', source: 'user_input' }] },
    } as Parameters<RunHistory['insertPlannedPipeline']>[0]);
    void planned;
    forgetPipeline('wf-param');
    const wf = getPipeline('wf-param', history)!;
    const shown = prepareWorkflowGrant(wf, { ...ENTRY, params: { week: '40' }, cron: CRON, afterUntrusted: false }, engineDb);
    if (!shown.ok) throw new Error(shown.error);
    const r = acceptWorkflowGrant(wf, { ...ENTRY, params: { week: '40' }, cron: CRON, afterUntrusted: false, checksum: shown.checksum, name: undefined, title: 't' }, 'local', { history, taskManager: tm, hasher: engineDb });
    expect(r.ok).toBe(true);
    forgetPipeline('wf-param');
    const result = await runGuardedSavedWorkflow(engine(), 'wf-param', { week: '41' }, { origin: { kind: 'library' } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/week/);
    expect(posts()).toEqual([]);
  });
});
