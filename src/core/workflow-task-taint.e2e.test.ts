/**
 * A workflow task carries what the session that created it had taken in, end to end.
 *
 * Real: RunHistory + EngineDb + TaskManager, the `task_create` tool, WorkerLoop.executePipeline,
 * runGuardedSavedWorkflow, runManifest, spawnInline and the step Agent. Mocked: the LLM (it
 * answers with the tool call a step would make) and the two tool handlers, which only observe.
 *
 * Each factor of this chain has its own unit test; this one pins the HAND-OFFS between them,
 * which no unit test sees: a value recorded by one layer and never passed to the next would
 * leave every unit green.
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

const mockProcess = vi.fn();
vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { WorkerLoop } from './worker-loop.js';
import { createToolContext } from './tool-context.js';
import { deriveTurnUntrusted } from './untrusted-signals.js';
import { taskCreateTool } from '../tools/builtin/task.js';
import { storePipeline, _resetPipelineStore } from '../tools/builtin/pipeline.js';
import { _resetTenantInvariantForTests } from './saved-workflow-runner.js';
import type { IAgent, ToolEntry, PlannedPipeline, TriggerRecord } from '../types/index.js';
import type { Engine } from './engine.js';

const endTurn = (text: string) => ({
  content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
});
const toolUse = (name: string, input: unknown) => ({
  content: [{ type: 'tool_use' as const, id: 'tu_1', name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
});

describe('a workflow task carries its creator\'s untrusted-content state into the run', () => {
  let dir: string;
  let history: RunHistory;
  let engineDb: EngineDb;
  let tm: TaskManager;
  /** What `memory_store` would record as `sourceUntrusted`, and what `http_request` received. */
  const seen: { sourceUntrusted?: boolean; httpInput?: unknown } = {};

  const memoryStore: ToolEntry = {
    definition: { name: 'memory_store', description: 'store', input_schema: { type: 'object', properties: { content: { type: 'string' } } } },
    // The real tool derives its write-trust from this very function (tools/builtin/memory.ts).
    handler: async (_input: unknown, agent: IAgent) => { seen.sourceUntrusted = deriveTurnUntrusted(agent); return 'stored'; },
  };
  const httpRequest: ToolEntry = {
    definition: { name: 'http_request', description: 'http', input_schema: { type: 'object', properties: { url: { type: 'string' }, headers: { type: 'object' } } } },
    handler: async (input: unknown) => { seen.httpInput = input; return 'ok'; },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete seen.sourceUntrusted; delete seen.httpInput;
    dir = mkdtempSync(join(tmpdir(), 'lynox-wf-taint-'));
    history = new RunHistory(join(dir, 'history.db'));
    engineDb = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engineDb);
    tm = new TaskManager(history);
    _resetPipelineStore();
    _resetTenantInvariantForTests();
  });

  afterEach(() => {
    try { engineDb.close(); } catch { /* closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function workflow(id: string, tools: string[]): PlannedPipeline {
    const planned = {
      id, name: id, goal: 'g', steps: [{ id: 's1', task: 'do the step', tools }],
      reasoning: 'r', estimatedCost: 0, createdAt: '2026-07-01T00:00:00.000Z',
      executed: false, executionMode: 'orchestrated', template: true, mode: 'autonomous',
      confirmedAt: '2026-07-01T00:00:00.000Z', parameters: [],
    } as unknown as PlannedPipeline;
    history.insertPlannedPipeline({ id, name: id, goal: 'g', steps: [], reasoning: '', estimatedCost: 0, createdAt: planned.createdAt, template: true });
    history.setWorkflowConfirmedAt(id, '2026-07-01T00:00:00.000Z');
    storePipeline(id, planned);
    return planned;
  }

  function creator(tainted: boolean): IAgent {
    const ctx = createToolContext({});
    ctx.taskManager = tm;
    ctx.runHistory = history;
    return {
      name: 'creator', model: 'claude-haiku-4-5-20251001', memory: null, tools: [], onStream: null,
      toolContext: ctx, ...(tainted ? { conversationSawUntrusted: true } : {}),
    } as unknown as IAgent;
  }

  async function createAndRun(workflowId: string, tainted: boolean): Promise<void> {
    const out = await taskCreateTool.handler(
      { title: `task ${String(tainted)}`, assignee: 'lynox', workflow_id: workflowId, schedule: '0 9 * * 1' }, creator(tainted),
    );
    expect(out).toContain('Workflow task created');
    const task = tm.listTriggers().find((t) => t.title === `task ${String(tainted)}`)!;
    const engine = {
      getTaskManager: () => tm,
      getUserConfig: () => ({ api_key: 'test-key' }),
      getContext: () => null,
      getHooks: () => [],
      getToolContext: () => ({ tools: [memoryStore, httpRequest] }),
      getMemory: () => null,
      getRunHistory: () => history,
      getSecretStore: () => null,
      escalateToUser: () => null,
    } as unknown as Engine;
    const loop = new WorkerLoop(engine, { hasChannels: () => false, notify: vi.fn() } as never, 60_000);
    await (loop as unknown as { executePipeline: (t: TriggerRecord) => Promise<void> }).executePipeline(task);
  }

  it('a step\'s durable write is marked untrusted when the creating session had read untrusted content', async () => {
    workflow('wf-store', ['memory_store']);
    mockProcess.mockResolvedValueOnce(toolUse('memory_store', { content: 'a fact' })).mockResolvedValueOnce(endTurn('done'));
    await createAndRun('wf-store', true);
    expect(seen.sourceUntrusted).toBe(true);
  });

  it('CONTROL: the same workflow from a clean session writes as trusted', async () => {
    workflow('wf-store', ['memory_store']);
    mockProcess.mockResolvedValueOnce(toolUse('memory_store', { content: 'a fact' })).mockResolvedValueOnce(endTurn('done'));
    await createAndRun('wf-store', false);
    expect(seen.sourceUntrusted).toBe(false);
  });

  it('PINS TODAY: a scheduled run resolves no secrets — a reference reaches the tool as text', async () => {
    // The headless run passes its steps no secret store, so `secret:NAME` is never resolved
    // here. If that changes, this test has to change with it — and from then on the secret
    // destination gate in agent.ts is what decides where a secret may go in a scheduled run,
    // judged with the taint this file pins above.
    workflow('wf-http', ['http_request']);
    mockProcess
      .mockResolvedValueOnce(toolUse('http_request', { url: 'https://example.org/', headers: { 'X-A': 'secret:SERVICE_TOKEN' } }))
      .mockResolvedValueOnce(endTurn('done'));
    await createAndRun('wf-http', false);
    expect(JSON.stringify(seen.httpInput)).toContain('secret:SERVICE_TOKEN');
  });
});
