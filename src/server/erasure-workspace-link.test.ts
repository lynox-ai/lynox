import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * A `<data>/workspace` that is a symlink boots as the default root (PRD D2). `DELETE /api/data`
 * empties it through the anchor when the link's target is a directory of its own (PRD I12d): the
 * target is emptied, the link and the target stay. A link into the data directory is refused:
 * 409 `linked_entries`, nothing erased — emptying it would empty that entry of the data directory.
 */

const SECRET = `t-${randomBytes(12).toString('hex')}`;
const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_WORKSPACE_ROOT'];

interface Booted {
  readonly api: LynoxHTTPApi;
  readonly baseUrl: string;
  readonly dir: string;
  readonly target: string;
  readonly cleanup: () => Promise<void>;
}

/** A real engine on a data dir whose `workspace` links to `targetOf(dataDir)`. */
async function boot(targetOf: (dataDir: string) => string): Promise<Booted> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-erasure-wslink-')));
  const target = targetOf(dir);
  mkdirSync(target, { recursive: true });
  symlinkSync(target, join(dir, 'workspace'));
  const saved: Record<string, string | undefined> = {};
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
  const api = new LynoxHTTPApi();
  await api.init();
  await api.start(0);
  const addr = (api as unknown as { server: Server | null }).server?.address();
  if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
  return {
    api, dir, target,
    baseUrl: `http://127.0.0.1:${String(addr.port)}`,
    cleanup: async () => {
      try {
        await api.shutdown();
      } finally {
        _resetWorkspaceAccess();
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        rmSync(dir, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
        reloadConfig();
      }
    },
  };
}

/** Files in the workspace and a memory marker in the data dir, for the erasure to reach. */
function seed(b: Booted): string {
  // Booted through the link: the context dir lives at the target.
  expect(existsSync(join(b.target, 'http-api'))).toBe(true);
  writeFileSync(join(b.target, 'http-api', 'kept.txt'), 'ZZ-kept');
  mkdirSync(join(b.target, 'other'));
  writeFileSync(join(b.target, 'other', 'b.txt'), 'ZZ-b');
  const memory = (b.api as unknown as { engine: { getMemory: () => Memory | null } }).engine.getMemory();
  if (memory === null) throw new Error('fixture: no flat-file memory');
  const markerPath = join(b.dir, 'memory', scopeToDir(memory.currentScope()), 'knowledge.txt');
  mkdirSync(join(markerPath, '..'), { recursive: true });
  writeFileSync(markerPath, 'ZZMARK');
  return markerPath;
}

/** Every file under `dir` with its size and mtime: "nothing erased" as one comparison. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel))) {
      const r = rel === '' ? name : join(rel, name);
      const st = lstatSync(join(dir, r));
      if (st.isDirectory()) visit(r);
      else out.push(`${r} ${String(st.size)} ${String(st.mtimeMs)}`);
    }
  };
  visit('');
  return out.sort();
}

async function erase(b: Booted): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${b.baseUrl}/api/data`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'DELETE_ALL_DATA' }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('Art. 17 erasure — a default workspace linked to a directory of its own (real engine)', () => {
  let b: Booted;
  let outside: string;
  beforeAll(async () => {
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-erasure-wslink-target-')));
    b = await boot(() => join(outside, 'ws'));
  }, 120_000);
  afterAll(async () => {
    await b?.cleanup();
    if (outside !== undefined) rmSync(outside, { recursive: true, force: true });
  });

  // The held root is checked by identity before anything else: a link re-pointed since boot is
  // "no longer the directory this engine opened", answered as unreachable (500, nothing erased).
  it('refuses, and erases nothing, once the link names another directory than the one held since boot', async () => {
    const markerPath = seed(b);
    const other = join(outside, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'o.txt'), 'ZZ-o');
    const link = join(b.dir, 'workspace');
    unlinkSync(link);
    symlinkSync(other, link);
    const before = snapshot(b.dir);
    try {
      const { status, body } = await erase(b);
      expect(status).toBe(500);
      expect(body['deleted']).toBe(false);
      expect(body['failed']).toEqual(['workspace']);
      expect(snapshot(b.dir)).toEqual(before);
      expect(readFileSync(markerPath, 'utf8')).toBe('ZZMARK');
      expect(readFileSync(join(b.target, 'other', 'b.txt'), 'utf8')).toBe('ZZ-b');
      expect(readFileSync(join(other, 'o.txt'), 'utf8')).toBe('ZZ-o');
    } finally {
      unlinkSync(link);
      symlinkSync(b.target, link);
      rmSync(join(b.target, 'other'), { recursive: true, force: true });
      rmSync(join(b.target, 'http-api', 'kept.txt'), { force: true });
    }
  }, 60_000);

  it('empties the target through the anchor; the link and the target stay', async () => {
    const markerPath = seed(b);
    const targetIno = statSync(b.target).ino;
    const { status, body } = await erase(b);
    expect(status).toBe(200);
    expect(body['deleted']).toBe(true);
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(join(b.target, 'other'))).toBe(false);
    expect(existsSync(join(b.target, 'http-api', 'kept.txt'))).toBe(false);
    expect(lstatSync(join(b.dir, 'workspace')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(b.dir, 'workspace'))).toBe(b.target);
    expect(statSync(b.target).ino).toBe(targetIno);
    // Only what the engine recreates for its own context may be there.
    expect(readdirSync(b.target).filter(n => n !== 'http-api')).toEqual([]);
  }, 60_000);
});

describe('Art. 17 erasure — a default workspace linked into the data directory (real engine)', () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot(dataDir => join(dataDir, 'elsewhere'));
  }, 120_000);
  afterAll(async () => { await b?.cleanup(); });

  it('refuses with 409 linked_entries, erases nothing, and leaves the target as it was', async () => {
    const markerPath = seed(b);
    const before = snapshot(b.dir);
    const { status, body } = await erase(b);
    expect(status).toBe(409);
    expect(body['code']).toBe('linked_entries');
    const linked = body['linked'] as Array<{ name: string; reason: string }>;
    expect(linked.find(l => l.name === 'workspace')?.reason).toMatch(/inside the data directory/);
    // The stores, the config and the secrets included: not one file of the data directory changed.
    expect(snapshot(b.dir)).toEqual(before);
    expect(readFileSync(markerPath, 'utf8')).toBe('ZZMARK');
    expect(readFileSync(join(b.target, 'http-api', 'kept.txt'), 'utf8')).toBe('ZZ-kept');
    expect(readFileSync(join(b.target, 'other', 'b.txt'), 'utf8')).toBe('ZZ-b');
  }, 60_000);
});
