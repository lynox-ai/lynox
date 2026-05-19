/**
 * Managed hosting usage hook — reports AI cost (USD cents) to the control plane.
 *
 * Only active when LYNOX_MANAGED_MODE is set (EU instances provisioned by
 * the managed hosting control plane). BYOK instances never load this.
 *
 * - onBeforeRun: blocks if cached `allowed` flag is false (hard cap) OR if
 *   the cached state is too stale to trust (fail-closed under CP outage)
 * - onAfterRun: queues cost report and periodically flushes to control plane
 * - Periodic re-sync: refreshes `allowed` flag every 5 min when denied
 *
 * Wave 3 — fail-closed contract:
 *  - Initial state is `allowed = false`; the first onInit syncStatus() MUST
 *    succeed before any request is allowed. Previously a fresh boot started
 *    in `allowed = true` and a silent sync failure left it that way.
 *  - Every successful flush/syncStatus updates `lastSyncedAtMs`. If the
 *    cached state grows older than STALE_THRESHOLD_MS, onBeforeRun denies
 *    new runs with a "control plane unreachable" message. Demo tenants
 *    tighten the threshold via LYNOX_MANAGED_FLUSH_INTERVAL_MS.
 */

import type { LynoxHooks, RunContext } from './engine.js';

interface UsageReport {
  run_id: string;
  model: string;
  cost_cents: number;
}

interface FlushResponse {
  accepted: number;
  balance_cents: number;
  allowed: boolean;
}

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const FLUSH_BATCH_SIZE = 10;
const MAX_PENDING = 500;
const RESYNC_INTERVAL_MS = 5 * 60_000; // Re-check credit status every 5 min when denied
const FLUSH_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 5_000;
// Stale threshold: how long we trust the cached `allowed` flag when the
// control plane is unreachable. After this, fail-closed on new runs.
// Matches 10× the default flush interval — leaves headroom for transient
// CP restarts but won't silently allow uncapped spend if the CP is
// genuinely down. Demo tenants override via LYNOX_MANAGED_FLUSH_INTERVAL_MS
// + this same 10× multiplier.
const STALE_MULTIPLIER = 10;

/** Parse a positive integer env var with fallback; rejects 0/NaN/negative. */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createManagedHook(): LynoxHooks {
  const controlPlaneUrl = process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] ?? '';
  const instanceId = process.env['LYNOX_MANAGED_INSTANCE_ID'] ?? '';
  const secret = process.env['LYNOX_HTTP_SECRET'] ?? '';

  if (!controlPlaneUrl || !instanceId || !secret) {
    throw new Error(
      'Managed hook: missing LYNOX_MANAGED_CONTROL_PLANE_URL, LYNOX_MANAGED_INSTANCE_ID, or LYNOX_HTTP_SECRET',
    );
  }

  // Fail-closed default: first sync must succeed before any request runs.
  // Previously this was `true`, so a fresh-boot CP outage left the engine
  // burning credit indefinitely until the first successful flush.
  let allowed = false;
  let lastSyncedAtMs = 0;
  const flushIntervalMs = parsePositiveIntEnv('LYNOX_MANAGED_FLUSH_INTERVAL_MS', DEFAULT_FLUSH_INTERVAL_MS);
  const staleThresholdMs = flushIntervalMs * STALE_MULTIPLIER;
  const pending: UsageReport[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let resyncTimer: ReturnType<typeof setInterval> | null = null;
  let flushing = false;

  async function flush(): Promise<void> {
    if (flushing || pending.length === 0) return;
    flushing = true;

    const batch = pending.splice(0);
    const url = `${controlPlaneUrl}/internal/usage/${instanceId}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-instance-secret': secret },
        body: JSON.stringify({ runs: batch }),
        signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
      });

      if (res.ok) {
        const data = (await res.json()) as FlushResponse;
        allowed = data.allowed;
        lastSyncedAtMs = Date.now();
      } else {
        requeueBatch(batch);
        process.stderr.write(`[lynox] Managed usage report failed: ${res.status}\n`);
      }
    } catch (err: unknown) {
      requeueBatch(batch);
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[lynox] Managed usage report error: ${msg}\n`);
    } finally {
      flushing = false;
    }
  }

  /** Put failed batch back, respecting the max queue size. */
  function requeueBatch(batch: UsageReport[]): void {
    const available = MAX_PENDING - pending.length;
    if (available <= 0) return; // Queue full, drop batch
    const toKeep = batch.slice(-available); // Keep newest entries
    pending.unshift(...toKeep);
  }

  /** Sync credit status from control plane. */
  async function syncStatus(): Promise<void> {
    const url = `${controlPlaneUrl}/internal/usage/${instanceId}/status`;
    try {
      const res = await fetch(url, {
        headers: { 'x-instance-secret': secret },
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json()) as { allowed: boolean };
        allowed = data.allowed;
        lastSyncedAtMs = Date.now();
      }
    } catch {
      // Sync failed — keep current state. The staleness check in
      // onBeforeRun will deny new runs if this persists past the threshold.
    }
  }

  /** Has the cached `allowed` state grown stale (CP unreachable too long)? */
  function isStale(): boolean {
    // Pre-first-sync state — lastSyncedAtMs===0 — is treated as stale,
    // so even with `allowed=true` (e.g. test injection) we still gate on
    // a real sync having happened.
    if (lastSyncedAtMs === 0) return true;
    return Date.now() - lastSyncedAtMs > staleThresholdMs;
  }

  return {
    async onInit() {
      await syncStatus();
      process.stderr.write(
        `[lynox] Managed hook initialized: allowed=${allowed}, instance=${instanceId}, flushInterval=${flushIntervalMs}ms, staleThreshold=${staleThresholdMs}ms\n`,
      );
      flushTimer = setInterval(() => { void flush(); }, flushIntervalMs);
      // Periodic re-sync when denied OR when the cached state is stale —
      // picks up credit pack purchases AND recovers from CP outages once
      // connectivity returns. Without the staleness clause the resync only
      // fired when `allowed` was already false, so a fail-closed engine
      // could never re-allow itself even after the CP came back up.
      resyncTimer = setInterval(() => {
        if (!allowed || isStale()) void syncStatus();
      }, RESYNC_INTERVAL_MS);
    },

    onBeforeRun(_runId: string, _context: RunContext) {
      if (isStale()) {
        throw new Error(
          'Managed control plane unreachable — credit status is stale and the engine is fail-closed for safety. ' +
          'New runs will resume automatically once the control plane comes back online. ' +
          'Status: https://status.lynox.cloud',
        );
      }
      if (!allowed) {
        throw new Error(
          'AI budget for this period reached. Buy a credit pack to continue now, or wait for your next billing cycle.\n' +
          'Manage your account at https://lynox.ai/managed/account',
        );
      }
    },

    onAfterRun(runId: string, costUsd: number, context: RunContext) {
      if (costUsd <= 0) return; // Skip zero-cost or erroneous runs

      const costCents = Math.max(1, Math.round(costUsd * 100));

      pending.push({
        run_id: runId,
        model: context.modelTier,
        cost_cents: costCents,
      });

      // Drop oldest if over capacity
      while (pending.length > MAX_PENDING) {
        pending.shift();
      }

      if (pending.length >= FLUSH_BATCH_SIZE) {
        void flush();
      }
    },

    async onShutdown() {
      if (flushTimer) clearInterval(flushTimer);
      if (resyncTimer) clearInterval(resyncTimer);
      // Final flush with retry
      for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
        await flush();
        if (pending.length === 0) break;
        await new Promise(r => setTimeout(r, 1_000));
      }
      if (pending.length > 0) {
        process.stderr.write(`[lynox] Managed hook shutdown: ${pending.length} usage reports lost\n`);
      }
    },
  };
}
