import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';

/**
 * `GET /api/backups` leaves each backup's `files` out unless `?files=1` asks for it; the totals
 * stay either way. On a real engine with a real backup, so the list is the one the route serves.
 */
describe('GET /api/backups: files only on request (real engine)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret scan looks for.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  let id: string;
  let backupPath: string;
  let manifestFiles: { path: string; size_bytes: number }[];
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];
  const call = (method: string, path: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${SECRET}` } });
  const entry = async (query: string): Promise<Record<string, unknown>> => {
    const res = await call('GET', `/api/backups${query}`);
    expect(res.status).toBe(200);
    const found = ((await res.json()) as { backups: Record<string, unknown>[] }).backups.find(b => b['backup_id'] === id);
    if (found === undefined) throw new Error(`backup ${id} not listed for "${query}"`);
    return found;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-backups-list-route-'));
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

    mkdirSync(join(dir, 'workspace'), { recursive: true });
    writeFileSync(join(dir, 'workspace', 'a.md'), 'twelve bytes');
    const created = await (await call('POST', '/api/backups')).json() as { success: boolean; path: string };
    expect(created.success).toBe(true);
    backupPath = created.path;
    id = basename(created.path);
    manifestFiles = (JSON.parse(readFileSync(join(created.path, 'manifest.json'), 'utf8')) as { files: { path: string; size_bytes: number }[] }).files;
  }, 120_000);

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

  it('the backup has files to leave out (control)', () => {
    expect(manifestFiles.length).toBeGreaterThan(1);
    expect(manifestFiles.some(f => f.size_bytes > 0)).toBe(true);
  });

  it('without the parameter: no `files`, the totals of the manifest\'s files', async () => {
    const listed = await entry('');
    expect(Object.hasOwn(listed, 'files')).toBe(false);
    expect(listed['file_count']).toBe(manifestFiles.length);
    expect(listed['total_bytes']).toBe(manifestFiles.reduce((s, f) => s + f.size_bytes, 0));
    expect(listed['provenance']).toBe('verified');
  });

  it('with `?files=1`: the manifest\'s `files` as before, and the same totals', async () => {
    const listed = await entry('?files=1');
    expect(listed['files']).toEqual(manifestFiles);
    expect(listed['file_count']).toBe(manifestFiles.length);
    expect(listed['total_bytes']).toBe(manifestFiles.reduce((s, f) => s + f.size_bytes, 0));
  });

  it.each(['?files=0', '?files=true', '?files=', '?file=1'])('only `1` asks for them: %s leaves `files` out', async (query) => {
    expect(Object.hasOwn(await entry(query), 'files')).toBe(false);
  });

  it('leaving `files` out of the answer leaves the manifest on disk untouched', async () => {
    await entry('');
    const onDisk = JSON.parse(readFileSync(join(backupPath, 'manifest.json'), 'utf8')) as { files: unknown };
    expect(onDisk.files).toEqual(manifestFiles);
  });
});
