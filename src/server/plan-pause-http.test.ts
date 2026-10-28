import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi, TAKEOVER_REFUSALS } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { PLAN_PAUSE_DEFAULT, setPlanPauseForTests } from '../core/plan-pause.js';
import type { Engine } from '../core/engine.js';
import { MandateEnds } from '../core/mandate-ends.js';

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

  it('the default is on only with its way out: the takeover route is registered (asked of the running router), and the view has the button', async () => {
    const id = pausedPlan();
    const res = await ask('POST', `/api/triggers/${id}/takeover`, ownerCookie, { expect: 'x' });
    // A route that exists answers anything but the dispatcher's own 404 for no route; a renamed
    // route counts as missing, and then the default has to stay off.
    const registered = !(res.status === 404 && res.json['error'] === 'Not found' && res.json['code'] === undefined);
    expect(registered).toBe(true);
    expect(PLAN_PAUSE_DEFAULT && !registered).toBe(false);
    // The button at a paused plan, rendered: the view's own test mounts TriggersView with a paused
    // plan and finds it. It is named here so that removing it fails this test too.
    const view = readFileSync(new URL('../../packages/web-ui/src/lib/components/triggersview-takeover.svelte.test.ts', import.meta.url), 'utf8');
    expect(view).toContain("it('shows for the owner at a paused plan'");
    expect(view).toContain("expect(button()?.textContent?.trim()).toBe('Übernehmen');");
    expect(PLAN_PAUSE_DEFAULT).toBe(true);
  });

  it('the takeover\'s refusals, exactly as ux wrote them (U-037, the API\'s fallback)', () => {
    expect(TAKEOVER_REFUSALS).toEqual({
      not_available: { status: 409, message: 'Taking over a plan is not available yet.' },
      bulk: { status: 409, message: "You don't need to take over a bulk run: no helper set it up." },
      nothing_to_take_over: { status: 409, message: 'This plan does not need to be taken over any more.' },
      unreadable: { status: 409, message: 'lynox cannot read who set up the workflow of this plan, so it cannot take the plan over. You can complete or delete it. The plan stays paused.' },
      running: { status: 409, message: 'A run of this plan, or of another plan that uses the same workflow, has not finished yet. Try again in a few minutes. The plan stays paused.' },
      changed: { status: 409, message: 'The plan changed while you were looking at it. Look at it again, then take it over. The plan stays paused.' },
      prompts: { status: 503, message: "lynox cannot close the plan's open questions right now, so it did not take the plan over. It stays paused. Try again in a few minutes." },
      unrecorded: { status: 503, message: 'The takeover cannot be recorded in the instance log right now, so lynox did not take the plan over; it stays paused. Try again in a few minutes.' },
    });
  });

  it('with the pause off, both takeover routes answer not_available before anything is read or written', async () => {
    const id = pausedPlan();
    const before = db().prepare('SELECT * FROM triggers WHERE id = ?').get(id);
    restore();
    restore = setPlanPauseForTests(false);
    const spy = vi.spyOn(engine.getRunHistory()!, 'getTrigger');
    const post = await ask('POST', `/api/triggers/${id}/takeover`, ownerCookie, { expect: 'x' });
    const get = await ask('GET', `/api/triggers/${id}/takeover-preview`, ownerCookie);
    const reads = spy.mock.calls.length;
    spy.mockRestore();
    expect([post.status, post.json['code'], get.status, get.json['code']]).toEqual([409, 'not_available', 409, 'not_available']);
    expect(reads).toBe(0);
    expect(db().prepare('SELECT * FROM triggers WHERE id = ?').get(id)).toEqual(before);
  });

  it('only the owner takes a plan over or sees its preview', async () => {
    const id = pausedPlan();
    const post = await ask('POST', `/api/triggers/${id}/takeover`, mandateCookie, { expect: 'x' });
    const get = await ask('GET', `/api/triggers/${id}/takeover-preview`, mandateCookie);
    expect([post.status, get.status]).toEqual([403, 403]);
    expect((db().prepare('SELECT paused_at FROM triggers WHERE id = ?').get(id) as { paused_at: number | null }).paused_at).toBe(1);
  });

  it('the owner takes a paused plan over from its preview; without the digest, or with another, nothing changes', async () => {
    const id = pausedPlan();
    const missing = await ask('POST', `/api/triggers/${id}/takeover`, ownerCookie, {});
    const wrong = await ask('POST', `/api/triggers/${id}/takeover`, ownerCookie, { expect: 'not-the-digest' });
    expect([missing.status, wrong.status, wrong.json['code']]).toEqual([400, 409, 'changed']);
    expect((db().prepare('SELECT paused_at FROM triggers WHERE id = ?').get(id) as { paused_at: number | null }).paused_at).toBe(1);
    const preview = await ask('GET', `/api/triggers/${id}/takeover-preview`, ownerCookie);
    expect([preview.status, preview.json['refusal'], preview.json['runsAs']]).toEqual([200, null, 'owner']);
    const taken = await ask('POST', `/api/triggers/${id}/takeover`, ownerCookie, { expect: preview.json['expect'] });
    expect([taken.status, taken.json['paused'], taken.json['runsAs']]).toEqual([200, false, 'owner']);
    const row = db().prepare('SELECT paused_at, paused_for, covered_created_by, covered_created_id, edited_by, confirmed_by FROM triggers WHERE id = ?').get(id);
    expect(row).toEqual({
      paused_at: null, paused_for: null, covered_created_by: 'mandate:ida@example.invalid', covered_created_id: 'TEST-MANDATE-PAUSE',
      edited_by: 'owner', confirmed_by: 'owner',
    });
    const audit = db().prepare("SELECT actor_kind, target FROM audit_log WHERE action = 'plan.takeover'").all();
    expect(audit).toContainEqual({ actor_kind: 'owner', target: `trigger=${id} mandates=TEST-MANDATE-PAUSE` });
    const again = await ask('POST', `/api/triggers/${id}/takeover`, ownerCookie, { expect: preview.json['expect'] });
    expect([again.status, again.json['code']]).toEqual([409, 'nothing_to_take_over']);
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

  it('the list tells the owner whose access ended, a helper only that it is paused, and neither the stored columns', async () => {
    const id = pausedPlan();
    db().prepare('UPDATE triggers SET paused_for = ? WHERE id = ?').run(JSON.stringify([
      { mandateId: 'TEST-MANDATE-PAUSE', email: 'ida@example.invalid', reason: 'revoked', endsAt: 1, roles: ['created'], closedPrompt: false },
    ]), id);
    const rowOf = async (cookie: string): Promise<Record<string, unknown> | undefined> =>
      ((await ask('GET', '/api/triggers', cookie)).json['triggers'] as Array<Record<string, unknown>>).find((t) => t['id'] === id);
    const owner = await rowOf(ownerCookie);
    expect(owner?.['paused']).toBe(true);
    expect(owner?.['paused_who']).toEqual(['ida@example.invalid']);
    // How and when, for the notice the view says in full (the push shortens the name).
    expect(owner?.['paused_ended']).toEqual([{ email: 'ida@example.invalid', reason: 'revoked', ends_at: '1970-01-01T00:00:01.000Z', warned: false }]);
    const helper = await rowOf(mandateCookie);
    expect(helper?.['paused']).toBe(true);
    expect(helper).not.toHaveProperty('paused_who');
    expect(helper).not.toHaveProperty('paused_ended');
    // An end the owner was warned of says so (641c-2b writes `warned`).
    db().prepare('UPDATE triggers SET paused_for = ? WHERE id = ?').run(JSON.stringify([
      { mandateId: 'TEST-MANDATE-PAUSE', email: 'ida@example.invalid', reason: 'expired', endsAt: 1, roles: ['created'], closedPrompt: false, warned: true },
    ]), id);
    expect((await rowOf(ownerCookie))?.['paused_ended']).toEqual([{ email: 'ida@example.invalid', reason: 'expired', ends_at: '1970-01-01T00:00:01.000Z', warned: true }]);
    for (const row of [owner, helper]) {
      for (const col of ['paused_at', 'paused_due_at', 'paused_for']) expect(row).not.toHaveProperty(col);
    }
    // Switching it answers the same row shape.
    const sw = await ask('PATCH', `/api/tasks/${id}`, ownerCookie, { enabled: true });
    expect(sw.json).not.toHaveProperty('paused_for');
    expect(sw.json['paused_who']).toEqual(['ida@example.invalid']);
  });

  it('the list says who reads it, the owner or a helper', async () => {
    expect((await ask('GET', '/api/triggers', ownerCookie)).json['viewer']).toBe('owner');
    expect((await ask('GET', '/api/triggers', mandateCookie)).json['viewer']).toBe('mandate');
  });

  it('the count of paused plans is for the owner, and leaves out a completed plan', async () => {
    const count = async (cookie: string): Promise<unknown> => (await ask('GET', '/api/triggers/paused-count', cookie)).json['count'];
    const before = await count(ownerCookie);
    expect(typeof before).toBe('number');
    const id = pausedPlan();
    expect(await count(ownerCookie)).toBe((before as number) + 1);
    db().prepare("UPDATE triggers SET status = 'completed' WHERE id = ?").run(id);
    expect(await count(ownerCookie)).toBe(before);
    // A helper is not told how many plans are paused (some may be another's).
    const helper = await ask('GET', '/api/triggers/paused-count', mandateCookie);
    expect([helper.status, helper.json['viewer'], helper.json['count']]).toEqual([200, 'mandate', null]);
  });

  it('the paused filter is applied before the list is cut at a hundred rows', async () => {
    const id = pausedPlan();
    db().prepare("UPDATE triggers SET next_run_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    for (let i = 0; i < 101; i++) {
      engine.getRunHistory()!.insertTrigger({
        id: `early-${String(i)}`, title: 'Early', source: 'cron', effect: 'notify', scheduleCron: '0 9 * * 1', nextRunAt: '2026-01-05T09:00:00.000Z',
        confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner',
      });
    }
    try {
      const all = await ask('GET', '/api/triggers', ownerCookie);
      // The unfiltered list is cut before the plan: filtering it afterwards would miss it.
      expect((all.json['triggers'] as Array<{ id: string }>).map((t) => t.id)).not.toContain(id);
      const only = await ask('GET', '/api/triggers?status=paused', ownerCookie);
      expect((only.json['triggers'] as Array<{ id: string }>).map((t) => t.id)).toContain(id);
    } finally {
      db().prepare("DELETE FROM triggers WHERE id LIKE 'early-%'").run();
    }
  });

  it("a mandate's request that extends its ended grant pauses its plan before the extension commits", async () => {
    const nowS = Math.floor(Date.now() / 1000);
    engine.getRunHistory()!.insertTrigger({
      id: 'extended', title: 'Extended', source: 'cron', effect: 'notify', scheduleCron: '0 9 * * 1', nextRunAt: '2026-01-05T09:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner', createdBy: 'mandate:eva@example.invalid', createdMandateId: 'TEST-MANDATE-EXT',
    });
    // The grant had ended, as an earlier login recorded it.
    db().prepare('INSERT INTO mandate_ends (mandate_id, ends_at, issued_at) VALUES (?, ?, ?)').run('TEST-MANDATE-EXT', nowS - 3600, nowS - 7200);
    const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
    const eva = loginSession(SECRET, {
      kind: 'mandate', email: 'eva@example.invalid', display: 'EVA', mandate_id: 'TEST-MANDATE-EXT',
      mandate_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    })?.token;
    if (eva === undefined) throw new Error('fixture: no cookie');
    await ask('GET', '/api/triggers', eva);
    expect(engine.getMandateEnds()!.isLive('TEST-MANDATE-EXT')).toBe(true);
    const row = db().prepare('SELECT paused_at, paused_for FROM triggers WHERE id = ?').get('extended') as { paused_at: number | null; paused_for: string };
    expect(row.paused_at).not.toBeNull();
    expect(JSON.parse(row.paused_for)).toMatchObject([{ mandateId: 'TEST-MANDATE-EXT', reason: 'expired', endsAt: nowS - 3600 }]);
  });

  it('with the switch off nothing is refused for a pause and nothing shows one', async () => {
    restore();
    restore = () => undefined;
    const off = setPlanPauseForTests(false);
    try {
      const id = pausedPlan();
      db().prepare('UPDATE triggers SET paused_for = ? WHERE id = ?').run(JSON.stringify([
        { mandateId: 'TEST-MANDATE-PAUSE', email: 'ida@example.invalid', reason: 'revoked', endsAt: 1, roles: ['created'], closedPrompt: false },
      ]), id);
      const all = await ask('GET', '/api/triggers', ownerCookie);
      // Off, the row carries no `paused` at all: the list is main's.
      expect((all.json['triggers'] as Array<{ id: string; paused?: boolean }>).find((t) => t.id === id)).not.toHaveProperty('paused');
      // Nor what is stored about it: after a time with the switch on and back, `paused_for` stays in the row.
      expect((all.json['triggers'] as Array<{ id: string }>).find((t) => t.id === id)).not.toHaveProperty('paused_for');
      const edit = await ask('PATCH', `/api/tasks/${id}`, ownerCookie, { title: 'Renamed' });
      expect(edit.status).toBe(200);
      // Every answer that sends the row back leaves the stored columns out, a helper's edit as well.
      const stored = ['paused_at', 'paused_due_at', 'paused_for'];
      const helperEdit = await ask('PATCH', `/api/tasks/${id}`, mandateCookie, { title: 'Again' });
      const stamp = await ask('POST', `/api/tasks/${id}/confirm`, ownerCookie, {});
      const done = await ask('POST', `/api/tasks/${id}/complete`, mandateCookie);
      for (const [what, r] of [['owner edit', edit], ['helper edit', helperEdit], ['confirm', stamp], ['complete', done]] as const) {
        expect([what, r.status, r.json['id']]).toEqual([what, 200, id]);
        for (const col of stored) expect(r.json, `${what} ${col}`).not.toHaveProperty(col);
      }
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
      // A question of the plan still open: the sweep ends it, it is not released for an answer.
      const asked = first.engine.getPromptStore()!.insertAskUser('s-stock', 'Go on?', undefined, undefined, undefined, undefined, 'stock');
      await first.api.shutdown();

      const restore = setPlanPauseForTests(true);
      try {
        const second = await up(dir);
        try {
          const row = second.engine.getEngineDb()!.getDb().prepare('SELECT paused_at, paused_for FROM triggers WHERE id = ?').get('stock') as { paused_at: number | null; paused_for: string | null };
          expect(row.paused_at).not.toBeNull();
          expect(row.paused_for).toContain('old@example.invalid');
          expect(second.engine.getPromptStore()!.getById(asked)?.status).toBe('expired');
        } finally { await second.api.shutdown(); }
      } finally { restore(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
});

describe('the boot sweep, switched off and failing (real engine)', () => {
  /** Two boots on one file; between them a plan and its mandate's ended grant are written. */
  async function seeded(dir: string): Promise<void> {
    const first = await up(dir);
    first.engine.getRunHistory()!.insertTrigger({
      id: 'stock', title: 'Stock', source: 'cron', effect: 'notify', scheduleCron: '0 9 * * 1', nextRunAt: '2026-01-05T09:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z', createdBy: 'mandate:old@example.invalid', createdMandateId: 'G-OLD',
    });
    first.engine.getMandateEnds()!.record({ kind: 'mandate', email: 'old@example.invalid', mandateId: 'G-OLD', mandateExp: Math.floor(Date.now() / 1000) - 3600 }, Math.floor(Date.now() / 1000) - 7200);
    await first.api.shutdown();
  }
  const pausedAt = (engine: Engine): number | null =>
    (engine.getEngineDb()!.getDb().prepare('SELECT paused_at FROM triggers WHERE id = ?').get('stock') as { paused_at: number | null }).paused_at;

  it('switched off, a boot with an ended grant on file pauses nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-pause-boot-off-'));
    try {
      await seeded(dir);
      const restore = setPlanPauseForTests(false);
      try {
        const second = await up(dir);
        try {
          expect(pausedAt(second.engine)).toBeNull();
          // The same file pauses on a boot with the switch on: the plan was one the sweep would take.
          restore();
          await second.api.shutdown();
          const on = setPlanPauseForTests(true);
          try {
            const third = await up(dir);
            try { expect(pausedAt(third.engine)).not.toBeNull(); } finally { await third.api.shutdown(); }
          } finally { on(); }
        } catch (err) { await second.api.shutdown().catch(() => undefined); throw err; }
      } finally { restore(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);

  it('a sweep that throws at boot is said on stderr and the engine still starts and answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-pause-boot-throw-'));
    try {
      await seeded(dir);
      const restore = setPlanPauseForTests(true);
      const endRow = vi.spyOn(MandateEnds.prototype, 'endRow').mockImplementation(() => { throw new Error('disk I/O error'); });
      const err = vi.spyOn(process.stderr, 'write');
      try {
        const second = await up(dir);
        try {
          endRow.mockRestore();
          expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('pausing plans of ended mandates failed');
          expect(pausedAt(second.engine)).toBeNull();
          const health = await fetch(`${second.base}/api/health`);
          expect(health.status).toBe(200);
        } finally { await second.api.shutdown(); }
      } finally { endRow.mockRestore(); err.mockRestore(); restore(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);
});
