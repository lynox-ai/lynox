import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveWorkflowTool } from './process.js';
import { _resetPipelineStore, getPipeline } from './pipeline.js';
import { createToolContext } from '../../core/tool-context.js';
import { scoreCapture, type CaptureExpectation } from '../../core/capture-rubric.js';
import type { IAgent, ProcessRecord, LynoxUserConfig } from '../../types/index.js';

// Mock the Haiku extraction (process-capture) so the eval is DETERMINISTIC: it
// feeds a golden ProcessRecord (the model's output for a known trace) and grades
// what the `processToSteps` glue produces. This regression-proofs the glue (param
// namespacing, dep wiring, step ids); the LIVE extraction quality is graded by
// the online smoke (tests/online/process-capture.test.ts) with the SAME rubric.
const captureProcessMock = vi.fn();
vi.mock('../../core/process-capture.js', () => ({
  captureProcess: (...args: unknown[]) => captureProcessMock(...args),
}));

const mockConfig = { api_key: 'k' } as LynoxUserConfig;

function makeAgent(runHistory: unknown): IAgent {
  const toolContext = createToolContext(mockConfig);
  toolContext.runHistory = runHistory as never;
  return { name: 't', model: 'm', memory: null, tools: [], onStream: null, currentRunId: 'run-abc', currentThreadId: 'thread-1', toolContext } as unknown as IAgent;
}

function mockHistory() {
  return {
    getSessionToolCalls: vi.fn().mockReturnValue([{ id: 'tc', run_id: 'run-abc', tool_name: 'http_request', input_json: '{}', output_json: '', duration_ms: 1, sequence_order: 0 }]),
    getRun: vi.fn().mockReturnValue({ id: 'run-abc', session_id: 'thread-1' }),
    insertProcess: vi.fn(),
    insertPlannedPipeline: vi.fn(),
    getPlannedPipeline: vi.fn().mockReturnValue(undefined),
    getAvgStepCostByModelTier: vi.fn().mockReturnValue({}),
  };
}

// === Golden fixtures: (a model annotation, the expectation we grade against) ===
// The annotation uses BARE `{{x}}` placeholders exactly as the Haiku extractor
// emits them — the glue's job is to namespace them to `{{params.x}}`.
interface Fixture { name: string; record: ProcessRecord; expected: CaptureExpectation }

const FIXTURES: Fixture[] = [
  {
    name: 'http → write report (2 steps, 2 params, one dependency)',
    record: {
      id: 'p1', name: 'Monthly Report', description: 'fetch + write', sourceRunId: 'run-abc',
      steps: [
        { order: 0, tool: 'http_request', description: 'Fetch the metrics', inputTemplate: { url: '{{api_url}}', range: '{{time_range}}' }, dependsOn: [] },
        { order: 1, tool: 'write_file', description: 'Write the report', inputTemplate: { path: 'report.md' }, dependsOn: [0] },
      ],
      parameters: [
        { name: 'api_url', description: 'endpoint', type: 'string', source: 'user_input' },
        { name: 'time_range', description: 'period', type: 'date', source: 'relative_date' },
      ],
      createdAt: '2026-06-24T00:00:00.000Z',
    },
    expected: {
      params: [
        { name: 'api_url', type: 'string', source: 'user_input' },
        { name: 'time_range', type: 'date', source: 'relative_date' },
      ],
      stepCount: 2,
      deps: { 'step-1': ['step-0'] },
    },
  },
  {
    name: 'fetch → transform → post (3 steps, chained deps, a numeric param)',
    record: {
      id: 'p2', name: 'Sync Pipeline', description: 'fetch transform post', sourceRunId: 'run-abc',
      steps: [
        { order: 0, tool: 'http_request', description: 'Fetch rows', inputTemplate: { url: '{{source_url}}', limit: '{{max_rows}}' }, dependsOn: [] },
        { order: 1, tool: 'bash', description: 'Transform', inputTemplate: { cmd: 'process' }, dependsOn: [0] },
        { order: 2, tool: 'http_request', description: 'Post result', inputTemplate: { url: '{{sink_url}}' }, dependsOn: [1] },
      ],
      parameters: [
        { name: 'source_url', description: 'in', type: 'string', source: 'user_input' },
        { name: 'max_rows', description: 'cap', type: 'number', source: 'user_input' },
        { name: 'sink_url', description: 'out', type: 'string', source: 'user_input' },
      ],
      createdAt: '2026-06-24T00:00:00.000Z',
    },
    expected: {
      params: [
        { name: 'source_url', type: 'string', source: 'user_input' },
        { name: 'max_rows', type: 'number', source: 'user_input' },
        { name: 'sink_url', type: 'string', source: 'user_input' },
      ],
      stepCount: 3,
      deps: { 'step-1': ['step-0'], 'step-2': ['step-1'] },
    },
  },
];

const QUALITY_GATE = 0.95;

describe('exploratory-capture eval (offline golden rubric, Slice C3)', () => {
  beforeEach(() => {
    _resetPipelineStore();
    captureProcessMock.mockReset();
  });

  for (const fx of FIXTURES) {
    it(`captures "${fx.name}" at quality ≥ ${QUALITY_GATE}`, async () => {
      captureProcessMock.mockResolvedValue(structuredClone(fx.record));
      const res = await saveWorkflowTool.handler({ name: fx.record.name }, makeAgent(mockHistory()));
      const parsed = JSON.parse(res) as { workflow_id: string };
      const captured = getPipeline(parsed.workflow_id)!;
      expect(captured).toBeDefined();

      const score = scoreCapture(captured, fx.expected);
      // The bare `{{api_url}}` etc. in the annotation MUST have been namespaced to
      // `{{params.api_url}}` by the glue — a regression there trips reExecutable.
      expect(score.reExecutable, score.notes.join(' | ')).toBe(true);
      expect(score.overall, score.notes.join(' | ')).toBeGreaterThanOrEqual(QUALITY_GATE);
    });
  }
});
