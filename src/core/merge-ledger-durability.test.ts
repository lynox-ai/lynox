import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { RunHistory } from './run-history.js';
import { ThreadStore } from './thread-store.js';
import { runMerge, rollbackMergeRun, isMergeLedgerFileName, type MergeLedgerFile } from './subject-merge-runner.js';
import { BackupManager } from './backup.js';
import { MigrationExporter } from './migration-export.js';
import { MigrationImporter } from './migration-import.js';
import {
  generateEphemeralKeypair, serializePublicKey, deserializePublicKey,
  deriveTransferKey, deriveSigningKey, verifyHandshake,
  encryptChunk, computeManifestHash, sha256,
  type MigrationManifest, type MigrationChunkMeta,
} from './migration-crypto.js';

const MIGRATION_TOKEN = 'b'.repeat(64);

/** The handshake dance, same shape as migration.test.ts's helper. */
function performHandshake(importer: MigrationImporter): Buffer {
  const server = importer.startHandshake(MIGRATION_TOKEN);
  expect(verifyHandshake(server.serverPubKey, server.signature, deriveSigningKey(MIGRATION_TOKEN))).toBe(true);
  const clientKp = generateEphemeralKeypair();
  const transferKey = deriveTransferKey(
    clientKp.privateKey,
    deserializePublicKey(server.serverPubKey),
    Buffer.from(server.challengeNonce, 'hex'),
  );
  importer.completeHandshake(serializePublicKey(clientKp.publicKey));
  return transferKey;
}

/**
 * `subjects_merge` told users a merge was reversible. It was not — and the third of the
 * three reasons was that the ONLY artifact that can reverse one, the merge ledger under
 * `~/.lynox/sweeps/`, was in no backup list and in neither migration list. So a restore
 * or a tenant migration silently ended the possibility for every past merge.
 *
 * These tests assert the CAPABILITY, not the file. Checking that a JSON file reappeared
 * would pass while the thing the user actually wants — getting the entry back — stayed
 * impossible, which is the shape of a verification that cannot fail. Each round-trip
 * therefore ends in a real `rollbackMergeRun` against the RESTORED ledger on the
 * RESTORED stores, and asserts the archived subject is live again.
 */

const SRC_VAULT_KEY = 'source-vault-key-for-merge-ledger-durability-2026';
const DST_VAULT_KEY = 'destination-vault-key-for-merge-ledger-durability-2026';

describe('merge ledger survives backup→restore and export→import', () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];

  function openStores(dir: string): { store: SubjectStore; threadStore: ThreadStore } {
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const history = new RunHistory(join(dir, 'history.db'));
    closers.push(() => {
      try { engine.close(); } catch { /* noop */ }
      try { history.close(); } catch { /* noop */ }
    });
    return { store: new SubjectStore(engine), threadStore: new ThreadStore(history.getDb()) };
  }

  function makeTmp(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  const readLedgerRaw = (dir: string): string => {
    const f = readdirSync(join(dir, 'sweeps')).find((n) => isMergeLedgerFileName(n))!;
    return readFileSync(join(dir, 'sweeps', f), 'utf8');
  };

  const readLedgerFrom = (dir: string): MergeLedgerFile => {
    const f = readdirSync(join(dir, 'sweeps')).find((n) => isMergeLedgerFileName(n))!;
    return JSON.parse(readFileSync(join(dir, 'sweeps', f), 'utf8')) as MergeLedgerFile;
  };

  afterEach(() => {
    for (const c of closers) c();
    closers.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('a merge stays undoable across a backup→restore cycle', async () => {
    const dir = makeTmp('lynox-ledger-backup-');
    const backupDir = makeTmp('lynox-ledger-backupdest-');
    const { store, threadStore } = openStores(dir);

    const dup = store.createSubject({ kind: 'organization', name: 'Meridian AG' });
    const canon = store.createSubject({ kind: 'organization', name: 'Meridian' });
    expect(runMerge(store, null, threadStore, dir, dup, canon).ok).toBe(true);
    expect(store.getSubject(dup)?.archived_at).toBeTruthy();

    const mgr = new BackupManager(dir, { backupDir, retentionDays: 7, encrypt: false }, null);
    const made = await mgr.createBackup();
    expect(made.success).toBe(true);

    // The disaster this defends against: the ledger directory is gone. Before this
    // change the backup simply did not contain it, so the restore below could not
    // bring it back and the merge became permanent without anyone being told.
    rmSync(join(dir, 'sweeps'), { recursive: true, force: true });
    expect(existsSync(join(dir, 'sweeps'))).toBe(false);

    const restored = await mgr.restoreBackup(made.path);
    expect(restored.success).toBe(true);
    expect(existsSync(join(dir, 'sweeps'))).toBe(true);

    // REOPEN the stores. `restoreBackup` renames a fresh file over `engine.db`, so the
    // handle opened before it still points at the pre-restore inode — rolling back
    // through it would exercise the OLD database and pass while the restore was broken.
    // A review pass caught exactly that here; the ledger was read from disk, the stores
    // were not.
    const after = openStores(dir);
    expect(after.store.getSubject(dup)?.archived_at).toBeTruthy();

    // The capability, not the file: the restored ledger actually reverses the merge.
    const back = rollbackMergeRun(after.store, null, after.threadStore, readLedgerFrom(dir));
    expect(back.ok).toBe(true);
    expect(after.store.getSubject(dup)?.archived_at).toBeFalsy();
  });

  it('a merge stays undoable across an export→import migration', () => {
    const srcDir = makeTmp('lynox-ledger-src-');
    const dstDir = makeTmp('lynox-ledger-dst-');
    const src = openStores(srcDir);

    const dup = src.store.createSubject({ kind: 'organization', name: 'Nordberg GmbH' });
    const canon = src.store.createSubject({ kind: 'organization', name: 'Nordberg' });
    expect(runMerge(src.store, null, src.threadStore, srcDir, dup, canon).ok).toBe(true);

    const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
    const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY });

    const { manifest, chunks } = exporter.export(performHandshake(importer));

    expect(manifest.chunks.some((c) => c.type === 'sweeps')).toBe(true);

    importer.setManifest(manifest);
    for (const chunk of chunks) importer.receiveChunk(chunk);
    const verification = importer.restore();
    expect(verification.mergeLedgersImported).toBe(1);

    // Open the DESTINATION's restored stores and reverse the merge there. This is the
    // clause the register row asks for: the merge a user made on the old instance is
    // still undoable on the new one.
    const dst = openStores(dstDir);
    expect(dst.store.getSubject(dup)?.archived_at).toBeTruthy();
    const back = rollbackMergeRun(dst.store, null, dst.threadStore, readLedgerFrom(dstDir));
    expect(back.ok).toBe(true);
    expect(dst.store.getSubject(dup)?.archived_at).toBeFalsy();
  });

  /**
   * Hand-build an encrypted sweeps bundle. This exists because the EXPORTER structurally
   * cannot produce a hostile key — it filters by the same predicate the importer applies —
   * so a test that goes through the exporter can never reach the importer's guards. The
   * first version of this file did exactly that and asserted a file it had written
   * OUTSIDE sweeps/ (join normalises `../`) had not appeared: an assert that could not
   * fail, guarding the code path it was named for. A migration bundle arrives from
   * another machine; crafting one is the honest fixture.
   */
  function importCraftedSweeps(dstDir: string, files: Record<string, string>): { threw: string | null } {
    const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY });
    const transferKey = performHandshake(importer);
    const data = Buffer.from(JSON.stringify({ files }), 'utf-8');
    const meta: MigrationChunkMeta = {
      seq: 0, type: 'sweeps', name: 'sweeps', originalSize: data.length, checksum: sha256(data),
    };
    const base = {
      version: 1 as const, exportedAt: new Date().toISOString(), lynoxVersion: 'test',
      totalChunks: 1, chunks: [meta],
    };
    const manifestHash = computeManifestHash(base);
    const manifest: MigrationManifest = { ...base, manifestHash };
    importer.setManifest(manifest);
    importer.receiveChunk(encryptChunk(data, transferKey, 0, manifestHash));
    try { importer.restore(); return { threw: null }; }
    catch (err) { return { threw: err instanceof Error ? err.message : String(err) }; }
  }

  const VALID_LEDGER_NAME = 'merge-2026-08-20T10-00-00-000Z-abc123.json';
  /** A payload the importer accepts — the name alone is no longer enough. */
  const VALID_LEDGER_BODY = JSON.stringify({ version: 1, phase: 'merge', entry: {}, dataStore: [], threadAnchors: [], applied: true });

  it('refuses every crafted bundle key that is not a plain ledger basename', () => {
    for (const evil of [
      '../../evil.json',
      '/etc/passwd',
      `${VALID_LEDGER_NAME}/../../escape.json`,
      'sweep-2026-08-20T10-00-00-000Z.json',
      `${VALID_LEDGER_NAME}.bak`,
    ]) {
      expect(isMergeLedgerFileName(evil), `must refuse ${evil}`).toBe(false);
    }
    expect(isMergeLedgerFileName(VALID_LEDGER_NAME)).toBe(true);

    // …and end-to-end through a real importer, which the exporter cannot set up for us.
    const dstDir = makeTmp('lynox-ledger-craft-');
    importCraftedSweeps(dstDir, {
      '../escape-attempt.json': '{"pwned":true}',
      '../../escape-deeper.json': '{"pwned":true}',
      // The key that needs BOTH guards to be present in some combination: it survives a
      // `startsWith('merge-')` predicate AND traverses, so it separates the two guards
      // from each other instead of letting either hide behind the other.
      'merge-../../escape-prefixed.json': '{"pwned":true}',
      [VALID_LEDGER_NAME]: VALID_LEDGER_BODY,
    });
    expect(existsSync(join(dstDir, 'escape-attempt.json'))).toBe(false);
    expect(existsSync(join(dstDir, '..', 'escape-deeper.json'))).toBe(false);
    expect(existsSync(join(dstDir, '..', 'escape-prefixed.json'))).toBe(false);
    expect(readdirSync(join(dstDir, 'sweeps'))).toEqual([VALID_LEDGER_NAME]);
  });

  it('never writes THROUGH a symlink planted at a valid ledger name', () => {
    const dstDir = makeTmp('lynox-ledger-symwrite-');
    const victim = join(dstDir, 'victim.json');
    writeFileSync(victim, 'ORIGINAL', 'utf-8');
    mkdirSync(join(dstDir, 'sweeps'), { recursive: true });
    // `writeFileSync` opens O_CREAT|O_TRUNC, which FOLLOWS a symlink — so without the
    // unlink-first + 'wx' this bundle content lands in `victim.json`.
    symlinkSync(victim, join(dstDir, 'sweeps', VALID_LEDGER_NAME));

    importCraftedSweeps(dstDir, { [VALID_LEDGER_NAME]: VALID_LEDGER_BODY });

    expect(readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(lstatSync(join(dstDir, 'sweeps', VALID_LEDGER_NAME)).isSymbolicLink()).toBe(false);
  });

  it('refuses to restore at all when sweeps/ itself is a symlink', () => {
    const dstDir = makeTmp('lynox-ledger-symdir-');
    const outside = makeTmp('lynox-ledger-outside-');
    // resolve() is lexical and mkdirSync(recursive) no-ops on an existing link, so the
    // startsWith(sweepsPrefix) check passes while every ledger lands in `outside`.
    symlinkSync(outside, join(dstDir, 'sweeps'));

    const { threw } = importCraftedSweeps(dstDir, { [VALID_LEDGER_NAME]: VALID_LEDGER_BODY });
    expect(threw).toMatch(/not a real directory/i);
    expect(existsSync(join(outside, VALID_LEDGER_NAME))).toBe(false);
  });

  it('bounds the ledger COUNT, not only the byte size', () => {
    const dstDir = makeTmp('lynox-ledger-count-');
    const files: Record<string, string> = {};
    for (let i = 0; i < 60_001; i++) {
      files[`merge-2026-08-20T10-00-00-${String(i % 1000).padStart(3, '0')}Z-x${String(i)}.json`] = '{}';
    }
    const { threw } = importCraftedSweeps(dstDir, files);
    expect(threw).toMatch(/Too many merge ledgers/i);
  });

  it('does not carry a symlink in sweeps/ out through the export', () => {
    const srcDir = makeTmp('lynox-ledger-symexp-src-');
    const dstDir = makeTmp('lynox-ledger-symexp-dst-');
    const { store, threadStore } = openStores(srcDir);
    const dup = store.createSubject({ kind: 'organization', name: 'Kessler AG' });
    const canon = store.createSubject({ kind: 'organization', name: 'Kessler' });
    expect(runMerge(store, null, threadStore, srcDir, dup, canon).ok).toBe(true);

    // A symlink wearing a valid ledger name, pointing at something that is not a ledger.
    const secret = join(srcDir, 'secret-material.txt');
    writeFileSync(secret, 'PRIVATE-KEY-MATERIAL', 'utf-8');
    symlinkSync(secret, join(srcDir, 'sweeps', VALID_LEDGER_NAME));

    const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
    const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY });
    const { manifest, chunks } = exporter.export(performHandshake(importer));
    importer.setManifest(manifest);
    for (const chunk of chunks) importer.receiveChunk(chunk);
    importer.restore();

    for (const f of readdirSync(join(dstDir, 'sweeps'))) {
      expect(readFileSync(join(dstDir, 'sweeps', f), 'utf-8')).not.toContain('PRIVATE-KEY-MATERIAL');
    }
    expect(existsSync(join(dstDir, 'sweeps', VALID_LEDGER_NAME))).toBe(false);
  });

  it('does not copy a symlink in sweeps/ into a backup', async () => {
    const dir = makeTmp('lynox-ledger-symbak-');
    const backupDir = makeTmp('lynox-ledger-symbakdest-');
    const { store, threadStore } = openStores(dir);
    const dup = store.createSubject({ kind: 'organization', name: 'Hallberg AG' });
    const canon = store.createSubject({ kind: 'organization', name: 'Hallberg' });
    expect(runMerge(store, null, threadStore, dir, dup, canon).ok).toBe(true);

    const secret = join(dir, 'vault-lookalike.txt');
    writeFileSync(secret, 'PRIVATE-KEY-MATERIAL', 'utf-8');
    symlinkSync(secret, join(dir, 'sweeps', VALID_LEDGER_NAME));
    // A dangling link too: following one hard-fails the WHOLE backup (ENOENT), which
    // would take every other file in the run down with it.
    symlinkSync(join(dir, 'does-not-exist'), join(dir, 'sweeps', 'merge-2026-08-20T10-00-00-001Z-dead01.json'));

    const mgr = new BackupManager(dir, { backupDir, retentionDays: 7, encrypt: false }, null);
    const made = await mgr.createBackup();
    expect(made.success).toBe(true);

    const copied = readdirSync(join(made.path, 'sweeps'));
    expect(copied).not.toContain(VALID_LEDGER_NAME);
    for (const f of copied) {
      expect(readFileSync(join(made.path, 'sweeps', f), 'utf-8')).not.toContain('PRIVATE-KEY-MATERIAL');
    }
  });

  // The exporter and the importer must decide "is this a merge ledger?" the SAME way.
  // Loosening either side alone is silent: a `merge-`-prefixed lookalike that the export
  // carries and the import then drops produces no error anywhere, and the comment
  // claiming one source of truth would be false while every other test stayed green.
  it('does not export a merge- lookalike the importer would refuse', () => {
    const srcDir = makeTmp('lynox-ledger-lookalike-src-');
    const dstDir = makeTmp('lynox-ledger-lookalike-dst-');
    const { store, threadStore } = openStores(srcDir);
    const dup = store.createSubject({ kind: 'organization', name: 'Aurelva AG' });
    const canon = store.createSubject({ kind: 'organization', name: 'Aurelva' });
    expect(runMerge(store, null, threadStore, srcDir, dup, canon).ok).toBe(true);

    // Prefix matches, shape does not — exactly what a `startsWith('merge-')` filter admits.
    writeFileSync(join(srcDir, 'sweeps', 'merge-not-really.json'), '{"version":1}', 'utf-8');

    const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
    const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY });
    const { manifest, chunks } = exporter.export(performHandshake(importer));
    importer.setManifest(manifest);
    for (const chunk of chunks) importer.receiveChunk(chunk);
    expect(importer.restore().mergeLedgersImported).toBe(1);

    // Assert on the PAYLOAD, not the destination. Checking the destination only would
    // stay green with a loose exporter, because the importer drops the lookalike either
    // way — the leak would be silent and this test would claim a coverage it lacks.
    // `originalSize` is the plaintext bundle length, so it pins exactly which files went
    // in: the real ledger and nothing else.
    const sweepsChunk = manifest.chunks.find((c) => c.type === 'sweeps');
    expect(sweepsChunk).toBeDefined();
    const realName = readdirSync(join(srcDir, 'sweeps')).find((n) => isMergeLedgerFileName(n))!;
    const expectedBundle = JSON.stringify({ files: { [realName]: readLedgerRaw(srcDir) } });
    expect(sweepsChunk!.originalSize).toBe(Buffer.byteLength(expectedBundle, 'utf-8'));
    expect(readdirSync(join(dstDir, 'sweeps'))).toHaveLength(1);
  });

  it('carries merge ledgers only — an operator sweep ledger is not a reversal record', () => {
    const srcDir = makeTmp('lynox-ledger-kinds-src-');
    const dstDir = makeTmp('lynox-ledger-kinds-dst-');
    const { store, threadStore } = openStores(srcDir);
    const dup = store.createSubject({ kind: 'organization', name: 'Vitalis AG' });
    const canon = store.createSubject({ kind: 'organization', name: 'Vitalis' });
    expect(runMerge(store, null, threadStore, srcDir, dup, canon).ok).toBe(true);

    writeFileSync(join(srcDir, 'sweeps', 'sweep-2026-08-20T10-00-00-000Z.json'),
      JSON.stringify({ version: 1, phase: 'archive', archived: [], primaryNulled: [] }), 'utf-8');

    const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
    const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY });
    const { manifest, chunks } = exporter.export(performHandshake(importer));
    importer.setManifest(manifest);
    for (const chunk of chunks) importer.receiveChunk(chunk);

    expect(importer.restore().mergeLedgersImported).toBe(1);
    expect(readdirSync(join(dstDir, 'sweeps')).filter((f) => f.startsWith('sweep-'))).toEqual([]);

    // The destination assert above cannot fail on its own: the importer drops a sweep
    // ledger whatever the exporter did, so deleting the EXPORTER's filter would stay
    // green here. This is the trap the lookalike test's comment names, and the first
    // version of this test walked straight into it. Pin the payload.
    const sweepsChunk = manifest.chunks.find((c) => c.type === 'sweeps');
    expect(sweepsChunk).toBeDefined();
    const realName = readdirSync(join(srcDir, 'sweeps')).find((n) => isMergeLedgerFileName(n))!;
    expect(sweepsChunk!.originalSize).toBe(
      Buffer.byteLength(JSON.stringify({ files: { [realName]: readLedgerRaw(srcDir) } }), 'utf-8'),
    );
  });
});
