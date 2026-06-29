import { randomUUID } from 'node:crypto';

import type { Engine, RunContext } from './engine.js';
import type { ModelTier } from '../types/index.js';

/**
 * Gate + debit a metered request that does NOT flow through `Session.run()`.
 *
 * Voice TTS (`POST /api/speak`) and STT (`POST /api/transcribe`) proxy directly
 * to the provider on a lynox-supplied key (managed / managed_pro pool key), but
 * — unlike an interactive chat turn or a saved-workflow run — they never fired
 * the managed-credit lifecycle. The consequences on a managed instance:
 *
 *   - No `onBeforeRun` gate: a credit-EXHAUSTED tenant (or one whose control
 *     plane is stale → fail-closed) could keep driving the pool key, bounded
 *     only by the global request rate limit.
 *   - No `onAfterRun` debit: the spend was written to the local RunHistory but
 *     never reported to the control plane, so it was never deducted from the
 *     customer's `costBalanceCents` balance.
 *
 * These two helpers fire the exact same hooks `Session.run()` and
 * `runGuardedSavedWorkflow()` use, so every metered path converges on one gate
 * + one debit. On a true self-hosted instance (no `LYNOX_BILLING_TIER` env) no
 * hooks are registered, so both helpers are no-ops and the audio routes behave
 * exactly as before. The managed hook is also registered on hosted/BYOK (any
 * billing tier set), but there the control plane reports `allowed: true` so the
 * gate passes, and the cost report is rejected as not-applicable so the debit
 * is a CP no-op — BYOK is never credit-gated or billed for voice. Only
 * managed / managed_pro actually gate + debit.
 *
 * The managed hook keys billing off `LYNOX_MANAGED_INSTANCE_ID` (the container
 * == the tenant) and ignores the `RunContext` in `onBeforeRun`, so no tenant id
 * has to be threaded through. The `modelTier` is used only as the CP-side cost
 * label (same as the saved-workflow runner, which labels by the configured
 * tier); pass `'fast'` for a lightweight non-reasoning audio call.
 */

/** Result of the pre-run gate: a shared run id + the block reason (if any). */
export interface MeteredGateResult {
  /** Run id shared by the gate and the later cost report. The CP dedups
   *  debits on this id, so the same value MUST be passed to reportMeteredCost. */
  runId: string;
  /** Non-null when a hook blocked the run; the human-readable reason to surface. */
  blockedReason: string | null;
}

function buildRunContext(engine: Engine, runId: string, modelTier: ModelTier): RunContext {
  const context = engine.getContext();
  return {
    runId,
    contextId: context?.id ?? '',
    modelTier,
    durationMs: 0,
    source: context?.source ?? 'cli',
  };
}

/**
 * Run every registered `onBeforeRun` hook. A hook that throws means "blocked"
 * (managed budget exhausted, or control plane stale → fail-closed). Mirrors
 * `Session.run()` / `runGuardedSavedWorkflow()`: the caller must abort the run
 * when `blockedReason` is non-null. Returns the run id to thread into the
 * matching `reportMeteredCost()` on the success path.
 */
export async function fireBeforeRunGate(engine: Engine, modelTier: ModelTier): Promise<MeteredGateResult> {
  const runId = randomUUID();
  const runContext = buildRunContext(engine, runId, modelTier);
  for (const hook of engine.getHooks()) {
    if (hook.onBeforeRun) {
      try {
        await hook.onBeforeRun(runId, runContext);
      } catch (err: unknown) {
        return { runId, blockedReason: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  return { runId, blockedReason: null };
}

/**
 * Run every registered `onAfterRun` hook so the spend is queued for the
 * control-plane debit. Skips zero/negative cost (mirrors the managed hook).
 * Hook errors are non-fatal — the managed flush retries on the next run — so a
 * billing hiccup never breaks the audio response to the client.
 */
export function reportMeteredCost(engine: Engine, runId: string, costUsd: number, modelTier: ModelTier): void {
  if (costUsd <= 0) return;
  const runContext = buildRunContext(engine, runId, modelTier);
  for (const hook of engine.getHooks()) {
    if (hook.onAfterRun) {
      try {
        hook.onAfterRun(runId, costUsd, runContext);
      } catch { /* non-fatal — billing flush retries on the next run */ }
    }
  }
}
