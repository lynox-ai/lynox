import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { AuditLog } from '../core/audit-log.js';

/**
 * A mandate's reads leave a row in the actor trail (PRD customer-granted-operator-access D15) —
 * measured on a real engine, through the real dispatcher, with a real mandate cookie. One row
 * per read, written before the answer; no row for the owner; and a read the trail cannot
 * record is not answered.
 */
describe('a mandate\'s reads in the actor trail (real engine)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret
  // scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let dir: string;
  let base: string;
  let mandateCookie: string;
  let ownerCookie: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];

  type Row = { actor_kind: string; actor_email: string | null; actor_display: string | null; mandate_id: string | null; action: string; target: string | null; phase: string; correlation_id: string };
  type Inner = {
    engine: { _toolContext: { auditLog: AuditLog | null }; engineDb: { getDb: () => import('better-sqlite3').Database } };
    rateCounts: Map<string, unknown>;
    staticRoutes: Map<string, (...a: unknown[]) => Promise<void>>;
    server: Server | null;
  };
  const inner = (): Inner => api as unknown as Inner;
  const rows = (): Row[] => inner().engine.engineDb.getDb()
    .prepare('SELECT actor_kind, actor_email, actor_display, mandate_id, action, target, phase, correlation_id FROM audit_log ORDER BY rowid')
    .all() as Row[];
  const readRows = (): Row[] => rows().filter((r) => r.phase === 'read');

  const ask = async (method: string, path: string, cookie: string): Promise<Response> => {
    // The loop below asks once per route; the per-client window must not answer for the trail.
    inner().rateCounts.clear();
    return fetch(`${base}${path}`, { method, headers: { cookie: `lynox_session=${cookie}` } });
  };

  /** Swaps the engine's trail for one that cannot write, for the length of `fn`. */
  const withBrokenTrail = async (fn: () => Promise<void>): Promise<void> => {
    const ctx = inner().engine._toolContext;
    const kept = ctx.auditLog;
    ctx.auditLog = { record: () => { throw new Error('disk full'); } } as unknown as AuditLog;
    try { await fn(); } finally { ctx.auditLog = kept; }
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-read-trail-'));
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
    const addr = inner().server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('fixture: no port');
    base = `http://127.0.0.1:${String(addr.port)}`;
    const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
    const m = loginSession(SECRET, {
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-READ',
      mandate_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })?.token;
    const o = loginSession(SECRET, null)?.token;
    if (m === undefined || o === undefined) throw new Error('fixture: no cookie');
    mandateCookie = m;
    ownerCookie = o;
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

  let before = 0;
  beforeEach(() => { before = readRows().length; });
  const newReadRows = (): Row[] => readRows().slice(before);

  it('writes exactly one row for a mandate\'s read: the route, the path, the actor, and no query', async () => {
    const res = await ask('GET', '/api/threads/t-7?q=private-words', mandateCookie);
    await res.arrayBuffer();
    expect(res.status).not.toBe(503);
    const got = newReadRows();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      actor_kind: 'mandate', actor_email: 'ida@example.invalid', actor_display: 'IDA', mandate_id: 'TEST-MANDATE-READ',
      action: 'GET /api/threads/:id', target: '/api/threads/t-7', phase: 'read',
    });
    expect(JSON.stringify(got[0])).not.toContain('private-words');
  });

  it('writes one row for a static route, named by its path', async () => {
    const res = await ask('GET', '/api/threads', mandateCookie);
    await res.arrayBuffer();
    expect(res.status).toBe(200);
    const got = newReadRows();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ action: 'GET /api/threads', target: '/api/threads', actor_email: 'ida@example.invalid' });
  });

  it('writes one row for a HEAD, which runs the GET handler', async () => {
    const res = await ask('HEAD', '/api/threads', mandateCookie);
    await res.arrayBuffer();
    const got = newReadRows();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ action: 'HEAD /api/threads', target: '/api/threads' });
  });

  it('writes no row for the owner\'s read', async () => {
    const res = await ask('GET', '/api/threads', ownerCookie);
    await res.arrayBuffer();
    expect(res.status).toBe(200);
    expect(newReadRows()).toHaveLength(0);
  });

  it('masks a secret-shaped path segment in the row', async () => {
    const key = `sk-ant-${'A1b2'.repeat(8)}`;
    const res = await ask('GET', `/api/threads/${key}`, mandateCookie);
    await res.arrayBuffer();
    const got = newReadRows();
    expect(got).toHaveLength(1);
    expect(got[0]?.target).not.toContain(key);
    expect(got[0]?.target).toMatch(/^\/api\/threads\/\*\*\*/);
  });

  it('does not answer a mandate\'s read the trail cannot record, and the handler does not run', async () => {
    const routes = inner().staticRoutes;
    const real = routes.get('GET /api/threads');
    if (real === undefined) throw new Error('fixture: no GET /api/threads');
    const spy = vi.fn(real);
    routes.set('GET /api/threads', spy);
    try {
      await withBrokenTrail(async () => {
        const res = await ask('GET', '/api/threads', mandateCookie);
        expect(res.status).toBe(503);
        expect(await res.text()).toContain('cannot be recorded');
      });
      expect(spy).not.toHaveBeenCalled();
      // The same route still answers once the trail can write: the spy is wired.
      const ok = await ask('GET', '/api/threads', mandateCookie);
      await ok.arrayBuffer();
      expect(ok.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      routes.set('GET /api/threads', real);
    }
  });

  it('refuses a read as well when the engine keeps no trail at all', async () => {
    const ctx = inner().engine._toolContext;
    const kept = ctx.auditLog;
    ctx.auditLog = null;
    try {
      const res = await ask('GET', '/api/threads', mandateCookie);
      expect(res.status).toBe(503);
      await res.arrayBuffer();
    } finally {
      ctx.auditLog = kept;
    }
  });

  it('answers the owner\'s read with a broken trail, and leaves a mandate\'s write path to its own writer', async () => {
    await withBrokenTrail(async () => {
      const owner = await ask('GET', '/api/threads', ownerCookie);
      await owner.arrayBuffer();
      expect(owner.status).toBe(200);
      // A POST is not a read: this writer does not answer for it (the write trail does).
      const post = await fetch(`${base}/api/threads`, {
        method: 'POST',
        headers: { cookie: `lynox_session=${mandateCookie}`, 'content-type': 'application/json' },
        body: '{}',
      });
      await post.arrayBuffer();
      expect(post.status).not.toBe(503);
    });
  });

  /**
   * The detector: every GET route a mandate may reach, read off the real route table. A new
   * read route cannot arrive without the trail, because this loop finds it. Two answers count
   * as "not answered": the trail's 503, and the 403 of an `owner-only` route, which refuses a
   * mandate before the trail is asked.
   */
  it('answers no GET route of the table to a mandate when the trail cannot record', async () => {
    // Answered before authentication, with no principal to name: the two OAuth providers'
    // redirects back. They carry no session a dispatch check could read; the state cookie
    // is their identity check. Each one's place before authentication is asserted below, so
    // an entry here that stops being one fails rather than hides a route.
    const BEFORE_AUTH = new Set(['GET /api/google/callback', 'GET /api/oauth/callback']);
    for (const key of BEFORE_AUTH) {
      inner().rateCounts.clear();
      const res = await fetch(`${base}${key.slice(4)}`);
      await res.arrayBuffer();
      expect(res.status, key).not.toBe(401);
    }
    // The control: a route behind authentication does answer 401 without a cookie here.
    inner().rateCounts.clear();
    const control = await fetch(`${base}/api/threads`);
    await control.arrayBuffer();
    expect(control.status).toBe(401);
    const table = api.routeStancesForTesting().filter((r) => r.method === 'GET' && r.scope === 'user' && !BEFORE_AUTH.has(`GET ${r.path}`));
    expect(table.length).toBeGreaterThan(50);
    const answered: string[] = [];
    await withBrokenTrail(async () => {
      for (const r of table) {
        const path = r.path.replace(/:[^/]+/g, 'x1');
        const res = await ask('GET', path, mandateCookie);
        const want = r.stance?.kind === 'owner-only' ? 403 : 503;
        if (res.status !== want) answered.push(`${r.path} → ${String(res.status)}`);
        await res.body?.cancel();
      }
    });
    expect(answered).toEqual([]);
  }, 60_000);
});
