import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';

/**
 * The owner's status field after a boot in which engine.db or history.db could not be opened.
 *
 * `/api/health` says only `degraded` (it answers without auth), and the owner reads neither it nor
 * the container log. The status bar polls `/api/providers/status` on every page; the field rides it,
 * for the owner only, and names the store, so the UI can say what is missing.
 *
 * A REAL boot (as in `health-degraded-boot.test.ts`): a directory where the database file belongs,
 * which SQLite cannot open, so the test covers the wiring from the boot's `catch` to the field.
 */

const SECRET = 'boot-store-field-test-secret-value';

let booted: { api: LynoxHTTPApi; dir: string } | null = null;

afterEach(async () => {
  if (booted !== null) {
    const { api, dir } = booted;
    booted = null;
    await api.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  reloadConfig();
});

async function boot(broken: ReadonlyArray<'engine.db' | 'history.db'>, managedId?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-boot-store-field-'));
  for (const name of broken) mkdirSync(join(dir, name));
  vi.stubEnv('LYNOX_DATA_DIR', dir);
  vi.stubEnv('LYNOX_HTTP_SECRET', SECRET);
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', managedId);
  // A mandate is refused before any handler while durable knowledge is off.
  vi.stubEnv('LYNOX_DURABLE_MEMORY_ENABLED', 'true');
  reloadConfig();
  const api = new LynoxHTTPApi();
  booted = { api, dir };
  await api.init();
  await api.start(0);
  const port = api.boundPort;
  if (port === undefined) throw new Error('server is not bound after start()');
  return `http://127.0.0.1:${String(port)}`;
}

async function cookies(): Promise<{ owner: string; mandate: string }> {
  const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
  const mandate = loginSession(SECRET, {
    kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-BOOT-STORE',
    mandate_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  })?.token;
  const owner = loginSession(SECRET, null)?.token;
  if (mandate === undefined || owner === undefined) throw new Error('fixture: no cookie');
  return { owner, mandate };
}

const providers = async (base: string, cookie: string): Promise<{ status: number; body: Record<string, unknown>; text: string }> => {
  const res = await fetch(`${base}/api/providers/status`, { headers: { cookie: `lynox_session=${cookie}` } });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
};

describe('the owner sees which boot store did not open', () => {
  it.each([
    [['engine.db'] as const],
    [['history.db'] as const],
    [['engine.db', 'history.db'] as const],
  ])('names %j to the owner on the polled route', async (broken) => {
    const base = await boot(broken);
    const { owner } = await cookies();
    const r = await providers(base, owner);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body['providers'])).toBe(true);
    expect(r.body['boot_stores_missing']).toEqual([...broken]);
    expect(r.text).not.toContain('boot_stores_alerted');
  }, 60_000);

  it('says the control plane is alerted on an instance it runs', async () => {
    const base = await boot(['history.db'], 'inst-boot-store-test');
    const { owner } = await cookies();
    const r = await providers(base, owner);
    expect(r.body).toMatchObject({ boot_stores_missing: ['history.db'], boot_stores_alerted: true });
  }, 60_000);

  // history.db, not engine.db: without engine.db durable knowledge does not load, and a mandate is
  // then refused before any handler (403), so it never reaches the route at all.
  it('gives a mandate 200 without the field', async () => {
    const base = await boot(['history.db']);
    const { mandate } = await cookies();
    const r = await providers(base, mandate);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('boot_stores_missing');
    expect(r.text).not.toContain('history.db');
  }, 60_000);

  it('shows the owner no field when both stores opened', async () => {
    const base = await boot([]);
    const { owner } = await cookies();
    const r = await providers(base, owner);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('boot_stores_missing');
  }, 60_000);
});
