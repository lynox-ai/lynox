import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { setPlanPauseForTests } from '../core/plan-pause.js';
import { COVER_FROM_MARKS } from '../core/takeover-core.js';
import { withOwnerStamp, workflowAwaitsStampResult } from '../core/workflow-stamp.js';
import type { Engine } from '../core/engine.js';
import type { PlannedPipeline } from '../types/pipeline.js';
import type { RequestPrincipal } from '../core/request-principal.js';

/**
 * The owner's takeover of a workflow from the library (`workflow-takeover.ts`) through a real
 * engine and the real dispatcher: who may ask, that the library's Run button then runs it as the
 * owner, and that the library offers it exactly where the takeover allows it. Only the runner
 * itself is replaced, to see whom a run is for without running a model.
 */

const runs = vi.hoisted(() => ({ principals: [] as unknown[] }));
vi.mock('../core/saved-workflow-runner.js', async (importActual) => ({
  ...(await importActual<typeof import('../core/saved-workflow-runner.js')>()),
  runGuardedSavedWorkflow: async (_engine: unknown, _id: string, _params: unknown, opts: { principal: RequestPrincipal }) => {
    runs.principals.push(opts.principal);
    return { ok: true, runId: `run-${String(runs.principals.length)}`, status: 'completed' };
  },
}));

const SECRET = `t-${randomBytes(12).toString('hex')}`;
const VAULT = `v-${randomBytes(12).toString('hex')}`;
const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_DURABLE_MEMORY_ENABLED'];

type Inner = { engine: Engine; rateCounts: Map<string, unknown>; server: Server | null };

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env['LYNOX_HTTP_SECRET'] = SECRET;
  process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
  process.env['LYNOX_VAULT_KEY'] = VAULT;
  process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = 'true';
  delete process.env['LYNOX_BILLING_TIER'];
  delete process.env['LYNOX_MANAGED_MODE'];
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('the workflow takeover routes (real engine)', () => {
  let dir: string;
  let api: LynoxHTTPApi;
  let base: string;
  let engine: Engine;
  let ownerCookie: string;
  let mandateCookie: string;
  let restore: () => void = () => undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-wf-takeover-http-'));
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as Inner).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('fixture: no port');
    base = `http://127.0.0.1:${String(addr.port)}`;
    engine = (api as unknown as Inner).engine;
    const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
    const m = loginSession(SECRET, {
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-WF',
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
  beforeEach(() => { restore = setPlanPauseForTests(true); runs.principals.length = 0; });
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
  const nowS = (): number => Math.floor(Date.now() / 1000);
  let n = 0;
  const grantOf = (email: string): string => `G-${email}`;
  const end = (email: string): void => {
    engine.getMandateEnds()!.record({ kind: 'mandate', email, mandateId: grantOf(email), mandateExp: nowS() - 3600 }, nowS() - 7200);
  };
  const live = (email: string): void => {
    engine.getMandateEnds()!.record({ kind: 'mandate', email, mandateId: grantOf(email), mandateExp: nowS() + 3600 }, nowS() - 10);
  };
  /** A library workflow a mandate created (`by`), with an id unique to the test; stamped by the owner when `stamped`. */
  const workflow = (by: string | null, opts: { stamped?: boolean; grant?: string | null; steps?: unknown[] } = {}): string => {
    const id = `wf-${String(++n)}-${randomBytes(3).toString('hex')}`;
    const steps = opts.steps ?? [{ id: 's1', task: 'Summarise the week' }];
    const plain = { id, name: `W ${id}`, template: true, mode: 'autonomous', steps } as unknown as PlannedPipeline;
    const planned = opts.stamped === true ? withOwnerStamp(engine.getEngineDb()!, plain, new Date().toISOString()) : plain;
    const grant = opts.grant === undefined ? (by === null ? null : grantOf(by)) : opts.grant;
    db().prepare("INSERT INTO workflows (id, name, definition_json, is_template, created_by, created_mandate_id, created_at) VALUES (?, ?, ?, 1, ?, ?, '2026-01-01 00:00:00')")
      .run(id, plain.name, JSON.stringify(planned), by === null ? null : `mandate:${by}`, grant);
    return id;
  };
  const editor = (id: string, email: string): void => {
    db().prepare("UPDATE workflows SET mandate_editor = ?, mandate_editor_id = ?, mandate_edited_at = '2026-02-01 00:00:00' WHERE id = ?").run(`mandate:${email}`, grantOf(email), id);
  };
  const run = (id: string): Promise<{ status: number; json: Record<string, unknown> }> => ask('POST', `/api/workflows/${id}/run`, ownerCookie);
  const takeOver = async (id: string): Promise<{ status: number; json: Record<string, unknown> }> => {
    const p = await ask('GET', `/api/workflows/${id}/takeover-preview`, ownerCookie);
    expect([p.status, p.json['refusal']]).toEqual([200, null]);
    return ask('POST', `/api/workflows/${id}/takeover`, ownerCookie, { expect: p.json['expect'] });
  };

  it('stamp holds, mandate ended: Run is refused, and after the takeover Run runs as the owner', async () => {
    const id = workflow('a@example.invalid', { stamped: true });
    end('a@example.invalid');
    const refused = await run(id);
    expect([refused.status, refused.json['code']]).toEqual([403, 'author_ended']);
    expect(runs.principals).toEqual([]);
    const out = await takeOver(id);
    expect([out.status, out.json]).toEqual([200, { takenOver: true, runsAs: 'owner', stillOff: 0 }]);
    const ran = await run(id);
    expect(ran.status).toBe(200);
    expect(runs.principals).toEqual([{ kind: 'owner' }]);
  });

  it('the mandate changed the steps after the stamp: Run waits for the stamp (the definition is cached), and after the takeover it runs as the owner', async () => {
    const id = workflow('b@example.invalid', { stamped: true });
    live('b@example.invalid');
    db().prepare("UPDATE workflows SET definition_json = json_set(definition_json, '$.steps[0].task', 'Summarise the month') WHERE id = ?").run(id);
    editor(id, 'b@example.invalid');
    const waits = await run(id);
    expect([waits.status, waits.json['code']]).toEqual([409, 'workflow_awaits_stamp']);
    // The grant runs out: a later login's record with its end passed.
    engine.getMandateEnds()!.record({ kind: 'mandate', email: 'b@example.invalid', mandateId: grantOf('b@example.invalid'), mandateExp: nowS() - 1 }, nowS());
    expect(engine.getMandateEnds()!.isLive(grantOf('b@example.invalid'))).toBe(false);
    const out = await takeOver(id);
    expect(out.status).toBe(200);
    const ran = await run(id);
    expect(ran.status).toBe(200);
    expect(runs.principals).toEqual([{ kind: 'owner' }]);
  });

  it('a mandate may neither see the preview nor take a workflow over, and nothing is written', async () => {
    const id = workflow('c@example.invalid');
    end('c@example.invalid');
    const before = db().prepare('SELECT * FROM workflows WHERE id = ?').get(id);
    expect((await ask('GET', `/api/workflows/${id}/takeover-preview`, mandateCookie)).status).toBe(403);
    expect((await ask('POST', `/api/workflows/${id}/takeover`, mandateCookie, { expect: 'x' })).status).toBe(403);
    expect(db().prepare('SELECT * FROM workflows WHERE id = ?').get(id)).toEqual(before);
  });

  it('is not held to the plan pause: with the pause off the takeover still works', async () => {
    restore();
    restore = setPlanPauseForTests(false);
    const id = workflow('d@example.invalid');
    end('d@example.invalid');
    expect((await takeOver(id)).status).toBe(200);
  });

  it('refuses without a digest, with a stale digest (changed) and for a live mandate (mandate_live), by code', async () => {
    const id = workflow('e@example.invalid');
    end('e@example.invalid');
    expect((await ask('POST', `/api/workflows/${id}/takeover`, ownerCookie, {})).status).toBe(400);
    const stale = await ask('POST', `/api/workflows/${id}/takeover`, ownerCookie, { expect: 'stale' });
    expect([stale.status, stale.json['code']]).toEqual([409, 'changed']);
    const liveId = workflow('f@example.invalid');
    live('f@example.invalid');
    const p = await ask('GET', `/api/workflows/${liveId}/takeover-preview`, ownerCookie);
    expect([p.status, p.json['refusal']]).toEqual([200, 'mandate_live']);
    const r = await ask('POST', `/api/workflows/${liveId}/takeover`, ownerCookie, { expect: 'x' });
    expect([r.status, r.json['code']]).toEqual([409, 'mandate_live']);
    expect((await ask('GET', '/api/workflows/no-such-workflow/takeover-preview', ownerCookie)).status).toBe(404);
  });

  it('the preview shows the steps as the stamp preview does, each with its connection flag, and the marks', async () => {
    const id = workflow('g@example.invalid');
    end('g@example.invalid');
    const stamp = await ask('GET', `/api/workflows/${id}/stamp-preview`, ownerCookie);
    const p = await ask('GET', `/api/workflows/${id}/takeover-preview`, ownerCookie);
    expect(p.json['steps']).toEqual((stamp.json['steps'] as Array<Record<string, unknown>>).map((s) => ({ ...s, foreignConnection: false })));
    expect(p.json['marks']).toEqual([{ name: 'g@example.invalid', role: 'workflow-created', ended: true }]);
    expect(p.json['planned']).toBeUndefined();
  });

  it('marks a captured step on a connection a mandate made, and names the covered mandate’s connection', async () => {
    const id = workflow('k@example.invalid', { steps: [
      { id: 's1', task: 'Summarise the week' },
      { id: 's2', task: 'Read the orders', tool: 'http_request', input_template: { url: 'https://shop.example.invalid/orders', method: 'GET' } },
    ] });
    end('k@example.invalid');
    const shop = {
      id: 'shop', name: 'Shop', base_url: 'https://shop.example.invalid',
      oauth_grant: { connected_by: 'mandate:k@example.invalid', connected_mandate_id: grantOf('k@example.invalid'), account: { label: 'Main store', source: 'store' } },
    };
    const inner = engine as unknown as { getApiStore: () => unknown };
    const orig = inner.getApiStore;
    inner.getApiStore = () => ({ knownProfiles: () => [shop], getByHostname: (h: string) => (h === 'shop.example.invalid' ? shop : undefined) });
    try {
      const p = await ask('GET', `/api/workflows/${id}/takeover-preview`, ownerCookie);
      expect((p.json['steps'] as Array<{ id: string; foreignConnection: boolean }>).map((s) => [s.id, s.foreignConnection])).toEqual([['s1', false], ['s2', true]]);
      expect(p.json['connections']).toEqual([{ profileId: 'shop', account: 'Main store', by: 'k@example.invalid' }]);
    } finally {
      inner.getApiStore = orig;
    }
  });

  it('counts the plans that stay switched off after the takeover, as the stamp does', async () => {
    const id = workflow('h@example.invalid');
    end('h@example.invalid');
    engine.getRunHistory()!.insertTrigger({ id: `off-${id}`, title: 'Off', source: 'webhook', effect: 'run_workflow', pipelineId: id });
    db().prepare('UPDATE triggers SET enabled = 0, last_run_result = ? WHERE id = ?').run(`${workflowAwaitsStampResult(id)} (since)`, `off-${id}`);
    const out = await takeOver(id);
    expect([out.status, out.json['stillOff']]).toEqual([200, 1]);
  });

  describe('the library shows the Run refusal for an ended author exactly where the takeover is allowed', () => {
    const cases: Array<[string, () => string]> = [
      ['no mandate mark', () => workflow(null)],
      ['a live mandate', () => { const id = workflow('l1@example.invalid'); live('l1@example.invalid'); return id; }],
      ['an ended mandate', () => { const id = workflow('x1@example.invalid'); end('x1@example.invalid'); return id; }],
      ['live creator, ended editor', () => { const id = workflow('l2@example.invalid'); live('l2@example.invalid'); editor(id, 'x2@example.invalid'); end('x2@example.invalid'); return id; }],
      ['ended creator, live editor', () => { const id = workflow('x3@example.invalid'); end('x3@example.invalid'); editor(id, 'l3@example.invalid'); live('l3@example.invalid'); return id; }],
      ['a mark without a grant id', () => workflow('u1@example.invalid', { grant: null })],
      ['editor covered, creator ended', () => {
        const id = workflow('x4@example.invalid');
        end('x4@example.invalid');
        editor(id, 'x5@example.invalid');
        end('x5@example.invalid');
        // The editor's mark alone covered, as a takeover of an earlier state left it.
        db().prepare(`UPDATE workflows SET ${COVER_FROM_MARKS} WHERE id = ?`).run(nowS(), id);
        db().prepare('UPDATE workflows SET covered_created_by = NULL, covered_created_id = NULL, covered_created_at = NULL WHERE id = ?').run(id);
        return id;
      }],
    ];
    for (const [name, make] of cases) {
      it(`agree: ${name}`, async () => {
        const id = make();
        const lib = await ask('GET', '/api/workflows/library', ownerCookie);
        const card = (lib.json['workflows'] as Array<{ id: string; runs_as?: { ended: boolean } }>).find((w) => w.id === id);
        expect(card).toBeDefined();
        const p = await ask('GET', `/api/workflows/${id}/takeover-preview`, ownerCookie);
        const allowed = p.status === 200 && p.json['refusal'] === null;
        expect([name, card?.runs_as?.ended === true]).toEqual([name, allowed]);
      });
    }

    it('a definition that does not parse has no card, and the takeover refuses it as unreadable', async () => {
      const id = workflow('x6@example.invalid');
      end('x6@example.invalid');
      db().prepare("UPDATE workflows SET definition_json = '{broken' WHERE id = ?").run(id);
      try {
        // No card offers it. (The library's own read of such a row fails as a whole today; either way
        // there is no button that leads to the takeover.)
        const lib = await ask('GET', '/api/workflows/library', ownerCookie);
        const cards = lib.status === 200 ? lib.json['workflows'] as Array<{ id: string }> : [];
        expect(cards.some((w) => w.id === id)).toBe(false);
        const p = await ask('GET', `/api/workflows/${id}/takeover-preview`, ownerCookie);
        expect([p.status, p.json['refusal']]).toEqual([200, 'unreadable']);
        const r = await ask('POST', `/api/workflows/${id}/takeover`, ownerCookie, { expect: 'x' });
        expect([r.status, r.json['code']]).toEqual([409, 'unreadable']);
      } finally {
        db().prepare('DELETE FROM workflows WHERE id = ?').run(id);
      }
    });
  });
});
