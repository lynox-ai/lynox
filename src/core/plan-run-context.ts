import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestPrincipal } from './request-principal.js';

/**
 * The mandate a running plan acts for (`planOf`), held for everything the run does: its turns,
 * the agents it spawns and the steps of the workflow it runs, which all inherit the async
 * context. Read where a decision differs between a plan that runs unattended under the owner's
 * stamp and the same mandate acting in its own session — today the one case is a connection the
 * mandate made with an account of its own, which a plan does not use (`mandateMayRead`).
 *
 * Its own store rather than a field of the worker's task context, so a reader in `core/` does
 * not have to import the worker loop.
 */
const planRunStorage = new AsyncLocalStorage<{ readonly planOf: RequestPrincipal }>();

/** Run `fn` as part of the plan that acts for `planOf`. */
export function runAsPlanOf<T>(planOf: RequestPrincipal, fn: () => T): T {
  return planRunStorage.run({ planOf }, fn);
}

/** The mandate the plan this code runs in acts for; undefined outside a plan's run. */
export function currentPlanOf(): RequestPrincipal | undefined {
  return planRunStorage.getStore()?.planOf;
}
