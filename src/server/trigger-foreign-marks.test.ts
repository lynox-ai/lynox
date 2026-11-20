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
 * What a mandate learns of the schedules another mandate set up, through a real engine and the
 * real dispatcher: that a helper set them up, never which one, and none of the values they bind.
 * The owner reads every mark and value as stored. A mandate is also refused the grant preview of
 * a workflow it may not schedule, as the schedule itself is refused (`POST /api/tasks`).
 */

const SECRET = `t-${randomBytes(12).toString('hex')}`;
const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_DURABLE_MEMORY_ENABLED', 'LYNOX_FEATURE_WORKFLOW_REVIEWED_GRANT'];
type Inner = { engine: Engine; rateCounts: Map<string, unknown>; server: Server | null };
type Row = Record<string, unknown> & { id: string };

const IDA = 'mandate:ida@example.invalid';
const OLE = 'mandate:ole@example.invalid';
const saved: Record<string, string | undefined> = {};

describe('a mandate reads another mandate\'s schedules without its address, grant or values (real engine)', () => {
  let dir: string;
  let api: LynoxHTTPApi;
  let base: string;
  let ownerCookie: string;
  let mandateCookie: string;

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    // A mandate is let in only on the durable memory tools, as on the fleet.
    process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = 'true';
    process.env['LYNOX_FEATURE_WORKFLOW_REVIEWED_GRANT'] = 'true';
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    dir = mkdtempSync(join(tmpdir(), 'lynox-trigger-marks-'));
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as Inner).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('fixture: no port');
    base = `http://127.0.0.1:${String(addr.port)}`;
    const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
    const m = loginSession(SECRET, {
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-IDA',
      mandate_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })?.token;
    const o = loginSession(SECRET, null)?.token;
    if (m === undefined || o === undefined) throw new Error('fixture: no cookie');
    mandateCookie = m;
    ownerCookie = o;

    const engine = (api as unknown as Inner).engine;
    const history = engine.getRunHistory()!;
    const db = engine.getEngineDb()!.getDb();
    const save = (id: string, author: Parameters<typeof history.insertPlannedPipeline>[1]): void => {
      history.insertPlannedPipeline({
        id, name: id, goal: 'g', steps: [{ id: 's1', task: 't' }], reasoning: '', estimatedCost: 0,
        createdAt: '2026-01-01T00:00:00.000Z', template: true,
      }, author);
    };
    save('wf-owner', { kind: 'owner' });
    save('wf-ida', { kind: 'mandate', email: 'ida@example.invalid', mandateId: 'TEST-MANDATE-IDA' });
    save('wf-ole', { kind: 'mandate', email: 'ole@example.invalid', mandateId: 'TEST-MANDATE-OLE' });
    save('wf-unread', { kind: 'owner' });
    // The schedules name a saved workflow, so it is saved first.
    const schedule = (id: string, params: string, by: { createdBy?: string; createdMandateId?: string }): void => {
      history.insertTrigger({
        id, title: id, source: 'cron', effect: 'run_workflow', scheduleCron: '0 9 * * 1', nextRunAt: '2026-01-05T09:00:00.000Z',
        pipelineId: 'wf-owner', pipelineParams: params, ...by,
      });
    };
    schedule('t-owner', '{"region":"owner-value"}', { createdBy: 'owner' });
    schedule('t-ida', '{"region":"ida-value"}', { createdBy: IDA, createdMandateId: 'TEST-MANDATE-IDA' });
    schedule('t-ole', '{"region":"ole-value"}', { createdBy: OLE, createdMandateId: 'TEST-MANDATE-OLE' });
    // The owner's schedule, last changed by another mandate: its values are that mandate's choice.
    schedule('t-ole-edit', '{"region":"ole-edit-value"}', { createdBy: 'owner' });
    db.prepare('UPDATE triggers SET edited_by = ?, mandate_editor = ?, mandate_editor_id = ? WHERE id = ?').run(OLE, OLE, 'TEST-MANDATE-OLE', 't-ole-edit');
    // Changed by the owner since, so only the lasting editor mark names the other mandate.
    schedule('t-ole-lasting', '{"region":"ole-lasting-value"}', { createdBy: 'owner' });
    db.prepare("UPDATE triggers SET edited_by = 'owner', mandate_editor = ?, mandate_editor_id = ? WHERE id = ?").run(OLE, 'TEST-MANDATE-OLE', 't-ole-lasting');
    // Another mandate's schedule the owner took over: the marks it covered name that mandate,
    // the schedule is the owner's now and keeps its values.
    schedule('t-covered', '{"region":"covered-value"}', { createdBy: 'owner' });
    db.prepare('UPDATE triggers SET covered_created_by = ?, covered_created_id = ?, covered_edited_by = ?, covered_edited_id = ? WHERE id = ?')
      .run(OLE, 'TEST-MANDATE-OLE', OLE, 'TEST-MANDATE-OLE', 't-covered');
    // The mandate's own schedule, switched by another mandate since: its values stay its own.
    schedule('t-ida-touched', '{"region":"ida-touched-value"}', { createdBy: IDA, createdMandateId: 'TEST-MANDATE-IDA' });
    db.prepare('UPDATE triggers SET edited_by = ?, mandate_editor = ?, mandate_editor_id = ? WHERE id = ?').run(OLE, OLE, 'TEST-MANDATE-OLE', 't-ida-touched');
    // Another mandate's schedule the mandate switches off itself.
    schedule('t-ole-patch', '{"region":"ole-patch-value"}', { createdBy: OLE, createdMandateId: 'TEST-MANDATE-OLE' });

    const read = history.getWorkflowAuthorship.bind(history);
    history.getWorkflowAuthorship = (id: string) => {
      if (id === 'wf-unread') throw new Error('authorship read failed');
      return read(id);
    };
  }, 120_000);

  afterAll(async () => {
    await api?.shutdown();
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const get = async (path: string, headers: Record<string, string>): Promise<Response> => {
    (api as unknown as Inner).rateCounts.clear();
    return fetch(`${base}${path}`, { headers });
  };
  const triggers = async (headers: Record<string, string>): Promise<Map<string, Row>> => {
    const res = await get('/api/triggers', headers);
    expect(res.status).toBe(200);
    const body = await res.json() as { triggers: Row[] };
    return new Map(body.triggers.map((t) => [t.id, t]));
  };
  const asMandate = (): Record<string, string> => ({ cookie: `lynox_session=${mandateCookie}` });

  it('gives the owner every mark, grant id and value as stored, by cookie and by bearer', async () => {
    for (const headers of [{ cookie: `lynox_session=${ownerCookie}` }, { authorization: `Bearer ${SECRET}` }]) {
      const rows = await triggers(headers);
      expect(rows.get('t-ole')).toMatchObject({ created_by: OLE, created_mandate_id: 'TEST-MANDATE-OLE', pipeline_params: '{"region":"ole-value"}' });
      expect(rows.get('t-ole-edit')).toMatchObject({ edited_by: OLE, mandate_editor: OLE, mandate_editor_id: 'TEST-MANDATE-OLE', pipeline_params: '{"region":"ole-edit-value"}' });
      expect(rows.get('t-covered')).toMatchObject({ covered_created_by: OLE, covered_created_id: 'TEST-MANDATE-OLE', covered_edited_by: OLE, covered_edited_id: 'TEST-MANDATE-OLE' });
    }
  });

  it('tells a mandate that another mandate set a schedule up, not which one, and leaves out its grant id and values', async () => {
    const rows = await triggers(asMandate());
    const ole = rows.get('t-ole')!;
    expect(ole['created_by']).toBe('mandate:');
    expect(ole).not.toHaveProperty('created_mandate_id');
    expect(ole).not.toHaveProperty('pipeline_params');
    // The schedule itself stays listed: the list is the tenant's.
    expect(ole['pipeline_id']).toBe('wf-owner');
  });

  it('treats a schedule another mandate last changed as that mandate\'s, by either editor mark', async () => {
    const rows = await triggers(asMandate());
    const edit = rows.get('t-ole-edit')!;
    expect(edit).toMatchObject({ created_by: 'owner', edited_by: 'mandate:', mandate_editor: 'mandate:' });
    expect(edit).not.toHaveProperty('mandate_editor_id');
    expect(edit).not.toHaveProperty('pipeline_params');
    const lasting = rows.get('t-ole-lasting')!;
    expect(lasting).toMatchObject({ edited_by: 'owner', mandate_editor: 'mandate:' });
    expect(lasting).not.toHaveProperty('mandate_editor_id');
    expect(lasting).not.toHaveProperty('pipeline_params');
  });

  it('leaves a mandate its own marks and values, and the owner\'s', async () => {
    const rows = await triggers(asMandate());
    expect(rows.get('t-ida')).toMatchObject({ created_by: IDA, created_mandate_id: 'TEST-MANDATE-IDA', pipeline_params: '{"region":"ida-value"}' });
    expect(rows.get('t-owner')).toMatchObject({ created_by: 'owner', pipeline_params: '{"region":"owner-value"}' });
  });

  it('shows a mandate the marks a takeover covered without whose they were, and the owner\'s schedule with its values', async () => {
    const covered = (await triggers(asMandate())).get('t-covered')!;
    expect(covered).toMatchObject({ created_by: 'owner', covered_created_by: 'mandate:', covered_edited_by: 'mandate:', pipeline_params: '{"region":"covered-value"}' });
    expect(covered).not.toHaveProperty('covered_created_id');
    expect(covered).not.toHaveProperty('covered_edited_id');
  });

  it('leaves a mandate the values of its own schedule after another mandate changed it, without saying which one', async () => {
    const own = (await triggers(asMandate())).get('t-ida-touched')!;
    expect(own).toMatchObject({ created_by: IDA, created_mandate_id: 'TEST-MANDATE-IDA', edited_by: 'mandate:', mandate_editor: 'mandate:', pipeline_params: '{"region":"ida-touched-value"}' });
    expect(own).not.toHaveProperty('mandate_editor_id');
  });

  it('answers a mandate\'s change of another mandate\'s schedule with the row as its list shows it', async () => {
    (api as unknown as Inner).rateCounts.clear();
    const res = await fetch(`${base}/api/tasks/t-ole-patch`, {
      method: 'PATCH', headers: { ...asMandate(), 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const row = await res.json() as Row;
    expect(row).toMatchObject({ id: 't-ole-patch', created_by: 'mandate:' });
    expect(row).not.toHaveProperty('created_mandate_id');
    expect(row).not.toHaveProperty('pipeline_params');
    // Its own change is marked as its own, by name.
    expect(row['edited_by']).toBe(IDA);
  });

  it('puts no address, grant id or value of another mandate anywhere in a mandate\'s list', async () => {
    const text = await (await get('/api/triggers', asMandate())).text();
    for (const stored of ['ole@example.invalid', 'TEST-MANDATE-OLE', 'ole-value', 'ole-edit-value', 'ole-lasting-value', 'ole-patch-value']) expect(text).not.toContain(stored);
    // The positive control: the same list does carry the mandate's own.
    expect(text).toContain('ida-value');
  });

  it('refuses a mandate the grant preview of a workflow it may not schedule, as the schedule itself', async () => {
    const preview = async (id: string, headers: Record<string, string>): Promise<{ status: number; code?: string }> => {
      (api as unknown as Inner).rateCounts.clear();
      const res = await fetch(`${base}/api/workflows/${id}/grant-preview`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ scheduleCron: '0 9 * * 1', method: 'POST', host: 'api.partner.example', paths: ['/v1/x'], params: { region: 'de' } }),
      });
      const body = await res.json() as { code?: string };
      return { status: res.status, ...(body.code !== undefined ? { code: body.code } : {}) };
    };
    const schedule = async (id: string): Promise<{ status: number; code?: string }> => {
      (api as unknown as Inner).rateCounts.clear();
      const res = await fetch(`${base}/api/tasks`, {
        method: 'POST', headers: { ...asMandate(), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'probe', pipelineId: id, scheduleCron: '0 9 * * 1', params: { region: 'de' } }),
      });
      const body = await res.json() as { code?: string };
      return { status: res.status, ...(body.code !== undefined ? { code: body.code } : {}) };
    };
    for (const [id, code] of [['wf-ole', 'foreign_workflow'], ['wf-unread', 'unreadable_workflow']] as const) {
      const refused = await preview(id, asMandate());
      expect(refused).toEqual({ status: 403, code });
      // The same answer the schedule itself gives the same mandate.
      expect(await schedule(id)).toEqual(refused);
    }
    // Its own workflow, the owner's, and the owner on another mandate's pass the refusal (what
    // follows answers the grant itself, which these workflows do not need).
    for (const [id, headers] of [['wf-ida', asMandate()], ['wf-owner', asMandate()], ['wf-ole', { authorization: `Bearer ${SECRET}` }]] as const) {
      const r = await preview(id, headers);
      expect(r.code).not.toBe('foreign_workflow');
      expect(r.code).not.toBe('unreadable_workflow');
      expect(r.status).not.toBe(403);
    }
  });
});
