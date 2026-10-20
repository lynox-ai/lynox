import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgent, LynoxUserConfig, PlannedPipeline, ToolEntry } from '../types/index.js';
import type { WorkflowAuthorship } from '../core/workflow-store.js';

/**
 * A saved workflow a mandate made or last changed runs only while that mandate's grant is live,
 * whoever starts it: a chat's `run_workflow` by id and its retry, and `runSavedWorkflow`, which the
 * library's Run button, the HTTP run route and a schedule all go through. The check is at
 * `runManifest`; each caller only says what it runs (`run-source.ts`).
 *
 * Driven through the real `run_workflow` handler, the real `runSavedWorkflow` and the real runner;
 * only the LLM is scripted. "Ran" means a step agent reached the provider.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: vi.fn() } };
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

import { runWorkflowTool, runSavedWorkflow, _resetPipelineStore, storePipeline } from '../tools/builtin/pipeline.js';
import { runManifest, retryManifest } from './runner.js';
import {
  savedWorkflowSource, sourceRefusal, WORKFLOW_ENDED_REFUSAL, WORKFLOW_UNREADABLE_REFUSAL, NESTED_AT_TOP_REFUSAL,
  type RunSource,
} from './run-source.js';
import { createToolContext } from '../core/tool-context.js';

function endTurnResponse(text: string) {
  return { content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } };
}

const config: LynoxUserConfig = { api_key: 'test-key', durable_memory_enabled: false };

const WF = 'wf-author-probe';
const B = 'mandate:bea@example.test';

const OWNERS: WorkflowAuthorship = { createdBy: null, createdMandateId: null, mandateEditor: null, mandateEditorId: null, mandateEditedAt: null, createdAt: '2026-10-19 12:00:00' };
const BEAS: WorkflowAuthorship = { ...OWNERS, createdBy: B, createdMandateId: 'grant-b' };
const EDITED_BY_BEA: WorkflowAuthorship = { ...OWNERS, mandateEditor: B, mandateEditorId: 'grant-b', mandateEditedAt: '2026-10-19 13:00:00' };

/** What the engine's stores answer in a test: the workflow's authorship row (or a read that throws),
 *  and which grants are live (`null` = no store of mandate ends). */
let authorship: WorkflowAuthorship | undefined | 'throws';
let live: Set<string> | null;

function planned(): PlannedPipeline {
  return {
    id: WF, name: 'Report', goal: 'Write the report', steps: [{ id: 'write', task: 'Write the report.' }], reasoning: 'probe',
    estimatedCost: 0.01, createdAt: '2026-10-19T12:00:00.000Z', executed: false,
    executionMode: 'orchestrated', template: true, mode: 'autonomous',
  };
}

function engineContext(): ReturnType<typeof createToolContext> {
  const ctx = createToolContext(config);
  ctx.tools = [{
    definition: { name: 'note', description: 'note', input_schema: { type: 'object' as const, properties: {} } },
    handler: async () => 'noted',
  } as unknown as ToolEntry];
  // Everything else the run asks of the store answers nothing.
  ctx.runHistory = new Proxy({
    getWorkflowAuthorship: (id: string) => {
      if (authorship === 'throws') throw new Error('engine.db is gone');
      return id === WF ? authorship : undefined;
    },
  } as Record<string, unknown>, { get: (t, k) => (typeof k === 'string' && k in t ? t[k] : () => undefined) }) as unknown as NonNullable<typeof ctx.runHistory>;
  ctx.mandateEnds = live === null ? null : { isLive: (id: string) => live!.has(id) };
  return ctx;
}

function chat(principal?: IAgent['principal']): IAgent {
  const ctx = engineContext();
  return {
    toolContext: ctx,
    getAvailableTools: () => ctx.tools,
    currentThreadId: 't-1',
    userTimezone: 'UTC',
    ...(principal ? { principal } : {}),
    noteUntrustedData: vi.fn(),
    noteForeignContent: vi.fn(),
  } as unknown as IAgent;
}

function scriptStep(): void {
  mockProcess.mockImplementationOnce(() => Promise.resolve(endTurnResponse('Report written.')));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProcess.mockReset();
  _resetPipelineStore();
  storePipeline(WF, planned());
  authorship = OWNERS;
  live = new Set(['grant-b']);
});

describe("a saved workflow a mandate shaped runs only while that mandate's grant is live", () => {
  it("the owner's chat runs a workflow a live mandate made", async () => {
    authorship = BEAS;
    scriptStep();
    const out = await runWorkflowTool.handler({ workflow_id: WF }, chat());
    expect(out).not.toMatch(/^Error/);
    expect(mockProcess).toHaveBeenCalledTimes(1);
  });

  it("the owner's chat does not run it once that mandate's grant ended, and no step reaches the provider", async () => {
    authorship = BEAS;
    live = new Set();
    const out = await runWorkflowTool.handler({ workflow_id: WF }, chat());
    expect(out).toBe(`Error: Workflow execution failed: ${WORKFLOW_ENDED_REFUSAL}`);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it("another mandate's chat, live itself, does not run it either", async () => {
    authorship = BEAS;
    live = new Set(['grant-a']);
    const out = await runWorkflowTool.handler({ workflow_id: WF }, chat({ kind: 'mandate', email: 'ada@example.test', mandateId: 'grant-a' }));
    expect(out).toBe(`Error: Workflow execution failed: ${WORKFLOW_ENDED_REFUSAL}`);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it("the owner's workflow a mandate later changed depends on that mandate", async () => {
    authorship = EDITED_BY_BEA;
    live = new Set();
    const out = await runWorkflowTool.handler({ workflow_id: WF }, chat());
    expect(out).toBe(`Error: Workflow execution failed: ${WORKFLOW_ENDED_REFUSAL}`);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it("the owner's own workflow runs whatever the grants, also with no store of mandate ends", async () => {
    live = null;
    scriptStep();
    const out = await runWorkflowTool.handler({ workflow_id: WF }, chat());
    expect(out).not.toMatch(/^Error/);
    expect(mockProcess).toHaveBeenCalledTimes(1);
  });

  it("with no store of mandate ends, a mandate's workflow cannot be told live and does not run", async () => {
    authorship = BEAS;
    live = null;
    const out = await runWorkflowTool.handler({ workflow_id: WF }, chat());
    expect(out).toBe(`Error: Workflow execution failed: ${WORKFLOW_ENDED_REFUSAL}`);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it.each([
    ['has no authorship row', undefined],
    ['cannot be read', 'throws' as const],
  ])('a workflow whose authorship %s does not run', async (_label, a) => {
    authorship = a;
    const out = await runWorkflowTool.handler({ workflow_id: WF }, chat());
    expect(out).toBe(`Error: Workflow execution failed: ${WORKFLOW_UNREADABLE_REFUSAL}`);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('a retry, after the grant ended, does not re-run the failed step', async () => {
    authorship = BEAS;
    const parent = chat();
    mockProcess.mockImplementationOnce(() => Promise.reject(new Error('provider down')));
    await runWorkflowTool.handler({ workflow_id: WF }, parent);
    expect(mockProcess).toHaveBeenCalledTimes(1);
    live!.delete('grant-b');
    const out = await runWorkflowTool.handler({ workflow_id: WF, retry: true }, parent);
    expect(out).toBe(`Error: Workflow retry failed: ${WORKFLOW_ENDED_REFUSAL}`);
    expect(mockProcess).toHaveBeenCalledTimes(1);
  });

  it('a retry while the grant lives re-runs it (control)', async () => {
    authorship = BEAS;
    const parent = chat();
    mockProcess.mockImplementationOnce(() => Promise.reject(new Error('provider down')));
    await runWorkflowTool.handler({ workflow_id: WF }, parent);
    scriptStep();
    const out = await runWorkflowTool.handler({ workflow_id: WF, retry: true }, parent);
    expect(out).not.toMatch(/^Error/);
    expect(mockProcess).toHaveBeenCalledTimes(2);
  });

  it('steps a chat writes itself run as before: no saved workflow shaped them', async () => {
    authorship = undefined;
    live = new Set();
    scriptStep();
    const out = await runWorkflowTool.handler({ name: 'adhoc', steps: [{ id: 'write', task: 'Write the report.' }] }, chat());
    expect(out).not.toMatch(/^Error/);
    expect(mockProcess).toHaveBeenCalledTimes(1);
  });
});

describe('runSavedWorkflow — the Run button, the HTTP run route and a schedule', () => {
  function runtime() {
    const ctx = engineContext();
    return { tools: ctx.tools, toolContext: ctx };
  }

  it("does not run a mandate's workflow once its grant ended", async () => {
    authorship = BEAS;
    live = new Set();
    const ctx = engineContext();
    const result = await runSavedWorkflow(WF, ctx.runHistory, config, undefined, runtime());
    expect(result).toEqual({ ok: false, error: `Workflow execution failed: ${WORKFLOW_ENDED_REFUSAL}` });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('runs it while the grant lives', async () => {
    authorship = BEAS;
    scriptStep();
    const ctx = engineContext();
    const result = await runSavedWorkflow(WF, ctx.runHistory, config, undefined, runtime());
    expect(result).toMatchObject({ ok: true, status: 'completed' });
    expect(mockProcess).toHaveBeenCalledTimes(1);
  });

  it('a caller without the engine context cannot tell a mandate live, so the workflow does not run', async () => {
    authorship = BEAS;
    const ctx = engineContext();
    const result = await runSavedWorkflow(WF, ctx.runHistory, config);
    expect(result).toEqual({ ok: false, error: `Workflow execution failed: ${WORKFLOW_ENDED_REFUSAL}` });
    expect(mockProcess).not.toHaveBeenCalled();
  });
});

describe('runManifest refuses a source that may not run, before the run exists', () => {
  const manifest = {
    manifest_version: '1.1' as const, name: 'probe', triggered_by: 'test', context: {},
    agents: [{ id: 'a', agent: 'a', runtime: 'mock' as const }], gate_points: [], on_failure: 'stop' as const,
  };
  const endedBea: RunSource = { kind: 'saved', workflowId: WF, authors: [{ kind: 'mandate', email: 'bea@example.test', mandateId: 'grant-b' }], ends: { isLive: () => false } };

  it('an ended author: no step runs, no hook fires', async () => {
    const onRunStart = vi.fn();
    const mockResponses = new Map([['a', 'ran']]);
    await expect(runManifest(manifest, config, { source: endedBea, mockResponses, hooks: { onRunStart } })).rejects.toThrow(WORKFLOW_ENDED_REFUSAL);
    expect(onRunStart).not.toHaveBeenCalled();
  });

  it('the same through retryManifest', async () => {
    const prev = { runId: 'r', manifestName: 'probe', status: 'failed' as const, outputs: new Map(), startedAt: new Date().toISOString() };
    await expect(retryManifest(manifest, prev as never, config, { source: endedBea, mockResponses: new Map([['a', 'ran']]) })).rejects.toThrow(WORKFLOW_ENDED_REFUSAL);
  });

  it('a nested source is refused at the top level and accepted below it', async () => {
    await expect(runManifest(manifest, config, { source: { kind: 'nested' }, mockResponses: new Map([['a', 'ran']]) })).rejects.toThrow(NESTED_AT_TOP_REFUSAL);
    expect(sourceRefusal({ kind: 'nested' }, 1)).toBeUndefined();
  });

  it('a caller that names no source is refused', async () => {
    await expect(runManifest(manifest, config, { mockResponses: new Map([['a', 'ran']]) } as never)).rejects.toThrow(/must say what it runs/);
    await expect(runManifest(manifest, config, undefined as never)).rejects.toThrow(/must say what it runs/);
  });

  it('a store of mandate ends that throws rejects the run instead of throwing out of runManifest', async () => {
    const broken: RunSource = { ...endedBea, ends: { isLive: () => { throw new Error('engine.db is closed'); } } };
    let call: Promise<unknown> | undefined;
    expect(() => { call = runManifest(manifest, config, { source: broken, mockResponses: new Map([['a', 'ran']]) }); }).not.toThrow();
    await expect(call).rejects.toThrow('engine.db is closed');
  });

  it("a live author's run goes ahead (control)", async () => {
    const state = await runManifest(manifest, config, { source: { ...endedBea, ends: { isLive: () => true } }, mockResponses: new Map([['a', 'ran']]) });
    expect(state.status).toBe('completed');
  });
});

describe('savedWorkflowSource — whom a saved workflow depends on', () => {
  const ends = { isLive: () => true };
  it.each([
    ["the owner's workflow: nobody", OWNERS, []],
    ['a mandate made it: that mandate, with its grant', BEAS, [{ kind: 'mandate', email: 'bea@example.test', mandateId: 'grant-b' }]],
    ['a mandate changed it last: that mandate, with its grant', EDITED_BY_BEA, [{ kind: 'mandate', email: 'bea@example.test', mandateId: 'grant-b' }]],
    ['a mark without a grant id: the mandate without one', { ...BEAS, createdMandateId: null }, [{ kind: 'mandate', email: 'bea@example.test' }]],
  ])('%s', (_label, a, authors) => {
    expect(savedWorkflowSource(WF, () => a, ends)).toEqual({ kind: 'saved', workflowId: WF, authors, ends });
  });

  it('reads the authorship of exactly this id', () => {
    const read = vi.fn(() => OWNERS);
    savedWorkflowSource(WF, read, ends);
    expect(read).toHaveBeenCalledWith(WF);
  });

  it.each([
    ['no row', () => undefined],
    ['a read that throws', () => { throw new Error('gone'); }],
    ['no store to read', undefined],
  ])('unreadable for %s', (_label, read) => {
    expect(savedWorkflowSource(WF, read, ends)).toMatchObject({ authors: 'unreadable' });
  });

  it('a missing store of mandate ends is carried as none', () => {
    expect(savedWorkflowSource(WF, () => OWNERS, undefined)).toMatchObject({ ends: null });
  });

  it('a mandate without a grant id counts as ended, even with every grant live', () => {
    const src = savedWorkflowSource(WF, () => ({ ...BEAS, createdMandateId: null }), { isLive: () => true });
    expect(sourceRefusal(src, 0)).toBe(WORKFLOW_ENDED_REFUSAL);
  });
});
