import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { MigrationExporter } from '../core/migration-export.js';
import type { MigrationImporter } from '../core/migration-import.js';
import { generateEphemeralKeypair, serializePublicKey, deserializePublicKey, deriveTransferKey } from '../core/migration-crypto.js';
import { _resetWorkspaceAccess } from '../core/workspace-access.js';
import { resetShellIsolationForTest, setShellIsolationForTest, WORKSPACE_LABEL, type ShellIsolation } from '../core/shell-isolation.js';
import { anchorFromFd, closeAnchor } from '../core/workspace-fd.js';
import { getWorkspaceDir, setTenantWorkspace } from '../core/workspace.js';
import { closeWorkspaceBase } from '../core/workspace-rel.js';

/**
 * The routes that would walk or empty the shared workspace tree, in shell sidecar mode (PRD D6,
 * D7), on a real engine. The mode decides, never the tier: each refusal is shown with the tier
 * unset, and each test asserts the message, so a tier check cannot make it green.
 */
describe('routes in sidecar mode (real engine)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret scan looks for.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];
  const sidecar = { kind: 'sidecar', socket: '/run/lynox/shell.sock', root: {} } as unknown as ShellIsolation;
  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const tier = (value: string | undefined): void => {
    if (value === undefined) delete process.env['LYNOX_BILLING_TIER'];
    else process.env['LYNOX_BILLING_TIER'] = value;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-sidecar-routes-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  }, 120_000);

  afterEach(() => {
    resetShellIsolationForTest();
    tier(undefined);
  });

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  describe('D6: the full erase', () => {
    const plant = (): string => {
      mkdirSync(join(dir, 'workspace'), { recursive: true });
      const f = join(dir, 'workspace', 'keep.md');
      writeFileSync(f, 'kept');
      return f;
    };
    const erase = (): Promise<Response> => call('DELETE', '/api/data', { confirm: 'DELETE_ALL_DATA' });

    it('refuses without a tier, names the mode-less way out, and erases nothing', async () => {
      const f = plant();
      setShellIsolationForTest(sidecar);
      const res = await erase();
      const body = await res.json() as { error: string; code: string };
      expect(res.status).toBe(409);
      expect(body.code).toBe('erasure_sidecar_mode');
      expect(body.error).toBe('On this instance lynox does not delete everything item by item. On this instance you manage the workspace files outside lynox. Remove them where you manage them.');
      expect(existsSync(f)).toBe(true);
    });

    it('refuses on a managed tier with the account-page way out, not the bare tier 403', async () => {
      const f = plant();
      setShellIsolationForTest(sidecar);
      tier('managed');
      const res = await erase();
      const body = await res.json() as { error: string; code: string };
      expect(res.status).toBe(409);
      expect(body.code).toBe('erasure_sidecar_mode');
      expect(body.error).toBe('On this instance lynox does not delete everything item by item. You remove everything by deleting the instance. To do that, cancel your subscription on your account page. When the instance is deleted after that is stated in the privacy policy (https://lynox.ai/privacy); to have it done right away, write to support@lynox.ai.');
      expect(body.error).not.toMatch(/manage the workspace files outside lynox/);
      expect(existsSync(f)).toBe(true);
    });

    it('control: in local mode the same request is not refused for the mode', async () => {
      plant();
      // A wrong confirmation stops before anything is erased, after the mode check.
      const res = await call('DELETE', '/api/data', { confirm: 'no' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).not.toBe('erasure_sidecar_mode');
    });
  });

  describe('walker 4: the backup restore, without a tier', () => {
    it('refuses a backup that holds workspace files, names the way out, and changes nothing', async () => {
      mkdirSync(join(dir, 'workspace'), { recursive: true });
      writeFileSync(join(dir, 'workspace', 'kept.md'), 'ZZ-kept');
      const made = await call('POST', '/api/backups');
      const created = await made.json() as { success: boolean; path: string; manifest: { files: Array<{ path: string }> } };
      expect(created.success).toBe(true);
      expect(created.manifest.files.map(f => f.path)).toContain('workspace/kept.md');
      writeFileSync(join(dir, 'workspace', 'kept.md'), 'ZZ-live');

      setShellIsolationForTest(sidecar);
      const res = await call('POST', `/api/backups/${basename(created.path)}/restore`, { allow_unverified: true });
      const body = await res.json() as { error: string; code: string; success: boolean };
      expect(res.status).toBe(409);
      expect(body.code).toBe('workspace_sidecar_mode');
      expect(body.error).toBe('This backup contains files from the workspace. On this instance lynox does not restore them from a backup; nothing was changed. You can restore the rest from a backup without the workspace. On this instance you manage the workspace files outside lynox.');
      expect(readFileSync(join(dir, 'workspace', 'kept.md'), 'utf8')).toBe('ZZ-live');
    });
  });

  // The tree is a directory of the test machine handed over as fd 3; `/workspace` does not exist
  // here, so a route that still reached it by name would fail or answer from somewhere else (D3).
  describe('D3: the file area and the workspace status, reached through fd 3', () => {
    const withTree = async (fn: (tree: string) => Promise<void>): Promise<void> => {
      const tree = join(dir, 'fd3-tree');
      mkdirSync(join(tree, 'ctx1'), { recursive: true });
      const anchor = anchorFromFd(openSync(tree, constants.O_RDONLY | constants.O_DIRECTORY), WORKSPACE_LABEL);
      const before = getWorkspaceDir();
      setShellIsolationForTest({ kind: 'sidecar', socket: '/run/lynox/shell.sock', root: { mode: 'sidecar', anchor, label: WORKSPACE_LABEL } });
      _resetWorkspaceAccess();
      setTenantWorkspace(`${WORKSPACE_LABEL}/ctx1`);
      try {
        await fn(tree);
      } finally {
        closeWorkspaceBase();
        setTenantWorkspace(before);
        resetShellIsolationForTest();
        _resetWorkspaceAccess();
        closeAnchor(anchor);
        rmSync(tree, { recursive: true, force: true });
      }
    };

    it('GET /api/files lists the context folder from fd 3 and makes nothing by name', async () => {
      await withTree(async (tree) => {
        writeFileSync(join(tree, 'ctx1', 'report.md'), 'x');
        const res = await call('GET', '/api/files');
        expect(res.status).toBe(200);
        const body = await res.json() as { entries: Array<{ name: string }> };
        expect(body.entries.map(e => e.name)).toEqual(['report.md']);
      });
    });

    it('the workspace status names the sidecar mode, compares fd 3\'s mount, and reads no old location', async () => {
      await withTree(async () => {
        mkdirSync(join(dir, 'workspace'), { recursive: true });
        writeFileSync(join(dir, 'workspace', 'left.md'), 'x');
        const res = await call('GET', '/api/admin/workspace/status');
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body['workspace_root_mode']).toBe('sidecar');
        expect(body['workspace_legacy_pending']).toBe(false);
        // fd 3 and the data directory are on the same mount here: not a mount of its own.
        if (process.platform === 'linux') expect(body['workspace_root_is_mount']).toBe(false);
        rmSync(join(dir, 'workspace', 'left.md'));
      });
    });
  });

  describe('the backup list (row 987)', () => {
    type Listed = { backup_id: string; provenance?: string; coverage?: { workspace: string } };
    const listed = async (id: string): Promise<Listed | undefined> =>
      ((await (await call('GET', '/api/backups')).json()) as { backups: Listed[] }).backups.find(b => b.backup_id === id);

    it('delivers each backup\'s provenance, so a record stripped from a signed manifest shows as mismatch', async () => {
      setShellIsolationForTest(sidecar);
      const created = await (await call('POST', '/api/backups')).json() as { success: boolean; path: string };
      expect(created.success).toBe(true);
      const id = basename(created.path);
      expect(await listed(id)).toMatchObject({ provenance: 'verified', coverage: { workspace: 'omitted-sidecar' } });

      const file = join(created.path, 'manifest.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      delete manifest['coverage'];
      writeFileSync(file, JSON.stringify(manifest, null, 2));
      const stripped = await listed(id);
      expect(stripped?.coverage).toBeUndefined();
      expect(stripped?.provenance).toBe('mismatch');
    });
  });

  describe('walker 3: the migration import, with the tier set', () => {
    let src: string;
    const SRC_KEY = `s-${randomBytes(12).toString('hex')}`;
    const IMPORT_MANAGED = 'This import contains files from the workspace. On this instance lynox does not bring them in during an import; nothing was changed. Import without the workspace; for the files, write to support@lynox.ai.';
    type Internals = { _getOrCreateMigrationImporter: () => Promise<MigrationImporter | null>; _restoring: boolean };
    const internals = (): Internals => api as unknown as Internals;

    /** A session through the handshake, and the source's export made in local mode, so it carries the workspace. */
    async function handshake(): Promise<{ importer: MigrationImporter; exported: ReturnType<MigrationExporter['export']> }> {
      src = mkdtempSync(join(tmpdir(), 'lynox-sidecar-routes-src-'));
      mkdirSync(join(src, 'workspace'), { recursive: true });
      writeFileSync(join(src, 'workspace', 'theirs.md'), 'ZZ-theirs');
      writeFileSync(join(src, 'config.json'), JSON.stringify({ default_tier: 'deep' }));
      _resetWorkspaceAccess();
      const importer = await internals()._getOrCreateMigrationImporter();
      if (importer === null) throw new Error('fixture: no importer');
      const sh = importer.startHandshake('e'.repeat(64));
      const kp = generateEphemeralKeypair();
      const key = deriveTransferKey(kp.privateKey, deserializePublicKey(sh.serverPubKey), Buffer.from(sh.challengeNonce, 'hex'));
      importer.completeHandshake(serializePublicKey(kp.publicKey));
      const exported = new MigrationExporter({ lynoxDir: src, vaultKey: SRC_KEY }).export(key);
      expect(exported.manifest.chunks.map(c => c.name)).toContain('workspace');
      return { importer, exported };
    }

    afterEach(async () => {
      await call('DELETE', '/api/migration');
      if (src !== undefined) rmSync(src, { recursive: true, force: true });
    });

    it('refuses the manifest before any chunk is transferred', async () => {
      const { exported } = await handshake();
      setShellIsolationForTest(sidecar);
      tier('starter');
      const res = await call('POST', '/api/migration/manifest', exported.manifest);
      const body = await res.json() as { error: string; code: string };
      expect(res.status).toBe(409);
      expect(body.code).toBe('workspace_sidecar_mode');
      expect(body.error).toBe(IMPORT_MANAGED);
    });

    it('refuses on the assembled bundles before the engine shuts down', async () => {
      const { importer, exported } = await handshake();
      // Past the manifest route, as a mislabelled chunk would get: the deciding check is the next one.
      importer.setManifest(exported.manifest);
      for (const c of exported.chunks) importer.receiveChunk(c);
      const config = (): string | null => existsSync(join(dir, 'config.json')) ? readFileSync(join(dir, 'config.json'), 'utf8') : null;
      const before = config();
      setShellIsolationForTest(sidecar);
      tier('starter');
      const res = await call('POST', '/api/migration/restore');
      const body = await res.json() as { error: string; code: string };
      expect(res.status).toBe(409);
      expect(body.code).toBe('workspace_sidecar_mode');
      expect(body.error).toBe(IMPORT_MANAGED);
      expect(internals()._restoring).toBe(false);
      expect(config()).toBe(before);
      // The engine still answers: it was not shut down.
      expect((await call('GET', '/api/backups')).status).toBe(200);
    });

    it('refuses a mislabelled chunk on the bundles, which the manifest check cannot see', async () => {
      const { importer, exported } = await handshake();
      importer.setManifest(exported.manifest);
      for (const c of exported.chunks) importer.receiveChunk(c);
      // The name in the manifest is not bound to the payload: renamed after the transfer, the
      // workspace bundle is filed under `apis`, so only the content still says `workspace`.
      exported.manifest.chunks.find(c => c.name === 'workspace')!.name = 'apis';
      setShellIsolationForTest(sidecar);
      tier('starter');
      const res = await call('POST', '/api/migration/restore');
      const body = await res.json() as { error: string; code: string };
      expect(res.status).toBe(409);
      expect(body.code).toBe('workspace_sidecar_mode');
      expect(body.error).toBe(IMPORT_MANAGED);
      expect(internals()._restoring).toBe(false);
    });
  });
});
