import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureProcess } from './process-capture.js';
import type { ToolCallRecord } from './run-history.js';

// Mock Anthropic SDK (class pattern — see dag-planner.test.ts)
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    beta = {
      messages: {
        create: (...args: unknown[]) => mockCreate(...args),
      },
    };
    constructor(..._args: unknown[]) { /* accept any args */ }
  },
}));

function makeMockResponse() {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'extract_process',
        input: {
          steps: [
            { order: 0, tool: 'http_request', description: 'Fetch ad data from Google Ads API', inputTemplate: { url: 'https://ads.google.com/api', method: 'GET' }, dependsOn: [] },
            { order: 1, tool: 'bash', description: 'Parse and clean CSV data', inputTemplate: { command: 'node parse.js' }, dependsOn: [0] },
            { order: 2, tool: 'write_file', description: 'Generate monthly report', inputTemplate: { path: 'report.pdf' }, dependsOn: [1] },
          ],
          parameters: [
            { name: 'time_range', description: 'Reporting period', type: 'date', defaultValue: 'last month', source: 'relative_date' },
            { name: 'account_id', description: 'Google Ads account', type: 'string', defaultValue: '123-456', source: 'user_input' },
          ],
        },
      },
    ],
  };
}

function makeToolCalls(): ToolCallRecord[] {
  return [
    { id: 'tc1', run_id: 'run1', tool_name: 'memory_recall', input_json: '{"query":"ads"}', output_json: '', duration_ms: 100, sequence_order: 0 },
    { id: 'tc2', run_id: 'run1', tool_name: 'http_request', input_json: '{"url":"https://ads.google.com/api","method":"GET"}', output_json: '{"data":[]}', duration_ms: 500, sequence_order: 1 },
    { id: 'tc3', run_id: 'run1', tool_name: 'bash', input_json: '{"command":"node parse.js"}', output_json: 'parsed 100 rows', duration_ms: 200, sequence_order: 2 },
    { id: 'tc4', run_id: 'run1', tool_name: 'write_file', input_json: '{"path":"report.pdf","content":"..."}', output_json: '', duration_ms: 50, sequence_order: 3 },
    { id: 'tc5', run_id: 'run1', tool_name: 'memory_store', input_json: '{"namespace":"knowledge","content":"report done"}', output_json: '', duration_ms: 30, sequence_order: 4 },
  ];
}

describe('captureProcess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue(makeMockResponse());
  });

  it('should filter out internal tools', async () => {
    const record = await captureProcess('run1', 'Ad Report', makeToolCalls(), {
      apiKey: 'test-key',
    });

    // memory_recall and memory_store should be filtered out
    // Haiku returns 3 steps (from the 3 action tools: http, bash, write_file)
    expect(record.steps).toHaveLength(3);
    expect(record.steps[0]!.tool).toBe('http_request');
  });

  it('should return structured ProcessRecord', async () => {
    const record = await captureProcess('run1', 'Monthly Report', makeToolCalls(), {
      apiKey: 'test-key',
      description: 'Generates monthly ad performance report',
    });

    expect(record.id).toBeDefined();
    expect(record.name).toBe('Monthly Report');
    expect(record.description).toBe('Generates monthly ad performance report');
    expect(record.sourceRunId).toBe('run1');
    expect(record.createdAt).toBeDefined();
  });

  it('should identify parameters', async () => {
    const record = await captureProcess('run1', 'Report', makeToolCalls(), {
      apiKey: 'test-key',
    });

    expect(record.parameters).toHaveLength(2);
    expect(record.parameters[0]!.name).toBe('time_range');
    expect(record.parameters[0]!.source).toBe('relative_date');
    expect(record.parameters[1]!.name).toBe('account_id');
    expect(record.parameters[1]!.source).toBe('user_input');
  });

  it('should detect step dependencies', async () => {
    const record = await captureProcess('run1', 'Report', makeToolCalls(), {
      apiKey: 'test-key',
    });

    expect(record.steps[0]!.dependsOn).toEqual([]);
    expect(record.steps[1]!.dependsOn).toEqual([0]);
    expect(record.steps[2]!.dependsOn).toEqual([1]);
  });

  it('should return empty steps for no action tool calls', async () => {
    const internalOnly: ToolCallRecord[] = [
      { id: 'tc1', run_id: 'run1', tool_name: 'memory_recall', input_json: '{}', output_json: '', duration_ms: 50, sequence_order: 0 },
      { id: 'tc2', run_id: 'run1', tool_name: 'ask_user', input_json: '{}', output_json: '', duration_ms: 100, sequence_order: 1 },
    ];

    const record = await captureProcess('run1', 'Empty', internalOnly, {
      apiKey: 'test-key',
    });

    expect(record.steps).toHaveLength(0);
    expect(record.parameters).toHaveLength(0);
  });
});
