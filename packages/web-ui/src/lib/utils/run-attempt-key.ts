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

function mint(): string {
  // Same fallback shape as `newQueueId` in stores/chat.svelte.ts: `crypto.randomUUID`
  // needs a secure context, and the UI is also opened over plain http on a LAN address.
  // This is a dedup key inside one single-tenant instance, not a secret — uniqueness
  // across one person's attempts is the whole requirement.
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `wk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** The current attempt's key for `workflowId`, minting and storing one if there is none. */
export function attemptKey(workflowId: string): string {
  const storageKey = RUN_KEY_PREFIX + workflowId;
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
export function clearAttemptKey(workflowId: string): void {
  try {
    localStorage.removeItem(RUN_KEY_PREFIX + workflowId);
  } catch {
    /* nothing stored, nothing to clear */
  }
}
