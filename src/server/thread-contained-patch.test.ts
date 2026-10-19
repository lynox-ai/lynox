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
 * A chat that read data through a store connection keeps private mode on for its life:
 * `PATCH /api/threads/:id` refuses `skip_extraction: false` there, read from the containment
 * record, fail-closed. On a booted engine, because the record has to be wired where the route
 * looks for it.
 */
describe('PATCH /api/threads/:id on a contained chat (real engine)', () => {
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

  let lastBody = '';
  async function patch(threadId: string, body: Record<string, unknown>): Promise<number> {
    const res = await fetch(`${baseUrl}/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    lastBody = await res.text();
    return res.status;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-contained-patch-'));
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

  it('the booted engine holds the containment record where the funnel and the route read it', () => {
    expect(engine().getToolContext().containment).toBeInstanceOf(Containment);
  });

  it('refuses to switch private mode off in a contained chat, and switches it off in another (control)', async () => {
    const ts = engine().getThreadStore()!;
    const containment = engine().getToolContext().containment!;
    ts.createThread('t-contained', { title: 'contained' });
    ts.createThread('t-free', { title: 'free' });
    ts.updateThread('t-contained', { skip_extraction: true });
    ts.updateThread('t-free', { skip_extraction: true });
    containment.contain({ kind: 'thread', id: 't-contained' }, { kind: 'api', connectionId: 'shop-acme' });

    expect(await patch('t-contained', { skip_extraction: false, title: 'renamed' })).toBe(409);
    // The page tells this refusal apart from any other by its code.
    expect((JSON.parse(lastBody) as { code?: unknown }).code).toBe('contained');
    expect(ts.getThread('t-contained')?.skip_extraction).toBe(1);
    // Refused whole: nothing else in the request was applied either.
    expect(ts.getThread('t-contained')?.title).toBe('contained');
    // Anything else on a contained chat still goes through.
    expect(await patch('t-contained', { title: 'renamed' })).toBe(200);
    expect(await patch('t-contained', { skip_extraction: true })).toBe(200);

    expect(await patch('t-free', { skip_extraction: false })).toBe(200);
    expect(ts.getThread('t-free')?.skip_extraction).toBe(0);
  });

  it('a record that cannot be read refuses', async () => {
    const ctx = engine().getToolContext();
    const ts = engine().getThreadStore()!;
    ts.createThread('t-unread', { title: 'x' });
    ts.updateThread('t-unread', { skip_extraction: true });
    const real = ctx.containment;
    ctx.containment = new Containment({ prepare: () => { throw new Error('disk I/O error'); } } as never);
    try {
      expect(await patch('t-unread', { skip_extraction: false })).toBe(409);
      // An unreadable record is not proof the chat read the store, and the answer says so.
      expect(lastBody).toContain('This chat read data through a store connection, or this engine cannot read whether it did, so private mode stays on for it.');
      expect(ts.getThread('t-unread')?.skip_extraction).toBe(1);
    } finally {
      ctx.containment = real;
    }
    expect(await patch('t-unread', { skip_extraction: false })).toBe(200);
  });
});
