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
});
