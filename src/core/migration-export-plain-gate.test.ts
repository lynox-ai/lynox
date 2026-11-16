/**
 * Without the destination's offer the export is today's: it does not decrypt the stores at all,
 * not even to throw the result away (that would hold every store's plaintext in memory for nothing).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { generateEphemeralKeypair, deriveTransferKey, deserializePublicKey, serializePublicKey } from './migration-crypto.js';

const calls = { stores: 0, ledgers: 0 };
vi.mock('./migration-plain-source.js', async (original) => {
  const real = await original<typeof import('./migration-plain-source.js')>();
  return {
    ...real,
    rewriteStoreForPlain: (...a: Parameters<typeof real.rewriteStoreForPlain>) => { calls.stores++; return real.rewriteStoreForPlain(...a); },
    rewriteLedgersForPlain: (...a: Parameters<typeof real.rewriteLedgersForPlain>) => { calls.ledgers++; return real.rewriteLedgersForPlain(...a); },
  };
});
const { MigrationExporter } = await import('./migration-export.js');

const VAULT = 'a-vault-key-for-the-plain-gate-test-2026';
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); calls.stores = 0; calls.ledgers = 0; });

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
