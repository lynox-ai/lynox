import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
    const f = readdirSync(join(dir, 'sweeps')).find((n) => n.startsWith('merge-'))!;
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

    // The capability, not the file: the restored ledger actually reverses the merge.
    const back = rollbackMergeRun(store, null, threadStore, readLedgerFrom(dir));
    expect(back.ok).toBe(true);
    expect(store.getSubject(dup)?.archived_at).toBeFalsy();
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

  it('refuses a crafted bundle key that tries to escape sweeps/', () => {
    const srcDir = makeTmp('lynox-ledger-evilsrc-');
    const dstDir = makeTmp('lynox-ledger-evildst-');

    // Names an importer must refuse. The guard is the WRITER's own name shape, which
    // admits a basename only — so traversal, absolute paths and lookalikes all fail it
    // without the importer needing its own separate notion of "safe".
    for (const evil of [
      '../../evil.json',
      '/etc/passwd',
      'merge-2026-08-20T10-00-00-000Z-abc123.json/../../escape.json',
      'sweep-2026-08-20T10-00-00-000Z.json',
      'merge-2026-08-20T10-00-00-000Z-abc123.json.bak',
    ]) {
      expect(isMergeLedgerFileName(evil), `must refuse ${evil}`).toBe(false);
    }
    expect(isMergeLedgerFileName('merge-2026-08-20T10-00-00-000Z-abc123.json')).toBe(true);

    // And end-to-end: a bundle carrying such a key writes nothing outside sweeps/.
    mkdirSync(join(srcDir, 'sweeps'), { recursive: true });
    writeFileSync(join(srcDir, 'sweeps', '../escape-attempt.json'), '{"pwned":true}', 'utf-8');
    const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
    const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY });
    const { manifest, chunks } = exporter.export(performHandshake(importer));
    importer.setManifest(manifest);
    for (const chunk of chunks) importer.receiveChunk(chunk);
    importer.restore();
    expect(existsSync(join(dstDir, 'escape-attempt.json'))).toBe(false);
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
  });
});
