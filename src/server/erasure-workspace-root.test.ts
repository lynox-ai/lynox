import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { scopeToDir } from '../core/scope-resolver.js';
import type { Memory } from '../core/memory.js';
import type { WorkspaceAccess } from '../core/workspace-access.js';
import { _resetWorkspaceAccess, workspaceAccess } from '../core/workspace-access.js';

/**
 * `DELETE /api/data` reaches the workspace through the anchored root (PRD P18 D5): the root is
 * emptied in place, never removed by name, never through a link, and a mount below it, a
 * remainder or a root the engine cannot reach is a failure — measured on a real engine.
 */
describe('Art. 17 erasure — the workspace root (real engine)', () => {
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  let outside: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_WORKSPACE_ROOT'];
  const IS_ROOT = process.getuid?.() === 0;

  const root = (): string => join(dir, 'workspace');
  const seams = (): { _workspaceWalk: (a: WorkspaceAccess, d: string) => Promise<{ readonly mountBoundaries: readonly string[]; readonly dataDirAt: readonly string[] }> } =>
    api as unknown as { _workspaceWalk: (a: WorkspaceAccess, d: string) => Promise<{ readonly mountBoundaries: readonly string[]; readonly dataDirAt: readonly string[] }> };

  async function erase(): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/data`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE_ALL_DATA' }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  /** A marker in the flat-file memory, the first store the erasure empties: intact = nothing erased. */
  function memoryMarker(): () => string | null {
    const memory = (api as unknown as { engine: { getMemory: () => Memory | null } }).engine.getMemory();
    if (memory === null) throw new Error('fixture: no flat-file memory');
    const path = join(dir, 'memory', scopeToDir(memory.currentScope()), 'knowledge.txt');
    const mark = `ZZMARK-${randomBytes(3).toString('hex')}`;
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, mark);
    return () => (existsSync(path) && readFileSync(path, 'utf8') === mark ? mark : null);
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-ws-'));
    outside = mkdtempSync(join(tmpdir(), 'lynox-erasure-ws-outside-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    delete process.env['LYNOX_WORKSPACE_ROOT'];
    _resetWorkspaceAccess();
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  }, 120_000);

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      _resetWorkspaceAccess();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      if (outside !== undefined) rmSync(outside, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('empties the root in place, keeps its inode and the context dir, and does not follow a link (I1b, I1f)', async () => {
    const ino = statSync(root()).ino;
    mkdirSync(join(root(), 'sub', 'deep'), { recursive: true });
    writeFileSync(join(root(), 'http-api', 'a.txt'), 'ZZ-a');
    writeFileSync(join(root(), 'sub', 'deep', 'b.txt'), 'ZZ-b');
    writeFileSync(join(outside, 'target.txt'), 'ZZ-outside');
    symlinkSync(join(outside, 'target.txt'), join(root(), 'http-api', 'link'));

    const res = await erase();
    expect(res.body['failed'] ?? []).toEqual([]);
    expect(res.status).toBe(200);
    expect(res.body['message']).toBe('All user data has been permanently deleted');
    expect(statSync(root()).ino).toBe(ino);
    expect(readdirSync(root())).toEqual(['http-api']);
    expect(readdirSync(join(root(), 'http-api'))).toEqual([]);
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('ZZ-outside');
  }, 60_000);

  it('refuses the whole erasure with 409 when the anchor walk finds a mount below the root (I1e)', async () => {
    const intact = memoryMarker();
    writeFileSync(join(root(), 'http-api', 'kept.txt'), 'ZZ-kept');
    const s = seams();
    const real = s._workspaceWalk;
    s._workspaceWalk = async () => ({ mountBoundaries: ['proj/mnt'], dataDirAt: [] });
    try {
      const res = await erase();
      expect(res.status).toBe(409);
      expect(res.body['code']).toBe('linked_entries');
      const linked = res.body['linked'] as Array<{ name: string; reason: string }>;
      expect(linked.map(l => l.name)).toEqual(['workspace']);
      expect(linked[0]!.reason).toMatch(/proj\/mnt/);
    } finally {
      s._workspaceWalk = real;
    }
    expect(intact()).not.toBeNull();
    expect(readFileSync(join(root(), 'http-api', 'kept.txt'), 'utf8')).toBe('ZZ-kept');
    rmSync(join(root(), 'http-api', 'kept.txt'));
  }, 60_000);

  it('the erasure walk names a directory of the root that IS the directory it is asked about', async () => {
    mkdirSync(join(root(), 'sub', 'deeper'), { recursive: true });
    const access = workspaceAccess();
    const s = seams();
    expect((await s._workspaceWalk(access, join(root(), 'sub', 'deeper'))).dataDirAt).toEqual(['sub/deeper']);
    expect((await s._workspaceWalk(access, root())).dataDirAt).toEqual(['']);
    expect((await s._workspaceWalk(access, dir)).dataDirAt).toEqual([]);
    rmSync(join(root(), 'sub'), { recursive: true });
  }, 60_000);

  it('refuses with 409 when the anchor walk finds the data directory inside the root, and erases nothing', async () => {
    const intact = memoryMarker();
    writeFileSync(join(root(), 'http-api', 'kept.txt'), 'ZZ-kept');
    const s = seams();
    const real = s._workspaceWalk;
    let askedFor: string | null = null;
    // A bind mount of the data directory into the root takes privileges; the walk is stood in for,
    // and the real one is still asked with the data directory, so the seam cannot drift from it.
    s._workspaceWalk = async (a, d) => {
      askedFor = d;
      const found = await real.call(api, a, d);
      return { mountBoundaries: found.mountBoundaries, dataDirAt: ['srv/lynox'] };
    };
    try {
      const res = await erase();
      expect(res.status).toBe(409);
      expect(res.body['code']).toBe('linked_entries');
      const linked = res.body['linked'] as Array<{ name: string; reason: string }>;
      expect(linked.find(l => l.name === 'workspace')?.reason).toMatch(/contains the data directory/);
    } finally {
      s._workspaceWalk = real;
    }
    expect(askedFor).not.toBeNull();
    expect(intact()).not.toBeNull();
    expect(readFileSync(join(root(), 'http-api', 'kept.txt'), 'utf8')).toBe('ZZ-kept');
    rmSync(join(root(), 'http-api', 'kept.txt'));
  }, 60_000);

  it.skipIf(IS_ROOT)('answers failed, never success, when something below the root cannot be removed (I1c)', async () => {
    mkdirSync(join(root(), 'locked'));
    writeFileSync(join(root(), 'locked', 'x.txt'), 'ZZ-x');
    chmodSync(join(root(), 'locked'), 0o500);
    try {
      const res = await erase();
      expect(res.status).toBe(500);
      expect(res.body['deleted']).toBe(false);
      expect(res.body['failed'] as string[]).toContain('workspace');
      expect(res.body['message']).toBeUndefined();
    } finally {
      chmodSync(join(root(), 'locked'), 0o700);
      rmSync(join(root(), 'locked'), { recursive: true, force: true });
    }
  }, 60_000);

  // Last: it replaces the root under the engine's anchor.
  it('erases nothing and answers 500 when the root the engine holds is gone (I1d)', async () => {
    const intact = memoryMarker();
    rmSync(root(), { recursive: true, force: true });
    mkdirSync(root());
    const res = await erase();
    expect(res.status).toBe(500);
    expect(res.body['deleted']).toBe(false);
    expect(res.body['failed']).toEqual(['workspace']);
    expect(intact()).not.toBeNull();
  }, 60_000);
});
