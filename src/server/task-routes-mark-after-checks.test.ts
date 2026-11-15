import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { Engine } from '../core/engine.js';

/**
 * A helper's change of a schedule through the task routes takes the owner's stamp off it
 * (`markEditedBy`), and only a change the task manager goes on to write does: a change it refuses
 * (an invalid schedule, fields a schedule does not carry) leaves the stamp and names no editor.
 * Through a real engine and the real dispatcher.
 */

const SECRET = `t-${randomBytes(12).toString('hex')}`;
const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_DURABLE_MEMORY_ENABLED'];
const VAULT = `v-${randomBytes(12).toString('hex')}`;

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

describe('the task routes mark a helper\'s change of a schedule only once it passed the checks (real engine)', () => {
  let dir: string;
  let api: LynoxHTTPApi;
  let base: string;
  let engine: Engine;
  let ownerCookie: string;
  let mandateCookie: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-task-mark-'));
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
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-MARK',
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

  const ask = async (method: string, path: string, cookie: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    (api as unknown as Inner).rateCounts.clear();
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { cookie: `lynox_session=${cookie}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text === '' ? {} : JSON.parse(text) as Record<string, unknown> };
  };
  const STAMP = '2026-01-01T00:00:00.000Z';
  const seed = (id: string): void => {
    engine.getRunHistory()!.insertTrigger({
      id, title: 'Weekly', source: 'cron', effect: 'notify', scheduleCron: '0 9 * * 1', nextRunAt: '2027-01-04T09:00:00.000Z',
      confirmedAt: STAMP, confirmedBy: 'owner',
    });
  };
  const row = (id: string): unknown => engine.getEngineDb()!.getDb()
    .prepare('SELECT edited_by, mandate_editor, confirmed_at FROM triggers WHERE id = ?').get(id);
  const untouched = { edited_by: null, mandate_editor: null, confirmed_at: STAMP };
  const marked = { edited_by: 'mandate:ida@example.invalid', mandate_editor: 'mandate:ida@example.invalid', confirmed_at: null };

  it('PATCH with an invalid schedule is refused and leaves the stamp; a valid one marks it', async () => {
    seed('mark-cron');
    const refused = await ask('PATCH', '/api/tasks/mark-cron', mandateCookie, { scheduleCron: 'every now and then' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(row('mark-cron')).toEqual(untouched);
    const ok = await ask('PATCH', '/api/tasks/mark-cron', mandateCookie, { scheduleCron: '0 10 * * 1' });
    expect(ok.status, 'positive control: the helper may change it').toBe(200);
    expect(row('mark-cron')).toEqual(marked);
  });

  it('PATCH of only fields a schedule does not carry answers 400 with what it lacks, and marks nothing', async () => {
    seed('mark-prio');
    const refused = await ask('PATCH', '/api/tasks/mark-prio', mandateCookie, { priority: 'high', dueDate: '2027-01-01' });
    expect([refused.status, refused.json['error']]).toEqual([400, 'This is a scheduled plan, not a to-do: it has no priority, due date. Nothing was changed.']);
    expect(row('mark-prio')).toEqual(untouched);
    const owner = await ask('PATCH', '/api/tasks/mark-prio', ownerCookie, { priority: 'high' });
    expect([owner.status, owner.json['error']], 'the owner reads the same, not "Task not found"').toEqual([400, 'This is a scheduled plan, not a to-do: it has no priority. Nothing was changed.']);
  });

  it('a helper\'s completion and its switch still mark the schedule', async () => {
    seed('mark-done');
    const done = await ask('POST', '/api/tasks/mark-done/complete', mandateCookie, {});
    expect(done.status).toBe(200);
    expect(row('mark-done')).toEqual(marked);
    seed('mark-off');
    const off = await ask('PATCH', '/api/tasks/mark-off', mandateCookie, { enabled: false });
    expect(off.status).toBe(200);
    expect(row('mark-off')).toEqual(marked);
  });

  it('control: the owner\'s valid change keeps the stamp and names no editor', async () => {
    seed('mark-owner');
    const ok = await ask('PATCH', '/api/tasks/mark-owner', ownerCookie, { scheduleCron: '0 10 * * 1' });
    expect(ok.status).toBe(200);
    expect(row('mark-owner')).toEqual(untouched);
  });
});
