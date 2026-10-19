import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, readdirSync, chmodSync } from 'node:fs';
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
import { _resetWorkspaceAccess } from './workspace-access.js';

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

  it('round-trips a bundle large enough to be SPLIT into parts', () => {
    // `splitIntoChunks` turns a payload over MAX_CHUNK_BYTES (8 MiB) into `workspace:part0`,
    // `workspace:part1`, … A review pass showed the importer handed those to JSON.parse ONE
    // AT A TIME, so the first part threw `Unterminated string in JSON` — uncaught, aborting
    // the import AFTER the databases had already been written. ~6 MB of files is enough,
    // because the payload is base64 (×4/3), and `workspace/` is the agent's own file area.
    const srcDir = tmp('lynox-pd9-src-'); const dstDir = tmp('lynox-pd9-dst-');
    mkdirSync(join(srcDir, 'workspace'), { recursive: true });
    const big = Buffer.alloc(7 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 997) big[i] = i % 251;   // not all-zero, so a truncation shows
    writeFileSync(join(srcDir, 'workspace', 'big.bin'), big);

    const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_KEY });
    const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_KEY });
    const { manifest, chunks } = exporter.export(handshake(importer));
    expect(manifest.chunks.filter(c => c.type === 'portable_dir').length,
      'fixture no longer produces a SPLIT bundle — the case this test exists for is gone')
      .toBeGreaterThan(1);

    importer.setManifest(manifest);
    for (const c of chunks) importer.receiveChunk(c);
    expect(importer.restore().portableDirFilesImported).toBe(1);
    expect(readFileSync(join(dstDir, 'workspace', 'big.bin')).equals(big)).toBe(true);
  });

  it('refuses to export when the data directory is inside the workspace root, never copies it into itself', () => {
    // `<data>/workspace` linked to the directory that holds the data directory stands in for a bind
    // mount, which takes privileges: the root then contains the data directory.
    const nest = tmp('lynox-pd-nest-');
    const srcDir = join(nest, 'src');
    mkdirSync(join(srcDir, 'apis'), { recursive: true });
    writeFileSync(join(srcDir, 'apis', 'a.json'), '{}', 'utf-8');
    symlinkSync(nest, join(srcDir, 'workspace'));
    const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_KEY });
    expect(() => exporter.export(Buffer.alloc(32, 1))).toThrow(/data directory is inside/);
  });

  it('refuses to ship a partial directory rather than truncating it silently', () => {
    // Both caps, reached through the test-only override — the real ceilings are 20 000
    // entries and 64 MiB, and a test that has to materialise either is slow enough that it
    // does not get written. The exporter used to `continue` past a cap, which admits
    // whatever smaller files come next: an order-dependent partial export with no signal.
    const srcDir = tmp('lynox-pd10-src-');
    mkdirSync(join(srcDir, 'apis'), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(srcDir, 'apis', `f${String(i)}.json`), 'x'.repeat(100), 'utf-8');

    const byEntries = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_KEY, portableDirLimits: { maxEntries: 3, maxBytes: 1 << 20 } });
    expect(() => byEntries.export(Buffer.alloc(32, 1))).toThrow(/exceeds the migration limits/i);

    const byBytes = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_KEY, portableDirLimits: { maxEntries: 1000, maxBytes: 250 } });
    expect(() => byBytes.export(Buffer.alloc(32, 1))).toThrow(/exceeds the migration limits/i);

    // Under the caps it ships normally, so the refusal is a boundary and not a blanket.
    const ok = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_KEY, portableDirLimits: { maxEntries: 10, maxBytes: 1 << 20 } });
    expect(ok.export(Buffer.alloc(32, 1)).manifest.chunks.some(c => c.type === 'portable_dir')).toBe(true);
  });

  it('strips a migrated custom_endpoint_ack from the flat api profiles on a MANAGED destination', () => {
    // `apis/` travelling opens a hole in the BYOK-endpoint disclosure gate with a precise
    // shape: a source from before the connections cutover ships `apis/` and no `engine.db`,
    // so the engine.db re-gate no-ops and the ack rides in intact — accepted on behalf of an
    // operator who never saw the dialog.
    const srcDir = tmp('lynox-pd11-src-'); const dstDir = tmp('lynox-pd11-dst-');
    mkdirSync(join(srcDir, 'apis'), { recursive: true });
    writeFileSync(join(srcDir, 'apis', 'byok.json'), JSON.stringify({
      id: 'byok', name: 'Byok', base_url: 'https://byok.example',
      custom_endpoint_ack: { hosts: ['byok.example'], accepted_at: '2026-01-01T00:00:00Z' },
    }), 'utf-8');

    const prior = process.env['LYNOX_BILLING_TIER'];
    process.env['LYNOX_BILLING_TIER'] = 'managed';
    try { migrate(srcDir, dstDir); } finally {
      if (prior === undefined) delete process.env['LYNOX_BILLING_TIER']; else process.env['LYNOX_BILLING_TIER'] = prior;
    }

    const landed = JSON.parse(readFileSync(join(dstDir, 'apis', 'byok.json'), 'utf-8')) as Record<string, unknown>;
    expect(landed['custom_endpoint_ack'], 'the ack was inherited — the disclosure gate is bypassed').toBeUndefined();
    // The profile itself still migrates; only the per-instance acceptance is dropped.
    expect(landed['base_url']).toBe('https://byok.example');
  });

  it('keeps the ack on a SELF-HOSTED destination — same data owner', () => {
    const srcDir = tmp('lynox-pd12-src-'); const dstDir = tmp('lynox-pd12-dst-');
    mkdirSync(join(srcDir, 'apis'), { recursive: true });
    writeFileSync(join(srcDir, 'apis', 'byok.json'), JSON.stringify({
      id: 'byok', custom_endpoint_ack: { hosts: ['byok.example'] },
    }), 'utf-8');

    const prior = process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_BILLING_TIER'];
    try { migrate(srcDir, dstDir); } finally {
      if (prior !== undefined) process.env['LYNOX_BILLING_TIER'] = prior;
    }

    const landed = JSON.parse(readFileSync(join(dstDir, 'apis', 'byok.json'), 'utf-8')) as Record<string, unknown>;
    expect(landed['custom_endpoint_ack'], 'a self-hosted move stripped an ack it should keep').toBeDefined();
  });

  // The import reads every `apis/*.json` it can, following a link, so the strip has to see the
  // same files or fail the import, as the engine.db re-gate does. Each case below is a file
  // already on the destination that the bundle does not carry.
  describe('the managed ack strip fails closed on a file it cannot rewrite', () => {
    const ACKED = JSON.stringify({ id: 'byok', name: 'Byok', base_url: 'https://byok.example', custom_endpoint_ack: { hosts: ['byok.example'] } });
    function source(): string {
      const srcDir = tmp('lynox-pd-ack-src-');
      mkdirSync(join(srcDir, 'apis'), { recursive: true });
      writeFileSync(join(srcDir, 'apis', 'other.json'), JSON.stringify({ id: 'other', name: 'Other', base_url: 'https://other.example' }), 'utf-8');
      return srcDir;
    }
    function migrateManaged(srcDir: string, dstDir: string): void {
      const prior = process.env['LYNOX_BILLING_TIER'];
      process.env['LYNOX_BILLING_TIER'] = 'managed';
      try { migrate(srcDir, dstDir); } finally {
        if (prior === undefined) delete process.env['LYNOX_BILLING_TIER']; else process.env['LYNOX_BILLING_TIER'] = prior;
      }
    }
    const ackOf = (path: string): unknown => (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>)['custom_endpoint_ack'];

    it('refuses a link in apis/ and writes nothing through it', () => {
      const dstDir = tmp('lynox-pd-ack-dst-'); const outside = tmp('lynox-pd-ack-out-');
      mkdirSync(join(dstDir, 'apis'), { recursive: true });
      writeFileSync(join(outside, 'target.json'), ACKED, 'utf-8');
      symlinkSync(join(outside, 'target.json'), join(dstDir, 'apis', 'byok.json'));

      expect(() => migrateManaged(source(), dstDir)).toThrow(/apis\/byok\.json is not a regular file/);
      // The link's target outside the data directory is left exactly as it was.
      expect(readFileSync(join(outside, 'target.json'), 'utf-8')).toBe(ACKED);
    });

    it.skipIf(process.getuid?.() === 0)('fails the import when a file with an ack cannot be rewritten (skipped as root)', () => {
      const dstDir = tmp('lynox-pd-ack-dst-');
      mkdirSync(join(dstDir, 'apis'), { recursive: true });
      const path = join(dstDir, 'apis', 'byok.json');
      writeFileSync(path, ACKED, 'utf-8');
      chmodSync(path, 0o400);
      try {
        expect(() => migrateManaged(source(), dstDir)).toThrow(/apis\/byok\.json could not be rewritten/);
      } finally {
        chmodSync(path, 0o600);
      }
      expect(ackOf(path), 'the refusal is the guard; the ack is still on disk').toBeDefined();
    });

    it.skipIf(process.getuid?.() === 0)('fails the import when a file cannot be read (skipped as root)', () => {
      const dstDir = tmp('lynox-pd-ack-dst-');
      mkdirSync(join(dstDir, 'apis'), { recursive: true });
      const path = join(dstDir, 'apis', 'byok.json');
      writeFileSync(path, ACKED, 'utf-8');
      chmodSync(path, 0o000);
      try {
        expect(() => migrateManaged(source(), dstDir)).toThrow(/apis\/byok\.json could not be read/);
      } finally {
        chmodSync(path, 0o600);
      }
    });

    it.skipIf(process.getuid?.() === 0)('fails the import when apis/ can be listed but its files not reached (skipped as root)', () => {
      // A source without `apis/`, so the restore writes nothing into the directory it cannot enter.
      const srcDir = tmp('lynox-pd-ack-src-');
      const dstDir = tmp('lynox-pd-ack-dst-');
      const apis = join(dstDir, 'apis');
      mkdirSync(apis, { recursive: true });
      writeFileSync(join(apis, 'byok.json'), ACKED, 'utf-8');
      chmodSync(apis, 0o400);
      try {
        expect(() => migrateManaged(srcDir, dstDir)).toThrow(/apis\/byok\.json could not be read/);
      } finally {
        chmodSync(apis, 0o700);
      }
    });

    it('control: a regular file already on the destination loses its ack, and the import finishes', () => {
      const dstDir = tmp('lynox-pd-ack-dst-');
      mkdirSync(join(dstDir, 'apis'), { recursive: true });
      const path = join(dstDir, 'apis', 'byok.json');
      writeFileSync(path, ACKED, 'utf-8');

      expect(() => migrateManaged(source(), dstDir)).not.toThrow();
      expect(ackOf(path)).toBeUndefined();
      expect((JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>)['base_url']).toBe('https://byok.example');
    });

    it('passes over a file that does not parse and a directory, as the import does', () => {
      const dstDir = tmp('lynox-pd-ack-dst-');
      mkdirSync(join(dstDir, 'apis', 'nested.json'), { recursive: true });
      writeFileSync(join(dstDir, 'apis', 'broken.json'), '{ "custom_endpoint_ack": ', 'utf-8');

      expect(() => migrateManaged(source(), dstDir)).not.toThrow();
      expect(readFileSync(join(dstDir, 'apis', 'broken.json'), 'utf-8')).toBe('{ "custom_endpoint_ack": ');
    });
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
    importCraftedWith(dstDir, dir, files);
  }

  /** As `importCrafted`, returning the verification (null when the import refused). */
  function importCraftedWith(dstDir: string, dir: unknown, files: Record<string, string>): ReturnType<MigrationImporter['restore']> | null {
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
    try { return importer.restore(); } catch { return null; /* a refusal is a pass here; the assertions check disk */ }
  }

  it('refuses an ANCESTOR symlink, not just one at the target itself', () => {
    // The depth-0 case (`target.txt` is a link) is closed by unlink+'wx'. This is the one a
    // review pass got through: with `apis/sub` a pre-existing symlink, the key
    // `sub/deeper/pwn.txt` still resolves to a path starting with the root — `resolve()` is
    // lexical — and a recursive mkdir then creates `deeper` THROUGH the link.
    const dstDir = tmp('lynox-pd7-dst-');
    const outside = tmp('lynox-pd7-out-');
    mkdirSync(join(dstDir, 'apis'), { recursive: true });
    symlinkSync(outside, join(dstDir, 'apis', 'sub'));

    const payload = Buffer.from('OWNED-OUTSIDE', 'utf-8').toString('base64');
    importCrafted(dstDir, 'apis', { 'sub/deeper/pwn.txt': payload, 'sub/direct.txt': payload });

    expect(existsSync(join(outside, 'deeper', 'pwn.txt'))).toBe(false);
    expect(existsSync(join(outside, 'direct.txt'))).toBe(false);
  });

  it('an EARLIER entry cannot plant a link the next one walks through', () => {
    // Entries are written in object order, so the ordering attack is real even on a clean
    // destination: the guard runs per entry rather than once up front.
    const dstDir = tmp('lynox-pd8-dst-');
    const outside = tmp('lynox-pd8-out-');
    mkdirSync(join(dstDir, 'apis'), { recursive: true });
    symlinkSync(outside, join(dstDir, 'apis', 'planted'));

    importCrafted(dstDir, 'apis', {
      'planted/after.txt': Buffer.from('OWNED', 'utf-8').toString('base64'),
      'ok.txt': Buffer.from('FINE', 'utf-8').toString('base64'),
    });

    expect(existsSync(join(outside, 'after.txt'))).toBe(false);
    // …and a legitimate sibling in the same bundle still lands, so the refusal is scoped.
    expect(readFileSync(join(dstDir, 'apis', 'ok.txt'), 'utf-8')).toBe('FINE');
  });

  it('workspace: refuses an ancestor symlink and a file on the way, names them, and lands the rest (P18 D6)', () => {
    const dstDir = tmp('lynox-pdw-dst-');
    const outside = tmp('lynox-pdw-out-');
    mkdirSync(join(dstDir, 'workspace'), { recursive: true });
    symlinkSync(outside, join(dstDir, 'workspace', 'sub'));
    writeFileSync(join(dstDir, 'workspace', 'afile'), 'live');
    mkdirSync(join(dstDir, 'workspace', 'adir'));
    const b64 = (t: string): string => Buffer.from(t, 'utf-8').toString('base64');
    const importer = importCraftedWith(dstDir, 'workspace', {
      'sub/deeper/pwn.txt': b64('OWNED'),
      'afile/x.txt': b64('X'),
      'adir': b64('D'),
      'ok/fine.txt': b64('FINE'),
    });
    expect(existsSync(join(outside, 'deeper', 'pwn.txt'))).toBe(false);
    expect(readFileSync(join(dstDir, 'workspace', 'afile'), 'utf-8')).toBe('live');
    expect(readFileSync(join(dstDir, 'workspace', 'ok', 'fine.txt'), 'utf-8')).toBe('FINE');
    expect([...(importer?.portableDirSkipped ?? [])].sort()).toEqual(['workspace/adir', 'workspace/afile/x.txt', 'workspace/sub/deeper/pwn.txt']);
  });

  it('workspace: lands every file in directories the target does not have yet (P18 D6)', () => {
    const dstDir = tmp('lynox-pdwn-dst-');
    mkdirSync(join(dstDir, 'workspace', 'http-api'), { recursive: true });
    const b64 = (t: string): string => Buffer.from(t, 'utf-8').toString('base64');
    const files = {
      'http-api/reports/q1.pdf': b64('Q1'), 'http-api/reports/q2.pdf': b64('Q2'),
      'd/a': b64('A'), 'd/b': b64('B'), 'd/e/f': b64('F'), 'd/e/g': b64('G'),
    };
    const importer = importCraftedWith(dstDir, 'workspace', files);
    expect(importer?.portableDirFilesImported).toBe(6);
    expect(importer?.portableDirSkipped).toBeUndefined();
    for (const [rel, data] of Object.entries(files)) {
      expect(readFileSync(join(dstDir, 'workspace', rel), 'utf-8')).toBe(Buffer.from(data, 'base64').toString('utf-8'));
    }
  });

  it('workspace: under a new directory, a file where the bundle needs a directory is skipped, not the whole set (P18 D6)', () => {
    const dstDir = tmp('lynox-pdwk-dst-');
    mkdirSync(join(dstDir, 'workspace'), { recursive: true });
    const b64 = (t: string): string => Buffer.from(t, 'utf-8').toString('base64');
    const importer = importCraftedWith(dstDir, 'workspace', { 'n/x/y': b64('Y'), 'n/x': b64('X'), 'n/z': b64('Z') });
    expect(importer?.portableDirSkipped).toEqual(['workspace/n/x']);
    expect(readFileSync(join(dstDir, 'workspace', 'n', 'x', 'y'), 'utf-8')).toBe('Y');
    expect(readFileSync(join(dstDir, 'workspace', 'n', 'z'), 'utf-8')).toBe('Z');
  });

  it('workspace: a file the bundle placed earlier blocks a deeper path, even under a new directory (P18 D6)', () => {
    const dstDir = tmp('lynox-pdwf-dst-');
    mkdirSync(join(dstDir, 'workspace'), { recursive: true });
    const b64 = (t: string): string => Buffer.from(t, 'utf-8').toString('base64');
    const importer = importCraftedWith(dstDir, 'workspace', { 'n/x': b64('X'), 'n/x/y': b64('Y') });
    expect(importer?.portableDirSkipped).toEqual(['workspace/n/x/y']);
    expect(readFileSync(join(dstDir, 'workspace', 'n', 'x'), 'utf-8')).toBe('X');
  });

  it('workspace: a name the file system cannot store as given is skipped, the rest lands (P18 D6)', () => {
    const dstDir = tmp('lynox-pdws-dst-');
    mkdirSync(join(dstDir, 'workspace'), { recursive: true });
    const b64 = (t: string): string => Buffer.from(t, 'utf-8').toString('base64');
    const lone = 'k' + String.fromCharCode(0xd801);
    const long = 'n'.repeat(300);
    const importer = importCraftedWith(dstDir, 'workspace', {
      'a.txt': b64('A'), [lone]: b64('L'), [`${String.fromCharCode(0xd800)}/y`]: b64('Y'), [`new/${long}`]: b64('N'), 'z.txt': b64('Z'),
    });
    expect([...(importer?.portableDirSkipped ?? [])].sort()).toEqual([`workspace/${String.fromCharCode(0xd800)}/y`, `workspace/${lone}`, `workspace/new/${long}`].sort());
    expect(readFileSync(join(dstDir, 'workspace', 'a.txt'), 'utf-8')).toBe('A');
    expect(readFileSync(join(dstDir, 'workspace', 'z.txt'), 'utf-8')).toBe('Z');
  });

  it('workspace: the export names a file whose name cannot travel, never drops it silently (P18 D6)', () => {
    const srcDir = tmp('lynox-pdwx-src-');
    mkdirSync(join(srcDir, 'workspace'), { recursive: true });
    writeFileSync(join(srcDir, 'workspace', 'two\nlines.txt'), 'X');
    writeFileSync(join(srcDir, 'workspace', 'a.txt'), 'A');
    const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_KEY });
    const importer = new MigrationImporter({ lynoxDir: tmp('lynox-pdwx-dst-'), vaultKey: DST_KEY });
    expect(exporter.export(handshake(importer)).skipped).toEqual(['workspace/two\nlines.txt']);
  });

  it('workspace: the export names a link it did not carry (P18 D6)', () => {
    const srcDir = tmp('lynox-pdwe-src-');
    const outside = tmp('lynox-pdwe-out-');
    mkdirSync(join(srcDir, 'workspace'), { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    symlinkSync(join(outside, 'secret.txt'), join(srcDir, 'workspace', 'link'));
    writeFileSync(join(srcDir, 'workspace', 'a.txt'), 'A');
    const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_KEY });
    const importer = new MigrationImporter({ lynoxDir: tmp('lynox-pdwe-dst-'), vaultKey: DST_KEY });
    const result = exporter.export(handshake(importer));
    expect(result.skipped).toEqual(['workspace/link']);
  });

  it('workspace: an external root is exported and imported through the root, not <data>/workspace (P18 D6)', () => {
    const saved = { data: process.env['LYNOX_DATA_DIR'], root: process.env['LYNOX_WORKSPACE_ROOT'] };
    const srcDir = tmp('lynox-pdx-src-'); const srcRoot = tmp('lynox-pdx-srcroot-');
    const dstDir = tmp('lynox-pdx-dst-'); const dstRoot = tmp('lynox-pdx-dstroot-');
    writeFileSync(join(srcRoot, 'a.txt'), 'ZZ-ext');
    try {
      process.env['LYNOX_DATA_DIR'] = srcDir;
      process.env['LYNOX_WORKSPACE_ROOT'] = srcRoot;
      _resetWorkspaceAccess();
      const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_KEY });
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_KEY });
      const { manifest, chunks } = exporter.export(handshake(importer));
      process.env['LYNOX_DATA_DIR'] = dstDir;
      process.env['LYNOX_WORKSPACE_ROOT'] = dstRoot;
      _resetWorkspaceAccess();
      importer.setManifest(manifest);
      for (const c of chunks) importer.receiveChunk(c);
      expect(importer.restore().portableDirFilesImported).toBe(1);
      expect(readFileSync(join(dstRoot, 'a.txt'), 'utf-8')).toBe('ZZ-ext');
      expect(existsSync(join(dstDir, 'workspace'))).toBe(false);
    } finally {
      _resetWorkspaceAccess();
      if (saved.data === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = saved.data;
      if (saved.root === undefined) delete process.env['LYNOX_WORKSPACE_ROOT']; else process.env['LYNOX_WORKSPACE_ROOT'] = saved.root;
    }
  });

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
