import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgent, LynoxUserConfig, PlannedPipeline, ToolEntry } from '../types/index.js';
import type { WorkflowAuthorship } from '../core/workflow-store.js';
import { OWNER_PRINCIPAL } from '../core/request-principal.js';

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
  // The agent's name rides along (a step's agent is named after the step), so a test can tell
  // which step a turn belongs to when steps run side by side.
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: (s: unknown) => unknown }, _handler: unknown, name: string) {
    this.process = (s: unknown) => mockProcess(s, name);
  }),
}));

import { runWorkflowTool, runSavedWorkflow, _resetPipelineStore, storePipeline } from '../tools/builtin/pipeline.js';
import { runManifest, retryManifest, stopForEndedAuthor } from './runner.js';
import {
  savedWorkflowSource, sourceRefusal, WORKFLOW_ENDED_REFUSAL, WORKFLOW_ENDED_MID_RUN, WORKFLOW_ENDED_MID_RUN_ERROR, WORKFLOW_END_CHECK_FAILED, WORKFLOW_END_CHECK_FAILED_ERROR, WORKFLOW_OF_ANOTHER_REFUSAL, WORKFLOW_UNREADABLE_REFUSAL, NESTED_AT_TOP_REFUSAL,
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
/** Set mid-run by a test: the store of mandate ends throws from then on. */
let liveThrows = false;
/** What the run wrote as its run row's end (`pipeline_runs`), in order. */
let runUpdates: Array<Record<string, unknown>> = [];

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
    updatePipelineRun: (_id: string, u: Record<string, unknown>) => { runUpdates.push(u); },
    getWorkflowAuthorship: (id: string) => {
      if (authorship === 'throws') throw new Error('engine.db is gone');
      return id === WF ? authorship : undefined;
    },
  } as Record<string, unknown>, { get: (t, k) => (typeof k === 'string' && k in t ? t[k] : () => undefined) }) as unknown as NonNullable<typeof ctx.runHistory>;
  ctx.mandateEnds = live === null ? null : { isLive: (id: string) => { if (liveThrows) throw new Error('engine.db is gone'); return live!.has(id); } };
  return ctx;
}

function chat(principal?: IAgent['principal']): IAgent {
  const ctx = engineContext();
  // A stored workflow run as a mandate writes its run row first (660b): without a log it would not
  // run. Since 1100 that is the owner's chat too, on a mandate's workflow.
  (ctx as unknown as Record<string, unknown>)['auditLog'] = { record: vi.fn() };
  return {
    toolContext: ctx,
    getAvailableTools: () => ctx.tools,
    currentThreadId: 't-1',
    userTimezone: 'UTC',
    principal: principal ?? OWNER_PRINCIPAL,
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
  liveThrows = false;
  runUpdates = [];
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
    // Since 1100 refused before the runner: another mandate's workflow is not this mandate's to run.
    expect(out).toBe(`Error: ${WORKFLOW_OF_ANOTHER_REFUSAL}`);
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
    return { tools: ctx.tools, toolContext: ctx, principal: OWNER_PRINCIPAL };
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
    const result = await runSavedWorkflow(WF, ctx.runHistory, config, undefined, { principal: OWNER_PRINCIPAL });
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

// 1100: the check at the start is not the only one. A mandate whose access ends while the run is
// under way ends the run before its next step, whoever started it.
describe('an access that ends mid-run ends the run before its next step (1100)', () => {
  function twoSteps(): void {
    storePipeline(WF, { ...planned(), steps: [{ id: 'write', task: 'Write the report.' }, { id: 'send', task: 'Send the report.', input_from: ['write'] }] });
  }
  /** Step one's turn; `end` ends B's grant while it runs. */
  function scriptFirst(end: boolean): void {
    mockProcess.mockImplementationOnce(() => {
      if (end) live!.delete('grant-b');
      return Promise.resolve(endTurnResponse('Report written.'));
    });
  }

  it("the owner's chat: B's grant ends during step one, step two never reaches the provider", async () => {
    authorship = BEAS;
    twoSteps();
    scriptFirst(true);
    scriptStep();
    const out = await runWorkflowTool.handler({ workflow_id: WF }, chat());
    expect(mockProcess).toHaveBeenCalledTimes(1);
    expect(out).toContain(WORKFLOW_ENDED_MID_RUN);
  });

  it('control: the grant stays live, both steps run', async () => {
    authorship = BEAS;
    twoSteps();
    scriptFirst(false);
    scriptStep();
    const out = await runWorkflowTool.handler({ workflow_id: WF }, chat());
    expect(mockProcess).toHaveBeenCalledTimes(2);
    expect(out).not.toContain(WORKFLOW_ENDED_MID_RUN);
  });

  it("the library's run (runSavedWorkflow): the same end", async () => {
    authorship = EDITED_BY_BEA;
    twoSteps();
    scriptFirst(true);
    scriptStep();
    const ctx = engineContext();
    // As the library's Run hands it: the mandate the workflow runs as (1055).
    const result = await runSavedWorkflow(WF, ctx.runHistory, config, undefined, { tools: ctx.tools, toolContext: ctx, principal: { kind: 'mandate', email: 'bea@example.test', mandateId: 'grant-b' } });
    expect(mockProcess).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, status: 'failed', error: WORKFLOW_ENDED_MID_RUN_ERROR });
  });

  it("the run row's stored error says why the run stopped and holds no sentence to the model (1184)", async () => {
    authorship = EDITED_BY_BEA;
    twoSteps();
    scriptFirst(true);
    scriptStep();
    const ctx = engineContext();
    await runSavedWorkflow(WF, ctx.runHistory, config, undefined, { tools: ctx.tools, toolContext: ctx, principal: { kind: 'mandate', email: 'bea@example.test', mandateId: 'grant-b' } });
    const stored = runUpdates.map((u) => u['error']).filter((e) => e !== undefined);
    expect(stored).toEqual([WORKFLOW_ENDED_MID_RUN_ERROR]);
    expect(String(stored[0])).not.toMatch(/tell the user|do not start it again/i);
  });

  it('the wording, as reviewed: the stored error speaks to the person (U-145), the model text is unchanged (U-122)', () => {
    expect(WORKFLOW_ENDED_MID_RUN_ERROR).toBe('The access of someone who set up or changed this workflow ended while it ran, so it stopped before its next step. '
      + 'Starting it again will not work. To finish the remaining steps, ask lynox in a chat to do them or to write a new workflow for them.');
    expect(WORKFLOW_ENDED_MID_RUN).toBe('The access of someone who set up or changed this workflow ended while it ran, so it stopped before its next step. '
      + 'The steps listed in this result ran; the others did not. Starting this workflow again is refused for the same reason, so do not start it again. '
      + 'If the remaining steps are still needed, tell the user they can describe them in chat and ask lynox to do them or to write a new workflow for them.');
    expect(WORKFLOW_END_CHECK_FAILED_ERROR).toBe('Could not check whether the access of everyone who set up or changed this workflow is still active, so it stopped before its next step. '
      + "No one's access is known to have ended. You can start it again, but the steps that already ran will run again, so first check that this does no harm.");
    expect(WORKFLOW_END_CHECK_FAILED).toBe('Could not check whether the access of everyone who set up or changed this workflow is still active, so it stopped before its next step. '
      + "No one's access is known to have ended. The steps listed in this result ran; the others did not. Do not say that anyone's access ended or name another cause. "
      + 'Tell the user they can start it again, and that the steps that already ran would then run again. Do not start it yourself unless they ask.');
  });

  it("the owner's chat still reads what to tell the user, as the result's endedBecause (1184)", async () => {
    authorship = BEAS;
    twoSteps();
    scriptFirst(true);
    scriptStep();
    const out = JSON.parse(await runWorkflowTool.handler({ workflow_id: WF }, chat()) as string) as Record<string, unknown>;
    expect(out['endedBecause']).toBe(WORKFLOW_ENDED_MID_RUN);
  });

  it('a store of ends that throws mid-run ends the run before its next step too', async () => {
    authorship = BEAS;
    twoSteps();
    mockProcess.mockImplementationOnce(() => { liveThrows = true; return Promise.resolve(endTurnResponse('Report written.')); });
    scriptStep();
    const out = await runWorkflowTool.handler({ workflow_id: WF }, chat());
    expect(mockProcess).toHaveBeenCalledTimes(1);
    // Stopped, but with its own cause: no end was found, so none is said (1184).
    expect((JSON.parse(out as string) as Record<string, unknown>)['endedBecause']).toBe(WORKFLOW_END_CHECK_FAILED);
    expect(out).not.toContain('ended while it ran');
  });

  it("control: the owner's own workflow does not depend on B and runs both steps when B's grant ends", async () => {
    authorship = OWNERS;
    twoSteps();
    scriptFirst(true);
    scriptStep();
    await runWorkflowTool.handler({ workflow_id: WF }, chat());
    expect(mockProcess).toHaveBeenCalledTimes(2);
  });
});

// 1100: the check before a step keeps an end the run already has, as the owner's stop does.
describe('stopForEndedAuthor keeps a cause the run already ended on', () => {
  const ended: RunSource = { kind: 'saved', workflowId: WF, authors: [{ kind: 'mandate', email: 'bea@example.test', mandateId: 'grant-b' }], ends: { isLive: () => false } };
  const state = (status: 'running' | 'failed', error?: string) => ({ runId: 'r', status, outputs: new Map(), startedAt: new Date().toISOString(), ...(error ? { error } : {}) }) as unknown as Parameters<typeof stopForEndedAuthor>[1];

  it('a run that already failed on a step halts, and keeps that step\'s error', () => {
    const s = state('failed', 'step two: the API answered 500');
    expect(stopForEndedAuthor({ source: ended } as Parameters<typeof stopForEndedAuthor>[0], s)).toBe(true);
    expect(s.error).toBe('step two: the API answered 500');
  });

  it('CONTROL: a running run halts with the mid-run end as its error', () => {
    const s = state('running');
    expect(stopForEndedAuthor({ source: ended } as Parameters<typeof stopForEndedAuthor>[0], s)).toBe(true);
    expect([s.status, s.error]).toEqual(['failed', WORKFLOW_ENDED_MID_RUN_ERROR]);
  });

  it('a check that throws halts the running run with an error that does not say an access ended (1184)', () => {
    const s = state('running');
    const broken: RunSource = { ...ended, ends: { isLive: () => { throw new Error('engine.db is gone'); } } } as RunSource;
    expect(stopForEndedAuthor({ source: broken } as Parameters<typeof stopForEndedAuthor>[0], s)).toBe(true);
    expect([s.status, s.error]).toEqual(['failed', WORKFLOW_END_CHECK_FAILED_ERROR]);
  });
});

// 1184 (1): a `runtime: 'pipeline'` step's sub-run reads the access of the saved workflow that
// holds it before each of ITS steps, not only the outer run before each outer step.
describe('a sub-run stops before its next step when a maker\'s access ends during it (1184)', () => {
  const nestedManifest = {
    manifest_version: '1.1' as const, name: 'probe', triggered_by: 'test', context: {},
    agents: [{
      id: 'outer', agent: 'outer', runtime: 'pipeline' as const,
      pipeline: [{ id: 'inner-write', task: 'Write the report.' }, { id: 'inner-send', task: 'Send the report.', input_from: ['inner-write'] }],
    }],
    gate_points: [], on_failure: 'stop' as const,
  };
  function beaSource(liveSet: Set<string>): RunSource {
    return { kind: 'saved', workflowId: WF, authors: [{ kind: 'mandate', email: 'bea@example.test', mandateId: 'grant-b' }], ends: { isLive: (id) => liveSet.has(id) } };
  }

  it("B's grant ends during the sub-run's first step: its second never reaches the provider, and the run says why", async () => {
    const liveSet = new Set(['grant-b']);
    mockProcess.mockImplementationOnce(() => { liveSet.delete('grant-b'); return Promise.resolve(endTurnResponse('Report written.')); });
    mockProcess.mockImplementation(() => Promise.resolve(endTurnResponse('Report sent.')));
    const state = await runManifest(nestedManifest, config, { source: beaSource(liveSet) });
    expect(mockProcess).toHaveBeenCalledTimes(1);
    expect([state.status, state.error]).toEqual(['failed', WORKFLOW_ENDED_MID_RUN_ERROR]);
  });

  it('control: the grant stays live, both sub-steps run', async () => {
    const liveSet = new Set(['grant-b']);
    mockProcess.mockImplementation(() => Promise.resolve(endTurnResponse('done')));
    const state = await runManifest(nestedManifest, config, { source: beaSource(liveSet) });
    expect(mockProcess).toHaveBeenCalledTimes(2);
    expect(state.status).toBe('completed');
  });

  it("the outer run ends with the sub-run's cause word for word, though a second read would succeed", async () => {
    // The read before the sub-run's second step throws once; a second read by the outer run
    // would succeed and could not tell what the sub-run stopped on.
    let throwOnce = false;
    const source: RunSource = { kind: 'saved', workflowId: WF, authors: [{ kind: 'mandate', email: 'bea@example.test', mandateId: 'grant-b' }],
      ends: { isLive: () => { if (throwOnce) { throwOnce = false; throw new Error('engine.db busy'); } return true; } } };
    mockProcess.mockImplementationOnce(() => { throwOnce = true; return Promise.resolve(endTurnResponse('Report written.')); });
    mockProcess.mockImplementation(() => Promise.resolve(endTurnResponse('Report sent.')));
    const state = await runManifest({ ...nestedManifest, on_failure: 'continue' as const }, config, { source });
    expect(mockProcess).toHaveBeenCalledTimes(1);
    expect([state.status, state.error]).toEqual(['failed', WORKFLOW_END_CHECK_FAILED_ERROR]);
  });
});

// 1184, review r2: steps of one phase run side by side. A sibling that fails after a sub-run
// stopped the run for its makers' access does not replace that cause.
describe("a sibling's later failure keeps the access stop (1184)", () => {
  it.each(['stop', 'continue'] as const)('sub-run stops for the end, then a sibling in the same phase fails under %s: the run keeps the end', async (onFailure) => {
    const liveSet = new Set(['grant-b']);
    const source: RunSource = { kind: 'saved', workflowId: WF, authors: [{ kind: 'mandate', email: 'bea@example.test', mandateId: 'grant-b' }], ends: { isLive: (id) => liveSet.has(id) } };
    let siblingFailedAt = 0;
    let stopSeenAt = 0;
    // The sibling's turn is under way before the grant ends (so its own check before the step
    // passed), and fails only after the sub-run has stopped the run.
    let siblingStarted!: () => void;
    const started = new Promise<void>((r) => { siblingStarted = r; });
    mockProcess.mockImplementation(async (_s: unknown, name: string) => {
      if (name === 'inner-write') { await started; liveSet.delete('grant-b'); return endTurnResponse('Report written.'); }
      if (name === 'sibling') {
        siblingStarted();
        return new Promise((_r, reject) => setTimeout(() => { siblingFailedAt = Date.now(); reject(new Error('the API answered 500')); }, 300));
      }
      return endTurnResponse('done');
    });
    const manifest = {
      manifest_version: '1.1' as const, name: 'probe', triggered_by: 'test', context: {}, execution: 'parallel' as const,
      agents: [
        { id: 'outer', agent: 'outer', runtime: 'pipeline' as const,
          pipeline: [{ id: 'inner-write', task: 'Write the report.' }, { id: 'inner-send', task: 'Send the report.', input_from: ['inner-write'] }] },
        { id: 'sibling', agent: 'sibling', runtime: 'inline' as const, task: 'Post the summary.' },
      ],
      gate_points: [], on_failure: onFailure,
    };
    const state = await runManifest(manifest, config, { source, parentTools: [], hooks: { onError: (id: string) => { if (id === 'outer') stopSeenAt = Date.now(); } } });
    // The order the test is about: the sub-run's stop was recorded before the sibling failed.
    expect(stopSeenAt).toBeGreaterThan(0);
    expect(siblingFailedAt).toBeGreaterThan(stopSeenAt);
    expect([state.status, state.error]).toEqual(['failed', WORKFLOW_ENDED_MID_RUN_ERROR]);
    // Under continue the sibling's own failure is still recorded as its output (review r3).
    if (onFailure === 'continue') expect(state.outputs.get('sibling')?.error).toBe('the API answered 500');
  });
});

// 1184, review r1 L1: the check before a step is not repeated when a step fails. A step that fails
// on its own, under `on_failure: 'continue'`, leaves the run to finish as it did before.
describe("a step's own failure keeps its outcome (1184)", () => {
  it('the last step fails under continue while the read of the access would throw: the run completes', async () => {
    let reads = 0;
    const source: RunSource = { kind: 'saved', workflowId: WF, authors: [{ kind: 'mandate', email: 'bea@example.test', mandateId: 'grant-b' }],
      // Live for the start and the check before the step; any read after it throws.
      ends: { isLive: () => { reads++; if (reads > 2) throw new Error('engine.db busy'); return true; } } };
    mockProcess.mockImplementation(() => Promise.reject(new Error('the API answered 500')));
    const manifest = {
      manifest_version: '1.1' as const, name: 'probe', triggered_by: 'test', context: {},
      agents: [{ id: 'send', agent: 'send', runtime: 'inline' as const, task: 'Send the report.' }], gate_points: [], on_failure: 'continue' as const,
    };
    const state = await runManifest(manifest, config, { source, parentTools: [] });
    expect(mockProcess, 'the step reached the provider and failed there').toHaveBeenCalled();
    expect(state.status).toBe('completed');
    expect(state.error).toBeUndefined();
  });
});
