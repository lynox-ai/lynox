import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { checkKeylessOverCiphertext } from './vault-key-detect.js';

/**
 * The check that reports a keyless boot over encrypted data. Real stores, so every registered table
 * exists and the ciphertext is the one `enc` writes; the stores are opened with a key to write it and
 * read back through their own connections, as the boot would.
 */

const KEY = randomBytes(48).toString('base64');
let dir: string;
const open: Array<{ close(): void }> = [];

function engineDb(): EngineDb {
  dir ??= mkdtempSync(join(tmpdir(), 'lynox-keyless-'));
  const db = new EngineDb(join(dir, 'engine.db'), KEY);
  open.push(db);
  return db;
}

function setBlock(db: EngineDb, id: 'profile' | 'playbook', content: string): void {
  db.getDb().prepare(`INSERT OR REPLACE INTO memory_blocks (id, content, char_limit) VALUES (?, ?, 1000)`).run(id, content);
}

afterEach(() => {
  for (const s of open.splice(0)) s.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined as unknown as string;
});

describe('checkKeylessOverCiphertext', () => {
  it('finds a value enc wrote, down to a one-byte plaintext (a 40-character body)', async () => {
    const db = engineDb();
    const one = db.enc('x');
    expect(one.length - 4).toBe(40);
    setBlock(db, 'playbook', one);
    const r = await checkKeylessOverCiphertext([{ name: 'engine.db', db: db.getDb() }]);
    expect(r).toEqual({ state: 'missing_over_encrypted_data', stores: ['engine.db'] });
  });

  it.each([
    ['a plaintext note that starts with enc:', 'enc: note to self'],
    ['another case', `Enc:${'A'.repeat(40)}`],
    ['a body shorter than 40', `enc:${'A'.repeat(36)}`],
    ['a body that is not a multiple of 4', `enc:${'A'.repeat(41)}`],
    ['a character outside base64', `enc:${'A'.repeat(39)}!`],
    ['padding before the end', `enc:${'A'.repeat(20)}=${'A'.repeat(19)}`],
    ['three padding characters', `enc:${'A'.repeat(41)}===`],
  ])('does not count %s', async (_label, value) => {
    const db = engineDb();
    setBlock(db, 'playbook', value);
    expect(await checkKeylessOverCiphertext([{ name: 'engine.db', db: db.getDb() }])).toBeNull();
  });

  it('still counts a body that ends in one or two padding characters', async () => {
    for (const body of [`${'A'.repeat(39)}=`, `${'A'.repeat(38)}==`]) {
      const db = engineDb();
      setBlock(db, 'playbook', `enc:${body}`);
      expect(await checkKeylessOverCiphertext([{ name: 'engine.db', db: db.getDb() }])).not.toBeNull();
      db.close(); open.pop(); rmSync(join(dir, 'engine.db'), { force: true });
      rmSync(join(dir, 'engine.db-wal'), { force: true }); rmSync(join(dir, 'engine.db-shm'), { force: true });
    }
  });

  it('steps past a window without a match to find ciphertext in a later row', async () => {
    const db = engineDb();
    // Two rows, one per step: the first step matches nothing and has to hand on its last rowid.
    setBlock(db, 'playbook', 'plain text');
    setBlock(db, 'profile', db.enc('later'));
    const r = await checkKeylessOverCiphertext([{ name: 'engine.db', db: db.getDb() }], { stepRows: 1 });
    expect(r).toEqual({ state: 'missing_over_encrypted_data', stores: ['engine.db'] });
  });

  it('reads at most one step per statement, whether or not the step matches', async () => {
    const db = engineDb();
    setBlock(db, 'playbook', 'plain text');
    setBlock(db, 'profile', db.enc('later'));
    // Count the statements run against memory_blocks: one step without a match, then one with it.
    // A statement that read past its step (the whole column, or the test beside the LIMIT) would
    // find the second row in the first call.
    const real = db.getDb();
    let calls = 0;
    const counting = {
      prepare(sql: string) {
        const stmt = real.prepare(sql);
        return { get: (...args: unknown[]) => { if (sql.includes('"memory_blocks"')) calls++; return stmt.get(...args); } };
      },
    } as unknown as Database.Database;
    const r = await checkKeylessOverCiphertext([{ name: 'engine.db', db: counting }], { stepRows: 1 });
    expect(r).toEqual({ state: 'missing_over_encrypted_data', stores: ['engine.db'] });
    expect(calls).toBe(2);
  });

  it('finds ciphertext in history.db and names only the store that holds it', async () => {
    const e = engineDb();
    const h = new RunHistory(join(dir, 'history.db'), KEY);
    open.push(h);
    h.getDb().prepare(`INSERT INTO runs (id, task_text) VALUES ('r1', ?)`).run(e.enc('a task'));
    const r = await checkKeylessOverCiphertext([
      { name: 'engine.db', db: e.getDb() },
      { name: 'history.db', db: h.getDb() },
    ]);
    expect(r).toEqual({ state: 'missing_over_encrypted_data', stores: ['history.db'] });
  });

  it('gives unknown when the budget runs out', async () => {
    const db = engineDb();
    setBlock(db, 'playbook', db.enc('x'));
    let t = 0;
    const r = await checkKeylessOverCiphertext([{ name: 'engine.db', db: db.getDb() }], { budgetMs: 10, now: () => (t += 100) });
    expect(r).toEqual({ state: 'unknown' });
  });

  it('gives unknown, and does not throw, when a query fails', async () => {
    const raw = new Database(':memory:');
    open.push(raw);
    expect(await checkKeylessOverCiphertext([{ name: 'engine.db', db: raw }])).toEqual({ state: 'unknown' });
  });

  it('writes nothing', async () => {
    const db = engineDb();
    setBlock(db, 'playbook', db.enc('x'));
    const before = db.getDb().prepare('SELECT total_changes() AS n').get() as { n: number };
    await checkKeylessOverCiphertext([{ name: 'engine.db', db: db.getDb() }]);
    const after = db.getDb().prepare('SELECT total_changes() AS n').get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
