import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PromptStore, PromptConflictError } from './prompt-store.js';

/** Build a fresh SQLite instance with just the pending_prompts schema the
 * PromptStore depends on. Mirrors migrations v25 + v27 (post-rewrite). */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  const stmts = [
    `CREATE TABLE pending_prompts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt_type TEXT NOT NULL CHECK(prompt_type IN ('ask_user','ask_secret')),
      question TEXT NOT NULL,
      options_json TEXT,
      questions_json TEXT,
      partial_answers_json TEXT,
      secret_name TEXT,
      secret_key_type TEXT,
      answer TEXT,
      answer_saved INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','expired')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      answered_at TEXT,
      expires_at TEXT NOT NULL
    )`,
    `CREATE INDEX idx_pending_prompts_session ON pending_prompts(session_id, status)`,
    `CREATE UNIQUE INDEX idx_pending_prompts_session_unique
      ON pending_prompts(session_id) WHERE status = 'pending'`,
  ];
  for (const s of stmts) db.prepare(s).run();
  return db;
}

describe('PromptStore', () => {
  let db: Database.Database;
  let store: PromptStore;

  beforeEach(() => {
    db = makeDb();
    store = new PromptStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('single-question ask_user', () => {
    it('round-trips insert -> answer -> waitForAnswer', async () => {
      const id = store.insertAskUser('s1', 'hello?', ['yes', 'no']);
      const wait = store.waitForAnswer(id);
      // Answer asynchronously -- event bus should deliver quickly.
      setTimeout(() => { store.answerUser(id, 'yes'); }, 10);
      const row = await wait;
      expect(row?.status).toBe('answered');
      expect(row?.answer).toBe('yes');
    });

    it('resolves immediately if already answered (fast path)', async () => {
      const id = store.insertAskUser('s1', 'q');
      store.answerUser(id, 'a');
      const row = await store.waitForAnswer(id);
      expect(row?.answer).toBe('a');
    });

    it('answerUser is idempotent -- second call returns false', () => {
      const id = store.insertAskUser('s1', 'q');
      expect(store.answerUser(id, 'a')).toBe(true);
      expect(store.answerUser(id, 'a')).toBe(false);
    });
  });

  describe('multi-question tabs', () => {
    it('stores questions and accepts array answers', async () => {
      const id = store.insertAskUserTabs('s1', [
        { question: 'q1', header: 'H1' },
        { question: 'q2', options: ['a', 'b'] },
      ]);
      const row = store.getById(id);
      expect(row?.questions_json).toContain('q1');
      expect(row?.questions_json).toContain('q2');

      const wait = store.waitForAnswer(id);
      setTimeout(() => { store.answerUserTabs(id, ['x', 'y']); }, 10);
      const answered = await wait;
      expect(answered?.answer).toBe(JSON.stringify(['x', 'y']));
    });

    it('rejects empty questions', () => {
      expect(() => store.insertAskUserTabs('s1', [])).toThrow();
    });

    it('persists partial answers without settling', () => {
      const id = store.insertAskUserTabs('s1', [{ question: 'q1' }, { question: 'q2' }]);
      store.setPartialAnswers(id, ['first', null]);
      const row = store.getById(id);
      expect(row?.status).toBe('pending'); // not settled
      expect(row?.partial_answers_json).toBe(JSON.stringify(['first', null]));
    });
  });

  describe('unicity per session', () => {
    it('rejects a second pending prompt in the same session', () => {
      store.insertAskUser('s1', 'q1');
      expect(() => store.insertAskUser('s1', 'q2')).toThrow(PromptConflictError);
    });

    it('allows new prompt after previous is answered', () => {
      const id = store.insertAskUser('s1', 'q1');
      store.answerUser(id, 'a');
      expect(() => store.insertAskUser('s1', 'q2')).not.toThrow();
    });

    it('allows new prompt after previous is expired', () => {
      // Insert, then manually mark expired to simulate TTL elapsed.
      const id = store.insertAskUser('s1', 'q1');
      db.prepare(`UPDATE pending_prompts SET status = 'expired' WHERE id = ?`).run(id);
      expect(() => store.insertAskUser('s1', 'q2')).not.toThrow();
    });
  });

  describe('abort signal', () => {
    it('resolves with aborted outcome immediately when signal already aborted', async () => {
      const id = store.insertAskUser('s1', 'q');
      const ac = new AbortController();
      ac.abort();
      const outcome = await store.waitForSettled(id, ac.signal);
      expect(outcome.status).toBe('aborted');
    });

    it('resolves with aborted when signal fires during wait', async () => {
      const id = store.insertAskUser('s1', 'q');
      const ac = new AbortController();
      const promise = store.waitForSettled(id, ac.signal);
      setTimeout(() => ac.abort(), 20);
      const outcome = await promise;
      expect(outcome.status).toBe('aborted');
    });
  });

  describe('expiry', () => {
    it('expireOld transitions past-due prompts and notifies waiters', async () => {
      const id = store.insertAskUser('s1', 'q');
      // Force expires_at into the past.
      db.prepare(`UPDATE pending_prompts SET expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(id);
      const wait = store.waitForSettled(id);
      store.expireOld();
      const outcome = await wait;
      expect(outcome.status).toBe('expired');
    });

    it('expirePrompt settles a single in-flight wait with expired and frees the session slot', async () => {
      const id = store.insertAskUser('s1', 'q');
      const wait = store.waitForSettled(id);
      expect(store.expirePrompt(id)).toBe(true);
      const outcome = await wait;
      expect(outcome.status).toBe('expired');
      // Slot is free again — a fresh prompt for the same session must insert.
      expect(() => store.insertAskUser('s1', 'q2')).not.toThrow();
    });

    it('expirePrompt is idempotent', () => {
      const id = store.insertAskUser('s1', 'q');
      expect(store.expirePrompt(id)).toBe(true);
      expect(store.expirePrompt(id)).toBe(false);
    });

    it('expirePrompt is a no-op for an already-answered prompt', () => {
      const id = store.insertAskUser('s1', 'q');
      store.answerUser(id, 'a');
      expect(store.expirePrompt(id)).toBe(false);
      expect(store.getById(id)?.status).toBe('answered');
    });
  });

  describe('getPending', () => {
    it('returns undefined when nothing pending', () => {
      expect(store.getPending('nope')).toBeUndefined();
    });

    it('returns the pending row with questions_json populated for tabs', () => {
      const id = store.insertAskUserTabs('s1', [{ question: 'q1' }]);
      const row = store.getPending('s1');
      expect(row?.id).toBe(id);
      expect(row?.questions_json).toBeTruthy();
    });
  });
});
