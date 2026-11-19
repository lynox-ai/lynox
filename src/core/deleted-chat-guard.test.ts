import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { RunHistory } from './run-history.js';
import { FALLBACK_CONTENT_COLUMNS } from './connection-erasure.js';
import { GUARDED_ROWS } from './deleted-chat-guard.js';

describe('deleted-chat guard', () => {
  const dirs: string[] = [];
  const open = (dir?: string): { history: RunHistory; dir: string } => {
    const d = dir ?? mkdtempSync(join(tmpdir(), 'lynox-guard-'));
    if (!dir) dirs.push(d);
    return { history: new RunHistory(join(d, 'history.db')), dir: d };
  };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const triggersOf = (history: RunHistory): string[] =>
    (history.getDb().prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'deleted_chat_%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);

  it('has a rule for every content table, and no other', () => {
    expect(Object.keys(GUARDED_ROWS).sort()).toEqual(Object.keys(FALLBACK_CONTENT_COLUMNS).sort());
  });

  it('puts an insert and an update trigger on every content table of history.db', () => {
    const { history } = open();
    try {
      const expected = Object.keys(FALLBACK_CONTENT_COLUMNS).flatMap((t) => [`deleted_chat_insert_${t}`, `deleted_chat_update_${t}`]).sort();
      expect(triggersOf(history)).toEqual(expected);
    } finally { history.close(); }
  });

  it('a migration that fails on open leaves the triggers as they were', () => {
    const first = open();
    const before = triggersOf(first.history);
    // The last migration runs again and fails: its column is already there.
    const last = (first.history.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    first.history.getDb().prepare('DELETE FROM schema_version WHERE version = ?').run(last);
    first.history.close();
    expect(() => new RunHistory(join(first.dir, 'history.db'))).toThrow();
    const raw = new BetterSqlite3(join(first.dir, 'history.db'));
    try {
      const names = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'deleted_chat_%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
      expect(names).toEqual(before);
    } finally { raw.close(); }
  });

  it('opens the same file again with the same triggers', () => {
    const first = open();
    const before = triggersOf(first.history);
    first.history.close();
    const again = open(first.dir);
    try {
      expect(triggersOf(again.history)).toEqual(before);
    } finally { again.history.close(); }
  });
});
