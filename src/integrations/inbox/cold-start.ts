// === Inbox cold-start backfill ===
//
// Triggered the first time a `mail_account` is connected. Walks recent
// envelopes from the provider, dedupes by thread, and pushes the survivors
// onto the classifier queue. The PRD's hard cap (1000 threads/account)
// keeps a spammer-shaped account from running unbounded LLM cost.
//
// Cold-start owns:
//   - per-thread dedupe (a thread of 30 messages = one classify call)
//   - the 1000-thread cap (configurable for tests)
//   - progress reporting for the UI's cold-start banner
//   - cost-bound estimation surfaced at completion
//
// Cold-start does NOT own provider fetching — the caller passes an async
// iterable, so this module stays decoupled from IMAP / Gmail specifics.

/**
 * Per-thread cost reference based on Haiku pricing as of 2026-05.
 * Inputs ~600 tokens (system + envelope + body slice) at $1/Mtok = $0.0006;
 * outputs ~120 tokens at $5/Mtok = $0.0006. Total ≈ $0.0012/thread. Used
 * for the user-facing "≈ $X one-time" message — telemetry can refine later.
 */
export const EST_COST_PER_THREAD_USD = 0.0012;

/** PRD §Cold-Start: 1000 threads per account is the DoS-bound. */
export const DEFAULT_THREAD_CAP = 1000;

export interface ColdStartPayload {
  /** Stable per-channel thread identifier — drives dedupe. */
  threadKey: string;
  /** Account whose backfill produced this payload — surfaces in audit-log. */
  accountId: string;
  /** Pre-built classifier prompt input — opaque to cold-start. */
  classifierInput: unknown;
}

/**
 * Subset of the queue surface cold-start uses. Full ClassifierQueue<T>
 * satisfies it; tests can pass a stub.
 */
export interface ColdStartQueue<T extends ColdStartPayload> {
  enqueue(payload: T): boolean;
}

export interface ColdStartProgress {
  accountId: string;
  /** Unique threads observed so far (post-dedupe). */
  uniqueThreads: number;
  /** Threads successfully enqueued. */
  enqueued: number;
  /** True once the thread cap has been reached. Iteration stops. */
  capped: boolean;
  capValue: number;
}

export interface ColdStartReport {
  accountId: string;
  uniqueThreads: number;
  enqueued: number;
  /** The thread count at which the cap fired, or null if not capped. */
  cappedAt: number | null;
  /** Enqueue calls that the queue rejected (backpressure). */
  rejectedByQueue: number;
  estimatedCostUSD: number;
}

export interface RunColdStartOptions<T extends ColdStartPayload> {
  accountId: string;
  /** Async iterable of payloads — caller fetches from IMAP/Gmail upstream. */
  fetchPayloads: () => AsyncIterable<T>;
  queue: ColdStartQueue<T>;
  /** Override the 1000-thread cap. */
  threadCap?: number | undefined;
  /** Fires after each enqueue or cap event so the UI can stream progress. */
  onProgress?: ((snapshot: ColdStartProgress) => void) | undefined;
}

/**
 * Run a backfill pass for one account. Returns once the iterable is
 * exhausted OR the cap is hit. The classifier work itself happens
 * asynchronously inside the queue — this report describes intent, not
 * completion.
 */
export async function runColdStart<T extends ColdStartPayload>(
  opts: RunColdStartOptions<T>,
): Promise<ColdStartReport> {
  const cap = opts.threadCap ?? DEFAULT_THREAD_CAP;
  const seen = new Set<string>();
  let enqueued = 0;
  let rejectedByQueue = 0;
  let capped = false;

  for await (const payload of opts.fetchPayloads()) {
    if (seen.has(payload.threadKey)) continue;
    seen.add(payload.threadKey);

    if (seen.size > cap) {
      capped = true;
      seen.delete(payload.threadKey); // do not count the over-cap thread
      opts.onProgress?.({
        accountId: opts.accountId,
        uniqueThreads: seen.size,
        enqueued,
        capped: true,
        capValue: cap,
      });
      break;
    }

    const accepted = opts.queue.enqueue(payload);
    if (accepted) {
      enqueued += 1;
    } else {
      rejectedByQueue += 1;
    }
    opts.onProgress?.({
      accountId: opts.accountId,
      uniqueThreads: seen.size,
      enqueued,
      capped: false,
      capValue: cap,
    });
  }

  return {
    accountId: opts.accountId,
    uniqueThreads: seen.size,
    enqueued,
    cappedAt: capped ? cap : null,
    rejectedByQueue,
    estimatedCostUSD: estimateCost(enqueued),
  };
}

/** Pure helper — exposed for the UI's pre-flight cost banner. */
export function estimateCost(threadCount: number): number {
  return Number((threadCount * EST_COST_PER_THREAD_USD).toFixed(4));
}
