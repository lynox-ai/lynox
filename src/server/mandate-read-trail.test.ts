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
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_DURABLE_MEMORY_ENABLED'];

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

  it('names what a query-addressed read read, and drops every other query value', async () => {
    const res = await ask('GET', '/api/history/runs?thread_id=t-9&q=private-words&limit=5', mandateCookie);
    await res.arrayBuffer();
    const file = await ask('GET', '/api/files/read?path=notes/plan.txt&hidden=1', mandateCookie);
    await file.arrayBuffer();
    const got = newReadRows();
    expect(got.map((r) => r.target)).toEqual(['/api/history/runs?thread_id=t-9', '/api/files/read?path=notes/plan.txt']);
    expect(JSON.stringify(got)).not.toContain('private-words');
  });

  it('keeps the shape of the row out of the actor\'s hands', async () => {
    // A value cannot add a pair, an escaped `?` in the path stays a path, a slash inside a
    // segment stays escaped, and a bidi character stays escaped. An empty identifier is
    // written as sent: the route may read it as "no filter".
    for (const path of [
      '/api/files/read?path=a%26hidden%3D1',
      '/api/threads/t1%3Fpath%3Dnotes%2Fx.txt',
      '/api/threads/a%E2%80%AEb',
      '/api/history/runs?sessionId=&thread_id=t-9',
    ]) {
      const res = await ask('GET', path, mandateCookie);
      await res.arrayBuffer();
    }
    expect(newReadRows().map((r) => r.target)).toEqual([
      '/api/files/read?path=a%26hidden%3D1',
      '/api/threads/t1%3Fpath%3Dnotes%2Fx.txt',
      '/api/threads/a%E2%80%AEb',
      '/api/history/runs?sessionId=&thread_id=t-9',
    ]);
  });

  it('masks a credential where it is visible only once the escapes are undone', async () => {
    // Masked before escaping: a userinfo URL in a value, a Bearer token behind an encoded space.
    const token = 'abcdefghijklmnopqrstuvwxyz';
    for (const path of [
      '/api/files/read?path=https%3A%2F%2Fuser%3Ahunter2pass%40db.example',
      `/api/threads/Bearer%20${token}`,
      '/api/files/read?path=M%C3%A4rz%20Bericht.pdf',
    ]) {
      const res = await ask('GET', path, mandateCookie);
      await res.arrayBuffer();
    }
    const got = newReadRows().map((r) => r.target ?? '');
    expect(got[0]).not.toContain('hunter2pass');
    expect(got[1]).not.toContain(token.slice(0, 20));
    // An id stays readable, letters and spaces as they are.
    expect(got[2]).toBe('/api/files/read?path=März Bericht.pdf');
  });

  it('masks a key that follows a character the row escapes', async () => {
    // Through the real server: a key after a character the row escapes is masked all the same.
    const tail = 'A1b2'.repeat(6);
    for (const path of [`/api/threads/x%3Fsk-ant-${tail}`, `/api/files/read?path=x%3Fsk-ant-${tail}`]) {
      const res = await ask('GET', path, mandateCookie);
      await res.arrayBuffer();
    }
    const got = newReadRows();
    expect(got).toHaveLength(2);
    for (const r of got) expect(r.target).not.toContain(tail);
  });

  it('masks an encoded key behind a byte that is not UTF-8', async () => {
    const tail = 'A1b2'.repeat(6);
    const res = await ask('GET', `/api/threads/%FF%73k-ant-${tail}`, mandateCookie);
    await res.arrayBuffer();
    const got = newReadRows();
    expect(got).toHaveLength(1);
    expect(got[0]?.target).not.toContain(tail);
  });

  it('masks an encoded key next to a malformed escape', async () => {
    const tail = 'A1b2'.repeat(6);
    const res = await ask('GET', `/api/threads/%73k-ant-${tail}%ZZ`, mandateCookie);
    await res.arrayBuffer();
    const got = newReadRows();
    expect(got).toHaveLength(1);
    expect(got[0]?.target).not.toContain(tail);
  });

  it('masks a percent-encoded secret shape in the path as well', async () => {
    // Short enough that only the vendor shape can catch it, not the 40-character catch-all:
    // the encoded `s` hides the shape until the path is decoded.
    const tail = 'A1b2'.repeat(6);
    const res = await ask('GET', `/api/threads/%73k-ant-${tail}`, mandateCookie);
    await res.arrayBuffer();
    const got = newReadRows();
    expect(got).toHaveLength(1);
    expect(got[0]?.target).not.toContain(tail);
  });

  it('writes no row for a mandate\'s cookie at an OAuth callback, answered before authentication', async () => {
    const res = await ask('GET', '/api/oauth/callback?state=x&code=y', mandateCookie);
    await res.arrayBuffer();
    expect(newReadRows()).toHaveLength(0);
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

  it('answers the owner\'s read with a broken trail', async () => {
    await withBrokenTrail(async () => {
      const owner = await ask('GET', '/api/threads', ownerCookie);
      await owner.arrayBuffer();
      expect(owner.status).toBe(200);
    });
  });

  it('writes no read row for a mandate\'s POST', async () => {
    inner().rateCounts.clear();
    const res = await fetch(`${base}/api/push/subscribe`, {
      method: 'POST',
      headers: { cookie: `lynox_session=${mandateCookie}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/ida-read', keys: { p256dh: 'p256dh', auth: 'auth' } } }),
    });
    await res.arrayBuffer();
    // Reached its handler: the write happened, and no read row came with it.
    expect(res.status).toBe(201);
    expect(newReadRows()).toHaveLength(0);
  });

  it('refuses a mandate at an admin route before any read row', async () => {
    const res = await ask('GET', '/api/export', mandateCookie);
    await res.arrayBuffer();
    expect(res.status).toBe(403);
    expect(newReadRows()).toHaveLength(0);
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

  /**
   * Every read of a mandate writes its trail, so a read another site makes the browser send would
   * put a row there the mandate never made: the session cookie is `SameSite=Lax` and travels on a
   * navigation from another site. Such a GET is refused before the row, for every route a mandate
   * reads; the owner's reads and the Web UI's pages stay as they were.
   */
  describe('a read another site sent', () => {
    const askWith = async (method: string, path: string, cookie: string, headers: Record<string, string>): Promise<Response> => {
      inner().rateCounts.clear();
      return fetch(`${base}${path}`, { method, headers: { cookie: `lynox_session=${cookie}`, ...headers } });
    };

    it('refuses a mandate\'s GET and HEAD from another site and a sibling host, and writes no row', async () => {
      for (const method of ['GET', 'HEAD']) {
        for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'https://evil.example' }]) {
          const res = await askWith(method, '/api/threads', mandateCookie, headers);
          await res.arrayBuffer();
          expect(res.status, `${method} ${JSON.stringify(headers)}`).toBe(403);
        }
      }
      expect(newReadRows()).toHaveLength(0);
    });

    it('refuses it for every GET route a mandate reaches, before the trail is asked', async () => {
      const table = api.routeStancesForTesting().filter((r) => r.method === 'GET' && r.scope === 'user' && r.path !== '/api/google/callback' && r.path !== '/api/oauth/callback');
      expect(table.filter((r) => r.stance?.kind === 'reads').length).toBeGreaterThan(50);
      const answered: string[] = [];
      for (const r of table) {
        const res = await askWith('GET', r.path.replace(/:[^/]+/g, 'x1'), mandateCookie, { 'Sec-Fetch-Site': 'cross-site' });
        // This check's refusal, not another 403 (an `owner-only` route refuses a mandate as well).
        const text = await res.text();
        if (res.status !== 403 || !text.includes('another site sent this request')) answered.push(`${r.path} → ${String(res.status)}`);
      }
      expect(answered).toEqual([]);
      expect(newReadRows()).toHaveLength(0);
    }, 60_000);

    it('answers the same read from its own pages and a typed URL, with one row each', async () => {
      for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }]) {
        const res = await askWith('GET', '/api/threads', mandateCookie, headers);
        await res.arrayBuffer();
        expect(res.status, JSON.stringify(headers)).toBe(200);
      }
      expect(newReadRows()).toHaveLength(2);
    });

    it('ALLOWED ON PURPOSE: a mandate\'s read with neither Sec-Fetch-Site nor Origin still runs and is recorded', async () => {
      const res = await askWith('GET', '/api/threads', mandateCookie, {});
      await res.arrayBuffer();
      expect(res.status).toBe(200);
      expect(newReadRows()).toHaveLength(1);
    });

    it('leaves the owner\'s reads from another site as they were: only a mandate\'s reads write a trail', async () => {
      const res = await askWith('GET', '/api/threads', ownerCookie, { 'Sec-Fetch-Site': 'cross-site' });
      await res.arrayBuffer();
      expect(res.status).toBe(200);
      expect(newReadRows()).toHaveLength(0);
    });

    it('lets a link from another site open a Web UI page with a mandate signed in', async () => {
      // A link in a mail opens a page, not an API route: the Web UI answers it before the check.
      const shell = vi.fn(async (_req: unknown, res: { writeHead: (s: number) => void; end: (b: string) => void }) => { res.writeHead(200); res.end('shell'); });
      const ui = inner() as unknown as { webUiHandler: unknown };
      const kept = ui.webUiHandler;
      ui.webUiHandler = shell;
      try {
        const res = await askWith('GET', '/app/threads/t-7', mandateCookie, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('shell');
      } finally { ui.webUiHandler = kept; }
      expect(shell).toHaveBeenCalledTimes(1);
      expect(newReadRows()).toHaveLength(0);
    });

    it('answers a refused navigation to an API route as a sentence, and writes no row', async () => {
      const res = await askWith('GET', '/api/threads', mandateCookie, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(await res.text()).toContain('another site sent this request');
      expect(newReadRows()).toHaveLength(0);
    });
  });
});
