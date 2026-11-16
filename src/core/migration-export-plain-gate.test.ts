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

const calls = { stores: 0, ledgers: 0 };
/** Every plaintext buffer the source makes: the framed payloads and the bodies they were framed from. */
const held: { payloads: Buffer[]; bodies: Buffer[] } = { payloads: [], bodies: [] };
vi.mock('./migration-rekey.js', async (original) => {
  const real = await original<typeof import('./migration-rekey.js')>();
  return { ...real, encodePlainPayload: <T,>(h: Parameters<typeof real.encodePlainPayload<T>>[0], body: Buffer) => { held.bodies.push(body); return real.encodePlainPayload(h, body); } };
});
const failEncrypt = { on: false };
vi.mock('./migration-crypto.js', async (original) => {
  const real = await original<typeof import('./migration-crypto.js')>();
  return { ...real, encryptChunk: (...a: Parameters<typeof real.encryptChunk>) => { if (failEncrypt.on) throw new Error('encrypt failed'); return real.encryptChunk(...a); } };
});
vi.mock('./migration-plain-source.js', async (original) => {
  const real = await original<typeof import('./migration-plain-source.js')>();
  return {
    ...real,
    rewriteStoreForPlain: (...a: Parameters<typeof real.rewriteStoreForPlain>) => { calls.stores++; const r = real.rewriteStoreForPlain(...a); held.payloads.push(r.payload); return r; },
    rewriteLedgersForPlain: (...a: Parameters<typeof real.rewriteLedgersForPlain>) => { calls.ledgers++; const r = real.rewriteLedgersForPlain(...a); if (r) held.payloads.push(r.payload); return r; },
  };
});
const { MigrationExporter } = await import('./migration-export.js');

const VAULT = 'a-vault-key-for-the-plain-gate-test-2026';
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); calls.stores = 0; calls.ledgers = 0; held.payloads.length = 0; held.bodies.length = 0; failEncrypt.on = false; vi.restoreAllMocks(); });

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

  it('on the raw path', () => {
    source();
    const r = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: TIGHT } });
    expect(r.plain?.stores.map(s => s.path)).toEqual(['raw', 'raw']);
    expectZeroed();
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
    expectZeroed();
  });

  it('when a chunk fails to encrypt', () => {
    source();
    failEncrypt.on = true;
    expect(() => new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: ROOMY } })).toThrow('encrypt failed');
    expectZeroed();
  });

  it('when a later collector throws', () => {
    source();
    const proto = MigrationExporter.prototype as unknown as { collectConfig: () => unknown };
    vi.spyOn(proto, 'collectConfig').mockImplementation(() => { throw new Error('config unreadable'); });
    expect(() => new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: ROOMY } })).toThrow('config unreadable');
    expectZeroed();
  });
});

