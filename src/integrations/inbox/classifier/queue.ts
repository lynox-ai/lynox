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
import { runOutsideGroup } from '../../../core/run-group.js';

export const DEFAULT_MAX_CONCURRENCY = 2;
export const DEFAULT_PER_JOB_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_QUEUE_DEPTH = 500;

/** Reason annotated on the AbortError when the per-job timer fires. */
export const TIMEOUT_REASON = 'classifier-timeout';

/**
 * The error a job waiting in the queue is dead-lettered with when the queue is drained for a
 * migration restore: it was never classified, and the classifier was not asked.
 */
export class DrainedForRestoreError extends Error {
  constructor() {
    super('drained-for-restore');
    this.name = 'DrainedForRestore';
  }
}

/**
 * The error a job is dead-lettered with when the process stops: either it was still waiting when
 * the shutdown's classify window ran out, or it was running when the shutdown cut it off. It was
 * not classified, and nothing classifies it later: the watcher marked the mail seen when it was
 * queued.
 */
export class DrainedForShutdownError extends Error {
  constructor() {
    super('drained-for-shutdown');
    this.name = 'DrainedForShutdown';
  }
}

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

/** Whether `work` settles before the epoch-millisecond `deadline`. */
async function settlesBy(work: Promise<void>, deadline: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // run-group-starter: a single timeout, cleared below whichever way this ends; its callback
  // only settles a local promise and reports no spend.
  const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); });
  try {
    return await Promise.race([work.then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
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
  /** Aborted by `abortRunning`: running jobs stop waiting for the classifier. */
  private readonly cutOff = new AbortController();

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
   *
   * With `deadLetterPending`, the jobs still waiting are not classified: each goes to
   * `onDeadLetter` with that error, and only the jobs already running are awaited. It also
   * applies to a queue that is already draining.
   */
  async drain(options: { deadLetterPending?: Error | undefined } = {}): Promise<void> {
    this.draining = true;
    if (options.deadLetterPending) {
      const reason = options.deadLetterPending;
      for (const job of this.pending.splice(0)) {
        await this._safeCallback('onDeadLetter', () => this.onDeadLetter(job.input, reason));
      }
      this._maybeResolveDrain();
    }
    if (this.depth === 0) return;
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  /**
   * Drain for a process that is about to be killed. Jobs are classified as usual until
   * `classifyUntil`; the jobs still waiting then are dead-lettered with `reason`, and the running
   * ones are awaited until `cutOffAt`, when they are dead-lettered with `reason` too. Both are
   * epoch milliseconds, so two queues drained one after the other share one budget. Resolves once
   * every job is classified or dead-lettered, and reports how many were dead-lettered at each step.
   */
  async drainWithin(opts: { classifyUntil: number; cutOffAt: number; reason: Error }): Promise<{ deadLetteredWaiting: number; cutOffRunning: number }> {
    const all = this.drain();
    if (await settlesBy(all, opts.classifyUntil)) return { deadLetteredWaiting: 0, cutOffRunning: 0 };
    const deadLetteredWaiting = this.pending.length;
    const running = this.drain({ deadLetterPending: opts.reason });
    if (await settlesBy(running, opts.cutOffAt)) return { deadLetteredWaiting, cutOffRunning: 0 };
    const cutOffRunning = this.active;
    this.abortRunning(opts.reason);
    await running;
    return { deadLetteredWaiting, cutOffRunning };
  }

  /**
   * Stop waiting for the jobs that are running: each is dead-lettered with `reason` at once, and
   * a classification that arrives afterwards is dropped. A job whose classification already
   * arrived finishes as classified. Only for `drainWithin`, which has emptied the waiting jobs
   * first: a job started after this would not be cut off.
   */
  private abortRunning(reason: Error): void {
    this.draining = true;
    this.cutOff.abort(reason);
  }

  private _tryStart(): void {
    while (this.active < this.maxConcurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) break;
      this.active += 1;
      // Outside any run group: a job runs in the context of whoever started this chain, not of
      // the one who enqueued it, so a chain started inside a chat run would otherwise report
      // every later mail's classification spend in that run's group (see `run-group.ts`).
      void runOutsideGroup(() => this._runJob(job)).finally(() => {
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
    const cutOff = this.cutOff.signal;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(TIMEOUT_REASON));
    }, this.perJobTimeoutMs);
    // The cut-off does not wait for the classifier to honour its signal: a provider that hangs
    // past it is exactly the case it is for.
    let onCutOff: (() => void) | undefined;
    const cut = new Promise<never>((_resolve, reject) => {
      onCutOff = () => {
        controller.abort(cutOff.reason);
        reject(asError(cutOff.reason));
      };
      // run-group-starter: removed when this attempt ends; it only ends this attempt, no spend.
      cutOff.addEventListener('abort', onCutOff, { once: true });
    });
    try {
      return await Promise.race([this.classify(job.input, { signal: controller.signal }), cut]);
    } finally {
      clearTimeout(timer);
      if (onCutOff) cutOff.removeEventListener('abort', onCutOff);
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
