import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentDateContext, withCurrentTimePrefix } from './prompts.js';

// File-level reset so a forgotten useRealTimers() in a future test can't
// poison the next case's `new Date()` reads.
afterEach(() => {
  vi.useRealTimers();
});

describe('currentDateContext', () => {
  it('truncates the current ISO timestamp to the hour', () => {
    // Stub Date so the test is deterministic across all minute boundaries.
    // Hour-truncation is what keeps the Anthropic prompt cache key stable
    // for the full hour — losing that defeats the whole point of the
    // helper, so the contract is worth pinning explicitly.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T08:41:23.456Z'));
    const ctx = currentDateContext();
    expect(ctx).toContain('2026-05-05T08:00:00Z');
    expect(ctx).not.toContain('08:41');
    expect(ctx).toContain('Tuesday');
  });

  it('mentions the per-turn fallback so the model knows where to read precise time', () => {
    // The hour-truncated value can lag by up to 59 minutes, which broke
    // "in 5 min" scheduling in the 2026-05-05 incident. The per-turn
    // `[Now: …Z]` marker is the precise source of truth; the docstring
    // has to point at it or the LLM keeps trusting the stale hour.
    const ctx = currentDateContext();
    expect(ctx).toMatch(/per-turn|user message|\[Now/i);
  });
});

describe('withCurrentTimePrefix', () => {
  it('prepends a [Now: <iso>] marker to a string user message', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T08:41:23.456Z'));
    const out = withCurrentTimePrefix('hello');
    expect(out).toBe('[Now: 2026-05-05T08:41:23.456Z]\n\nhello');
  });

  it('inserts a leading text block for a multimodal content array, leaving other blocks intact', () => {
    // Telegram + image flow. Strict-equal on the trailing blocks so a
    // future map/clone bug that truncates the image source would fail —
    // assert-on-type-only would silently let it pass.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T08:41:23.456Z'));
    const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xxx' } };
    const textBlock = { type: 'text', text: 'what is this?' };
    const out = withCurrentTimePrefix([imageBlock, textBlock]) as Array<unknown>;
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: 'text', text: '[Now: 2026-05-05T08:41:23.456Z]' });
    expect(out[1]).toEqual(imageBlock);
    expect(out[2]).toEqual(textBlock);
  });

  it('passes through an already-prefixed string unchanged (double-decorator guard)', () => {
    // A future Telegram / orchestrator path could pre-prepend the marker
    // and then re-route the same content through Session.run. Guard so
    // the model doesn't see two stacked markers.
    const already = '[Now: 2026-05-05T07:00:00Z]\n\nhello';
    expect(withCurrentTimePrefix(already)).toBe(already);
  });

  it('passes through an already-prefixed content array unchanged', () => {
    const already = [
      { type: 'text', text: '[Now: 2026-05-05T07:00:00Z]' },
      { type: 'text', text: 'hello' },
    ];
    expect(withCurrentTimePrefix(already)).toBe(already);
  });

  it('returns unrecognised input shapes unchanged (defensive)', () => {
    // agent.send is typed `string | unknown[]`. A buggy caller handing
    // a plain object / null / undefined shouldn't throw — we want the
    // existing failure mode to still surface where it would have.
    const obj = { foo: 'bar' } as unknown as string;
    expect(withCurrentTimePrefix(obj)).toBe(obj);
    expect(withCurrentTimePrefix(null as unknown as string)).toBe(null);
    expect(withCurrentTimePrefix(undefined as unknown as string)).toBe(undefined);
  });
});
