import { describe, it, expect, vi } from 'vitest';
import { ConversationLatch, type ConversationLatchSink } from './conversation-latch.js';

/** The thread's record of outside reads: only set, read as set when it cannot be read. */

function sink(over: Partial<ConversationLatchSink> = {}): ConversationLatchSink & { marked: string[] } {
  const marked: string[] = [];
  return { marked, markReadOutside: (id) => { marked.push(id); }, readOutside: (id) => marked.includes(id), ...over };
}

describe('ConversationLatch', () => {
  it('writes through once, and a new object for the thread reads it back', () => {
    const s = sink();
    const latch = ConversationLatch.forThread('th', s);
    expect(latch.isSet()).toBe(false);
    latch.set();
    latch.set();
    expect(s.marked).toEqual(['th']);
    expect(ConversationLatch.forThread('th', s).isSet()).toBe(true);
    expect(ConversationLatch.forThread('other', s).isSet()).toBe(false);
  });

  it('a record that cannot be read counts as set', () => {
    const latch = ConversationLatch.forThread('th', sink({ readOutside: () => { throw new Error('locked'); } }));
    expect(latch.isSet()).toBe(true);
  });

  it('a write that fails is kept in memory for this conversation', () => {
    const markReadOutside = vi.fn(() => { throw new Error('disk full'); });
    const latch = ConversationLatch.forThread('th', sink({ markReadOutside, readOutside: () => false }));
    latch.set();
    expect(markReadOutside).toHaveBeenCalledTimes(1);
    expect(latch.isSet()).toBe(true);
  });

  it('a detached record lives in memory only', () => {
    const latch = ConversationLatch.detached();
    expect(latch.isSet()).toBe(false);
    latch.set();
    expect(latch.isSet()).toBe(true);
  });
});
