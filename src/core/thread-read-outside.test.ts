// The thread's record of outside reads is written in the transaction of the message that carries
// the read: a message is never stored without it. Every writer of the thread goes through it, the
// agent's latch included (`ConversationLatch.set` arms the thread).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunHistory } from './run-history.js';
import { ThreadStore, ReadOutsideUnrecordedError } from './thread-store.js';
import { ConversationLatch } from './conversation-latch.js';
import { wrapUntrustedData } from './data-boundary.js';

const dirs: string[] = [];
const histories: RunHistory[] = [];
afterEach(() => {
  for (const h of histories) { try { h.close(); } catch { /* closed */ } }
  histories.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function open(): { store: ThreadStore; history: RunHistory } {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-read-outside-'));
  dirs.push(dir);
  const history = new RunHistory(join(dir, 'history.db'));
  histories.push(history);
  const store = new ThreadStore(history.getDb());
  store.createThread('th');
  return { store, history };
}

const count = (h: RunHistory, sql: string): number => (h.getDb().prepare(sql).get() as { n: number }).n;
const failRecord = (h: RunHistory): void => {
  h.getDb().exec("CREATE TRIGGER fail_read_outside BEFORE INSERT ON thread_read_outside BEGIN SELECT RAISE(ABORT, 'disk full'); END");
};

describe('ThreadStore: the record of outside reads', () => {
  it('an armed thread writes the record with its next message', () => {
    const { store, history } = open();
    ConversationLatch.forThread('th', store).set();
    expect(count(history, 'SELECT COUNT(*) AS n FROM thread_read_outside')).toBe(0);
    store.appendMessages('th', [{ role: 'user', content: 'tool result' }], 0);
    expect(count(history, 'SELECT COUNT(*) AS n FROM thread_read_outside')).toBe(1);
  });

  it('when the record cannot be written, the message is not stored either, and the thread stays armed', () => {
    const { store, history } = open();
    failRecord(history);
    ConversationLatch.forThread('th', store).set();
    expect(() => store.appendMessages('th', [{ role: 'user', content: 'tool result' }], 0)).toThrow(ReadOutsideUnrecordedError);
    expect(count(history, 'SELECT COUNT(*) AS n FROM thread_messages')).toBe(0);
    expect(store.readOutside('th')).toBe(true);
    // Fail-closed until a write succeeds: the next message that can be stored carries the record,
    // and only then is the thread no longer armed in memory.
    history.getDb().exec('DROP TRIGGER fail_read_outside');
    store.appendMessages('th', [{ role: 'user', content: 'weiter' }], 0);
    expect(count(history, 'SELECT COUNT(*) AS n FROM thread_read_outside')).toBe(1);
    expect((store as unknown as { _readOutsideArmed: Set<string> })._readOutsideArmed.has('th')).toBe(false);
    expect(store.readOutside('th'), 'the stored record still says so').toBe(true);
  });

  it('a message that carries outside content writes the record without an arm', () => {
    const { store, history } = open();
    store.appendMessages('th', [{ role: 'user', content: wrapUntrustedData('mallory@evil.example', 'mail') }], 0);
    expect(count(history, 'SELECT COUNT(*) AS n FROM thread_read_outside')).toBe(1);
  });

  it('CONTROL: a clean message of a thread nobody armed writes no record, even where the record cannot be written', () => {
    const { store, history } = open();
    failRecord(history);
    store.appendMessages('th', [{ role: 'user', content: 'hallo' }], 0);
    expect(count(history, 'SELECT COUNT(*) AS n FROM thread_messages')).toBe(1);
    expect(store.readOutside('th')).toBe(false);
  });

  it('typed words are read as the owner\'s only when their principal is the owner', () => {
    const { store } = open();
    store.appendMessages('th', [{ role: 'user', content: 'an x@evil.example' }], 0, undefined, 'mandate:h@example.invalid', 'an x@evil.example');
    store.appendMessages('th', [{ role: 'user', content: 'an anna@firma.ch' }], 1, undefined, 'owner', 'an anna@firma.ch');
    store.appendMessages('th', [{ role: 'user', content: 'an y@evil.example' }], 2, undefined, undefined, 'an y@evil.example');
    expect(store.ownerTypedTexts('th')).toEqual(['an anna@firma.ch']);
  });
});

describe('migration v75: escalation threads from before the record', () => {
  it('marks every escalation thread, and no other, and runs again without effect', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-read-outside-v75-'));
    dirs.push(dir);
    const path = join(dir, 'history.db');
    const history = new RunHistory(path);
    const store = new ThreadStore(history.getDb());
    for (const id of ['escalation-watch-1', 'escalation-watch-1-2', 'escalation-run-7', 'chat-owner', 'run-9c2e01', 'my-escalation-notes']) {
      store.createThread(id);
      store.appendMessages(id, [{ role: 'user', content: 'hello' }], 0);
    }
    // Back to v74: no record yet, as on a store written before the escalation kept one.
    history.getDb().exec('DELETE FROM thread_read_outside; DELETE FROM schema_version WHERE version >= 75;');
    history.close();

    const upgraded = new RunHistory(path);
    histories.push(upgraded);
    expect((upgraded.getDb().prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(75);
    const marked = (): string[] => (upgraded.getDb().prepare('SELECT thread_id FROM thread_read_outside ORDER BY thread_id').all() as Array<{ thread_id: string }>).map((r) => r.thread_id);
    expect(marked()).toEqual(['escalation-run-7', 'escalation-watch-1', 'escalation-watch-1-2']);
    const reopened = new ThreadStore(upgraded.getDb());
    expect(reopened.readOutside('chat-owner')).toBe(false);
    expect(reopened.readOutside('escalation-watch-1')).toBe(true);

    // Again on a store that has it: no error, nothing added.
    upgraded.getDb().exec('DELETE FROM schema_version WHERE version >= 75;');
    upgraded.close();
    const again = new RunHistory(path);
    histories.push(again);
    expect((again.getDb().prepare('SELECT COUNT(*) AS n FROM thread_read_outside').get() as { n: number }).n).toBe(3);
  });
});
