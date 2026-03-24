import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureProcessTool, promoteProcessTool } from './process.js';
import { _resetPipelineStore, getPipeline } from './pipeline.js';
import { createToolContext } from '../../core/tool-context.js';
import type { IAgent, ProcessRecord, NodynUserConfig } from '../../types/index.js';

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

// Mock RunHistory
function makeMockRunHistory() {
  const processes = new Map<string, ProcessRecord>();
  return {
    getRunToolCalls: vi.fn().mockReturnValue([
      { id: 'tc1', run_id: 'run-abc', tool_name: 'http_request', input_json: '{}', output_json: '', duration_ms: 100, sequence_order: 0 },
    ]),
    insertProcess: vi.fn().mockImplementation((record: ProcessRecord) => {
      processes.set(record.id, record);
    }),
    getProcess: vi.fn().mockImplementation((id: string) => processes.get(id)),
    updateProcessPromotion: vi.fn(),
    listProcesses: vi.fn().mockReturnValue([]),
    deleteProcess: vi.fn().mockReturnValue(true),
    _store: processes,
  };
}

const mockConfig = { api_key: 'test-key' } as NodynUserConfig;

function makeAgent(overrides: Partial<IAgent> = {}, runHistory: unknown = null, userConfig: NodynUserConfig = mockConfig): IAgent {
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
    const agent = makeAgent({}, mockHistory);
    const result = await captureProcessTool.handler(
      { name: 'Test' },
      agent,
    );

    expect(result).toContain('No tool calls');
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
