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

/**
 * M1 — a dropped usage report is un-debited spend (money owed to lynox that the
 * tenant used but was never billed for). The in-memory queue is best-effort, so
 * when a drop is unavoidable it must be LOUD (stderr marker + Bugsink capture +
 * a cumulative counter), not silently erode margin. These prove the drop paths
 * surface the loss instead of swallowing it.
 */
describe('managed-hook usage-drop is loud (M1)', () => {
  beforeEach(() => {
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.test';
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'inst-1';
    process.env['LYNOX_HTTP_SECRET'] = 'secret';
    delete process.env['LYNOX_MANAGED_FLUSH_INTERVAL_MS'];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'];
    delete process.env['LYNOX_MANAGED_INSTANCE_ID'];
    delete process.env['LYNOX_HTTP_SECRET'];
  });

  function dropLogs(spy: ReturnType<typeof vi.spyOn>, reason: string): string[] {
    return spy.mock.calls.map(c => String(c[0])).filter(s => s.includes('DROP') && s.includes(reason));
  }

  it('logs overflow evictions instead of silently dropping them', () => {
    // fetch hangs → the auto-flush at batch size gets stuck (flushing stays
    // true), so the queue can only grow and eventually evict past MAX_PENDING.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => { /* never resolves */ })));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const hook = createManagedHook(); // no onInit → no timers
    for (let i = 0; i < 600; i++) hook.onAfterRun?.(`run-${i}`, 0.01, CTX); // 1c each, > MAX_PENDING (500)

    const logs = dropLogs(stderrSpy, 'overflow-evict');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain('un-debited');
    stderrSpy.mockRestore();
  });

  it('reports spend lost at shutdown after all retries fail', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('cp down')));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const hook = createManagedHook();
    hook.onAfterRun?.('run-lost', 0.25, CTX); // 25c queued, never flushable

    // Shutdown retries flush 3× (1s apart) then gives up — drive the timers.
    const shutdown = hook.onShutdown?.();
    await vi.advanceTimersByTimeAsync(3_000);
    await shutdown;

    const logs = dropLogs(stderrSpy, 'shutdown-unflushed');
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('25c'); // the exact un-debited amount surfaced
    stderrSpy.mockRestore();
  });
});
