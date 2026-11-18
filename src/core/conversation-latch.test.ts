import { describe, it, expect } from 'vitest';
import { ConversationLatch, type ConversationLatchSink } from './conversation-latch.js';

/** The thread's record of outside reads: only set, read as set when it cannot be read. */

function sink(over: Partial<ConversationLatchSink> = {}): ConversationLatchSink & { armed: string[] } {
  const armed: string[] = [];
  return { armed, armReadOutside: (id) => { armed.push(id); }, readOutside: (id) => armed.includes(id), ...over };
}

describe('ConversationLatch', () => {
  it('arms its thread once, and a new object for the thread reads it back', () => {
    const s = sink();
    const latch = ConversationLatch.forThread('th', s);
    expect(latch.isSet()).toBe(false);
    latch.set();
    latch.set();
    expect(s.armed).toEqual(['th']);
    expect(ConversationLatch.forThread('th', s).isSet()).toBe(true);
    expect(ConversationLatch.forThread('other', s).isSet()).toBe(false);
  });

  it('a record that cannot be read counts as set', () => {
    const latch = ConversationLatch.forThread('th', sink({ readOutside: () => { throw new Error('locked'); } }));
    expect(latch.isSet()).toBe(true);
  });

  it('a detached record lives in memory only', () => {
    const latch = ConversationLatch.detached();
    expect(latch.isSet()).toBe(false);
    latch.set();
    expect(latch.isSet()).toBe(true);
  });
});
