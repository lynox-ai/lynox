import { randomUUID } from 'node:crypto';

import type { Engine, RunContext } from './engine.js';
import { checkPersistentBudget } from './session-budget.js';
import { runSavedWorkflow, type RunSavedWorkflowResult } from '../tools/builtin/pipeline.js';

/**
 * Run a saved / scheduled workflow through the SAME budget + managed-credit
 * lifecycle that `Session.run()` applies to an interactive turn:
 *
 *   1. `checkPersistentBudget()` — the daily/monthly cap.
 *   2. `onBeforeRun` hooks — the managed credit gate (deny when a tenant's AI
 *      budget is exhausted, or fail-closed when the control plane is stale).
 *   3. the run.
 *   4. `onAfterRun` hooks — report the run's cost so it is debited from the
 *      tenant's control-plane balance.
 *
 * `runSavedWorkflow()` on its own (the Saved-Workflows "Run" button and the
 * WorkerLoop's scheduled-pipeline executor) called `runManifest()` directly and
 * therefore skipped all three: a managed tenant could run uncapped, unbilled LLM
 * spend on lynox's wallet, indefinitely, even with an exhausted budget. This
 * wrapper closes that path. The managed hook keys billing off
 * `LYNOX_MANAGED_INSTANCE_ID` (the container == the tenant), so no tenant id has
 * to be threaded through the RunContext here.
 */
export async function runGuardedSavedWorkflow(
  engine: Engine,
  workflowId: string,
  params?: Record<string, unknown>,
): Promise<RunSavedWorkflowResult> {
  // 1. Persistent daily/monthly cap — same gate Session.run() checks first.
  const budgetCheck = checkPersistentBudget();
  if (!budgetCheck.allowed) {
    return { ok: false, error: budgetCheck.reason ?? 'Budget exceeded.' };
  }

  const config = engine.getUserConfig();
  const context = engine.getContext();
  const runContext: RunContext = {
    runId: randomUUID(),
    contextId: context?.id ?? '',
    modelTier: config.default_tier ?? 'balanced',
    durationMs: 0,
    source: context?.source ?? 'cli',
  };

  // 2. onBeforeRun credit gate — a hook throwing means "blocked" (managed
  //    budget exhausted / CP fail-closed). Mirror Session.run: abort the run.
  for (const hook of engine.getHooks()) {
    if (hook.onBeforeRun) {
      try {
        await hook.onBeforeRun(runContext.runId, runContext);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Run blocked: ${reason}` };
      }
    }
  }

  // 3. Run the workflow.
  const result = await runSavedWorkflow(workflowId, engine.getRunHistory(), config, params);

  // 4. onAfterRun cost report — debit the tenant's balance for the spend.
  //    Hook errors are non-fatal (mirror Session.run). Skip zero-cost runs.
  const costUsd = result.costUsd ?? 0;
  if (costUsd > 0) {
    for (const hook of engine.getHooks()) {
      if (hook.onAfterRun) {
        try {
          hook.onAfterRun(result.runId ?? runContext.runId, costUsd, runContext);
        } catch { /* non-fatal — billing flush retries on the next run */ }
      }
    }
  }

  return result;
}
