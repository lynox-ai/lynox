import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the bounded sink so the gate is tested without touching disk.
vi.mock('./bounded-jsonl-log.js', () => ({
  appendBoundedJsonl: vi.fn(() => Promise.resolve()),
}));

import { appendCaptureTelemetry, CAPTURE_TELEMETRY_LOG_FILE } from './capture-telemetry.js';
import { appendBoundedJsonl } from './bounded-jsonl-log.js';

const mockAppend = vi.mocked(appendBoundedJsonl);

describe('appendCaptureTelemetry', () => {
  beforeEach(() => mockAppend.mockClear());

  const entry = {
    ts: 1, event: 'remember_invoked' as const, thread: 't1',
    model: 'ministral-14b-2512', untrusted: false, outcome: 'active' as const,
  };

  it('is a byte-identical NO-OP when the DK flag is off (never touches the sink)', async () => {
    await appendCaptureTelemetry(false, entry);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('writes to the bounded sink when the DK flag is on', async () => {
    await appendCaptureTelemetry(true, entry);
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend).toHaveBeenCalledWith(CAPTURE_TELEMETRY_LOG_FILE, entry);
  });

  it('carries the fire-rate ends: a capture_eligible denominator with no outcome, a remember_invoked numerator with one', async () => {
    await appendCaptureTelemetry(true, { ts: 2, event: 'capture_eligible', thread: 't2', model: 'ministral-14b-2512', untrusted: false });
    await appendCaptureTelemetry(true, entry);
    const events = mockAppend.mock.calls.map((c) => (c[1] as { event: string; outcome?: string }));
    expect(events[0]).toMatchObject({ event: 'capture_eligible' });
    expect(events[0]!.outcome).toBeUndefined();
    expect(events[1]).toMatchObject({ event: 'remember_invoked', outcome: 'active' });
  });

  // ── Onboarding Wave 1 (PRD-ONBOARDING §7) ──

  it('activates the propose_* events with classification signals + an opaque entry-id (never text)', async () => {
    await appendCaptureTelemetry(true, {
      ts: 3, event: 'propose_shown', thread: 't3', model: 'ministral-14b-2512', untrusted: true,
      entryId: 'ke_abc123', captureSource: 'web_research', subjectKind: 'organization',
      confidence: 0.92, primary: true,
    });
    const logged = mockAppend.mock.calls[0]![1] as Record<string, unknown>;
    expect(logged).toMatchObject({
      event: 'propose_shown', entryId: 'ke_abc123', captureSource: 'web_research',
      subjectKind: 'organization', confidence: 0.92, primary: true,
    });
  });

  it('distinguishes an active discard from a silent ignore via the dismissed flag', async () => {
    await appendCaptureTelemetry(true, {
      ts: 4, event: 'propose_ignored', thread: 't4', model: 'ministral-14b-2512', untrusted: true,
      entryId: 'ke_x', dismissed: true,
    });
    expect(mockAppend.mock.calls[0]![1]).toMatchObject({ event: 'propose_ignored', dismissed: true });
  });

  it('carries the onboarding funnel events with a step index, gated off when DK is off', async () => {
    await appendCaptureTelemetry(false, { ts: 5, event: 'onboarding_started', thread: 't5', model: undefined, untrusted: false, step: 0 });
    expect(mockAppend).not.toHaveBeenCalled();
    await appendCaptureTelemetry(true, { ts: 6, event: 'onboarding_step_completed', thread: 't5', model: undefined, untrusted: false, step: 2 });
    await appendCaptureTelemetry(true, { ts: 7, event: 'onboarding_abandoned', thread: 't5', model: undefined, untrusted: false, step: 1 });
    const events = mockAppend.mock.calls.map((c) => c[1] as { event: string; step?: number });
    expect(events).toEqual([
      expect.objectContaining({ event: 'onboarding_step_completed', step: 2 }),
      expect.objectContaining({ event: 'onboarding_abandoned', step: 1 }),
    ]);
  });

  it('STRUCTURAL S5 guard: a fully-populated entry carries no fact-text field (only ids + signals)', async () => {
    // The PRIMARY S5 guarantee is the TYPE: CaptureTelemetryEntry has no content-bearing
    // field, so every production call-site (in tsc scope) is compile-blocked from passing
    // one — `text: '…'` at a real call-site fails `error TS2353` (verified by mutation probe).
    // This test is belt-and-suspenders: it builds the richest possible entry and pins the
    // full non-content key allow-set, so a reviewer who adds a content field to the type has
    // to consciously widen this list too (this runtime check alone can't see a type change).
    await appendCaptureTelemetry(true, {
      ts: 8, event: 'propose_confirmed', thread: 't8', model: 'ministral-14b-2512', untrusted: true,
      outcome: 'active', entryId: 'ke_y', dismissed: false, captureSource: 'ask_user',
      subjectKind: 'person', confidence: 0.5, primary: false, step: 3,
    });
    const logged = mockAppend.mock.calls[0]![1] as Record<string, unknown>;
    const allowed = new Set([
      'ts', 'event', 'thread', 'model', 'untrusted', 'outcome',
      'entryId', 'dismissed', 'captureSource', 'subjectKind', 'confidence', 'primary', 'step',
    ]);
    for (const key of Object.keys(logged)) expect(allowed.has(key)).toBe(true);
    // No content-bearing key exists on the entry at all.
    for (const forbidden of ['text', 'fact', 'content', 'value', 'answer']) {
      expect(Object.prototype.hasOwnProperty.call(logged, forbidden)).toBe(false);
    }
  });
});
