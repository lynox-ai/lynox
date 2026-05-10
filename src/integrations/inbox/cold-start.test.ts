import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ColdStartPayload,
  ColdStartQueue,
  EST_COST_PER_THREAD_USD,
  estimateCost,
  runColdStart,
} from './cold-start.js';

interface TestPayload extends ColdStartPayload {
  classifierInput: { subject: string };
}

function payload(threadKey: string, accountId = 'acct-1', subject = 't'): TestPayload {
  return { threadKey, accountId, classifierInput: { subject } };
}

async function* iter<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const item of items) yield item;
}

let queue: { enqueued: TestPayload[]; obj: ColdStartQueue<TestPayload> };

beforeEach(() => {
  const enqueued: TestPayload[] = [];
  queue = {
    enqueued,
    obj: {
      enqueue: (p) => {
        enqueued.push(p);
        return true;
      },
    },
  };
});

describe('runColdStart — happy path', () => {
  it('enqueues each unique thread exactly once', async () => {
    const items = [
      payload('t1'),
      payload('t1'), // dup
      payload('t2'),
      payload('t1'), // dup
      payload('t3'),
    ];
    const report = await runColdStart({
      accountId: 'acct-1',
      fetchPayloads: () => iter(items),
      queue: queue.obj,
    });
    expect(queue.enqueued.map((p) => p.threadKey)).toEqual(['t1', 't2', 't3']);
    expect(report).toEqual({
      accountId: 'acct-1',
      uniqueThreads: 3,
      enqueued: 3,
      cappedAt: null,
      rejectedByQueue: 0,
      estimatedCostUSD: estimateCost(3),
    });
  });

  it('returns a zero report when there is nothing to backfill', async () => {
    const report = await runColdStart({
      accountId: 'acct-1',
      fetchPayloads: () => iter<TestPayload>([]),
      queue: queue.obj,
    });
    expect(report.enqueued).toBe(0);
    expect(report.uniqueThreads).toBe(0);
    expect(report.cappedAt).toBeNull();
    expect(queue.enqueued).toHaveLength(0);
  });
});

describe('runColdStart — thread cap', () => {
  it('stops at the cap and reports cappedAt + uniqueThreads = cap', async () => {
    const items = Array.from({ length: 10 }, (_, i) => payload(`t${String(i)}`));
    const report = await runColdStart({
      accountId: 'acct-1',
      fetchPayloads: () => iter(items),
      queue: queue.obj,
      threadCap: 3,
    });
    expect(report.cappedAt).toBe(3);
    expect(report.uniqueThreads).toBe(3);
    expect(report.enqueued).toBe(3);
    expect(queue.enqueued.map((p) => p.threadKey)).toEqual(['t0', 't1', 't2']);
  });

  it('falls back to the default 1000-thread cap when threadCap is omitted', async () => {
    // Verify the default actually fires by feeding 1001 unique threads and
    // confirming the report stops at 1000. Earlier the test only probed
    // estimateCost — which never exercised the cap path.
    const items = Array.from({ length: 1001 }, (_, i) => payload(`t${String(i)}`));
    const report = await runColdStart({
      accountId: 'acct-1',
      fetchPayloads: () => iter(items),
      queue: queue.obj,
    });
    expect(report.cappedAt).toBe(1000);
    expect(report.uniqueThreads).toBe(1000);
    expect(report.enqueued).toBe(1000);
  });
});

describe('runColdStart — queue backpressure', () => {
  it('counts rejected enqueues without breaking the loop', async () => {
    const slots = [true, false, true, false, true];
    let i = 0;
    const q: ColdStartQueue<TestPayload> = {
      enqueue: () => slots[i++] ?? true,
    };
    const items = [
      payload('a'),
      payload('b'),
      payload('c'),
      payload('d'),
      payload('e'),
    ];
    const report = await runColdStart({
      accountId: 'acct-1',
      fetchPayloads: () => iter(items),
      queue: q,
    });
    expect(report.uniqueThreads).toBe(5);
    expect(report.enqueued).toBe(3);
    expect(report.rejectedByQueue).toBe(2);
  });
});

describe('runColdStart — progress', () => {
  it('emits a snapshot per enqueue and a final capped snapshot', async () => {
    const onProgress = vi.fn();
    const items = [payload('a'), payload('a'), payload('b'), payload('c'), payload('d')];
    await runColdStart({
      accountId: 'acct-1',
      fetchPayloads: () => iter(items),
      queue: queue.obj,
      threadCap: 2,
      onProgress,
    });
    // Two enqueues + one capped event = 3 calls (the duplicate is not reported)
    const events = onProgress.mock.calls.map((c) => c[0]);
    expect(events.map((e) => ({ uniq: e.uniqueThreads, enq: e.enqueued, capped: e.capped }))).toEqual([
      { uniq: 1, enq: 1, capped: false },
      { uniq: 2, enq: 2, capped: false },
      { uniq: 2, enq: 2, capped: true },
    ]);
  });

  it('omits onProgress calls when no callback is provided', async () => {
    await runColdStart({
      accountId: 'acct-1',
      fetchPayloads: () => iter([payload('a')]),
      queue: queue.obj,
    });
    // Smoke test — no throw, queue still received its enqueue.
    expect(queue.enqueued).toHaveLength(1);
  });
});

describe('estimateCost', () => {
  it('multiplies thread count by the per-thread reference cost', () => {
    expect(estimateCost(0)).toBe(0);
    expect(estimateCost(1000)).toBeCloseTo(EST_COST_PER_THREAD_USD * 1000);
  });

  it('rounds to four decimal places for stable display', () => {
    // Single thread is $0.0012 — should not surface trailing FP noise.
    expect(estimateCost(1)).toBe(0.0012);
  });
});
