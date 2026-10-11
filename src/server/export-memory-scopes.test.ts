import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { memoryStoreTool } from '../tools/builtin/memory.js';
import { createToolContext } from '../core/tool-context.js';
import type { Memory } from '../core/memory.js';
import type { IAgent } from '../types/index.js';

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
  const FACT = `Kornfeld Sattlerei prefers invoices in CHF ${randomBytes(3).toString('hex')}`;
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

  it('exports a fact memory_store wrote into a user scope, and the erasure removes it', async () => {
    const agent: IAgent = {
      name: 'test', model: 'test-model', memory: memoryOf(), tools: [], onStream: null,
      toolContext: createToolContext({}),
    };
    const stored = await memoryStoreTool.handler({ namespace: 'knowledge', content: FACT, scope: `user:${USER_ID}` }, agent);
    expect(stored).toMatch(/^Stored in knowledge \(scope: user:/);

    const before = await call('GET', '/api/export');
    expect(before.status).toBe(200);
    // Positive control: the current scope is not where the fact went.
    expect(JSON.stringify(before.body['memory'])).not.toContain(FACT);
    const scopes = before.body['memory_scopes'] as Record<string, Record<string, string>>;
    expect(scopes[`user-${USER_ID}`]?.['knowledge']).toContain(FACT);

    const erased = await call('DELETE', '/api/data', { confirm: 'DELETE_ALL_DATA' });
    expect(erased.body['failed'] ?? []).toEqual([]);
    expect(erased.status).toBe(200);

    const after = await call('GET', '/api/export');
    expect(after.body['memory_scopes']).toEqual({});
    expect(await memoryOf().loadScoped('knowledge', { type: 'user', id: USER_ID })).toBeNull();
  }, 60_000);
});
