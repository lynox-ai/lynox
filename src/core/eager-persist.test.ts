// T1 from /pr-review #456: regression-pin for the eager-persist helper.
// Walks the four contract cases the helper has to honour so any future
// refactor of `_persistMessages` keeps the idempotency + shrink-handling
// guarantees intact.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { persistAgentMessages } from './eager-persist.js';
import type { ThreadStore } from './thread-store.js';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

function makeMockThreadStore(opts?: {
  initialCount?: number;
  getCountThrows?: boolean;
  appendThrows?: boolean;
}): ThreadStore {
  let count = opts?.initialCount ?? 0;
  return {
    getMessageCount: vi.fn().mockImplementation((): number => {
      if (opts?.getCountThrows) throw new Error('SQLite locked');
      return count;
    }),
    // No display-only rows in these fixtures, so the API count tracks the
    // total count exactly — mirrors the production invariant that the two
    // diverge only after a failed turn has persisted a display note.
    getApiMessageCount: vi.fn().mockImplementation((): number => {
      if (opts?.getCountThrows) throw new Error('SQLite locked');
      return count;
    }),
    appendMessages: vi.fn().mockImplementation((_tid: string, msgs: BetaMessageParam[], _start: number, updates?: { message_count?: number }) => {
      if (opts?.appendThrows) throw new Error('SQLite full');
      count += msgs.length;
      if (updates?.message_count !== undefined) count = updates.message_count;
    }),
  } as unknown as ThreadStore;
}

function msg(role: 'user' | 'assistant', text: string): BetaMessageParam {
  return { role, content: text };
}

describe('persistAgentMessages', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns noop("no-threadstore") when threadStore is null', () => {
    const result = persistAgentMessages({
      threadStore: null,
      sessionId: 's1',
      allMessages: [msg('user', 'hi')],
    });
    expect(result).toEqual({ kind: 'noop', reason: 'no-threadstore' });
  });

  it('returns noop("no-new-messages") when in-memory buffer == SQLite floor', () => {
    const store = makeMockThreadStore({ initialCount: 3 });
    const result = persistAgentMessages({
      threadStore: store,
      sessionId: 's1',
      allMessages: [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')],
    });
    expect(result).toEqual({ kind: 'noop', reason: 'no-new-messages' });
    expect(store.appendMessages).not.toHaveBeenCalled();
  });

  it('returns noop when in-memory buffer is empty and floor is 0', () => {
    const store = makeMockThreadStore({ initialCount: 0 });
    const result = persistAgentMessages({
      threadStore: store,
      sessionId: 's1',
      allMessages: [],
    });
    expect(result.kind).toBe('noop');
    expect(store.appendMessages).not.toHaveBeenCalled();
  });

  it('appends only the delta when in-memory buffer is larger than floor', () => {
    const store = makeMockThreadStore({ initialCount: 2 });
    const allMessages = [
      msg('user', 'old1'),
      msg('assistant', 'old2'),
      msg('user', 'new1'),
      msg('assistant', 'new2'),
    ];
    const result = persistAgentMessages({
      threadStore: store,
      sessionId: 's1',
      allMessages,
    });

    expect(result).toEqual({ kind: 'appended', deltaLength: 2, newTotal: 4 });
    expect(store.appendMessages).toHaveBeenCalledTimes(1);
    expect(store.appendMessages).toHaveBeenCalledWith(
      's1',
      [msg('user', 'new1'), msg('assistant', 'new2')],
      2, // startSeq = existingCount = 2
      { message_count: 4 },
    );
  });

  it('skips with warn when in-memory buffer is shorter than persisted floor (shrink case)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeMockThreadStore({ initialCount: 10 });
    const result = persistAgentMessages({
      threadStore: store,
      sessionId: 's1',
      allMessages: [msg('user', 'only_recent_5')],
    });

    expect(result).toEqual({ kind: 'shrink-skip', bufferLength: 1, floorLength: 10 });
    expect(store.appendMessages).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('shorter than persisted API floor');
    expect(warnSpy.mock.calls[0]![0]).toContain('s1');
  });

  it('returns error outcome (no rethrow) when getMessageCount throws', () => {
    const store = makeMockThreadStore({ getCountThrows: true });
    const result = persistAgentMessages({
      threadStore: store,
      sessionId: 's1',
      allMessages: [msg('user', 'hi')],
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.message).toBe('SQLite locked');
    }
    expect(store.appendMessages).not.toHaveBeenCalled();
  });

  it('returns error outcome (no rethrow) when appendMessages throws', () => {
    const store = makeMockThreadStore({ initialCount: 0, appendThrows: true });
    const result = persistAgentMessages({
      threadStore: store,
      sessionId: 's1',
      allMessages: [msg('user', 'hi')],
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.message).toBe('SQLite full');
    }
  });

  it('is idempotent — second call after the first sees no-new-messages', () => {
    const store = makeMockThreadStore({ initialCount: 1 });
    const allMessages = [msg('user', 'a'), msg('assistant', 'b')];

    const first = persistAgentMessages({ threadStore: store, sessionId: 's1', allMessages });
    expect(first.kind).toBe('appended');
    expect(store.appendMessages).toHaveBeenCalledTimes(1);

    // Second call with the same buffer — floor has advanced via the mock's
    // append callback, so the delta is now empty.
    const second = persistAgentMessages({ threadStore: store, sessionId: 's1', allMessages });
    expect(second).toEqual({ kind: 'noop', reason: 'no-new-messages' });
    expect(store.appendMessages).toHaveBeenCalledTimes(1);
  });
});
