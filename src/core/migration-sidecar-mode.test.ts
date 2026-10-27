import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationExporter } from './migration-export.js';
import { MigrationImporter, manifestCarriesWorkspace } from './migration-import.js';
import { generateEphemeralKeypair, serializePublicKey, deserializePublicKey, deriveTransferKey, type MigrationManifest } from './migration-crypto.js';
import { resetShellIsolationForTest, setShellIsolationForTest, type ShellIsolation } from './shell-isolation.js';
import { _resetWorkspaceAccess } from './workspace-access.js';

const IS_ROOT = process.getuid?.() === 0;
const SIDECAR = { kind: 'sidecar', socket: '/run/lynox/shell.sock', root: {} } as unknown as ShellIsolation;
const LOCAL = { kind: 'local' } as ShellIsolation;
const SRC_KEY = 'a-src-vault-key-for-the-sidecar-test';
const DST_KEY = 'a-dst-vault-key-for-the-sidecar-test';
const IMPORT_SELF_HOST = 'This import contains files from the workspace. On this instance lynox does not bring them in during an import; nothing was changed. Import without the workspace. On this instance you manage the workspace files outside lynox.';

/**
 * Migration in shell sidecar mode (PRD D7): the export leaves the workspace out and records it
 * (walker 2); the import recognises a workspace by the manifest and, deciding, by the assembled
 * bundles (walker 3), and refuses to stage it. A pool directory at `chmod 000` sits in the
 * source's workspace, the shape that makes a walk throw.
 */
describe('migration — shell sidecar mode', () => {
  let tmp: string;
  let src: string;
  let dst: string;
  let locked: string;
  let savedTier: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-mig-sidecar-')));
    src = join(tmp, 'src');
    dst = join(tmp, 'dst');
    mkdirSync(join(src, 'apis'), { recursive: true });
    writeFileSync(join(src, 'apis', 'shop.json'), '{"id":"shop"}');
    writeFileSync(join(src, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
    mkdirSync(join(src, 'workspace'), { recursive: true });
    writeFileSync(join(src, 'workspace', 'mine.txt'), 'ZZ-mine');
    locked = join(src, 'workspace', 'pool-7');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    mkdirSync(dst, { recursive: true });
    savedTier = process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_BILLING_TIER'];
    _resetWorkspaceAccess();
  });

  afterEach(() => {
    resetShellIsolationForTest();
    _resetWorkspaceAccess();
    chmodSync(locked, 0o700);
    if (savedTier === undefined) delete process.env['LYNOX_BILLING_TIER']; else process.env['LYNOX_BILLING_TIER'] = savedTier;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A finished transfer into a fresh importer: handshake, manifest, every chunk. */
  function transfer(): { importer: MigrationImporter; manifest: MigrationManifest; workspace: string | undefined } {
    const importer = new MigrationImporter({ lynoxDir: dst, vaultKey: DST_KEY });
    const sh = importer.startHandshake('e'.repeat(64));
    const kp = generateEphemeralKeypair();
    const key = deriveTransferKey(kp.privateKey, deserializePublicKey(sh.serverPubKey), Buffer.from(sh.challengeNonce, 'hex'));
    importer.completeHandshake(serializePublicKey(kp.publicKey));
    const result = new MigrationExporter({ lynoxDir: src, vaultKey: SRC_KEY }).export(key);
    importer.setManifest(result.manifest);
    for (const c of result.chunks) importer.receiveChunk(c);
    return { importer, manifest: result.manifest, workspace: result.workspace };
  }
  const names = (m: MigrationManifest): string[] => m.chunks.map(c => c.name);

  describe('export (walker 2): omitted and recorded', () => {
    type WithCollect = { collectWorkspace(isolation?: ShellIsolation): unknown[] };

    it('collectWorkspace itself walks nothing in sidecar mode', () => {
      const exporter = new MigrationExporter({ lynoxDir: src, vaultKey: SRC_KEY });
      expect((exporter as unknown as WithCollect).collectWorkspace(SIDECAR)).toEqual([]);
    });

    it.skipIf(IS_ROOT)('control: in local mode the same tree makes the walk throw', () => {
      const exporter = new MigrationExporter({ lynoxDir: src, vaultKey: SRC_KEY });
      expect(() => (exporter as unknown as WithCollect).collectWorkspace(LOCAL)).toThrow(/EACCES|permission/i);
    });

    it('the export completes without a tier, carries the rest, and records the omission', () => {
      setShellIsolationForTest(SIDECAR);
      const { manifest, workspace } = transfer();
      expect(workspace).toBe('omitted-sidecar');
      expect(names(manifest)).toContain('apis');
      expect(names(manifest)).toContain('config');
      expect(names(manifest).filter(n => n.split(':')[0] === 'workspace')).toEqual([]);
    });

    it('control: in local mode the export carries the workspace and no record', () => {
      chmodSync(locked, 0o700);
      const { manifest, workspace } = transfer();
      expect(workspace).toBeUndefined();
      expect(names(manifest)).toContain('workspace');
    });
  });

  describe('import (walker 3): refused by content', () => {
    /** A transfer made in local mode, so the bundle carries the workspace; the import then runs in sidecar mode. */
    const withWorkspace = (): { importer: MigrationImporter; manifest: MigrationManifest } => {
      chmodSync(locked, 0o700);
      const t = transfer();
      setShellIsolationForTest(SIDECAR);
      return t;
    };

    it('the manifest names the workspace', () => {
      const { manifest } = withWorkspace();
      expect(manifestCarriesWorkspace(manifest)).toBe(true);
    });

    it('the assembled bundles carry it', () => {
      const { importer } = withWorkspace();
      expect(importer.bundlesCarryWorkspace()).toBe(true);
    });

    it('a mislabelled chunk is caught by the bundles, not by the manifest', () => {
      const { importer, manifest } = withWorkspace();
      // The name in the manifest is not bound to the payload: a chunk named `apis` that carries
      // `dir: 'workspace'` passes the manifest check.
      const ws = manifest.chunks.find(c => c.name === 'workspace')!;
      const apis = manifest.chunks.find(c => c.name === 'apis')!;
      manifest.chunks = manifest.chunks.filter(c => c !== apis);
      ws.name = 'apis';
      expect(manifestCarriesWorkspace(manifest)).toBe(false);
      expect(importer.bundlesCarryWorkspace()).toBe(true);
    });

    it('control: a transfer without the workspace carries none', () => {
      setShellIsolationForTest(SIDECAR);
      const { importer, manifest } = transfer();
      expect(manifestCarriesWorkspace(manifest)).toBe(false);
      expect(importer.bundlesCarryWorkspace()).toBe(false);
    });

    it('restoreWorkspace itself refuses in sidecar mode, after the checks before it', () => {
      const { importer } = withWorkspace();
      expect(() => importer.restore()).toThrow(IMPORT_SELF_HOST);
    });
  });
});
