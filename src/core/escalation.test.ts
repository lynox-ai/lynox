import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { ThreadStore } from './thread-store.js';
import { NotificationRouter as RealRouter, type ChannelOutcome, type DeliverySummary, type NotificationRouter, type NotificationMessage } from './notification-router.js';
import { escalateToUser } from './escalation.js';

function freshDb(): Database.Database {
  const db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE threads (
      created_by TEXT,
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', model_tier TEXT NOT NULL DEFAULT 'balanced', model_tier_source TEXT NOT NULL DEFAULT 'unknown',
      context_id TEXT NOT NULL DEFAULT '', message_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0, total_cost_usd REAL NOT NULL DEFAULT 0,
      summary TEXT, summary_up_to INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0,
      is_favorite INTEGER NOT NULL DEFAULT 0, skip_extraction INTEGER NOT NULL DEFAULT 0,
      is_unread INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE thread_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, seq INTEGER NOT NULL,
      role TEXT NOT NULL, content_json TEXT NOT NULL, usage_json TEXT, display_only INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('escalateToUser (the Agent→User escalation primitive, Slice B3)', () => {
  let store: ThreadStore;
  let notify: ReturnType<typeof vi.fn>;
  let router: NotificationRouter;

  beforeEach(() => {
    store = new ThreadStore(freshDb());
    notify = vi.fn<(m: NotificationMessage) => Promise<void>>().mockResolvedValue(undefined);
    router = { notify } as unknown as NotificationRouter;
  });

  it('opens an unread thread keyed by source, seeds the context, and pushes the threadId as a wakeup', () => {
    const r = escalateToUser(store, router, { key: 'task-1', title: '✗ Report', body: 'Step 3 failed: bad path', data: { taskId: 'task-1' } });
    expect(r).toEqual({ threadId: 'escalation-task-1' });
    const thread = store.getThread('escalation-task-1')!;
    expect(thread.is_unread).toBe(1);
    expect(thread.message_count).toBe(2); // user subject + assistant detail
    const msgs = store.getMessages('escalation-task-1');
    // API-validity: the thread must OPEN with a user-role message (Anthropic
    // rejects a leading assistant turn) so the user can reply.
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[1]!.role).toBe('assistant');
    // The agent's detail carries the context.
    expect(JSON.stringify(msgs)).toContain('Step 3 failed');
    // The push points at the thread (wakeup, not payload).
    const pushed = notify.mock.calls[0]![0] as NotificationMessage;
    expect(pushed.data).toMatchObject({ taskId: 'task-1', threadId: 'escalation-task-1' });
    expect(pushed.priority).toBe('high');
  });

  it('never lands the owner\'s detail in a thread a mandate holds — a bare push instead', () => {
    // An escalation thread is the owner's; a row with that id stamped by a mandate is refused
    // up front by POST /api/sessions, and this is the second layer.
    store.createThread('escalation-task-9', { created_by: 'mandate:setup@example.org' });
    const r = escalateToUser(store, router, { key: 'task-9', title: '✗ Report', body: 'Step 3 failed', data: { taskId: 'task-9' } });
    expect(r).toBeNull();
    expect(store.getMessages('escalation-task-9')).toEqual([]);
    expect(store.getThread('escalation-task-9')!.is_unread).toBe(0);
    expect((notify.mock.calls[0]![0] as NotificationMessage).data).toEqual({ taskId: 'task-9' });
  });

  it('control: an owner-opened escalation thread is bumped as before', () => {
    store.createThread('escalation-task-9', { created_by: 'owner' });
    expect(escalateToUser(store, router, { key: 'task-9', title: 't', body: 'b' })).toEqual({ threadId: 'escalation-task-9' });
    expect(store.getMessages('escalation-task-9')).toHaveLength(2);
  });

  it('BUMPS the same thread on a repeat event (one thread per source, history accumulates)', () => {
    escalateToUser(store, router, { key: 'task-1', title: 'Watch', body: 'first finding' });
    // Mark it read as if the user opened it...
    store.markThreadRead('escalation-task-1');
    expect(store.getThread('escalation-task-1')!.is_unread).toBe(0);
    // ...a second finding bumps the SAME thread + re-marks unread.
    const r = escalateToUser(store, router, { key: 'task-1', title: 'Watch', body: 'second finding' });
    expect(r).toEqual({ threadId: 'escalation-task-1' });
    const thread = store.getThread('escalation-task-1')!;
    expect(thread.message_count).toBe(4); // two events × (user + assistant)
    expect(thread.is_unread).toBe(1);
    // Roles still alternate after a bump (no two consecutive same-role turns) so
    // the conversation stays API-valid.
    const roles = store.getMessages('escalation-task-1').map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('appends the assistant body ALONE when the last turn is already user (concurrent-reply safe — no consecutive user → no 400)', () => {
    // Simulate a thread where the user just replied (last API turn = user), then
    // a background bump lands.
    store.createThread('escalation-task-1', { title: 't' });
    store.appendMessages('escalation-task-1', [
      { role: 'user', content: 'subject' },
      { role: 'assistant', content: 'detail' },
      { role: 'user', content: 'my reply' },
    ], 0, { message_count: 3 });
    escalateToUser(store, router, { key: 'task-1', title: 'Subj', body: 'new finding' });
    const roles = store.getMessages('escalation-task-1').map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']); // alternates; no doubled user
  });

  it('degrades to a bare push (returns null) when there is no ThreadStore', () => {
    const r = escalateToUser(null, router, { key: 'task-1', title: 't', body: 'b', data: { taskId: 'x' } });
    expect(r).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    // No threadId injected when there's no thread to point at.
    const pushed = notify.mock.calls[0]![0] as NotificationMessage;
    expect(pushed.data?.['threadId']).toBeUndefined();
  });
});

describe('escalateToUser reports whether anyone was told', () => {
  /** Runs one escalation through a real router and resolves with what onReported got. */
  function reported(
    outcomes: ChannelOutcome[],
    run: (router: NotificationRouter, onReported: (d: DeliverySummary) => void) => void,
  ): Promise<DeliverySummary> {
    const router = new RealRouter();
    outcomes.forEach((o, i) => router.register({ name: `ch${String(i)}`, send: async () => o }));
    return new Promise((resolve) => run(router, resolve));
  }

  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true); });
  afterEach(() => { stderr.mockRestore(); });

  it('delivered when a channel delivered the wakeup of a thread escalation', async () => {
    const store = new ThreadStore(freshDb());
    await expect(reported(['delivered'], (r, cb) => { escalateToUser(store, r, { key: 'k', title: 't', body: 'b', onReported: cb }); }))
      .resolves.toBe('delivered');
  });

  it('not_delivered when the only channel merely handled it — a skip is nobody told', async () => {
    const store = new ThreadStore(freshDb());
    await expect(reported(['skipped'], (r, cb) => { escalateToUser(store, r, { key: 'k', title: 't', body: 'b', onReported: cb }); }))
      .resolves.toBe('not_delivered');
  });

  it('no_channel when nothing is registered', async () => {
    const store = new ThreadStore(freshDb());
    await expect(reported([], (r, cb) => { escalateToUser(store, r, { key: 'k', title: 't', body: 'b', onReported: cb }); }))
      .resolves.toBe('no_channel');
  });

  it('reports on the bare-push path without a thread store', async () => {
    await expect(reported(['failed'], (r, cb) => { escalateToUser(null, r, { key: 'k', title: 't', body: 'b', onReported: cb }); }))
      .resolves.toBe('not_delivered');
  });

  it('reports on the mandate fallback path', async () => {
    const store = new ThreadStore(freshDb());
    store.createThread('escalation-k', { created_by: 'mandate:setup@example.org' });
    await expect(reported(['delivered'], (r, cb) => { escalateToUser(store, r, { key: 'k', title: 't', body: 'b', onReported: cb }); }))
      .resolves.toBe('delivered');
  });

  it('a throwing onReported is logged and does not reject anywhere', async () => {
    const store = new ThreadStore(freshDb());
    const router = new RealRouter();
    router.register({ name: 'push', send: async () => 'delivered' });
    escalateToUser(store, router, { key: 'k', title: 't', body: 'b', onReported: () => { throw new Error('db gone'); } });
    await vi.waitFor(() => {
      expect(stderr.mock.calls.map((c) => String(c[0])).some((l) => l.includes('[escalation] recording the delivery failed: db gone'))).toBe(true);
    });
  });
});
