/**
 * Per-user rate limiter with sliding window and concurrency tracking.
 * Used by Telegram and Slack bot entry points to prevent abuse.
 */

export interface RateLimiterConfig {
  /** Maximum concurrent runs per user. Default: 2 */
  maxConcurrent?: number | undefined;
  /** Maximum requests per hour per user. Default: 30 */
  maxPerHour?: number | undefined;
}

export interface AcquireResult {
  allowed: boolean;
  reason?: string | undefined;
}

interface UserState {
  timestamps: number[];
  concurrent: number;
}

export class RateLimiter {
  private readonly maxConcurrent: number;
  private readonly maxPerHour: number;
  private readonly users = new Map<string, UserState>();

  constructor(config?: RateLimiterConfig) {
    this.maxConcurrent = config?.maxConcurrent ?? 2;
    this.maxPerHour = config?.maxPerHour ?? 30;
  }

  /**
   * Try to acquire a rate limit slot for the given user.
   * If allowed, records the request and increments concurrent count.
   * Caller MUST call `release(userId)` when the run completes.
   */
  acquire(userId: string): AcquireResult {
    const now = Date.now();
    const state = this.getOrCreate(userId);

    // Prune timestamps older than 1 hour
    const cutoff = now - 3_600_000;
    state.timestamps = state.timestamps.filter(t => t > cutoff);

    // Check concurrent limit
    if (state.concurrent >= this.maxConcurrent) {
      return {
        allowed: false,
        reason: `Rate limit: max ${this.maxConcurrent} concurrent ${this.maxConcurrent === 1 ? 'run' : 'runs'}. Please wait for the current task to finish.`,
      };
    }

    // Check hourly limit
    if (state.timestamps.length >= this.maxPerHour) {
      return {
        allowed: false,
        reason: `Rate limit: max ${this.maxPerHour} requests per hour reached. Please try again later.`,
      };
    }

    // Allowed — record
    state.timestamps.push(now);
    state.concurrent++;
    return { allowed: true };
  }

  /** Release a concurrent slot after a run completes. */
  release(userId: string): void {
    const state = this.users.get(userId);
    if (state && state.concurrent > 0) {
      state.concurrent--;
    }
  }

  /** Reset all state (for testing). */
  reset(): void {
    this.users.clear();
  }

  private getOrCreate(userId: string): UserState {
    let state = this.users.get(userId);
    if (!state) {
      state = { timestamps: [], concurrent: 0 };
      this.users.set(userId, state);
    }
    return state;
  }
}

/**
 * Create a RateLimiter from environment variables.
 * LYNOX_RATE_LIMIT_CONCURRENT and LYNOX_RATE_LIMIT_PER_HOUR override defaults.
 */
export function createRateLimiterFromEnv(): RateLimiter {
  const concurrent = parseInt(process.env['LYNOX_RATE_LIMIT_CONCURRENT'] ?? '', 10);
  const perHour = parseInt(process.env['LYNOX_RATE_LIMIT_PER_HOUR'] ?? '', 10);
  return new RateLimiter({
    maxConcurrent: Number.isFinite(concurrent) && concurrent > 0 ? concurrent : undefined,
    maxPerHour: Number.isFinite(perHour) && perHour > 0 ? perHour : undefined,
  });
}
