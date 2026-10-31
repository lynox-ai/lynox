/**
 * What a call's row says beyond the call itself (PRD 3f-1b-α): its outcome, where it
 * stood toward the run's contract, the grant that lifted its write, and how its filing ended.
 *
 * Two paths, because there are two writers of `run_tool_calls`:
 *  - a scheduled workflow under an accepted grant, end to end: the real acceptance, WorkerLoop,
 *    runManifest, the step Agent, the real `http_request` and its gates, and the step stream
 *    handler, down to the row in history.db. The step's row is built from the result event.
 *  - an Agent with a contract handed in directly, read at its own sink (the one a Session wires
 *    to history.db). Here the cases that need a precise order of turns and batches are built.
 * Mocked in both: the LLM and the network below `fetchPinned`.
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
import { RunHistory, callFactsOf, type ToolCallRecord } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { WorkerLoop } from './worker-loop.js';
import { createToolContext } from './tool-context.js';
import { setPinnedTransportForTests, type PinnedTransportInput } from './network-guard.js';
import { httpRequestTool } from '../tools/builtin/http.js';
import { askUserTool } from '../tools/builtin/ask-user.js';
import { getPipeline, _resetPipelineStore, forgetPipeline } from '../tools/builtin/pipeline.js';
import { _resetTenantInvariantForTests } from './saved-workflow-runner.js';
import { acceptWorkflowGrant, prepareWorkflowGrant } from './workflow-grant.js';
import type { CapabilityContract, PlannedPipeline, StreamEvent, ToolEntry, TriggerRecord } from '../types/index.js';
import { Agent } from './agent.js';
import { withAfterUntrusted, withGrantId } from '../types/capability-contract.js';
import { ApiStore } from './api-store.js';
import type { Engine } from './engine.js';
import type { CallContract, CallFiled, GrantLift } from './call-connection.js';
import { InputRequiredError } from './input-required.js';
import { UNATTENDED_BLOCK_ANSWER } from './prompt-store.js';
import { runManifest, buildRunCtx } from '../orchestrator/runner.js';
import type { LynoxUserConfig } from '../types/index.js';

const endTurn = (text: string) => ({
  content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
});
const toolUses = (calls: Array<{ name: string; input: unknown; id: string }>) => ({
  content: calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input })), stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
});
const toolUse = (name: string, input: unknown, id = 'tu_1') => toolUses([{ name, input, id }]);

const HOST = 'api.example.com';
const TARGET = `https://${HOST}/v1/reports`;
const CRON = '0 9 * * 1';
const ENTRY = { method: 'POST', host: HOST, paths: ['/v1/reports'] };

type Transport = (input: PinnedTransportInput) => Promise<Response>;
const ok: Transport = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

describe('a scheduled workflow under a grant writes each call\'s facts onto its row', () => {
  let dir: string;
  let history: RunHistory;
  let engineDb: EngineDb;
  let tm: TaskManager;
  let sent: PinnedTransportInput[];
  let transport: Transport;
  let restoreTransport: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess.mockReset();
    sent = [];
    transport = ok;
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    restoreTransport = setPinnedTransportForTests(async (input) => {
      sent.push(input);
      return transport(input);
    });
    dir = mkdtempSync(join(tmpdir(), 'lynox-call-facts-'));
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
    } as Parameters<RunHistory['insertPlannedPipeline']>[0], null);
    forgetPipeline(id);
    return getPipeline(id, history)!;
  }

  function accept(planned: PlannedPipeline): TriggerRecord {
    const shown = prepareWorkflowGrant(planned, { ...ENTRY, params: {}, cron: CRON, afterUntrusted: false }, engineDb);
    if (!shown.ok) throw new Error(shown.error);
    const r = acceptWorkflowGrant(planned, { ...ENTRY, params: {}, cron: CRON, afterUntrusted: false, checksum: shown.checksum, name: 'Ada', title: 'Weekly' }, 'local', { history, taskManager: tm, hasher: engineDb });
    if (!r.ok) throw new Error(r.error);
    forgetPipeline(planned.id);
    return r.task;
  }

  function stampedGrantId(workflowId: string): string {
    forgetPipeline(workflowId);
    const id = getPipeline(workflowId, history)?.reviewedGrant?.grantId;
    if (typeof id !== 'string') throw new Error('no grantId on the stamp');
    return id;
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
      getPromptStore: () => null,
      escalateToUser: () => null,
      getMandateEnds: () => null,
    } as unknown as Engine;
  }

  async function fire(trigger: TriggerRecord): Promise<void> {
    const loop = new WorkerLoop(engine(), { hasChannels: () => false, notify: vi.fn() } as never, 60_000);
    await (loop as unknown as { executePipeline: (t: TriggerRecord, starter: undefined, ownerStop: AbortSignal) => Promise<void> }).executePipeline(tm.getTrigger(trigger.id)!, undefined, new AbortController().signal);
  }

  const httpRows = (): ToolCallRecord[] =>
    history.getDb().prepare(`SELECT * FROM run_tool_calls WHERE tool_name = 'http_request' ORDER BY rowid`).all() as ToolCallRecord[];

  it('a GET under the grant: ok, governing, the accepted grant named, no lift, and not the connection\'s grant', async () => {
    const trigger = accept(saveWorkflow());
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'GET' })).mockResolvedValueOnce(endTurn('read'));
    await fire(trigger);
    const [row] = httpRows();
    expect(row).toBeDefined();
    expect(callFactsOf(row!)).toEqual({ recorded: true, status: 'ok', contract: 'governing', contractGrantId: stampedGrantId('wf-post'), lift: null, filing: null });
    // The connection column stays its own: no connection was resolved for this host.
    expect(row!.grant_id).toBeNull();
  });

  it('a POST the grant lets through carries the lift, and the lift names the accepted grant', async () => {
    const trigger = accept(saveWorkflow());
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('posted'));
    await fire(trigger);
    const grantId = stampedGrantId('wf-post');
    expect(sent.map((s) => s.method)).toEqual(['POST']);
    expect(callFactsOf(httpRows()[0]!)).toEqual({ recorded: true, status: 'ok', contract: 'governing', contractGrantId: grantId, lift: { grantId, entry: 'v1' }, filing: null });
  });

  it('a lifted POST whose send fails is recorded as an error and keeps its lift', async () => {
    const trigger = accept(saveWorkflow());
    transport = async (input) => {
      if (input.method === 'POST') throw new Error('connection reset by peer');
      return ok(input);
    };
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('failed'));
    await fire(trigger);
    const facts = callFactsOf(httpRows()[0]!);
    expect(facts).toMatchObject({ recorded: true, status: 'error', contract: 'governing', lift: { grantId: stampedGrantId('wf-post'), entry: 'v1' } });
  });

  it('a step of a nested pipeline writes the same facts, naming the grant the outer run was handed', async () => {
    const contract = withGrantId({ version: 1, grantedTools: ['http_request'], httpMethods: ['POST'], hostPatterns: [HOST], pathPatterns: ['/v1/reports'], paramConstraints: {} }, 'g-nested');
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('posted'));
    await runManifest({
      manifest_version: '1.0', name: 'nested-facts', triggered_by: 'test', context: {}, gate_points: [], on_failure: 'stop',
      agents: [{ id: 'outer', agent: 'outer', runtime: 'pipeline', pipeline: [{ id: 'inner', task: 'post the weekly report', tools: ['http_request'] }] }],
    }, { api_key: 'test-key' } as LynoxUserConfig, {
      ...buildRunCtx({ autonomy: 'autonomous', parentTools: [httpRequestTool], parentToolContext: createToolContext({}) }),
      runHistory: history, capabilityContract: contract, source: { kind: 'adhoc' as const },
    });
    expect(sent.map((s) => s.method)).toEqual(['POST']);
    const rows = httpRows();
    expect(rows).toHaveLength(1);
    // The row belongs to the inner run's step, two levels below the outer run.
    const stepRun = history.getDb().prepare(`SELECT spawn_depth FROM runs WHERE id = ?`).get(rows[0]!.run_id) as { spawn_depth: number } | undefined;
    expect(stepRun?.spawn_depth).toBe(2);
    expect(callFactsOf(rows[0]!)).toEqual({ recorded: true, status: 'ok', contract: 'governing', contractGrantId: 'g-nested', lift: { grantId: 'g-nested', entry: 'v1' }, filing: null });
  });
});

describe('an Agent with a contract reports each call\'s facts to its sink and on its result event', () => {
  const contractFor = (host: string, path: string): CapabilityContract => ({
    version: 1, grantedTools: ['http_request'], httpMethods: ['POST'], hostPatterns: [host], pathPatterns: [path], paramConstraints: {},
  });
  type Rec = { toolName: string; isError: boolean; contract?: CallContract; grant?: GrantLift; filed?: CallFiled };
  type Ev = Extract<StreamEvent, { type: 'tool_result' }>;
  let sent: PinnedTransportInput[];
  let restoreTransport: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess.mockReset();
    sent = [];
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    restoreTransport = setPinnedTransportForTests(async (input) => { sent.push(input); return ok(input); });
  });
  afterEach(() => restoreTransport());

  async function run(contract: CapabilityContract, turns: unknown[], opts: { toolContext?: ReturnType<typeof createToolContext>; tools?: ToolEntry[]; promptUser?: (q: string) => Promise<string> } = {}):
  Promise<{ recs: Rec[]; events: Ev[]; error: unknown }> {
    const recs: Rec[] = [];
    const events: Ev[] = [];
    for (const t of turns) mockProcess.mockResolvedValueOnce(t);
    mockProcess.mockResolvedValueOnce(endTurn('done'));
    const agent = new Agent({
      ...(opts.promptUser ? { promptUser: opts.promptUser } : {}),
      name: 'chat', model: 'claude-sonnet-4-6', tools: opts.tools ?? [httpRequestTool], autonomy: 'autonomous', capabilityContract: contract,
      toolContext: opts.toolContext ?? createToolContext({}),
      recordToolCall: (c) => { recs.push(c as Rec); },
      onStream: async (e) => { if (e.type === 'tool_result') events.push(e); },
    });
    let error: unknown;
    try { await agent.send('go'); } catch (e) { error = e; }
    return { recs, events, error };
  }

  function connectedAccount(): ReturnType<typeof createToolContext> {
    const store = new ApiStore();
    store.register({
      id: 'shop-api', name: 'Shop', base_url: 'https://example.com/v1', description: 'Shop API',
      auth: { type: 'oauth2', vault_keys: ['SHOP_CLIENT_ID', 'SHOP_CLIENT_SECRET'], oauth: { grant_type: 'refresh_token', client_id_key: 'SHOP_CLIENT_ID', client_secret_key: 'SHOP_CLIENT_SECRET', preset_id: 'example-shop', preset_params: { shop: 'acme' } } },
    });
    const ctx = createToolContext({});
    ctx.apiStore = store;
    return ctx;
  }

  it('a write the write gate refuses (a connected account) is a soft failure on the event and an error at the sink, under the governing contract', async () => {
    const { recs, events } = await run(withGrantId(contractFor('example.com', '/v1/report'), 'grant-shop'),
      [toolUse('http_request', { url: 'https://example.com/v1/report', method: 'POST', body: '{}' })], { toolContext: connectedAccount() });
    expect(sent.filter((s) => s.method === 'POST')).toEqual([]);
    expect(events[0]!.result).toContain('requires user consent but no interactive prompt is available');
    // The gate's refusal is a soft failure: the model reads it as a result, and so does the chat.
    expect(events[0]!.isError).toBeUndefined();
    expect(events[0]!.softFailure).toBe(true);
    expect(events[0]!.contract).toEqual({ state: 'governing', grantId: 'grant-shop' });
    expect(recs[0]).toEqual(expect.objectContaining({ isError: true, contract: { state: 'governing', grantId: 'grant-shop' } }));
    expect(recs[0]!.grant).toBeUndefined();
  });

  it('CONTROL: the same POST without the connected profile goes out, ok, lifted, on the event and at the sink', async () => {
    const { recs, events } = await run(withGrantId(contractFor('example.com', '/v1/report'), 'grant-shop'),
      [toolUse('http_request', { url: 'https://example.com/v1/report', method: 'POST', body: '{}' })]);
    expect(sent.map((s) => s.method)).toEqual(['POST']);
    expect(events[0]!.isError).toBeUndefined();
    expect(events[0]!.softFailure).toBeUndefined();
    expect(recs[0]).toEqual(expect.objectContaining({ isError: false, contract: { state: 'governing', grantId: 'grant-shop' }, grant: { grantId: 'grant-shop', entry: 'v1' } }));
  });

  it('a contract nobody accepted is governing without a grant id', async () => {
    const { recs } = await run(contractFor(HOST, '/v1/reports'), [toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })]);
    expect(recs[0]!.contract).toEqual({ state: 'governing' });
  });

  it('after a turn that read from outside, the next turn\'s write stands as withheld, naming the grant it held back', async () => {
    const { recs, events } = await run(withGrantId(contractFor(HOST, '/v1/reports'), 'grant-w'), [
      toolUse('http_request', { url: TARGET, method: 'GET' }, 'tu_get'),
      toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' }, 'tu_post'),
    ]);
    expect(sent.map((s) => s.method)).toEqual(['GET']);
    // The refused write's result event carries it; a step's row is built from that event.
    expect(events.map((e) => e.contract)).toEqual([{ state: 'governing', grantId: 'grant-w' }, { state: 'withheld', grantId: 'grant-w' }]);
    expect(events[1]!.isError).toBe(true);
    // At the agent's own sink only the GET is there, as before this change.
    expect(recs.map((r) => r.contract)).toEqual([{ state: 'governing', grantId: 'grant-w' }]);
  });

  it('a contract allowed to lift after foreign content stays governing in the next turn, and lifts', async () => {
    const { recs } = await run(withAfterUntrusted(withGrantId(contractFor(HOST, '/v1/reports'), 'grant-a'), true), [
      toolUse('http_request', { url: TARGET, method: 'GET' }, 'tu_get'),
      toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' }, 'tu_post'),
    ]);
    expect(sent.map((s) => s.method)).toEqual(['GET', 'POST']);
    expect(recs[1]).toEqual(expect.objectContaining({ isError: false, contract: { state: 'governing', grantId: 'grant-a' }, grant: { grantId: 'grant-a', entry: 'v1' } }));
  });

  it('in one batch, a GET that reads from outside does not turn its sibling write into withheld', async () => {
    const { recs } = await run(withGrantId(contractFor(HOST, '/v1/reports'), 'grant-b'), [
      toolUses([
        { name: 'http_request', input: { url: TARGET, method: 'GET' }, id: 'tu_get' },
        { name: 'http_request', input: { url: TARGET, method: 'POST', body: '{}' }, id: 'tu_post' },
      ]),
    ]);
    expect(sent.map((s) => s.method).sort()).toEqual(['GET', 'POST']);
    const post = recs.find((r) => r.grant !== undefined);
    expect(post).toBeDefined();
    expect(post!.contract).toEqual({ state: 'governing', grantId: 'grant-b' });
    expect(recs.map((r) => r.contract?.state)).toEqual(['governing', 'governing']);
  });

  it('a question ask_user cannot put to anyone carries the contract on its result', async () => {
    // ask_user raises in its handler, so its result is streamed there, inside the batch. The
    // case where the result is streamed only after the batch is the next one.
    const { events, error } = await run(withGrantId(contractFor(HOST, '/v1/reports'), 'grant-q'), [
      toolUses([
        { name: 'http_request', input: { url: TARGET, method: 'GET' }, id: 'tu_get' },
        { name: 'ask_user', input: { question: 'Which week?' }, id: 'tu_ask' },
      ]),
    ], { tools: [httpRequestTool, askUserTool] });
    expect(error).toBeDefined();
    const asked = events.find((e) => e.name === 'ask_user');
    expect(asked).toBeDefined();
    expect(asked!.contract).toEqual({ state: 'governing', grantId: 'grant-q' });
  });

  /** A tool the danger check asks about before its handler runs. */
  const confirmTool: ToolEntry = {
    definition: { name: 'note_send', description: 'send a note', input_schema: { type: 'object', properties: {}, additionalProperties: true } },
    destructive: { mode: 'external' },
    handler: async () => 'sent',
  } as unknown as ToolEntry;

  it('a consent question nobody can answer, raised before the handler and streamed after the batch, keeps the contract the call entered under', async () => {
    // The GET beside it arms the run's latch, and the batch's snapshot is gone by the time the
    // question's result is streamed. Read then, the contract would be withheld; the call entered
    // under the governing one.
    const { events, error } = await run(withGrantId(contractFor(HOST, '/v1/reports'), 'grant-c'), [
      toolUses([
        { name: 'http_request', input: { url: TARGET, method: 'GET' }, id: 'tu_get' },
        { name: 'note_send', input: { text: 'hi' }, id: 'tu_note' },
      ]),
    ], { tools: [httpRequestTool, confirmTool], promptUser: async () => { throw new InputRequiredError('Allow note_send?'); } });
    expect(error).toBeInstanceOf(InputRequiredError);
    expect(sent.map((s) => s.method)).toEqual(['GET']);
    const asked = events.find((e) => e.name === 'note_send');
    expect(asked).toBeDefined();
    expect(asked!.isError).toBe(true);
    expect(asked!.contract).toEqual({ state: 'governing', grantId: 'grant-c' });
    // That a read after the batch would say withheld is shown by the mutants that read it there
    // (no memo, no capture at entry): both fail this test.
  });

  it('a call blocked in a run nobody watches carries the contract on its refusal', async () => {
    const { events } = await run(withGrantId(contractFor(HOST, '/v1/reports'), 'grant-u'),
      [toolUse('note_send', { text: 'hi' }, 'tu_note')], { tools: [httpRequestTool, confirmTool], promptUser: async () => UNATTENDED_BLOCK_ANSWER });
    expect(events).toHaveLength(1);
    expect(events[0]!.result).toContain('in a run nobody watches it is not queued');
    expect(events[0]!.contract).toEqual({ state: 'governing', grantId: 'grant-u' });
  });

  it('a call skipped as a repeat carries the contract on its result', async () => {
    const get = (id: string) => toolUse('http_request', { url: TARGET, method: 'GET' }, id);
    const { events } = await run(withGrantId(contractFor(HOST, '/v1/reports'), 'grant-r'), [get('g1'), get('g2'), get('g3'), get('g4')]);
    expect(sent).toHaveLength(3);
    expect(events).toHaveLength(4);
    expect(events[3]!.result).toContain('Do NOT call it again');
    expect(events[3]!.contract).toEqual({ state: 'withheld', grantId: 'grant-r' });
  });
});

// v71: the API request a call sent rides the same two ways — to the sink a Session wires to
// history.db, and on the result event the step recorder builds a workflow step's row from.
describe('an Agent reports the API request a call sent, with its cost, to its sink and on its result event', () => {
  let restoreTransport: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess.mockReset();
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    restoreTransport = setPinnedTransportForTests(async () => new Response('{"cost":0.09,"tasks":[]}', { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  afterEach(() => restoreTransport());

  async function run(url: string): Promise<{ recs: Array<{ apiCost?: unknown }>; events: Array<Extract<StreamEvent, { type: 'tool_result' }>> }> {
    const store = new ApiStore();
    store.register({ id: 'dataforseo', name: 'DataForSEO', base_url: 'https://api.dataforseo.com', description: 'SEO API', cost: { model: 'per_call', rate_usd: 0.001, response_field: 'cost' } });
    const ctx = createToolContext({});
    ctx.apiStore = store;
    const recs: Array<{ apiCost?: unknown }> = [];
    const events: Array<Extract<StreamEvent, { type: 'tool_result' }>> = [];
    mockProcess.mockResolvedValueOnce(toolUses([{ name: 'http_request', input: { url }, id: 'tu-1' }]));
    mockProcess.mockResolvedValueOnce(endTurn('done'));
    const agent = new Agent({
      name: 'chat', model: 'claude-sonnet-4-6', tools: [httpRequestTool], autonomy: 'autonomous', toolContext: ctx,
      recordToolCall: (c) => { recs.push(c); },
      onStream: async (e) => { if (e.type === 'tool_result') events.push(e); },
    });
    await agent.send('go');
    return { recs, events };
  }

  it('a GET to an API with a cost: the provider\'s figure, at the sink and on the event', async () => {
    const { recs, events } = await run('https://api.dataforseo.com/v3/keywords');
    expect(recs[0]!.apiCost).toEqual({ usd: 0.09, source: 'response' });
    expect(events[0]!.apiCost).toEqual({ usd: 0.09, source: 'response' });
  });

  it('CONTROL: the same GET to a host without a cost carries none', async () => {
    const { recs, events } = await run('https://example.com/v1/x');
    expect(recs[0]).not.toHaveProperty('apiCost');
    expect(events[0]).not.toHaveProperty('apiCost');
  });
});
