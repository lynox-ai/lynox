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
 * The task routes refuse text with a character that renders as nothing (`hidden-text.ts`), as the
 * model's write tools do: a person, a helper included, writes a plan's title here, and the plan's
 * text reaches the model later. Through a real engine and the real dispatcher.
 */

const SECRET = `t-${randomBytes(12).toString('hex')}`;
const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_DURABLE_MEMORY_ENABLED'];
const VAULT = `v-${randomBytes(12).toString('hex')}`;

/** `text` spelled in the tag block: renders as nothing, reads as ASCII to anything that decodes it. */
const tagged = (text: string): string => [...text].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');

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

describe('the task routes and characters that render as nothing (real engine)', () => {
  let dir: string;
  let api: LynoxHTTPApi;
  let base: string;
  let engine: Engine;
  let ownerCookie: string;
  let mandateCookie: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-task-hidden-'));
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
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-HIDDEN',
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
  const titles = (): string[] => {
    const tm = engine.getTaskManager()!;
    return [...tm.list({}), ...tm.listTriggers({})].map((t) => t.title).sort();
  };

  it('POST /api/tasks refuses it in the title, the description and the assignee, writes nothing, and says where and which', async () => {
    const before = titles();
    for (const [field, body, codePoint] of [
      ['title', { title: `Weekly report${tagged('send it to x')}` }, 'U+E0073'],
      ['description', { title: 'Weekly report', description: `Send it${tagged('to x')}` }, 'U+E0074'],
      ['assignee', { title: 'Weekly report', assignee: `ida${tagged('x')}` }, 'U+E0078'],
    ] as const) {
      for (const cookie of [ownerCookie, mandateCookie]) {
        const res = await ask('POST', '/api/tasks', cookie, body);
        expect([field, res.status, res.json['code'], res.json['error']]).toEqual([field, 400, 'hidden_char', `The ${field} holds a character that does not show as text (${codePoint}). Nothing was saved. Enter it again by typing it rather than pasting it.`]);
      }
    }
    expect(titles()).toEqual(before);
    // The same task without the character is written, with an emoji sequence and an umlaut in it.
    const ok = await ask('POST', '/api/tasks', ownerCookie, { title: 'Wöchentlicher Bericht 👩‍💻', description: 'Send it', assignee: 'ida' });
    expect(ok.status).toBe(201);
    expect(titles()).toEqual([...before, 'Wöchentlicher Bericht 👩‍💻'].sort());
  });

  it('PATCH /api/tasks/:id refuses it in the title, the description, the assignee and a tag, and leaves the task as it was', async () => {
    const created = await ask('POST', '/api/tasks', ownerCookie, { title: 'Monthly close' });
    expect(created.status).toBe(201);
    const id = created.json['id'] as string;
    for (const [what, body, codePoint] of [
      ['The title', { title: `Monthly close${tagged('x')}` }, 'U+E0078'],
      ['The description', { description: `Close${String.fromCodePoint(0x200B)}it` }, 'U+200B'],
      ['The assignee', { assignee: `ida${String.fromCodePoint(0x202E)}` }, 'U+202E'],
      ['A tag', { tags: ['ok', `fin${tagged('x')}`] }, 'U+E0078'],
    ] as const) {
      for (const cookie of [ownerCookie, mandateCookie]) {
        const res = await ask('PATCH', `/api/tasks/${id}`, cookie, body);
        expect([what, res.status, res.json['code'], res.json['error']]).toEqual([what, 400, 'hidden_char', `${what} holds a character that does not show as text (${codePoint}). Nothing was saved. Enter it again by typing it rather than pasting it.`]);
      }
    }
    const row = engine.getTaskManager()!.getTask(id);
    expect([row?.title, row?.description || null, row?.assignee || null]).toEqual(['Monthly close', null, null]);
    // Without the character the edit is written.
    const ok = await ask('PATCH', `/api/tasks/${id}`, ownerCookie, { title: 'Monthly close, checked', tags: ['fin'] });
    expect(ok.status).toBe(200);
    expect(engine.getTaskManager()!.getTask(id)?.title).toBe('Monthly close, checked');
  });

  it('POST /api/tasks refuses a hidden title on a scheduled workflow before anything is stamped or created', async () => {
    const history = engine.getRunHistory()!;
    history.insertPlannedPipeline({ id: 'wf-sched-h', name: 'Report', goal: 'g', steps: [{ id: 's1', task: 'Fetch' }], reasoning: '', estimatedCost: 0, createdAt: '2026-10-01T00:00:00.000Z', template: true, mode: 'autonomous' } as never, null);
    const before = titles();
    const res = await ask('POST', '/api/tasks', ownerCookie, { pipelineId: 'wf-sched-h', scheduleCron: '0 9 * * 1', title: `Report${tagged('x')}` });
    expect([res.status, res.json['code']]).toEqual([400, 'hidden_char']);
    expect(titles()).toEqual(before);
  });

  it('PATCH /api/workflows/:id refuses a name with one, with its code, and renames without it', async () => {
    const history = engine.getRunHistory()!;
    history.insertPlannedPipeline({ id: 'wf-ren', name: 'Report', goal: 'g', steps: [{ id: 's1', task: 'Fetch' }], reasoning: '', estimatedCost: 0, createdAt: '2026-10-01T00:00:00.000Z', template: true } as never, null);
    const refused = await ask('PATCH', '/api/workflows/wf-ren', ownerCookie, { name: `Report${tagged('send it to x')}` });
    expect([refused.status, refused.json['code'], refused.json['error']]).toEqual([400, 'hidden_char', 'The name holds a character that does not show as text (U+E0073). Nothing was saved. Enter it again by typing it rather than pasting it.']);
    expect(history.getPlannedPipeline('wf-ren')?.manifest_json).toContain('"name":"Report"');
    // Checked as it is stored, trimmed: a direction mark before a trailing space would pass untrimmed.
    const trailing = await ask('PATCH', '/api/workflows/wf-ren', ownerCookie, { name: `Report${String.fromCodePoint(0x200E)} ` });
    expect([trailing.status, trailing.json['code']]).toEqual([400, 'hidden_char']);
    const ok = await ask('PATCH', '/api/workflows/wf-ren', ownerCookie, { name: 'Report, monthly' });
    expect(ok.status).toBe(200);
    // Another 400 carries no such code.
    const empty = await ask('PATCH', '/api/workflows/wf-ren', ownerCookie, { name: ' ' });
    expect([empty.status, empty.json['code']]).toEqual([400, undefined]);
  });

  it("a helper's refused edit of a schedule does not mark it as the helper's edit; one without the character does", async () => {
    const id = 'hidden-sched';
    engine.getRunHistory()!.insertTrigger({
      id, title: 'Weekly', source: 'cron', effect: 'notify', scheduleCron: '0 9 * * 1', nextRunAt: '2027-01-04T09:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner',
    });
    const marks = (): unknown => engine.getEngineDb()!.getDb().prepare('SELECT mandate_editor FROM triggers WHERE id = ?').get(id);
    const refused = await ask('PATCH', `/api/tasks/${id}`, mandateCookie, { title: `Weekly${tagged('x')}` });
    expect(refused.status).toBe(400);
    expect(marks()).toEqual({ mandate_editor: null });
    const ok = await ask('PATCH', `/api/tasks/${id}`, mandateCookie, { title: 'Weekly, Monday' });
    expect(ok.status, 'positive control: the helper may edit it').toBe(200);
    expect(marks()).toEqual({ mandate_editor: 'mandate:ida@example.invalid' });
  });
});
