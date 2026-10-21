/**
 * The mark a write grant leaves on the call it let through, end to end.
 *
 * Real: the acceptance (`acceptWorkflowGrant`), WorkerLoop.executePipeline, the saved-workflow
 * run and its grant decision, runManifest, spawnInline, the step Agent, the real `http_request`
 * tool and its write gate, and the step stream handler that builds the step record. Mocked: the
 * LLM (it answers with the tool calls a step would make) and the network below `fetchPinned`.
 * `runManifest` is wrapped only to tee its `observeToolCall`, the seam the run already hands
 * every step record to; the run itself is the real one.
 *
 * What is pinned: the mark is present exactly when the write gate let a write through on a
 * grant, it names that acceptance, and it says nothing about the outcome.
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

type StepRecord = { toolName: string; outputJson: string; isError: boolean; grant?: { grantId: string; entry: 'v1' } | undefined };
const observed = vi.hoisted(() => ({ records: [] as StepRecord[] }));
vi.mock('../orchestrator/runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator/runner.js')>();
  return {
    ...real,
    runManifest: (manifest: Parameters<typeof real.runManifest>[0], config: Parameters<typeof real.runManifest>[1], options?: Parameters<typeof real.runManifest>[2]) =>
      real.runManifest(manifest, config, { source: { kind: 'adhoc' as const },
        ...options,
        observeToolCall: (call) => {
          observed.records.push(call as StepRecord);
          options?.observeToolCall?.(call);
        },
      }),
  };
});

import dns from 'node:dns/promises';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { WorkerLoop } from './worker-loop.js';
import { createToolContext } from './tool-context.js';
import { setPinnedTransportForTests, type PinnedTransportInput } from './network-guard.js';
import { httpRequestTool } from '../tools/builtin/http.js';
import { getPipeline, _resetPipelineStore, forgetPipeline } from '../tools/builtin/pipeline.js';
import { _resetTenantInvariantForTests } from './saved-workflow-runner.js';
import { acceptWorkflowGrant, prepareWorkflowGrant } from './workflow-grant.js';
import type { CapabilityContract, PlannedPipeline, StreamEvent, TriggerRecord } from '../types/index.js';
import { Agent } from './agent.js';
import { withGrantId } from '../types/capability-contract.js';
import { ApiStore } from './api-store.js';
import type { Engine } from './engine.js';

const endTurn = (text: string) => ({
  content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
});
const toolUses = (calls: Array<{ name: string; input: unknown; id: string }>) => ({
  content: calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input })), stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
});
const toolUse = (name: string, input: unknown, id = 'tu_1') => toolUses([{ name, input, id }]);

const HOST = 'api.example.com';
const TARGET = `https://${HOST}/v1/reports`;
const OTHER_PATH = `https://${HOST}/v1/other`;
const CRON = '0 9 * * 1';
const ENTRY = { method: 'POST', host: HOST, paths: ['/v1/reports'] };

type Transport = (input: PinnedTransportInput) => Promise<Response>;
const ok: Transport = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

describe('a grant marks the call whose write it let through, and no other', () => {
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
    observed.records.length = 0;
    sent = [];
    transport = ok;
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    restoreTransport = setPinnedTransportForTests(async (input) => {
      sent.push(input);
      return transport(input);
    });
    dir = mkdtempSync(join(tmpdir(), 'lynox-grant-mark-'));
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

  /** The `grantId` the stamp of `workflowId` names right now (`workflow_grants.id`). */
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
    } as unknown as Engine;
  }

  async function fire(trigger: TriggerRecord): Promise<void> {
    const loop = new WorkerLoop(engine(), { hasChannels: () => false, notify: vi.fn() } as never, 60_000);
    await (loop as unknown as { executePipeline: (t: TriggerRecord, starter: undefined, ownerStop: AbortSignal) => Promise<void> }).executePipeline(tm.getTrigger(trigger.id)!, undefined, new AbortController().signal);
  }

  const httpRecords = (): StepRecord[] => observed.records.filter((r) => r.toolName === 'http_request');
  const posts = (): PinnedTransportInput[] => sent.filter((s) => s.method === 'POST');

  it('a POST the grant lets through carries the grant that lifted it, in the step record', async () => {
    const trigger = accept(saveWorkflow());
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{"week":40}' })).mockResolvedValueOnce(endTurn('posted'));
    await fire(trigger);
    expect(posts().map((p) => p.url)).toEqual([TARGET]);
    expect(httpRecords()).toEqual([expect.objectContaining({ isError: false, grant: { grantId: stampedGrantId('wf-post'), entry: 'v1' } })]);
  });

  it('a GET under the same grant carries no mark (the write gate is never asked)', async () => {
    const trigger = accept(saveWorkflow());
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'GET' })).mockResolvedValueOnce(endTurn('read'));
    await fire(trigger);
    expect(sent.map((s) => s.method)).toEqual(['GET']);
    const [rec] = httpRecords();
    expect(rec).toBeDefined();
    expect(rec!.grant).toBeUndefined();
  });

  it('a POST to a path the grant does not name is refused and carries no mark', async () => {
    const trigger = accept(saveWorkflow());
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: OTHER_PATH, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('done'));
    await fire(trigger);
    expect(posts()).toEqual([]);
    const [rec] = httpRecords();
    expect(rec).toBeDefined();
    expect(rec!.outputJson).toMatch(/Permission denied \(non-interactive\)/);
    expect(rec!.grant).toBeUndefined();
  });

  it('accepting the same workflow again gives a new grant, and the next run is marked with the new one', async () => {
    const planned = saveWorkflow();
    const first = accept(planned);
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('posted'));
    await fire(first);
    const firstId = stampedGrantId('wf-post');
    const second = accept(getPipeline('wf-post', history)!);
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('posted'));
    await fire(second);
    const secondId = stampedGrantId('wf-post');
    expect(secondId).not.toBe(firstId);
    expect(httpRecords().map((r) => r.grant?.grantId)).toEqual([firstId, secondId]);
  });

  it('two calls in one batch, a lifted POST and a GET, carry the mark on the POST only', async () => {
    const trigger = accept(saveWorkflow());
    // Ordered by construction, not by timing: the GET is answered only once the POST has
    // been sent (so it passed the write gate, which marks before sending), and the POST is
    // answered only once the GET's record exists. A mark kept anywhere but on the call's own
    // slot is therefore already set when the GET is recorded.
    let releasePost!: () => void;
    const postHeld = new Promise<void>((r) => { releasePost = r; });
    const postSent = (): boolean => sent.some((s) => s.method === 'POST');
    transport = async (input) => {
      if (input.method === 'POST') await postHeld;
      if (input.method === 'GET') {
        // A deadline, so a regression that refuses the POST fails here instead of spinning past
        // the test into the next one.
        const until = Date.now() + 2000;
        while (!postSent()) {
          if (Date.now() > until) throw new Error('the POST never reached the transport');
          await new Promise((r) => setTimeout(r, 2));
        }
      }
      return ok(input);
    };
    const poll = setInterval(() => { if (httpRecords().length >= 1) releasePost(); }, 5);
    mockProcess
      .mockResolvedValueOnce(toolUses([
        { name: 'http_request', input: { url: TARGET, method: 'POST', body: '{}' }, id: 'tu_post' },
        { name: 'http_request', input: { url: TARGET, method: 'GET' }, id: 'tu_get' },
      ]))
      .mockResolvedValueOnce(endTurn('both'));
    try {
      await fire(trigger);
    } finally {
      clearInterval(poll);
      releasePost();
    }
    const grantId = stampedGrantId('wf-post');
    const recs = httpRecords();
    expect(recs).toHaveLength(2);
    expect(recs[0]!.grant).toBeUndefined();
    expect(recs[1]!.grant).toEqual({ grantId, entry: 'v1' });
    // `sent` logs a request when it starts; both were sent, the POST only finished last.
    expect(sent.map((s) => s.method).sort()).toEqual(['GET', 'POST']);
  });

  it('a lifted POST whose send fails keeps its mark and is recorded as an error', async () => {
    const trigger = accept(saveWorkflow());
    transport = async (input) => {
      if (input.method === 'POST') throw new Error('connection reset by peer');
      return ok(input);
    };
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('failed'));
    await fire(trigger);
    expect(posts()).toHaveLength(1);
    expect(httpRecords()).toEqual([expect.objectContaining({ isError: true, grant: { grantId: stampedGrantId('wf-post'), entry: 'v1' } })]);
  });

  it('a lifted POST answered with a redirect the grant does not cover keeps its mark, and is recorded as the error it ends in', async () => {
    // The call ends refused although the write may have landed (`RedirectRefusedAfterWrite`,
    // http.ts). The agent's own sink always recorded it as an error; the step record said ok only
    // because the result event carried no error flag after a soft failure (PRD 3f-1b-α, D3). Both
    // now agree.
    const trigger = accept(saveWorkflow());
    transport = async (input) => input.method === 'POST' && input.url === TARGET
      ? new Response(null, { status: 307, headers: { location: OTHER_PATH } })
      : ok(input);
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url: TARGET, method: 'POST', body: '{}' })).mockResolvedValueOnce(endTurn('redirected'));
    await fire(trigger);
    expect(posts().map((p) => p.url)).toEqual([TARGET]);
    const [rec] = httpRecords();
    expect(rec).toBeDefined();
    expect(rec!.outputJson).toContain('Write possibly landed');
    expect(rec!.isError).toBe(true);
    expect(rec!.grant).toEqual({ grantId: stampedGrantId('wf-post'), entry: 'v1' });
  });
});

describe('the mark at the write gate itself, with a contract handed to the agent directly', () => {
  // A contract can reach an Agent through `AgentConfig` without the saved-workflow path (an
  // embedder, a test). The runner drops one that names no accepted grant; the agent does not,
  // so the write gate decides what such a contract leaves on the record.
  const contractFor = (host: string, path: string): CapabilityContract => ({
    version: 1, grantedTools: ['http_request'], httpMethods: ['POST'], hostPatterns: [host], pathPatterns: [path], paramConstraints: {},
  });
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

  async function run(contract: CapabilityContract, url: string, toolContext = createToolContext({}), extra: { headers?: Record<string, string>; promptUser?: (q: string) => Promise<string> } = {}): Promise<Array<Extract<StreamEvent, { type: 'tool_result' }>>> {
    const events: Array<Extract<StreamEvent, { type: 'tool_result' }>> = [];
    mockProcess.mockResolvedValueOnce(toolUse('http_request', { url, method: 'POST', body: '{}', ...(extra.headers ? { headers: extra.headers } : {}) })).mockResolvedValueOnce(endTurn('done'));
    const agent = new Agent({
      ...(extra.promptUser ? { promptUser: extra.promptUser } : {}),
      name: 'step', model: 'claude-sonnet-4-6', tools: [httpRequestTool], autonomy: 'autonomous', capabilityContract: contract,
      toolContext,
      onStream: async (e) => { if (e.type === 'tool_result') events.push(e); },
    });
    await agent.send('post it');
    return events;
  }

  it('a contract that names no accepted grant lets the POST through and leaves no mark', async () => {
    const [ev] = await run(contractFor(HOST, '/v1/reports'), TARGET);
    expect(sent.map((s) => s.method)).toEqual(['POST']);
    expect(ev).toBeDefined();
    expect(ev!.grant).toBeUndefined();
  });

  it('CONTROL: the same contract naming a grant leaves that grant on the event', async () => {
    const [ev] = await run(withGrantId(contractFor(HOST, '/v1/reports'), 'grant-direct'), TARGET);
    expect(sent.map((s) => s.method)).toEqual(['POST']);
    expect(ev!.grant).toEqual({ grantId: 'grant-direct', entry: 'v1' });
  });

  it('a POST the danger check lifts but the write gate refuses (a connected account) carries no mark', async () => {
    // The tuple matches, so the danger check lifts. The host has a profile connected through a
    // built-in provider, a connected account no contract grants, so the write gate refuses it
    // (`connectedAccount` in `contractGrantsWrite`); nothing before that gate does.
    const store = new ApiStore();
    store.register({
      id: 'shop-api', name: 'Shop', base_url: 'https://example.com/v1', description: 'Shop API',
      auth: { type: 'oauth2', vault_keys: ['SHOP_CLIENT_ID', 'SHOP_CLIENT_SECRET'], oauth: { grant_type: 'refresh_token', client_id_key: 'SHOP_CLIENT_ID', client_secret_key: 'SHOP_CLIENT_SECRET', preset_id: 'example-shop', preset_params: { shop: 'acme' } } },
    });
    const ctx = createToolContext({});
    ctx.apiStore = store;
    const [ev] = await run(withGrantId(contractFor('example.com', '/v1/report'), 'grant-shop'), 'https://example.com/v1/report', ctx);
    expect(sent.filter((s) => s.method === 'POST')).toEqual([]);
    expect(ev).toBeDefined();
    expect(ev!.result).toContain('requires user consent but no interactive prompt is available');
    expect(ev!.grant).toBeUndefined();
  });

  it('a POST whose override header names a method the grant lacks is lifted by the danger check, refused by the write gate, and carries no mark', async () => {
    // The danger check lifts on the sent method (POST, granted). The write gate reads every
    // method the request names (`writeMethodsNamed`), and PATCH is not granted. (DELETE would
    // not do: the danger check blocks it outright, so no contract lifts it there.)
    const [ev] = await run(withGrantId(contractFor(HOST, '/v1/reports'), 'grant-override'), TARGET, createToolContext({}), { headers: { 'X-HTTP-Method-Override': 'PATCH' } });
    expect(sent.filter((s) => s.method === 'POST')).toEqual([]);
    expect(ev!.result).not.toMatch(/^Permission denied \(non-interactive\)/);
    expect(ev!.result).toContain('requires user consent but no interactive prompt is available');
    expect(ev!.grant).toBeUndefined();
  });

  it('a write a person allowed in the run carries no mark, even under a grant (only the grant\'s own lift marks)', async () => {
    // A connected account is never granted, so the write gate asks; the run has someone to ask,
    // who allows it. The write goes out on that Allow, not on the grant.
    const store = new ApiStore();
    store.register({
      id: 'shop-api', name: 'Shop', base_url: 'https://example.com/v1', description: 'Shop API',
      auth: { type: 'oauth2', vault_keys: ['SHOP_CLIENT_ID', 'SHOP_CLIENT_SECRET'], oauth: { grant_type: 'refresh_token', client_id_key: 'SHOP_CLIENT_ID', client_secret_key: 'SHOP_CLIENT_SECRET', preset_id: 'example-shop', preset_params: { shop: 'acme' } } },
    });
    const ctx = createToolContext({});
    ctx.apiStore = store;
    const promptUser = vi.fn(async () => 'Allow');
    const [ev] = await run(withGrantId(contractFor('example.com', '/v1/report'), 'grant-shop'), 'https://example.com/v1/report', ctx, { promptUser });
    expect(promptUser).toHaveBeenCalled();
    expect(sent.map((s) => s.method)).toEqual(['POST']);
    expect(ev!.grant).toBeUndefined();
  });

  it('CONTROL: the same contract on the same host without the connected profile lets the POST through, marked', async () => {
    const [ev] = await run(withGrantId(contractFor('example.com', '/v1/report'), 'grant-shop'), 'https://example.com/v1/report');
    expect(sent.map((s) => s.method)).toEqual(['POST']);
    expect(ev!.grant).toEqual({ grantId: 'grant-shop', entry: 'v1' });
  });
});

describe('nothing in this repo runs a tool handler outside its call slot', () => {
  // A worker pool runs a handler outside the slot the agent opens per call, so the grant mark
  // (and the connection stamp, and the call's abort signal) would go dark without an error.
  // `AgentConfig.workerPool` is a public option; no production code here sets one. Pinned as
  // the exact set of places that name it, so a new one has to be looked at.
  it('workerPool is named only by its declaration and the agent that reads it', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const root = join(__dirname, '..');
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.endsWith('.d.ts')) continue;
        const n = readFileSync(p, 'utf8').split('workerPool').length - 1;
        if (n > 0) hits.push(`${p.slice(root.length + 1)}:${String(n)}`);
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(['core/agent.ts:6', 'types/config.ts:1']);
  });
});
