/**
 * The one-time door a mandate's hand run goes through (PRD customer-granted-operator-
 * access §3.12 point 6).
 *
 * A schedule a mandate set up or changed waits for the owner's stamp, and both dispatch
 * backstops refuse it until then. The person who set it up may still test it by hand —
 * once, at once, under their own name. That run passes the backstops on a MARKER, never
 * on a principal: anything in-process can attach a principal to a call, and a principal
 * is no evidence that a person pressed a button. A marker is.
 *
 * What makes it one:
 * - Only a request mints one. The minter is handed out exactly ONCE per door, and the HTTP
 *   layer takes it and keeps it in a private field. A second claim throws, so a caller
 *   that comes later cannot mint; one that came first leaves the HTTP door without a
 *   minter, which refuses every hand run — the closed direction.
 * - A marker is an object identity, kept in a private map. A look-alike object is not a
 *   marker; nothing is persisted, so nothing survives the process.
 * - It is bound to one trigger id and consumed by the first dispatch that checks it. A
 *   second run with the same marker is refused.
 * - It covers only a proposal whose last party is the principal it was minted for
 *   (`handRunCovers` in worker-loop.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestPrincipal } from './request-principal.js';

declare const handRunMarkerBrand: unique symbol;

/** Opaque. Its only meaning is its identity in the door that minted it. */
export interface HandRunMarker { readonly [handRunMarkerBrand]: true }

/** What the door knows about a marker it issued. */
export interface HandRunGrant {
  readonly triggerId: string;
  readonly principal: RequestPrincipal;
}

export type HandRunMinter = (triggerId: string, principal: RequestPrincipal) => HandRunMarker;

/**
 * A test run leaves the proposal as it found it. The run's result is recorded, but its
 * schedule — status, next run, retry count, the enabled switch — is not the test's to
 * write: a one-shot proposal recorded `completed` or `failed` would never fire after the
 * owner stamps it, and a refusal that disables it would switch off what was being tested.
 * The scope is the whole run, its error path included; the task manager reads it.
 *
 * Entering the scope passes no check: it only withholds schedule writes for one trigger,
 * so a caller that enters it gains nothing it could use to run anything.
 */
const handRunScope = new AsyncLocalStorage<string>();

export function runAsHandRun<T>(triggerId: string, fn: () => Promise<T>): Promise<T> {
  return handRunScope.run(triggerId, fn);
}

/** Whether the current run is a test run by hand of this trigger. */
export function isHandRunOf(triggerId: string): boolean {
  return handRunScope.getStore() === triggerId;
}

export class HandRunDoor {
  readonly #issued = new Map<object, HandRunGrant>();
  #minterClaimed = false;

  /** The minter, exactly once. A second call throws. */
  claimMinter(): HandRunMinter {
    if (this.#minterClaimed) throw new Error('The hand-run minter has already been claimed.');
    this.#minterClaimed = true;
    return (triggerId, principal) => {
      const marker = Object.freeze({}) as HandRunMarker;
      this.#issued.set(marker, Object.freeze({ triggerId, principal }));
      return marker;
    };
  }

  /** The grant of `marker` when it is live and bound to `triggerId`, without using it up. */
  peek(marker: HandRunMarker | undefined, triggerId: string): HandRunGrant | null {
    if (marker === undefined) return null;
    const grant = this.#issued.get(marker);
    return grant !== undefined && grant.triggerId === triggerId ? grant : null;
  }

  /**
   * Use the marker up. Returns its grant when it was live and bound to `triggerId`, and
   * null otherwise. A marker bound to another trigger is NOT consumed by a mismatch, but
   * it does not pass either.
   */
  consume(marker: HandRunMarker | undefined, triggerId: string): HandRunGrant | null {
    if (marker === undefined) return null;
    const grant = this.#issued.get(marker);
    if (grant === undefined || grant.triggerId !== triggerId) return null;
    this.#issued.delete(marker);
    return grant;
  }

  /** Drop a marker that will not be dispatched (the run was refused for another reason). */
  revoke(marker: HandRunMarker | undefined): void {
    if (marker !== undefined) this.#issued.delete(marker);
  }
}
