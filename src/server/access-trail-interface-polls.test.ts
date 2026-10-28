import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { INTERFACE_POLLS } from '../core/audit-trail-view.js';

/**
 * Row 1034: the reads a helper's web UI makes by itself are marked in the owner's view, so the view
 * can group them. Measured through the real dispatcher: the mark follows the action the engine
 * itself wrote for the route it dispatched, so each listed route is read here as the web UI reads
 * it, and the mark must come out on exactly those.
 */
describe('reads the web UI makes by itself, in the owner\'s view (real engine)', () => {
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

  type Inner = { rateCounts: Map<string, unknown>; server: Server | null };
  type Entry = { kind: string; action?: string; target?: string | null; auto?: boolean };
  const inner = (): Inner => api as unknown as Inner;
  const ask = async (path: string, cookie: string, method = 'GET'): Promise<Response> => {
    inner().rateCounts.clear();
    return fetch(`${base}${path}`, { method, headers: { cookie: `lynox_session=${cookie}` } });
  };

  /** Each listed poll as the web UI sends it; a key per entry of INTERFACE_POLLS. */
  const POLLED: Record<string, string> = {
    'GET /api/runs/active': '/api/runs/active',
    'GET /api/providers/status': '/api/providers/status',
    'GET /api/history/cost/daily': '/api/history/cost/daily?days=1&tzOffsetMin=0',
    'GET /api/tasks': '/api/tasks?status=in_progress',
  };
  /**
   * The person's own reads on a listed route: grouped too, by route (sec-infra 2026-10-28: „faltet
   * auch das selbst geöffnete Fenster; aufklappbar sichtbar; kein Session-Inhalt“).
   */
  const OWN_ON_LISTED: Record<string, string> = {
    '/api/tasks': 'GET /api/tasks',
    '/api/tasks?status=done': 'GET /api/tasks',
    '/api/history/cost/daily?days=30': 'GET /api/history/cost/daily',
  };
  /** Reads on routes not listed; none may be marked. */
  const OWN = [
    '/api/threads',
    '/api/approvals/count',
    '/api/sessions/s-1/pending-prompt',
  ];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-trail-polls-'));
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
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-POLLS',
      mandate_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })?.token;
    const o = loginSession(SECRET, null)?.token;
    if (m === undefined || o === undefined) throw new Error('fixture: no cookie');
    mandateCookie = m;
    ownerCookie = o;

    for (const path of Object.values(POLLED)) await (await ask(path, mandateCookie)).arrayBuffer();
    for (const path of [...Object.keys(OWN_ON_LISTED), ...OWN]) await (await ask(path, mandateCookie)).arrayBuffer();
    // A listed route read with HEAD.
    await (await ask('/api/runs/active', mandateCookie, 'HEAD')).arrayBuffer();
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

  it('the test reads every listed route, and no other', () => {
    expect(Object.keys(POLLED).sort()).toEqual([...INTERFACE_POLLS].sort());
  });

  it('marks each listed read, and only those', async () => {
    const page = await (await ask('/api/access-trail', ownerCookie)).json() as { entries: Entry[] };
    const events = page.entries.filter((e) => e.kind === 'event');
    // Marked by route: each poll, and the person's own reads on a listed route.
    const marked = events.filter((e) => e.auto === true).map((e) => e.action).sort();
    expect(marked).toEqual([...Object.keys(POLLED), ...Object.values(OWN_ON_LISTED)].sort());
    // Reads on other routes stay unmarked, and so does a HEAD on a listed one.
    const unmarked = events.filter((e) => e.auto !== true).map((e) => e.target).sort();
    expect(unmarked).toEqual([...OWN, '/api/runs/active'].sort());
    expect(events.find((e) => e.action === 'HEAD /api/runs/active')?.auto).toBeUndefined();
    // Every read left its row: the mark groups, it never drops one.
    expect(events).toHaveLength(Object.keys(POLLED).length + Object.keys(OWN_ON_LISTED).length + OWN.length + 1);
  });
});
