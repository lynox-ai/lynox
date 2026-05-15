import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  callForStructuredJson,
  estimateCostUsd,
  estimateTokens,
  validateAgainstSchema,
  BudgetError,
  type ExtractSchema,
} from './llm-helper.js';

const SCHEMA: ExtractSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    count: { type: 'integer', minimum: 0 },
    level: { type: 'string', enum: ['low', 'medium', 'high'] as const },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
  required: ['name', 'count', 'level'],
};

function mockClient(payload: {
  toolInput?: unknown;
  contentBlocks?: Anthropic.ContentBlock[];
  usage?: { input_tokens: number; output_tokens: number };
}): Anthropic {
  const content: Anthropic.ContentBlock[] = payload.contentBlocks ?? [
    {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'extract',
      input: payload.toolInput,
    } as Anthropic.ContentBlock,
  ];
  return {
    messages: {
      create: async () => ({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content,
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: payload.usage ?? { input_tokens: 100, output_tokens: 50 },
      }),
    },
  } as unknown as Anthropic;
}

describe('estimateTokens', () => {
  it('returns 1 for short text', () => {
    expect(estimateTokens('hi')).toBe(1);
  });

  it('scales linearly at ~3.5 chars per token', () => {
    expect(estimateTokens('a'.repeat(35))).toBe(10);
    expect(estimateTokens('a'.repeat(3500))).toBe(1000);
  });
});

describe('validateAgainstSchema', () => {
  it('accepts a fully-valid object', () => {
    expect(() => validateAgainstSchema(
      { name: 'foo', count: 3, level: 'medium', tags: ['a', 'b'] },
      SCHEMA,
    )).not.toThrow();
  });

  it('rejects missing required field with path-pointer', () => {
    expect(() => validateAgainstSchema(
      { name: 'foo', count: 3 },
      SCHEMA,
    )).toThrow(/Missing required field "level"/);
  });

  it('rejects wrong type with path-pointer', () => {
    expect(() => validateAgainstSchema(
      { name: 'foo', count: 'three', level: 'low' },
      SCHEMA,
    )).toThrow(/Expected integer at "count"/);
  });

  it('rejects enum miss with available values', () => {
    expect(() => validateAgainstSchema(
      { name: 'foo', count: 3, level: 'extreme' },
      SCHEMA,
    )).toThrow(/not in enum \[low, medium, high\]/);
  });

  it('rejects integer that is a finite decimal', () => {
    expect(() => validateAgainstSchema(
      { name: 'foo', count: 3.5, level: 'low' },
      SCHEMA,
    )).toThrow(/Expected integer at "count"/);
  });

  it('rejects number below minimum', () => {
    expect(() => validateAgainstSchema(
      { name: 'foo', count: -1, level: 'low' },
      SCHEMA,
    )).toThrow(/below minimum 0/);
  });

  it('rejects oversized array via maxItems', () => {
    expect(() => validateAgainstSchema(
      { name: 'foo', count: 1, level: 'low', tags: ['a', 'b', 'c', 'd', 'e', 'f'] },
      SCHEMA,
    )).toThrow(/Array at "tags" has 6 items, max 5/);
  });

  it('rejects wrong item type inside array', () => {
    expect(() => validateAgainstSchema(
      { name: 'foo', count: 1, level: 'low', tags: ['a', 42] },
      SCHEMA,
    )).toThrow(/Expected string at "tags\[1\]"/);
  });

  it('rejects null root', () => {
    expect(() => validateAgainstSchema(null, SCHEMA)).toThrow(/Expected object at "<root>", got null/);
  });

  it('rejects array root', () => {
    expect(() => validateAgainstSchema([], SCHEMA)).toThrow(/Expected object at "<root>"/);
  });

  it('validates nested objects recursively', () => {
    const nested: ExtractSchema = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'string' } },
          required: ['inner'],
        },
      },
      required: ['outer'],
    };
    expect(() => validateAgainstSchema({ outer: {} }, nested)).toThrow(/Missing required field "outer.inner"/);
  });

  it('rejects wrong-typed nested property at the inner path', () => {
    const nested: ExtractSchema = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'string' } },
        },
      },
    };
    expect(() => validateAgainstSchema({ outer: 'not-an-object' }, nested)).toThrow(/Expected object at "outer"/);
  });
});

describe('callForStructuredJson', () => {
  const BASE_OPTS = {
    system: 'Extract structured data from the text.',
    user: 'Sample text to extract from.',
    schema: SCHEMA,
  };

  it('returns parsed data + cost on happy path', async () => {
    const client = mockClient({
      toolInput: { name: 'widget', count: 7, level: 'high', tags: ['a', 'b'] },
      usage: { input_tokens: 200, output_tokens: 80 },
    });
    const result = await callForStructuredJson<{ name: string; count: number; level: string; tags: string[] }>({
      ...BASE_OPTS,
      client,
    });
    expect(result.data.name).toBe('widget');
    expect(result.data.count).toBe(7);
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(80);
    // Cost = (200 * 0.8 + 80 * 4) / 1e6 = (160 + 320) / 1e6 = 0.00048
    expect(result.costUsd).toBeCloseTo(0.00048, 7);
  });

  it('rejects pre-flight when input estimate exceeds maxInputTokens', async () => {
    const huge = 'x'.repeat(500_000); // ~143k tokens
    const client = mockClient({ toolInput: { name: 'a', count: 1, level: 'low' } });
    await expect(callForStructuredJson({
      ...BASE_OPTS,
      user: huge,
      maxInputTokens: 1000,
      client,
    })).rejects.toThrow(BudgetError);
  });

  it('rejects pre-flight when cost estimate exceeds budgetUsd', async () => {
    // Set a near-zero budget so even small inputs trip the gate.
    const client = mockClient({ toolInput: { name: 'a', count: 1, level: 'low' } });
    await expect(callForStructuredJson({
      ...BASE_OPTS,
      budgetUsd: 0.000001,
      client,
    })).rejects.toThrow(BudgetError);
  });

  it('BudgetError carries the estimate context', async () => {
    const client = mockClient({ toolInput: { name: 'a', count: 1, level: 'low' } });
    try {
      await callForStructuredJson({
        ...BASE_OPTS,
        user: 'x'.repeat(50_000),
        maxInputTokens: 1000,
        client,
      });
      expect.fail('Expected BudgetError');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetError);
      const be = err as BudgetError;
      expect(be.estimatedInputTokens).toBeGreaterThan(1000);
      expect(be.estimatedCostUsd).toBeGreaterThan(0);
    }
  });

  it('estimateCostUsd clamps the output projection to maxOutputTokens', () => {
    // Pricing reference (Haiku 4.5 list, 2026-05): input $0.80/M, output $4.00/M.
    // 70_000 input tokens → $0.056 input cost.
    // Naive 25%-of-input projection = 17_500 output tokens × $4/M = $0.070.
    // Real API call caps output at maxOutputTokens (4_000) = $0.016.
    // Therefore the clamped estimate must be ~$0.072, not ~$0.126.
    const clamped = estimateCostUsd(70_000, 4_000);
    const unclamped = estimateCostUsd(70_000, 1_000_000); // cap well above 25% projection
    expect(clamped).toBeCloseTo(0.072, 3);
    expect(unclamped).toBeCloseTo(0.126, 3);
    // The clamp is the difference: $0.054 lower per call at this input size.
    expect(unclamped - clamped).toBeGreaterThan(0.05);
  });

  it('clamped estimate keeps a real 250 KB docs bootstrap inside the bumped $0.10 budget', async () => {
    const client = mockClient({ toolInput: { name: 'a', count: 1, level: 'low' } });
    // 245 K chars / 3.5 ≈ 70 K tokens — same scale as a real Stripe-style
    // docs landing page after the 250 KB body cap. Asserts the integration
    // path (not just the math) survives the bumped DOCS_EXTRACT_BUDGET_USD.
    await expect(callForStructuredJson({
      ...BASE_OPTS,
      user: 'x'.repeat(245_000),
      budgetUsd: 0.10,
      maxOutputTokens: 4_000,
      client,
    })).resolves.toBeDefined();
  });

  it('throws when the model emits no tool_use block', async () => {
    const client = mockClient({
      contentBlocks: [{ type: 'text', text: 'I refuse to call the tool.', citations: null } as Anthropic.ContentBlock],
    });
    await expect(callForStructuredJson({ ...BASE_OPTS, client })).rejects.toThrow(/did not call the extract tool/);
  });

  it('throws when the tool_use block has a malformed input shape (missing required field)', async () => {
    const client = mockClient({
      toolInput: { name: 'foo' }, // missing count + level
    });
    await expect(callForStructuredJson({ ...BASE_OPTS, client })).rejects.toThrow(/Missing required field/);
  });

  it('throws when the tool_use block has an out-of-enum field', async () => {
    const client = mockClient({
      toolInput: { name: 'foo', count: 1, level: 'invalid' },
    });
    await expect(callForStructuredJson({ ...BASE_OPTS, client })).rejects.toThrow(/not in enum/);
  });
});
