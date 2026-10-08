import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { scrubFreedPages, zeroDeletedContent } from './sqlite-constants.js';

describe('scrubFreedPages', () => {
  it('empties the WAL file when no other connection holds it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wal-'));
    try {
      const db = new Database(join(dir, 't.db'));
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE t (x TEXT)');
      db.prepare('INSERT INTO t (x) VALUES (?)').run('value');
      expect(statSync(join(dir, 't.db-wal')).size, 'fixture: the write went to the WAL').toBeGreaterThan(0);
      scrubFreedPages(db);
      expect(statSync(join(dir, 't.db-wal')).size).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes rows that were freed before secure_delete was on, and stale copies of rows deleted after', () => {
    // Every existing install has a freelist written by connections that never had
    // secure_delete: pages it does not free itself keep their bytes, and so do the
    // stale copies a rebalance leaves of rows that were still live at the time.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wal-'));
    try {
      const path = join(dir, 't.db');
      const before = new Database(path);
      before.pragma('journal_mode = WAL');
      before.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, kind TEXT, x TEXT)');
      const insert = before.prepare('INSERT INTO t (kind, x) VALUES (?, ?)');
      for (let i = 0; i < 200; i++) {
        insert.run('old', `ZZOLDDEL-${i}-${'o'.repeat(400)}`);
        insert.run('live', `ZZLIVE-${i}-${'l'.repeat(400)}`);
      }
      before.prepare("DELETE FROM t WHERE kind = 'old'").run();
      before.pragma('wal_checkpoint(TRUNCATE)');
      before.close();

      const db = new Database(path);
      db.pragma('journal_mode = WAL');
      zeroDeletedContent(db);
      db.prepare('DELETE FROM t').run();
      db.pragma('wal_checkpoint(TRUNCATE)');
      const bytes = readFileSync(path);
      expect(bytes.includes(Buffer.from('ZZOLDDEL')), 'fixture: secure_delete alone leaves the old freelist').toBe(true);

      scrubFreedPages(db);
      const after = readFileSync(path);
      expect(after.includes(Buffer.from('ZZOLDDEL'))).toBe(false);
      expect(after.includes(Buffer.from('ZZLIVE'))).toBe(false);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when a reader blocks the checkpoint, instead of reporting the WAL gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wal-'));
    try {
      const path = join(dir, 't.db');
      const writer = new Database(path);
      writer.pragma('journal_mode = WAL');
      writer.exec('CREATE TABLE t (x TEXT)');
      const reader = new Database(path);
      // An open read transaction pins the WAL frames it can see.
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) FROM t').get();
      writer.prepare('INSERT INTO t (x) VALUES (?)').run('value');
      expect(() => scrubFreedPages(writer)).toThrow(/blocked/);
      reader.exec('COMMIT');
      reader.close();
      writer.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('zeroDeletedContent', () => {
  it('leaves no trace of a deleted value in the main file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wal-'));
    try {
      const path = join(dir, 't.db');
      const db = new Database(path);
      db.pragma('journal_mode = WAL');
      zeroDeletedContent(db);
      db.exec('CREATE TABLE t (x TEXT)');
      db.prepare('INSERT INTO t (x) VALUES (?)').run('ZZDELETED-value-7f3a');
      scrubFreedPages(db);
      expect(readFileSync(path).includes(Buffer.from('ZZDELETED')), 'fixture: the value is in the main file').toBe(true);
      db.prepare('DELETE FROM t').run();
      // A bare checkpoint, not `scrubFreedPages`: its VACUUM would drop the freed
      // page whatever was on it, and this test is about secure_delete alone.
      db.pragma('wal_checkpoint(TRUNCATE)');
      expect(readFileSync(path).includes(Buffer.from('ZZDELETED'))).toBe(false);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
