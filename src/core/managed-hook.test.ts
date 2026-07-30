import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    // onBeforeRun is async now (the mirror refuse path awaits a resync) — assert
    // on the promise, not a sync throw (A2/RD-GAP5).
    await expect(hook.onBeforeRun!('run-1', CTX)).resolves.toBeUndefined();

    await hook.onShutdown?.();
  });

  it('fails closed when the control plane is genuinely unreachable past the threshold', async () => {
    const hook = createManagedHook();
    await hook.onInit?.();
    // First sync succeeded; now the CP goes down — every heartbeat rejects.
    fetchSpy.mockRejectedValue(new Error('network down'));

    await vi.advanceTimersByTimeAsync(305_000);

    await expect(hook.onBeforeRun!('run-2', CTX)).rejects.toThrow(/control plane temporarily unreachable/i);

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

/**
 * L-LE-3 — bill exact whole cents with a carried sub-cent remainder. The old
 * `Math.max(1, Math.round(costUsd * 100))` floored every run to >= 1 cent, so a
 * $0.001 run was billed 1c (10x) and per-helper debits multiplied the overcharge.
 */
describe('managed-hook sub-cent billing (L-LE-3)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.test';
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'inst-1';
    process.env['LYNOX_HTTP_SECRET'] = 'secret';
    delete process.env['LYNOX_MANAGED_FLUSH_INTERVAL_MS'];
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: true }) });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'];
    delete process.env['LYNOX_MANAGED_INSTANCE_ID'];
    delete process.env['LYNOX_HTTP_SECRET'];
  });

  // Every cost_cents actually reported to the CP across all flush POSTs.
  function flushedRuns(): Array<{ run_id: string; cost_cents: number }> {
    const runs: Array<{ run_id: string; cost_cents: number }> = [];
    for (const [url, opts] of fetchSpy.mock.calls) {
      const u = String(url);
      const body = (opts as { body?: string } | undefined)?.body;
      if (u.includes('/internal/usage/') && !u.endsWith('/status') && body) {
        const parsed = JSON.parse(body) as { runs?: Array<{ run_id: string; cost_cents: number }> };
        if (Array.isArray(parsed.runs)) runs.push(...parsed.runs);
      }
    }
    return runs;
  }

  it('does not bill a lone sub-cent run — it carries to the next', async () => {
    const hook = createManagedHook();
    hook.onAfterRun?.('r1', 0.001, CTX); // 0.1c — the old floor billed this as 1c
    await hook.onShutdown?.();
    expect(flushedRuns()).toHaveLength(0);
  });

  it('accumulates sub-cent runs into one exact cent (no per-helper amplification)', async () => {
    const hook = createManagedHook();
    // Ten $0.001 runs = $0.01 of real spend. The old floor billed 10 x 1c = 10c.
    for (let i = 0; i < 10; i++) hook.onAfterRun?.(`r${i}`, 0.001, CTX);
    await hook.onShutdown?.();
    const total = flushedRuns().reduce((n, r) => n + r.cost_cents, 0);
    expect(total).toBe(1);
  });

  it('carries the fractional remainder across runs', async () => {
    const hook = createManagedHook();
    hook.onAfterRun?.('a', 0.006, CTX); // 0.6c → carried, no report
    hook.onAfterRun?.('b', 0.006, CTX); // 1.2c → 1c reported, 0.2c carried
    await hook.onShutdown?.();
    const runs = flushedRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cost_cents).toBe(1);
  });

  it('bills a whole-cent run exactly (normal case unchanged)', async () => {
    const hook = createManagedHook();
    hook.onAfterRun?.('x', 0.03, CTX); // 3c exactly
    await hook.onShutdown?.();
    const runs = flushedRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cost_cents).toBe(3);
  });

  it('never over-bills a large batch of sub-cent runs vs the real spend', async () => {
    const hook = createManagedHook();
    // 250 runs at $0.004 = $1.00 real. Old floor: 250c. Exact: 100c.
    for (let i = 0; i < 250; i++) hook.onAfterRun?.(`r${i}`, 0.004, CTX);
    await hook.onShutdown?.();
    const total = flushedRuns().reduce((n, r) => n + r.cost_cents, 0);
    expect(total).toBe(100);
  });

  it('ignores non-finite costs (NaN / Infinity) without polluting the carry', async () => {
    const hook = createManagedHook();
    hook.onAfterRun?.('nan', Number.NaN, CTX);
    hook.onAfterRun?.('inf', Number.POSITIVE_INFINITY, CTX);
    hook.onAfterRun?.('ok', 0.02, CTX); // a real 2c run still bills correctly
    await hook.onShutdown?.();
    const runs = flushedRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cost_cents).toBe(2);
  });

  it('does not double-count a run fired twice with the same id (failed-run double-fire)', async () => {
    const hook = createManagedHook();
    // The failed-run path can re-fire onAfterRun with the SAME run_id after the
    // success path already fired it. The CP dedups whole-cent reports by run_id,
    // but a sub-cent fire emits no report — so without the accumulator's own
    // dedup the re-fire would add this run's 0.6c into the carry a second time.
    hook.onAfterRun?.('run-x', 0.006, CTX);
    hook.onAfterRun?.('run-x', 0.006, CTX); // duplicate — must be ignored
    // Three more distinct 0.6c runs. Deduped: 0.6 x 4 = 2.4c → 2c billed.
    // WITHOUT the dedup the duplicate adds 0.6c → 3.0c → 3c (an over-bill).
    for (const id of ['a', 'b', 'c']) hook.onAfterRun?.(id, 0.006, CTX);
    await hook.onShutdown?.();
    const total = flushedRuns().reduce((n, r) => n + r.cost_cents, 0);
    expect(total).toBe(2);
  });
});

/**
 * C2 / DEF-0083(b′) — the local balance mirror. A best-effort bounded local
 * tightening of the coarse ≤5-min allow-boolean: it can only REFUSE more, never
 * admit what `!isStale() && allowed` already refuses. Each test pins one of the
 * §7 build invariants (i–iv) or a §4.2 verify-done clause. The CP stays the exact
 * authority; the mirror closes the burst window between syncs.
 */
describe('managed-hook balance mirror (C2 / DEF-0083)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let statusBalance: number | null;
  let statusAllowed: boolean;

  beforeEach(() => {
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.test';
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'inst-1';
    process.env['LYNOX_HTTP_SECRET'] = 'secret';
    delete process.env['LYNOX_MANAGED_FLUSH_INTERVAL_MS'];
    statusBalance = 50; // 50c default entitlement
    statusAllowed = true;
    fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/status')) {
        return Promise.resolve({ ok: true, json: async () => ({ allowed: statusAllowed, balance_cents: statusBalance }) });
      }
      // flush POST — its balance is deliberately unreliable and the mirror ignores it.
      return Promise.resolve({ ok: true, json: async () => ({ allowed: statusAllowed, balance_cents: 0 }) });
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

  const statusCalls = (): number =>
    fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/status')).length;

  it('refuses a run when a burst drains the mirror ≤0 between CP syncs (verify-done)', async () => {
    const hook = createManagedHook();
    await hook.onInit?.(); // one /status → mirror = 50c
    // A $0.60 run debits 60c locally with no intervening /status: mirror 50 → -10.
    hook.onAfterRun?.('r1', 0.60, CTX);
    await expect(hook.onBeforeRun!('run-x', CTX)).rejects.toThrow(/budget for this period reached/i);
    await hook.onShutdown?.();
  });

  it('refuse is FINAL for the current run, but the resync picks up a credit pack for the next (§7 ii)', async () => {
    const hook = createManagedHook();
    await hook.onInit?.(); // mirror = 50c
    hook.onAfterRun?.('r1', 0.60, CTX); // mirror → -10
    statusBalance = 200; // customer buys a credit pack; the CP now reports 200c
    // The refuse forces a resync (which re-anchors mirror to +200), yet THIS run
    // is still refused — no re-evaluate-and-admit after the in-refuse resync.
    await expect(hook.onBeforeRun!('run-1', CTX)).rejects.toThrow(/budget for this period reached/i);
    // The NEXT run sees the refreshed mirror and is admitted.
    await expect(hook.onBeforeRun!('run-2', CTX)).resolves.toBeUndefined();
    await hook.onShutdown?.();
  });

  it('is a no-op for BYOK/hosted (null balance never mints a mirror)', async () => {
    statusBalance = null; // BYOK/hosted — no CP entitlement
    const hook = createManagedHook();
    await hook.onInit?.(); // mirror stays undefined
    hook.onAfterRun?.('r1', 5.00, CTX); // huge cost, but no mirror to decrement
    await expect(hook.onBeforeRun!('run-x', CTX)).resolves.toBeUndefined();
    await hook.onShutdown?.();
  });

  it('refuse path resyncs flush→status, /status the last writer, and touches only those endpoints (§7 iii/iv)', async () => {
    const hook = createManagedHook();
    await hook.onInit?.(); // mirror = 50c
    statusBalance = 10;
    hook.onAfterRun?.('r1', 0.60, CTX); // mirror → -10, pending has one 60c report
    fetchSpy.mockClear();
    await expect(hook.onBeforeRun!('run-x', CTX)).rejects.toThrow(/budget for this period reached/i);
    const calls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.endsWith('/status')).toBe(false); // flush POST FIRST
    expect(calls[1]!.endsWith('/status')).toBe(true); // then authoritative /status
    // No endpoint other than the flush POST + /status GET is hit on the refuse path.
    expect(calls.every(u => u.endsWith('/status') || u.includes(`/internal/usage/inst-1`))).toBe(true);
    await hook.onShutdown?.();
  });

  it('coalesces forced resyncs so repeated refuses can not fetch-storm the CP (verify-done, S2)', async () => {
    statusBalance = 0; // depleted — every run refuses
    const hook = createManagedHook();
    await hook.onInit?.(); // mirror = 0
    fetchSpy.mockClear();
    await expect(hook.onBeforeRun!('run-1', CTX)).rejects.toThrow(/budget for this period reached/i);
    await expect(hook.onBeforeRun!('run-2', CTX)).rejects.toThrow(/budget for this period reached/i);
    // Two refuses in the same coalesce window → exactly ONE forced /status.
    expect(statusCalls()).toBe(1);
    await hook.onShutdown?.();
  });

  it('checks staleness BEFORE the mirror (§7 i) — a stale CP refuses with the unreachable message, not budget', async () => {
    vi.useFakeTimers();
    const hook = createManagedHook();
    await hook.onInit?.(); // mirror = 50c, clock fresh, timers started
    hook.onAfterRun?.('r1', 0.60, CTX); // mirror → -10 (would trip the budget refuse)
    await hook.onShutdown?.(); // stop the heartbeat timers so advancing the clock cannot resync
    fetchSpy.mockRejectedValue(new Error('network down')); // CP now unreachable
    vi.advanceTimersByTime(305_000); // clock past the 300s staleness threshold; nothing resyncs it
    // isStale() is evaluated first, so the message is the staleness one — the mirror
    // term (mirror ≤ 0) is never reached even though it would refuse.
    await expect(hook.onBeforeRun!('run-x', CTX)).rejects.toThrow(/control plane temporarily unreachable/i);
  });
});

/**
 * Contract fixture pair (K-W2, PRD-CORE-PRO-CONTRACT §2.3 #1/#2).
 *
 * The golden fixtures in `src/contract/fixtures/` are shared bytes: the control
 * plane's pair tests assert its REAL route handlers accept/produce them, and
 * these tests drive the engine's REAL serializer/parser against the same files.
 * A field rename on either side fails one of the two suites before it ships.
 */
describe('managed-hook contract fixtures (K-W2)', () => {
  const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../contract/fixtures');
  const load = (name: string): unknown =>
    JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));

  let fetchSpy: ReturnType<typeof vi.fn>;
  // Hooks whose onInit started real intervals — shut down in afterEach even
  // when an assertion rejects mid-test, so no live timer pins the worker.
  let liveHooks: Array<ReturnType<typeof createManagedHook>> = [];
  const mkHook = (): ReturnType<typeof createManagedHook> => {
    const hook = createManagedHook();
    liveHooks.push(hook);
    return hook;
  };

  beforeEach(() => {
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.test';
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'inst-1';
    process.env['LYNOX_HTTP_SECRET'] = 'secret';
    delete process.env['LYNOX_MANAGED_FLUSH_INTERVAL_MS'];
  });

  afterEach(async () => {
    for (const hook of liveHooks) await hook.onShutdown?.();
    liveHooks = [];
    vi.unstubAllGlobals();
    delete process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'];
    delete process.env['LYNOX_MANAGED_INSTANCE_ID'];
    delete process.env['LYNOX_HTTP_SECRET'];
  });

  it('the REAL flush serializer produces exactly the usage-flush-request fixture (generator test)', async () => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: true }) });
    vi.stubGlobal('fetch', fetchSpy);
    const hook = mkHook();
    // Seed the two runs the fixture describes: 3c on `balanced`, 12c on `deep`.
    hook.onAfterRun?.('TEST-RUN-0001', 0.03, { modelTier: 'balanced' } as unknown as RunContext);
    hook.onAfterRun?.('TEST-RUN-0002', 0.12, { modelTier: 'deep' } as unknown as RunContext);
    await hook.onShutdown?.(); // final flush
    const flushCall = fetchSpy.mock.calls.find(([url]) => {
      const u = String(url);
      return u.includes('/internal/usage/') && !u.endsWith('/status');
    });
    expect(flushCall).toBeDefined();
    const body = JSON.parse(String((flushCall![1] as { body: string }).body)) as unknown;
    expect(body).toEqual(load('usage-flush-request.json'));
  });

  it('the REAL flush parser dereferences `allowed` off the usage-flush-response fixture', async () => {
    // No onInit: the hook starts allowed=false + stale. The ONLY state writer
    // in this test is flush() parsing the fixture — if the fixture's `allowed`
    // key were renamed, `data.allowed` would be undefined, the run below would
    // be refused, and this test would fail (the rename-fails-both-sides probe).
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => load('usage-flush-response.json') });
    vi.stubGlobal('fetch', fetchSpy);
    const hook = mkHook();
    hook.onAfterRun?.('TEST-RUN-0001', 0.03, CTX);
    await hook.onShutdown?.(); // flushes through the fixture response → allowed=true, fresh
    await expect(hook.onBeforeRun!('TEST-RUN-0002', CTX)).resolves.toBeUndefined();
  });

  it('the REAL /status parser consumes the managed fixture: allowed + balance anchor the mirror', async () => {
    fetchSpy = vi.fn().mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.endsWith('/status')) {
        return Promise.resolve({ ok: true, json: async () => load('usage-status-response.managed.json') });
      }
      return Promise.resolve({ ok: true, json: async () => load('usage-flush-response.json') });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const hook = mkHook();
    await hook.onInit?.();
    // Fixture says allowed:true, balance 2985c → a run is admitted.
    await expect(hook.onBeforeRun!('TEST-RUN-0001', CTX)).resolves.toBeUndefined();
    // The mirror anchored on the fixture's balance_cents: spending past it
    // (2985c = $29.85 → $30 spend drives the mirror ≤ 0) refuses the next run.
    hook.onAfterRun?.('TEST-RUN-0002', 30, CTX);
    await expect(hook.onBeforeRun!('TEST-RUN-0003', CTX)).rejects.toThrow(/budget for this period reached/i);
    await hook.onShutdown?.();
  });

  it('the REAL /status parser consumes the hosted fixture: null balance leaves the mirror inert', async () => {
    fetchSpy = vi.fn().mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.endsWith('/status')) {
        return Promise.resolve({ ok: true, json: async () => load('usage-status-response.hosted.json') });
      }
      return Promise.resolve({ ok: true, json: async () => load('usage-flush-response.json') });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const hook = mkHook();
    await hook.onInit?.();
    // allowed:true + balance null (BYOK/hosted): no mirror, spend never refuses.
    hook.onAfterRun?.('TEST-RUN-0001', 100, CTX);
    await expect(hook.onBeforeRun!('TEST-RUN-0002', CTX)).resolves.toBeUndefined();
    await hook.onShutdown?.();
  });
});
