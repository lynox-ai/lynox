/**
 * Without the destination's offer the export is today's: it does not decrypt the stores at all,
 * not even to throw the result away (that would hold every store's plaintext in memory for nothing).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { generateEphemeralKeypair, deriveTransferKey, deserializePublicKey, serializePublicKey } from './migration-crypto.js';

const calls = { stores: 0, ledgers: 0 };
/** Every plaintext buffer the source makes: the framed payloads and the bodies they were framed from. */
const held: { payloads: Buffer[]; bodies: Buffer[] } = { payloads: [], bodies: [] };
vi.mock('./migration-rekey.js', async (original) => {
  const real = await original<typeof import('./migration-rekey.js')>();
  return { ...real, encodePlainPayload: <T,>(h: Parameters<typeof real.encodePlainPayload<T>>[0], body: Buffer) => { held.bodies.push(body); return real.encodePlainPayload(h, body); } };
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
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); calls.stores = 0; calls.ledgers = 0; held.payloads.length = 0; held.bodies.length = 0; vi.restoreAllMocks(); });

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
      const d = new Database(join(dir, 'engine.db'));
      d.exec('CREATE TABLE filler (v TEXT)');
      d.prepare('INSERT INTO filler (v) VALUES (?)').run('f'.repeat(9 * 1024 * 1024));
      d.close();
    }
  }
  const expectZeroed = (): void => {
    expect(held.payloads.length).toBe(2);
    expect(held.bodies.length).toBe(2);
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
    expectZeroed();
  });

  it('on the raw path', () => {
    source();
    const r = new MigrationExporter({ lynoxDir: dir, vaultKey: VAULT }).export(key(), undefined, { plain: { ceiling: TIGHT } });
    expect(r.plain?.stores.map(s => s.path)).toEqual(['raw', 'raw']);
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

