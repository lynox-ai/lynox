/**
 * Managed hosting usage hook — reports token consumption to the control plane.
 *
 * Only active when LYNOX_MANAGED_MODE is set (EU instances provisioned by
 * the managed hosting control plane). BYOK instances never load this.
 *
 * - onBeforeRun: blocks if cached `allowed` flag is false (hard cap)
 * - onAfterRun: queues usage and periodically flushes to control plane
 * - Periodic re-sync: refreshes `allowed` flag every 5 min when denied
 */

import type { LynoxHooks, RunContext } from './engine.js';

interface UsageReport {
  run_id: string;
  model: string;
  total_tokens: number;
}

interface FlushResponse {
  accepted: number;
  balance_tokens: number;
  allowed: boolean;
}

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_BATCH_SIZE = 10;
const MAX_PENDING = 500;
const RESYNC_INTERVAL_MS = 5 * 60_000; // Re-check credit status every 5 min when denied
const FLUSH_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 5_000;

/** Blended cost estimate: ~$9/1M tokens (average across input+output, all model tiers). */
const DEFAULT_USD_PER_TOKEN = 0.000009;

export function createManagedHook(): LynoxHooks {
  const controlPlaneUrl = process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] ?? '';
  const instanceId = process.env['LYNOX_MANAGED_INSTANCE_ID'] ?? '';
  const secret = process.env['LYNOX_HTTP_SECRET'] ?? '';
  const usdPerToken = Number(process.env['LYNOX_MANAGED_USD_PER_TOKEN'] ?? '') || DEFAULT_USD_PER_TOKEN;

  if (!controlPlaneUrl || !instanceId || !secret) {
    throw new Error(
      'Managed hook: missing LYNOX_MANAGED_CONTROL_PLANE_URL, LYNOX_MANAGED_INSTANCE_ID, or LYNOX_HTTP_SECRET',
    );
  }

  let allowed = true;
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
      }
    } catch {
      // Sync failed — keep current state
    }
  }

  return {
    async onInit() {
      await syncStatus();
      process.stderr.write(`[lynox] Managed hook initialized: allowed=${allowed}, instance=${instanceId}\n`);
      flushTimer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
      // Periodic re-sync when denied — picks up credit top-ups
      resyncTimer = setInterval(() => {
        if (!allowed) void syncStatus();
      }, RESYNC_INTERVAL_MS);
    },

    onBeforeRun(_runId: string, _context: RunContext) {
      if (!allowed) {
        throw new Error(
          'Token allowance exhausted. Purchase additional credits or wait for your next billing cycle.\n' +
          'Manage your account at https://lynox.ai/managed/account',
        );
      }
    },

    onAfterRun(runId: string, costUsd: number, context: RunContext) {
      if (costUsd <= 0) return; // Skip zero-cost or erroneous runs

      const estimatedTokens = Math.max(1, Math.round(costUsd / usdPerToken));

      pending.push({
        run_id: runId,
        model: context.modelTier,
        total_tokens: estimatedTokens,
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
