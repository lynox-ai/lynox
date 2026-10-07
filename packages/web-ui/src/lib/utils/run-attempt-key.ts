/**
 * The idempotency key for one ATTEMPT at running a saved workflow
 * (PRD idempotency-bulk-first §3.3).
 *
 * Why it is persisted and not component state: `runningId` in the library view is state
 * in ONE tab, and it survives neither a reload nor a second tab — which is exactly when
 * a person clicks Run again. The key is what lets the SERVER recognise the repeat, and
 * the server is the only party that knows whether the first attempt already spent money.
 *
 * Why it lives in its own module rather than inside the component: a Svelte component
 * cannot be imported in vitest here (the root config has no svelte plugin), so logic left
 * in the component can only be witnessed by reading its source — and "the same key comes
 * back after a reload" is not a property any source grep can see.
 *
 * The lifecycle is: minted on the first call for a workflow, returned unchanged by every
 * later call, and gone only when the caller clears it after a TERMINAL answer. Deciding
 * what counts as terminal is the caller's, because only it sees the response.
 */
const RUN_KEY_PREFIX = 'lynox:workflow-run-key:';

/**
 * Whether an answer ENDS the attempt, i.e. whether its key may be discarded.
 *
 * ⚠ The rule lives here, as a function over the answer, because in the component it was a
 * `keepKey` flag set in two branches — and a refuter killed nothing with it: `let keepKey
 * = true` (never clear) and `keepKey = true` added to the other 409 both survived, because
 * the only witness was a regex asserting that a conditional clear existed in the text.
 *
 * Only an answer the ROUTE produced itself is terminal. A 5xx or a 429 from a proxy, or
 * anything else, says the request did not reach its own decision — the engine may still be
 * spending — and discarding the key there is what lets the next click pay a second time.
 * Unknown therefore means NOT over, which is the safe direction: keeping a key costs at
 * worst a 409 the client can recover from, and the route hands out `run_outcome_unknown`
 * for the state a kept key can get stuck in.
 */
export function attemptIsOver(answer: { httpStatus: number; code?: string | undefined }): boolean {
  if (answer.httpStatus === 409) {
    // The two codes that mean "your attempt is alive". Every other 409 — the outcome is
    // unknown, or the run is held in a status the route does not act on — is the end of
    // this key: no further click on it could change the answer.
    return answer.code !== 'run_claim_in_flight' && answer.code !== 'run_in_progress';
  }
  // The answers the route itself produces: the run happened (200), or it was refused
  // before any claim could be taken (400 bad body/params/key, 403 unconfirmed, 404 gone).
  return answer.httpStatus === 200 || answer.httpStatus === 400
    || answer.httpStatus === 403 || answer.httpStatus === 404;
}

function mint(): string {
  // Same fallback shape as `newQueueId` in stores/chat.svelte.ts: `crypto.randomUUID`
  // needs a secure context, and the UI is also opened over plain http on a LAN address.
  // This is a dedup key inside one single-tenant instance, not a secret — uniqueness
  // across one person's attempts is the whole requirement.
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `wk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A stable fingerprint of the run's inputs, so that an attempt is identified by what it
 * would DO and not only by which workflow it runs.
 *
 * Without it the key is per workflow: a key kept across a lost answer would be sent again
 * with DIFFERENT parameter values, the server would recognise the key, replay the earlier
 * run, and the person's new values would be silently ignored while the notice read
 * "completed". A changed input is a different operation and deserves a different key.
 *
 * Not a hash — the values are the user's own and never leave the browser. Sorted by name
 * so key order cannot make one attempt look like two.
 */
function inputFingerprint(params: Record<string, string> | undefined): string {
  if (params === undefined) return '';
  const entries = Object.keys(params).sort().map(k => `${k}=${params[k] ?? ''}`);
  return entries.length === 0 ? '' : `:${entries.join('\u0000')}`;
}

/** The current attempt's key, minting and storing one if there is none. */
export function attemptKey(workflowId: string, params?: Record<string, string>): string {
  const storageKey = RUN_KEY_PREFIX + workflowId + inputFingerprint(params);
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing !== null && existing !== '') return existing;
    const minted = mint();
    localStorage.setItem(storageKey, minted);
    return minted;
  } catch {
    // Private window, blocked site data, or no storage at all: fall back to a per-call
    // key. The run still works and still gets its server-side claim for THIS request;
    // what is lost is recognition across a reload. Refusing to run is the worse trade.
    return mint();
  }
}

/** End the attempt: the next call to {@link attemptKey} mints a new one. */
export function clearAttemptKey(workflowId: string, params?: Record<string, string>): void {
  try {
    localStorage.removeItem(RUN_KEY_PREFIX + workflowId + inputFingerprint(params));
  } catch {
    /* nothing stored, nothing to clear */
  }
}

/**
 * Drop every attempt key of a workflow, whatever its inputs were — for a workflow that no
 * longer exists. Without this a deleted workflow leaves its keys behind for good: nothing
 * else ever removes them, and no later answer can be terminal for a workflow that is gone.
 */
export function clearAllAttemptKeys(workflowId: string): void {
  const prefix = RUN_KEY_PREFIX + workflowId;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      // `=== prefix` for the no-params attempt, `prefix + ':'` for a fingerprinted one —
      // and NOT `startsWith(prefix)` alone, which would also take the keys of a workflow
      // whose id merely begins with this one's.
      if (k !== null && (k === prefix || k.startsWith(`${prefix}:`))) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    /* no storage, nothing to clear */
  }
}
