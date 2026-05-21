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

  it('filters save_workflow as an internal tool', async () => {
    const withSelf: ToolCallRecord[] = [
      { id: 'tc1', run_id: 'run1', tool_name: 'http_request', input_json: '{"url":"x"}', output_json: 'ok', duration_ms: 10, sequence_order: 0 },
      { id: 'tc2', run_id: 'run1', tool_name: 'save_workflow', input_json: '{}', output_json: '', duration_ms: 5, sequence_order: 1 },
    ];
    await captureProcess('run1', 'X', withSelf, { apiKey: 'test-key' });

    // save_workflow itself must not appear in the payload sent to Haiku.
    const payload = JSON.stringify(mockCreate.mock.calls[0]![0]);
    expect(payload).not.toContain('save_workflow');
    expect(payload).toContain('http_request');
  });
});

/**
 * Redaction hardening (PRD §6.2) — value-pattern + high-entropy scanning,
 * redact-then-truncate ordering. These assert against the exact JSON payload
 * the (mocked) Haiku call receives, so a leaked secret would be visible.
 */
describe('captureProcess — secret redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue(makeMockResponse());
  });

  /** The user-message string that captureProcess sends to Haiku. */
  function sentPayload(): string {
    const body = mockCreate.mock.calls[0]![0] as { messages: { content: string }[] };
    return body.messages[0]!.content;
  }

  it('redacts key-name JSON pairs in tool inputs', async () => {
    const calls: ToolCallRecord[] = [
      { id: 'a', run_id: 'r', tool_name: 'http_request', input_json: '{"url":"x","api_key":"super-secret-value-12345"}', output_json: 'ok', duration_ms: 1, sequence_order: 0 },
    ];
    await captureProcess('r', 'X', calls, { apiKey: 'k' });
    const payload = sentPayload();
    expect(payload).not.toContain('super-secret-value-12345');
    expect(payload).toContain('[REDACTED]');
  });

  it('redacts a bearer token value in step output', async () => {
    const calls: ToolCallRecord[] = [
      { id: 'a', run_id: 'r', tool_name: 'http_request', input_json: '{"url":"x"}', output_json: 'Authorization: Bearer abcDEF123ghiJKL456mnoPQR', duration_ms: 1, sequence_order: 0 },
    ];
    await captureProcess('r', 'X', calls, { apiKey: 'k' });
    const payload = sentPayload();
    expect(payload).not.toContain('abcDEF123ghiJKL456mnoPQR');
  });

  it('redacts a Slack-style xox token', async () => {
    const calls: ToolCallRecord[] = [
      { id: 'a', run_id: 'r', tool_name: 'http_request', input_json: '{"token":"plain"}', output_json: 'xoxb-1234567890-ABCDEFGHIJ', duration_ms: 1, sequence_order: 0 },
    ];
    await captureProcess('r', 'X', calls, { apiKey: 'k' });
    expect(sentPayload()).not.toContain('xoxb-1234567890-ABCDEFGHIJ');
  });

  it('redacts a JWT-shaped value', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_signature';
    const calls: ToolCallRecord[] = [
      { id: 'a', run_id: 'r', tool_name: 'http_request', input_json: `{"jwt":"${jwt}"}`, output_json: 'ok', duration_ms: 1, sequence_order: 0 },
    ];
    await captureProcess('r', 'X', calls, { apiKey: 'k' });
    expect(sentPayload()).not.toContain(jwt);
  });

  it('redacts a provider-prefixed API key in output', async () => {
    const calls: ToolCallRecord[] = [
      { id: 'a', run_id: 'r', tool_name: 'http_request', input_json: '{"url":"x"}', output_json: 'key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', duration_ms: 1, sequence_order: 0 },
    ];
    await captureProcess('r', 'X', calls, { apiKey: 'k' });
    expect(sentPayload()).not.toContain('sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv');
  });

  it('redacts a high-entropy bare token without a known prefix', async () => {
    const secret = 'aZ9kQ2mW8xL4pR7tV3nY6cH1bG5dF0sJ';
    const calls: ToolCallRecord[] = [
      { id: 'a', run_id: 'r', tool_name: 'http_request', input_json: `{"session":"${secret}"}`, output_json: 'ok', duration_ms: 1, sequence_order: 0 },
    ];
    await captureProcess('r', 'X', calls, { apiKey: 'k' });
    expect(sentPayload()).not.toContain(secret);
  });

  it('does not mangle ordinary prose / URLs', async () => {
    const calls: ToolCallRecord[] = [
      { id: 'a', run_id: 'r', tool_name: 'http_request', input_json: '{"url":"https://example.com/reports/monthly"}', output_json: 'The monthly report was generated successfully today', duration_ms: 1, sequence_order: 0 },
    ];
    await captureProcess('r', 'X', calls, { apiKey: 'k' });
    const payload = sentPayload();
    expect(payload).toContain('https://example.com/reports/monthly');
    expect(payload).toContain('The monthly report was generated successfully today');
  });

  it('redact-then-truncate: a secret straddling the 200-char output cap is still redacted', async () => {
    // Pad with 190 chars of prose, then place a provider key so it spans the
    // 200-char truncation boundary. Redaction must run on the full string
    // first, so the key never survives to be truncated mid-token.
    const padding = 'x'.repeat(190);
    const secret = 'sk-live_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const calls: ToolCallRecord[] = [
      { id: 'a', run_id: 'r', tool_name: 'http_request', input_json: '{"url":"x"}', output_json: `${padding} ${secret}`, duration_ms: 1, sequence_order: 0 },
    ];
    await captureProcess('r', 'X', calls, { apiKey: 'k' });
    const payload = sentPayload();
    // Neither the whole key nor a recognisable prefix fragment survives.
    expect(payload).not.toContain('sk-live_AbCdEfGhIjKlMnOpQrStUvWxYz');
  });

  it('redacts namespaced secret keys whose name ends in a keyword', async () => {
    const calls: ToolCallRecord[] = [
      { id: 'a', run_id: 'r', tool_name: 'http_request', input_json: '{"db-password":"Hunter2-prod-XYZ","x_api_key":"keykeykey-7777"}', output_json: 'ok', duration_ms: 1, sequence_order: 0 },
    ];
    await captureProcess('r', 'X', calls, { apiKey: 'k' });
    const payload = sentPayload();
    expect(payload).not.toContain('Hunter2-prod-XYZ');
    expect(payload).not.toContain('keykeykey-7777');
  });

  it('redacts URL-embedded credentials (user:pass@host)', async () => {
    const calls: ToolCallRecord[] = [
      { id: 'a', run_id: 'r', tool_name: 'http_request', input_json: '{"dsn":"postgres://admin:s3cretPwd9@db.internal:5432/app"}', output_json: 'ok', duration_ms: 1, sequence_order: 0 },
    ];
    await captureProcess('r', 'X', calls, { apiKey: 'k' });
    expect(sentPayload()).not.toContain('s3cretPwd9');
  });
});
