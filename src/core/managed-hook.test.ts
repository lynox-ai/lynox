import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createManagedHook } from './managed-hook.js';
import type { RunContext } from './engine.js';

const CTX = { modelTier: 'balanced' } as unknown as RunContext;

/**
 * Regression coverage for the idle-tenant staleness oscillation: flush() only
 * refreshes lastSyncedAtMs when there are pending usage reports, so an idle
 * managed tenant relies entirely on the resync heartbeat to stay fresh. A
 * previous `if (!allowed || isStale())` guard meant the clock was only reset
 * AFTER staleness, so a healthy idle tenant oscillated fresh->stale and any
 * run in the stale window was wrongly fail-closed with "control plane
 * unreachable". The heartbeat must fire unconditionally.
 */
describe('managed-hook credit heartbeat', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.test';
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'inst-1';
    process.env['LYNOX_HTTP_SECRET'] = 'secret';
    delete process.env['LYNOX_MANAGED_FLUSH_INTERVAL_MS']; // default 30s -> stale 300s, resync 150s
    vi.useFakeTimers();
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ allowed: true }),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'];
    delete process.env['LYNOX_MANAGED_INSTANCE_ID'];
    delete process.env['LYNOX_HTTP_SECRET'];
  });

  function statusCalls(): number {
    return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/status')).length;
  }

  it('re-syncs on the heartbeat cadence even while allowed=true and idle', async () => {
    const hook = createManagedHook();
    await hook.onInit?.();
    // onInit performs one status sync.
    expect(statusCalls()).toBe(1);

    // Advance two full resync intervals (~150s each). With the old guard this
    // would NOT re-sync (allowed=true, not yet stale), drifting toward stale.
    await vi.advanceTimersByTimeAsync(150_000);
    expect(statusCalls()).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(statusCalls()).toBeGreaterThanOrEqual(3);

    await hook.onShutdown?.();
  });

  it('does not fail-closed a healthy idle tenant past the staleness threshold', async () => {
    const hook = createManagedHook();
    await hook.onInit?.();

    // Idle past the 300s staleness threshold — no usage reports, so flush()
    // never refreshes the clock; only the heartbeat keeps it fresh.
    await vi.advanceTimersByTimeAsync(305_000);

    // CP is healthy (fetch resolves ok), so a run must NOT be blocked.
    expect(() => hook.onBeforeRun?.('run-1', CTX)).not.toThrow();

    await hook.onShutdown?.();
  });

  it('fails closed when the control plane is genuinely unreachable past the threshold', async () => {
    const hook = createManagedHook();
    await hook.onInit?.();
    // First sync succeeded; now the CP goes down — every heartbeat rejects.
    fetchSpy.mockRejectedValue(new Error('network down'));

    await vi.advanceTimersByTimeAsync(305_000);

    expect(() => hook.onBeforeRun?.('run-2', CTX)).toThrow(/control plane temporarily unreachable/i);

    await hook.onShutdown?.();
  });
});
