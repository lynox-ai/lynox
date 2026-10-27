import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { MigrationImporter } from '../core/migration-import.js';
import type { MigrationManifest } from '../core/migration-crypto.js';
import { resetShellIsolationForTest, setShellIsolationForTest, type ShellIsolation } from '../core/shell-isolation.js';
import { _resetWorkspaceAccess } from '../core/workspace-access.js';

/**
 * The target of the export: a real importer in a temp dir, answering the four calls the route
 * makes. The route reaches the network only through `network-guard.js` (imported lazily there),
 * so stubbing that module is the seam: the route, the exporter and the transfer run for real.
 */
const target: { importer: MigrationImporter | null; manifest: MigrationManifest | null } = { importer: null, manifest: null };
const TOKEN = 'e'.repeat(64);

vi.mock('../core/network-guard.js', async (original) => {
  const real = await original<typeof import('../core/network-guard.js')>();
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  return {
    ...real,
    assertPublicUrl: vi.fn(async () => undefined),
    fetchPinned: vi.fn(async (url: string, init: RequestInit = {}) => {
      const imp = target.importer!;
      const path = new URL(url).pathname;
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
      try {
        if (path === '/api/migration/handshake' && (init.method ?? 'GET') === 'GET') return json(imp.startHandshake(TOKEN));
        if (path === '/api/migration/handshake') { imp.completeHandshake((body as { clientPubKey: string }).clientPubKey); return json({ ready: true }); }
        if (path === '/api/migration/manifest') { target.manifest = body as MigrationManifest; imp.setManifest(target.manifest); return json({ accepted: true }); }
        if (path === '/api/migration/chunk') return json(imp.receiveChunk(body as Parameters<MigrationImporter['receiveChunk']>[0]));
        // The target's restore is not under test: answered without writing.
        if (path === '/api/migration/restore') return json({ success: true, verification: {} });
      } catch (err: unknown) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return json({ error: `unexpected ${path}` }, 404);
    }),
  };
});

const { LynoxHTTPApi } = await import('./http-api.js');
const { reloadConfig } = await import('../core/config.js');

/**
 * Walker 2 through its route (PRD D7): `POST /api/migration/export` in shell sidecar mode, the
 * tier unset. The workspace is left out of what reaches the target, the rest goes, and the
 * route's result says so. A pool directory at `chmod 000` is in the workspace: wired to a walk,
 * the export would end in an error event instead.
 */
describe('the migration export route in sidecar mode (real engine)', () => {
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const sidecar = { kind: 'sidecar', socket: '/run/lynox/shell.sock', root: {} } as unknown as ShellIsolation;
  let api: InstanceType<typeof LynoxHTTPApi>;
  let baseUrl: string;
  let dir: string;
  let dst: string;
  let locked: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-sidecar-export-'));
    dst = mkdtempSync(join(tmpdir(), 'lynox-sidecar-export-dst-'));
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
    mkdirSync(join(dir, 'apis'), { recursive: true });
    writeFileSync(join(dir, 'apis', 'shop.json'), '{"id":"shop"}');
    locked = join(dir, 'workspace', 'pool-7');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(dir, 'workspace', 'mine.txt'), 'ZZ-mine');
    chmodSync(locked, 0o000);
    _resetWorkspaceAccess();
  }, 120_000);

  afterEach(() => {
    resetShellIsolationForTest();
    target.importer?.cleanup();
    target.importer = null;
    target.manifest = null;
  });

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      chmodSync(locked, 0o700);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
      reloadConfig();
    }
  });

  /** Runs the export and returns the SSE events by name. */
  async function exportTo(): Promise<Map<string, unknown>> {
    target.importer = new MigrationImporter({ lynoxDir: dst, vaultKey: 'a-dst-vault-key-for-the-route-test' });
    const res = await fetch(`${baseUrl}/api/migration/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'https://target.example', migrationToken: TOKEN }),
    });
    expect(res.status).toBe(200);
    const events = new Map<string, unknown>();
    for (const block of (await res.text()).split('\n\n')) {
      const name = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (name !== undefined && data !== undefined) events.set(name, JSON.parse(data));
    }
    return events;
  }

  it('leaves the workspace out of what reaches the target, carries the rest, and says so', async () => {
    setShellIsolationForTest(sidecar);
    const events = await exportTo();
    expect(events.get('error')).toBeUndefined();
    expect(events.get('done')).toMatchObject({ success: true, workspace: 'omitted-sidecar' });
    const names = target.manifest!.chunks.map(c => c.name);
    expect(names).toContain('apis');
    expect(names.filter(n => n.split(':')[0] === 'workspace')).toEqual([]);
  });

  it('control: in local mode the same route walks the tree and fails on the closed directory', async () => {
    const events = await exportTo();
    expect(events.get('done')).toBeUndefined();
    expect((events.get('error') as { message: string }).message).toMatch(/EACCES|permission/i);
  });
});
