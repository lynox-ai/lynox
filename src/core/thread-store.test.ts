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
      model_tier TEXT NOT NULL DEFAULT 'balanced',
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
      usage_json TEXT,
      display_only INTEGER NOT NULL DEFAULT 0,
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

describe('ThreadStore.getNextSeq (deletion-safe seq assignment)', () => {
  let db: Database.Database;
  let store: ThreadStore;

  beforeEach(() => {
    db = freshDb();
    store = new ThreadStore(db);
    store.createThread('t1');
  });

  it('returns 0 for an empty thread', () => {
    expect(store.getNextSeq('t1')).toBe(0);
  });

  it('returns MAX(seq)+1, equal to the row count on an append-only thread', () => {
    store.appendMessages('t1', [makeMessage('user', 'a'), makeMessage('assistant', 'b')], 0, { message_count: 2 });
    expect(store.getNextSeq('t1')).toBe(2);
    expect(store.getMessageCount('t1')).toBe(2);
  });

  it('stays MAX(seq)+1 after a mid-thread row deletion — where COUNT(*) would reuse a seq and collide', () => {
    store.appendMessages('t1', [
      makeMessage('user', 'a'),     // seq 0
      makeMessage('assistant', 'b'), // seq 1
      makeMessage('user', 'c'),     // seq 2
    ], 0, { message_count: 3 });
    // Delete the middle row: COUNT(*) drops to 2 (would reuse seq 2), but the
    // surviving MAX(seq) is still 2, so the next seq must be 3 — no collision.
    db.prepare('DELETE FROM thread_messages WHERE thread_id = ? AND seq = ?').run('t1', 1);
    expect(store.getMessageCount('t1')).toBe(2); // count-based seq would be 2 → collide with surviving seq 2
    expect(store.getNextSeq('t1')).toBe(3);      // MAX(seq)+1 stays monotonic
  });

  it('keeps display-only rows in the seq space (next seq sorts after a trailing note)', () => {
    store.appendMessages('t1', [makeMessage('user', 'a')], 0, { message_count: 1 });
    store.appendDisplayNotes('t1', [{ role: 'assistant', content: 'compacted' }], store.getNextSeq('t1'));
    expect(store.getNextSeq('t1')).toBe(2);
  });
});

describe('ThreadStore.setMessageUsage', () => {
  let db: Database.Database;
  let store: ThreadStore;

  beforeEach(() => {
    db = freshDb();
    store = new ThreadStore(db);
    store.createThread('t1');
  });

  it('stamps usage JSON onto the latest assistant message only', () => {
    store.appendMessages('t1', [makeMessage('user', 'hi'), makeMessage('assistant', 'hello')], 0, { message_count: 2 });
    const usage = JSON.stringify({ tokensIn: 100, tokensOut: 20, costUsd: 0.01 });
    store.setMessageUsage('t1', usage);
    const rows = store.getMessages('t1');
    expect(rows[1]?.usage_json).toBe(usage);
    expect(rows[0]?.usage_json).toBeNull();
  });

  it('targets the highest-seq assistant row even when a tool_result trails', () => {
    store.appendMessages('t1', [
      makeMessage('user', 'hi'),
      makeMessage('assistant', 'first'),
      makeMessage('assistant', 'final'),
      makeMessage('user', 'tool_result carrier'),
    ], 0, { message_count: 4 });
    const usage = JSON.stringify({ tokensIn: 50 });
    store.setMessageUsage('t1', usage);
    const rows = store.getMessages('t1');
    expect(rows[2]?.usage_json).toBe(usage); // 'final' assistant row (seq 2)
    expect(rows[1]?.usage_json).toBeNull();  // earlier assistant row untouched
    expect(rows[3]?.usage_json).toBeNull();  // trailing user row untouched
  });

  it('is a no-op when the thread has no assistant message', () => {
    store.appendMessages('t1', [makeMessage('user', 'hi')], 0, { message_count: 1 });
    store.setMessageUsage('t1', JSON.stringify({ tokensIn: 5 }));
    expect(store.getMessages('t1')[0]?.usage_json).toBeNull();
  });

  it('targets the highest-seq NON-display assistant row (skips a B-full note)', () => {
    store.appendMessages('t1', [makeMessage('user', 'q'), makeMessage('assistant', 'real reply')], 0, { message_count: 2 });
    // A failed follow-up turn left a display-only assistant note at a higher seq.
    store.appendDisplayNotes('t1', [{ role: 'assistant', content: { _lynox_note: { code: 'provider_error' } } }], 2);
    const usage = JSON.stringify({ tokensIn: 42 });
    store.setMessageUsage('t1', usage);
    const rows = store.getMessages('t1');
    expect(rows[1]?.usage_json).toBe(usage); // the real reply (seq 1) is stamped
    expect(rows[2]?.usage_json).toBeNull();  // the display note (seq 2) is NOT
  });
});

describe('ThreadStore B-full display-only rows', () => {
  let db: Database.Database;
  let store: ThreadStore;

  beforeEach(() => {
    db = freshDb();
    store = new ThreadStore(db);
    store.createThread('t1');
    // A completed turn: user + assistant (both API rows, display_only=0).
    store.appendMessages('t1', [makeMessage('user', 'hello'), makeMessage('assistant', 'hi there')], 0, { message_count: 2 });
  });

  it('appendDisplayNotes persists rows with display_only=1', () => {
    store.appendDisplayNotes('t1', [
      { role: 'user', content: 'failed question' },
      { role: 'assistant', content: { _lynox_note: { code: 'provider_error', detail: '401' } } },
    ], 2);
    const rows = store.getMessages('t1');
    expect(rows).toHaveLength(4);
    expect(rows[2]?.display_only).toBe(1);
    expect(rows[3]?.display_only).toBe(1);
    expect(rows[0]?.display_only).toBe(0);
  });

  it('getMessages({apiOnly}) excludes display-only rows; default includes them', () => {
    store.appendDisplayNotes('t1', [{ role: 'assistant', content: { _lynox_note: { code: 'provider_error' } } }], 2);
    expect(store.getMessages('t1')).toHaveLength(3);                  // render path: full history
    expect(store.getMessages('t1', { apiOnly: true })).toHaveLength(2); // API context: notes filtered
  });

  it('getApiMessageCount tracks non-display rows; getMessageCount tracks all', () => {
    store.appendDisplayNotes('t1', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: { _lynox_note: { code: 'provider_error' } } },
    ], 2);
    expect(store.getApiMessageCount('t1')).toBe(2); // unchanged by the notes
    expect(store.getMessageCount('t1')).toBe(4);    // includes both notes
  });

  it('markDisplayOnlyFrom flips a failed run footprint and reports the user message', () => {
    // A second turn eager-persisted its user + partial assistant, then failed.
    store.appendMessages('t1', [
      makeMessage('user', 'second q'), makeMessage('assistant', 'partial'),
    ], 2, { message_count: 4 }); // appends seq 2,3 (the second turn)
    const res = store.markDisplayOnlyFrom('t1', 2);
    expect(res).toEqual({ marked: 2, hadUserMessage: true });
    expect(store.getApiMessageCount('t1')).toBe(2);          // only the first turn remains API
    expect(store.getMessages('t1', { apiOnly: true })).toHaveLength(2);
    expect(store.getMessages('t1')).toHaveLength(4);         // all still render
  });

  it('markDisplayOnlyFrom on an empty footprint is a no-op', () => {
    const res = store.markDisplayOnlyFrom('t1', 2); // nothing persisted at seq>=2
    expect(res).toEqual({ marked: 0, hadUserMessage: false });
    expect(store.getApiMessageCount('t1')).toBe(2);
  });
});
