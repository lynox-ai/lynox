import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SecretVault } from './secret-vault.js';
import { MigrationExporter } from './migration-export.js';
import { MigrationImporter } from './migration-import.js';
import {
  computeManifestHash,
  deriveTransferKey,
  deserializePublicKey,
  generateEphemeralKeypair,
  serializePublicKey,
  MIGRATION_MAX_CHUNKS,
  MIGRATION_MAX_TOTAL_BYTES,
  type MigrationChunkMeta,
} from './migration-crypto.js';

const SRC_KEY = 's'.repeat(48);
const DST_KEY = 'd'.repeat(48);
const TOKEN = 'b'.repeat(64);

let src: string;
let dst: string;

beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), 'lynox-bounds-src-'));
  dst = mkdtempSync(join(tmpdir(), 'lynox-bounds-dst-'));
  const vault = new SecretVault({ path: join(src, 'vault.db'), masterKey: SRC_KEY });
  vault.set('A_KEY', 'a-value', 'any', 0);
  vault.close();
  for (const name of ['history.db', 'engine.db']) {
    const db = new Database(join(src, name));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run(`row of ${name}`);
    db.close();
  }
  writeFileSync(join(src, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
});

afterEach(() => {
  rmSync(src, { recursive: true, force: true });
  rmSync(dst, { recursive: true, force: true });
});

function transferKey(): Buffer {
  const importer = new MigrationImporter({ lynoxDir: dst, vaultKey: DST_KEY });
  const server = importer.startHandshake(TOKEN);
  const client = generateEphemeralKeypair();
  const key = deriveTransferKey(client.privateKey, deserializePublicKey(server.serverPubKey), Buffer.from(server.challengeNonce, 'hex'));
  importer.completeHandshake(serializePublicKey(client.publicKey));
  importer.cleanup();
  return key;
}

/** The export this fixture makes under the real bounds: its chunk count and total size. */
function measure(): { chunks: number; bytes: number } {
  const { manifest } = new MigrationExporter({ lynoxDir: src, vaultKey: SRC_KEY }).export(transferKey());
  return { chunks: manifest.totalChunks, bytes: manifest.chunks.reduce((s, c) => s + c.originalSize, 0) };
}

function exportWith(bounds: { maxChunks: number; maxTotalBytes: number }): { phases: string[]; run: () => unknown } {
  const phases: string[] = [];
  const exporter = new MigrationExporter({ lynoxDir: src, vaultKey: SRC_KEY, bounds });
  const key = transferKey();
  return { phases, run: () => exporter.export(key, (p) => { phases.push(p.phase); }) };
}

describe('the source checks the migration bounds before it encrypts anything', () => {
  it('refuses one chunk over the count, names the bound, and encrypts nothing; takes it at the count', () => {
    const { chunks, bytes } = measure();
    expect(chunks).toBeGreaterThan(1);

    const over = exportWith({ maxChunks: chunks - 1, maxTotalBytes: bytes });
    expect(over.run).toThrow(`it needs ${String(chunks)} chunks, and a migration carries at most ${String(chunks - 1)}`);
    expect(over.phases).not.toContain('encrypting');
    expect(over.phases).toContain('collecting');

    const at = exportWith({ maxChunks: chunks, maxTotalBytes: bytes });
    expect(at.run).not.toThrow();
    expect(at.phases).toContain('done');
  });

  it('refuses one byte over the total, names the bound, and encrypts nothing; takes it at the total', () => {
    const { chunks, bytes } = measure();

    const over = exportWith({ maxChunks: chunks, maxTotalBytes: bytes - 1 });
    // Under 0.1 MiB apart both sizes read the same in MiB, so the refusal gives them in bytes.
    expect(over.run).toThrow(`This instance's data does not fit one migration: it is ${String(bytes)} bytes, and a migration carries at most ${String(bytes - 1)} bytes. None of your data was sent, and the data on this instance is unchanged. A migration cannot move only part of it; write to support@lynox.ai with this message and we will look at it with you.`);
    expect(over.phases).not.toContain('encrypting');

    const at = exportWith({ maxChunks: chunks, maxTotalBytes: bytes });
    expect(at.run).not.toThrow();
  });

  it('gives the sizes in MiB where they read apart, and names both bounds when both are exceeded', () => {
    const db = new Database(join(src, 'history.db'));
    db.prepare('INSERT INTO t (v) VALUES (?)').run('x'.repeat(300 * 1024));
    db.close();
    const { chunks } = measure();
    const both = exportWith({ maxChunks: chunks - 1, maxTotalBytes: 1 });
    expect(both.run).toThrow(`it needs ${String(chunks)} chunks, and a migration carries at most ${String(chunks - 1)} (each kind of data starts its own chunks of up to 8 MiB); it is 0.3 MiB, and a migration carries at most 0.0 MiB. None of your data was sent, and the data on this instance is unchanged. A migration cannot move only part of it; write to support@lynox.ai with this message and we will look at it with you.`);
  });

  it('uses the bounds the destination enforces when no override is given', () => {
    const exporter = new MigrationExporter({ lynoxDir: src, vaultKey: SRC_KEY });
    expect((exporter as unknown as { bounds: unknown }).bounds).toEqual({ maxChunks: MIGRATION_MAX_CHUNKS, maxTotalBytes: MIGRATION_MAX_TOTAL_BYTES });
  });
});

describe('the destination enforces the same bounds', () => {
  function refusal(chunks: MigrationChunkMeta[]): string {
    const importer = new MigrationImporter({ lynoxDir: dst, vaultKey: DST_KEY });
    importer.startHandshake(TOKEN);
    importer.completeHandshake(serializePublicKey(generateEphemeralKeypair().publicKey));
    const base = { version: 1 as const, exportedAt: '', lynoxVersion: '', totalChunks: chunks.length, chunks };
    try {
      importer.setManifest({ ...base, manifestHash: computeManifestHash(base) });
      return '';
    } catch (err) {
      return (err as Error).message;
    } finally {
      importer.cleanup();
    }
  }
  const memory = (n: number, size: number): MigrationChunkMeta[] =>
    Array.from({ length: n }, (_, i) => ({ seq: i, type: 'memory' as const, name: `memory:part${String(i)}`, originalSize: size, checksum: 'x' }));

  it('refuses one chunk over the count and not at it', () => {
    expect(refusal(memory(MIGRATION_MAX_CHUNKS + 1, 1))).toMatch(/^Too many chunks/);
    expect(refusal(memory(MIGRATION_MAX_CHUNKS, 1))).toBe('');
  });

  it('refuses one byte over the total and not at it', () => {
    const at = memory(2, MIGRATION_MAX_TOTAL_BYTES / 2);
    expect(refusal(at)).toBe('');
    const over = memory(2, MIGRATION_MAX_TOTAL_BYTES / 2);
    over[1] = { ...over[1]!, originalSize: MIGRATION_MAX_TOTAL_BYTES / 2 + 1 };
    expect(refusal(over)).toMatch(/^Total data size exceeds limit/);
  });
});

describe('the public migration docs', () => {
  it('state the bounds the code enforces, and no other ceiling', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'src', 'content', 'docs', 'features', 'migration.md'), 'utf-8');
    expect(doc).toContain(`at most ${String(MIGRATION_MAX_CHUNKS)} chunks`);
    expect(doc).toContain(`at most ${String(MIGRATION_MAX_TOTAL_BYTES / (1024 * 1024))} MiB in total`);
    expect(doc).not.toMatch(/512\s*MB/);
    expect(doc).toContain('If your data does not fit, write to support@lynox.ai; a migration cannot move only part of it.');
  });
});
