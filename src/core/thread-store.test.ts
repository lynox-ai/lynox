// Contract test for the round-2 P1 change to `ThreadStore.appendMessages`:
// when called with the optional `threadUpdates` 4th arg, the message INSERTs
// and the rollup UPDATE must run inside the SAME better-sqlite3 transaction
// (one fsync under WAL instead of two). Without an explicit test, a future
// refactor could split them back out and silently break the atomicity claim.

import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { ThreadStore } from './thread-store.js';
import type Database from 'better-sqlite3';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

function freshDb(): Database.Database {
  const db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      model_tier TEXT NOT NULL DEFAULT 'sonnet',
      context_id TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      summary TEXT,
      summary_up_to INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      skip_extraction INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE thread_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function makeMessage(role: 'user' | 'assistant', text: string): BetaMessageParam {
  return { role, content: text };
}

describe('ThreadStore.appendMessages with threadUpdates (P1 contract)', () => {
  let db: Database.Database;
  let store: ThreadStore;

  beforeEach(() => {
    db = freshDb();
    store = new ThreadStore(db);
    store.createThread('t1');
  });

  it('appends messages AND updates message_count atomically when threadUpdates is provided', () => {
    store.appendMessages('t1', [makeMessage('user', 'hi'), makeMessage('assistant', 'hello')], 0, {
      message_count: 2,
    });
    expect(store.getMessageCount('t1')).toBe(2);
    expect(store.getThread('t1')?.message_count).toBe(2);
  });

  it('updates total_tokens and total_cost_usd alongside the append', () => {
    store.appendMessages('t1', [makeMessage('user', 'hi')], 0, {
      message_count: 1,
      total_tokens: 1234,
      total_cost_usd: 0.05,
    });
    const thread = store.getThread('t1');
    expect(thread?.message_count).toBe(1);
    expect(thread?.total_tokens).toBe(1234);
    expect(thread?.total_cost_usd).toBeCloseTo(0.05);
  });

  it('appends without touching threadUpdates fields when no 4th-arg given (back-compat)', () => {
    store.appendMessages('t1', [makeMessage('user', 'hi')], 0);
    expect(store.getMessageCount('t1')).toBe(1);
    // message_count remains at the default 0 because no rollup was provided.
    expect(store.getThread('t1')?.message_count).toBe(0);
  });

  it('handles an empty messages array with rollup-only (no INSERTs, still updates)', () => {
    store.appendMessages('t1', [], 0, { message_count: 0, total_tokens: 42 });
    expect(store.getMessageCount('t1')).toBe(0);
    expect(store.getThread('t1')?.total_tokens).toBe(42);
  });

  it('appends a delta starting at the supplied startSeq', () => {
    store.appendMessages('t1', [makeMessage('user', 'a')], 0, { message_count: 1 });
    store.appendMessages('t1', [makeMessage('assistant', 'b'), makeMessage('user', 'c')], 1, {
      message_count: 3,
    });
    expect(store.getMessageCount('t1')).toBe(3);
    expect(store.getThread('t1')?.message_count).toBe(3);
    // Verify seq integrity — the second batch starts at seq=1, not seq=0.
    const rows = db.prepare('SELECT seq, role FROM thread_messages WHERE thread_id = ? ORDER BY seq ASC').all('t1') as Array<{ seq: number; role: string }>;
    expect(rows).toEqual([
      { seq: 0, role: 'user' },
      { seq: 1, role: 'assistant' },
      { seq: 2, role: 'user' },
    ]);
  });
});
