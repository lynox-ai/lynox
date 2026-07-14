import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveWorkflowTool, processToSteps } from './process.js';
import { _resetPipelineStore, getPipeline, storePipeline } from './pipeline.js';
import { createToolContext } from '../../core/tool-context.js';
import { RunHistory } from '../../core/run-history.js';
import { EngineDb } from '../../core/engine-db.js';
import type { IAgent, ProcessRecord, LynoxUserConfig, PlannedPipeline } from '../../types/index.js';

// === Mock process-capture (the Haiku extraction step) ===

const captureProcessMock = vi.fn();
vi.mock('../../core/process-capture.js', () => ({
  captureProcess: (...args: unknown[]) => captureProcessMock(...args),
}));

const SAMPLE_RECORD: ProcessRecord = {
  id: 'proc-123',
  name: 'Test Process',
  description: 'A test process',
  sourceRunId: 'run-abc',
  steps: [
    { order: 0, tool: 'http_request', description: 'Fetch data from API', inputTemplate: { url: '{{api_url}}' }, dependsOn: [] },
    { order: 1, tool: 'write_file', description: 'Generate report', inputTemplate: { path: 'report.pdf' }, dependsOn: [0] },
  ],
  parameters: [
    { name: 'api_url', description: 'API endpoint', type: 'string', defaultValue: 'https://api.example.com', source: 'user_input' },
    { name: 'time_range', description: 'Reporting period', type: 'date', defaultValue: 'last month', source: 'relative_date' },
  ],
  createdAt: '2026-03-21T12:00:00.000Z',
};

const SESSION_TOOL_CALLS = [
  { id: 'tc0', run_id: 'run-earlier', tool_name: 'http_request', input_json: '{}', output_json: '', duration_ms: 100, sequence_order: 0 },
  { id: 'tc1', run_id: 'run-earlier', tool_name: 'write_file', input_json: '{}', output_json: '', duration_ms: 80, sequence_order: 1 },
  { id: 'tc2', run_id: 'run-abc', tool_name: 'save_workflow', input_json: '{}', output_json: '', duration_ms: 5, sequence_order: 0 },
];

// === Mock RunHistory ===

function makeMockRunHistory() {
  const processes = new Map<string, ProcessRecord>();
  return {
    getRunToolCalls: vi.fn().mockReturnValue([SESSION_TOOL_CALLS[0]]),
    getSessionToolCalls: vi.fn().mockReturnValue(SESSION_TOOL_CALLS),
    getRun: vi.fn().mockReturnValue({ id: 'run-abc', session_id: 'thread-1' }),
    insertProcess: vi.fn().mockImplementation((record: ProcessRecord) => {
      processes.set(record.id, record);
    }),
    getProcess: vi.fn().mockImplementation((id: string) => processes.get(id)),
    getPlannedPipeline: vi.fn().mockReturnValue(undefined),
    insertPlannedPipeline: vi.fn(),
    getAvgStepCostByModelTier: vi.fn().mockReturnValue({}),
    _store: processes,
  };
}

const mockConfig = { api_key: 'test-key' } as LynoxUserConfig;

function makeAgent(
  overrides: Partial<IAgent> = {},
  runHistory: unknown = null,
  userConfig: LynoxUserConfig = mockConfig,
): IAgent {
  const toolContext = createToolContext(userConfig);
  toolContext.runHistory = runHistory as never;
  return {
    name: 'test',
    model: 'test-model',
    memory: null,
    tools: [],
    onStream: null,
    currentRunId: 'run-abc',
    toolContext,
    ...overrides,
  } as unknown as IAgent;
}

// =====================================================================
// Source A — session capture (no workflow_id)
// =====================================================================

describe('save_workflow — session source', () => {
  let mockHistory: ReturnType<typeof makeMockRunHistory>;

  beforeEach(() => {
    _resetPipelineStore();
    mockHistory = makeMockRunHistory();
    captureProcessMock.mockReset();
    captureProcessMock.mockResolvedValue(structuredClone(SAMPLE_RECORD));
  });

  it('captures the session and stores a reusable workflow in one call', async () => {
    const agent = makeAgent({ currentThreadId: 'thread-1' }, mockHistory);
    const result = await saveWorkflowTool.handler({ name: 'Monthly Report' }, agent);

    const parsed = JSON.parse(result) as { workflow_id: string; steps: number; source: string; parameters: string[] };
    expect(parsed.workflow_id).toBeDefined();
    expect(parsed.steps).toBe(2);
    expect(parsed.source).toBe('session');
    expect(parsed.parameters).toEqual(['api_url', 'time_range']);

    // The PlannedPipeline is stored, flagged as a reusable template.
    const pipeline = getPipeline(parsed.workflow_id);
    expect(pipeline).toBeDefined();
    expect(pipeline!.template).toBe(true);
    expect(pipeline!.executed).toBe(false);
    expect(pipeline!.steps).toHaveLength(2);
    expect(pipeline!.steps[1]!.input_from).toEqual(['step-0']);
    // Persisted to pipeline_runs so the Saved Workflows library finds it.
    expect(mockHistory.insertPlannedPipeline).toHaveBeenCalledTimes(1);
  });

  it('first-run-confirms the saved workflow (self-built = authorised)', async () => {
    // The provenance seam behind the library Run gate + the worker-loop cron gate:
    // the user authored these steps in their own session, so the saved workflow is
    // confirmed for unattended execution at save time. An IMPORTED workflow lands
    // UNCONFIRMED on purpose (its steps are attacker-authorable) — asserted in
    // import-workflow.test.ts. Without this stamp the Run gate would refuse a
    // user's own saved workflow.
    const agent = makeAgent({ currentThreadId: 'thread-1' }, mockHistory);
    await saveWorkflowTool.handler({ name: 'Test' }, agent);
    const pipeline = mockHistory.insertPlannedPipeline.mock.calls[0]?.[0] as PlannedPipeline | undefined;
    expect(pipeline?.confirmedAt).toBeTruthy();
  });

  it('resolves input_from by step order even when order != array index', async () => {
    // Regression: processToSteps builds step IDs as `step-<order>`. Deriving
    // `input_from` from the array index instead of the order value left a
    // dangling reference whenever a captured record's `order` was not 0,1,2…
    captureProcessMock.mockResolvedValue({
      ...structuredClone(SAMPLE_RECORD),
      steps: [
        { order: 10, tool: 'http_request', description: 'Fetch', inputTemplate: {}, dependsOn: [] },
        { order: 20, tool: 'write_file', description: 'Report', inputTemplate: {}, dependsOn: [10] },
      ],
    });
    const agent = makeAgent({ currentThreadId: 'thread-1' }, mockHistory);
    const result = await saveWorkflowTool.handler({ name: 'Test' }, agent);
    const parsed = JSON.parse(result) as { workflow_id: string };
    const pipeline = getPipeline(parsed.workflow_id);
    expect(pipeline!.steps[0]!.id).toBe('step-10');
    expect(pipeline!.steps[1]!.id).toBe('step-20');
    // input_from must point at step[0]'s real id (`step-10`), not `step-1`.
    expect(pipeline!.steps[1]!.input_from).toEqual(['step-10']);
  });

  it('writes the internal ProcessRecord for lineage (D11) linked to the pipeline', async () => {
    const agent = makeAgent({ currentThreadId: 'thread-1' }, mockHistory);
    const result = await saveWorkflowTool.handler({ name: 'Monthly Report' }, agent);
    const parsed = JSON.parse(result) as { workflow_id: string };

    expect(mockHistory.insertProcess).toHaveBeenCalledOnce();
    const stored = mockHistory.insertProcess.mock.calls[0]![0] as ProcessRecord;
    // The ProcessRecord records which pipeline it was promoted into.
    expect(stored.promotedToPipelineId).toBe(parsed.workflow_id);
  });

  it('gathers session-wide tool calls, not just the current run', async () => {
    const agent = makeAgent({ currentThreadId: 'thread-1' }, mockHistory);
    await saveWorkflowTool.handler({ name: 'Monthly Report' }, agent);

    expect(mockHistory.getSessionToolCalls).toHaveBeenCalledWith('thread-1');
    expect(mockHistory.getRunToolCalls).not.toHaveBeenCalled();
    expect(captureProcessMock).toHaveBeenCalledWith(
      'run-abc',
      'Monthly Report',
      SESSION_TOOL_CALLS,
      expect.objectContaining({ apiKey: 'test-key' }),
    );
  });

  it('falls back to run.session_id when currentThreadId is absent', async () => {
    const agent = makeAgent({ currentThreadId: undefined }, mockHistory);
    await saveWorkflowTool.handler({ name: 'Test' }, agent);

    expect(mockHistory.getRun).toHaveBeenCalledWith('run-abc');
    expect(mockHistory.getSessionToolCalls).toHaveBeenCalledWith('thread-1');
    expect(mockHistory.getRunToolCalls).not.toHaveBeenCalled();
  });

  it('falls back to single-run scope when no session can be resolved', async () => {
    mockHistory.getRun.mockReturnValue({ id: 'run-abc', session_id: '' });
    const agent = makeAgent({ currentThreadId: undefined }, mockHistory);
    await saveWorkflowTool.handler({ name: 'Test' }, agent);

    expect(mockHistory.getRunToolCalls).toHaveBeenCalledWith('run-abc');
    expect(mockHistory.getSessionToolCalls).not.toHaveBeenCalled();
  });

  it('errors without currentRunId', async () => {
    const agent = makeAgent({ currentRunId: undefined }, mockHistory);
    const result = await saveWorkflowTool.handler({ name: 'Test' }, agent);
    expect(result).toContain('No active run');
  });

  it('errors without run history', async () => {
    const agent = makeAgent({}, null);
    const result = await saveWorkflowTool.handler({ name: 'Test' }, agent);
    expect(result).toContain('not available');
  });

  it('errors when no tool calls are found', async () => {
    mockHistory.getSessionToolCalls.mockReturnValue([]);
    mockHistory.getRunToolCalls.mockReturnValue([]);
    const agent = makeAgent({ currentThreadId: 'thread-1' }, mockHistory);
    const result = await saveWorkflowTool.handler({ name: 'Test' }, agent);
    expect(result).toContain('Nothing to save');
  });

  it('reports nothing-to-save when extraction yields zero steps', async () => {
    captureProcessMock.mockResolvedValue({ ...structuredClone(SAMPLE_RECORD), steps: [] });
    const agent = makeAgent({ currentThreadId: 'thread-1' }, mockHistory);
    const result = await saveWorkflowTool.handler({ name: 'Test' }, agent);
    expect(result).toContain('No actionable steps');
    // No partial state written.
    expect(mockHistory.insertProcess).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Source A — retryable-error path (Haiku extraction failure)
// =====================================================================

describe('save_workflow — retryable extraction failure', () => {
  let mockHistory: ReturnType<typeof makeMockRunHistory>;

  beforeEach(() => {
    _resetPipelineStore();
    mockHistory = makeMockRunHistory();
    captureProcessMock.mockReset();
  });

  it('surfaces a clear retryable error and writes no partial state', async () => {
    captureProcessMock.mockRejectedValue(new Error('network timeout'));
    const agent = makeAgent({ currentThreadId: 'thread-1' }, mockHistory);
    const result = await saveWorkflowTool.handler({ name: 'Flaky Workflow' }, agent);

    // Error message names the failure and tells the agent it can retry.
    expect(result).toMatch(/extraction failed/i);
    expect(result).toMatch(/network timeout/);
    expect(result).toMatch(/retry/i);

    // Atomicity: no ProcessRecord, no PlannedPipeline written.
    expect(mockHistory.insertProcess).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Source B — promote an existing plan_task workflow (workflow_id given)
// =====================================================================

describe('save_workflow — workflow_id source', () => {
  let mockHistory: ReturnType<typeof makeMockRunHistory>;

  function makePlan(overrides: Partial<PlannedPipeline> = {}): PlannedPipeline {
    return {
      id: 'plan-789',
      name: 'Ad Report Plan',
      goal: 'Generate the monthly ad report',
      steps: [
        { id: 'step-0', task: 'Fetch ad data' },
        { id: 'step-1', task: 'Write report', input_from: ['step-0'] },
      ],
      reasoning: 'planned',
      estimatedCost: 0.01,
      createdAt: '2026-03-21T12:00:00.000Z',
      executed: true,
      executionMode: 'orchestrated',
      template: false,
      mode: 'autonomous',
      ...overrides,
    };
  }

  beforeEach(() => {
    _resetPipelineStore();
    mockHistory = makeMockRunHistory();
    captureProcessMock.mockReset();
  });

  it('promotes a non-template plan into a reusable workflow copy', async () => {
    storePipeline('plan-789', makePlan());
    const agent = makeAgent({}, mockHistory);
    const result = await saveWorkflowTool.handler(
      { name: 'Saved Ad Report', description: 'Reusable monthly report', workflow_id: 'plan-789' },
      agent,
    );

    const parsed = JSON.parse(result) as { workflow_id: string; source: string; steps: number };
    expect(parsed.source).toBe('workflow_id');
    expect(parsed.steps).toBe(2);
    // A new id — the original plan is untouched.
    expect(parsed.workflow_id).not.toBe('plan-789');

    const reusable = getPipeline(parsed.workflow_id);
    expect(reusable).toBeDefined();
    expect(reusable!.template).toBe(true);
    expect(reusable!.name).toBe('Saved Ad Report');
    expect(reusable!.goal).toBe('Reusable monthly report');
    expect(reusable!.executed).toBe(false);

    // The original plan stays a non-template, unchanged.
    expect(getPipeline('plan-789')!.template).toBe(false);

    // The session-capture path is never touched for this source.
    expect(captureProcessMock).not.toHaveBeenCalled();
    expect(mockHistory.insertProcess).not.toHaveBeenCalled();
    // The reusable copy is persisted to pipeline_runs (not just the volatile
    // in-memory store) so the Saved Workflows library finds it.
    expect(mockHistory.insertPlannedPipeline).toHaveBeenCalledTimes(1);
  });

  // Regression (2026-05-22): save_workflow only did the in-memory storePipeline
  // and never insertPlannedPipeline, so the Saved Workflows library — which
  // queries pipeline_runs via getPlannedPipelines — was always empty. This
  // test exercises the real persistence end-to-end against the library query.
  it('persists the saved workflow so getPlannedPipelines (the library) finds it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-save-wf-'));
    const history = new RunHistory(join(dir, 'h.db'));
    // S3f: workflow/trigger defs live in engine.db — wire it so the persistence works.
    const engine = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engine);
    try {
      storePipeline('plan-src', makePlan({ id: 'plan-src', template: false }));
      const agent = makeAgent({}, history);
      const result = await saveWorkflowTool.handler(
        { name: 'Saved WF', description: 'reusable', workflow_id: 'plan-src' },
        agent,
      );
      const parsed = JSON.parse(result) as { workflow_id: string };
      const rows = history.getPlannedPipelines(50);
      const saved = rows.find((r) => r.id === parsed.workflow_id);
      expect(saved).toBeDefined();
      expect(saved!.manifest_name).toBe('Saved WF');
      // The library filters on manifest_json.template === true.
      expect((JSON.parse(saved!.manifest_json) as { template: boolean }).template).toBe(true);
    } finally {
      try { engine.close(); } catch { /* already closed */ }
      history.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent for an already-reusable workflow', async () => {
    storePipeline('tmpl-1', makePlan({ id: 'tmpl-1', template: true }));
    const agent = makeAgent({}, mockHistory);
    const result = await saveWorkflowTool.handler(
      { name: 'Already Saved', workflow_id: 'tmpl-1' },
      agent,
    );

    const parsed = JSON.parse(result) as { workflow_id: string; already_reusable: boolean };
    expect(parsed.already_reusable).toBe(true);
    expect(parsed.workflow_id).toBe('tmpl-1');
  });

  it('errors for an unknown workflow_id', async () => {
    const agent = makeAgent({}, mockHistory);
    const result = await saveWorkflowTool.handler(
      { name: 'X', workflow_id: 'does-not-exist' },
      agent,
    );
    expect(result).toContain('not found');
  });
});

// =====================================================================
// Session-call forwarding
// =====================================================================
//
// The redaction sub-task (PRD §6.2 — value-pattern + high-entropy scanning,
// redact-then-truncate) lives in `process-capture.ts` and is covered against
// the real, unmocked sanitizer in `process-capture.test.ts`. Here we only
// assert that `save_workflow` forwards the session tool-calls verbatim into
// `captureProcess`, which is the layer that performs the redaction.

describe('save_workflow — session-call forwarding', () => {
  it('forwards the raw session tool-calls to captureProcess for redaction', async () => {
    _resetPipelineStore();
    captureProcessMock.mockReset();
    captureProcessMock.mockResolvedValue(structuredClone(SAMPLE_RECORD));
    const mockHistory = makeMockRunHistory();
    const agent = makeAgent({ currentThreadId: 'thread-1' }, mockHistory);
    await saveWorkflowTool.handler({ name: 'X' }, agent);
    expect(captureProcessMock).toHaveBeenCalledWith(
      'run-abc',
      'X',
      SESSION_TOOL_CALLS,
      expect.anything(),
    );
  });
});

describe('processToSteps (deterministic-replay carry-through)', () => {
  function makeRecord(over: Partial<ProcessRecord> = {}): ProcessRecord {
    return {
      id: 'rec-1',
      name: 'Monthly Report',
      description: 'A monthly client report',
      sourceRunId: 'run-1',
      steps: [],
      parameters: [],
      createdAt: '2026-06-22T00:00:00.000Z',
      ...over,
    };
  }

  it('carries the literal tool + input_template onto each runnable step', () => {
    const steps = processToSteps(makeRecord({
      steps: [
        { order: 0, tool: 'data_store_query', description: 'Pull revenue', inputTemplate: { table: 'revenue', client: '{{client}}' }, dependsOn: [] },
      ],
      parameters: [{ name: 'client', description: 'client', type: 'string', source: 'user_input' }],
    }));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.id).toBe('step-0');
    expect(steps[0]!.tool).toBe('data_store_query');
    // The captured bare {{client}} placeholder is re-homed into the params namespace.
    expect(steps[0]!.input_template).toEqual({ table: 'revenue', client: '{{params.client}}' });
  });

  it('re-homes bare {{param}} placeholders into the {{params.*}} namespace (deep)', () => {
    const steps = processToSteps(makeRecord({
      steps: [
        { order: 0, tool: 'http', description: 'Fetch', inputTemplate: { url: 'https://api/{{client}}/m/{{month}}', tags: ['{{client}}', 'fixed'] }, dependsOn: [] },
      ],
      parameters: [
        { name: 'client', description: 'c', type: 'string', source: 'user_input' },
        { name: 'month', description: 'm', type: 'date', source: 'relative_date' },
      ],
    }));
    expect(steps[0]!.input_template).toEqual({
      url: 'https://api/{{params.client}}/m/{{params.month}}',
      tags: ['{{params.client}}', 'fixed'],
    });
  });

  it('does not match a param name inside a longer placeholder ({{report_month}} vs month)', () => {
    const steps = processToSteps(makeRecord({
      steps: [{ order: 0, tool: 'http', description: 'X', inputTemplate: { u: '{{report_month}}' }, dependsOn: [] }],
      parameters: [
        { name: 'month', description: 'm', type: 'string', source: 'user_input' },
        { name: 'report_month', description: 'rm', type: 'string', source: 'user_input' },
      ],
    }));
    // `month` must NOT rewrite the inner of `{{report_month}}`; only the exact
    // `{{report_month}}` token is namespaced.
    expect(steps[0]!.input_template).toEqual({ u: '{{params.report_month}}' });
  });

  it('surfaces referenced params as {{params.<name>}} hints in the prose task', () => {
    const steps = processToSteps(makeRecord({
      steps: [
        { order: 0, tool: 'http', description: 'Fetch client data', inputTemplate: { url: 'https://api/{{client}}' }, dependsOn: [] },
      ],
      parameters: [
        { name: 'client', description: 'client', type: 'string', source: 'user_input' },
        { name: 'unused', description: 'not referenced', type: 'string', source: 'user_input' },
      ],
    }));
    // Only the param actually referenced by the template is hinted, in the
    // {{params.*}} namespace (so prose + input_template resolve the same way).
    expect(steps[0]!.task).toContain('{{params.client}}');
    expect(steps[0]!.task).not.toContain('{{params.unused}}');
  });

  it('emits no parameter hint when the step references none', () => {
    const steps = processToSteps(makeRecord({
      steps: [{ order: 0, tool: 'bash', description: 'List files', inputTemplate: { cmd: 'ls' }, dependsOn: [] }],
      parameters: [{ name: 'client', description: 'client', type: 'string', source: 'user_input' }],
    }));
    expect(steps[0]!.task).toBe('List files');
  });

  it('maps dependsOn order values to step-<order> input_from, dropping stale ones', () => {
    const steps = processToSteps(makeRecord({
      steps: [
        { order: 0, tool: 'http', description: 'A', inputTemplate: {}, dependsOn: [] },
        { order: 1, tool: 'bash', description: 'B', inputTemplate: {}, dependsOn: [0, 99] },
      ],
    }));
    expect(steps[1]!.input_from).toEqual(['step-0']); // 99 has no step → dropped
    expect(steps[0]!.input_from).toBeUndefined();
  });
});
