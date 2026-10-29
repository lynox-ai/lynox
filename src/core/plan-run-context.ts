import { AsyncLocalStorage } from 'node:async_hooks';
import { principalTag, type RequestPrincipal } from './request-principal.js';

/**
 * The mandate a running plan acts for (`planOf`), held for everything the run does: its turns,
 * the agents it spawns and the steps of the workflow it runs, which all inherit the async
 * context. Read where a decision differs between a plan that runs unattended under the owner's
 * stamp and the same mandate acting in its own session — today the one case is a connection the
 * mandate made with an account of its own, which a plan uses only when the owner's stamp lists it
 * (`planConnectionState` in profile-secret-view.ts, the one reader of the plan and its stamp).
 * The store also holds the run's key for the instance log, read by `currentPlanRun` below, which
 * compares a row's principal with `planOf` and decides nothing about connections.
 *
 * Its own store rather than a field of the worker's task context, so a reader in `core/` does
 * not have to import the worker loop.
 */
const planRunStorage = new AsyncLocalStorage<{ readonly planOf: RequestPrincipal; readonly stamp: readonly StampEntry[] | null; readonly planRun: string | undefined }>();

/**
 * One connection the owner's stamp of a plan lists: the profile, the grant it was connected
 * under, and a digest of where its tokens go (`bindingOf`). A reconnect mints a new grant and a
 * change of endpoint changes the digest, so either makes the entry stop matching.
 */
export interface StampEntry {
  readonly profile: string;
  readonly grant: string;
  readonly binding: string;
}

/**
 * Run `fn` as part of the plan that acts for `planOf`. `stamp`: the connections the owner's stamp
 * of this run's schedule lists, already checked against the stamp it was written with; null when
 * it lists none or no longer holds. `planRun`: the key of the run's own rows in the instance log
 * (the correlation id of its `plan:run` rows), which every row written within the run carries.
 */
export function runAsPlanOf<T>(planOf: RequestPrincipal, fn: () => T, stamp: readonly StampEntry[] | null = null, planRun?: string): T {
  return planRunStorage.run({ planOf, stamp, planRun }, fn);
}

/**
 * The key of the plan run this code runs in, for a row in the instance log written by `principal`;
 * undefined outside a plan's run, in one whose start was not recorded, or for a row of anyone but
 * the one the plan acts for. A row the run's code writes for someone else — the owner's erasure
 * sweep a delete starts, which records every pending erasure on the instance — is not the run's.
 * Read by `AuditLog.record` only, so a writer cannot forget it.
 */
export function currentPlanRun(principal: RequestPrincipal): string | undefined {
  const store = planRunStorage.getStore();
  return store !== undefined && principalTag(principal) === principalTag(store.planOf) ? store.planRun : undefined;
}

/** The mandate the plan this code runs in acts for; undefined outside a plan's run. */
export function currentPlanOf(): RequestPrincipal | undefined {
  return planRunStorage.getStore()?.planOf;
}

/** The connections the stamp of the plan this code runs in lists; null outside a plan's run or
 *  when the stamp lists none. */
export function currentPlanStamp(): readonly StampEntry[] | null {
  return planRunStorage.getStore()?.stamp ?? null;
}

/**
 * The run of a workflow someone other than the owner started in a chat (660b): its key in the
 * instance log, held for its steps the way a plan's run holds `planRun`. Its own store, not the
 * plan's: `runAsPlanOf` would also set `currentPlanOf`, which turns a mandate's own connections
 * to the plan's rule (`planConnectionState`), and a workflow run in a chat is the mandate's own
 * session, not a plan.
 */
const workflowRunStorage = new AsyncLocalStorage<{ readonly principal: string; readonly key: string }>();

/** Run `fn` as the workflow run of `principal` whose rows carry `key` (the correlation id of its `workflow:run` pair). */
export function runAsWorkflowRun<T>(principal: RequestPrincipal, key: string, fn: () => T): T {
  return workflowRunStorage.run({ principal: principalTag(principal), key }, fn);
}

/** The key of the workflow run this code runs in, for a row written by `principal`; undefined
 *  outside one, or for a row of anyone else. Read by `AuditLog.record` after {@link currentPlanRun}. */
export function currentWorkflowRun(principal: RequestPrincipal): string | undefined {
  const store = workflowRunStorage.getStore();
  return store !== undefined && principalTag(principal) === store.principal ? store.key : undefined;
}
