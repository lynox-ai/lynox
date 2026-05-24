import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  captureProcess,
  collapseConsecutiveDuplicates,
  buildCanonicalSteps,
} from './process-capture.js';
import type { StepAnnotation } from './process-capture.js';
import type { ToolCallRecord } from './run-history.js';
import { MISTRAL_MODEL_MAP, setOpenAIModelResolver } from '../types/models.js';

// Mock Anthropic SDK (class pattern — see dag-planner.test.ts)
const mockCreate = vi.fn();
const anthropicCtorCalls: Array<Record<string, unknown>> = [];

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    beta = {
      messages: {
        create: (...args: unknown[]) => mockCreate(...args),
      },
    };
    constructor(opts: Record<string, unknown> = {}) {
      anthropicCtorCalls.push(opts);
    }
  },
}));

// Mock OpenAIAdapter so we can assert how captureProcess wires provider='openai'.
const mockOpenAICreate = vi.fn();
const openaiCtorCalls: Array<Record<string, unknown>> = [];

vi.mock('./openai-adapter.js', () => ({
  OpenAIAdapter: class MockOpenAIAdapter {
    baseURL: string;
    modelId: string;
    beta = {
      messages: {
        create: (...args: unknown[]) => mockOpenAICreate(...args),
      },
    };
    constructor(opts: { baseURL: string; apiKey: unknown; modelId: string }) {
      openaiCtorCalls.push(opts as unknown as Record<string, unknown>);
      this.baseURL = opts.baseURL;
      this.modelId = opts.modelId;
    }
  },
}));

/**
 * Mock Haiku response — the model now ANNOTATES a fixed numbered list, so it
 * returns `{ index, description, inputTemplate, dependsOn }` per call index.
 */
function makeMockResponse() {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'extract_process',
        input: {
          steps: [
            { index: 0, description: 'Fetch ad data from Google Ads API', inputTemplate: { url: 'https://ads.google.com/api', method: 'GET' }, dependsOn: [] },
            { index: 1, description: 'Parse and clean CSV data', inputTemplate: { command: 'node parse.js' }, dependsOn: [0] },
            { index: 2, description: 'Generate monthly report', inputTemplate: { path: 'report.pdf' }, dependsOn: [1] },
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

/** Build a ToolCallRecord with sane defaults for the deterministic tests. */
function call(tool_name: string, input_json: string, order: number): ToolCallRecord {
  return { id: `tc-${order}`, run_id: 'r', tool_name, input_json, output_json: 'ok', duration_ms: 1, sequence_order: order };
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

    // memory_recall and memory_store are filtered out → 3 action calls remain,
    // and the canonical spine is exactly 3 steps.
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

  it('drops malformed parameters from the Haiku response', async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'extract_process',
          input: {
            steps: [{ index: 0, description: 'step', inputTemplate: {}, dependsOn: [] }],
            parameters: [
              { name: 'good', description: 'ok', type: 'string', source: 'user_input' },
              { name: 'bad_type', description: 'x', type: 'frobnicate', source: 'user_input' }, // unknown type — dropped
              { description: 'no name', type: 'string', source: 'context' },                   // missing name — dropped
              { name: 'bad_source', description: 'x', type: 'string', source: 'telepathy' },    // unknown source — dropped
            ],
          },
        },
      ],
    });
    const record = await captureProcess('run1', 'Report', makeToolCalls(), { apiKey: 'k' });
    expect(record.parameters).toHaveLength(1);
    expect(record.parameters[0]!.name).toBe('good');
  });

  it('should detect step dependencies', async () => {
    const record = await captureProcess('run1', 'Report', makeToolCalls(), {
      apiKey: 'test-key',
    });

    expect(record.steps[0]!.dependsOn).toEqual([]);
    expect(record.steps[1]!.dependsOn).toEqual([0]);
    expect(record.steps[2]!.dependsOn).toEqual([1]);
  });

  it('orders steps deterministically by canonical call position', async () => {
    const record = await captureProcess('run1', 'Report', makeToolCalls(), {
      apiKey: 'test-key',
    });
    expect(record.steps.map(s => s.order)).toEqual([0, 1, 2]);
    expect(record.steps.map(s => s.tool)).toEqual(['http_request', 'bash', 'write_file']);
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

  it('step count equals the canonical call count regardless of Haiku output', async () => {
    // Haiku returns only ONE annotation for a 3-action-call session.
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'extract_process',
          input: {
            steps: [{ index: 0, description: 'only this one', inputTemplate: {}, dependsOn: [] }],
            parameters: [],
          },
        },
      ],
    });

    const record = await captureProcess('run1', 'Report', makeToolCalls(), { apiKey: 'k' });
    // Haiku cannot collapse the spine — 3 action calls → 3 steps.
    expect(record.steps).toHaveLength(3);
    expect(record.steps[0]!.description).toBe('only this one');
    // Missing annotations get a fallback description = tool name.
    expect(record.steps[1]!.description).toBe('bash');
    expect(record.steps[2]!.description).toBe('write_file');
  });

  it('collapses identical consecutive action calls before annotation', async () => {
    // Two literally-identical consecutive http_request calls — a retry.
    const retried: ToolCallRecord[] = [
      call('http_request', '{"url":"a"}', 0),
      call('http_request', '{"url":"a"}', 1),
      call('write_file', '{"path":"b"}', 2),
    ];
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'extract_process',
          input: { steps: [], parameters: [] },
        },
      ],
    });
    const record = await captureProcess('run1', 'Retry', retried, { apiKey: 'k' });
    // 3 raw calls → 2 canonical steps.
    expect(record.steps).toHaveLength(2);
    expect(record.steps.map(s => s.tool)).toEqual(['http_request', 'write_file']);
  });
});

describe('collapseConsecutiveDuplicates', () => {
  it('keeps two distinct action calls as two', () => {
    const result = collapseConsecutiveDuplicates([
      call('http_request', '{"url":"a"}', 0),
      call('write_file', '{"path":"b"}', 1),
    ]);
    expect(result).toHaveLength(2);
  });

  it('collapses identical consecutive calls into one', () => {
    const result = collapseConsecutiveDuplicates([
      call('http_request', '{"url":"a"}', 0),
      call('http_request', '{"url":"a"}', 1),
      call('http_request', '{"url":"a"}', 2),
      call('write_file', '{"path":"b"}', 3),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]!.tool_name).toBe('http_request');
    expect(result[1]!.tool_name).toBe('write_file');
  });

  it('does NOT collapse non-consecutive identical calls', () => {
    const result = collapseConsecutiveDuplicates([
      call('http_request', '{"url":"a"}', 0),
      call('write_file', '{"path":"b"}', 1),
      call('http_request', '{"url":"a"}', 2),
    ]);
    expect(result).toHaveLength(3);
  });

  it('does NOT collapse consecutive same-tool calls with different input', () => {
    const result = collapseConsecutiveDuplicates([
      call('http_request', '{"url":"a"}', 0),
      call('http_request', '{"url":"b"}', 1),
    ]);
    expect(result).toHaveLength(2);
  });

  it('returns an empty list for empty input', () => {
    expect(collapseConsecutiveDuplicates([])).toEqual([]);
  });
});

describe('buildCanonicalSteps', () => {
  const calls: ToolCallRecord[] = [
    call('http_request', '{"url":"a"}', 0),
    call('write_file', '{"path":"b"}', 1),
  ];

  it('builds exactly one step per canonical call, in order', () => {
    const annotations: StepAnnotation[] = [
      { index: 0, description: 'Fetch data', inputTemplate: { url: 'a' }, dependsOn: [] },
      { index: 1, description: 'Write file', inputTemplate: { path: 'b' }, dependsOn: [0] },
    ];
    const steps = buildCanonicalSteps(calls, annotations);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ order: 0, tool: 'http_request', description: 'Fetch data', inputTemplate: { url: 'a' }, dependsOn: [] });
    expect(steps[1]).toEqual({ order: 1, tool: 'write_file', description: 'Write file', inputTemplate: { path: 'b' }, dependsOn: [0] });
  });

  it('synthesizes a fallback step when an annotation index is missing', () => {
    // Haiku omits index 1.
    const annotations: StepAnnotation[] = [
      { index: 0, description: 'Fetch data', inputTemplate: { url: 'a' }, dependsOn: [] },
    ];
    const steps = buildCanonicalSteps(calls, annotations);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toEqual({ order: 1, tool: 'write_file', description: 'write_file', inputTemplate: {}, dependsOn: [] });
  });

  it('ignores an extra/unknown annotation index — count still matches', () => {
    const annotations: StepAnnotation[] = [
      { index: 0, description: 'Fetch data', inputTemplate: {}, dependsOn: [] },
      { index: 1, description: 'Write file', inputTemplate: {}, dependsOn: [] },
      { index: 99, description: 'ghost step', inputTemplate: {}, dependsOn: [] },
    ];
    const steps = buildCanonicalSteps(calls, annotations);
    expect(steps).toHaveLength(2);
    expect(steps.some(s => s.description === 'ghost step')).toBe(false);
  });

  it('first annotation wins on a duplicate index', () => {
    const annotations: StepAnnotation[] = [
      { index: 0, description: 'first', inputTemplate: {}, dependsOn: [] },
      { index: 0, description: 'second', inputTemplate: {}, dependsOn: [] },
      { index: 1, description: 'Write file', inputTemplate: {}, dependsOn: [] },
    ];
    const steps = buildCanonicalSteps(calls, annotations);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.description).toBe('first');
  });

  it('falls back to tool name when annotation description is empty', () => {
    const annotations: StepAnnotation[] = [
      { index: 0, description: '', inputTemplate: {}, dependsOn: [] },
      { index: 1, description: 'Write file', inputTemplate: {}, dependsOn: [] },
    ];
    const steps = buildCanonicalSteps(calls, annotations);
    expect(steps[0]!.description).toBe('http_request');
  });

  it('defaults dependsOn to an empty array when the annotation omits it', () => {
    const annotations: StepAnnotation[] = [
      { index: 0, description: 'Fetch data', inputTemplate: {} },
      { index: 1, description: 'Write file', inputTemplate: {} },
    ];
    const steps = buildCanonicalSteps(calls, annotations);
    expect(steps[0]!.dependsOn).toEqual([]);
    expect(steps[1]!.dependsOn).toEqual([]);
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

/**
 * Provider plumbing — regression guard for the EU-residency bug where
 * captureProcess constructed an Anthropic client + `claude-haiku-…` model id
 * regardless of the caller's actual provider, so a Mistral user's
 * `save_workflow` call routed to api.anthropic.com (or 4xx'd on Mistral with
 * an unknown model). Without this test, the silent regression resurfaces the
 * next time someone refactors the client construction.
 */
describe('captureProcess — provider plumbing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    anthropicCtorCalls.length = 0;
    openaiCtorCalls.length = 0;
    // Mirror engine bootstrap for a Mistral-hosted tenant — without this,
    // `getModelId('haiku', 'openai')` falls back to the Anthropic id and
    // the assertion below would only catch the client-routing bug, not
    // the model-id bug. Reset to null in afterEach so other tests aren't
    // affected.
    setOpenAIModelResolver({ map: MISTRAL_MODEL_MAP, fallbackModelId: null });
    mockOpenAICreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'extract_process',
          input: {
            steps: [{ index: 0, description: 'do thing', inputTemplate: {}, dependsOn: [] }],
            parameters: [],
          },
        },
      ],
    });
    mockCreate.mockResolvedValue(makeMockResponse());
  });

  afterEach(() => {
    setOpenAIModelResolver({ map: null, fallbackModelId: null });
  });

  it('routes workflow-save to api.mistral.ai with a Mistral model id when provider=openai', async () => {
    const calls: ToolCallRecord[] = [
      call('http_request', '{"url":"https://example.com"}', 0),
    ];
    await captureProcess('run1', 'Mistral Workflow', calls, {
      apiKey: 'mistral-key',
      apiBaseURL: 'https://api.mistral.ai/v1',
      provider: 'openai',
      openaiModelId: 'ministral-8b-2512',
    });

    // OpenAIAdapter was constructed (not the Anthropic SDK).
    expect(openaiCtorCalls).toHaveLength(1);
    expect(openaiCtorCalls[0]!.baseURL).toBe('https://api.mistral.ai/v1');
    expect(openaiCtorCalls[0]!.modelId).toBe('ministral-8b-2512');
    expect(anthropicCtorCalls).toHaveLength(0);

    // The model id sent on the request is a Mistral one, never claude-*.
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    const body = mockOpenAICreate.mock.calls[0]![0] as { model: string; betas?: unknown };
    expect(body.model).toBe('ministral-8b-2512');
    expect(body.model.startsWith('claude-')).toBe(false);
    // `betas` is an Anthropic-only header; openai-compat must omit it so the
    // Mistral endpoint doesn't get a stray field it doesn't understand.
    expect(body.betas).toBeUndefined();
  });

  it('preserves legacy Anthropic path when provider is omitted', async () => {
    const calls: ToolCallRecord[] = [
      call('http_request', '{"url":"https://example.com"}', 0),
    ];
    await captureProcess('run1', 'Anthropic Workflow', calls, {
      apiKey: 'sk-ant-test',
    });

    // No OpenAIAdapter constructed — legacy callers untouched.
    expect(openaiCtorCalls).toHaveLength(0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const body = mockCreate.mock.calls[0]![0] as { model: string };
    expect(body.model.startsWith('claude-haiku')).toBe(true);
  });
});
