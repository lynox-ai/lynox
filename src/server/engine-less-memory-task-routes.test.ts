import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { engineLessStoreText } from '../core/engine-less-refusal.js';

/**
 * A REAL boot without engine.db (a directory where the file belongs, as in
 * `engine-less-profile-writes.test.ts`). The memory routes and the to-do routes refuse a change
 * with 409, the code `engine_less` and the client's sentence, and nothing changes. A first boot
 * with engine.db writes the fact and the to-do the refused requests aim at, through the same
 * routes, so the refusals are not the routes' default.
 */

const SECRET = 'engine-less-memory-task-test-secret';
const MEMORY = { error: engineLessStoreText('memory', 'client'), code: 'engine_less' };
const TASK = { error: engineLessStoreText('task', 'client'), code: 'engine_less' };
const FACT = 'The warehouse moved to Thun in October.';

let booted: LynoxHTTPApi | null = null;
const dirs: string[] = [];

afterEach(async () => {
  if (booted !== null) { const api = booted; booted = null; await api.shutdown(); }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  vi.unstubAllEnvs();
  reloadConfig();
});

async function boot(dir: string, durable: boolean): Promise<string> {
  vi.stubEnv('LYNOX_DATA_DIR', dir);
  vi.stubEnv('LYNOX_HTTP_SECRET', SECRET);
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  vi.stubEnv('ORIGIN', 'http://127.0.0.1');
  vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', '');
  vi.stubEnv('LYNOX_DURABLE_MEMORY_ENABLED', durable ? 'true' : 'false');
  reloadConfig();
  const api = new LynoxHTTPApi();
  booted = api;
  await api.init();
  await api.start(0);
  const port = api.boundPort;
  if (port === undefined) throw new Error('server is not bound after start()');
  return `http://127.0.0.1:${String(port)}`;
}

async function stop(): Promise<void> {
  if (booted !== null) { const api = booted; booted = null; await api.shutdown(); }
}

async function ownerCookie(): Promise<string> {
  const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
  const owner = loginSession(SECRET, null)?.token;
  if (owner === undefined) throw new Error('fixture: no cookie');
  return `lynox_session=${owner}`;
}

function json(cookie: string, method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/**
 * A first boot with engine.db and durable memory on that writes the fact and one to-do, then
 * engine.db made unopenable.
 */
async function seededThenBroken(): Promise<{ dir: string; taskId: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-less-routes-'));
  dirs.push(dir);
  // Durable memory on, as on the boot that refuses below: with engine.db its routes write.
  const base = await boot(dir, true);
  const cookie = await ownerCookie();
  const health = (await (await fetch(`${base}/api/health`)).json()) as { engine?: { durable_memory?: string } };
  expect(health.engine?.durable_memory, 'the seeding boot has its durable memory').toBe('on');
  expect((await fetch(`${base}/api/memory/knowledge/append`, json(cookie, 'POST', { text: FACT }))).status).toBe(200);
  const created = await fetch(`${base}/api/tasks`, json(cookie, 'POST', { title: 'Order new shelves' }));
  expect(created.status).toBe(201);
  const taskId = ((await created.json()) as { id: string }).id;
  await stop();
  renameSync(join(dir, 'engine.db'), join(dir, 'engine.db.aside'));
  mkdirSync(join(dir, 'engine.db'));
  return { dir, taskId };
}

// Each test boots a real engine twice, which takes seconds under a loaded box.
describe('an engine without engine.db refuses a change to memory or a to-do over HTTP', { timeout: 120_000 }, () => {
  it('refuses every memory change with the reason; reading stays, and the memory is as it was', async () => {
    const { dir } = await seededThenBroken();
    const base = await boot(dir, true);
    const cookie = await ownerCookie();
    const read = async (): Promise<unknown> => (await fetch(`${base}/api/memory/knowledge`, { headers: { cookie } })).json();
    const before = await read();
    expect(JSON.stringify(before)).toContain(FACT);

    for (const [method, path, body] of [
      ['PUT', '/api/memory/knowledge', { content: 'The office closes on Fridays.' }],
      ['POST', '/api/memory/knowledge/append', { text: 'The office closes on Fridays.' }],
      ['PATCH', '/api/memory/knowledge', { old_content: FACT, new_content: 'The warehouse moved to Bern.' }],
      ['DELETE', '/api/memory/knowledge?pattern=warehouse', undefined],
    ] as const) {
      const res = await fetch(`${base}${path}`, json(cookie, method, body));
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(await res.json(), `${method} ${path}`).toEqual(MEMORY);
    }
    expect(await read()).toEqual(before);
  });

  it('refuses adding, changing, completing and deleting a to-do with the reason; the list is as it was', async () => {
    const { dir, taskId } = await seededThenBroken();
    const base = await boot(dir, true);
    const cookie = await ownerCookie();
    const list = async (): Promise<unknown> => (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    const before = await list();
    expect(JSON.stringify(before)).toContain('Order new shelves');

    for (const [method, path, body] of [
      ['POST', '/api/tasks', { title: 'Call the landlord' }],
      ['PATCH', `/api/tasks/${taskId}`, { title: 'Order two shelves' }],
      ['POST', `/api/tasks/${taskId}/complete`, undefined],
      ['DELETE', `/api/tasks/${taskId}`, undefined],
    ] as const) {
      const res = await fetch(`${base}${path}`, json(cookie, method, body));
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(await res.json(), `${method} ${path}`).toEqual(TASK);
    }
    expect(await list()).toEqual(before);
  });

  it('leaves a trigger to its own refusal: one with a run time is not answered as a to-do', async () => {
    const { dir } = await seededThenBroken();
    const base = await boot(dir, true);
    const cookie = await ownerCookie();
    const res = await fetch(`${base}/api/tasks`, json(cookie, 'POST', { title: 'Send the report', runAt: '2099-01-01T08:00:00Z' }));
    // A trigger's store is engine.db, which refuses it with its own error, and nothing is added.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBeUndefined();
    expect(body.error).toMatch(/trigger writes require engine\.db/);
    const list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).text();
    expect(list).not.toContain('Send the report');
  });
});
