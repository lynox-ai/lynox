import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { scopeToDir } from '../core/scope-resolver.js';
import type { Memory } from '../core/memory.js';
import { _resetWorkspaceAccess } from '../core/workspace-access.js';

/**
 * A `<data>/workspace` that is a symlink boots as the default root, and `DELETE /api/data`
 * refuses it as before: 409 `linked_entries`, nothing erased, the target untouched. Emptying the
 * target through the anchor would empty whatever the link points at.
 */
describe('Art. 17 erasure — a linked default workspace (real engine)', () => {
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  let target: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_WORKSPACE_ROOT'];

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-erasure-wslink-')));
    target = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-erasure-wslink-target-')));
    symlinkSync(target, join(dir, 'workspace'));
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
      if (target !== undefined) rmSync(target, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('refuses with 409 linked_entries, erases nothing, and leaves the target as it was', async () => {
    // Booted through the link: the context dir lives at the target.
    expect(existsSync(join(target, 'http-api'))).toBe(true);
    writeFileSync(join(target, 'http-api', 'kept.txt'), 'ZZ-kept');
    mkdirSync(join(target, 'other'));
    writeFileSync(join(target, 'other', 'b.txt'), 'ZZ-b');
    const memory = (api as unknown as { engine: { getMemory: () => Memory | null } }).engine.getMemory();
    if (memory === null) throw new Error('fixture: no flat-file memory');
    const markerPath = join(dir, 'memory', scopeToDir(memory.currentScope()), 'knowledge.txt');
    mkdirSync(join(markerPath, '..'), { recursive: true });
    writeFileSync(markerPath, 'ZZMARK');

    const res = await fetch(`${baseUrl}/api/data`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE_ALL_DATA' }),
    });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(409);
    expect(body['code']).toBe('linked_entries');
    const linked = body['linked'] as Array<{ name: string; reason: string }>;
    expect(linked.map(l => l.name)).toContain('workspace');
    expect(linked.find(l => l.name === 'workspace')!.reason).toMatch(/symbolic link/);
    expect(readFileSync(markerPath, 'utf8')).toBe('ZZMARK');
    expect(readFileSync(join(target, 'http-api', 'kept.txt'), 'utf8')).toBe('ZZ-kept');
    expect(readFileSync(join(target, 'other', 'b.txt'), 'utf8')).toBe('ZZ-b');
  }, 60_000);
});
