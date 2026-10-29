import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import Database from 'better-sqlite3';
import { EngineDb } from '../core/engine-db.js';
import type { Engine } from '../core/engine.js';
import { reloadConfig } from '../core/config.js';

/**
 * A keyless boot over stores that already hold encrypted values: a REAL boot of a data dir whose
 * engine.db was written under a key that is now gone (`vault.db` present, no `vault.key`, no env key,
 * no `~/.lynox/.env`), so `ensureVaultKey` neither loads nor mints one.
 *
 * What is measured: the check runs after listen and reports through three channels — `degraded` on
 * the unauthenticated health route (one word, nothing else), the owner's status field on the two
 * authenticated routes, and nothing for a mandate (200, no field). Nothing is written differently.
 */

const SECRET = 'vault-keyless-test-secret-value';

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

/** A data dir in the state, or (with `ciphertext: false`) the same dir whose stores hold only plaintext. */
function dataDir(ciphertext: boolean, dropTable?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-keyless-boot-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const data = join(dir, 'data');
  mkdirSync(data);
  const db = new EngineDb(join(data, 'engine.db'), randomBytes(48).toString('base64'));
  const value = ciphertext ? db.enc('a playbook written under the old key') : 'a plaintext playbook';
  db.getDb().prepare(`INSERT OR REPLACE INTO memory_blocks (id, content, char_limit) VALUES ('playbook', ?, 1000)`).run(value);
  if (dropTable !== undefined) db.getDb().exec(`DROP TABLE ${dropTable}`);
  db.close();
  // vault.db present, vault.key absent: the key is lost, and the boot must not mint a new one.
  writeFileSync(join(data, 'vault.db'), '');
  return dir;
}

async function boot(dir: string, key?: string): Promise<{ base: string; api: LynoxHTTPApi }> {
  vi.stubEnv('HOME', join(dir, 'home'));
  vi.stubEnv('LYNOX_DATA_DIR', join(dir, 'data'));
  vi.stubEnv('LYNOX_HTTP_SECRET', SECRET);
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  vi.stubEnv('LYNOX_VAULT_KEY', key);
  vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', undefined);
  vi.stubEnv('LYNOX_BILLING_TIER', undefined);
  vi.stubEnv('LYNOX_MANAGED_MODE', undefined);
  reloadConfig();
  const api = new LynoxHTTPApi();
  booted = { api, dir };
  await api.init();
  await api.start(0);
  const port = api.boundPort;
  if (port === undefined) throw new Error('server is not bound after start()');
  return { base: `http://127.0.0.1:${String(port)}`, api };
}

async function cookies(): Promise<{ owner: string; mandate: string }> {
  const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
  const mandate = loginSession(SECRET, {
    kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-KEYLESS',
    mandate_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  })?.token;
  const owner = loginSession(SECRET, null)?.token;
  if (mandate === undefined || owner === undefined) throw new Error('fixture: no cookie');
  return { owner, mandate };
}

const getJson = async (url: string, cookie?: string): Promise<{ status: number; body: Record<string, unknown>; text: string }> => {
  const res = await fetch(url, cookie === undefined ? {} : { headers: { cookie: `lynox_session=${cookie}` } });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
};

/** The check runs after listen without being awaited; wait until the health route reflects it. */
async function settled(base: string, want: 'ok' | 'degraded'): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const r = await getJson(`${base}/api/health`);
    if (r.body['status'] === want) return r.body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`health never said ${want}`);
}

describe('a keyless boot over encrypted data', () => {
  it('sets degraded on both health routes, one word, with HTTP 200', async () => {
    const { base } = await boot(dataDir(true));
    await settled(base, 'degraded');
    for (const path of ['/health', '/api/health']) {
      const r = await getJson(`${base}${path}`);
      expect(r.status).toBe(200);
      expect(r.body['status']).toBe('degraded');
      expect(r.text).not.toMatch(/vault|engine\.db|history|encrypt|keyless/i);
    }
  }, 60_000);

  it('shows the owner the field on the polled route and on the vault route', async () => {
    const { base } = await boot(dataDir(true));
    await settled(base, 'degraded');
    const { owner } = await cookies();
    const providers = await getJson(`${base}/api/providers/status`, owner);
    expect(providers.status).toBe(200);
    expect(providers.body).toMatchObject({ vault_key: 'missing_over_encrypted_data', vault_key_stores: ['engine.db'] });
    expect(Array.isArray(providers.body['providers'])).toBe(true);
    const vault = await getJson(`${base}/api/vault/key`, owner);
    expect(vault.status).toBe(200);
    expect(vault.body).toMatchObject({ configured: false, vault_key: 'missing_over_encrypted_data', vault_key_stores: ['engine.db'] });
  }, 60_000);

  it('gives a mandate 200 on both routes, without the field', async () => {
    const { base } = await boot(dataDir(true));
    await settled(base, 'degraded');
    const { mandate } = await cookies();
    const providers = await getJson(`${base}/api/providers/status`, mandate);
    expect(providers.status).toBe(200);
    expect(Array.isArray(providers.body['providers'])).toBe(true);
    expect(providers.text).not.toContain('vault_key');
    const vault = await getJson(`${base}/api/vault/key`, mandate);
    expect(vault.status).toBe(200);
    expect(vault.body).toEqual({ configured: false });
  }, 60_000);

  it('says ok, and shows no field, when the stores hold no encrypted value', async () => {
    const { base } = await boot(dataDir(false));
    // Give the check the time it takes in the positive case before reading the absence.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const health = await getJson(`${base}/api/health`);
    expect(health.body['status']).toBe('ok');
    const { owner } = await cookies();
    expect((await getJson(`${base}/api/providers/status`, owner)).text).not.toContain('vault_key');
  }, 60_000);

  it('runs no check, and says ok, when a key is set', async () => {
    const { base } = await boot(dataDir(true), randomBytes(48).toString('base64'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await getJson(`${base}/api/health`)).body['status']).toBe('ok');
    const { owner } = await cookies();
    expect((await getJson(`${base}/api/providers/status`, owner)).text).not.toContain('vault_key');
  }, 60_000);

  it('shows the owner "could not be checked", and leaves health ok, when the check cannot read a store', async () => {
    // No ciphertext found, and a registered table the check cannot read: the state may hold and was not checked.
    const { base } = await boot(dataDir(false, 'inbound_events'));
    const { owner } = await cookies();
    let body: Record<string, unknown> = {};
    for (let i = 0; i < 100 && body['vault_key'] === undefined; i++) {
      body = (await getJson(`${base}/api/providers/status`, owner)).body;
      if (body['vault_key'] === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(body['vault_key']).toBe('unknown');
    expect(body['vault_key_stores']).toBeUndefined();
    expect((await getJson(`${base}/api/health`)).body['status']).toBe('ok');
  }, 60_000);

  it('writes what a keyless boot wrote before: plaintext through the writer, the old ciphertext untouched', async () => {
    const dir = dataDir(true);
    const dbPath = join(dir, 'data', 'engine.db');
    const before = new Database(dbPath, { readonly: true });
    const old = before.prepare(`SELECT content FROM memory_blocks WHERE id = 'playbook'`).get() as { content: string };
    before.close();
    const { base, api } = await boot(dir);
    await settled(base, 'degraded');
    const engine = (api as unknown as { engine: Engine | null }).engine;
    const engineDb = engine?.getEngineDb() ?? null;
    if (engineDb === null) throw new Error('fixture: no engine.db after boot');
    // Every writer of an encrypted column goes through `enc`; without a key it returns its input.
    engineDb.getDb().prepare(`INSERT INTO memory_blocks (id, content, char_limit) VALUES ('profile', ?, 1000)`)
      .run(engineDb.enc('written after the keyless boot'));
    const after = new Database(dbPath, { readonly: true });
    const rows = after.prepare(`SELECT id, content FROM memory_blocks ORDER BY id`).all() as { id: string; content: string }[];
    after.close();
    expect(rows).toEqual([
      { id: 'playbook', content: old.content },
      { id: 'profile', content: 'written after the keyless boot' },
    ]);
    expect(old.content.startsWith('enc:')).toBe(true);
  }, 60_000);

  it('mints no key and writes no key file', async () => {
    const dir = dataDir(true);
    const { base } = await boot(dir);
    await settled(base, 'degraded');
    expect(process.env['LYNOX_VAULT_KEY']).toBeUndefined();
    expect(readdirSync(join(dir, 'data'))).not.toContain('vault.key');
  }, 60_000);
});
