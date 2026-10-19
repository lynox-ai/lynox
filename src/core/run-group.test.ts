import { describe, it, expect } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import {
  currentRunGroup, openPendingRunGroup, openRunGroup, runOutsideGroup, settleRunGroup,
} from './run-group.js';

describe('run group', () => {
  it('is null outside any run, and the opened id inside', () => {
    expect(currentRunGroup()).toBeNull();
    openRunGroup('g1', () => { expect(currentRunGroup()).toBe('g1'); });
    expect(currentRunGroup()).toBeNull();
  });

  it('reaches work the run starts without awaiting, after the run has returned', async () => {
    let later: Promise<string | null> | undefined;
    await openRunGroup('g1', async () => {
      later = new Promise((resolve) => setTimeout(() => resolve(currentRunGroup()), 5));
    });
    expect(currentRunGroup()).toBeNull();
    expect(await later).toBe('g1');
  });

  it('reaches a diagnostics_channel subscriber, which runs in the publisher\'s context', () => {
    const ch = channel('lynox:test:run-group');
    let seen: string | null | undefined;
    const sub = (): void => { seen = currentRunGroup(); };
    ch.subscribe(sub);
    try {
      openRunGroup('g1', () => ch.publish({}));
      expect(seen).toBe('g1');
    } finally {
      ch.unsubscribe(sub);
    }
  });

  it('a pending group takes the first id it is settled with and keeps it', () => {
    openPendingRunGroup(() => {
      expect(currentRunGroup()).toBeNull();
      expect(settleRunGroup('run-a')).toBe('run-a');
      // An internal run started from this one settles into the same group.
      expect(settleRunGroup('run-c')).toBe('run-a');
      expect(currentRunGroup()).toBe('run-a');
    });
  });

  it('settling outside any run sets nothing', () => {
    expect(settleRunGroup('run-x')).toBeNull();
    expect(currentRunGroup()).toBeNull();
  });

  it('runOutsideGroup cuts off the group for what it starts', async () => {
    let inner: Promise<string | null> | undefined;
    openRunGroup('g1', () => {
      inner = runOutsideGroup(() => new Promise((resolve) => setTimeout(() => resolve(currentRunGroup()), 1)));
    });
    expect(await inner).toBeNull();
  });
});
