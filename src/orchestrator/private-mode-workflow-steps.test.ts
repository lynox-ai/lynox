import { OWNER_PRINCIPAL } from '../core/request-principal.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgent, IMemory, LynoxUserConfig, ToolEntry } from '../types/index.js';
import type { ThreadStore } from '../core/thread-store.js';
import { channels } from '../core/observability.js';

/**
 * Private mode on a chat must reach the steps of a workflow that chat starts.
 *
 * Driven through the stable public entry — the real `run_workflow` tool handler — with
 * a REAL step `Agent` (only the LLM is scripted, the way `src/core/agent.test.ts` does it).
 * The step is scripted to (1) call `memory_store`, then (2) end its turn with a text, so
 * BOTH write paths a step has into the chat's memory are exercised:
 *   - the explicit tool write (`memory_store` → `privateThreadRefusal` → `IMemory.append`);
 *   - the step agent's own end-of-turn capture (`_captureAtTurnEnd` → `_captureGate` →
 *     `IMemory.maybeUpdate` on the legacy path).
 *
 * Only the legacy capture path is driven (`durable_memory_enabled` off). The durable path
 * sits behind the SAME `_captureGate` (memory present, `skipMemoryExtraction`,
 * `isInternalRun`) and is reachable from a step too: `spawnInline` passes
 * `durableMemoryEnabled: config.durable_memory_enabled === true` and the parent's
 * `toolContext`, so with the flag on, `_captureFallback` writes through
 * `toolContext.knowledgeStore` instead of calling `maybeUpdate`. Pinning that branch needs
 * a real KnowledgeStore (see parallel-step-taint.test.ts); the gate it shares is what the
 * cases below pin.
 *
 * Every way a chat starts steps is driven: inline steps (A–C), a nested pipeline (D, through
 * the real `runManifest` → `spawnPipeline` → `spawnInline`), a saved workflow by id (E) and
 * its retry (F). `spawnViaAgent` builds its agent without `memory`, so its capture already
 * stands down as `no_memory` and its memory tools answer "not configured"; it gets the same
 * origin so the step paths cannot diverge, but there is nothing in memory to observe there.
 *
 * Compare spawn.ts, where a `spawn_agent` child already inherits `originThreadId` and the
 * flag from its parent.
 */

// === Mocks (LLM only — the Agent, the runner and the memory tool are real) ===

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        stream: vi.fn(),
      },
    };
  }
  class APIError extends Error {
    status: number;
    error: unknown;
    headers: unknown;
    constructor(status: number, error: unknown, message: string | undefined, headers: unknown) {
      super(message ?? String(error));
      this.status = status;
      this.error = error;
      this.headers = headers;
      this.name = 'APIError';
    }
  }
  return { default: MockAnthropic, APIError };
});

const mockProcess = vi.fn();

vi.mock('../core/stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

import { runWorkflowTool, _resetPipelineStore, storePipeline } from '../tools/builtin/pipeline.js';
import { runManifest, buildRunCtx } from './runner.js';
import { chatOriginOf, applyChatOrigin } from './runtime-adapter.js';
import type { Agent } from '../core/agent.js';
import type { PlannedPipeline } from '../types/index.js';
import { memoryStoreTool } from '../tools/builtin/memory.js';
import { createToolContext } from '../core/tool-context.js';

function endTurnResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function toolUseResponse(tools: Array<{ id: string; name: string; input: unknown }>) {
  return {
    content: tools.map(t => ({ type: 'tool_use' as const, id: t.id, name: t.name, input: t.input })),
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const PRIVATE_REFUSAL_PREFIX = 'Not stored: this chat is in private mode.';

// Long enough to clear any length gate a real extractor applies; the fake below records
// the call itself, so the agent-side gate is what decides.
const FINAL_TEXT = 'The supplier review is finished. The preferred supplier for packaging material '
  + 'is the regional vendor with the 14-day delivery window, and the order volume for next '
  + 'quarter is planned at roughly 1200 units, split across two deliveries.';

interface FakeMemory extends IMemory {
  writes: Array<{ method: string; args: unknown[] }>;
  maybeUpdateCalls: unknown[][];
}

function makeFakeMemory(): FakeMemory {
  const writes: Array<{ method: string; args: unknown[] }> = [];
  const maybeUpdateCalls: unknown[][] = [];
  const rec = (method: string) => (...args: unknown[]) => {
    writes.push({ method, args });
    return Promise.resolve(method === 'update' || method === 'updateScoped' ? true : method.startsWith('delete') ? 0 : undefined);
  };
  return {
    writes,
    maybeUpdateCalls,
    load: () => Promise.resolve(null),
    loadScoped: () => Promise.resolve(null),
    loadAll: () => Promise.resolve(),
    render: () => '',
    hasContent: () => false,
    save: rec('save') as IMemory['save'],
    append: rec('append') as IMemory['append'],
    appendScoped: rec('appendScoped') as IMemory['appendScoped'],
    update: rec('update') as IMemory['update'],
    updateScoped: rec('updateScoped') as IMemory['updateScoped'],
    delete: rec('delete') as IMemory['delete'],
    deleteScoped: rec('deleteScoped') as IMemory['deleteScoped'],
    maybeUpdate: (...args: unknown[]) => {
      maybeUpdateCalls.push(args);
      return Promise.resolve();
    },
  };
}

/** Thread rows the private-mode check reads; mutable so a case can flip one mid-run. */
const threadRows = new Map<string, { id: string; skip_extraction: number }>();

function makeThreadStore(): ThreadStore {
  return {
    getThread: (id: string) => threadRows.get(id),
  } as unknown as ThreadStore;
}

const config: LynoxUserConfig = {
  api_key: 'test-key',
  durable_memory_enabled: false,
};

/** What the step's `memory_store` call answered — the real handler, observed. */
let storeResults: string[] = [];

const observedMemoryStore: ToolEntry = {
  ...memoryStoreTool,
  handler: async (input: unknown, agent: IAgent) => {
    const out = await (memoryStoreTool.handler as (i: unknown, a: IAgent) => Promise<string>)(input, agent);
    storeResults.push(out);
    return out;
  },
} as ToolEntry;

type ParentAgent = IAgent & { skipMemoryExtraction: boolean };

// The engine's store of who made a saved workflow, as the owner's: every saved workflow has that
// row, and a run whose author cannot be read does not start. Everything else the run asks of the
// store answers nothing.
const OWNER_HISTORY = new Proxy({
  getWorkflowAuthorship: () => ({ createdBy: null, createdMandateId: null, mandateEditor: null, mandateEditorId: null, mandateEditedAt: null, createdAt: '2026-10-12 12:00:00' }),
} as Record<string, unknown>, { get: (t, k) => (typeof k === 'string' && k in t ? t[k] : () => undefined) }) as unknown as NonNullable<ReturnType<typeof createToolContext>['runHistory']>;

function makeParent(opts: { threadId: string; privateMode: boolean; memory: IMemory }): ParentAgent {
  const ctx = createToolContext(config);
  ctx.runHistory = OWNER_HISTORY;
  ctx.tools = [observedMemoryStore];
  ctx.threadStore = makeThreadStore();
  return {
    toolContext: ctx,
    principal: OWNER_PRINCIPAL,
    getAvailableTools: () => ctx.tools,
    memory: opts.memory,
    currentThreadId: opts.threadId,
    skipMemoryExtraction: opts.privateMode,
    userTimezone: 'UTC',
    noteUntrustedData: vi.fn(),
  } as unknown as ParentAgent;
}

function scriptStep(onFirstCall?: () => void): void {
  mockProcess.mockImplementationOnce(() => {
    onFirstCall?.();
    return Promise.resolve(toolUseResponse([{
      id: 'tu-store-1',
      name: 'memory_store',
      input: { namespace: 'knowledge', content: 'Preferred packaging supplier has a 14-day delivery window.' },
    }]));
  });
  mockProcess.mockImplementationOnce(() => Promise.resolve(endTurnResponse(FINAL_TEXT)));
}

async function runOneStepWorkflow(parent: ParentAgent): Promise<string> {
  const out = await runWorkflowTool.handler({
    name: 'private-mode-probe',
    steps: [{ id: 'collect', task: 'Record the supplier decision and summarise it.', tools: ['memory_store'] }],
  }, parent);
  // The legacy capture is scheduled, not awaited by send(); let it settle.
  await new Promise(r => setTimeout(r, 0));
  return out;
}

describe('run_workflow steps inherit the chat\'s private mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess.mockReset();
    _resetPipelineStore();
    storeResults = [];
    threadRows.clear();
    threadRows.set('t-priv', { id: 't-priv', skip_extraction: 1 });
    threadRows.set('t-pub', { id: 't-pub', skip_extraction: 0 });
  });

  it('A: a step started from a private chat neither stores nor captures into memory', async () => {
    const memory = makeFakeMemory();
    const parent = makeParent({ threadId: 't-priv', privateMode: true, memory });
    scriptStep();

    await runOneStepWorkflow(parent);

    // The step really ran its scripted turn (two model calls) and really called the tool.
    expect(mockProcess).toHaveBeenCalledTimes(2);
    expect(storeResults).toHaveLength(1);
    // Explicit write: refused with the private-mode answer, nothing reached the store.
    expect(storeResults[0]).toContain(PRIVATE_REFUSAL_PREFIX);
    expect(memory.writes).toEqual([]);
    // End-of-turn capture: stood down.
    expect(memory.maybeUpdateCalls).toEqual([]);
  });

  it('B (positive control): a step started from a normal chat stores and captures', async () => {
    const memory = makeFakeMemory();
    const parent = makeParent({ threadId: 't-pub', privateMode: false, memory });
    scriptStep();

    await runOneStepWorkflow(parent);

    expect(mockProcess).toHaveBeenCalledTimes(2);
    expect(storeResults).toHaveLength(1);
    expect(storeResults[0]).toMatch(/^Stored in knowledge\./);
    expect(memory.writes.map(w => w.method)).toEqual(['append']);
    expect(memory.writes[0]!.args).toEqual(['knowledge', 'Preferred packaging supplier has a 14-day delivery window.']);
    expect(memory.maybeUpdateCalls).toHaveLength(1);
    expect(String(memory.maybeUpdateCalls[0]![0])).toContain('preferred supplier for packaging');
  });

  it('H: a step\'s writes in a normal chat are stamped with that chat, so switching it private later can remove them', async () => {
    const memory = makeFakeMemory();
    const parent = makeParent({ threadId: 't-pub', privateMode: false, memory });
    scriptStep();
    const published: Array<{ sourceThreadId?: string }> = [];
    const onStore = (msg: unknown): void => { published.push(msg as { sourceThreadId?: string }); };
    channels.memoryStore.subscribe(onStore);
    try {
      await runOneStepWorkflow(parent);
    } finally {
      channels.memoryStore.unsubscribe(onStore);
    }

    // The explicit write: what the knowledge layer mirrors carries the chat.
    expect(storeResults[0]).toMatch(/^Stored in knowledge\./);
    expect(published.map(m => m.sourceThreadId)).toEqual(['t-pub']);
    // The end-of-turn capture: the legacy store is handed the chat as the source thread.
    expect(memory.maybeUpdateCalls).toHaveLength(1);
    expect(memory.maybeUpdateCalls[0]![2]).toBe('t-pub');
  });

  it('C: private mode switched on while the step runs stops the step\'s end-of-turn capture', async () => {
    const memory = makeFakeMemory();
    const parent = makeParent({ threadId: 't-pub', privateMode: false, memory });
    // The user turns private mode on mid-run: the session flips the live agent's flag
    // (session.ts setSkipMemoryExtraction) and the thread row carries skip_extraction = 1.
    scriptStep(() => {
      parent.skipMemoryExtraction = true;
      threadRows.set('t-pub', { id: 't-pub', skip_extraction: 1 });
    });

    await runOneStepWorkflow(parent);

    expect(mockProcess).toHaveBeenCalledTimes(2);
    expect(storeResults[0]).toContain(PRIVATE_REFUSAL_PREFIX);
    expect(memory.maybeUpdateCalls).toEqual([]);
  });

  it('C2: the switch reaches the step through the thread row when the chat\'s agent was rebuilt', async () => {
    const memory = makeFakeMemory();
    const parent = makeParent({ threadId: 't-pub', privateMode: false, memory });
    // The session rebuilt its agent (model change) before the user switched private mode on,
    // so the flag flips on a NEW agent and this run's origin still holds the old one. Only the
    // thread row changes here.
    scriptStep(() => {
      threadRows.set('t-pub', { id: 't-pub', skip_extraction: 1 });
    });

    await runOneStepWorkflow(parent);

    expect(mockProcess).toHaveBeenCalledTimes(2);
    expect(parent.skipMemoryExtraction).toBe(false);
    expect(memory.maybeUpdateCalls).toEqual([]);
  });

  async function runNested(parent: ParentAgent, memory: FakeMemory): Promise<void> {
    await runManifest({
      manifest_version: '1.0',
      name: 'nested-private-probe',
      triggered_by: 'test',
      context: {},
      agents: [{
        id: 'outer', agent: 'outer', runtime: 'pipeline',
        pipeline: [{ id: 'inner', task: 'Record the supplier decision and summarise it.', tools: ['memory_store'] }],
      }],
      gate_points: [],
      on_failure: 'stop',
    }, config, { ...buildRunCtx({
      autonomy: undefined,
      parentTools: [observedMemoryStore],
      parentToolContext: parent.toolContext,
      parentMemory: memory,
      chatOrigin: chatOriginOf(parent),
    }), source: { kind: 'adhoc' as const } });
    await new Promise(r => setTimeout(r, 0));
  }

  it('D: a nested pipeline\'s step started from a private chat neither stores nor captures', async () => {
    const memory = makeFakeMemory();
    const parent = makeParent({ threadId: 't-priv', privateMode: true, memory });
    scriptStep();

    await runNested(parent, memory);

    expect(mockProcess).toHaveBeenCalledTimes(2);
    expect(storeResults).toHaveLength(1);
    expect(storeResults[0]).toContain(PRIVATE_REFUSAL_PREFIX);
    expect(memory.writes).toEqual([]);
    expect(memory.maybeUpdateCalls).toEqual([]);
  });

  it('D (positive control): the same nested step from a normal chat stores and captures', async () => {
    const memory = makeFakeMemory();
    const parent = makeParent({ threadId: 't-pub', privateMode: false, memory });
    scriptStep();

    await runNested(parent, memory);

    expect(storeResults[0]).toMatch(/^Stored in knowledge\./);
    expect(memory.writes.map(w => w.method)).toEqual(['append']);
    expect(memory.maybeUpdateCalls).toHaveLength(1);
  });

  function plannedProbe(): PlannedPipeline {
    return {
      id: 'wf-private-probe',
      name: 'Supplier note',
      goal: 'Record the supplier decision',
      steps: [{ id: 'collect', task: 'Record the supplier decision and summarise it.', tools: ['memory_store'] }],
      reasoning: 'probe',
      estimatedCost: 0.01,
      createdAt: '2026-10-12T12:00:00.000Z',
      executed: false,
      executionMode: 'orchestrated',
      template: false,
      mode: 'autonomous',
    };
  }

  it('E: a saved workflow run by id from a private chat neither stores nor captures', async () => {
    const memory = makeFakeMemory();
    const parent = makeParent({ threadId: 't-priv', privateMode: true, memory });
    storePipeline('wf-private-probe', plannedProbe());
    scriptStep();

    await runWorkflowTool.handler({ workflow_id: 'wf-private-probe' }, parent);
    await new Promise(r => setTimeout(r, 0));

    expect(mockProcess).toHaveBeenCalledTimes(2);
    expect(storeResults).toHaveLength(1);
    expect(storeResults[0]).toContain(PRIVATE_REFUSAL_PREFIX);
    expect(memory.writes).toEqual([]);
    expect(memory.maybeUpdateCalls).toEqual([]);
  });

  it('E (positive control): the same saved workflow from a normal chat stores and captures', async () => {
    const memory = makeFakeMemory();
    const parent = makeParent({ threadId: 't-pub', privateMode: false, memory });
    storePipeline('wf-private-probe', plannedProbe());
    scriptStep();

    await runWorkflowTool.handler({ workflow_id: 'wf-private-probe' }, parent);
    await new Promise(r => setTimeout(r, 0));

    expect(storeResults[0]).toMatch(/^Stored in knowledge\./);
    expect(memory.writes.map(w => w.method)).toEqual(['append']);
    expect(memory.maybeUpdateCalls).toHaveLength(1);
  });

  async function failFirstRun(parent: ParentAgent): Promise<void> {
    storePipeline('wf-private-probe', plannedProbe());
    // First run: a step that fails, so the retry has something to re-run.
    mockProcess.mockImplementationOnce(() => Promise.reject(new Error('provider down')));
    await runWorkflowTool.handler({ workflow_id: 'wf-private-probe' }, parent);
    mockProcess.mockClear();
  }

  it('F (positive control): a retry from a normal chat stores and captures', async () => {
    const memory = makeFakeMemory();
    const parent = makeParent({ threadId: 't-pub', privateMode: false, memory });
    await failFirstRun(parent);
    scriptStep();

    await runWorkflowTool.handler({ workflow_id: 'wf-private-probe', retry: true }, parent);
    await new Promise(r => setTimeout(r, 0));

    expect(mockProcess).toHaveBeenCalledTimes(2);
    expect(storeResults.at(-1)).toMatch(/^Stored in knowledge\./);
    expect(memory.maybeUpdateCalls).toHaveLength(1);
  });

  it('F: a retry from a chat that went private since the first run neither stores nor captures', async () => {
    const memory = makeFakeMemory();
    const parent = makeParent({ threadId: 't-pub', privateMode: false, memory });
    await failFirstRun(parent);

    parent.skipMemoryExtraction = true;
    threadRows.set('t-pub', { id: 't-pub', skip_extraction: 1 });
    scriptStep();
    await runWorkflowTool.handler({ workflow_id: 'wf-private-probe', retry: true }, parent);
    await new Promise(r => setTimeout(r, 0));

    expect(mockProcess).toHaveBeenCalledTimes(2);
    expect(storeResults.at(-1)).toContain(PRIVATE_REFUSAL_PREFIX);
    expect(memory.writes).toEqual([]);
    expect(memory.maybeUpdateCalls).toEqual([]);
  });
});

describe('applyChatOrigin', () => {
  it('G: the step\'s own switch counts for the step only, and the chat\'s ON wins', () => {
    const chat = { currentThreadId: 't-chat', originThreadId: undefined, skipMemoryExtraction: false };
    const step = { originThreadId: undefined as string | undefined, skipMemoryExtraction: false };
    applyChatOrigin(step as unknown as Agent, chatOriginOf(chat));

    expect(step.originThreadId).toBe('t-chat');
    expect(step.skipMemoryExtraction).toBe(false);
    step.skipMemoryExtraction = true;
    expect(step.skipMemoryExtraction).toBe(true);
    expect(chat.skipMemoryExtraction).toBe(false);
    step.skipMemoryExtraction = false;
    chat.skipMemoryExtraction = true;
    expect(step.skipMemoryExtraction).toBe(true);
    step.skipMemoryExtraction = false;
    expect(step.skipMemoryExtraction).toBe(true);
  });

  it('G2: no origin leaves the step as it was', () => {
    const step = { originThreadId: undefined as string | undefined, skipMemoryExtraction: false };
    applyChatOrigin(step as unknown as Agent, undefined);
    expect(step.originThreadId).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(step, 'skipMemoryExtraction')?.get).toBeUndefined();
  });
});
