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

  it('disambiguates UTC-storage from local-display', () => {
    // Live test 2026-05-05 caught the inverse of the original bug: agent
    // displayed 14:00 Uhr (correct CEST) but ALSO wrote run_at as
    // "2026-05-05T14:00Z" — interpreting the local clock as UTC, off by
    // the tz offset. The system prompt has to call out that storage stays
    // UTC while display stays local; otherwise the model conflates them.
    const ctx = currentDateContext();
    expect(ctx).toMatch(/UTC.*storage|storage.*UTC|tool inputs.*UTC|run_at.*UTC/i);
    expect(ctx).toMatch(/replies?.*local|local.*replies?|present.*local|local.*clock/i);
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

  it('appends user-local time + IANA tz when timezone is provided (string path)', () => {
    // Bug 2026-05-05: agent presented "11:20 Uhr" verbatim from the UTC
    // marker. With the tz arg, the marker now also surfaces the user's
    // wallclock so the model can render times in their local zone.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T11:20:50.123Z'));
    const out = withCurrentTimePrefix('hi', 'Europe/Zurich') as string;
    // Europe/Zurich in May is UTC+2 (CEST) → 13:20:50.
    expect(out).toBe('[Now: 2026-05-05T11:20:50.123Z; user local 2026-05-05 13:20:50 Europe/Zurich]\n\nhi');
  });

  it('appends user-local time on multimodal content arrays too', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T11:20:50.123Z'));
    const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xxx' } };
    const out = withCurrentTimePrefix([imageBlock], 'America/New_York') as Array<unknown>;
    // America/New_York in May is UTC-4 (EDT) → 07:20:50.
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ type: 'text', text: '[Now: 2026-05-05T11:20:50.123Z; user local 2026-05-05 07:20:50 America/New_York]' });
    expect(out[1]).toEqual(imageBlock);
  });

  it('handles winter DST correctly (CET, UTC+1)', () => {
    // Earlier test pinned summer (CEST, UTC+2). Winter case ensures the
    // formatter actually re-derives the offset from the date rather than
    // from any cached/pinned value — DST regressions surface here.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T11:20:50.123Z'));
    const out = withCurrentTimePrefix('hi', 'Europe/Zurich') as string;
    expect(out).toBe('[Now: 2026-01-15T11:20:50.123Z; user local 2026-01-15 12:20:50 Europe/Zurich]\n\nhi');
  });

  it('routes empty-string tz through the UTC-only path', () => {
    // The web-ui sends '' when Intl is somehow missing; the http-api
    // sanitiser also emits '' for invalid input. Either should land on
    // the UTC-only marker shape — never throw, never invoke the formatter.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T11:20:50.123Z'));
    const out = withCurrentTimePrefix('hi', '') as string;
    expect(out).toBe('[Now: 2026-05-05T11:20:50.123Z]\n\nhi');
  });

  it('falls back to UTC-only marker when timezone is invalid (no throw)', () => {
    // Defensive: a malformed tz like 'Mars/Olympus' must not break the run.
    // Intl.DateTimeFormat would throw RangeError on construction; we catch
    // and fall back to the UTC-only marker shape.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T11:20:50.123Z'));
    const out = withCurrentTimePrefix('hi', 'Mars/Olympus') as string;
    expect(out).toBe('[Now: 2026-05-05T11:20:50.123Z]\n\nhi');
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
