import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { PLAN_PAUSE_DEFAULT, setPlanPauseForTests } from '../core/plan-pause.js';
import type { Engine } from '../core/engine.js';

/**
 * The plan pause (`plan-pause.ts`) through a real engine and the real dispatcher: the switch is
 * held to the takeover route, the routes refuse a paused plan before anything marks it, and the
 * boot sweep pauses a plan whose mandate ended while the engine was down.
 */

const SECRET = `t-${randomBytes(12).toString('hex')}`;
const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];
const VAULT = `v-${randomBytes(12).toString('hex')}`;
const ENDED = 'This schedule, or the workflow it runs, was set up or changed by someone whose access has ended, so it does not run.';

type Inner = { engine: Engine; rateCounts: Map<string, unknown>; server: Server | null };

async function up(dir: string): Promise<{ api: LynoxHTTPApi; base: string; engine: Engine }> {
  process.env['LYNOX_DATA_DIR'] = dir;
  reloadConfig();
  const api = new LynoxHTTPApi();
  await api.init();
  await api.start(0);
  const addr = (api as unknown as Inner).server?.address();
  if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('fixture: no port');
  return { api, base: `http://127.0.0.1:${String(addr.port)}`, engine: (api as unknown as Inner).engine };
}

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env['LYNOX_HTTP_SECRET'] = SECRET;
  process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
  process.env['LYNOX_VAULT_KEY'] = VAULT;
  delete process.env['LYNOX_BILLING_TIER'];
  delete process.env['LYNOX_MANAGED_MODE'];
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('the pause is held to its takeover (real engine)', () => {
  let dir: string;
  let api: LynoxHTTPApi;
  let base: string;
  let engine: Engine;
  let ownerCookie: string;
  let mandateCookie: string;
  let restore: () => void = () => undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-pause-http-'));
    ({ api, base, engine } = await up(dir));
    const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
    const m = loginSession(SECRET, {
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-PAUSE',
      mandate_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })?.token;
    const o = loginSession(SECRET, null)?.token;
    if (m === undefined || o === undefined) throw new Error('fixture: no cookie');
    mandateCookie = m;
    ownerCookie = o;
  }, 120_000);
  afterAll(async () => {
    await api?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => { restore = setPlanPauseForTests(true); });
  afterEach(() => { restore(); });

  const ask = async (method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    (api as unknown as Inner).rateCounts.clear();
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { cookie: `lynox_session=${cookie}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text === '' ? {} : JSON.parse(text) as Record<string, unknown> };
  };

  const db = (): import('better-sqlite3').Database => engine.getEngineDb()!.getDb();
  let n = 0;
  /** A stamped plan the mandate of the cookie created, paused. */
  const pausedPlan = (): string => {
    const id = `paused-${String(++n)}`;
    engine.getRunHistory()!.insertTrigger({
      id, title: 'Weekly', source: 'cron', effect: 'notify', scheduleCron: '0 9 * * 1', nextRunAt: '2026-01-05T09:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner', createdBy: 'mandate:ida@example.invalid', createdMandateId: 'TEST-MANDATE-PAUSE',
    });
    db().prepare('UPDATE triggers SET paused_at = 1 WHERE id = ?').run(id);
    return id;
  };
  const marks = (id: string): unknown => db().prepare('SELECT edited_by, mandate_editor FROM triggers WHERE id = ?').get(id);

  it('the default is off for as long as the takeover route is not registered (asked of the running router)', async () => {
    const id = pausedPlan();
    const res = await ask('POST', `/api/triggers/${id}/takeover`, ownerCookie);
    // A route that exists answers anything but the dispatcher's own 404 for no route; a renamed
    // route counts as missing, and then the default has to stay off.
    const registered = !(res.status === 404 && res.json['error'] === 'Not found' && res.json['code'] === undefined);
    expect(registered).toBe(false);
    expect(PLAN_PAUSE_DEFAULT && !registered).toBe(false);
  });

  it('Run now on a paused plan answers 409 with its own code', async () => {
    const id = pausedPlan();
    const res = await ask('POST', `/api/triggers/${id}/run`, ownerCookie);
    expect([res.status, res.json['code'], res.json['error']]).toEqual([409, 'paused', 'paused because an access ended; it needs to be taken over']);
  });

  it("a mandate's change, completion and delete are refused before anything marks the plan", async () => {
    for (const [method, path, body] of [
      ['PATCH', '', { title: 'Renamed' }], ['PATCH', '', { enabled: false }], ['POST', '/complete', undefined], ['DELETE', '', undefined],
    ] as const) {
      const id = pausedPlan();
      const res = await ask(method, `/api/tasks/${id}${path}`, mandateCookie, body);
      expect([method, path, res.status, res.json['code']]).toEqual([method, path, 409, 'paused']);
      expect(marks(id)).toEqual({ edited_by: null, mandate_editor: null });
    }
  });

  it('the owner may switch it, complete it and delete it, but not edit or stamp it', async () => {
    const edit = await ask('PATCH', `/api/tasks/${pausedPlan()}`, ownerCookie, { title: 'Renamed' });
    expect([edit.status, edit.json['code']]).toEqual([409, 'paused']);
    const stamp = await ask('POST', `/api/tasks/${pausedPlan()}/confirm`, ownerCookie, {});
    expect([stamp.status, stamp.json['code']]).toEqual([409, 'paused']);
    const sw = await ask('PATCH', `/api/tasks/${pausedPlan()}`, ownerCookie, { enabled: true });
    expect([sw.status, sw.json['paused'], sw.json['note']]).toEqual([200, true, 'paused because an access ended; it needs to be taken over']);
    expect((await ask('POST', `/api/tasks/${pausedPlan()}/complete`, ownerCookie)).status).toBe(200);
    expect((await ask('DELETE', `/api/tasks/${pausedPlan()}`, ownerCookie)).status).toBe(200);
  });

  it('the list shows a plan as paused, and filters on it', async () => {
    const id = pausedPlan();
    const all = await ask('GET', '/api/triggers', ownerCookie);
    const mine = (all.json['triggers'] as Array<{ id: string; paused: boolean }>).find((t) => t.id === id);
    expect(mine?.paused).toBe(true);
    const only = await ask('GET', '/api/triggers?status=paused', ownerCookie);
    const ids = (only.json['triggers'] as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain(id);
    expect(ids.every((x) => x.startsWith('paused-'))).toBe(true);
  });

  it('with the switch off nothing is refused for a pause and nothing shows one', async () => {
    restore();
    restore = () => undefined;
    const off = setPlanPauseForTests(false);
    try {
      const id = pausedPlan();
      const all = await ask('GET', '/api/triggers', ownerCookie);
      expect((all.json['triggers'] as Array<{ id: string; paused: boolean }>).find((t) => t.id === id)?.paused).toBe(false);
      const edit = await ask('PATCH', `/api/tasks/${id}`, ownerCookie, { title: 'Renamed' });
      expect(edit.status).toBe(200);
    } finally { off(); }
  });
});

describe('the boot sweep (real engine)', () => {
  it("pauses a plan the gate stopped before the upgrade, whose mandate ended before the boot, before the worker starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-pause-boot-'));
    try {
      // First boot, switch off: the plan and its mandate's ended grant are written, as the earlier gate left them.
      const first = await up(dir);
      first.engine.getRunHistory()!.insertTrigger({
        id: 'stock', title: 'Stock', source: 'cron', effect: 'notify', scheduleCron: '0 9 * * 1', nextRunAt: '2026-01-05T09:00:00.000Z',
        confirmedAt: '2026-01-01T00:00:00.000Z', createdBy: 'mandate:old@example.invalid', createdMandateId: 'G-OLD',
      });
      first.engine.getEngineDb()!.getDb().prepare("UPDATE triggers SET status = 'stopped', last_run_status = 'stopped', last_run_result = ? WHERE id = 'stock'").run(ENDED);
      first.engine.getMandateEnds()!.record({ kind: 'mandate', email: 'old@example.invalid', mandateId: 'G-OLD', mandateExp: Math.floor(Date.now() / 1000) - 3600 }, Math.floor(Date.now() / 1000) - 7200);
      await first.api.shutdown();

      const restore = setPlanPauseForTests(true);
      try {
        const second = await up(dir);
        try {
          const row = second.engine.getEngineDb()!.getDb().prepare('SELECT paused_at, paused_for FROM triggers WHERE id = ?').get('stock') as { paused_at: number | null; paused_for: string | null };
          expect(row.paused_at).not.toBeNull();
          expect(row.paused_for).toContain('old@example.invalid');
        } finally { await second.api.shutdown(); }
      } finally { restore(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
});
