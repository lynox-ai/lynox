import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { truncateWal, zeroDeletedContent } from './sqlite-constants.js';

describe('truncateWal', () => {
  it('empties the WAL file when no other connection holds it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wal-'));
    try {
      const db = new Database(join(dir, 't.db'));
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE t (x TEXT)');
      db.prepare('INSERT INTO t (x) VALUES (?)').run('value');
      expect(statSync(join(dir, 't.db-wal')).size, 'fixture: the write went to the WAL').toBeGreaterThan(0);
      truncateWal(db);
      expect(statSync(join(dir, 't.db-wal')).size).toBe(0);
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
      expect(() => truncateWal(writer)).toThrow(/blocked/);
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
      truncateWal(db);
      expect(readFileSync(path).includes(Buffer.from('ZZDELETED')), 'fixture: the value is in the main file').toBe(true);
      db.prepare('DELETE FROM t').run();
      truncateWal(db);
      expect(readFileSync(path).includes(Buffer.from('ZZDELETED'))).toBe(false);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
