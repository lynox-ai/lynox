import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { ThreadStore } from '../core/thread-store.js';
import type { ToolContext } from '../core/tool-context.js';
import { Containment } from '../core/containment.js';

/**
 * The thread routes say whether a chat is contained (`contained`), so the UI can explain why
 * private mode stays on. Read from the same record the refusals read, fail-closed. On a booted
 * engine, because the record has to be wired where the routes look for it.
 */
describe('GET /api/threads and /api/threads/:id carry `contained` (real engine)', () => {
  // Built at runtime, never a literal: a key-shaped fixture string is what the commit-time
  // secret scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY'];
  const saved: Record<string, string | undefined> = {};
  let api: LynoxHTTPApi | undefined;
  let baseUrl: string;
  let dir: string | undefined;

  function engine(): { getThreadStore: () => ThreadStore | null; getToolContext: () => ToolContext } {
    return (api as unknown as { engine: ReturnType<typeof engine> }).engine;
  }

  async function get(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
    return await res.json() as Record<string, unknown>;
  }
  async function one(threadId: string): Promise<unknown> {
    return ((await get(`/api/threads/${threadId}`))['thread'] as Record<string, unknown>)['contained'];
  }
  async function listed(): Promise<Map<string, unknown>> {
    const threads = (await get('/api/threads?limit=500'))['threads'] as Array<Record<string, unknown>>;
    return new Map(threads.map((t) => [t['id'] as string, t['contained']]));
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-contained-get-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
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

  it('a contained chat reads `contained: true`, another `false`, in the thread and in the list', async () => {
    const ts = engine().getThreadStore()!;
    const containment = engine().getToolContext().containment!;
    ts.createThread('g-contained', { title: 'contained' });
    ts.createThread('g-free', { title: 'free' });
    ts.createThread('g-other', { title: 'other' });
    // The overview lists only chats with messages.
    for (const id of ['g-contained', 'g-free', 'g-other']) ts.updateThread(id, { message_count: 1 });
    containment.contain({ kind: 'thread', id: 'g-contained' }, { kind: 'api', connectionId: 'shop-acme' });
    // A bulk run of the same id is not the thread.
    containment.contain({ kind: 'bulk_run', id: 'g-other' }, { kind: 'api', connectionId: 'shop-acme' });

    expect(await one('g-contained')).toBe(true);
    expect(await one('g-free')).toBe(false);
    expect(await one('g-other')).toBe(false);
    const list = await listed();
    expect(list.get('g-contained')).toBe(true);
    expect(list.get('g-free')).toBe(false);
    expect(list.get('g-other')).toBe(false);
  });

  it('a record that cannot be read answers `contained: true`, in the thread and in the list', async () => {
    const ctx = engine().getToolContext();
    const ts = engine().getThreadStore()!;
    ts.createThread('g-unread', { title: 'x' });
    ts.updateThread('g-unread', { message_count: 1 });
    const real = ctx.containment;
    ctx.containment = new Containment({ prepare: () => { throw new Error('disk I/O error'); } } as never);
    try {
      expect(await one('g-unread')).toBe(true);
      expect((await listed()).get('g-unread')).toBe(true);
    } finally {
      ctx.containment = real;
    }
    expect(await one('g-unread')).toBe(false);
    expect((await listed()).get('g-unread')).toBe(false);
  });
});
