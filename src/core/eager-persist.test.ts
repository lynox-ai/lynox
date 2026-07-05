// T1 from /pr-review #456 (updated 2026-06-06): regression-pin for the
// eager-persist helper. The helper now appends a delta computed BY IDENTITY
// (the agent's persisted high-water-mark) instead of slicing against a disk-row
// count floor — the floor silently dropped post-compaction / post-resume
// assistant turns (data-loss in long chats). These cases pin the new contract:
// append-the-delta, no-op on empty, idempotency via onPersisted, error-swallow.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { persistAgentMessages, persistFailedTurnDisplay, persistCompactionMarker } from './eager-persist.js';
import type { ThreadStore, DisplayNoteInput } from './thread-store.js';
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
    // MAX(seq)+1 — equals the row count on these append-only fixtures (no
    // deletions), so startSeq assertions are stable.
    getNextSeq: vi.fn().mockImplementation((): number => {
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
      delta: [msg('user', 'hi')],
    });
    expect(result).toEqual({ kind: 'noop', reason: 'no-threadstore' });
  });

  it('returns noop("no-new-messages") when the delta is empty', () => {
    const store = makeMockThreadStore({ initialCount: 3 });
    const onPersisted = vi.fn();
    const result = persistAgentMessages({
      threadStore: store,
      sessionId: 's1',
      delta: [],
      onPersisted,
    });
    expect(result).toEqual({ kind: 'noop', reason: 'no-new-messages' });
    expect(store.appendMessages).not.toHaveBeenCalled();
    expect(onPersisted).not.toHaveBeenCalled();
  });

  it('appends the whole delta and advances the mark via onPersisted', () => {
    const store = makeMockThreadStore({ initialCount: 2 });
    const onPersisted = vi.fn();
    const result = persistAgentMessages({
      threadStore: store,
      sessionId: 's1',
      delta: [msg('user', 'new1'), msg('assistant', 'new2')],
      onPersisted,
    });

    expect(result).toEqual({ kind: 'appended', deltaLength: 2, newTotal: 4 });
    expect(store.appendMessages).toHaveBeenCalledTimes(1);
    expect(store.appendMessages).toHaveBeenCalledWith(
      's1',
      [msg('user', 'new1'), msg('assistant', 'new2')],
      2, // startSeq = MAX(seq)+1 = existing count
      { message_count: 4 },
    );
    expect(onPersisted).toHaveBeenCalledWith(2);
  });

  it('persists a delta even when the on-disk count is FAR LARGER than the buffer (post-compaction)', () => {
    // The bug: after compaction the agent buffer collapses to ~2 synthetic
    // messages while disk still holds the full pre-compaction history (e.g. 70
    // rows). The old count-floor slice saw buffer<floor → shrink-skip → the new
    // assistant turn was NEVER written. The identity delta persists it; the new
    // rows get seqs starting at MAX(seq)+1 so they sort after the kept history.
    const store = makeMockThreadStore({ initialCount: 70 });
    const onPersisted = vi.fn();
    const result = persistAgentMessages({
      threadStore: store,
      sessionId: 's1',
      // summary(assistant, already-marked, NOT in delta) + new user + new asst
      delta: [msg('user', 'continue please'), msg('assistant', 'here you go')],
      onPersisted,
    });
    expect(result).toEqual({ kind: 'appended', deltaLength: 2, newTotal: 72 });
    expect(store.appendMessages).toHaveBeenCalledWith(
      's1',
      [msg('user', 'continue please'), msg('assistant', 'here you go')],
      70, // startSeq = MAX(seq)+1 = sorts after the kept history
      { message_count: 72 },
    );
    expect(onPersisted).toHaveBeenCalledWith(2);
  });

  it('returns error outcome (no rethrow) when getMessageCount throws', () => {
    const store = makeMockThreadStore({ getCountThrows: true });
    const onPersisted = vi.fn();
    const result = persistAgentMessages({
      threadStore: store,
      sessionId: 's1',
      delta: [msg('user', 'hi')],
      onPersisted,
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.message).toBe('SQLite locked');
    }
    expect(store.appendMessages).not.toHaveBeenCalled();
    // Mark must NOT advance on a failed write — the turn is retried next time.
    expect(onPersisted).not.toHaveBeenCalled();
  });

  it('returns error outcome (no rethrow) when appendMessages throws — mark not advanced', () => {
    const store = makeMockThreadStore({ initialCount: 0, appendThrows: true });
    const onPersisted = vi.fn();
    const result = persistAgentMessages({
      threadStore: store,
      sessionId: 's1',
      delta: [msg('user', 'hi')],
      onPersisted,
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.message).toBe('SQLite full');
    }
    expect(onPersisted).not.toHaveBeenCalled();
  });
});

function makeFailMockStore(opts?: { hadUserMessage?: boolean; marked?: number; total?: number }) {
  const appendDisplayNotes = vi.fn();
  const updateThread = vi.fn();
  const markDisplayOnlyFrom = vi.fn().mockReturnValue({ marked: opts?.marked ?? 0, hadUserMessage: opts?.hadUserMessage ?? false });
  const getMessageCount = vi.fn().mockReturnValue(opts?.total ?? 0);
  // MAX(seq)+1 == row count on append-only fixtures.
  const getNextSeq = vi.fn().mockReturnValue(opts?.total ?? 0);
  const store = { appendDisplayNotes, updateThread, markDisplayOnlyFrom, getMessageCount, getNextSeq } as unknown as ThreadStore;
  return { store, appendDisplayNotes, updateThread, markDisplayOnlyFrom, getMessageCount, getNextSeq };
}

describe('persistFailedTurnDisplay (B-full)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns noop when threadStore is null', () => {
    const res = persistFailedTurnDisplay({ threadStore: null, sessionId: 's1', startSeq: 0, task: 'hi', error: new Error('x') });
    expect(res).toEqual({ kind: 'noop', reason: 'no-threadstore' });
  });

  it('first-response error (nothing persisted): appends BOTH user message + note', () => {
    const m = makeFailMockStore({ hadUserMessage: false, marked: 0, total: 2 });
    const res = persistFailedTurnDisplay({ threadStore: m.store, sessionId: 's1', startSeq: 2, task: 'what is the weather?', error: new Error('boom') });
    expect(res).toEqual({ kind: 'persisted', appended: 2, flipped: 0 });
    expect(m.markDisplayOnlyFrom).toHaveBeenCalledWith('s1', 2);
    const notes = m.appendDisplayNotes.mock.calls[0]![1] as DisplayNoteInput[];
    expect(notes).toHaveLength(2);
    expect(notes[0]).toEqual({ role: 'user', content: 'what is the weather?' });
    expect(notes[1]!.role).toBe('assistant');
    expect(notes[1]!.content).toMatchObject({ _lynox_note: { code: 'provider_error', detail: 'boom' } });
    expect(m.appendDisplayNotes).toHaveBeenCalledWith('s1', notes, 2); // startSeq = total
    expect(m.updateThread).toHaveBeenCalledWith('s1', { message_count: 4 });
  });

  it('eager-persisted then failed (footprint flipped): appends ONLY the note, not a duplicate user message', () => {
    const m = makeFailMockStore({ hadUserMessage: true, marked: 2, total: 4 });
    const res = persistFailedTurnDisplay({ threadStore: m.store, sessionId: 's1', startSeq: 2, task: 'q', error: new Error('rate limit') });
    expect(res).toEqual({ kind: 'persisted', appended: 1, flipped: 2 });
    const notes = m.appendDisplayNotes.mock.calls[0]![1] as DisplayNoteInput[];
    expect(notes).toHaveLength(1);
    expect(notes[0]!.role).toBe('assistant');
    expect(m.updateThread).toHaveBeenCalledWith('s1', { message_count: 5 });
  });

  it('an interruption (noteCode=run_interrupted) records a calm note with NO raw provider detail', () => {
    const m = makeFailMockStore({ hadUserMessage: true, marked: 1, total: 3 });
    persistFailedTurnDisplay({ threadStore: m.store, sessionId: 's1', startSeq: 2, task: 'q', error: new Error('Run interrupted before completion'), noteCode: 'run_interrupted' });
    const notes = m.appendDisplayNotes.mock.calls[0]![1] as DisplayNoteInput[];
    const note = notes.find(n => n.role === 'assistant')!.content as { _lynox_note: { code: string; detail?: string } };
    expect(note._lynox_note.code).toBe('run_interrupted');
    // No error detail leaks into a calm interruption note.
    expect(note._lynox_note.detail).toBeUndefined();
  });

  it('swallows thread-store errors (fire-and-forget contract)', () => {
    const store = { markDisplayOnlyFrom: vi.fn().mockImplementation(() => { throw new Error('SQLite locked'); }) } as unknown as ThreadStore;
    const res = persistFailedTurnDisplay({ threadStore: store, sessionId: 's1', startSeq: 0, task: 'q', error: new Error('x') });
    expect(res.kind).toBe('error');
  });

  it('sanitizes control chars in the note detail', () => {
    const m = makeFailMockStore({ total: 0 });
    persistFailedTurnDisplay({ threadStore: m.store, sessionId: 's1', startSeq: 0, task: 'q', error: new Error('a' + String.fromCharCode(7) + 'b') });
    const notes = m.appendDisplayNotes.mock.calls[0]![1] as DisplayNoteInput[];
    const note = notes.find(n => n.role === 'assistant')!.content as { _lynox_note: { detail: string } };
    expect(note._lynox_note.detail).toBe('a b');
  });
});

describe('persistCompactionMarker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when threadStore is null', () => {
    expect(persistCompactionMarker(null, 's1')).toBe(false);
  });

  it('appends a display-only context_compacted note after existing messages', () => {
    const m = makeFailMockStore({ total: 12 });
    const ok = persistCompactionMarker(m.store, 's1');
    expect(ok).toBe(true);
    // Appended at MAX(seq)+1 = total count, so it sorts after surviving rows.
    expect(m.appendDisplayNotes).toHaveBeenCalledWith('s1', expect.any(Array), 12);
    const notes = m.appendDisplayNotes.mock.calls[0]![1] as DisplayNoteInput[];
    const note = notes[0]!.content as { _lynox_note: { code: string } };
    expect(notes[0]!.role).toBe('assistant');
    expect(note._lynox_note.code).toBe('context_compacted');
    expect(m.updateThread).toHaveBeenCalledWith('s1', { message_count: 13 });
  });

  it('returns false (never throws) when the store errors', () => {
    const store = {
      getMessageCount: vi.fn().mockImplementation(() => { throw new Error('SQLite locked'); }),
    } as unknown as Parameters<typeof persistCompactionMarker>[0];
    expect(persistCompactionMarker(store, 's1')).toBe(false);
  });
});
