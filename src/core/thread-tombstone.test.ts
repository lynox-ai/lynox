import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunHistory } from './run-history.js';
import { PromptStore } from './prompt-store.js';
import { principalFromTag } from './request-principal.js';
import { ThreadStore, ThreadDeletedError } from './thread-store.js';
import { escalateToUser } from './escalation.js';
import type { NotificationRouter, NotifyReport } from './notification-router.js';
import { WorkflowQuestions } from './workflow-questions.js';

/**
 * A deleted conversation stays deleted. `createThread` was INSERT OR IGNORE, so every writer
 * still holding a deleted id re-created an empty thread under it and went on writing. The
 * refusal sits in the store, and each writer that can meet a deleted id is checked here on a
 * real history database: the escalation, a workflow run's question, and a session.
 */
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  vi.restoreAllMocks();
});

function freshHistory(): { history: RunHistory; threads: ThreadStore } {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-tomb-'));
  const history = new RunHistory(join(dir, 'history.db'));
  cleanups.push(() => { try { history.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  return { history, threads: new ThreadStore(history.getDb()) };
}

describe('ThreadStore: a deleted thread is not opened again', () => {
  it('refuses the id of a deleted thread and creates no row', () => {
    const { threads } = freshHistory();
    threads.createThread('t-1', { title: 'mine' });
    threads.deleteThread('t-1');

    expect(threads.isDeleted('t-1')).toBe(true);
    expect(() => threads.createThread('t-1', { title: 'again' })).toThrow(ThreadDeletedError);
    expect(threads.getThread('t-1'), 'no row came back').toBeUndefined();
  });

  it('leaves every other id alone: a new one is created, a live one resumes', () => {
    const { threads } = freshHistory();
    threads.createThread('live', { title: 'kept' });
    threads.createThread('gone');
    threads.deleteThread('gone');

    expect(threads.isDeleted('live')).toBe(false);
    threads.createThread('live', { title: 'not re-stamped' });
    expect(threads.getThread('live')?.title, 'a resume is still a no-op').toBe('kept');
    threads.createThread('fresh', { title: 'new' });
    expect(threads.getThread('fresh')?.title).toBe('new');
  });

  it('a message for the deleted id has no row to land in', () => {
    // The refusal is enough on its own because `thread_messages` references `threads`: a writer
    // that kept the id cannot append once the row is gone and cannot be re-created.
    const { threads } = freshHistory();
    threads.createThread('t-2');
    threads.deleteThread('t-2');
    expect(() => threads.appendMessages('t-2', [{ role: 'user', content: 'hello' }], 0)).toThrow();
    expect(threads.getMessages('t-2')).toEqual([]);
  });
});

describe('an escalation after its thread was deleted', () => {
  function router(): { router: NotificationRouter; data: Array<Record<string, string> | undefined> } {
    const data: Array<Record<string, string> | undefined> = [];
    const notify = vi.fn(async (msg: { data?: Record<string, string> }): Promise<NotifyReport> => { data.push(msg.data); return []; });
    return { router: { notify } as unknown as NotificationRouter, data };
  }

  it('opens a new thread instead of reviving the deleted one, and points the push at it', () => {
    const { threads } = freshHistory();
    const r = router();
    expect(escalateToUser(threads, r.router, { key: 'abc123', title: 'Watcher', body: 'first change' })).toEqual({ threadId: 'escalation-abc123' });
    threads.deleteThread('escalation-abc123');

    const second = escalateToUser(threads, r.router, { key: 'abc123', title: 'Watcher', body: 'second change' });

    expect(second).toEqual({ threadId: 'escalation-abc123-2' });
    expect(threads.getThread('escalation-abc123'), 'the deleted thread stays deleted').toBeUndefined();
    const msgs = threads.getMessages('escalation-abc123-2', { apiOnly: true });
    expect(msgs.map((m) => m.role), 'a valid conversation of its own').toEqual(['user', 'assistant']);
    expect(msgs[1]!.content_json).toContain('second change');
    expect(r.data.at(-1)?.['threadId']).toBe('escalation-abc123-2');
  });

  it('keeps bumping the new thread, and moves on again when that one is deleted', () => {
    const { threads } = freshHistory();
    const r = router();
    escalateToUser(threads, r.router, { key: 'k9', title: 'Job', body: 'one' });
    threads.deleteThread('escalation-k9');
    escalateToUser(threads, r.router, { key: 'k9', title: 'Job', body: 'two' });
    expect(escalateToUser(threads, r.router, { key: 'k9', title: 'Job', body: 'three' }), 'one thread per key while it lives').toEqual({ threadId: 'escalation-k9-2' });
    threads.deleteThread('escalation-k9-2');
    expect(escalateToUser(threads, r.router, { key: 'k9', title: 'Job', body: 'four' })).toEqual({ threadId: 'escalation-k9-3' });
    expect(threads.getThread('escalation-k9-2')).toBeUndefined();
  });
});

describe('a workflow run whose thread was deleted while it ran', () => {
  const RUN_ID = '21111111-2222-4333-8444-555555555555';

  function channel(history: RunHistory, threads: ThreadStore, prompts: PromptStore, notified: unknown[], scopeMember?: { abort: () => void }): WorkflowQuestions {
    return new WorkflowQuestions({
      runId: RUN_ID,
      scheduleId: 'trg-wf',
      title: 'Weekly offer',
      principal: principalFromTag('owner'),
      handRun: false,
      promptStore: () => prompts,
      threadStore: () => threads,
      maskOffBox: (text) => text,
      notify: async (msg): Promise<NotifyReport> => { notified.push(msg); return [{ channel: 'push', outcome: 'delivered' }]; },
      recordDelivery: () => () => {},
      ownerStop: new AbortController().signal,
      teardown: new AbortController().signal,
      tearingDown: () => false,
      abortScope: { members: new Set(scopeMember ? [scopeMember] : []) },
      onPending: () => {},
    });
  }

  it('deleting the thread withdraws the question it waits on, and the run ends with that reason', async () => {
    // The thread was the only place the owner could answer it. Without the withdrawal the run
    // waited out the TTL and ended as "expired".
    const { history, threads } = freshHistory();
    const prompts = new PromptStore(history.getDb());
    const member = { abort: vi.fn() };
    const q = channel(history, threads, prompts, [], member);
    const answer = q.ask('Which list, A or B?', ['A', 'B']);
    await vi.waitFor(() => { expect(prompts.getPending(RUN_ID)).toBeDefined(); });
    const id = prompts.getPending(RUN_ID)!.id;

    threads.deleteThread(RUN_ID);
    expect(prompts.withdrawForDeletedThread(RUN_ID)).toBe(1);

    await expect(answer).resolves.toBe('__dismissed__');
    expect(q.unansweredBecause).toBe('thread_deleted');
    expect(member.abort, 'no later step runs').toHaveBeenCalled();
    expect(prompts.getById(id)).toMatchObject({ status: 'expired', closed_reason: 'thread_deleted' });
  });

  it('withdraws only the deleted thread\'s live questions', () => {
    const { history } = freshHistory();
    const prompts = new PromptStore(history.getDb());
    const mine = prompts.insertAskUser('gone-thread', 'In the deleted chat?');
    const elsewhere = prompts.insertAskUser('other-thread', 'In another chat of the same owner?');
    // A parked question belongs to its trigger's wait, which ends on its own deadline.
    const parked = prompts.insertAskUser('parked-thread', 'Parked on a trigger?', undefined, undefined, undefined, undefined, 'trg-1');

    expect(prompts.withdrawForDeletedThread('gone-thread')).toBe(1);
    expect(prompts.withdrawForDeletedThread('parked-thread')).toBe(0);

    expect(prompts.getById(mine)).toMatchObject({ status: 'expired', closed_reason: 'thread_deleted' });
    expect(prompts.getById(elsewhere)).toMatchObject({ status: 'pending', closed_reason: null });
    expect(prompts.getById(parked)).toMatchObject({ status: 'pending', closed_reason: null });
  });

  it('a question asked after the thread was deleted ends the run with that reason, and re-creates nothing', async () => {
    // Deleting the thread withdrew what was waiting then. A question the run asks afterwards had
    // nowhere to be answered and waited out its TTL; now it ends the run the same way at once.
    const { history, threads } = freshHistory();
    const prompts = new PromptStore(history.getDb());
    const notified: unknown[] = [];
    const member = { abort: vi.fn() };
    threads.createThread(RUN_ID, { title: 'Weekly offer' });
    threads.deleteThread(RUN_ID);
    const q = channel(history, threads, prompts, notified, member);

    await expect(q.ask('Which list, A or B?', ['A', 'B'])).resolves.toBe('__dismissed__');

    expect(q.unansweredBecause).toBe('thread_deleted');
    expect(member.abort, 'no later step runs').toHaveBeenCalled();
    expect(prompts.getPending(RUN_ID), 'no question left that nobody can answer').toBeUndefined();
    expect(notified, 'nobody is asked').toHaveLength(0);
    expect(threads.getThread(RUN_ID), 'the deleted thread stays deleted').toBeUndefined();
  });
});
