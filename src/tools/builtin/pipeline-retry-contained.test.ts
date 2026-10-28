/**
 * A retry of a workflow run hands the run's cached outputs to whoever retries it. A run started
 * from a contained chat carries that chat's data, so a retry from another chat contains that chat
 * before any step runs, or nothing runs (`pipeline.ts`, retry mode).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunState, AgentOutput } from '../../types/orchestration.js';
import type { IAgent, ToolEntry } from '../../types/index.js';

vi.mock('../../core/dag-planner.js', () => ({
  estimatePipelineCost: () => ({ steps: [], totalCostUsd: 0 }),
}));
const mockRunManifest = vi.fn();
const mockRetryManifest = vi.fn();
vi.mock('../../orchestrator/runner.js', async (importActual) => {
  const actual = await importActual<typeof import('../../orchestrator/runner.js')>();
  return {
    runManifest: (...args: unknown[]) => mockRunManifest(...args),
    retryManifest: (...args: unknown[]) => mockRetryManifest(...args),
    buildRunCtx: actual.buildRunCtx,
  };
});
vi.mock('../../orchestrator/validate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../orchestrator/validate.js')>();
  return { ...actual, validateManifest: (m: unknown) => m };
});

import { runWorkflowTool, storePipeline, _resetPipelineStore } from './pipeline.js';
import { EngineDb } from '../../core/engine-db.js';
import { RunHistory } from '../../core/run-history.js';
import { Containment, CONTAINED_READ_REFUSAL } from '../../core/containment.js';
import { createToolContext } from '../../core/tool-context.js';

// A busy machine takes longer than the default 10 s to import and open the store.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const tools: ToolEntry[] = [{
  definition: { name: 'bash', description: 'Run bash', input_schema: { type: 'object' as const, properties: {} } },
  handler: vi.fn() as ToolEntry['handler'],
}];

function runState(status: RunState['status']): RunState {
  const out: AgentOutput = {
    stepId: 's', result: 'store order 1001', startedAt: '', completedAt: '', durationMs: 1,
    tokensIn: 1, tokensOut: 1, costUsd: 0, skipped: false,
  };
  return { runId: 'r', manifestName: 'm', startedAt: '', completedAt: '', status, globalContext: {}, outputs: new Map([['s', out]]) };
}

/** A thread store over a map, whose update can be switched off to leave the flag unset. */
function fakeThreads(ids: string[]) {
  const flags = new Map(ids.map((id) => [id, 0]));
  const frozen = { on: false };
  return {
    flags, frozen,
    store: {
      getThread: (id: string) => (flags.has(id) ? { skip_extraction: flags.get(id)! } : undefined),
      updateThread: (id: string, u: { skip_extraction?: boolean }) => { if (!frozen.on && flags.has(id) && u.skip_extraction === true) flags.set(id, 1); },
    },
  };
}

let dir: string;
let engineDb: EngineDb;
let containment: Containment;
let history: RunHistory;
let threads: ReturnType<typeof fakeThreads>;

function chat(thread: string | undefined): IAgent {
  const toolContext = createToolContext({});
  toolContext.tools = tools;
  toolContext.containment = containment;
  toolContext.runHistory = history;
  toolContext.threadStore = threads.store as never;
  return { toolContext, currentThreadId: thread, getAvailableTools: () => tools } as unknown as IAgent;
}

const ID = 'wf-retry';
/** Run the workflow once from `origin`; the run fails, so it can be retried. */
async function firstRun(origin: string): Promise<void> {
  storePipeline(ID, {
    id: ID, name: 'report', goal: 'g', steps: [{ id: 's', task: 't' }], reasoning: 'r', estimatedCost: 0,
    createdAt: new Date().toISOString(), executed: false, executionMode: 'tracked', template: false,
  });
  mockRunManifest.mockResolvedValueOnce(runState('failed'));
  await runWorkflowTool.handler({ workflow_id: ID }, chat(origin));
}
const retry = (agent: IAgent): Promise<string> => {
  mockRetryManifest.mockResolvedValueOnce(runState('completed'));
  return runWorkflowTool.handler({ workflow_id: ID, retry: true }, agent);
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetPipelineStore();
  dir = mkdtempSync(join(tmpdir(), 'lynox-retry-contained-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), '');
  containment = new Containment(engineDb.getDb(), null);
  history = new RunHistory(join(dir, 'history.db'));
  threads = fakeThreads(['chat-shop', 'chat-other', 'chat-third']);
});
afterEach(() => {
  history.close();
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('a retry of a run a contained chat started', () => {
  it('contains the retrying chat before a step runs, and again after a retry from the same chat', async () => {
    await firstRun('chat-shop');
    // A step of the run read the store: the run's chat is contained.
    containment.contain({ kind: 'thread', id: 'chat-shop' }, { kind: 'api', connectionId: 'shop-a' });
    mockRetryManifest.mockImplementationOnce(async () => {
      // Contained before the retried steps run, not after they return.
      expect(containment.isContained({ threadId: 'chat-other' })).toBe(true);
      return runState('completed');
    });
    expect(await runWorkflowTool.handler({ workflow_id: ID, retry: true }, chat('chat-other'))).toContain('store order 1001');
    expect(mockRetryManifest).toHaveBeenCalledTimes(1);
    expect(threads.flags.get('chat-other')).toBe(1);
    // After a retry from the run's own chat, a third chat is still contained.
    expect(await retry(chat('chat-shop'))).toContain('store order 1001');
    expect(await retry(chat('chat-third'))).toContain('store order 1001');
    expect(containment.isContained({ threadId: 'chat-third' })).toBe(true);
    expect(threads.flags.get('chat-third')).toBe(1);
  });

  it('a chat that a retry contained becomes the origin: the next retry from a third chat is contained', async () => {
    await firstRun('chat-shop'); // a chat that never reads the store
    // The retry from chat-other re-runs a step that reads the store, which contains chat-other.
    mockRetryManifest.mockImplementationOnce(async () => {
      containment.contain({ kind: 'thread', id: 'chat-other' }, { kind: 'api', connectionId: 'shop-a' });
      return runState('completed');
    });
    expect(await runWorkflowTool.handler({ workflow_id: ID, retry: true }, chat('chat-other'))).toContain('store order 1001');
    expect(containment.isContained({ threadId: 'chat-shop' })).toBe(false);
    // The retried state holds chat-other's store data, so a third chat reads it only contained.
    expect(await retry(chat('chat-third'))).toContain('store order 1001');
    expect(containment.isContained({ threadId: 'chat-third' })).toBe(true);
    expect(threads.flags.get('chat-third')).toBe(1);
  });

  it('refuses, running nothing, when the retrying chat cannot be contained or has no thread', async () => {
    await firstRun('chat-shop');
    containment.contain({ kind: 'thread', id: 'chat-shop' }, { kind: 'api', connectionId: 'shop-a' });
    threads.frozen.on = true;
    expect(await retry(chat('chat-other'))).toBe(`Error: ${CONTAINED_READ_REFUSAL}`);
    threads.frozen.on = false;
    expect(await retry(chat(undefined))).toBe(`Error: ${CONTAINED_READ_REFUSAL}`);
    expect(mockRetryManifest).not.toHaveBeenCalled();
  });

  it('a run from an uncontained chat, or a retry from its own chat, contains nothing new (control)', async () => {
    await firstRun('chat-shop');
    expect(await retry(chat('chat-other'))).toContain('store order 1001');
    expect(containment.isContained({ threadId: 'chat-other' })).toBe(false);
    expect(threads.flags.get('chat-other')).toBe(0);
    containment.contain({ kind: 'thread', id: 'chat-shop' }, { kind: 'api', connectionId: 'shop-a' });
    expect(await retry(chat('chat-shop'))).toContain('store order 1001');
    expect(mockRetryManifest).toHaveBeenCalledTimes(2);
  });
});

// run_workflow lets `secret:` references travel as written, so a step resolves them through the
// caller's store; a retried step must get that store as a first run's step does.
describe('a retry hands its steps the caller\'s secret store', () => {
  it('passes the same store to the retried steps as to the first run\'s', async () => {
    const secretStore = { resolve: vi.fn() };
    const withStore = (thread: string): IAgent => Object.assign(chat(thread), { secretStore }) as IAgent;
    storePipeline(ID, {
      id: ID, name: 'report', goal: 'g', steps: [{ id: 's', task: 't' }], reasoning: 'r', estimatedCost: 0,
      createdAt: new Date().toISOString(), executed: false, executionMode: 'tracked', template: false,
    });
    mockRunManifest.mockResolvedValueOnce(runState('failed'));
    await runWorkflowTool.handler({ workflow_id: ID }, withStore('chat-shop'));
    expect((mockRunManifest.mock.calls[0]![2] as { secretStore?: unknown }).secretStore).toBe(secretStore);
    expect(await retry(withStore('chat-shop'))).toContain('store order 1001');
    expect((mockRetryManifest.mock.calls[0]![3] as { secretStore?: unknown }).secretStore).toBe(secretStore);
  });
});

