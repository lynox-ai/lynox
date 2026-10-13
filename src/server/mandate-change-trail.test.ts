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
 * Every change a mandate makes leaves two rows in the actor trail (PRD customer-granted-operator-
 * access §3.6, §7(c)) — measured on a real engine, through the real dispatcher, with a real
 * mandate cookie. An `attempt` row before the handler, an outcome row when the answer closes; no
 * row for the owner; and a change the trail cannot record is not made.
 */
describe('a mandate\'s changes in the actor trail (real engine)', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'lynox-change-trail-'));
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

  /** The rows written since the test began, once the outcome row of the last change is in. */
  let before = 0;
  beforeEach(() => { before = rows().length; });
  const newRows = async (want: number): Promise<Row[]> => {
    for (let i = 0; i < 100 && rows().length - before < want; i++) await new Promise((r) => setTimeout(r, 5));
    return rows().slice(before);
  };
  const subscribe = async (cookie: string, endpoint: string, body?: string): Promise<Response> => {
    inner().rateCounts.clear();
    return fetch(`${base}/api/push/subscribe`, {
      method: 'POST',
      headers: { cookie: `lynox_session=${cookie}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: body ?? JSON.stringify({ subscription: { endpoint, keys: { p256dh: 'p256dh', auth: 'auth' } } }),
    });
  };

  it('writes attempt and done around a change that happened, joined by one correlation id', async () => {
    const res = await subscribe(mandateCookie, 'https://fcm.googleapis.com/fcm/send/ida-change');
    await res.arrayBuffer();
    expect(res.status).toBe(201);
    const got = await newRows(2);
    expect(got.map((r) => r.phase)).toEqual(['attempt', 'done']);
    for (const r of got) {
      expect(r).toMatchObject({
        actor_kind: 'mandate', actor_email: 'ida@example.invalid', actor_display: 'IDA', mandate_id: 'TEST-MANDATE-READ',
        action: 'POST /api/push/subscribe', target: '/api/push/subscribe',
      });
    }
    expect(got[0]!.correlation_id).toBe(got[1]!.correlation_id);
  });

  it('writes attempt and refused around a change that was refused', async () => {
    const res = await subscribe(mandateCookie, '', JSON.stringify({ subscription: { endpoint: 'not a url' } }));
    await res.arrayBuffer();
    expect(res.status).toBeGreaterThanOrEqual(400);
    const got = await newRows(2);
    expect(got.map((r) => r.phase)).toEqual(['attempt', 'refused']);
    expect(got[0]!.correlation_id).toBe(got[1]!.correlation_id);
  });

  it('writes nothing for the owner\'s change', async () => {
    const res = await subscribe(ownerCookie, 'https://fcm.googleapis.com/fcm/send/owner-change');
    await res.arrayBuffer();
    expect(res.status).toBe(201);
    // Long enough for an outcome row, had one been opened.
    await new Promise((r) => setTimeout(r, 100));
    expect(rows().slice(before)).toEqual([]);
  });

  it('records the outcome of a change whose client left before the answer', async () => {
    // A handler that acts after an await, as a hand start does. The client drops the connection
    // while it waits; the change still happens, and the trail says it did.
    const routes = inner().staticRoutes;
    const real = routes.get('POST /api/push/subscribe');
    if (real === undefined) throw new Error('fixture: no POST /api/push/subscribe');
    let acted = false;
    routes.set('POST /api/push/subscribe', async (...a: unknown[]) => {
      await new Promise((r) => setTimeout(r, 150));
      acted = true;
      await real(...a);
    });
    try {
      const ac = new AbortController();
      inner().rateCounts.clear();
      const pending = fetch(`${base}/api/push/subscribe`, {
        method: 'POST', signal: ac.signal,
        headers: { cookie: `lynox_session=${mandateCookie}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/ida-left', keys: { p256dh: 'p256dh', auth: 'auth' } } }),
      }).catch(() => null);
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await pending;
      for (let i = 0; i < 100 && !acted; i++) await new Promise((r) => setTimeout(r, 5));
      const got = await newRows(2);
      expect(acted).toBe(true);
      expect(got.map((r) => r.phase)).toEqual(['attempt', 'done']);
    } finally {
      routes.set('POST /api/push/subscribe', real);
    }
  });

  it('records failed for a change whose handler threw before answering', async () => {
    const routes = inner().staticRoutes;
    const real = routes.get('POST /api/push/subscribe');
    if (real === undefined) throw new Error('fixture: no POST /api/push/subscribe');
    routes.set('POST /api/push/subscribe', async () => { throw new Error('broke mid-change'); });
    try {
      const res = await subscribe(mandateCookie, 'https://fcm.googleapis.com/fcm/send/ida-threw');
      await res.arrayBuffer();
      expect(res.status).toBe(500);
      const got = await newRows(2);
      expect(got.map((r) => r.phase)).toEqual(['attempt', 'failed']);
      expect(got[0]!.correlation_id).toBe(got[1]!.correlation_id);
    } finally {
      routes.set('POST /api/push/subscribe', real);
    }
  });

  it('writes a read row, not a change, for a GET', async () => {
    const res = await ask('GET', '/api/threads', mandateCookie);
    await res.arrayBuffer();
    const got = await newRows(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(rows().slice(before).map((r) => r.phase)).toEqual(['read']);
    expect(got[0]!.action).toBe('GET /api/threads');
  });

  it('does not make a change the trail cannot record, and the handler does not run', async () => {
    const routes = inner().staticRoutes;
    const real = routes.get('POST /api/push/subscribe');
    if (real === undefined) throw new Error('fixture: no POST /api/push/subscribe');
    const spy = vi.fn(real);
    routes.set('POST /api/push/subscribe', spy);
    try {
      await withBrokenTrail(async () => {
        const res = await subscribe(mandateCookie, 'https://fcm.googleapis.com/fcm/send/ida-broken');
        expect(res.status).toBe(503);
        expect(await res.text()).toContain('cannot be recorded');
        // The owner's change does not depend on the trail.
        const owner = await subscribe(ownerCookie, 'https://fcm.googleapis.com/fcm/send/owner-broken');
        await owner.arrayBuffer();
        expect(owner.status).toBe(201);
      });
      expect(spy).toHaveBeenCalledTimes(1);
      // The control: with the trail back, the mandate's change reaches the spy.
      const ok = await subscribe(mandateCookie, 'https://fcm.googleapis.com/fcm/send/ida-back');
      await ok.arrayBuffer();
      expect(ok.status).toBe(201);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      routes.set('POST /api/push/subscribe', real);
    }
  });

  it('refuses a change as well when the engine keeps no trail at all', async () => {
    const ctx = inner().engine._toolContext;
    const kept = ctx.auditLog;
    ctx.auditLog = null;
    try {
      const res = await subscribe(mandateCookie, 'https://fcm.googleapis.com/fcm/send/ida-none');
      await res.arrayBuffer();
      expect(res.status).toBe(503);
    } finally {
      ctx.auditLog = kept;
    }
  });

  /**
   * The detector: every route of the table that is not GET or HEAD and that a mandate may
   * reach. A new one cannot arrive without the trail, because this loop finds it. Two answers
   * count as "not made": the trail's 503, and the 403 of an `owner-only` route, which refuses a
   * mandate before the trail is asked.
   */
  it('makes no change on any route of the table when the trail cannot record', async () => {
    const table = api.routeStancesForTesting().filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && r.scope === 'user');
    expect(table.length).toBeGreaterThan(80);
    const answered: string[] = [];
    await withBrokenTrail(async () => {
      for (const r of table) {
        inner().rateCounts.clear();
        const res = await fetch(`${base}${r.path.replace(/:[^/]+/g, 'x1')}`, {
          method: r.method,
          headers: { cookie: `lynox_session=${mandateCookie}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
          body: '{}',
        });
        const text = await res.text();
        // The trail's own refusal, not a handler's 503 (a missing service answers 503 too).
        const ok = r.stance?.kind === 'owner-only' ? res.status === 403 : res.status === 503 && text.includes('cannot be recorded in the instance log');
        if (!ok) answered.push(`${r.method} ${r.path} → ${String(res.status)}`);
      }
    });
    expect(answered).toEqual([]);
  }, 120_000);
});
