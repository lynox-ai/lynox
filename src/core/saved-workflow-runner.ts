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
/**
 * S6 tenant-isolation invariant: one container serves exactly one tenant. The
 * headless runner sources `toolContext`/`dataStore`/`memory` off the single
 * engine and keys billing off `LYNOX_MANAGED_INSTANCE_ID` (the container ==
 * the tenant), so a process that ever served a SECOND, distinct tenant would
 * silently execute one tenant's workflow with another's resources/credit. We
 * record the first tenant identity this process serves and fail closed if a
 * different one reaches the runner — a tripwire that a future per-container
 * multiplexing can't slip past silently. Stateful by design (process-scoped).
 */
let _processTenantId: string | null = null;
export function assertSingleTenantContext(tenantId: string): void {
  if (_processTenantId === null) {
    _processTenantId = tenantId;
    return;
  }
  if (_processTenantId !== tenantId) {
    throw new Error(
      `Tenant-isolation invariant violated (S6): this process is bound to tenant "${_processTenantId}" ` +
      `but a saved-workflow run was requested for tenant "${tenantId}". One container serves exactly one tenant.`,
    );
  }
}
/** Test-only: clear the recorded process tenant between cases. */
export function _resetTenantInvariantForTests(): void {
  _processTenantId = null;
}

export async function runGuardedSavedWorkflow(
  engine: Engine,
  workflowId: string,
  params?: Record<string, unknown> | undefined,
): Promise<RunSavedWorkflowResult> {
  // 1. Persistent daily/monthly cap — same gate Session.run() checks first.
  const budgetCheck = checkPersistentBudget();
  if (!budgetCheck.allowed) {
    return { ok: false, error: budgetCheck.reason ?? 'Budget exceeded.' };
  }

  const config = engine.getUserConfig();
  const context = engine.getContext();

  // S6: refuse to start if a second, distinct tenant context reaches this
  // process (fail closed rather than run the wrong tenant's workflow). Key on
  // the ENGINE CONTEXT id — that is the per-engine tenant identity (it carries
  // toolContext/dataStore/memory) and is exactly what a future per-container
  // multiplexing would vary. We deliberately do NOT key on
  // LYNOX_MANAGED_INSTANCE_ID first: it is process-global and immutable, so it
  // would read the SAME value for two multiplexed tenants and the tripwire could
  // never fire in the very mode it guards. `context.id` is always non-empty
  // post-start (resolveContext), so a normal single-tenant process records one
  // stable id and never trips; the env var / 'default' are unreachable backstops.
  const tenantId = context?.id ?? process.env['LYNOX_MANAGED_INSTANCE_ID'] ?? 'default';
  try {
    assertSingleTenantContext(tenantId);
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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

  // 3. Run the workflow. Pass the engine's tool set + tool-context + memory so
  //    inline steps can actually execute headless — the runner needs
  //    `parentTools` or it throws before running a step.
  const toolContext = engine.getToolContext();
  const result = await runSavedWorkflow(workflowId, engine.getRunHistory(), config, params, {
    tools: toolContext.tools,
    toolContext,
    memory: engine.getMemory(),
  });

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
