import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestPrincipal } from './request-principal.js';

/**
 * The mandate a running plan acts for (`planOf`), held for everything the run does: its turns,
 * the agents it spawns and the steps of the workflow it runs, which all inherit the async
 * context. Read where a decision differs between a plan that runs unattended under the owner's
 * stamp and the same mandate acting in its own session — today the one case is a connection the
 * mandate made with an account of its own, which a plan uses only when the owner's stamp lists it
 * (`planConnectionState` in profile-secret-view.ts, the one reader of this store).
 *
 * Its own store rather than a field of the worker's task context, so a reader in `core/` does
 * not have to import the worker loop.
 */
const planRunStorage = new AsyncLocalStorage<{ readonly planOf: RequestPrincipal; readonly stamp: readonly StampEntry[] | null }>();

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
 * it lists none or no longer holds.
 */
export function runAsPlanOf<T>(planOf: RequestPrincipal, fn: () => T, stamp: readonly StampEntry[] | null = null): T {
  return planRunStorage.run({ planOf, stamp }, fn);
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
