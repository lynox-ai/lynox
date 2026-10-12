import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { memoryStoreTool } from '../tools/builtin/memory.js';
import { createToolContext } from '../core/tool-context.js';
import { Memory } from '../core/memory.js';
import { saveManifest } from '../core/project.js';
import type { IAgent } from '../types/index.js';

type Scopes = Record<string, Record<string, string>>;

/**
 * Flat-file memory lives in one directory per scope (`global`, `<contextId>`, `user-<id>`),
 * and `memory_store` writes into whichever scope the agent names. The export read only the
 * current scope, so a fact stored under a user scope was held, erased by `DELETE /api/data`,
 * and never shown by `GET /api/export`. Seeded here through the tool itself, on a real engine.
 */
describe('Art. 15 export and Art. 17 erasure see every flat-file memory scope (real engine)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret
  // scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const USER_ID = `zz${randomBytes(3).toString('hex')}`;
  const USER_FACT = `ZZMARKER-user-scope-${randomBytes(3).toString('hex')}`;
  const DEFAULT_FACT = `ZZMARKER-default-scope-${randomBytes(3).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];

  const memoryOf = (): Memory => {
    const m = (api as unknown as { engine: { getMemory: () => Memory | null } }).engine.getMemory();
    if (m === null) throw new Error('fixture: no flat-file memory');
    return m;
  };

  async function call(method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-export-scopes-'));
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

  it('exports a fact memory_store wrote into a user scope next to the default one, and the erasure removes both', async () => {
    const agent: IAgent = {
      name: 'test', model: 'test-model', memory: memoryOf(), tools: [], onStream: null,
      toolContext: createToolContext({}),
    };
    const stored = await memoryStoreTool.handler({ namespace: 'knowledge', content: USER_FACT, scope: `user:${USER_ID}` }, agent);
    expect(stored).toMatch(/^Stored in knowledge \(scope: user:/);
    await memoryOf().save('knowledge', DEFAULT_FACT);

    const before = await call('GET', '/api/export');
    expect(before.status).toBe(200);
    expect(before.body['memory_scopes_may_be_incomplete']).toBe(false);
    // The default scope is where the old `memory` key looks, and it holds only its own fact:
    // the user-scope fact can only reach the export through `memory_scopes`.
    const current = JSON.stringify(before.body['memory']);
    expect(current).toContain(DEFAULT_FACT);
    expect(current).not.toContain(USER_FACT);
    const scopes = before.body['memory_scopes'] as Scopes;
    expect(scopes[`user-${USER_ID}`]?.['knowledge.txt']).toContain(USER_FACT);
    // And `memory_scopes` carries the default scope too, not only the ones `memory` misses.
    const holding = Object.entries(scopes).filter(([, files]) => files['knowledge.txt']?.includes(DEFAULT_FACT)).map(([k]) => k);
    expect(holding).toHaveLength(1);
    expect(holding[0]).not.toBe(`user-${USER_ID}`);

    const erased = await call('DELETE', '/api/data', { confirm: 'DELETE_ALL_DATA' });
    expect(erased.body['failed'] ?? []).toEqual([]);
    expect(erased.status).toBe(200);

    const after = await call('GET', '/api/export');
    expect(after.status).toBe(200);
    expect(after.body['memory_scopes']).toEqual({});
    expect(after.body['memory_scopes_may_be_incomplete']).toBe(false);
    expect(await memoryOf().loadScoped('knowledge', { type: 'user', id: USER_ID })).toBeNull();
  }, 60_000);

  it('still exports the files on disk when the engine runs without a memory instance', async () => {
    // `memory: false` leaves `getMemory()` null, while the directory keeps what runs with it on
    // wrote. Seeded through the real store first, then the instance is taken away.
    const mem = memoryOf();
    const agent: IAgent = {
      name: 'test', model: 'test-model', memory: mem, tools: [], onStream: null,
      toolContext: createToolContext({}),
    };
    await memoryStoreTool.handler({ namespace: 'knowledge', content: USER_FACT, scope: `user:${USER_ID}` }, agent);
    const engineRef = (api as unknown as { engine: { getMemory: () => Memory | null } }).engine;
    const orig = engineRef.getMemory;
    engineRef.getMemory = () => null;
    try {
      const res = await call('GET', '/api/export');
      expect(res.status).toBe(200);
      expect(res.body['memory']).toEqual({});
      expect((res.body['memory_scopes'] as Scopes)[`user-${USER_ID}`]?.['knowledge.txt']).toContain(USER_FACT);
      expect(res.body['memory_scopes_may_be_incomplete']).toBe(false);
    } finally {
      engineRef.getMemory = orig;
      mem.eraseAll();
    }
  }, 60_000);
});

/**
 * The export reads what `eraseAll` removes — every regular file under the store's directory —
 * and says so when it could not read something, instead of returning a shorter answer.
 */
describe('Memory.exportAllScopes', () => {
  let dir: string;
  let mem: Memory;
  const base = (): string => join(dir, 'memory');

  const fresh = (): void => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-export-all-scopes-'));
    mem = new Memory(dir);
    mkdirSync(join(base(), 'global'), { recursive: true });
    writeFileSync(join(base(), 'global', 'knowledge.txt'), 'ZZMARKER-global');
  };
  afterEach(() => {
    // Restore permissions first, or the cleanup itself cannot descend.
    for (const p of [join(base(), 'global'), join(base(), 'global', 'knowledge.txt')]) {
      if (existsSync(p)) chmodSync(p, 0o700);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('is empty and complete when the store directory does not exist', async () => {
    fresh();
    rmSync(base(), { recursive: true, force: true });
    expect(await mem.exportAllScopes()).toEqual({ scopes: {}, mayBeIncomplete: false });
  });

  it('carries the manifest the engine writes and a loose file, both of which the erasure deletes', async () => {
    fresh();
    saveManifest(dir, 'ctx-zz', new Map([['notes/plan.md', 1700000000000]]));
    writeFileSync(join(base(), 'loose.txt'), 'ZZMARKER-loose');
    const { scopes, mayBeIncomplete } = await mem.exportAllScopes();
    expect(mayBeIncomplete).toBe(false);
    expect(scopes['ctx-zz']?.['manifest.json']).toContain('notes/plan.md');
    expect(scopes['.']?.['loose.txt']).toBe('ZZMARKER-loose');
    expect(scopes['global']?.['knowledge.txt']).toBe('ZZMARKER-global');

    mem.eraseAll();
    expect(await mem.exportAllScopes()).toEqual({ scopes: {}, mayBeIncomplete: false });
  });

  it('does not follow a symlinked scope or file out of the store', async () => {
    fresh();
    const outside = mkdtempSync(join(tmpdir(), 'lynox-export-outside-'));
    try {
      writeFileSync(join(outside, 'knowledge.txt'), 'ZZMARKER-outside');
      symlinkSync(outside, join(base(), 'linked-scope'));
      symlinkSync(join(outside, 'knowledge.txt'), join(base(), 'global', 'linked.txt'));
      const { scopes, mayBeIncomplete } = await mem.exportAllScopes();
      expect(JSON.stringify(scopes)).not.toContain('ZZMARKER-outside');
      // Shown to be reachable, so the absence above is the filter and not a broken link.
      expect(scopes['global']?.['knowledge.txt']).toBe('ZZMARKER-global');
      expect(mayBeIncomplete).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('carries a scope directory named __proto__ instead of dropping it into the prototype', async () => {
    fresh();
    mkdirSync(join(base(), '__proto__'));
    writeFileSync(join(base(), '__proto__', 'knowledge.txt'), 'ZZMARKER-proto');
    // And a FILE of that name, for the inner map.
    writeFileSync(join(base(), 'global', '__proto__'), 'ZZMARKER-proto-file');
    const { scopes } = await mem.exportAllScopes();
    expect(Object.keys(scopes)).toContain('__proto__');
    expect(JSON.stringify(scopes)).toContain('ZZMARKER-proto');
    expect(Object.keys(scopes['global'] ?? {})).toContain('__proto__');
    expect(JSON.stringify(scopes)).toContain('ZZMARKER-proto-file');
  });

  it('reports a nested directory instead of claiming the scope is complete', async () => {
    fresh();
    mkdirSync(join(base(), 'global', 'nested'));
    const { scopes, mayBeIncomplete } = await mem.exportAllScopes();
    expect(scopes['global']?.['knowledge.txt']).toBe('ZZMARKER-global');
    expect(mayBeIncomplete).toBe(true);
  });

  // Permission bits do not stop root, so the unreadable cases have no meaning there.
  const asRoot = process.getuid?.() === 0;

  it.skipIf(asRoot)('flags an unreadable file instead of leaving it out silently', async () => {
    fresh();
    writeFileSync(join(base(), 'global', 'status.txt'), 'ZZMARKER-status');
    chmodSync(join(base(), 'global', 'knowledge.txt'), 0o000);
    const { scopes, mayBeIncomplete } = await mem.exportAllScopes();
    expect(scopes['global']?.['status.txt']).toBe('ZZMARKER-status');
    expect(scopes['global']?.['knowledge.txt']).toBeUndefined();
    expect(mayBeIncomplete).toBe(true);
  });

  it.skipIf(asRoot)('flags an unlistable scope directory', async () => {
    fresh();
    chmodSync(join(base(), 'global'), 0o000);
    const { scopes, mayBeIncomplete } = await mem.exportAllScopes();
    expect(scopes['global']).toBeUndefined();
    expect(mayBeIncomplete).toBe(true);
  });
});
