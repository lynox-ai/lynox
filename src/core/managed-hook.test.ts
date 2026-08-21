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
  // What the CP states about the gate. `'balance'` is the current control
  // plane; `undefined` omits the key entirely (a control plane from before the
  // field existed); anything else is what a broken reply would carry.
  let statusGate: unknown;

  beforeEach(() => {
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.test';
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'inst-1';
    process.env['LYNOX_HTTP_SECRET'] = 'secret';
    delete process.env['LYNOX_MANAGED_FLUSH_INTERVAL_MS'];
    statusBalance = 50; // 50c default entitlement
    statusAllowed = true;
    statusGate = 'balance';
    fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/status')) {
        const body: Record<string, unknown> = { allowed: statusAllowed, balance_cents: statusBalance };
        if (statusGate !== undefined) body['spend_gate'] = statusGate;
        return Promise.resolve({ ok: true, json: async () => body });
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

  // ── An ALREADY-ANCHORED mirror meeting the CP's gate statement ──────────────
  //
  // The case above starts cold. These do not, and that is the whole difference:
  // the mirror can only ever go DOWN once anchored (`onAfterRun` decrements,
  // `onBeforeRun` refuses), and the re-anchor is the only thing that can raise
  // it. So what the re-anchor does on a non-numeric balance decides whether an
  // account that stops being balance-gated is released (comp) or stays frozen
  // — and whether a container that should NOT be released can be released by
  // accident. The two signals are kept apart on purpose:
  //
  //   `spend_gate: 'none'`        → a POSITIVE statement → clear
  //   `balance_cents: null` alone → a provider-type fact  → keep
  //
  // #1102 cleared on the bare null and was reversed here: the null also reaches
  // a container that holds the pooled key while its instance row says
  // otherwise, and clearing left that container with no bound at all.

  it('clears an anchored mirror on `spend_gate: "none"` — a comp is metered but never refused', async () => {
    const hook = createManagedHook();
    await hook.onInit?.(); // mirror = 50c, anchored from a number
    hook.onAfterRun?.('r1', 0.60, CTX); // mirror → -10c: gated

    // The CP now states the account is not balance-gated. The balance it sends
    // is the REAL one — negative — so anchoring on it would refuse: this is the
    // case that proves the gate statement is read BEFORE the number.
    statusBalance = -250;
    statusGate = 'none';
    await hook.onShutdown?.(); // stop the first timer pair before re-init
    await hook.onInit?.();

    // MUTATION THIS KILLS (a): dropping the `spend_gate === 'none'` branch —
    // the -250 anchors, run-b is refused.
    // MUTATION THIS KILLS (b): swapping the order (number first, then gate) —
    // same outcome, the number wins and refuses.
    await expect(hook.onBeforeRun!('run-b', CTX)).resolves.toBeUndefined();

    // And it stays ungated: further spend must not re-arm a mirror that is gone.
    hook.onAfterRun?.('r2', 5.00, CTX);
    await expect(hook.onBeforeRun!('run-c', CTX)).resolves.toBeUndefined();
    await hook.onShutdown?.();
  });

  it('a bare null balance does NOT clear an anchored mirror — it is a provider-type fact, not a release', async () => {
    // A control plane from before `spend_gate` existed (the key is absent), or
    // a current one answering its non-managed branch for a container that
    // still holds the pooled key. Either way: no positive statement, no clear.
    // The freeze is bounded (the mirror keeps decrementing to its floor and a
    // restart re-anchors); a clear would have been unbounded.
    const hook = createManagedHook();
    await hook.onInit?.(); // mirror = 50c

    statusBalance = null;
    statusGate = undefined; // legacy reply: `{ allowed, balance_cents: null }`
    hook.onAfterRun?.('r1', 0.60, CTX); // mirror → -10c

    // The refuse fires a forced flush→/status; that /status now carries the
    // null. Under #1102's branch it would clear the mirror right there, and
    // run-b below would be admitted. Under the current code it keeps -10c.
    await expect(hook.onBeforeRun!('run-a', CTX)).rejects.toThrow(/budget for this period reached/i);
    // MUTATION THIS KILLS: re-adding `else if (data.balance_cents === null) mirror = undefined`.
    await expect(hook.onBeforeRun!('run-b', CTX)).rejects.toThrow(/budget for this period reached/i);
    await hook.onShutdown?.();
  });

  it('only the exact token `"none"` releases — `"unfunded"` and every near-miss keep the guard armed', async () => {
    // `'unfunded'` is the CP's "no statement" token and must behave like an
    // absent key. `'NONE'`, `'None'`, `'none '`, `'balance'`-with-a-null-balance,
    // a boolean: each is what a careless emitter or a loosened comparison would
    // produce. A `typeof data.spend_gate === 'string'` rewrite, or a
    // `.toLowerCase()` "tolerance", passes the comp test above and admits these.
    for (const junk of ['unfunded', 'NONE', 'None', 'none ', 'balance', true, 1, {}]) {
      const hook = createManagedHook();
      statusBalance = 50;
      statusGate = 'balance';
      await hook.onInit?.(); // mirror = 50c
      hook.onAfterRun?.('r1', 0.60, CTX); // mirror → -10c

      statusBalance = null;
      statusGate = junk;
      await hook.onShutdown?.();
      await hook.onInit?.();

      // MUTATION THIS KILLS: loosening the `=== 'none'` comparison in any
      // direction (case-folding, trimming, truthiness, typeof-string), or
      // treating `'unfunded'` as a release.
      await expect(hook.onBeforeRun!('run-x', CTX), JSON.stringify(junk))
        .rejects.toThrow(/budget for this period reached/i);
      await hook.onShutdown?.();
    }
  });

  it('a body WITHOUT `spend_gate` still anchors on a numeric balance — an older control plane keeps gating', async () => {
    // The window in which an older control plane omits the field: every numeric
    // balance arrives without a token and must gate exactly as before.
    // MUTATION THIS KILLS: `else if (data.spend_gate === 'balance' &&
    // typeof data.balance_cents === 'number')` — every other test in this
    // block sends `'balance'`, so only this one sees the difference.
    const hook = createManagedHook();
    statusGate = undefined;
    statusBalance = 50;
    await hook.onInit?.(); // anchored at 50c from a legacy body
    hook.onAfterRun?.('r1', 0.60, CTX); // mirror → -10c
    await expect(hook.onBeforeRun!('run-x', CTX)).rejects.toThrow(/budget for this period reached/i);
    await hook.onShutdown?.();
  });

  it('`"none"` releases on the token alone — a null balance beside it changes nothing', async () => {
    // The token is the statement; `balance_cents` is not consulted once it is
    // read. MUTATION THIS KILLS: `spend_gate === 'none' && typeof
    // data.balance_cents === 'number'` — which would turn a comp reply with a
    // null balance back into a frozen mirror.
    const hook = createManagedHook();
    await hook.onInit?.(); // mirror = 50c
    hook.onAfterRun?.('r1', 0.60, CTX); // mirror → -10c

    statusBalance = null;
    statusGate = 'none';
    await hook.onShutdown?.();
    await hook.onInit?.();
    await expect(hook.onBeforeRun!('run-x', CTX)).resolves.toBeUndefined();
    await hook.onShutdown?.();
  });

  it('`"none"` does not override `allowed: false` — the two terms stay independent', async () => {
    // `allowed` can go false for reasons other than money (a suspended
    // account); the gate token must not be read as "allowed". This pins the
    // independence only — both refuse paths throw the same message, so it does
    // not distinguish WHICH term refused.
    const hook = createManagedHook();
    statusBalance = -250;
    statusGate = 'none';
    statusAllowed = false;
    await hook.onInit?.();
    await expect(hook.onBeforeRun!('run-x', CTX)).rejects.toThrow(/budget for this period reached/i);
    await hook.onShutdown?.();
  });

  it('a malformed /status does NOT clear the mirror — the guard stays armed', async () => {
    // The other half of the branch, and the one a careless fix loses. An absent
    // or non-null non-numeric `balance_cents` is a broken response, not a signal.
    // Treating it as "not balance-gated" would let ONE degraded CP reply switch
    // the local overspend guard off, which is strictly worse than the freeze.
    const hook = createManagedHook();
    await hook.onInit?.(); // mirror = 50c
    hook.onAfterRun?.('r1', 0.60, CTX); // mirror → -10c

    // /status starts answering 200 OK with the field missing entirely.
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).endsWith('/status')) {
        return Promise.resolve({ ok: true, json: async () => ({ allowed: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ allowed: true, balance_cents: 0 }) });
    });
    await hook.onInit?.();

    // MUTATION THIS KILLS: widening the branch to a bare `else { mirror = undefined; }`.
    // That reads as a simplification and silently disarms the spend guard.
    await expect(hook.onBeforeRun!('run-x', CTX)).rejects.toThrow(/budget for this period reached/i);
    await hook.onShutdown?.();
  });

  it('a non-null NON-NUMBER does not clear it either — `typeof x === "object"` is not the test', async () => {
    // The gap the ABSENT case above leaves open, and it is not academic:
    // `typeof null === 'object'`, so `else if (typeof data.balance_cents ===
    // 'object')` looks like a faithful rewrite of the null check, passes every
    // other test in this file, and additionally clears the mirror on `{}` or
    // `[]` — a malformed reply disarming the guard, which is the one outcome the
    // branch comment rules out. Found by mutating the line, not by reading it.
    // Driven through the harness's own `statusBalance` seam rather than by
    // replacing the fetch mock: a replacement survives the loop iteration and
    // silently stops the NEXT case from anchoring at all, so every later
    // assertion passes for the wrong reason. (It did, on the first draft.)
    for (const junk of [{}, [], 'none', true]) {
      const hook = createManagedHook();
      statusBalance = 50;
      await hook.onInit?.(); // mirror = 50c
      hook.onAfterRun?.('r1', 0.60, CTX); // mirror → -10c

      statusBalance = junk as unknown as number; // a broken reply, not a signal
      await hook.onInit?.();

      await expect(hook.onBeforeRun!('run-x', CTX), JSON.stringify(junk))
        .rejects.toThrow(/budget for this period reached/i);
      await hook.onShutdown?.();
    }
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

  it('the REAL /status parser consumes the comp fixture: a negative balance with `spend_gate: none` clears the mirror', async () => {
    // The fixture carries balance_cents -250 — the number the engine would
    // have anchored on and refused. The gate token is what stops that, and it
    // is read off the same golden bytes the control plane's pair test emits.
    let status = 'usage-status-response.managed.json';
    fetchSpy = vi.fn().mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.endsWith('/status')) {
        return Promise.resolve({ ok: true, json: async () => load(status) });
      }
      return Promise.resolve({ ok: true, json: async () => load('usage-flush-response.json') });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const hook = mkHook();
    await hook.onInit?.(); // anchored at 2985c from the managed fixture
    hook.onAfterRun?.('TEST-RUN-0001', 30, CTX); // mirror → ≤ 0
    await expect(hook.onBeforeRun!('TEST-RUN-0002', CTX)).rejects.toThrow(/budget for this period reached/i);

    // The kill below exists only because the comp fixture's balance is ≤ 0 — a
    // positive comp balance would admit the run with or without the token.
    expect((load('usage-status-response.comp.json') as { balance_cents: number }).balance_cents).toBeLessThanOrEqual(0);
    status = 'usage-status-response.comp.json'; // the account is comped
    await hook.onShutdown?.();
    await hook.onInit?.();
    // Renaming `spend_gate` in the fixture (or the parser) re-anchors on -250
    // and this run is refused — the rename-fails-both-sides probe for the field.
    await expect(hook.onBeforeRun!('TEST-RUN-0003', CTX)).resolves.toBeUndefined();
    await hook.onShutdown?.();
  });

  it('the REAL /status parser consumes the hosted fixture WARM: `unfunded` keeps an anchored mirror', async () => {
    // Cold, the hosted fixture leaves the mirror inert (above). Warm — a
    // container anchored from a funded reply that then meets the unfunded
    // branch — it must NOT be released: the CP made no statement about a gate.
    let status = 'usage-status-response.managed.json';
    fetchSpy = vi.fn().mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.endsWith('/status')) {
        return Promise.resolve({ ok: true, json: async () => load(status) });
      }
      return Promise.resolve({ ok: true, json: async () => load('usage-flush-response.json') });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const hook = mkHook();
    await hook.onInit?.(); // anchored at 2985c
    status = 'usage-status-response.hosted.json';
    hook.onAfterRun?.('TEST-RUN-0001', 30, CTX); // mirror → ≤ 0
    // The refuse path resyncs against the hosted fixture; `unfunded` keeps the
    // mirror, so this and the next run stay refused.
    await expect(hook.onBeforeRun!('TEST-RUN-0002', CTX)).rejects.toThrow(/budget for this period reached/i);
    await expect(hook.onBeforeRun!('TEST-RUN-0003', CTX)).rejects.toThrow(/budget for this period reached/i);
    await hook.onShutdown?.();
  });
});
/**
 * DEF-provider-billing-alert: a provider billing/quota stop must reach the CP as
 * an incident even though it spent 0 tokens — the failure class that otherwise
 * stays invisible (a per-request error the CP never sees, /api/health green).
 * Emission is gated on the CP FUNDING this instance (spend_gate balance/none),
 * so a BYOK tenant's own-account failure never raises a pooled-provider alert.
 */
describe('managed-hook provider incident', () => {
  beforeEach(() => {
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.test';
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'inst-1';
    process.env['LYNOX_HTTP_SECRET'] = 'secret';
    delete process.env['LYNOX_MANAGED_FLUSH_INTERVAL_MS'];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'];
    delete process.env['LYNOX_MANAGED_INSTANCE_ID'];
    delete process.env['LYNOX_HTTP_SECRET'];
  });

  /** A fetch mock that routes by URL: /status returns the given spend_gate (so
   *  onInit sets cpFunded), /incident returns `incidentOk` (false → reject),
   *  everything else returns a benign ok. */
  function routingFetch(spendGate: string, incidentOk = true): ReturnType<typeof vi.fn> {
    return vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/status')) {
        return Promise.resolve({ ok: true, json: async () => ({ allowed: true, spend_gate: spendGate, balance_cents: 5000 }) });
      }
      if (String(url).endsWith('/incident')) {
        return incidentOk ? Promise.resolve({ ok: true }) : Promise.reject(new Error('cp down'));
      }
      return Promise.resolve({ ok: true, json: async () => ({ allowed: true }) });
    });
  }

  function incidentCalls(spy: ReturnType<typeof vi.fn>): Array<[string, RequestInit]> {
    return spy.mock.calls.filter(([url]) => String(url).endsWith('/incident')) as Array<[string, RequestInit]>;
  }

  const billing = (providerHost: string, status = 412): RunContext =>
    ({ modelTier: 'balanced', failure: { kind: 'provider_billing', providerHost, status } } as unknown as RunContext);

  /** A CP-FUNDED hook (spend_gate balance), onInit'd so cpFunded is set. */
  async function fundedHook(spy: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('fetch', spy);
    const hook = createManagedHook();
    await hook.onInit?.();
    return hook;
  }

  const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

  it('reports the incident with cost 0 — the cost skip must NOT drop it', async () => {
    const spy = routingFetch('balance');
    const hook = await fundedHook(spy);
    // costUsd = 0: a billing failure spends no tokens. The usage-report path skips
    // it; the incident path must not.
    hook.onAfterRun?.('run-1', 0, billing('api.fireworks.ai', 412));
    await hook.onShutdown?.();

    const calls = incidentCalls(spy);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe('https://cp.test/internal/usage/inst-1/incident');
    expect((init.headers as Record<string, string>)['x-instance-secret']).toBe('secret');
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'provider_billing', provider_host: 'api.fireworks.ai', status: 412,
    });
  });

  it('coalesces repeated failures on the SAME host into one report', async () => {
    const spy = routingFetch('balance');
    const hook = await fundedHook(spy);
    for (let i = 0; i < 5; i++) hook.onAfterRun?.(`run-${i}`, 0, billing('api.fireworks.ai'));
    await hook.onShutdown?.();
    expect(incidentCalls(spy)).toHaveLength(1);
  });

  it('reports each distinct provider host separately', async () => {
    const spy = routingFetch('balance');
    const hook = await fundedHook(spy);
    hook.onAfterRun?.('run-a', 0, billing('api.fireworks.ai'));
    hook.onAfterRun?.('run-b', 0, billing('api.anthropic.com', 400));
    await hook.onShutdown?.();
    const hosts = incidentCalls(spy).map(([, init]) => JSON.parse(String(init.body)).provider_host).sort();
    expect(hosts).toEqual(['api.anthropic.com', 'api.fireworks.ai']);
  });

  it('does NOT report an incident for a normal (non-failure) run', async () => {
    const spy = routingFetch('balance');
    const hook = await fundedHook(spy);
    hook.onAfterRun?.('run-ok', 0.01, { modelTier: 'balanced' } as unknown as RunContext);
    await hook.onShutdown?.();
    expect(incidentCalls(spy)).toHaveLength(0);
  });

  it('does NOT emit for a BYOK/unfunded instance — even on a real billing failure', async () => {
    // The source-side gate: spend_gate 'unfunded' → the tenant runs on their own
    // key, so a 402/credit-balance is theirs, not the CP's pooled account. This is
    // also the forge defence: a tenant who owns their endpoint cannot raise a
    // pooled-provider alert.
    const spy = routingFetch('unfunded');
    const hook = await fundedHook(spy); // onInit runs, but cpFunded stays false
    hook.onAfterRun?.('run-byok', 0, billing('api.fireworks.ai', 402));
    await hook.onShutdown?.();
    expect(incidentCalls(spy)).toHaveLength(0);
  });

  it('a failed incident POST is handled and clears the coalesce stamp so the next failure retries', async () => {
    // Replaces a weak "never throws" assertion: `void fetch().catch()` cannot
    // throw synchronously regardless. The real contract is that a rejected POST
    // (a) does not crash and (b) does not suppress the host for the whole window.
    const spy = routingFetch('balance', /* incidentOk */ false);
    const hook = await fundedHook(spy);
    expect(() => hook.onAfterRun?.('run-1', 0, billing('api.fireworks.ai'))).not.toThrow();
    await flushMicrotasks(); // let the .then/.catch clear the stamp
    // Second failure on the same host: the stamp was cleared, so it re-POSTs
    // instead of being coalesced away.
    hook.onAfterRun?.('run-2', 0, billing('api.fireworks.ai'));
    await hook.onShutdown?.();
    expect(incidentCalls(spy)).toHaveLength(2);
  });
})
