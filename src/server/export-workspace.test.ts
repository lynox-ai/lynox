import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { EXPORT_STAGING_DIR } from '../core/workspace-export.js';

/**
 * The workspace files of the Art. 15 / Art. 20 export, on a real engine: the JSON export names
 * them, `GET /api/export/workspace` streams them as a tar, and the staged copy never outlives the
 * request — not a completed one, not an aborted one, not a crashed one (the boot sweep).
 */
describe('workspace files in the export (real engine)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret scan looks for.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];
  const staging = (): string => join(dir, EXPORT_STAGING_DIR);
  const get = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${SECRET}` } });
  const LEFTOVER = 'workspace-crashed';
  /** The handler removes its staged copy once the stream has ended on ITS side, which can be a
   *  moment after the client holds the last byte. */
  const stagingEmptied = async (): Promise<string[]> => {
    const deadline = Date.now() + 10_000;
    while (readdirSync(staging()).length > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    return readdirSync(staging());
  };
  /** A whole export, body read to the end: an unread body holds the export slot. */
  const fullExport = async (): Promise<number> => {
    const res = await get('/api/export/workspace');
    await res.arrayBuffer();
    await stagingEmptied();
    return res.status;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-export-ws-'));
    // What a process that died mid-export leaves behind; the boot sweep must remove it.
    mkdirSync(join(dir, EXPORT_STAGING_DIR, LEFTOVER), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, EXPORT_STAGING_DIR, LEFTOVER, 'workspace.tar'), 'half an archive');
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

  it('the boot sweep removed the staged copy a crashed export left behind', () => {
    expect(existsSync(join(staging(), LEFTOVER))).toBe(false);
  });

  it('streams the workspace as a tar GNU tar reads, names it in the JSON export, and leaves no staged copy', async () => {
    mkdirSync(join(dir, 'workspace', 'out'), { recursive: true });
    writeFileSync(join(dir, 'workspace', 'out', 'report.md'), '# Quarterly');

    const json = await (await get('/api/export')).json() as { workspace: { files: Array<{ path: string; size: number }> }; workspace_archive: string };
    expect(json.workspace.files).toEqual([{ path: 'out/report.md', size: 11 }]);
    expect(json.workspace_archive).toBe('/api/export/workspace');

    const res = await get('/api/export/workspace');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-tar');
    expect(res.headers.get('x-lynox-workspace-files')).toBe('1');
    expect(res.headers.get('x-lynox-workspace-incomplete')).toBe('false');
    const tar = Buffer.from(await res.arrayBuffer());
    const tarPath = join(dir, 'got.tar');
    writeFileSync(tarPath, tar);
    expect(execFileSync('tar', ['-xOf', tarPath, 'workspace/out/report.md']).toString()).toBe('# Quarterly');
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', tarPath, 'workspace-manifest.json']).toString()) as { files: Array<{ sha256: string }> };
    expect(manifest.files[0]!.sha256).toBe(createHash('sha256').update('# Quarterly').digest('hex'));
    expect(await stagingEmptied()).toEqual([]);
  });

  it('refuses a request without the admin bearer', async () => {
    expect((await fetch(`${baseUrl}/api/export/workspace`)).status).toBe(401);
  });

  it('answers 409 while another workspace export runs, and serves again once it is over', async () => {
    const flag = api as unknown as { workspaceExportInProgress: boolean };
    flag.workspaceExportInProgress = true;
    try {
      const res = await get('/api/export/workspace');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('export_in_progress');
    } finally {
      flag.workspaceExportInProgress = false;
    }
    expect(await fullExport()).toBe(200);
  });

  it('answers 409 while an erasure runs', async () => {
    const flag = api as unknown as { erasureInProgress: boolean };
    flag.erasureInProgress = true;
    try {
      const res = await get('/api/export/workspace');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('erasure_in_progress');
    } finally {
      flag.erasureInProgress = false;
    }
  });

  it('removes the staged copy when the client leaves mid-download', async () => {
    // Large enough that the body is still streaming when the client aborts.
    writeFileSync(join(dir, 'workspace', 'big.bin'), randomBytes(8 * 1024 * 1024));
    const ctrl = new AbortController();
    const res = await fetch(`${baseUrl}/api/export/workspace`, { headers: { Authorization: `Bearer ${SECRET}` }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    ctrl.abort();
    await reader.cancel().catch(() => { /* aborted */ });
    expect(await stagingEmptied()).toEqual([]);
    // The flag is released too: the next export is served.
    expect(await fullExport()).toBe(200);
  });
});
