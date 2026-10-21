/**
 * The connection stamp of a pipeline step's call, end to end.
 *
 * Real: the acceptance (`acceptWorkflowGrant`), WorkerLoop.executePipeline, the saved-workflow
 * run, runManifest, spawnInline, the step Agent, the real `http_request` tool and its connection
 * resolver, the step stream handler that builds the step record, and the runner's write of that
 * record into history.db `run_tool_calls`. Mocked: the LLM (it answers with the tool calls a step
 * would make) and the network below `fetchPinned`. `runManifest` is wrapped only to tee its
 * `observeToolCall`, the seam the run already hands every step record to.
 *
 * What is pinned: a step call's row carries the connection and grant its URL resolved to, the
 * same stamp a conversation's call row gets, and there is exactly one row per call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

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

type StepRecord = { toolName: string; isError: boolean; toolUseId: string | undefined; connection?: { id: string; createdAt: string | null; grantId: string | null } | undefined };
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
import type { PlannedPipeline, TriggerRecord } from '../types/index.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import type { Engine } from './engine.js';

const endTurn = (text: string) => ({
  content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
});
const toolUses = (calls: Array<{ name: string; input: unknown; id: string }>) => ({
  content: calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input })), stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
});

const SHOP = 'api.shop.example';
const CRM = 'api.crm.example';
const PLAIN = 'api.plain.example';
const CRON = '0 9 * * 1';
// The accepted grant is a write grant; the calls here are reads, which it does not need to lift.
const ENTRY = { method: 'POST', host: SHOP, paths: ['/v1/reports'] };

type Transport = (input: PinnedTransportInput) => Promise<Response>;
const ok: Transport = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

function profile(id: string, host: string, grantId: string): ApiProfile {
  return {
    id, name: id, base_url: `https://${host}/v1`, description: 'stub',
    custom_endpoint_ack: { accepted: true, hosts: [host], accepted_at: '2026-10-19T00:00:00.000Z' },
    oauth_grant: { grant_id: grantId },
  } as ApiProfile;
}

type Row = { tool_name: string; connection_id: string | null; connection_created_at: string | null; grant_id: string | null; tool_use_id: string | null };

describe('a pipeline step call carries the connection and grant it resolved to', () => {
  let dir: string;
  let history: RunHistory;
  let engineDb: EngineDb;
  let tm: TaskManager;
  let store: ApiStore;
  let transport: Transport;
  let restoreTransport: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess.mockReset();
    observed.records.length = 0;
    transport = ok;
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    restoreTransport = setPinnedTransportForTests(async (input) => transport(input));
    dir = mkdtempSync(join(tmpdir(), 'lynox-step-connection-'));
    history = new RunHistory(join(dir, 'history.db'));
    engineDb = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engineDb);
    tm = new TaskManager(history);
    store = new ApiStore();
    expect(store.register(profile('shop', SHOP, 'g-shop-1'))).toBe(true);
    expect(store.register(profile('crm', CRM, 'g-crm-4'))).toBe(true);
    // Without engine.db rows the store knows no `created_at`; a fixed one makes the column a witness.
    store.connectionCreatedAt = (id: string) => (id === 'shop' ? '2026-10-01 08:00:00' : null);
    _resetPipelineStore();
    _resetTenantInvariantForTests();
  });

  afterEach(() => {
    restoreTransport();
    try { engineDb.close(); } catch { /* closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function accepted(): TriggerRecord {
    const id = 'wf-read';
    history.insertPlannedPipeline({
      id, name: id, goal: 'read the weekly numbers', reasoning: 'r', estimatedCost: 0,
      createdAt: '2026-10-01T00:00:00.000Z', template: true,
      steps: [{ id: 's1', task: 'read the weekly numbers', tools: ['http_request'] }],
      ...{ mode: 'autonomous', parameters: [] },
    } as Parameters<RunHistory['insertPlannedPipeline']>[0], null);
    forgetPipeline(id);
    const planned: PlannedPipeline = getPipeline(id, history)!;
    const shown = prepareWorkflowGrant(planned, { ...ENTRY, params: {}, cron: CRON, afterUntrusted: false }, engineDb);
    if (!shown.ok) throw new Error(shown.error);
    const r = acceptWorkflowGrant(planned, { ...ENTRY, params: {}, cron: CRON, afterUntrusted: false, checksum: shown.checksum, name: 'Ada', title: 'Weekly' }, 'local', { history, taskManager: tm, hasher: engineDb });
    if (!r.ok) throw new Error(r.error);
    forgetPipeline(planned.id);
    return r.task;
  }

  function engine(): Engine {
    const ctx = createToolContext({});
    ctx.tools = [httpRequestTool];
    ctx.apiStore = store;
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

  async function fire(calls: Array<{ url: string; id: string }>): Promise<void> {
    const trigger = accepted();
    mockProcess
      .mockResolvedValueOnce(toolUses(calls.map((c) => ({ name: 'http_request', input: { url: c.url, method: 'GET' }, id: c.id }))))
      .mockResolvedValueOnce(endTurn('read'));
    const loop = new WorkerLoop(engine(), { hasChannels: () => false, notify: vi.fn() } as never, 60_000);
    await (loop as unknown as { executePipeline: (t: TriggerRecord, starter: undefined, ownerStop: AbortSignal) => Promise<void> }).executePipeline(tm.getTrigger(trigger.id)!, undefined, new AbortController().signal);
  }

  /** Every `http_request` row in history.db, under any run, so a second row for one call shows up. */
  function rows(): Row[] {
    const db = new Database(join(dir, 'history.db'), { readonly: true });
    try {
      return db.prepare(`SELECT tool_name, connection_id, connection_created_at, grant_id, tool_use_id
        FROM run_tool_calls WHERE tool_name = 'http_request' ORDER BY tool_use_id`).all() as Row[];
    } finally {
      db.close();
    }
  }

  it('a step GET through a saved profile is written with its connection, created_at and grant, once', async () => {
    await fire([{ url: `https://${SHOP}/v1/orders`, id: 'tu_shop' }]);
    expect(observed.records.filter((r) => r.toolName === 'http_request')).toEqual([
      expect.objectContaining({ toolUseId: 'tu_shop', connection: { id: 'shop', createdAt: '2026-10-01 08:00:00', grantId: 'g-shop-1' } }),
    ]);
    expect(rows()).toEqual([
      { tool_name: 'http_request', connection_id: 'shop', connection_created_at: '2026-10-01 08:00:00', grant_id: 'g-shop-1', tool_use_id: 'tu_shop' },
    ]);
  });

  it('a step GET to a host with no saved profile carries no connection, and its row columns stay NULL', async () => {
    await fire([{ url: `https://${PLAIN}/v1/status`, id: 'tu_plain' }]);
    const [rec] = observed.records.filter((r) => r.toolName === 'http_request');
    expect(rec).toBeDefined();
    expect(rec!.connection).toBeUndefined();
    expect(rows()).toEqual([
      { tool_name: 'http_request', connection_id: null, connection_created_at: null, grant_id: null, tool_use_id: 'tu_plain' },
    ]);
  });

  it('two calls in one batch to two connections each keep their own stamp', async () => {
    // The CRM answer is held until the shop row exists, so results come back in the opposite
    // order of the calls: a stamp kept anywhere but on the call's own result would cross over.
    let releaseCrm!: () => void;
    const crmHeld = new Promise<void>((r) => { releaseCrm = r; });
    transport = async (input) => {
      if (input.url.includes(CRM)) await crmHeld;
      return ok(input);
    };
    const poll = setInterval(() => { if (observed.records.some((r) => r.toolUseId === 'tu_shop')) releaseCrm(); }, 5);
    try {
      await fire([{ url: `https://${CRM}/v1/contacts`, id: 'tu_crm' }, { url: `https://${SHOP}/v1/orders`, id: 'tu_shop' }]);
    } finally {
      clearInterval(poll);
      releaseCrm();
    }
    // The stream processor is mocked here, so no `tool_call` event is emitted and a record's input
    // is never paired; that its own URL stays next to its stamp is pinned in runtime-adapter.test.ts.
    expect(observed.records.filter((r) => r.toolName === 'http_request').map((r) => r.toolUseId)).toEqual(['tu_shop', 'tu_crm']);
    expect(rows()).toEqual([
      { tool_name: 'http_request', connection_id: 'crm', connection_created_at: null, grant_id: 'g-crm-4', tool_use_id: 'tu_crm' },
      { tool_name: 'http_request', connection_id: 'shop', connection_created_at: '2026-10-01 08:00:00', grant_id: 'g-shop-1', tool_use_id: 'tu_shop' },
    ]);
  });

  it('a step call whose send fails keeps its stamp and is recorded as an error', async () => {
    transport = async () => { throw new Error('connection reset by peer'); };
    await fire([{ url: `https://${SHOP}/v1/orders`, id: 'tu_shop' }]);
    expect(observed.records.filter((r) => r.toolName === 'http_request')).toEqual([
      expect.objectContaining({ isError: true, connection: { id: 'shop', createdAt: '2026-10-01 08:00:00', grantId: 'g-shop-1' } }),
    ]);
    expect(rows()).toEqual([
      { tool_name: 'http_request', connection_id: 'shop', connection_created_at: '2026-10-01 08:00:00', grant_id: 'g-shop-1', tool_use_id: 'tu_shop' },
    ]);
  });
});
