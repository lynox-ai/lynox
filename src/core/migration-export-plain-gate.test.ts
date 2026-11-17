/**
 * Without the destination's offer the export is today's: it does not decrypt the stores at all,
 * not even to throw the result away (that would hold every store's plaintext in memory for nothing).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { EngineDb, deriveEngineEncKey } from './engine-db.js';
import { encryptStoredText } from './migration-rekey.js';
import { RunHistory } from './run-history.js';
import { generateEphemeralKeypair, deriveTransferKey, deserializePublicKey, serializePublicKey } from './migration-crypto.js';

const calls = { stores: 0, ledgers: 0, rewritten: [] as string[], judged: [] as Array<{ store: string; input: { rawBytes: number; othersBytes: number; restBytes: number; maxTotalBytes: number } }> };
/** Every plaintext buffer the source makes: the framed payloads and the bodies they were framed from. */
const held: { payloads: Buffer[]; bodies: Buffer[] } = { payloads: [], bodies: [] };
vi.mock('./migration-rekey.js', async (original) => {
  const real = await original<typeof import('./migration-rekey.js')>();
  return { ...real, encodePlainPayload: <T,>(h: Parameters<typeof real.encodePlainPayload<T>>[0], body: Buffer) => { held.bodies.push(body); return real.encodePlainPayload(h, body); } };
});
const failEncrypt = { on: false };
/** engine.db's raw size in the current test, so the judged inputs can be told apart. */
const engineRaw = { bytes: -1 };
vi.mock('./migration-crypto.js', async (original) => {
  const real = await original<typeof import('./migration-crypto.js')>();
  return { ...real, encryptChunk: (...a: Parameters<typeof real.encryptChunk>) => { if (failEncrypt.on) throw new Error('encrypt failed'); return real.encryptChunk(...a); } };
});
vi.mock('./migration-plain-source.js', async (original) => {
  const real = await original<typeof import('./migration-plain-source.js')>();
  return {
    ...real,
    plainFormRefusal: (input: Parameters<typeof real.plainFormRefusal>[0]) => { calls.judged.push({ store: input.rawBytes === engineRaw.bytes ? 'engine.db' : 'other', input: { ...input } }); return real.plainFormRefusal(input); },
    rewriteStoreForPlain: (...a: Parameters<typeof real.rewriteStoreForPlain>) => { calls.stores++; calls.rewritten.push(a[1]); const r = real.rewriteStoreForPlain(...a); held.payloads.push(r.payload); return r; },
    rewriteLedgersForPlain: (...a: Parameters<typeof real.rewriteLedgersForPlain>) => { calls.ledgers++; const r = real.rewriteLedgersForPlain(...a); if (r) held.payloads.push(r.payload); return r; },
  };
});
const { MigrationExporter } = await import('./migration-export.js');

const VAULT = 'a-vault-key-for-the-plain-gate-test-2026';
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); calls.stores = 0; calls.ledgers = 0; calls.rewritten.length = 0; calls.judged.length = 0; engineRaw.bytes = -1; held.payloads.length = 0; held.bodies.length = 0; failEncrypt.on = false; vi.restoreAllMocks(); });

function key(): Buffer {
  const a = generateEphemeralKeypair(); const b = generateEphemeralKeypair();
  return deriveTransferKey(a.privateKey, deserializePublicKey(serializePublicKey(b.publicKey)), Buffer.alloc(32, 1));
}

describe('the export decrypts the stores only on the destination\'s offer', () => {
  it('does not rewrite a store without the offer, and does with it', () => {
    dir = mkdtempSync(join(tmpdir(), 'mig-gate-'));
    new EngineDb(join(dir, 'engine.db'), VAULT).close();
    new RunHistory(join(dir, 'history.db'), VAULT).close();
    const exporter = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT });
    exporter.export(key());
    expect(calls.stores).toBe(0);
    exporter.export(key(), undefined, { plain: { ceiling: { import_limit_mb: 100_000, baseline_mb: 1, k: 1.5, rest_factor: 1 } } });
    expect(calls.stores).toBe(2);
  });
});

describe('the export zeroes every plaintext buffer it made, whichever path a store takes', () => {
  const ROOMY = { import_limit_mb: 100_000, baseline_mb: 0, k: 1, rest_factor: 1 };
  const TIGHT = { import_limit_mb: 1, baseline_mb: 0, k: 1, rest_factor: 1 };
  const zero = (b: Buffer): boolean => b.length > 0 && b.every(x => x === 0);

  function source(opts: { filler?: boolean } = {}): void {
    dir = mkdtempSync(join(tmpdir(), 'mig-zero-'));
    new EngineDb(join(dir, 'engine.db'), VAULT).close();
    new RunHistory(join(dir, 'history.db'), VAULT).close();
    if (opts.filler) {
      // A merge ledger with one contact cell and a filler, written as the merge runner writes it.
      const key = deriveEngineEncKey(VAULT);
      mkdirSync(join(dir, 'sweeps'));
      writeFileSync(join(dir, 'sweeps', 'merge-2026-11-16T00-00-00-000Z-abc123.json'), JSON.stringify({
        version: 1, phase: 'merge', createdAt: '2026-11-16T00:00:00.000Z',
        entry: {
          dupId: 'd', canonicalId: 'c', kind: 'person', ownerUserId: 'u', dupArchivedAtWas: null, dupMergedIntoWas: null,
          canonicalAliasesWas: '[]', canonicalParentWasDup: false, repoints: [], memorySubjects: { dupRows: [], canonicalMemoryIdsBefore: [] }, cooccurrences: [],
          detail: { table: 'people', dupRow: { subject_id: 'd', email: encryptStoredText('d@example.org', key), phone: '' }, canonicalRow: { subject_id: 'c', email: '', phone: '' } },
        },
        dataStore: [], threadAnchors: [], applied: true, pad: 'f'.repeat(9 * 1024 * 1024),
      }, null, 2));
      key.fill(0);
      const d = new Database(join(dir, 'engine.db'));
      d.exec('CREATE TABLE filler (v TEXT)');
      d.prepare('INSERT INTO filler (v) VALUES (?)').run('f'.repeat(9 * 1024 * 1024));
      d.close();
    }
  }
  const expectZeroed = (n = 2): void => {
    expect(held.payloads.length).toBe(n);
    expect(held.bodies.length).toBe(n);
    for (const b of [...held.payloads, ...held.bodies]) expect(zero(b)).toBe(true);
  };

  it('on the plaintext path in one part', () => {
    source();
    new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: ROOMY } });
    expectZeroed();
  });

  it('on the plaintext path in several parts', () => {
    source({ filler: true });
    const { manifest } = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: ROOMY } });
    expect(manifest.chunks.filter(c => c.type === 'sqlite_db_plain' && c.name.startsWith('engine.db')).length).toBeGreaterThan(1);
    expect(manifest.chunks.filter(c => c.type === 'sweeps' && c.name.startsWith('sweeps:part')).length).toBeGreaterThan(1);
    expect(manifest.chunks.find(c => c.name === 'sweeps:part0')?.ledgerForm).toBe('plain');
    expectZeroed(3);
  });

  it('on the raw path, after the plaintext forms were built', () => {
    source();
    // The source's bound sits exactly at the bundle with every store raw: the forms are built (the
    // stores pass the check before the rewrite), the plaintext forms are larger, so all go raw.
    const raw = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key()).manifest.chunks.reduce((n, c) => n + c.originalSize, 0);
    const r = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT, bounds: { maxChunks: 64, maxTotalBytes: raw } }).export(key(), undefined, { plain: { ceiling: ROOMY } });
    expect(r.plain?.stores.map(s => [s.path, s.reason])).toEqual([['raw', 'bounds'], ['raw', 'bounds']]);
    expectZeroed();
  });

  it('does not build the merge ledgers\' plaintext form when engine.db has none', () => {
    source({ filler: true });
    const r = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: TIGHT } });
    expect(r.plain?.ledgers?.path).toBe('raw');
    expect(calls.stores).toBe(0);
    expect(calls.ledgers).toBe(0);
    // Control: with room, both are built.
    new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: ROOMY } });
    expect(calls.ledgers).toBe(1);
  });

  it('does not build the merge ledgers\' plaintext form when their raw form is over the sweeps cap', () => {
    source({ filler: true });
    // The raw ledgers are a little over 9 MiB here; a cap below that leaves engine.db raw with them.
    const r = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT, sweepsCapBytes: 8 * 1024 * 1024 }).export(key(), undefined, { plain: { ceiling: ROOMY } });
    expect(calls.ledgers).toBe(0);
    expect(r.plain?.stores.find((s) => s.store === 'engine.db')).toMatchObject({ path: 'raw', reason: 'ledgers' });
    // Control: with the cap above them, they are built.
    new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT, sweepsCapBytes: 64 * 1024 * 1024 }).export(key(), undefined, { plain: { ceiling: ROOMY } });
    expect(calls.ledgers).toBe(1);
  });

  it('on the raw path, without building a plaintext form', () => {
    source();
    const r = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: TIGHT } });
    expect(r.plain?.stores.map(s => s.path)).toEqual(['raw', 'raw']);
    expect(calls.stores).toBe(0);
    expectZeroed(0);
  });

  it('when a database after the two stores fails to snapshot', () => {
    source();
    const ds = new Database(join(dir, 'datastore.db'));
    ds.exec('CREATE TABLE t (v)');
    ds.close();
    const proto = MigrationExporter.prototype as unknown as { snapshotDatabase: (n: string) => Buffer | null };
    const original = proto.snapshotDatabase;
    vi.spyOn(proto, 'snapshotDatabase').mockImplementation(function (this: unknown, n: string) {
      if (n === 'datastore.db') throw new Error('snapshot failed');
      return original.call(this, n);
    });
    expect(() => new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: ROOMY } })).toThrow('snapshot failed');
    // The plaintext forms are built only after every chunk is collected: none exists yet.
    expect(calls.stores).toBe(0);
    expectZeroed(0);
  });

  it('when a chunk fails to encrypt', () => {
    source();
    failEncrypt.on = true;
    // A chunk outside the stores, held to see that it is zeroed too.
    const proto = MigrationExporter.prototype as unknown as { collectConfig: () => { data: Buffer } | null };
    const original = proto.collectConfig;
    const config: Buffer[] = [];
    vi.spyOn(proto, 'collectConfig').mockImplementation(function (this: unknown) { const c = original.call(this); if (c) config.push(c.data); return c; });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
    expect(() => new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: ROOMY } })).toThrow('encrypt failed');
    expectZeroed();
    expect(config).toHaveLength(1);
    expect(zero(config[0]!)).toBe(true);
  });

  it('when a later collector throws, no plaintext form has been built yet', () => {
    source({ filler: true });
    const proto = MigrationExporter.prototype as unknown as { collectConfig: () => unknown };
    vi.spyOn(proto, 'collectConfig').mockImplementation(() => { throw new Error('config unreadable'); });
    expect(() => new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: ROOMY } })).toThrow('config unreadable');
    expect(calls.stores + calls.ledgers).toBe(0);
    expectZeroed(0);
  });

  it('when the merge ledgers\' rewrite throws, the stores\' plaintext forms included', () => {
    source({ filler: true });
    const proto = MigrationExporter.prototype as unknown as { plainLedgers: () => unknown };
    vi.spyOn(proto, 'plainLedgers').mockImplementation(() => { throw new Error('ledgers unreadable'); });
    expect(() => new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: ROOMY } })).toThrow('ledgers unreadable');
    expectZeroed(2);
  });
});

describe('a store is judged by its raw size before its plaintext form is built', () => {
  const MIB = 1024 * 1024;
  /** A source with both stores; engine.db's raw size recorded (its snapshot is the file's pages). */
  function source(): void {
    dir = mkdtempSync(join(tmpdir(), 'mig-bound-'));
    new EngineDb(join(dir, 'engine.db'), VAULT).close();
    new RunHistory(join(dir, 'history.db'), VAULT).close();
    const d = new Database(join(dir, 'engine.db'));
    d.exec('CREATE TABLE filler (v TEXT)');
    d.prepare('INSERT INTO filler (v) VALUES (?)').run('f'.repeat(256 * 1024));
    d.close();
  }
  /** What the export judged engine.db by, from one export with room for everything. */
  function engineInput(): { rawBytes: number; othersBytes: number; restBytes: number; maxTotalBytes: number } {
    const proto = MigrationExporter.prototype as unknown as { snapshotDatabase: (n: string) => Buffer | null };
    const original = proto.snapshotDatabase;
    const spy = vi.spyOn(proto, 'snapshotDatabase').mockImplementation(function (this: unknown, n: string) {
      const b = original.call(this, n);
      if (n === 'engine.db' && b) engineRaw.bytes = b.length;
      return b;
    });
    new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: { import_limit_mb: 100_000, baseline_mb: 0, k: 1, rest_factor: 0 } } });
    spy.mockRestore();
    const judged = calls.judged.find((j) => j.store === 'engine.db');
    expect(judged).toBeDefined();
    calls.judged.length = 0; calls.rewritten.length = 0; calls.stores = 0;
    return judged!.input;
  }

  it('against the destination\'s numbers: at the bound the store is rewritten, one byte over it is not', () => {
    source();
    const at = engineInput();
    // k 1, no baseline, no rest factor: the largest store is the limit minus everything else, to the byte.
    const limitMb = (bytes: number): number => bytes / MIB;
    const exactly = { import_limit_mb: limitMb(at.rawBytes + at.othersBytes), baseline_mb: 0, k: 1, rest_factor: 0 };
    const under = { ...exactly, import_limit_mb: limitMb(at.rawBytes + at.othersBytes - 1) };
    new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: exactly } });
    expect(calls.rewritten).toContain('engine.db');
    calls.rewritten.length = 0;
    const r = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: under } });
    expect(calls.rewritten).not.toContain('engine.db');
    expect(r.plain?.stores.find((s) => s.store === 'engine.db')).toMatchObject({ path: 'raw', reason: 'memory' });
  });

  it('against the source\'s own size bound, whatever the destination announces', () => {
    source();
    const at = engineInput();
    const vast = { import_limit_mb: 1e12, baseline_mb: 0, k: 1, rest_factor: 0 };
    // The bound sits exactly at the bundle with engine.db raw: rewritten. One byte less: not rewritten.
    new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT, bounds: { maxChunks: 64, maxTotalBytes: at.rawBytes + at.othersBytes } }).export(key(), undefined, { plain: { ceiling: vast } });
    expect(calls.rewritten).toContain('engine.db');
    calls.rewritten.length = 0;
    const exporter = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT, bounds: { maxChunks: 64, maxTotalBytes: at.rawBytes + at.othersBytes - 1 } });
    // The bundle is then over the source's bound in any form, so the export refuses; the store was never rewritten.
    expect(() => exporter.export(key(), undefined, { plain: { ceiling: vast } })).toThrow('does not fit one migration');
    expect(calls.rewritten).not.toContain('engine.db');
  });

  it('against this instance\'s own memory: a rewrite that would go over it is not started', () => {
    source();
    const at = engineInput();
    const vast = { import_limit_mb: 1e12, baseline_mb: 0, k: 1, rest_factor: 0 };
    // Resident 100 MiB, so the limit sits exactly at 100 + kSource * engine.db.
    const fits = 100 + (7.0 * at.rawBytes) / MIB;
    const own = (limitMb: number) => ({ limitMb: () => limitMb, rssMb: () => 100 });
    new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT, ownMemory: own(fits) }).export(key(), undefined, { plain: { ceiling: vast } });
    expect(calls.rewritten).toContain('engine.db');
    calls.rewritten.length = 0;
    const r = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT, ownMemory: own(fits - 0.001) }).export(key(), undefined, { plain: { ceiling: vast } });
    expect(calls.rewritten).not.toContain('engine.db');
    expect(r.plain?.stores.find((s) => s.store === 'engine.db')).toMatchObject({ path: 'raw', reason: 'source-memory' });
  });

  it('a store refused before its rewrite is reported with the reason', () => {
    source();
    const r = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: { import_limit_mb: 0.001, baseline_mb: 0, k: 1, rest_factor: 0 } } });
    expect(calls.stores).toBe(0);
    expect(r.plain?.stores.map((s) => [s.store, s.path, s.reason])).toEqual([['engine.db', 'raw', 'memory'], ['history.db', 'raw', 'memory']]);
  });
});
