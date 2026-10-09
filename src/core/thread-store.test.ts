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
      created_by TEXT,
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      model_tier TEXT NOT NULL DEFAULT 'balanced',
      model_tier_source TEXT NOT NULL DEFAULT 'unknown',
      context_id TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      summary TEXT,
      summary_up_to INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      skip_extraction INTEGER NOT NULL DEFAULT 0,
      is_unread INTEGER NOT NULL DEFAULT 0,
      primary_subject_id TEXT,
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

describe('ThreadStore — Slice B3 unread state', () => {
  let db: Database.Database;
  let store: ThreadStore;
  beforeEach(() => {
    db = freshDb();
    store = new ThreadStore(db);
  });

  it('updateThread sets is_unread; markThreadRead clears it', () => {
    store.createThread('t1', { title: 'Escalation' });
    expect(store.getThread('t1')!.is_unread).toBe(0);
    store.updateThread('t1', { is_unread: true });
    expect(store.getThread('t1')!.is_unread).toBe(1);
    store.markThreadRead('t1');
    expect(store.getThread('t1')!.is_unread).toBe(0);
  });

  it('listThreads floats an unread thread above a (newer) FAVORITE — proving is_unread leads the order', () => {
    // 'fav' is a favorite; 'unread' is a plain unread thread created AFTER it
    // (so it is also the more-recent one). Without `is_unread DESC` leading the
    // ORDER BY, the favorite would win (is_favorite DESC); with it, the unread
    // non-favorite floats above. So this asserts the unread term specifically.
    store.createThread('fav', { title: 'fav' });
    store.appendMessages('fav', [makeMessage('user', 'hi')], 0, { message_count: 1 });
    store.updateThread('fav', { is_favorite: true });

    store.createThread('unread', { title: 'unread' });
    store.appendMessages('unread', [makeMessage('user', 'hi')], 0, { message_count: 1 });
    store.updateThread('unread', { is_unread: true });

    const ids = store.listThreads().map((t) => t.id);
    expect(ids[0]).toBe('unread'); // unread (non-favorite) beats the favorite
    expect(ids[1]).toBe('fav');
  });
});

describe('ThreadStore — anchor (Context-Hierarchy Scoping Slice A)', () => {
  it('sets, reads back, and clears a thread anchor', () => {
    const store = new ThreadStore(freshDb());
    store.createThread('t1', { title: 'x' });
    expect(store.getThread('t1')?.primary_subject_id).toBe(null); // default un-anchored
    store.updateThread('t1', { primary_subject_id: 'subj-42' });
    expect(store.getThread('t1')?.primary_subject_id).toBe('subj-42');
    store.updateThread('t1', { primary_subject_id: null }); // null = a real clear, not a skip
    expect(store.getThread('t1')?.primary_subject_id).toBe(null);
  });

  it('undefined leaves the anchor unchanged while another field updates (whitelist skip)', () => {
    const store = new ThreadStore(freshDb());
    store.createThread('t2');
    store.updateThread('t2', { primary_subject_id: 'subj-7' });
    store.updateThread('t2', { title: 'renamed' }); // anchor omitted → must survive
    const t = store.getThread('t2');
    expect(t?.primary_subject_id).toBe('subj-7');
    expect(t?.title).toBe('renamed');
  });
});

describe('ThreadStore.listBySubjectId (R2b subject footprint)', () => {
  it('returns threads anchored to a subject, newest activity first; others excluded', () => {
    const db = freshDb();
    const store = new ThreadStore(db);
    // Direct seed with explicit updated_at so the recency order is deterministic.
    const ins = db.prepare('INSERT INTO threads (id, primary_subject_id, updated_at) VALUES (?, ?, ?)');
    ins.run('th-old', 's-acme', '2026-01-01');
    ins.run('th-new', 's-acme', '2026-05-01');
    ins.run('th-other', 's-beta', '2026-09-01');
    expect(store.listBySubjectId('s-acme').map(t => t.id)).toEqual(['th-new', 'th-old']);
    expect(store.listBySubjectId('s-beta').map(t => t.id)).toEqual(['th-other']);
    expect(store.listBySubjectId('s-none')).toEqual([]);
    db.close();
  });
});

describe('ThreadStore — reading and erasing ALL threads (GDPR Art. 15/17)', () => {
  /** `count` threads with one message each and a DESCENDING `updated_at`, so the
   *  overview listing would order them t0000, t0001, … */
  function seedThreads(db: Database.Database, count: number): void {
    const ins = db.prepare('INSERT INTO threads (id, title, message_count, updated_at) VALUES (?, ?, 1, ?)');
    db.transaction(() => {
      for (let i = 0; i < count; i++) {
        ins.run(`t${String(i).padStart(4, '0')}`, `Thread ${i}`, `2026-01-01T00:00:${String(count - i).padStart(5, '0')}`);
      }
    })();
  }

  it('listThreadsForExport reaches every row the overview listing hides', () => {
    const db = freshDb();
    const store = new ThreadStore(db);
    seedThreads(db, 250);
    // The three row classes `listThreads` cannot return, each one personal data:
    //  · past its 200-row cap (the 250 above)
    //  · `message_count = 0` — never listed, and the TITLE is user-written text
    //  · archived — a UI gesture, not consent to be left out of an access request
    db.prepare("INSERT INTO threads (id, title, message_count) VALUES ('empty-but-named', 'Scheidung Mueller', 0)").run();
    db.prepare("INSERT INTO threads (id, title, message_count, is_archived) VALUES ('archived', 'Alte Sache', 3, 1)").run();

    // The listing, for contrast — this is what the export used to be built on.
    expect(store.listThreads({ limit: 1000, includeArchived: true })).toHaveLength(200);

    const all: string[] = [];
    let after: string | undefined;
    for (;;) {
      const batch = store.listThreadsForExport({ after, limit: 100 });
      all.push(...batch.map(t => t.id));
      if (batch.length < 100) break;
      after = batch[batch.length - 1]!.id;
    }

    expect(all).toHaveLength(252);
    expect(new Set(all).size, 'no row twice').toBe(252);
    expect(all).toContain('empty-but-named');
    expect(all).toContain('archived');
    db.close();
  });

  it('listThreadsForExport keeps its place when the table is written mid-walk', () => {
    // The reason the key is `id` and not an offset into the overview order. A live
    // engine writes threads while an export runs: `updated_at` bumps and
    // `is_unread` flips, both of which lead the listing's ORDER BY, so an
    // OFFSET-based walk re-sorts under itself — one row comes back twice and
    // another is never returned. An Art. 15 dump that quietly loses a thread is
    // exactly the defect this method exists for, so the test writes the worst case
    // between every page.
    const db = freshDb();
    const store = new ThreadStore(db);
    seedThreads(db, 40);
    const bump = db.prepare("UPDATE threads SET updated_at = ?, is_unread = 1 WHERE id = ?");

    const all: string[] = [];
    let after: string | undefined;
    let page = 0;
    for (;;) {
      const batch = store.listThreadsForExport({ after, limit: 10 });
      all.push(...batch.map(t => t.id));
      if (batch.length < 10) break;
      after = batch[batch.length - 1]!.id;
      // Move a row that has NOT been read yet to the very front of the listing
      // order, which is what breaks an offset walk.
      bump.run('2027-01-01T00:00:00', `t${String(39 - page).padStart(4, '0')}`);
      page++;
    }

    expect(all).toHaveLength(40);
    expect(new Set(all).size, 'no row twice and none lost').toBe(40);
    db.close();
  });

  it('deleteAllThreads removes rows no listing returns — past the cap, unread-count 0, archived', () => {
    const db = freshDb();
    const store = new ThreadStore(db);
    seedThreads(db, 250);
    db.prepare("INSERT INTO threads (id, title, message_count) VALUES ('empty-but-named', 'Scheidung Mueller', 0)").run();
    db.prepare("INSERT INTO threads (id, title, message_count, is_archived) VALUES ('archived', 'Alte Sache', 3, 1)").run();
    db.prepare("INSERT INTO thread_messages (thread_id, seq, role, content_json) VALUES ('t0000', 0, 'user', '\"hi\"')").run();
    // An orphan: a message whose parent thread row does not exist. It takes a
    // pragma flip to CREATE one here (better-sqlite3 enforces FKs by default) and
    // that is precisely its provenance in the wild — a write made while
    // `foreign_keys` was off, which `run-history.ts` does around migrations. No
    // cascade can ever reach such a row, because there is no parent to delete.
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO thread_messages (thread_id, seq, role, content_json) VALUES ('vanished-thread', 0, 'user', '\"orphan\"')").run();
    db.pragma('foreign_keys = ON');

    const before = (db.prepare('SELECT COUNT(*) c FROM threads').get() as { c: number }).c;
    expect(before, 'fixture guard — the wipe assertion must not be vacuous').toBe(252);

    const removed = store.deleteAllThreads();

    expect(removed).toBe(252);
    expect((db.prepare('SELECT COUNT(*) c FROM threads').get() as { c: number }).c).toBe(0);
    // Messages go too, and the ORPHAN is the one that matters: the cascade would
    // have taken the other message row with its thread, but a row with no parent
    // survives any number of thread deletions. It is only gone because the wipe
    // deletes `thread_messages` outright.
    expect((db.prepare('SELECT COUNT(*) c FROM thread_messages').get() as { c: number }).c).toBe(0);
    db.close();
  });
});
