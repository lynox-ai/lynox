import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChangesetWriter, IAgent, LynoxUserConfig, ToolEntry } from '../types/index.js';

/**
 * A workflow started from a chat runs its steps under that chat's review: each step agent gets
 * the chat agent's writer view (`IAgent.changeset`), so a step's write is saved and recorded in
 * the review, and "Rollback all" undoes it with the chat's own writes. The step does not own the
 * review, so it keeps the checks a write gets without one. A run started without a review
 * behaves as before.
 *
 * A step cannot move files: `batch_files` is not among the tools a step may declare
 * (INLINE_CORE_TOOLS), so the move refusal is pinned for `spawn_agent` children in agent.test.ts.
 *
 * Driven through the real `run_workflow` handler and the real runner, with REAL step agents and
 * the real `write_file` tool; only the LLM is scripted (as in private-mode-workflow-steps.test.ts).
 * Every way a chat starts steps is driven: inline (A), a nested pipeline (D), a saved workflow by
 * id (E) and its retry (F), and a step of a named agent (V).
 */

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
import { writeFileTool } from '../tools/builtin/fs.js';
import { setTenantWorkspace, clearTenantWorkspace } from '../core/workspace.js';
import { ChangesetManager } from '../core/changeset.js';
import { Agent } from '../core/agent.js';
import { createToolContext } from '../core/tool-context.js';
import type { PlannedPipeline } from '../types/index.js';

function endTurnResponse(text: string) {
  return { content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } };
}

function toolUseResponse(id: string, name: string, input: unknown) {
  return { content: [{ type: 'tool_use' as const, id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 } };
}

const config: LynoxUserConfig = { api_key: 'test-key', durable_memory_enabled: false };

let dir: string;
let manager: ChangesetManager;
/** What the step's write_file call answered: its result, or the error it threw. */
let writeResults: string[] = [];

const observedWrite: ToolEntry = {
  ...writeFileTool,
  handler: async (input: unknown, agent: IAgent) => {
    const out = await (writeFileTool.handler as (i: unknown, a: IAgent) => Promise<string>)(input, agent);
    writeResults.push(out);
    return out;
  },
} as ToolEntry;

/** The chat agent's writer view of a real review, as `Agent.changeset` hands it out. */
function viewOf(m: ChangesetManager): ChangesetWriter {
  return new Agent({ name: 'chat', model: 'claude-sonnet-4-6', apiKey: 'test-key', changesetManager: m }).changeset!;
}

// The engine's store of who made a saved workflow, as the owner's: every saved workflow has that
// row, and a run whose author cannot be read does not start. Everything else the run asks of the
// store answers nothing.
const OWNER_HISTORY = new Proxy({
  getWorkflowAuthorship: () => ({ createdBy: null, createdMandateId: null, mandateEditor: null, mandateEditorId: null, mandateEditedAt: null, createdAt: '2026-10-12 12:00:00' }),
} as Record<string, unknown>, { get: (t, k) => (typeof k === 'string' && k in t ? t[k] : () => undefined) }) as unknown as NonNullable<ReturnType<typeof createToolContext>['runHistory']>;

function makeParent(review: ChangesetWriter | undefined): IAgent {
  const ctx = createToolContext(config);
  ctx.runHistory = OWNER_HISTORY;
  ctx.tools = [observedWrite];
  return {
    toolContext: ctx,
    getAvailableTools: () => ctx.tools,
    currentThreadId: 't-1',
    userTimezone: 'UTC',
    changeset: review,
    noteUntrustedData: vi.fn(),
  } as unknown as IAgent;
}

const thesis = (): string => join(dir, 'thesis.md');

function scriptWrite(path: string, content = 'the step wrote this'): void {
  mockProcess.mockImplementationOnce(() => Promise.resolve(toolUseResponse('tu-write', 'write_file', { path, content })));
  mockProcess.mockImplementationOnce(() => Promise.resolve(endTurnResponse('Done.')));
}

const STEP = { id: 'draft', task: 'Write the draft.', tools: ['write_file'] };

function planned(): PlannedPipeline {
  return {
    id: 'wf-review-probe', name: 'Draft', goal: 'Write the draft', steps: [STEP], reasoning: 'probe',
    estimatedCost: 0.01, createdAt: '2026-10-19T12:00:00.000Z', executed: false,
    executionMode: 'orchestrated', template: false, mode: 'autonomous',
  };
}

/** The step overwrote the user's file, the review holds it, and "Rollback all" restores it.
 *  `builtinWrites`: calls of the built-in write_file (a named agent brings its own). */
function expectReviewedAndRolledBack(builtinWrites = 1): void {
  expect(writeResults).toHaveLength(builtinWrites);
  expect(readFileSync(thesis(), 'utf8')).toBe('the step wrote this');
  expect(manager.getChanges().map((c) => [c.file, c.status])).toEqual([['thesis.md', 'modified']]);
  manager.rollbackAll();
  expect(readFileSync(thesis(), 'utf8')).toBe('the user wrote this');
}

describe('workflow steps write under the review of the chat that started them', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess.mockReset();
    _resetPipelineStore();
    writeResults = [];
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'review-steps-')));
    setTenantWorkspace(dir);
    manager = new ChangesetManager(dir, 'run');
    writeFileSync(thesis(), 'the user wrote this');
  });

  afterEach(() => {
    manager.cleanup();
    clearTenantWorkspace();
    rmSync(dir, { recursive: true, force: true });
  });

  it('A: an inline step\'s write is in the review and is rolled back with it', async () => {
    scriptWrite(thesis());
    await runWorkflowTool.handler({ name: 'review-probe', steps: [STEP] }, makeParent(viewOf(manager)));
    expect(manager.isEmpty()).toBe(false);
    expectReviewedAndRolledBack();
  });

  it('A: a file the step creates is in the review as added and is removed with it', async () => {
    const made = join(dir, 'made.md');
    scriptWrite(made);
    await runWorkflowTool.handler({ name: 'review-probe', steps: [STEP] }, makeParent(viewOf(manager)));
    expect(manager.getChanges().map((c) => [c.file, c.status])).toEqual([['made.md', 'added']]);
    manager.rollbackAll();
    expect(existsSync(made)).toBe(false);
  });

  it('A (as before): a chat without a review starts a step whose write stands', async () => {
    scriptWrite(thesis());
    await runWorkflowTool.handler({ name: 'review-probe', steps: [STEP] }, makeParent(undefined));
    expect(writeResults).toHaveLength(1);
    expect(readFileSync(thesis(), 'utf8')).toBe('the step wrote this');
    expect(manager.isEmpty()).toBe(true);
  });

  it('A (not the owner): a step under the review is still refused a write it is refused without one', async () => {
    const secret = join(dir, 'deploy.env');
    for (const review of [undefined, viewOf(manager)]) {
      writeResults = [];
      scriptWrite(secret);
      await runWorkflowTool.handler({ name: 'review-probe', steps: [STEP] }, makeParent(review));
      expect(writeResults).toEqual([]);
      expect(existsSync(secret)).toBe(false);
    }
  });

  it('D: a nested pipeline\'s step writes under the review', async () => {
    scriptWrite(thesis());
    const parent = makeParent(viewOf(manager));
    await runManifest({
      manifest_version: '1.0', name: 'nested-review-probe', triggered_by: 'test', context: {},
      agents: [{ id: 'outer', agent: 'outer', runtime: 'pipeline', pipeline: [STEP] }],
      gate_points: [], on_failure: 'stop',
    }, config, { ...buildRunCtx({
      autonomy: undefined,
      parentTools: [observedWrite],
      parentToolContext: parent.toolContext,
      parentChangeset: parent.changeset,
    }), source: { kind: 'adhoc' as const } });
    expectReviewedAndRolledBack();
  });

  it('E: a saved workflow run by id writes under the review', async () => {
    storePipeline('wf-review-probe', planned());
    scriptWrite(thesis());
    await runWorkflowTool.handler({ workflow_id: 'wf-review-probe' }, makeParent(viewOf(manager)));
    expectReviewedAndRolledBack();
  });

  it('F: its retry does too', async () => {
    const parent = makeParent(viewOf(manager));
    storePipeline('wf-review-probe', planned());
    mockProcess.mockImplementationOnce(() => Promise.reject(new Error('provider down')));
    await runWorkflowTool.handler({ workflow_id: 'wf-review-probe' }, parent);
    expect(writeResults).toEqual([]);
    scriptWrite(thesis());
    await runWorkflowTool.handler({ workflow_id: 'wf-review-probe', retry: true }, parent);
    expectReviewedAndRolledBack();
  });

  it('V: a named agent\'s step writes under the review', async () => {
    const agentsDir = join(dir, 'agents');
    mkdirSync(join(agentsDir, 'writer'), { recursive: true });
    writeFileSync(join(agentsDir, 'writer', 'index.js'), `
import { writeFileSync } from 'node:fs';
export default {
  name: 'writer', version: '1.0.0', defaultTier: 'balanced', systemPrompt: 'You write.',
  tools: [{
    name: 'write_file', description: 'write', input_schema: { type: 'object', properties: {} },
    execute: async (input) => { writeFileSync(input.path, input.content); return 'written'; },
  }],
};
`);
    scriptWrite(thesis());
    const parent = makeParent(viewOf(manager));
    const result = await runManifest({
      manifest_version: '1.0', name: 'agent-review-probe', triggered_by: 'test', context: {},
      agents: [{ id: 'w', agent: 'writer', task: 'Write the draft.' }],
      gate_points: [], on_failure: 'stop',
    }, config, { ...buildRunCtx({ source: { kind: 'adhoc' as const }, autonomy: undefined, parentToolContext: parent.toolContext, parentChangeset: parent.changeset }), agentsDir });
    expect({ status: result.status, write: readFileSync(thesis(), 'utf8') }).toEqual({ status: 'completed', write: 'the step wrote this' });
    expectReviewedAndRolledBack(0);
  });
});
