import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
 * `DELETE /api/data` with the workspace root outside the data dir (PRD P18 D5, I1a, I5, I12): the
 * root is emptied through its anchor, and a `workspace` left in the data dir is a leftover — asked
 * about like an unknown entry, refused when it is a link, removed for good once acknowledged.
 */
describe('Art. 17 erasure — an external workspace root (real engine)', () => {
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  let outside: string;
  let ext: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_WORKSPACE_ROOT'];

  const root = (): string => ext;
  const leftover = (): string => join(dir, 'workspace');

  async function erase(body: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/data`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE_ALL_DATA', ...body }),
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
    ext = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-erasure-ws-ext-')));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    process.env['LYNOX_WORKSPACE_ROOT'] = ext;
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
      if (ext !== undefined) rmSync(ext, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('boots on the external root: the context lives there, nothing under <data>/workspace', () => {
    expect(statSync(join(root(), 'http-api')).isDirectory()).toBe(true);
    expect(existsSync(leftover())).toBe(false);
  });

  it('empties the external root and keeps it (I1a)', async () => {
    const ino = statSync(root()).ino;
    mkdirSync(join(root(), 'proj'), { recursive: true });
    writeFileSync(join(root(), 'proj', 'a.txt'), 'ZZ-a');
    writeFileSync(join(root(), 'http-api', 'b.txt'), 'ZZ-b');
    const res = await erase();
    expect(res.body['failed'] ?? []).toEqual([]);
    expect(res.status).toBe(200);
    expect(statSync(root()).ino).toBe(ino);
    expect(readdirSync(root())).toEqual(['http-api']);
    expect(readdirSync(join(root(), 'http-api'))).toEqual([]);
  }, 60_000);

  it('asks about a leftover, then removes it for good and empties the root (I5, I12a)', async () => {
    mkdirSync(join(leftover(), 'http-api'), { recursive: true });
    writeFileSync(join(leftover(), 'http-api', 'old.txt'), 'ZZ-old');
    writeFileSync(join(root(), 'http-api', 'new.txt'), 'ZZ-new');
    const intact = memoryMarker();
    const first = await erase();
    expect(first.status).toBe(409);
    expect(first.body['code']).toBe('unknown_entries');
    const unknown = first.body['unknown'] as Array<{ name: string }>;
    expect(unknown.map(u => u.name)).toEqual(['workspace']);
    expect(intact()).not.toBeNull();
    expect(readFileSync(join(leftover(), 'http-api', 'old.txt'), 'utf8')).toBe('ZZ-old');

    const second = await erase({ remove_unknown: unknown });
    expect(second.body['failed'] ?? []).toEqual([]);
    expect(second.status).toBe(200);
    expect(existsSync(leftover())).toBe(false);
    expect(readdirSync(join(root(), 'http-api'))).toEqual([]);
  }, 60_000);

  it('refuses a leftover that is a symlink, and leaves its target untouched (I12b)', async () => {
    mkdirSync(join(outside, 'proj'), { recursive: true });
    writeFileSync(join(outside, 'proj', 'kept.txt'), 'ZZ-target');
    symlinkSync(outside, leftover());
    try {
      const first = await erase();
      expect(first.status).toBe(409);
      expect(first.body['code']).toBe('unknown_entries');
      const unknown = first.body['unknown'] as Array<{ name: string }>;
      expect(unknown.map(u => u.name)).toEqual(['workspace']);
      const second = await erase({ remove_unknown: unknown });
      expect(second.status).toBe(409);
      expect(second.body['code']).toBe('linked_entries');
      expect((second.body['linked'] as Array<{ name: string }>).map(l => l.name)).toEqual(['workspace']);
      expect(second.body['deleted']).toBeUndefined();
      expect(readFileSync(join(outside, 'proj', 'kept.txt'), 'utf8')).toBe('ZZ-target');
    } finally {
      rmSync(leftover(), { force: true });
    }
  }, 60_000);
});
