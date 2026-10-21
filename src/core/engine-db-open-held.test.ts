import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';

// The boot sets a corrupt engine.db or history.db aside and starts on an empty one. It took any
// error of its integrity check for corruption, so a file another process held locked past the wait
// was set aside as well, and the engine started empty while the data sat beside it. A held file now
// fails the open loudly and stays; what corruption looks like (a file that is no database, a
// malformed page, a check that reports a fault) is still set aside. Both stores, the same cases.

const BETTER_SQLITE3 = createRequire(import.meta.url).resolve('better-sqlite3');

const STORES = [
  { name: 'engine.db', open: (file: string): { close(): void } => new EngineDb(file, '') },
  { name: 'history.db', open: (file: string): { close(): void } => new RunHistory(file) },
] as const;

for (const store of STORES) {
  describe(`the boot open of a ${store.name} another process holds`, () => {
    const dirs: string[] = [];
    const holders: ChildProcess[] = [];
    const tmp = (): string => {
      const d = mkdtempSync(join(tmpdir(), 'lynox-open-held-'));
      dirs.push(d);
      return d;
    };
    /** An engine.db made by EngineDb, with one row of our own to find again. */
    const seed = (dir: string, journal: 'wal' | 'delete' = 'wal'): string => {
      const file = join(dir, store.name);
      store.open(file).close();
      const db = new Database(file);
      db.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('kept')");
      if (journal === 'delete') db.pragma('journal_mode = DELETE');
      db.close();
      return file;
    };
    const marker = (file: string): boolean => {
      const db = new Database(file, { readonly: true });
      try {
        return (db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name = 'marker'").get() as { c: number }).c === 1;
      } finally {
        db.close();
      }
    };
    const setAside = (dir: string): string[] => readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    /** A second process that holds `file` the given way until it is killed. */
    const hold = async (file: string, how: 'locking-exclusive' | 'exclusive-txn'): Promise<void> => {
      const script = `
        const Database = require(${JSON.stringify(BETTER_SQLITE3)});
        const db = new Database(${JSON.stringify(file)});
        if (${JSON.stringify(how)} === 'locking-exclusive') db.pragma('locking_mode = EXCLUSIVE');
        else db.exec('BEGIN EXCLUSIVE');
        db.exec('CREATE TABLE IF NOT EXISTS held (a)'); db.exec('INSERT INTO held VALUES (1)');
        process.stdout.write('ready\\n');
        setInterval(() => {}, 1000);`;
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      holders.push(child);
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on('data', (b: Buffer) => { if (String(b).includes('ready')) resolve(); });
        child.on('exit', (code) => reject(new Error(`holder exited ${String(code)}`)));
      });
    };

    afterEach(() => {
      vi.restoreAllMocks();
      for (const h of holders.splice(0)) h.kill('SIGKILL');
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    it('held with locking_mode=EXCLUSIVE: the open fails loudly, and the file and its data stay', async () => {
      const dir = tmp();
      const file = seed(dir);
      await hold(file, 'locking-exclusive');
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(() => store.open(file)).toThrow(/locked|busy/i);
      expect(setAside(dir), 'the held file was set aside as corrupt').toEqual([]);
      holders.splice(0).forEach((h) => h.kill('SIGKILL'));
      await new Promise((r) => setTimeout(r, 100));
      expect(marker(file)).toBe(true);
    }, 30_000);

    it('a restored file in rollback mode, held by an exclusive transaction: the same', async () => {
      const dir = tmp();
      const file = seed(dir, 'delete');
      await hold(file, 'exclusive-txn');
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(() => store.open(file)).toThrow(/locked|busy/i);
      expect(setAside(dir)).toEqual([]);
      holders.splice(0).forEach((h) => h.kill('SIGKILL'));
      await new Promise((r) => setTimeout(r, 100));
      expect(marker(file)).toBe(true);
    }, 30_000);

    it('control: once the holder is gone, the same file opens and keeps its data', async () => {
      const dir = tmp();
      const file = seed(dir);
      await hold(file, 'locking-exclusive');
      holders.splice(0).forEach((h) => h.kill('SIGKILL'));
      await new Promise((r) => setTimeout(r, 100));
      store.open(file).close();
      expect(setAside(dir)).toEqual([]);
      expect(marker(file)).toBe(true);
    }, 30_000);
  });

  describe(`a corrupt ${store.name} is still set aside at the boot`, () => {
    const dirs: string[] = [];
    afterEach(() => {
      vi.restoreAllMocks();
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const corrupt = (damage: (bytes: Buffer) => Buffer): { dir: string; file: string } => {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-open-corrupt-'));
      dirs.push(dir);
      const file = join(dir, store.name);
      store.open(file).close();
      writeFileSync(file, damage(readFileSync(file)));
      return { dir, file };
    };

    for (const [shape, damage] of [
      ['its header overwritten (no database)', (b: Buffer) => b.fill(0x41, 0, 100)],
      ['cut short (a malformed image)', (b: Buffer) => b.subarray(0, 50)],
      ['a b-tree page scrambled (the check reports a fault)', (b: Buffer) => { const page = b.readUInt16BE(16) || 65536; for (let i = page + 8; i < page + 400; i++) b[i] = b[i]! ^ 0xff; return b; }],
    ] as const) {
      it(`a file with ${shape} is set aside and the boot starts on an empty one`, () => {
        const { dir, file } = corrupt(damage);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        store.open(file).close();
        expect(readdirSync(dir).some((f) => f.startsWith(`${store.name}.corrupt-`))).toBe(true);
      });
    }
  });
}
