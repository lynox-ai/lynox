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
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
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
import { getPipeline, _resetPipelineStore, forgetPipeline, storePipeline, runSavedWorkflow } from '../tools/builtin/pipeline.js';
import { _resetTenantInvariantForTests, runGuardedSavedWorkflow } from './saved-workflow-runner.js';
import { acceptWorkflowGrant, prepareWorkflowGrant } from './workflow-grant.js';
import type { IAgent, PlannedPipeline, ToolEntry, TriggerRecord } from '../types/index.js';
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

  function saveWorkflow(id = 'wf-post', steps: PlannedPipeline['steps'] = [{ id: 's1', task: 'post the weekly report', tools: ['http_request'] }]): PlannedPipeline {
    history.insertPlannedPipeline({
      id, name: id, goal: 'post the weekly report', reasoning: 'r', estimatedCost: 0,
      createdAt: '2026-10-01T00:00:00.000Z', template: true,
      steps,
      ...{ mode: 'autonomous', parameters: [] },
    } as Parameters<RunHistory['insertPlannedPipeline']>[0], null);
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

  // A stored memory the run can read: what a person approved earlier, not the run's own text.
  let recalls = 0;
  // Whom the step agent that called it was built for (1055).
  let recalledAs: unknown[] = [];
  const memoryRecallTool: ToolEntry = {
    definition: { name: 'memory_recall', description: 'recall', input_schema: { type: 'object' as const, properties: {} } },
    handler: async (_input: unknown, agent: IAgent) => { recalls++; recalledAs.push(agent.principal); return '- the weekly report goes to finance'; },
  };

  function engine(): Engine {
    const ctx = createToolContext({});
    ctx.tools = [httpRequestTool, memoryRecallTool];
    return {
      getTaskManager: () => tm,
      getUserConfig: () => ({ api_key: 'test-key' }),
      getContext: () => null,
      getHooks: () => [],
      getToolContext: () => ctx,
      getMemory: () => null,
      getRunHistory: () => history,
      getEngineDb: () => engineDb,
      // No grant ends here: the plan pause (on by default) finds nothing to pause.
      getMandateEnds: () => null,
      getSecretStore: () => null,
      getPromptStore: () => null,
      escalateToUser: () => null,
    } as unknown as Engine;
  }

  async function fire(trigger: TriggerRecord, starter?: RequestPrincipal): Promise<void> {
    const loop = new WorkerLoop(engine(), { hasChannels: () => false, notify } as never, 60_000);
    await (loop as unknown as { executePipeline: (t: TriggerRecord, starter: RequestPrincipal | undefined, ownerStop: AbortSignal) => Promise<void> }).executePipeline(tm.getTrigger(trigger.id)!, starter, new AbortController().signal);
  }

  const posts = (): PinnedTransportInput[] => sent.filter((s) => s.method === 'POST');
  const lastRun = (id: string): string => tm.getTrigger(id)?.last_run_result ?? '';

  it('verify-done: a workflow granted over the acceptance runs on its schedule, and the POST reaches the host', async () => {
    const trigger = accept(saveWorkflow());
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{"week":40}' })).mockResolvedValueOnce(endTurn('posted'));
    await fire(trigger);
    expect(posts().map((p) => p.url)).toEqual([TARGET]);
    expect(lastRun(trigger.id)).toContain('Workflow completed');
  });

  describe('a headless run carries whom it is for down to its step agents (1055)', () => {
    const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'eva@kanzlei.example', mandateId: 'grant-eva' };
    beforeEach(() => { recalledAs = []; });
    function scheduled(steps: PlannedPipeline['steps']): TriggerRecord {
      const planned = saveWorkflow('wf-for', steps);
      history.setWorkflowConfirmedAt(planned.id, '2026-10-01T00:00:00.000Z');
      forgetPipeline(planned.id);
      return tm.createPipelineTask({ title: 'Weekly', pipelineId: planned.id, scheduleCron: CRON, pipelineParams: '{}' });
    }

    it('a run for a mandate builds its step agent for that mandate', async () => {
      const trigger = scheduled([{ id: 's1', task: 'recall where the report goes', tools: ['memory_recall'] }]);
      mockProcess.mockResolvedValueOnce(toolUse('memory_recall', {})).mockResolvedValueOnce(endTurn('finance'));
      await fire(trigger, MANDATE);
      expect(recalledAs).toEqual([MANDATE]);
      expect(lastRun(trigger.id)).toContain('Pipeline completed');
    });

    it('CONTROL: the same run with no one named builds its step agent for the owner', async () => {
      const trigger = scheduled([{ id: 's1', task: 'recall where the report goes', tools: ['memory_recall'] }]);
      mockProcess.mockResolvedValueOnce(toolUse('memory_recall', {})).mockResolvedValueOnce(endTurn('finance'));
      await fire(trigger);
      expect(recalledAs).toEqual([OWNER_PRINCIPAL]);
    });

    it('a run for a mandate refuses a step that names a tool the mandate\'s lock withholds, before the model is asked', async () => {
      const trigger = scheduled([{ id: 's1', task: 'clean up', tools: ['bash'] }]);
      await fire(trigger, MANDATE);
      expect(mockProcess).not.toHaveBeenCalled();
      const [run] = history.getRecentPipelineRuns(1);
      expect(history.getPipelineStepResults(run!.id).map((r) => r.error ?? '').join('\n')).toContain('needs bash');
    });

    it('CONTROL: the owner\'s run of that step is not refused for it', async () => {
      const trigger = scheduled([{ id: 's1', task: 'clean up', tools: ['bash'] }]);
      mockProcess.mockResolvedValueOnce(endTurn('nothing to clean'));
      await fire(trigger);
      expect(lastRun(trigger.id)).not.toContain('needs bash');
      expect(mockProcess).toHaveBeenCalled();
    });
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

  it('a write the grant refuses for its header is not sent, and the owner\'s run record names the header, not its value', async () => {
    const trigger = accept(saveWorkflow());
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', headers: { Prefer: 'respond-async-zq7' }, body: '{}' })).mockResolvedValueOnce(endTurn('done'));
    await fire(trigger);
    expect(posts()).toEqual([]);
    expect(lastRun(trigger.id)).toContain(`Not granted for an unattended run: POST ${TARGET}. It sets a header "Prefer", which a run under a reviewed grant may not set.`);
    expect(lastRun(trigger.id)).not.toContain('respond-async-zq7');
  });

  it('CONTROL: the same write with a header the grant allows reaches the host', async () => {
    const trigger = accept(saveWorkflow());
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', headers: { 'Idempotency-Key': 'k-1' }, body: '{}' })).mockResolvedValueOnce(endTurn('posted'));
    await fire(trigger);
    expect(posts().map((p) => p.url)).toEqual([TARGET]);
    expect(lastRun(trigger.id)).not.toContain('sets a header');
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
      { name: 'creator', model: 'claude-haiku-4-5-20251001', memory: null, tools: [], onStream: null, toolContext: ctx, principal: OWNER_PRINCIPAL } as unknown as IAgent,
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

  describe('after a step has read stored memory', () => {
    // Step one reads memory, step two writes. The read is foreign content for the grant, and
    // the run carries that to the step that writes.
    const steps: PlannedPipeline['steps'] = [
      { id: 's1', task: 'look up who gets the weekly report', tools: ['memory_recall'] },
      { id: 's2', task: 'post the weekly report', tools: ['http_request'], input_from: ['s1'] },
    ];
    function recallThenPost(): void {
      recalls = 0;
      mockProcess
        .mockResolvedValueOnce(toolUse('memory_recall', {}, 'tu_recall'))
        .mockResolvedValueOnce(endTurn('finance'))
        .mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' }, 'tu_post'))
        .mockResolvedValueOnce(endTurn('done'));
    }

    it('a grant without afterUntrusted does not lift the write', async () => {
      const trigger = accept(saveWorkflow('wf-mem', steps), false);
      recallThenPost();
      await fire(trigger);
      expect(posts()).toEqual([]);
      expect(lastRun(trigger.id)).toMatch(/read external content before this call/);
    });

    it('a grant with afterUntrusted does', async () => {
      const trigger = accept(saveWorkflow('wf-mem', steps), true);
      recallThenPost();
      await fire(trigger);
      expect(recalls).toBe(1);
      expect(posts().map((p) => p.url)).toEqual([TARGET]);
    });

    // Two paths refuse here: the step's own dispatch, and the run taint arming the live step
    // through the getter. Either alone holds, so this fails only when both are gone; the
    // agent tests pin each path by itself.
    it('a single step that reads memory and then writes does not lift the write either', async () => {
      const oneStep: PlannedPipeline['steps'] = [
        { id: 's1', task: 'look up who gets the weekly report, then post it', tools: ['memory_recall', 'http_request'] },
      ];
      const trigger = accept(saveWorkflow('wf-mem-one', oneStep), false);
      recalls = 0;
      mockProcess
        .mockResolvedValueOnce(toolUse('memory_recall', {}, 'tu_recall'))
        .mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' }, 'tu_post'))
        .mockResolvedValueOnce(endTurn('done'));
      await fire(trigger);
      expect(recalls).toBe(1);
      expect(posts()).toEqual([]);
      expect(lastRun(trigger.id)).toMatch(/read external content before this call/);
    });
  });

  it('a person\'s library start runs under the grant, with the schedule\'s cron and values', async () => {
    const planned = saveWorkflow();
    accept(planned);
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('done'));
    const result = await runGuardedSavedWorkflow(engine(), planned.id, undefined, { principal: OWNER_PRINCIPAL, origin: { kind: 'library', by: 'local' } });
    expect(result.ok).toBe(true);
    expect(posts().map((p) => p.url)).toEqual([TARGET]);
  });

  it('CONTROL: the same start without an origin (any other caller) runs without the grant', async () => {
    const planned = saveWorkflow();
    accept(planned);
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('done'));
    const result = await runGuardedSavedWorkflow(engine(), planned.id, undefined, { principal: OWNER_PRINCIPAL });
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

  it('a number parameter left at a text default runs on its schedule under the grant', async () => {
    // The binder keeps a default as written ("10") but coerces a supplied value (10); the
    // schedule's run supplies the stored values. Granted as "10", it would be refused by
    // its own enum on every run.
    history.insertPlannedPipeline({
      id: 'wf-default', name: 'wf-default', goal: 'g', reasoning: 'r', estimatedCost: 0, createdAt: '2026-10-01T00:00:00.000Z', template: true,
      steps: [{ id: 's1', task: 'post the batch', tools: ['http_request'], input_template: { url: TARGET, body: '{{params.limit}}' } }],
      ...{ mode: 'autonomous', parameters: [{ name: 'limit', description: '', type: 'number', source: 'user_input', defaultValue: '10' }] },
    } as Parameters<RunHistory['insertPlannedPipeline']>[0], null);
    forgetPipeline('wf-default');
    const wf = getPipeline('wf-default', history)!;
    const shown = prepareWorkflowGrant(wf, { ...ENTRY, params: {}, cron: CRON, afterUntrusted: false }, engineDb);
    if (!shown.ok) throw new Error(shown.error);
    const r = acceptWorkflowGrant(wf, { ...ENTRY, params: {}, cron: CRON, afterUntrusted: false, checksum: shown.checksum, name: undefined, title: 't' }, 'local', { history, taskManager: tm, hasher: engineDb });
    if (!r.ok) throw new Error(r.error);
    forgetPipeline('wf-default');
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '10' })).mockResolvedValueOnce(endTurn('done'));
    await fire(r.task);
    expect(posts().map((p) => p.url)).toEqual([TARGET]);
  });

  describe('a library start of a workflow with parameters', () => {
    // `withTaskParam`: a second parameter that reaches only the step's task text. Under the
    // grant, the accepted value goes into the step's prompt without the untrusted-data
    // boundary (`resolveTaskTemplate` with the grant's matcher); any other value keeps it.
    function grantedParamWorkflow(withTaskParam = false): void {
      history.insertPlannedPipeline({
        id: 'wf-vals', name: 'wf-vals', goal: 'g', reasoning: 'r', estimatedCost: 0, createdAt: '2026-10-01T00:00:00.000Z', template: true,
        steps: [{ id: 's1', task: withTaskParam ? 'post the week, mention {{params.note}}' : 'post the week', tools: ['http_request'], input_template: { url: TARGET, body: '{{params.week}}' } }],
        ...{ mode: 'autonomous', parameters: [
          { name: 'week', description: '', type: 'string', source: 'user_input' },
          { name: 'note', description: '', type: 'string', source: 'user_input' },
        ] },
      } as Parameters<RunHistory['insertPlannedPipeline']>[0], null);
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
      const result = await runGuardedSavedWorkflow(engine(), 'wf-vals', undefined, { principal: OWNER_PRINCIPAL, origin: { kind: 'library', by: 'local' } });
      expect(result.grantNote).toBeUndefined();
      expect(posts().map((p) => p.url)).toEqual([TARGET]);
    });

    it('with another value for a parameter no constraint pins (task text only) runs without the grant', async () => {
      grantedParamWorkflow(true);
      mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '40' })).mockResolvedValueOnce(endTurn('done'));
      const result = await runGuardedSavedWorkflow(engine(), 'wf-vals', { week: '40', note: 'something else' }, { principal: OWNER_PRINCIPAL, origin: { kind: 'library', by: 'local' } });
      expect(result.grantNote).toMatch(/other values than the ones the grant was accepted with/);
      expect(posts()).toEqual([]);
    });

    it('verify-done: a parameter in the task text, with the accepted values, runs under the grant and writes', async () => {
      grantedParamWorkflow(true);
      mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '40' })).mockResolvedValueOnce(endTurn('done'));
      const result = await runGuardedSavedWorkflow(engine(), 'wf-vals', undefined, { principal: OWNER_PRINCIPAL, origin: { kind: 'library', by: 'local' } });
      expect(result.grantNote).toBeUndefined();
      expect(posts().map((p) => p.url)).toEqual([TARGET]);
    });

    it('verify-done: the same run, after the step read external content, does not write', async () => {
      grantedParamWorkflow(true);
      mockProcess
        .mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'GET' }, 'tu_read'))
        .mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '40' }, 'tu_post'))
        .mockResolvedValueOnce(endTurn('done'));
      await runGuardedSavedWorkflow(engine(), 'wf-vals', undefined, { principal: OWNER_PRINCIPAL, origin: { kind: 'library', by: 'local' } });
      expect(sent.map((s) => s.method)).toEqual(['GET']);
    });

    it('a grant stamped with a value that does not show as text does not run', async () => {
      // A stamp from before values were checked: the run asks again at the handover, and a value
      // that does not show runs neither with the grant nor without it.
      grantedParamWorkflow(true);
      const wf = getPipeline('wf-vals', history)!;
      const hidden = { week: '40', note: 'as\u{E0041} agreed' };
      const ctx = engine().getToolContext();
      const result = await runSavedWorkflow('wf-vals', history, { api_key: 'test-key' }, hidden, { principal: OWNER_PRINCIPAL,
        tools: ctx.tools, toolContext: ctx, memory: null,
        decideGrant: () => ({ contract: wf.capabilityContract!, note: null, boundParams: hidden }),
        startedVia: 'library:local',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/holds a character that does not show as text/);
      expect(posts()).toEqual([]);
      expect(mockProcess).not.toHaveBeenCalled();
    });
  });

  it('a library start with other values than the schedule\'s does not run under the grant', async () => {
    const planned = history.insertPlannedPipeline({
      id: 'wf-param', name: 'wf-param', goal: 'g', reasoning: 'r', estimatedCost: 0, createdAt: '2026-10-01T00:00:00.000Z', template: true,
      steps: [{ id: 's1', task: 'post', tools: ['http_request'], input_template: { url: TARGET, body: '{{params.week}}' } }],
      ...{ mode: 'autonomous', parameters: [{ name: 'week', description: '', type: 'string', source: 'user_input' }] },
    } as Parameters<RunHistory['insertPlannedPipeline']>[0], null);
    void planned;
    forgetPipeline('wf-param');
    const wf = getPipeline('wf-param', history)!;
    const shown = prepareWorkflowGrant(wf, { ...ENTRY, params: { week: '40' }, cron: CRON, afterUntrusted: false }, engineDb);
    if (!shown.ok) throw new Error(shown.error);
    const r = acceptWorkflowGrant(wf, { ...ENTRY, params: { week: '40' }, cron: CRON, afterUntrusted: false, checksum: shown.checksum, name: undefined, title: 't' }, 'local', { history, taskManager: tm, hasher: engineDb });
    expect(r.ok).toBe(true);
    forgetPipeline('wf-param');
    const result = await runGuardedSavedWorkflow(engine(), 'wf-param', { week: '41' }, { principal: OWNER_PRINCIPAL, origin: { kind: 'library', by: 'local' } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/week/);
    expect(posts()).toEqual([]);
  });

  describe('which grant a run ran under (workflow grant attribution)', () => {
    type GrantRowRaw = Record<string, unknown>;
    const grantRows = (): GrantRowRaw[] =>
      engineDb.getDb().prepare('SELECT * FROM workflow_grants ORDER BY rowid').all() as GrantRowRaw[];
    const runRows = (): Array<{ id: string; parent_run_id: string | null; workflow_grant_id: string | null; started_via: string | null }> =>
      history.getDb().prepare('SELECT id, parent_run_id, workflow_grant_id, started_via FROM pipeline_runs ORDER BY started_at, rowid').all() as Array<{ id: string; parent_run_id: string | null; workflow_grant_id: string | null; started_via: string | null }>;
    const stampOf = (id: string) => { forgetPipeline(id); return getPipeline(id, history)!.reviewedGrant!; };

    it('verify-done: two workflows defined alike get two rows, and accepting one again a third, leaving the two as they were', () => {
      accept(saveWorkflow('wf-a'));
      accept(saveWorkflow('wf-b'));
      const before = grantRows();
      expect(before).toHaveLength(2);
      // Same contract, steps and schedule: the checksum is the same, the grant is not.
      expect(before[0]!['checksum']).toBe(before[1]!['checksum']);
      expect(before[0]!['id']).not.toBe(before[1]!['id']);
      accept(getPipeline('wf-a', history)!);
      const after = grantRows();
      expect(after).toHaveLength(3);
      expect(after.slice(0, 2)).toEqual(before);
      // The stamp names the newest row; the row is the acceptance as shown.
      expect(stampOf('wf-a').grantId).toBe(after[2]!['id']);
      expect(after[2]).toMatchObject({ workflow_id: 'wf-a', accepted_by: 'local', name: 'Ada', cron: CRON, bound_params_json: '{}', after_untrusted: 0 });
    });

    it('verify-done: a workflow deleted between reading and accepting leaves no row, no stamp and no schedule', () => {
      const planned = saveWorkflow('wf-gone');
      history.deletePlannedPipeline('wf-gone');
      const shown = prepareWorkflowGrant(planned, { ...ENTRY, params: {}, cron: CRON, afterUntrusted: false }, engineDb);
      if (!shown.ok) throw new Error(shown.error);
      const r = acceptWorkflowGrant(planned, { ...ENTRY, params: {}, cron: CRON, afterUntrusted: false, checksum: shown.checksum, name: 'Ada', title: 'W' }, 'local', { history, taskManager: tm, hasher: engineDb });
      expect(r).toMatchObject({ ok: false, status: 500 });
      expect(grantRows()).toEqual([]);
      expect(tm.listTriggers()).toEqual([]);
    });

    it('verify-done: a row that cannot be written leaves no stamp and no schedule', () => {
      const planned = saveWorkflow('wf-norow');
      engineDb.getDb().exec('DROP TABLE workflow_grants');
      const shown = prepareWorkflowGrant(planned, { ...ENTRY, params: {}, cron: CRON, afterUntrusted: false }, engineDb);
      if (!shown.ok) throw new Error(shown.error);
      const r = acceptWorkflowGrant(planned, { ...ENTRY, params: {}, cron: CRON, afterUntrusted: false, checksum: shown.checksum, name: 'Ada', title: 'W' }, 'local', { history, taskManager: tm, hasher: engineDb });
      expect(r).toMatchObject({ ok: false, status: 500 });
      forgetPipeline('wf-norow');
      expect(getPipeline('wf-norow', history)!.reviewedGrant).toBeUndefined();
      expect(getPipeline('wf-norow', history)!.capabilityContract).toBeUndefined();
      expect(tm.listTriggers()).toEqual([]);
    });

    it('a row stays byte for byte as written, through a later acceptance and through deleting its workflow', () => {
      accept(saveWorkflow('wf-keep'));
      const first = grantRows();
      accept(getPipeline('wf-keep', history)!);
      const both = grantRows();
      expect(both[0]).toEqual(first[0]);
      history.deletePlannedPipeline('wf-keep');
      // A foreign key would have refused the delete, or deleted or changed the rows.
      expect(getPipeline('wf-keep', history)).toBeUndefined();
      expect(grantRows()).toEqual(both);
    });

    it('verify-done: a scheduled run records the grant and its schedule; the same workflow without a grant records neither', async () => {
      const trigger = accept(saveWorkflow('wf-run'));
      mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('posted'));
      await fire(trigger);
      expect(posts()).toHaveLength(1);
      const granted = runRows();
      expect(granted).toHaveLength(1);
      expect(granted[0]).toMatchObject({ workflow_grant_id: stampOf('wf-run').grantId, started_via: `schedule:${trigger.id}` });

      const plain = saveWorkflow('wf-plain');
      history.setWorkflowConfirmedAt(plain.id, '2026-10-01T00:00:00.000Z');
      forgetPipeline(plain.id);
      const t2 = tm.createPipelineTask({ title: 'Plain', pipelineId: plain.id, scheduleCron: CRON, pipelineParams: '{}' });
      mockProcess.mockResolvedValueOnce(endTurn('nothing to do'));
      await fire(t2);
      const rows = runRows();
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ workflow_grant_id: null, started_via: null });
    });

    it('a schedule the owner runs with "Run now" records schedule-hand, a library start the auth origin', async () => {
      const trigger = accept(saveWorkflow('wf-how'));
      mockProcess.mockResolvedValueOnce(endTurn('done'));
      // The real entry point of POST /api/triggers/:id/run, without a marker: the owner's press.
      const loop = new WorkerLoop(engine(), { hasChannels: () => false, notify } as never, 60_000);
      expect(await loop.runTriggerNow(trigger.id)).toEqual({ ok: true });
      await vi.waitFor(() => expect(runRows()).toHaveLength(1));
      await vi.waitFor(() => expect(lastRun(trigger.id)).toContain('Workflow completed'));
      mockProcess.mockResolvedValueOnce(endTurn('done'));
      const lib = await runGuardedSavedWorkflow(engine(), 'wf-how', undefined, { principal: OWNER_PRINCIPAL, origin: { kind: 'library', by: 'cookie:0123abcd' } });
      expect(lib.grantNote).toBeUndefined();
      const grantId = stampOf('wf-how').grantId;
      expect(runRows().map((r) => [r.workflow_grant_id, r.started_via])).toEqual([
        [grantId, `schedule-hand:${trigger.id}`],
        [grantId, 'library:cookie:0123abcd'],
      ]);
    });

    it('verify-done: a run under a grant whose run row cannot be written does not write, and says why; with the row it does', async () => {
      const trigger = accept(saveWorkflow('wf-unrecorded'));
      const insert = vi.spyOn(history, 'insertPipelineRun').mockImplementationOnce(() => { throw new Error('SQLITE_FULL'); });
      mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('done'));
      const refused = await runGuardedSavedWorkflow(engine(), 'wf-unrecorded', undefined, { principal: OWNER_PRINCIPAL, origin: { kind: 'library', by: 'local' } });
      expect(posts()).toEqual([]);
      expect(refused.grantNote).toMatch(/could not be recorded/);
      // CONTROL: the same grant, the row written — the POST goes out.
      insert.mockRestore();
      mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('done'));
      await fire(trigger);
      expect(posts().map((p) => p.url)).toEqual([TARGET]);
      expect(lastRun(trigger.id)).not.toMatch(/could not be recorded/);
    });

    it('a run whose acceptance row is gone runs without the grant, and does not write', async () => {
      const trigger = accept(saveWorkflow('wf-rowgone'));
      engineDb.getDb().prepare('DELETE FROM workflow_grants WHERE workflow_id = ?').run('wf-rowgone');
      mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('done'));
      await fire(trigger);
      expect(posts()).toEqual([]);
      expect(lastRun(trigger.id)).toMatch(/record of its acceptance is missing/);
    });

    it('verify-done: the reader tells found, missing and unavailable apart', () => {
      accept(saveWorkflow('wf-read'));
      const grantId = stampOf('wf-read').grantId!;
      expect(history.readWorkflowGrant(grantId)).toMatchObject({ state: 'found', grant: { grantId, workflowId: 'wf-read', by: 'local', name: 'Ada' } });
      expect(history.readWorkflowGrant('no-such-grant')).toEqual({ state: 'missing', grantId: 'no-such-grant' });
      const bare = new RunHistory(join(dir, 'bare-history.db'));
      try {
        expect(bare.readWorkflowGrant(grantId)).toEqual({ state: 'unavailable', grantId });
      } finally { bare.close(); }
      // A row whose binding is neither value is unreadable, not unkeyed.
      engineDb.getDb().prepare("UPDATE workflow_grants SET binding = 'garbled' WHERE id = ?").run(grantId);
      expect(history.readWorkflowGrant(grantId)).toEqual({ state: 'unavailable', grantId });
      engineDb.close();
      expect(history.readWorkflowGrant(grantId)).toEqual({ state: 'unavailable', grantId });
    });

    it('the run read API does not send how a run was started (it holds an auth-origin label)', async () => {
      accept(saveWorkflow('wf-api'));
      mockProcess.mockResolvedValueOnce(endTurn('done'));
      const r = await runGuardedSavedWorkflow(engine(), 'wf-api', undefined, { principal: OWNER_PRINCIPAL, origin: { kind: 'library', by: 'cookie:0123abcd' } });
      // CONTROL: the row holds both.
      expect(runRows()[0]).toMatchObject({ started_via: 'library:cookie:0123abcd' });
      const read = history.getPipelineRun(r.runId!) as Record<string, unknown>;
      expect(read['id']).toBe(r.runId);
      expect(read).not.toHaveProperty('started_via');
      expect(read).not.toHaveProperty('workflow_grant_id');
    });

    it('the owner\'s erasure empties the grant rows (pinned, not a mutation target)', () => {
      accept(saveWorkflow('wf-erase'));
      expect(grantRows()).toHaveLength(1);
      engineDb.deleteAllData();
      expect(grantRows()).toEqual([]);
    });
  });
});
