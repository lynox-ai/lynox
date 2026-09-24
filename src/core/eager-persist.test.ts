// T1 from /pr-review #456 (updated 2026-06-06): regression-pin for the
// eager-persist helper. The helper now appends a delta computed BY IDENTITY
// (the agent's persisted high-water-mark) instead of slicing against a disk-row
// count floor — the floor silently dropped post-compaction / post-resume
// assistant turns (data-loss in long chats). These cases pin the new contract:
// append-the-delta, no-op on empty, idempotency via onPersisted, error-swallow.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { persistAgentMessages, persistFailedTurnDisplay, persistCompactionMarker , capStopNote } from './eager-persist.js';
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

  it('a continuation loop (continuation_loop) names the repeated truncated prefix', () => {
    const m = makeFailMockStore({ hadUserMessage: true, marked: 1, total: 3 });
    const err = Object.assign(new Error('Run stopped: truncated continuations repeated'), {
      loopPrefix: 'Ich speichere die CSV-Datei und analysiere sie strukturiert mit Python.',
    });
    persistFailedTurnDisplay({ threadStore: m.store, sessionId: 's1', startSeq: 2, task: 'q', error: err, noteCode: 'continuation_loop' });
    const notes = m.appendDisplayNotes.mock.calls[0]![1] as DisplayNoteInput[];
    const note = notes.find(n => n.role === 'assistant')!.content as { _lynox_note: { code: string; detail?: string } };
    expect(note._lynox_note.code).toBe('continuation_loop');
    expect(note._lynox_note.detail).toContain('repeated truncated response');
    expect(note._lynox_note.detail).toContain('Ich speichere die CSV-Datei');
  });

  it('a hard loop break (tool_loop_break) names the repeated call in the note detail', () => {
    const m = makeFailMockStore({ hadUserMessage: true, marked: 1, total: 3 });
    // ToolLoopBreakError shape, duck-typed (loopKey carries `tool\x00input`) so
    // this module test needs no agent import.
    const loopErr = Object.assign(new Error('Run stopped: repeated tool call'), {
      loopKey: 'api_setup\x00{"action":"view","id":"zai"}',
    });
    persistFailedTurnDisplay({ threadStore: m.store, sessionId: 's1', startSeq: 2, task: 'q', error: loopErr, noteCode: 'tool_loop_break' });
    const notes = m.appendDisplayNotes.mock.calls[0]![1] as DisplayNoteInput[];
    const note = notes.find(n => n.role === 'assistant')!.content as { _lynox_note: { code: string; detail?: string } };
    expect(note._lynox_note.code).toBe('tool_loop_break');
    expect(note._lynox_note.detail).toContain('api_setup');
    expect(note._lynox_note.detail).toContain('view');
  });

  it('a failed INTERNAL (compaction) run flips its footprint but appends NO visible note', () => {
    // The task here is the internal compaction prompt — synthesizing it as a
    // user note would leak a system prompt into the user's thread. hadUserMessage
    // is false (nothing eager-persisted), which on the normal path WOULD push a
    // user note from `task`; the internal flag must suppress that entirely.
    const m = makeFailMockStore({ hadUserMessage: false, marked: 3, total: 5 });
    const res = persistFailedTurnDisplay({
      threadStore: m.store,
      sessionId: 's1',
      startSeq: 2,
      task: 'Summarize the conversation so far so work can continue…',
      error: new Error('Run interrupted before completion'),
      noteCode: 'run_interrupted',
      internal: true,
    });
    // Footprint still neutralized from the model context, but zero notes appended.
    expect(m.markDisplayOnlyFrom).toHaveBeenCalledWith('s1', 2);
    expect(res).toEqual({ kind: 'persisted', appended: 0, flipped: 3 });
    expect(m.appendDisplayNotes).not.toHaveBeenCalled();
    expect(m.updateThread).not.toHaveBeenCalled();
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

/**
 * The cap-stop banner decision.
 *
 * Extracted from Session for the same reason everything else in this file was:
 * the branch that decides whether the user is told lives one call away from a
 * run loop nothing can drive in a unit test, and it went unwritten for as long
 * as it was in there. The incident it exists for is a prod export where a cap
 * stopped twenty identical turns and the explanation reached the run record and
 * nothing else.
 */
describe('capStopNote', () => {
  const stop = (cause: string, tools: string[], count = tools.length) =>
    ({ cause, pendingTools: tools, pendingToolCount: count });

  it('names the turn limit when tool calls were still pending', () => {
    expect(capStopNote(stop('iteration_cap', ['data_store_query']), { isInternalRun: false }))
      .toEqual({ code: 'turn_limit', detail: 'still calling: data_store_query' });
  });

  it('names the cost budget as its own banner, not as a turn limit', () => {
    // Two different things happened to the user's turn and two different things
    // fix it — one is "work in smaller steps", the other is "raise the budget".
    expect(capStopNote(stop('budget_cap', ['bash']), { isInternalRun: false })?.code)
      .toBe('cost_budget');
  });

  it('lists every pending tool, so the banner names what was cut off', () => {
    expect(capStopNote(stop('iteration_cap', ['a', 'b']), { isInternalRun: false })?.detail)
      .toBe('still calling: a, b');
  });

  it('says nothing when the cap landed on a finished answer', () => {
    // `_finishOnCap` returns the bare text in this case and calls it a normal
    // end of turn. A banner here would train the reader to ignore banners.
    expect(capStopNote(stop('iteration_cap', [], 0), { isInternalRun: false })).toBeNull();
  });

  it('says nothing for an ordinary end of turn', () => {
    expect(capStopNote(stop('end_turn', [], 0), { isInternalRun: false })).toBeNull();
    expect(capStopNote(stop('max_tokens', [], 0), { isInternalRun: false })).toBeNull();
  });

  it('says nothing for a cause it does not know', () => {
    // Fail closed: a new stop cause must not inherit a banner whose text was
    // written for a different one.
    expect(capStopNote(stop('absolute_cap', ['x']), { isInternalRun: false })).toBeNull();
  });

  it('stays silent on an internal run', () => {
    // Same reason the failure path is silent: a compaction run's footprint is
    // neutralized, and a banner would surface machinery nobody asked for.
    expect(capStopNote(stop('iteration_cap', ['x']), { isInternalRun: true })).toBeNull();
  });

  it('says nothing when there was no stop to report', () => {
    expect(capStopNote(null, { isInternalRun: false })).toBeNull();
  });

  it('carries a detail-less banner when the names were all rejected upstream', () => {
    // pendingToolCount > 0 with an empty name list is what `safeToolNames`
    // produces when every name failed its charset gate — the banner still owes
    // the user the fact that something was cut off.
    const note = capStopNote(stop('iteration_cap', [], 3), { isInternalRun: false });
    expect(note?.code).toBe('turn_limit');
    expect(note?.detail).toBeUndefined();
  });

  it('caps the detail, because the banner is the only thing holding it back', () => {
    // `buildDisplayNoteContent` passes `detail` through untouched, so the only
    // place a length limit can live is here. A turn stopped mid-flight can hold
    // a dozen pending calls with long names; unbounded, that renders as a wall
    // of tool names where a one-line note was promised.
    const many = Array.from({ length: 40 }, (_, i) => `a_very_long_tool_name_number_${i}`);
    const detail = capStopNote(stop('iteration_cap', many), { isInternalRun: false })?.detail;
    expect(detail, 'unbounded detail reached the banner').toBeDefined();
    expect((detail as string).length).toBeLessThanOrEqual(300);
    // The cap must TRUNCATE, not empty it — a guard that returns '' would also
    // satisfy the length bound while destroying the information.
    expect(detail).toMatch(/^still calling: a_very_long_tool_name_number_0, /);
  });
});
