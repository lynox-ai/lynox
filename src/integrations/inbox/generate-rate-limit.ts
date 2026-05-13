// === Per-account rate limit for /draft/generate ===
//
// Each draft-generation call costs ~$0.01-0.03 (Haiku ≈ $0.05/Mtok in,
// $0.25/Mtok out × ~5k tokens). A stolen session pegging the endpoint
// could rack up real money without bound. The global HTTP rate-limit
// caps at 200 req/hr per IP, which is too coarse for this single
// expensive route.
//
// This module enforces a sliding-window limit per account (default
// 10/min). In-memory state — restart resets the window, which is fine
// for the abuse-prevention goal. A future Redis-backed variant would
// span horizontally-scaled instances, but lynox currently runs
// single-instance per tenant.

export interface GenerateRateLimiterOptions {
  /** Sliding-window length in milliseconds. Default 60_000 (1 minute). */
  windowMs?: number;
  /** Max requests per account within the window. Default 10. */
  maxPerWindow?: number;
  /** Override the clock for tests. */
  now?: () => number;
}

export interface RateLimitResult {
  /** True when the call is allowed (and recorded). False when over the limit. */
  ok: boolean;
  /** When this account's bucket falls below the cap again, ISO timestamp. */
  retryAt?: Date;
  /** Current count inside the window (after this call if ok, else unchanged). */
  windowCount: number;
}

export class GenerateRateLimiter {
  private readonly windowMs: number;
  private readonly maxPerWindow: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, number[]>();

  constructor(opts: GenerateRateLimiterOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxPerWindow = opts.maxPerWindow ?? 10;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record + check in one call. The bucket is pruned of expired timestamps
   * on every access — no separate sweep needed. Returns `{ ok: false }`
   * when the request would exceed the cap; the timestamps array is then
   * left untouched (so retries don't compound).
   */
  check(accountId: string): RateLimitResult {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const bucket = this.buckets.get(accountId) ?? [];
    // Prune in-place — the bucket array is short, splice is cheap here.
    while (bucket.length > 0 && bucket[0]! < cutoff) bucket.shift();
    if (bucket.length >= this.maxPerWindow) {
      // Earliest timestamp in the window becomes retry-at + windowMs.
      const retryAtMs = (bucket[0] ?? now) + this.windowMs;
      return {
        ok: false,
        retryAt: new Date(retryAtMs),
        windowCount: bucket.length,
      };
    }
    bucket.push(now);
    this.buckets.set(accountId, bucket);
    return { ok: true, windowCount: bucket.length };
  }

  /** Clear all rate-limit state — useful for tests + reset on tenant change. */
  reset(): void {
    this.buckets.clear();
  }
}
