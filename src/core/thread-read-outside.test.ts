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
