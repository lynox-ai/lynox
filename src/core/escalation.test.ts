import { describe, it, expect, beforeEach, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { ThreadStore } from './thread-store.js';
import type { NotificationRouter, NotificationMessage } from './notification-router.js';
import { escalateToUser } from './escalation.js';

function freshDb(): Database.Database {
  const db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE threads (
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
