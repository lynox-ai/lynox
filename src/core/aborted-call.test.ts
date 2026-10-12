import { describe, it, expect } from 'vitest';
import {
  abortedCallCost, partialMessageOf, reportAbortedCall, abortedCallCounts, TOOL_USE_OVERHEAD_TOKENS,
} from './aborted-call.js';
import { calculateCost } from './pricing.js';

const MODEL = 'claude-haiku-4-5-20251001';
const REQUEST = {
  system: 'You write follow-up suggestion chips.',
  messages: [{ role: 'user', content: 'Frage: Wie weiter mit dem Angebot für Beispiel AG?' }],
  tools: [{ name: 'suggest_follow_ups', input_schema: { type: 'object' } }],
};
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

describe('abortedCallCost — the stream got as far as its first event', () => {
  // The provider's own prompt count is in the partial message; only the output is unknown.
  const partial = { usage: { input_tokens: 1200, cache_read_input_tokens: 300 }, content: [{ type: 'tool_use', input: { suggestions: [] } }] };

  it('bounds the output at max_tokens and takes the prompt as counted', () => {
    const c = abortedCallCost({ model: MODEL, maxTokens: 960, request: REQUEST, partial });
    expect(c.fromSnapshot).toBe(true);
    expect(c.upperBoundUsd).toBe(calculateCost(MODEL, { input_tokens: 1200, cache_read_input_tokens: 300, output_tokens: 960 }));
  });

  it('estimates below the bound, from what was streamed so far', () => {
    const c = abortedCallCost({ model: MODEL, maxTokens: 960, request: REQUEST, partial });
    expect(c.estimateUsd).toBeLessThan(c.upperBoundUsd);
    expect(c.estimateUsd).toBeGreaterThan(calculateCost(MODEL, { input_tokens: 1200, cache_read_input_tokens: 300, output_tokens: 0 }));
  });
});

describe('abortedCallCost — no count from the provider (aborted before the first event, or a stream without a snapshot)', () => {
  // The cap reads the bound, so it must not come out below the real cost. A token is at least
  // one byte, so the request's UTF-8 size is a prompt count the real one cannot exceed.
  it('cannot be below a prompt of one token per byte plus the tool-use overhead, with full output', () => {
    const c = abortedCallCost({ model: MODEL, maxTokens: 512, request: REQUEST });
    expect(c.fromSnapshot).toBe(false);
    expect(c.upperBoundUsd).toBeGreaterThanOrEqual(
      calculateCost(MODEL, { input_tokens: bytes(REQUEST) + TOOL_USE_OVERHEAD_TOKENS, output_tokens: 512 }));
  });

  it('counts bytes, not characters, so text outside ASCII does not shrink the bound', () => {
    const wide = { ...REQUEST, messages: [{ role: 'user', content: '見積もりの件、どう進めますか。'.repeat(40) }] };
    const c = abortedCallCost({ model: MODEL, maxTokens: 512, request: wide });
    expect(c.upperBoundUsd).toBeGreaterThanOrEqual(
      calculateCost(MODEL, { input_tokens: bytes(wide) + TOOL_USE_OVERHEAD_TOKENS, output_tokens: 512 }));
  });

  it('prices the prompt at the cache-write rate when that is higher', () => {
    const c = abortedCallCost({ model: MODEL, maxTokens: 512, request: REQUEST });
    expect(c.upperBoundUsd).toBeGreaterThanOrEqual(
      calculateCost(MODEL, { input_tokens: 0, cache_creation_input_tokens: bytes(REQUEST) + TOOL_USE_OVERHEAD_TOKENS, output_tokens: 512 }));
  });

  it('keeps the estimate below the bound', () => {
    const c = abortedCallCost({ model: MODEL, maxTokens: 512, request: REQUEST });
    expect(c.estimateUsd).toBeLessThan(c.upperBoundUsd);
  });

  it('treats a snapshot without a prompt count like no snapshot', () => {
    const c = abortedCallCost({ model: MODEL, maxTokens: 512, request: REQUEST, partial: { usage: { input_tokens: 0 } } });
    expect(c.fromSnapshot).toBe(false);
  });

  it.each([
    ['a non-numeric cache-write count', { cache_creation_input_tokens: 'many' }],
    ['a negative cache-write count', { cache_creation_input_tokens: -1_000_000 }],
    ['a non-numeric cache-read count', { cache_read_input_tokens: 'many' }],
    ['a negative cache-read count', { cache_read_input_tokens: -1_000_000 }],
    ['an infinite cache-write count', { cache_creation_input_tokens: Infinity }],
    ['an infinite prompt count', { input_tokens: Infinity }],
  ])('treats a snapshot with %s like no snapshot, so the bound stays a finite amount above zero', (_label, bad) => {
    const usage = { input_tokens: 1200, ...bad } as unknown as { input_tokens: number };
    const c = abortedCallCost({ model: MODEL, maxTokens: 512, request: REQUEST, partial: { usage } });
    const unmeasured = abortedCallCost({ model: MODEL, maxTokens: 512, request: REQUEST });
    expect(c.fromSnapshot).toBe(false);
    expect(Number.isFinite(c.upperBoundUsd)).toBe(true);
    expect(c.upperBoundUsd).toBe(unmeasured.upperBoundUsd);
  });
});

describe('partialMessageOf', () => {
  it('reads the partial message of a stream that keeps one', () => {
    const m = { usage: { input_tokens: 5 } };
    expect(partialMessageOf({ currentMessage: m })).toBe(m);
  });

  it('is undefined for a stream without one, and for a getter that throws', () => {
    expect(partialMessageOf({ finalMessage: () => undefined })).toBeUndefined();
    expect(partialMessageOf(undefined)).toBeUndefined();
    expect(partialMessageOf({ get currentMessage(): unknown { throw new Error('gone'); } })).toBeUndefined();
  });
});

describe('reportAbortedCall', () => {
  it('counts every aborted call as not billed, and the uncounted ones separately', () => {
    const before = abortedCallCounts();
    const counted = abortedCallCost({ model: MODEL, maxTokens: 512, request: REQUEST, partial: { usage: { input_tokens: 10 } } });
    const uncounted = abortedCallCost({ model: MODEL, maxTokens: 512, request: REQUEST });
    reportAbortedCall('test.site', MODEL, counted);
    reportAbortedCall('test.site', MODEL, uncounted);
    const after = abortedCallCounts();
    expect(after.notBilled['test.site']).toBe((before.notBilled['test.site'] ?? 0) + 2);
    expect(after.uncounted['test.site']).toBe((before.uncounted['test.site'] ?? 0) + 1);
  });
});
