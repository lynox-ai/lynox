import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { TRAIL_FORM } from '../core/audit-log.js';

/**
 * The owner's view of the actor trail (`GET /api/access-trail`) — measured on a real engine,
 * through the real dispatcher, with rows a mandate's reads really wrote. The owner reads them;
 * the mandate may not; a row from before the trail's current form is not shown.
 */
describe('the owner\'s view of the actor trail (real engine)', () => {
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

  type Inner = {
    engine: { engineDb: { getDb: () => import('better-sqlite3').Database } };
    rateCounts: Map<string, unknown>;
    server: Server | null;
  };
  type Entry = { kind: string; target?: string | null; person?: { email: string | null } };
  type Page = { entries: Entry[]; before: number | null };
  const inner = (): Inner => api as unknown as Inner;

  const ask = async (path: string, cookie: string): Promise<Response> => {
    inner().rateCounts.clear();
    return fetch(`${base}${path}`, { headers: { cookie: `lynox_session=${cookie}` } });
  };
  const targetsOf = (page: Page): (string | null | undefined)[] => page.entries.map((e) => e.target);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-access-trail-'));
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
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-VIEW',
      mandate_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })?.token;
    const o = loginSession(SECRET, null)?.token;
    if (m === undefined || o === undefined) throw new Error('fixture: no cookie');
    mandateCookie = m;
    ownerCookie = o;

    // Two reads by the mandate, each leaving its row through the real dispatcher.
    for (const path of ['/api/threads/t-1', '/api/threads/t-2']) await (await ask(path, mandateCookie)).arrayBuffer();
    // An owner's read writes no row at all, so the owner's row in the current form is written
    // here, as is a mandate row from before the current form (no `trail_form`).
    const db = inner().engine.engineDb.getDb();
    db.prepare(
      `INSERT INTO audit_log (ts, actor_kind, action, target, phase, correlation_id, trail_form)
       VALUES (?, 'owner', 'trigger.run', 't-owner', 'attempt', 'c-owner', ?)`,
    ).run(new Date().toISOString(), TRAIL_FORM);
    db.prepare(
      `INSERT INTO audit_log (ts, actor_kind, actor_email, actor_display, mandate_id, action, target, phase, correlation_id)
       VALUES (?, 'mandate', 'ida@example.invalid', 'IDA', 'TEST-MANDATE-VIEW', 'GET /api/threads/:id', '/api/threads/t-old', 'read', 'c-old')`,
    ).run(new Date().toISOString());
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

  it('shows the owner the mandate\'s rows, newest first, and nothing else', async () => {
    const res = await ask('/api/access-trail', ownerCookie);
    expect(res.status).toBe(200);
    const page = await res.json() as Page;
    expect(targetsOf(page)).toEqual(['/api/threads/t-2', '/api/threads/t-1']);
    expect(page.entries.every((e) => e.person?.email === 'ida@example.invalid')).toBe(true);
    expect(page.before).toBeNull();
  });

  it('does not show a row written before the trail\'s current form', async () => {
    const page = await (await ask('/api/access-trail', ownerCookie)).json() as Page;
    expect(targetsOf(page)).not.toContain('/api/threads/t-old');
    // The row is there, so the route left it out, not the fixture.
    const n = inner().engine.engineDb.getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE target = '/api/threads/t-old'").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('pages back from the oldest row of a full page', async () => {
    const first = await (await ask('/api/access-trail?limit=1', ownerCookie)).json() as Page;
    expect(targetsOf(first)).toEqual(['/api/threads/t-2']);
    expect(first.before).not.toBeNull();
    const next = await (await ask(`/api/access-trail?limit=1&before=${String(first.before)}`, ownerCookie)).json() as Page;
    expect(targetsOf(next)).toEqual(['/api/threads/t-1']);
  });

  it('refuses a mandate', async () => {
    const res = await ask('/api/access-trail', mandateCookie);
    expect(res.status).toBe(403);
    await res.arrayBuffer();
  });
});
