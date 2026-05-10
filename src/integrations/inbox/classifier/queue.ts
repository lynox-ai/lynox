// === Inbox classifier — in-process job queue ===
//
// Owns concurrency, timeouts, retry, and dead-letter for the per-mail
// classification path. The PRD specifies (`§Architecture / Concurrency`):
//
//   - max-concurrency = 2 per instance (avoids LLM-burst on 50-mail ticks)
//   - per-job timeout 30s (Haiku is sub-second; 30s is for SDK retries)
//   - explicit retry-once + dead-letter (silent swallow is forbidden)
//   - max queue depth 500 — backpressure on extreme bursts
//
// The queue is generic over the input payload so the watcher can pass
// whatever shape it needs to its onSuccess / onDeadLetter callbacks. The
// watcher hook (separate commit) wires this with the inbox repository:
// onSuccess → insertItem + appendAudit, onDeadLetter → audit-log only.

import type { ClassifyResult } from './index.js';

export const DEFAULT_MAX_CONCURRENCY = 2;
export const DEFAULT_PER_JOB_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_QUEUE_DEPTH = 500;

/** Reason annotated on the AbortError when the per-job timer fires. */
export const TIMEOUT_REASON = 'classifier-timeout';

export interface QueueClassifyFn<T> {
  (input: T, opts: { signal: AbortSignal }): Promise<ClassifyResult>;
}

export interface ClassifierQueueOptions<T> {
  /** Bound classify function — typically `(input, {signal}) => classifyMail(input, llm, {signal})`. */
  classify: QueueClassifyFn<T>;
  /** Called once per job that completed within the retry budget. */
  onSuccess: (input: T, result: ClassifyResult) => void | Promise<void>;
  /** Called once per job that failed every retry attempt. */
  onDeadLetter: (input: T, error: Error) => void | Promise<void>;
  maxConcurrency?: number | undefined;
  perJobTimeoutMs?: number | undefined;
  maxQueueDepth?: number | undefined;
  /** When true (default), each job gets one retry on a thrown attempt. */
  retryOnce?: boolean | undefined;
}

interface QueueJob<T> {
  id: string;
  input: T;
}

let _jobCounter = 0;
function nextJobId(): string {
  _jobCounter += 1;
  return `cjob_${String(Date.now())}_${String(_jobCounter)}`;
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

/**
 * Bounded async work queue. Single instance per Engine — the watcher pushes
 * jobs on every tick; cold-start pushes a backfill burst once per account.
 */
export class ClassifierQueue<T> {
  private readonly classify: QueueClassifyFn<T>;
  private readonly onSuccess: ClassifierQueueOptions<T>['onSuccess'];
  private readonly onDeadLetter: ClassifierQueueOptions<T>['onDeadLetter'];
  private readonly maxConcurrency: number;
  private readonly perJobTimeoutMs: number;
  private readonly maxQueueDepth: number;
  private readonly retryOnce: boolean;

  private readonly pending: QueueJob<T>[] = [];
  private active = 0;
  private draining = false;
  private drainResolvers: Array<() => void> = [];

  constructor(options: ClassifierQueueOptions<T>) {
    this.classify = options.classify;
    this.onSuccess = options.onSuccess;
    this.onDeadLetter = options.onDeadLetter;
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.perJobTimeoutMs = options.perJobTimeoutMs ?? DEFAULT_PER_JOB_TIMEOUT_MS;
    this.maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.retryOnce = options.retryOnce ?? true;
  }

  /**
   * Submit a job. Returns false when the queue is full (caller should drop
   * the mail back to the unclassified pool — the watcher's next tick will
   * try again) or when the queue is draining.
   */
  enqueue(input: T): boolean {
    if (this.draining) return false;
    if (this.depth >= this.maxQueueDepth) return false;
    this.pending.push({ id: nextJobId(), input });
    queueMicrotask(() => this._tryStart());
    return true;
  }

  /** Total in-flight + waiting jobs. */
  get depth(): number {
    return this.active + this.pending.length;
  }

  get activeCount(): number {
    return this.active;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * Stop accepting new work and resolve once everything in-flight settles.
   * Idempotent — calling twice returns the same promise.
   */
  drain(): Promise<void> {
    this.draining = true;
    if (this.depth === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  private _tryStart(): void {
    while (this.active < this.maxConcurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) break;
      this.active += 1;
      void this._runJob(job).finally(() => {
        this.active -= 1;
        this._maybeResolveDrain();
        this._tryStart();
      });
    }
    this._maybeResolveDrain();
  }

  private _maybeResolveDrain(): void {
    if (!this.draining || this.depth > 0) return;
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private async _runJob(job: QueueJob<T>): Promise<void> {
    const attempts = this.retryOnce ? 2 : 1;
    let lastErr: unknown = new Error('classifier-no-attempt');
    for (let i = 0; i < attempts; i++) {
      // Don't burn retry attempts on a draining queue — caller wants to exit.
      if (i > 0 && this.draining) break;
      try {
        const result = await this._attempt(job);
        await this._safeCallback('onSuccess', () => this.onSuccess(job.input, result));
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    await this._safeCallback('onDeadLetter', () => this.onDeadLetter(job.input, asError(lastErr)));
  }

  private async _attempt(job: QueueJob<T>): Promise<ClassifyResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(TIMEOUT_REASON));
    }, this.perJobTimeoutMs);
    try {
      return await this.classify(job.input, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Callback errors must not crash the queue or the host process. We catch
   * and swallow them — the caller's onSuccess/onDeadLetter are responsible
   * for their own logging. (PRD: silent swallow is forbidden ONLY for the
   * classification path — queue-internal callback failures are different.)
   */
  private async _safeCallback(label: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // Surface to stderr so the host operator sees something — never throw.
      console.error(`[ClassifierQueue] ${label} callback threw:`, err);
    }
  }
}
