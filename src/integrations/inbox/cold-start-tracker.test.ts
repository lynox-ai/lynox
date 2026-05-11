import { beforeEach, describe, expect, it } from 'vitest';
import type { ColdStartProgress, ColdStartReport } from './cold-start.js';
import { ColdStartTracker } from './cold-start-tracker.js';

let clock: number;
const advance = (ms: number): number => (clock += ms);

function freshTracker(opts: { recentTtlMs?: number } = {}): ColdStartTracker {
  return new ColdStartTracker({
    now: () => clock,
    ...(opts.recentTtlMs !== undefined ? { recentTtlMs: opts.recentTtlMs } : {}),
  });
}

function progress(accountId: string, uniq: number, capped = false): ColdStartProgress {
  return { accountId, uniqueThreads: uniq, enqueued: uniq, capped, capValue: 1000 };
}

function report(accountId: string, threads: number): ColdStartReport {
  return {
    accountId,
    uniqueThreads: threads,
    enqueued: threads,
    cappedAt: null,
    rejectedByQueue: 0,
    estimatedCostUSD: threads * 0.0012,
  };
}

beforeEach(() => {
  clock = 1_700_000_000_000;
});

describe('ColdStartTracker — start + progress', () => {
  it('records a running entry when start is called', () => {
    const t = freshTracker();
    t.start('acct-1');
    const snap = t.getSnapshot();
    expect(snap.active).toHaveLength(1);
    expect(snap.active[0]).toMatchObject({
      accountId: 'acct-1',
      status: 'running',
      progress: null,
    });
    expect(snap.recent).toHaveLength(0);
  });

  it('overwrites the previous snapshot when progress fires multiple times', () => {
    const t = freshTracker();
    t.start('acct-1');
    t.progress(progress('acct-1', 3));
    advance(50);
    t.progress(progress('acct-1', 7));
    const snap = t.getSnapshot();
    expect(snap.active[0]?.progress).toMatchObject({ uniqueThreads: 7, enqueued: 7 });
  });

  it('lazy-starts when progress fires before an explicit start', () => {
    const t = freshTracker();
    t.progress(progress('acct-1', 1));
    const snap = t.getSnapshot();
    expect(snap.active).toHaveLength(1);
    expect(snap.active[0]?.progress?.uniqueThreads).toBe(1);
  });
});

describe('ColdStartTracker — complete + fail', () => {
  it('moves a running entry to recent on completion', () => {
    const t = freshTracker();
    t.start('acct-1');
    t.progress(progress('acct-1', 3));
    advance(1000);
    t.complete(report('acct-1', 3));
    const snap = t.getSnapshot();
    expect(snap.active).toHaveLength(0);
    expect(snap.recent).toHaveLength(1);
    expect(snap.recent[0]).toMatchObject({
      accountId: 'acct-1',
      status: 'completed',
      error: null,
    });
    expect(snap.recent[0]?.report?.uniqueThreads).toBe(3);
  });

  it('moves a running entry to recent on failure with the error message', () => {
    const t = freshTracker();
    t.start('acct-1');
    t.fail('acct-1', 'IMAP timeout');
    const snap = t.getSnapshot();
    expect(snap.active).toHaveLength(0);
    expect(snap.recent[0]).toMatchObject({
      accountId: 'acct-1',
      status: 'failed',
      error: 'IMAP timeout',
      report: null,
    });
  });

  it('uses now() as startedAt when complete() is called without a prior start', () => {
    const t = freshTracker();
    t.complete(report('acct-1', 1));
    const snap = t.getSnapshot();
    expect(snap.recent).toHaveLength(1);
    expect(snap.recent[0]?.startedAt).toBe(snap.recent[0]?.finishedAt);
  });

  it('uses now() as startedAt when fail() is called without a prior start', () => {
    const t = freshTracker();
    t.fail('acct-1', 'boom');
    const snap = t.getSnapshot();
    expect(snap.recent[0]?.startedAt).toBe(snap.recent[0]?.finishedAt);
  });

  it('isolates concurrent runs by accountId', () => {
    const t = freshTracker();
    t.start('acct-1');
    t.start('acct-2');
    t.progress(progress('acct-2', 5));
    t.complete(report('acct-1', 0));
    const snap = t.getSnapshot();
    expect(snap.active.map((a) => a.accountId)).toEqual(['acct-2']);
    expect(snap.recent.map((r) => r.accountId)).toEqual(['acct-1']);
  });

  it('clears a prior recent entry when the same account starts a new run', () => {
    const t = freshTracker();
    t.start('acct-1');
    t.complete(report('acct-1', 2));
    expect(t.getSnapshot().recent).toHaveLength(1);
    t.start('acct-1');
    const snap = t.getSnapshot();
    expect(snap.recent).toHaveLength(0);
    expect(snap.active).toHaveLength(1);
  });
});

describe('ColdStartTracker — recent TTL', () => {
  it('drops completed entries past the retention window', () => {
    const t = freshTracker({ recentTtlMs: 1000 });
    t.start('acct-1');
    t.complete(report('acct-1', 5));
    expect(t.getSnapshot().recent).toHaveLength(1);
    advance(1500);
    expect(t.getSnapshot().recent).toHaveLength(0);
  });

  it('keeps an entry that is still within the window', () => {
    const t = freshTracker({ recentTtlMs: 1000 });
    t.start('acct-1');
    t.complete(report('acct-1', 5));
    advance(500);
    expect(t.getSnapshot().recent).toHaveLength(1);
  });

  it('clears multiple expired entries in a single getSnapshot pass', () => {
    const tracker = freshTracker({ recentTtlMs: 1000 });
    tracker.start('a');
    tracker.complete(report('a', 1));
    advance(100);
    tracker.start('b');
    tracker.complete(report('b', 2));
    advance(100);
    tracker.start('c');
    tracker.complete(report('c', 3));
    expect(tracker.getSnapshot().recent).toHaveLength(3);
    advance(2000);
    expect(tracker.getSnapshot().recent).toHaveLength(0);
  });
});
