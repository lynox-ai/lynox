/**
 * Managed hosting usage hook — reports token consumption to the control plane.
 *
 * Only active when LYNOX_MANAGED_MODE is set (EU instances provisioned by
 * the managed hosting control plane). BYOK instances never load this.
 *
 * - onBeforeRun: blocks if cached `allowed` flag is false (hard cap)
 * - onAfterRun: queues usage and periodically flushes to control plane
 * - Flush triggers: every 30s or when 10 runs are queued
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

export function createManagedHook(): LynoxHooks {
  const controlPlaneUrl = process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] ?? '';
  const instanceId = process.env['LYNOX_MANAGED_INSTANCE_ID'] ?? '';
  const secret = process.env['LYNOX_HTTP_SECRET'] ?? '';

  if (!controlPlaneUrl || !instanceId || !secret) {
    process.stderr.write(
      '[lynox] Managed hook: missing LYNOX_MANAGED_CONTROL_PLANE_URL, LYNOX_MANAGED_INSTANCE_ID, or LYNOX_HTTP_SECRET\n',
    );
    return {};
  }

  let allowed = true;
  const pending: UsageReport[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let flushing = false;

  async function flush(): Promise<void> {
    if (flushing || pending.length === 0) return;
    flushing = true;

    const batch = pending.splice(0);
    const url = `${controlPlaneUrl}/internal/usage/${instanceId}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, runs: batch }),
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        const data = (await res.json()) as FlushResponse;
        allowed = data.allowed;
      } else {
        // Put failed batch back for retry
        pending.unshift(...batch);
        process.stderr.write(`[lynox] Managed usage report failed: ${res.status}\n`);
      }
    } catch (err: unknown) {
      // Network error — put batch back for retry
      pending.unshift(...batch);
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[lynox] Managed usage report error: ${msg}\n`);
    } finally {
      flushing = false;
    }
  }

  /** Sync credit status from control plane on startup. */
  async function syncStatus(): Promise<void> {
    const url = `${controlPlaneUrl}/internal/usage/${instanceId}/status`;
    try {
      const res = await fetch(url, {
        headers: { 'x-instance-secret': secret },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { allowed: boolean };
        allowed = data.allowed;
      }
    } catch {
      // Startup sync failed — assume allowed until first flush
    }
  }

  return {
    async onInit() {
      await syncStatus();
      flushTimer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
    },

    onBeforeRun(_runId: string, _context: RunContext) {
      if (!allowed) {
        throw new Error(
          'Token allowance exhausted. Purchase additional credits or wait for your next billing cycle.\n' +
          'Manage your account at https://lynox.ai/managed/account',
        );
      }
    },

    onAfterRun(runId: string, _costUsd: number, context: RunContext) {
      // We don't have exact token counts here — costUsd is what we get.
      // Estimate tokens from cost using Sonnet pricing as conservative baseline.
      // The control plane will use the actual token count from the run record if available.
      // For now, we use a blended estimate: $15/1M output is Sonnet 4.6 pricing.
      // The actual per-model debit happens on the control plane side based on the model field.
      const estimatedTokens = Math.max(1, Math.round(_costUsd / 0.000015)); // ~$15/1M output tokens

      pending.push({
        run_id: runId,
        model: context.modelTier,
        total_tokens: estimatedTokens,
      });

      if (pending.length >= FLUSH_BATCH_SIZE) {
        void flush();
      }
    },

    async onShutdown() {
      if (flushTimer) clearInterval(flushTimer);
      await flush(); // Final flush
    },
  };
}
