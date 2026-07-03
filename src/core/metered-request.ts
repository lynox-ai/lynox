import { randomUUID } from 'node:crypto';

import { recordSessionCost } from './session-budget.js';
import type { Engine, RunContext } from './engine.js';
import type { ModelTier, SessionCounters } from '../types/index.js';

/**
 * Minimal engine surface these helpers need. Lets a non-`Session` caller that
 * does NOT hold the full Engine (e.g. the KG extractor inside KnowledgeLayer)
 * still gate + debit through the same lifecycle. `Engine` satisfies this, so
 * existing callers pass `engine` unchanged.
 */
export type HookHost = Pick<Engine, 'getHooks' | 'getContext'>;

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

function buildRunContext(host: HookHost, runId: string, modelTier: ModelTier): RunContext {
  const context = host.getContext();
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
export async function fireBeforeRunGate(host: HookHost, modelTier: ModelTier): Promise<MeteredGateResult> {
  const runId = randomUUID();
  const runContext = buildRunContext(host, runId, modelTier);
  for (const hook of host.getHooks()) {
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
export function reportMeteredCost(host: HookHost, runId: string, costUsd: number, modelTier: ModelTier): void {
  // `> 0` (not `<= 0`) so undefined/NaN — e.g. cost derived from a malformed
  // pricing override — is a clean no-op rather than debiting NaN cents (mirrors
  // debitInRunHelperCost below).
  if (!(costUsd > 0)) return;
  const runContext = buildRunContext(host, runId, modelTier);
  for (const hook of host.getHooks()) {
    if (hook.onAfterRun) {
      try {
        hook.onAfterRun(runId, costUsd, runContext);
      } catch { /* non-fatal — billing flush retries on the next run */ }
    }
  }
}

/**
 * Account for a pool-key spend made by an IN-RUN helper on a SEPARATE
 * `beta.messages.stream` (web-search rerank, plan_task DAG planning, api_setup
 * docs extraction, retrieval HyDE). Those tokens never flow through the agent's
 * stream, so the enclosing run's own token accounting — hence both the local
 * session budget AND the managed CP debit — would otherwise miss them.
 *
 * NO gate here: the enclosing run was already admitted by its `onBeforeRun`.
 * This only makes the marginal spend VISIBLE — to the local `$max_session_cost`
 * cap (`recordSessionCost`) and to the tenant balance (`reportMeteredCost` with
 * a fresh run id; the CP dedups on it). `host` is null on self-host / BYOK, so
 * the CP debit is skipped there while the local cap still tracks the spend.
 */
export function debitInRunHelperCost(
  host: HookHost | null,
  counters: SessionCounters,
  costUsd: number,
  modelTier: ModelTier,
): void {
  // `> 0` (not `<= 0`) so undefined/NaN — a helper whose usage was unavailable —
  // is a clean no-op rather than poisoning the counter with NaN.
  if (!(costUsd > 0)) return;
  recordSessionCost(counters, costUsd);
  if (host) reportMeteredCost(host, randomUUID(), costUsd, modelTier);
}
