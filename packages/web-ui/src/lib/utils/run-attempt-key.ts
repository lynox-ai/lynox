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
    // ⚠ THREE codes keep the key, and the third is the one this function got wrong in a way
    // that undid the server's refusal. `run_outcome_unknown` means the claimed run STARTED
    // and its outcome was never recorded — so it may still be running and still spending.
    // The route refuses precisely for that reason. Treating it as terminal discarded the
    // key, and the next click took a fresh claim and started a second, possibly CONCURRENT,
    // paid run with nothing anywhere checking for the first.
    //
    // The distinction that was collapsed: for `run_claim_held` the earlier run is OVER (a
    // status the route does not act on), so a new attempt duplicates nothing that is still
    // alive. For `run_outcome_unknown` it may be. Those are not the same answer.
    //
    // Keeping it means the key stays at 409 until its owner deliberately releases it, which
    // the view asks about rather than deciding — see `clearAttemptKey`'s caller.
    return answer.code !== 'run_claim_in_flight'
      && answer.code !== 'run_in_progress'
      && answer.code !== 'run_outcome_unknown';
  }
  // ⚠ 400 is NOT terminal, and the first version of this function said it was, with the
  // reason "refused before any claim could be taken". That reason is refuted by a test in
  // this same repo: the route answers 400 for a run that threw AFTER it started, whose
  // claim is stamped as having spent. Discarding the key there is what lets the next click
  // pay for the whole workflow again — which is what this function exists to prevent.
  //
  // Keeping it costs nothing in the other reading: a 400 that really was a pre-run refusal
  // released the claim, so the next click re-claims the same key and runs. A 400 after a
  // paid start keeps the key, and the next click gets the disclosed restart instead of a
  // silent second charge. Keep is right for both, which is why the unknown case keeps too.
  //
  // 403 is the consent gate, which answers before any claim exists.
  //
  // ⚠ 404 is NOT terminal either, for the same reason as 400 and one the route makes
  // unavoidable: it maps a RUN failure to 404 by looking for the substring "not found" in
  // the error. So a run that started, spent, and failed with a message containing those
  // words arrives here as a 404 — indistinguishable, from the client, from "there is no
  // such workflow". The client cannot tell them apart, so it must not treat the answer as
  // proof that nothing was spent.
  //
  // What that costs: a workflow that is genuinely gone leaves one bounded storage entry
  // behind, because no later answer can ever be terminal for it. That is the same trade as
  // for 400, and it is the cheap side of the two.
  return answer.httpStatus === 200 || answer.httpStatus === 403;
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
 * ⚠ Three things the first version got wrong, all found by refutation:
 *  · it joined `name=value` pairs with a separator and did not escape them, so
 *    `{a: 'x\0b=y'}` and `{a: 'x', b: 'y'}` produced ONE key — a collision that replays
 *    the wrong run, i.e. the very defect the fingerprint was added to prevent. `JSON`
 *    does the escaping, so no value can forge a boundary.
 *  · it compared unnormalised strings, so the same umlaut typed on two keyboards (NFC vs
 *    NFD) split one attempt into two and paid twice. Normalised to NFC.
 *  · it put the values VERBATIM into the storage key's name, which is where a reader of
 *    `localStorage` would then find a client name or an IBAN, unbounded in length and
 *    removed only when the workflow is deleted. Before the fingerprint existed, storage
 *    held one UUID per workflow. A digest keeps the discrimination without the content.
 *
 * The digest is a 64-bit FNV-1a over the canonical JSON, not a cryptographic hash: it has
 * to separate one person's handful of parameter sets, not resist an adversary. A collision
 * would replay a wrong run, so the width is deliberate rather than minimal.
 */
function inputFingerprint(params: Record<string, string> | undefined): string {
  if (params === undefined) return '';
  const names = Object.keys(params).sort();
  if (names.length === 0) return '';
  const canonical = JSON.stringify(names.map(k => [k.normalize('NFC'), (params[k] ?? '').normalize('NFC')]));
  // FNV-1a, two independent 32-bit lanes with different offset bases → 64 bits of output.
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  return `:${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
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
