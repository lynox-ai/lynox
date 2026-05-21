import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureProcessTool, promoteProcessTool } from './process.js';
import { _resetPipelineStore, getPipeline } from './pipeline.js';
import { createToolContext } from '../../core/tool-context.js';
import type { IAgent, ProcessRecord, LynoxUserConfig } from '../../types/index.js';

// Mock process-capture module
vi.mock('../../core/process-capture.js', () => ({
  captureProcess: vi.fn().mockResolvedValue({
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
  } satisfies ProcessRecord),
}));

const RUN_TOOL_CALL = { id: 'tc1', run_id: 'run-abc', tool_name: 'http_request', input_json: '{}', output_json: '', duration_ms: 100, sequence_order: 0 };
const SESSION_TOOL_CALLS = [
  { id: 'tc0', run_id: 'run-earlier', tool_name: 'http_request', input_json: '{}', output_json: '', duration_ms: 100, sequence_order: 0 },
  { id: 'tc1', run_id: 'run-earlier', tool_name: 'write_file', input_json: '{}', output_json: '', duration_ms: 80, sequence_order: 1 },
  { id: 'tc2', run_id: 'run-abc', tool_name: 'capture_process', input_json: '{}', output_json: '', duration_ms: 5, sequence_order: 0 },
];

// Mock RunHistory
function makeMockRunHistory() {
  const processes = new Map<string, ProcessRecord>();
  return {
    // Current-run scope: holds only this turn's calls (the capture_process call).
    getRunToolCalls: vi.fn().mockReturnValue([RUN_TOOL_CALL]),
    // Session scope: holds the workflow tool calls from earlier turns.
    getSessionToolCalls: vi.fn().mockReturnValue(SESSION_TOOL_CALLS),
    getRun: vi.fn().mockReturnValue({ id: 'run-abc', session_id: 'thread-1' }),
    insertProcess: vi.fn().mockImplementation((record: ProcessRecord) => {
      processes.set(record.id, record);
    }),
    getProcess: vi.fn().mockImplementation((id: string) => processes.get(id)),
    updateProcessPromotion: vi.fn(),
    listProcesses: vi.fn().mockReturnValue([]),
    deleteProcess: vi.fn().mockReturnValue(true),
    getAvgStepCostByModelTier: vi.fn().mockReturnValue({}),
    _store: processes,
  };
}

const mockConfig = { api_key: 'test-key' } as LynoxUserConfig;

function makeAgent(overrides: Partial<IAgent> = {}, runHistory: unknown = null, userConfig: LynoxUserConfig = mockConfig): IAgent {
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

describe('capture_process tool', () => {
  let mockHistory: ReturnType<typeof makeMockRunHistory>;

  beforeEach(() => {
    _resetPipelineStore();
    mockHistory = makeMockRunHistory();
  });

  it('should capture process from current run', async () => {
    const agent = makeAgent({}, mockHistory);
    const result = await captureProcessTool.handler(
      { name: 'Monthly Report' },
      agent,
    );

    const parsed = JSON.parse(result) as { process_id: string; step_count: number; parameter_count: number };
    expect(parsed.process_id).toBe('proc-123');
    expect(parsed.step_count).toBe(2);
    expect(parsed.parameter_count).toBe(2);
    expect(mockHistory.insertProcess).toHaveBeenCalledOnce();
  });

  it('should error without currentRunId', async () => {
    const agent = makeAgent({ currentRunId: undefined }, mockHistory);
    const result = await captureProcessTool.handler(
      { name: 'Test' },
      agent,
    );

    expect(result).toContain('No active run');
  });

  it('should error without run history', async () => {
    const agent = makeAgent({}, null);
    const result = await captureProcessTool.handler(
      { name: 'Test' },
      agent,
    );

    expect(result).toContain('not available');
  });

  it('should error when no tool calls found', async () => {
    mockHistory.getRunToolCalls.mockReturnValue([]);
    mockHistory.getSessionToolCalls.mockReturnValue([]);
    const agent = makeAgent({}, mockHistory);
    const result = await captureProcessTool.handler(
      { name: 'Test' },
      agent,
    );

    expect(result).toContain('No tool calls');
  });

  it('gathers session-wide tool calls, not just the current run', async () => {
    // currentThreadId resolves the session; capture must read across turns.
    const agent = makeAgent({ currentThreadId: 'thread-1' }, mockHistory);
    const result = await captureProcessTool.handler(
      { name: 'Monthly Report' },
      agent,
    );

    // The session-scoped query is used, the single-run query is not.
    expect(mockHistory.getSessionToolCalls).toHaveBeenCalledWith('thread-1');
    expect(mockHistory.getRunToolCalls).not.toHaveBeenCalled();

    // captureProcess receives the session-wide calls + keeps currentRunId as source.
    const { captureProcess } = await import('../../core/process-capture.js');
    expect(captureProcess).toHaveBeenCalledWith(
      'run-abc',
      'Monthly Report',
      SESSION_TOOL_CALLS,
      expect.objectContaining({ apiKey: 'test-key' }),
    );

    const parsed = JSON.parse(result) as { process_id: string };
    expect(parsed.process_id).toBe('proc-123');
  });

  it('falls back to run.session_id when currentThreadId is absent', async () => {
    // No currentThreadId -> resolve via getRun(currentRunId).session_id.
    const agent = makeAgent({ currentThreadId: undefined }, mockHistory);
    await captureProcessTool.handler({ name: 'Test' }, agent);

    expect(mockHistory.getRun).toHaveBeenCalledWith('run-abc');
    expect(mockHistory.getSessionToolCalls).toHaveBeenCalledWith('thread-1');
    expect(mockHistory.getRunToolCalls).not.toHaveBeenCalled();
  });

  it('falls back to single-run scope when no session can be resolved', async () => {
    // Neither a thread id nor a run.session_id -> legacy current-run behaviour.
    mockHistory.getRun.mockReturnValue({ id: 'run-abc', session_id: '' });
    const agent = makeAgent({ currentThreadId: undefined }, mockHistory);
    await captureProcessTool.handler({ name: 'Test' }, agent);

    expect(mockHistory.getRunToolCalls).toHaveBeenCalledWith('run-abc');
    expect(mockHistory.getSessionToolCalls).not.toHaveBeenCalled();
  });
});

describe('promote_process tool', () => {
  let mockHistory: ReturnType<typeof makeMockRunHistory>;

  beforeEach(() => {
    _resetPipelineStore();
    mockHistory = makeMockRunHistory();

    // Pre-populate a process
    const process: ProcessRecord = {
      id: 'proc-456',
      name: 'Ad Report',
      description: 'Monthly ad performance report',
      sourceRunId: 'run-xyz',
      steps: [
        { order: 0, tool: 'http_request', description: 'Fetch ad data', inputTemplate: { url: '{{api_url}}' } },
        { order: 1, tool: 'write_file', description: 'Generate report', inputTemplate: { path: 'report.pdf' }, dependsOn: [0] },
      ],
      parameters: [
        { name: 'api_url', description: 'API endpoint', type: 'string', defaultValue: 'https://ads.api.com', source: 'user_input' },
      ],
      createdAt: '2026-03-21T12:00:00.000Z',
    };
    mockHistory._store.set('proc-456', process);
    mockHistory.getProcess.mockImplementation((id: string) => mockHistory._store.get(id));
  });

  it('should promote process to pipeline', async () => {
    const result = await promoteProcessTool.handler(
      { process_id: 'proc-456' },
      makeAgent({}, mockHistory),
    );

    const parsed = JSON.parse(result) as { pipeline_id: string; steps: number; parameters: string[] };
    expect(parsed.pipeline_id).toBeDefined();
    expect(parsed.steps).toBe(2);
    expect(parsed.parameters).toEqual(['api_url']);

    // Verify pipeline was stored
    const pipeline = getPipeline(parsed.pipeline_id);
    expect(pipeline).toBeDefined();
    expect(pipeline!.name).toBe('Ad Report');
    expect(pipeline!.steps).toHaveLength(2);
    expect(pipeline!.steps[1]!.input_from).toEqual(['step-0']);

    // Verify process was marked as promoted
    expect(mockHistory.updateProcessPromotion).toHaveBeenCalledWith('proc-456', parsed.pipeline_id);
  });

  it('should error for unknown process', async () => {
    const result = await promoteProcessTool.handler(
      { process_id: 'nonexistent' },
      makeAgent({}, mockHistory),
    );

    expect(result).toContain('not found');
  });

  it('should error for already promoted process', async () => {
    const process = mockHistory._store.get('proc-456')!;
    process.promotedToPipelineId = 'existing-pipeline';
    mockHistory._store.set('proc-456', process);

    const result = await promoteProcessTool.handler(
      { process_id: 'proc-456' },
      makeAgent({}, mockHistory),
    );

    expect(result).toContain('already promoted');
  });

  it('should error without run history', async () => {
    const result = await promoteProcessTool.handler(
      { process_id: 'proc-456' },
      makeAgent({}, null),
    );

    expect(result).toContain('not available');
  });
});
