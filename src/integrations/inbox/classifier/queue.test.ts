import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClassifierQueue,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PER_JOB_TIMEOUT_MS,
  TIMEOUT_REASON,
} from './queue.js';
import type { ClassifyResult } from './index.js';

const verdict = (bucket: ClassifyResult['bucket'] = 'requires_user'): ClassifyResult => ({
  bucket,
  confidence: 0.9,
  reasonDe: 'r',
  failReason: null,
  classifierVersion: 'v1',
  bodyTruncated: false,
});

/**
 * Make a controllable classify function: one promise per call, resolved by
 * the caller via the returned `release(idx, mode)` helper.
 */
function controllable() {
  const calls: Array<{
    input: unknown;
    signal: AbortSignal;
    resolve: (r: ClassifyResult) => void;
    reject: (e: Error) => void;
  }> = [];
  const classify = vi.fn(async (input: unknown, opts: { signal: AbortSignal }) => {
    return new Promise<ClassifyResult>((resolve, reject) => {
      calls.push({ input, signal: opts.signal, resolve, reject });
    });
  });
  return { classify, calls };
}

let onSuccess: ReturnType<typeof vi.fn>;
let onDeadLetter: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onSuccess = vi.fn();
  onDeadLetter = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

// Wait until a synchronous condition becomes true within `iterations` event-loop ticks.
async function waitFor(predicate: () => boolean, iterations = 50): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('waitFor: condition not met');
}

describe('ClassifierQueue — basics', () => {
  it('enqueue returns true and increases depth', () => {
    const { classify } = controllable();
    const q = new ClassifierQueue({ classify, onSuccess, onDeadLetter });
    expect(q.enqueue('a')).toBe(true);
    expect(q.enqueue('b')).toBe(true);
    expect(q.depth).toBe(2);
  });

  it('rejects enqueue when over the depth cap', () => {
    const { classify } = controllable();
    const q = new ClassifierQueue({
      classify,
      onSuccess,
      onDeadLetter,
      maxConcurrency: 1,
      maxQueueDepth: 2,
    });
    expect(q.enqueue(1)).toBe(true);
    expect(q.enqueue(2)).toBe(true);
    expect(q.enqueue(3)).toBe(false);
  });

  it('rejects enqueue once draining', async () => {
    const { classify } = controllable();
    const q = new ClassifierQueue({ classify, onSuccess, onDeadLetter });
    void q.drain();
    expect(q.enqueue('after-drain')).toBe(false);
  });

  it('uses defaults for concurrency / timeout / depth when not provided', () => {
    const { classify } = controllable();
    const q = new ClassifierQueue({ classify, onSuccess, onDeadLetter });
    // We cannot read the private fields, so probe via behavior: depth cap is
    // 500; enqueueing 500 succeeds, 501st returns false.
    for (let i = 0; i < 500; i++) {
      expect(q.enqueue(i)).toBe(true);
    }
    expect(q.enqueue(500)).toBe(false);
    // Sanity-check the exported constant the cap is built from.
    expect(DEFAULT_MAX_CONCURRENCY).toBe(2);
    expect(DEFAULT_PER_JOB_TIMEOUT_MS).toBe(30_000);
  });
});

describe('ClassifierQueue — concurrency', () => {
  it('caps concurrent classify calls at maxConcurrency', async () => {
    // Snapshot activeCount on EVERY classify entry so that a regression
    // letting 3 jobs start at once is caught even if waitFor stops at 2.
    const observedActive: number[] = [];
    let q: ClassifierQueue<string>;
    const calls: Array<{ resolve: (r: ClassifyResult) => void }> = [];
    const classify = vi.fn(async () => {
      observedActive.push(q.activeCount);
      return new Promise<ClassifyResult>((resolve) => {
        calls.push({ resolve });
      });
    });
    q = new ClassifierQueue({
      classify,
      onSuccess,
      onDeadLetter,
      maxConcurrency: 2,
    });
    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');
    // Wait for the first two to start
    await waitFor(() => calls.length === 2);
    expect(q.activeCount).toBe(2);
    // Release the first — third now starts
    calls[0]!.resolve(verdict());
    await waitFor(() => calls.length === 3);
    expect(q.activeCount).toBe(2);
    calls[1]!.resolve(verdict());
    calls[2]!.resolve(verdict());
    await waitFor(() => onSuccess.mock.calls.length === 3);
    expect(onSuccess).toHaveBeenCalledTimes(3);
    // Observed max ≤ maxConcurrency — catches a future bug where the
    // semaphore lets a 3rd job start before one of the in-flight resolves.
    expect(Math.max(...observedActive)).toBeLessThanOrEqual(2);
  });
});

describe('ClassifierQueue — retry + dead-letter', () => {
  it('retries once on a thrown attempt and reports success', async () => {
    let attempts = 0;
    const classify = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('flaky-network');
      return verdict('auto_handled');
    });
    const q = new ClassifierQueue({ classify, onSuccess, onDeadLetter });
    q.enqueue('x');
    await waitFor(() => onSuccess.mock.calls.length === 1);
    expect(attempts).toBe(2);
    expect(onSuccess).toHaveBeenCalledWith('x', expect.objectContaining({ bucket: 'auto_handled' }));
    expect(onDeadLetter).not.toHaveBeenCalled();
  });

  it('routes to dead-letter after both attempts fail', async () => {
    const err = new Error('persistent-fail');
    const classify = vi.fn(async () => {
      throw err;
    });
    const q = new ClassifierQueue({ classify, onSuccess, onDeadLetter });
    q.enqueue('x');
    await waitFor(() => onDeadLetter.mock.calls.length === 1);
    expect(classify).toHaveBeenCalledTimes(2); // first + retry
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onDeadLetter).toHaveBeenCalledWith('x', err);
  });

  it('honors retryOnce=false (single attempt)', async () => {
    const classify = vi.fn(async () => {
      throw new Error('fail');
    });
    const q = new ClassifierQueue({
      classify,
      onSuccess,
      onDeadLetter,
      retryOnce: false,
    });
    q.enqueue('x');
    await waitFor(() => onDeadLetter.mock.calls.length === 1);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('does not retry while draining', async () => {
    const { classify, calls } = controllable();
    const q = new ClassifierQueue({ classify, onSuccess, onDeadLetter });
    q.enqueue('x');
    // Wait for the first attempt to start so drain happens mid-flight
    await waitFor(() => calls.length === 1);
    // Drain BEFORE the first attempt resolves
    void q.drain();
    // Now reject — retry must be skipped because the queue is draining
    calls[0]!.reject(new Error('boom'));
    await waitFor(() => onDeadLetter.mock.calls.length === 1);
    expect(classify).toHaveBeenCalledTimes(1);
  });
});

describe('ClassifierQueue — timeout', () => {
  it('aborts the in-flight attempt when the per-job timeout elapses', async () => {
    vi.useFakeTimers();
    const aborted: boolean[] = [];
    const classify = vi.fn(async (_: unknown, opts: { signal: AbortSignal }) => {
      // Resolve only on abort — model the SDK's signal-aware behavior.
      return new Promise<ClassifyResult>((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          aborted.push(opts.signal.aborted);
          reject(new Error('aborted'));
        });
      });
    });
    const q = new ClassifierQueue({
      classify,
      onSuccess,
      onDeadLetter,
      perJobTimeoutMs: 100,
      retryOnce: false,
    });
    q.enqueue('x');
    // Fire the timer; the signal aborts, the attempt rejects, dead-letter fires.
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();
    expect(aborted).toEqual([true]);
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    const [, err] = onDeadLetter.mock.calls[0]!;
    expect((err as Error).message).toBe('aborted');
  });

  it('exports the timeout reason constant for downstream audit-log enrichment', () => {
    expect(TIMEOUT_REASON).toBe('classifier-timeout');
  });
});

describe('ClassifierQueue — drain', () => {
  it('resolves immediately when the queue is empty', async () => {
    const { classify } = controllable();
    const q = new ClassifierQueue({ classify, onSuccess, onDeadLetter });
    await q.drain(); // would hang if not idempotent on empty
  });

  it('waits for in-flight + pending jobs to settle', async () => {
    const { classify, calls } = controllable();
    const q = new ClassifierQueue({
      classify,
      onSuccess,
      onDeadLetter,
      maxConcurrency: 1,
    });
    q.enqueue('a');
    q.enqueue('b');
    await waitFor(() => calls.length === 1);

    let drained = false;
    const drainPromise = q.drain().then(() => {
      drained = true;
    });
    expect(drained).toBe(false);

    calls[0]!.resolve(verdict());
    await waitFor(() => calls.length === 2);
    expect(drained).toBe(false);

    calls[1]!.resolve(verdict());
    await drainPromise;
    expect(drained).toBe(true);
  });

  it('does not throw when callbacks throw — host process stays alive', async () => {
    const classify = vi.fn(async () => verdict());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwingSuccess = vi.fn(() => {
      throw new Error('callback boom');
    });
    const q = new ClassifierQueue({
      classify,
      onSuccess: throwingSuccess,
      onDeadLetter,
    });
    q.enqueue('x');
    await waitFor(() => throwingSuccess.mock.calls.length === 1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
