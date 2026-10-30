import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { MigrationExporter } from './migration-export.js';
import { MigrationImporter } from './migration-import.js';
import {
  generateEphemeralKeypair,
  serializePublicKey,
  deserializePublicKey,
  deriveTransferKey,
} from './migration-crypto.js';

// A restore swaps the bundle's databases in only once every one of them is staged and checked, and
// applies the config after that: a failure on the way leaves every database and the config as they
// were. See migration-import.ts (`stageDatabases`, `drainDestination`).

const VAULT_KEY = 'two-phase-restore-test-key-2026';
const DBS = ['engine.db', 'history.db', 'datastore.db', 'agent-memory.db'] as const;
const NEW_HALF_LIFE = 11;
const OLD_HALF_LIFE = 99;

// Each test seeds two data dirs and runs a full export and import: seconds on a loaded machine.
describe('migration restore — databases swap in together, config after them', { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  const holders: Database.Database[] = [];

  afterEach(() => {
    for (const h of holders.splice(0)) { try { h.close(); } catch { /* closed */ } }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'lynox-restore-2phase-'));
    dirs.push(d);
    return d;
  }

  /** The four databases, each carrying `tag`, and a config with a field the restore merges. */
  function seed(dir: string, tag: 'new' | 'old'): void {
    new EngineDb(join(dir, 'engine.db'), VAULT_KEY).close();
    for (const db of DBS) {
      const d = new Database(join(dir, db));
      try {
        d.exec('CREATE TABLE IF NOT EXISTS zz_mark (v TEXT)');
        d.prepare('INSERT INTO zz_mark (v) VALUES (?)').run(tag);
      } finally {
        d.close();
      }
    }
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ memory_half_life_days: tag === 'new' ? NEW_HALF_LIFE : OLD_HALF_LIFE }));
  }

  function markOf(path: string): string {
    const d = new Database(path, { readonly: true });
    try {
      return (d.prepare('SELECT v FROM zz_mark').get() as { v: string }).v;
    } finally {
      d.close();
    }
  }

  const marks = (dir: string, names: readonly string[] = DBS): Record<string, string> =>
    Object.fromEntries(names.map((db) => [db, markOf(join(dir, db))]));
  const halfLife = (dir: string): unknown =>
    (JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as { memory_half_life_days?: unknown }).memory_half_life_days;
  const leftovers = (dir: string): string[] => readdirSync(dir).filter((f) => f.includes('migration-tmp') || f.includes('.corrupt-'));

  /** A full bundle from `src`, received by an importer on `dst`; `damage` may alter a chunk before the restore. */
  function receive(src: string, dst: string, damage?: (chunkOf: (name: string) => Buffer) => void): MigrationImporter {
    const importer = new MigrationImporter({ lynoxDir: dst, vaultKey: VAULT_KEY });
    const handshake = importer.startHandshake('b'.repeat(64));
    const keypair = generateEphemeralKeypair();
    const key = deriveTransferKey(keypair.privateKey, deserializePublicKey(handshake.serverPubKey), Buffer.from(handshake.challengeNonce, 'hex'));
    importer.completeHandshake(serializePublicKey(keypair.publicKey));
    const { manifest, chunks } = new MigrationExporter({ lynoxDir: src, vaultKey: VAULT_KEY }).export(key);
    importer.setManifest(manifest);
    for (const chunk of chunks) importer.receiveChunk(chunk);
    if (damage) {
      // The decrypted chunk as the importer holds it: what a damaged database in the bundle looks like.
      const received = (importer as unknown as { session: { receivedChunks: Map<number, Buffer> } }).session.receivedChunks;
      damage((name) => {
        const meta = manifest.chunks.find((c) => c.name === name);
        if (!meta) throw new Error(`fixture: no chunk ${name}`);
        return received.get(meta.seq)!;
      });
    }
    return importer;
  }

  /** The fourth database of the bundle fails its integrity check: page 2 onward overwritten, header intact. */
  const damageFourth = (chunkOf: (name: string) => Buffer): void => {
    const buf = chunkOf('agent-memory.db');
    expect(buf.length, 'fixture: agent-memory.db spans more than one page').toBeGreaterThan(4096);
    buf.fill(0x55, 4096);
  };

  /** A file SQLite cannot read as a database, with a `-wal` beside it. */
  function makeUnreadable(dst: string, name: string): Buffer {
    const garbage = Buffer.alloc(8192, 0x5a);
    rmSync(join(dst, name));
    writeFileSync(join(dst, name), garbage);
    writeFileSync(join(dst, `${name}-wal`), Buffer.alloc(4096, 0x5b));
    return garbage;
  }

  it('swaps all four databases in and applies the config', () => {
    const src = tmp(); const dst = tmp();
    seed(src, 'new'); seed(dst, 'old');

    const verification = receive(src, dst).restore();

    expect(verification.databasesRestored).toEqual([...DBS]);
    expect(marks(dst)).toEqual({ 'engine.db': 'new', 'history.db': 'new', 'datastore.db': 'new', 'agent-memory.db': 'new' });
    expect(halfLife(dst)).toBe(NEW_HALF_LIFE);
    expect(leftovers(dst)).toEqual([]);
  });

  it('a fourth database that fails its integrity check leaves all four and the config as they were', () => {
    const src = tmp(); const dst = tmp();
    seed(src, 'new'); seed(dst, 'old');

    expect(() => receive(src, dst, damageFourth).restore()).toThrow(/integrity check failed for agent-memory\.db/);

    expect(marks(dst)).toEqual({ 'engine.db': 'old', 'history.db': 'old', 'datastore.db': 'old', 'agent-memory.db': 'old' });
    expect(halfLife(dst), 'config not applied').toBe(OLD_HALF_LIFE);
    expect(leftovers(dst), 'staged copies removed').toEqual([]);
  });

  it('a fourth destination that is a directory leaves the other three and the config as they were', () => {
    const src = tmp(); const dst = tmp();
    seed(src, 'new'); seed(dst, 'old');
    rmSync(join(dst, 'agent-memory.db'));
    mkdirSync(join(dst, 'agent-memory.db'));
    writeFileSync(join(dst, 'agent-memory.db', 'keep'), 'x');

    expect(() => receive(src, dst).restore()).toThrow();

    expect(marks(dst, ['engine.db', 'history.db', 'datastore.db'])).toEqual({ 'engine.db': 'old', 'history.db': 'old', 'datastore.db': 'old' });
    expect(readFileSync(join(dst, 'agent-memory.db', 'keep'), 'utf-8')).toBe('x');
    expect(halfLife(dst), 'config not applied').toBe(OLD_HALF_LIFE);
    expect(leftovers(dst), 'nothing staged or moved aside').toEqual([]);
  });

  it('restores over a -wal a crash left on a database nothing holds open', () => {
    const src = tmp(); const dst = tmp();
    seed(src, 'new'); seed(dst, 'old');
    // A process writes agent-memory.db in WAL mode and dies without closing it.
    const crash = spawnSync(process.execPath, ['-e', `
      const Database = require('better-sqlite3');
      const db = new Database(${JSON.stringify(join(dst, 'agent-memory.db'))});
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 0');
      db.prepare('INSERT INTO zz_mark (v) VALUES (?)').run('crash');
      process.kill(process.pid, 'SIGKILL');
    `], { cwd: process.cwd() });
    expect(crash.signal, `fixture: the writer must die by SIGKILL (${crash.stderr.toString()})`).toBe('SIGKILL');
    expect(statSync(join(dst, 'agent-memory.db-wal')).size, 'fixture: a -wal with frames is left behind').toBeGreaterThan(0);

    receive(src, dst).restore();

    expect(marks(dst)).toEqual({ 'engine.db': 'new', 'history.db': 'new', 'datastore.db': 'new', 'agent-memory.db': 'new' });
    expect(existsSync(join(dst, 'agent-memory.db-wal')), 'no -wal beside the restored database').toBe(false);
    expect(halfLife(dst)).toBe(NEW_HALF_LIFE);
  });

  it('replaces a write-protected destination without a -wal, as a plain rename always did', () => {
    const src = tmp(); const dst = tmp();
    seed(src, 'new'); seed(dst, 'old');
    // In WAL mode, as run history opens it: a read-write open of a write-protected WAL database
    // falls back to read-only and leaves a -wal behind.
    const wal = new Database(join(dst, 'history.db'));
    wal.pragma('journal_mode = WAL');
    wal.close();
    chmodSync(join(dst, 'history.db'), 0o444);
    expect(existsSync(join(dst, 'history.db-wal')), 'fixture: no -wal beside it').toBe(false);

    receive(src, dst).restore();

    expect(marks(dst)).toEqual({ 'engine.db': 'new', 'history.db': 'new', 'datastore.db': 'new', 'agent-memory.db': 'new' });
    expect(halfLife(dst)).toBe(NEW_HALF_LIFE);
  });

  it('replaces a symlink to a directory, as a plain rename always did', () => {
    const src = tmp(); const dst = tmp(); const elsewhere = tmp();
    seed(src, 'new'); seed(dst, 'old');
    rmSync(join(dst, 'datastore.db'));
    symlinkSync(elsewhere, join(dst, 'datastore.db'));

    receive(src, dst).restore();

    expect(lstatSync(join(dst, 'datastore.db')).isFile(), 'the link itself was replaced').toBe(true);
    expect(marks(dst)).toEqual({ 'engine.db': 'new', 'history.db': 'new', 'datastore.db': 'new', 'agent-memory.db': 'new' });
  });

  it('restores over a -wal whose database is gone', () => {
    const src = tmp(); const dst = tmp();
    seed(src, 'new'); seed(dst, 'old');
    rmSync(join(dst, 'agent-memory.db'));
    writeFileSync(join(dst, 'agent-memory.db-wal'), Buffer.alloc(4096, 0x5b));

    receive(src, dst).restore();

    expect(marks(dst)).toEqual({ 'engine.db': 'new', 'history.db': 'new', 'datastore.db': 'new', 'agent-memory.db': 'new' });
    expect(existsSync(join(dst, 'agent-memory.db-wal'))).toBe(false);
    expect(leftovers(dst)).toEqual([]);
  });

  it('a destination another connection holds open stops the restore before anything is swapped in', () => {
    const src = tmp(); const dst = tmp();
    seed(src, 'new'); seed(dst, 'old');
    const holder = new Database(join(dst, 'datastore.db'));
    holders.push(holder);
    holder.pragma('journal_mode = WAL');
    holder.prepare('INSERT INTO zz_mark (v) VALUES (?)').run('held');

    expect(() => receive(src, dst).restore()).toThrow(/datastore\.db is still open elsewhere/);

    holder.close();
    expect(marks(dst)).toEqual({ 'engine.db': 'old', 'history.db': 'old', 'datastore.db': 'old', 'agent-memory.db': 'old' });
    expect(halfLife(dst), 'config not applied').toBe(OLD_HALF_LIFE);
    expect(leftovers(dst)).toEqual([]);
  });

  it('a destination SQLite cannot read is moved aside under the boot\'s corrupt name, its -wal with it', () => {
    const src = tmp(); const dst = tmp();
    seed(src, 'new'); seed(dst, 'old');
    const garbage = makeUnreadable(dst, 'datastore.db');

    receive(src, dst).restore();

    expect(marks(dst)).toEqual({ 'engine.db': 'new', 'history.db': 'new', 'datastore.db': 'new', 'agent-memory.db': 'new' });
    expect(halfLife(dst)).toBe(NEW_HALF_LIFE);
    expect(existsSync(join(dst, 'datastore.db-wal')), 'the old -wal is not beside the restored database').toBe(false);
    // The -wal travels only if the check never opened the file read-write: a read-write connection
    // closing on a file that is no database deletes the -wal beside it.
    const aside = readdirSync(dst).filter((f) => /^datastore\.db\.corrupt-\d+$/.test(f));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dst, aside[0]!)).equals(garbage)).toBe(true);
    expect(existsSync(join(dst, `${aside[0]!}-wal`)), 'the -wal moved with it').toBe(true);
  });

  it.each([
    ['its integrity check (before any destination is checked)', 'integrity' as const, /integrity check failed for agent-memory\.db/],
    ['its destination being held open (checked after the unreadable one)', 'held' as const, /agent-memory\.db is still open elsewhere/],
  ])('an unreadable destination stays where it is when the fourth database fails %s', (_label, failure, thrown) => {
    const src = tmp(); const dst = tmp();
    seed(src, 'new'); seed(dst, 'old');
    const garbage = makeUnreadable(dst, 'datastore.db');
    if (failure === 'held') {
      const holder = new Database(join(dst, 'agent-memory.db'));
      holders.push(holder);
      holder.pragma('journal_mode = WAL');
      holder.prepare('INSERT INTO zz_mark (v) VALUES (?)').run('held');
    }

    expect(() => receive(src, dst, failure === 'integrity' ? damageFourth : undefined).restore()).toThrow(thrown);
    for (const h of holders.splice(0)) h.close();

    expect(readFileSync(join(dst, 'datastore.db')).equals(garbage), 'the unreadable database is untouched').toBe(true);
    expect(existsSync(join(dst, 'datastore.db-wal'))).toBe(true);
    expect(marks(dst, ['engine.db', 'history.db', 'agent-memory.db'])).toEqual({ 'engine.db': 'old', 'history.db': 'old', 'agent-memory.db': 'old' });
    expect(halfLife(dst), 'config not applied').toBe(OLD_HALF_LIFE);
    expect(leftovers(dst), 'nothing staged or moved aside').toEqual([]);
  });
});
