import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { MANDATE_REVOKED_ACTION, type AuditLog } from '../core/audit-log.js';
import { AMBIENT_CROSS_SITE_REFUSAL } from './cross-site-write.js';
import type { MandateEnds } from '../core/mandate-ends.js';

/**
 * What a mandate is refused as owner-only, and the revoke of its access, are rows in its trail,
 * so the owner sees the attempt and when the access ended. Measured on a real engine, through the
 * real dispatcher, with a real mandate cookie.
 */
describe('a mandate\'s refused attempts and its revoke in the actor trail (real engine)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret
  // scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const MANDATE_ID = 'TEST-MANDATE-REFUSED';
  let api: LynoxHTTPApi;
  let dir: string;
  let base: string;
  let mandateCookie: string;
  let ownerCookie: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_DURABLE_MEMORY_ENABLED'];

  type Row = { id: number; actor_kind: string; actor_email: string | null; actor_display: string | null; mandate_id: string | null; action: string; target: string | null; phase: string; correlation_id: string };
  type Inner = {
    engine: { _toolContext: { auditLog: AuditLog | null }; engineDb: { getDb: () => import('better-sqlite3').Database }; getMandateEnds: () => MandateEnds | null };
    rateCounts: Map<string, { count: number; resetAt: number }>;
    server: Server | null;
    _openTrails: WeakMap<object, unknown>;
    _dispatchRoute: WeakMap<object, { method: string; routePath: string; pathname: string }>;
    _recordMandateRefusal: (req: object, principal: unknown) => void;
  };
  const inner = (): Inner => api as unknown as Inner;
  const rows = (): Row[] => inner().engine.engineDb.getDb()
    .prepare('SELECT id, actor_kind, actor_email, actor_display, mandate_id, action, target, phase, correlation_id FROM audit_log ORDER BY id')
    .all() as Row[];

  const ask = async (method: string, path: string, cookie: string): Promise<Response> => {
    inner().rateCounts.clear();
    const res = await fetch(`${base}${path}`, { method, headers: { cookie: `lynox_session=${cookie}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json', origin: base }) }, ...(method === 'GET' ? {} : { body: '{}' }) });
    await res.arrayBuffer();
    return res;
  };

  /** Swaps the engine's trail for one that cannot write, for the length of `fn`. */
  const withBrokenTrail = async (fn: () => Promise<void>): Promise<void> => {
    const ctx = inner().engine._toolContext;
    const kept = ctx.auditLog;
    ctx.auditLog = { record: () => { throw new Error('disk full'); } } as unknown as AuditLog;
    try { await fn(); } finally { ctx.auditLog = kept; }
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-refused-trail-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    // A mandate is let in only on the durable memory tools (660a-2), as on the fleet.
    process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = 'true';
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
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: MANDATE_ID,
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
  beforeEach(() => { before = rows().length; });
  const newRows = (): Row[] => rows().slice(before);
  const refusedRows = (): Row[] => newRows().filter((r) => r.phase === 'refused');

  it('an owner-only read: refused, one refused row with the route, the path and the person, and no read row', async () => {
    const res = await ask('GET', '/api/secrets', mandateCookie);
    expect(res.status).toBe(403);
    const got = newRows();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      actor_kind: 'mandate', actor_email: 'ida@example.invalid', actor_display: 'IDA', mandate_id: MANDATE_ID,
      action: 'GET /api/secrets', target: '/api/secrets', phase: 'refused',
    });
  });

  it('an owner-only route with a parameter: refused, and its refused row names the route as registered and the path as sent', async () => {
    const res = await ask('GET', '/api/api-profiles/p-7/client', mandateCookie);
    expect(res.status).toBe(403);
    expect(refusedRows()).toEqual([expect.objectContaining({ action: 'GET /api/api-profiles/:id/client', target: '/api/api-profiles/p-7/client', mandate_id: MANDATE_ID })]);
  });

  it('an owner-only write: refused, and its refused row names the method', async () => {
    const res = await ask('POST', '/api/google/disconnect', mandateCookie);
    expect(res.status).toBe(403);
    expect(refusedRows()).toEqual([expect.objectContaining({ action: 'POST /api/google/disconnect', target: '/api/google/disconnect', mandate_id: MANDATE_ID })]);
  });

  it('an admin route: refused for the mandate, with a refused row under the route as registered', async () => {
    const res = await ask('GET', '/api/security/events/aggregate', mandateCookie);
    expect(res.status).toBe(403);
    expect(refusedRows()).toEqual([expect.objectContaining({ action: 'GET /api/security/events/aggregate', mandate_id: MANDATE_ID })]);
  });

  it('a reveal of the vault key: refused, and the refused row says reveal, apart from the plain read row', async () => {
    const res = await ask('GET', '/api/vault/key?reveal=true', mandateCookie);
    expect(res.status).toBe(403);
    const got = newRows();
    expect(got.map((r) => [r.phase, r.action, r.target])).toEqual([
      ['read', 'GET /api/vault/key', '/api/vault/key'],
      ['refused', 'GET /api/vault/key', '/api/vault/key?reveal=true'],
    ]);
  });

  it('a reveal of the access token: refused, and the refused row says reveal', async () => {
    const res = await ask('GET', '/api/auth/token?reveal=true', mandateCookie);
    expect(res.status).toBe(403);
    expect(refusedRows()).toEqual([expect.objectContaining({ action: 'GET /api/auth/token', target: '/api/auth/token?reveal=true' })]);
  });

  it('the plain status of the vault key: answered, a read row and no refused row', async () => {
    const res = await ask('GET', '/api/vault/key', mandateCookie);
    expect(res.status).toBe(200);
    expect(newRows().map((r) => r.phase)).toEqual(['read']);
  });

  it('the owner at the same routes: answered or let through, and no row at all', async () => {
    for (const path of ['/api/secrets', '/api/vault/key?reveal=true', '/api/security/events/aggregate']) {
      const res = await ask('GET', path, ownerCookie);
      expect(res.status, path).not.toBe(403);
    }
    expect(newRows()).toEqual([]);
  });

  it('a refused row that cannot be written: the refusal stands, still 403, and the failure is logged', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await withBrokenTrail(async () => {
        const res = await ask('GET', '/api/secrets', mandateCookie);
        expect(res.status).toBe(403);
      });
      expect(err.mock.calls.some(([m]) => String(m).includes('refused attempt could not be recorded'))).toBe(true);
    } finally {
      err.mockRestore();
    }
    expect(newRows()).toEqual([]);
  });

  it('a change whose outcome row cannot be written: the attempt row stands, and the failure is logged', async () => {
    const ctx = inner().engine._toolContext;
    const kept = ctx.auditLog;
    if (kept === null) throw new Error('fixture: no trail');
    // Writes the attempt, refuses every outcome.
    ctx.auditLog = new Proxy(kept, {
      get: (target, prop) => prop === 'record'
        ? (entry: { phase: string }) => { if (entry.phase !== 'attempt') throw new Error('disk full'); return target.record(entry as Parameters<AuditLog['record']>[0]); }
        : Reflect.get(target, prop, target),
    });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await ask('POST', '/api/tasks', mandateCookie);
      expect(err.mock.calls.some(([m]) => String(m).includes('outcome of a mandate\'s change could not be recorded'))).toBe(true);
    } finally {
      err.mockRestore();
      ctx.auditLog = kept;
    }
    expect(newRows().map((r) => [r.action, r.phase])).toEqual([['POST /api/tasks', 'attempt']]);
  });

  it('an admin route asked from another site: refused, and no row the person never made', async () => {
    inner().rateCounts.clear();
    const res = await fetch(`${base}/api/security/events/aggregate`, { headers: { cookie: `lynox_session=${mandateCookie}`, 'sec-fetch-site': 'cross-site' } });
    const body = await res.text();
    // Refused as the cross-site request it is, not as the admin route.
    expect(res.status).toBe(403);
    expect(body).toContain(AMBIENT_CROSS_SITE_REFUSAL);
    expect(newRows()).toEqual([]);
  });

  it('an admin route asked past the rate limit: 429 before any row', async () => {
    await ask('GET', '/api/threads', mandateCookie);
    before = rows().length;
    for (const entry of inner().rateCounts.values()) entry.count = 1_000_000;
    const res = await fetch(`${base}/api/security/events/aggregate`, { headers: { cookie: `lynox_session=${mandateCookie}` } });
    await res.arrayBuffer();
    expect(res.status).toBe(429);
    expect(newRows()).toEqual([]);
    inner().rateCounts.clear();
  });

  it('a refusal inside a write\'s handler: no second row, as the write\'s own pair closes as refused', () => {
    const mandate = { kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandateId: MANDATE_ID };
    const route = { method: 'POST', routePath: '/api/tasks', pathname: '/api/tasks' };
    const inWrite = {};
    inner()._dispatchRoute.set(inWrite, route);
    inner()._openTrails.set(inWrite, {});
    inner()._recordMandateRefusal(inWrite, mandate);
    expect(newRows()).toEqual([]);
    // Control: the same refusal without an open pair is a row.
    const alone = {};
    inner()._dispatchRoute.set(alone, route);
    inner()._recordMandateRefusal(alone, mandate);
    expect(refusedRows()).toEqual([expect.objectContaining({ action: 'POST /api/tasks', mandate_id: MANDATE_ID })]);
  });

  it('a revoke: one row in the person\'s trail after its reads, and none for what it asks afterwards', async () => {
    const ends = inner().engine.getMandateEnds();
    if (ends === null) throw new Error('fixture: no mandate ends');
    expect(ends.revoke(MANDATE_ID)).toBe(true);
    const got = newRows();
    expect(got).toEqual([expect.objectContaining({
      actor_kind: 'mandate', actor_email: 'ida@example.invalid', actor_display: 'IDA', mandate_id: MANDATE_ID,
      action: MANDATE_REVOKED_ACTION, target: null, phase: 'done',
    })]);
    const last = got[0]!.id;
    const res = await ask('GET', '/api/threads', mandateCookie);
    expect(res.status).toBe(403);
    expect(rows().filter((r) => r.id > last)).toEqual([]);
    // Told once: a second revoke of the same grant changes nothing and writes nothing.
    expect(ends.revoke(MANDATE_ID)).toBe(false);
    expect(rows().filter((r) => r.id > last)).toEqual([]);
  });

  it('a revoke of a grant that never acted here: no row, and the revoke still holds', () => {
    const ends = inner().engine.getMandateEnds();
    if (ends === null) throw new Error('fixture: no mandate ends');
    expect(ends.revoke('TEST-MANDATE-NEVER-HERE')).toBe(true);
    expect(newRows()).toEqual([]);
    expect(ends.isLive('TEST-MANDATE-NEVER-HERE')).toBe(false);
  });
});
