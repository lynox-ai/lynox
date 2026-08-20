import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MigrationExporter } from './migration-export.js';
import { MigrationImporter } from './migration-import.js';
import {
  generateEphemeralKeypair, serializePublicKey, deserializePublicKey,
  deriveTransferKey, deriveSigningKey, verifyHandshake,
  encryptChunk, computeManifestHash, sha256, type MigrationChunkMeta,
} from './migration-crypto.js';
import { isPortableDirEntryName, GENERIC_PORTABLE_DIRS } from './data-dir-inventory.js';

/**
 * `apis/` and `workspace/` migrate through one GENERIC collector, because neither has
 * structure the importer needs to understand. Two things about that are easy to get wrong
 * and both are asserted here: the payload is BINARY (a measured instance had a .docx in its
 * file area, and a utf-8 round-trip silently destroys one while an ASCII-only test stays
 * green), and the entry keys come from another machine, so they are attacker-shaped.
 */

const SRC_KEY = 'portable-dir-source-key-2026';
const DST_KEY = 'portable-dir-destination-key-2026';
const TOKEN = 'c'.repeat(64);

function handshake(importer: MigrationImporter): Buffer {
  const server = importer.startHandshake(TOKEN);
  expect(verifyHandshake(server.serverPubKey, server.signature, deriveSigningKey(TOKEN))).toBe(true);
  const kp = generateEphemeralKeypair();
  const key = deriveTransferKey(kp.privateKey, deserializePublicKey(server.serverPubKey), Buffer.from(server.challengeNonce, 'hex'));
  importer.completeHandshake(serializePublicKey(kp.publicKey));
  return key;
}

describe('portable directories survive a migration', () => {
  const dirs: string[] = [];
  const tmp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

  function migrate(srcDir: string, dstDir: string): number {
    const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_KEY });
    const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_KEY });
    const { manifest, chunks } = exporter.export(handshake(importer));
    importer.setManifest(manifest);
    for (const c of chunks) importer.receiveChunk(c);
    return importer.restore().portableDirFilesImported;
  }

  it('round-trips a BINARY file byte for byte, not as utf-8', () => {
    const srcDir = tmp('lynox-pd-src-'); const dstDir = tmp('lynox-pd-dst-');
    // Bytes a utf-8 decode+encode cycle mangles: a lone 0x80 continuation, 0xff, and a NUL.
    // A .docx (the real case) is a zip and full of them.
    const payload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x80, 0xff, 0xfe, 0x41, 0x00]);
    mkdirSync(join(srcDir, 'workspace', 'nested'), { recursive: true });
    writeFileSync(join(srcDir, 'workspace', 'nested', 'contract.docx'), payload);

    expect(migrate(srcDir, dstDir)).toBe(1);
    const out = readFileSync(join(dstDir, 'workspace', 'nested', 'contract.docx'));
    expect(out.equals(payload), 'binary payload did not survive — a utf-8 round-trip mangles it').toBe(true);
  });

  it('carries every declared generic portable directory', () => {
    const srcDir = tmp('lynox-pd2-src-'); const dstDir = tmp('lynox-pd2-dst-');
    for (const name of GENERIC_PORTABLE_DIRS) {
      mkdirSync(join(srcDir, name), { recursive: true });
      writeFileSync(join(srcDir, name, 'probe.json'), `{"dir":"${name}"}`, 'utf-8');
    }
    expect(migrate(srcDir, dstDir)).toBe(GENERIC_PORTABLE_DIRS.length);
    for (const name of GENERIC_PORTABLE_DIRS) {
      expect(readFileSync(join(dstDir, name, 'probe.json'), 'utf-8')).toBe(`{"dir":"${name}"}`);
    }
  });

  it('refuses entry keys that escape the directory', () => {
    for (const evil of ['../escape.json', 'a/../../escape.json', '/etc/passwd', 'a\\b.json', './x.json', '', 'a/./b']) {
      expect(isPortableDirEntryName(evil), `must refuse ${JSON.stringify(evil)}`).toBe(false);
    }
    for (const ok of ['probe.json', 'nested/probe.json', 'a/b/c/d.bin']) {
      expect(isPortableDirEntryName(ok), `must accept ${ok}`).toBe(true);
    }
  });

  it('does not carry a symlink out of a portable directory', () => {
    const srcDir = tmp('lynox-pd3-src-'); const dstDir = tmp('lynox-pd3-dst-');
    const secret = join(srcDir, 'vault-lookalike.txt');
    writeFileSync(secret, 'PRIVATE-KEY-MATERIAL', 'utf-8');
    mkdirSync(join(srcDir, 'workspace'), { recursive: true });
    writeFileSync(join(srcDir, 'workspace', 'real.txt'), 'kept', 'utf-8');
    symlinkSync(secret, join(srcDir, 'workspace', 'link.txt'));

    expect(migrate(srcDir, dstDir)).toBe(1);
    expect(existsSync(join(dstDir, 'workspace', 'link.txt'))).toBe(false);
    for (const f of readdirSync(join(dstDir, 'workspace'))) {
      expect(readFileSync(join(dstDir, 'workspace', f), 'utf-8')).not.toContain('PRIVATE-KEY-MATERIAL');
    }
  });

  it('never writes THROUGH a symlink planted at a target path', () => {
    const srcDir = tmp('lynox-pd4-src-'); const dstDir = tmp('lynox-pd4-dst-');
    mkdirSync(join(srcDir, 'workspace'), { recursive: true });
    writeFileSync(join(srcDir, 'workspace', 'target.txt'), 'FROM-BUNDLE', 'utf-8');

    const victim = join(dstDir, 'victim.txt');
    writeFileSync(victim, 'ORIGINAL', 'utf-8');
    mkdirSync(join(dstDir, 'workspace'), { recursive: true });
    symlinkSync(victim, join(dstDir, 'workspace', 'target.txt'));

    migrate(srcDir, dstDir);
    expect(readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(lstatSync(join(dstDir, 'workspace', 'target.txt')).isSymbolicLink()).toBe(false);
  });

  /**
   * Hand-build an encrypted portable_dir bundle. The EXPORTER only ever emits declared
   * directories and confined keys, so a test that goes through it can never reach the
   * importer's guards — the first version of this case asserted against the CONSTANT
   * instead, which tests a list, not the importer, and left the guard uncovered.
   */
  function importCrafted(dstDir: string, dir: unknown, files: Record<string, string>): void {
    const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_KEY });
    const transferKey = handshake(importer);
    const data = Buffer.from(JSON.stringify({ dir, files }), 'utf-8');
    const meta: MigrationChunkMeta = {
      seq: 0, type: 'portable_dir', name: typeof dir === 'string' ? dir : 'x',
      originalSize: data.length, checksum: sha256(data),
    };
    const base = { version: 1 as const, exportedAt: new Date().toISOString(), lynoxVersion: 'test', totalChunks: 1, chunks: [meta] };
    const manifestHash = computeManifestHash(base);
    importer.setManifest({ ...base, manifestHash });
    importer.receiveChunk(encryptChunk(data, transferKey, 0, manifestHash));
    try { importer.restore(); } catch { /* a refusal is a pass here; the assertions check disk */ }
  }

  it('refuses a bundle naming a directory this build does not declare portable', () => {
    const dstDir = tmp('lynox-pd5-dst-');
    const payload = Buffer.from('OWNED', 'utf-8').toString('base64');
    for (const dir of ['vault', 'backups', '..', '', 'memory', 'sweeps']) {
      importCrafted(dstDir, dir, { 'probe.txt': payload });
      expect(existsSync(join(dstDir, String(dir), 'probe.txt')), `${dir} was accepted`).toBe(false);
    }
    expect(existsSync(join(dstDir, 'probe.txt'))).toBe(false);
    // The declared ones still work, so the refusal is not simply "nothing ever lands".
    importCrafted(dstDir, 'apis', { 'probe.txt': payload });
    expect(readFileSync(join(dstDir, 'apis', 'probe.txt'), 'utf-8')).toBe('OWNED');
  });

  it('reads entries with lstat, so a symlink is never followed on the EXPORT side', () => {
    // The explicit `isSymbolicLink()` skip is redundant with `lstat().isFile()`; the load-
    // bearing part is that the stat is an LSTAT at all. Mutating it to `statSync` is the
    // mutation that matters, so assert the property that mutation breaks: a symlink whose
    // TARGET is a perfectly ordinary file must still not be carried.
    const srcDir = tmp('lynox-pd6-src-'); const dstDir = tmp('lynox-pd6-dst-');
    const target = join(srcDir, 'ordinary.txt');
    writeFileSync(target, 'TARGET-CONTENT', 'utf-8');
    mkdirSync(join(srcDir, 'apis'), { recursive: true });
    symlinkSync(target, join(srcDir, 'apis', 'looks-normal.json'));

    migrate(srcDir, dstDir);
    expect(existsSync(join(dstDir, 'apis', 'looks-normal.json'))).toBe(false);
  });
});
