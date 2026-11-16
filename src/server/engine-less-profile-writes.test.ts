import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { signProfileOAuthState } from '../core/oauth-state-cookie.js';

/**
 * A REAL boot without engine.db (as in `boot-store-owner-field.test.ts`: a directory where the file
 * belongs, which SQLite cannot open). Such an engine reads its API profiles from the flat files in
 * `apis/`, which the next boot with engine.db does not read. The settings page's delete, the OAuth
 * start and the OAuth callback refuse with the plain reason before anything is written
 * or sent; the boot's own wiring sets that, which a unit test of the store cannot see.
 */

const SECRET = 'engine-less-profile-test-secret-value';
const REMOVE = "This engine is running without engine.db, which it could not open when it was started, so lynox does not remove API connections now: a removed connection would come back once the engine opens engine.db again. Nothing was removed, and nothing is removed later on its own; once someone has restarted the engine, the connection has to be removed again. This does not end on its own: it lasts until someone restarts the engine and the engine can open all its files again; the log the engine writes at start says why it could not.";
// The OAuth pages a person reads, in English (the default page language): their own text, then the
// status bar's closing paragraph for the mode, then the one way back into lynox.
const CONNECT_PAGE = '<p>lynox is not connecting accounts right now: the engine started without engine.db, and a new connection would be lost once it opens engine.db again. Nothing was sent to the provider. Connect the account again once the engine has restarted.</p>';
const SAVE_PAGE = '<p>lynox did not save this connection: the engine started without engine.db, and the change would be lost once it opens engine.db again. Add or change the connection again once the engine has restarted.</p>';
const SELFHOST_CLOSE = '<p>This lasts until the engine restarts and can open all its files again. The log the engine writes at startup names the cause; fix it and restart the engine.</p>';
const HELPER_CLOSE = '<p>This lasts until the engine restarts and can open all its files again. Let the owner of this instance know.</p>';
const MANAGED_CLOSE = '<p>This lasts until the engine restarts and can open all its files again. The lynox team gets an automatic alert about it.</p>';
const BACK_TO_APP = '<a class="go" href="/app">';

const PROFILE = {
  id: 'books-api',
  name: 'Books API',
  base_url: 'https://books.example.com/api',
  description: 'An OAuth test API.',
  auth: {
    type: 'oauth2',
    oauth: {
      authorize_url: 'https://books.example.com/oauth/authorize',
      token_url: 'https://books.example.com/oauth/token',
      client_id_key: 'BOOKS_CLIENT_ID',
      client_secret_key: 'BOOKS_CLIENT_SECRET',
    },
  },
};

let booted: { api: LynoxHTTPApi; dir: string } | null = null;

afterEach(async () => {
  if (booted !== null) {
    const { api, dir } = booted;
    booted = null;
    await api.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  reloadConfig();
});

async function boot(engineDbBroken: boolean): Promise<{ base: string; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-less-profile-'));
  if (engineDbBroken) mkdirSync(join(dir, 'engine.db'));
  mkdirSync(join(dir, 'apis'));
  const file = join(dir, 'apis', 'books-api.json');
  writeFileSync(file, JSON.stringify(PROFILE, null, 2));
  vi.stubEnv('LYNOX_DATA_DIR', dir);
  vi.stubEnv('LYNOX_HTTP_SECRET', SECRET);
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  vi.stubEnv('ORIGIN', 'http://127.0.0.1');
  // Self-host unless a test says otherwise: the managed test stubs the id after this.
  if (process.env['LYNOX_MANAGED_INSTANCE_ID'] === undefined) vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', '');
  reloadConfig();
  const api = new LynoxHTTPApi();
  booted = { api, dir };
  await api.init();
  await api.start(0);
  const port = api.boundPort;
  if (port === undefined) throw new Error('server is not bound after start()');
  return { base: `http://127.0.0.1:${String(port)}`, file };
}

async function ownerCookie(): Promise<string> {
  const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
  const owner = loginSession(SECRET, null)?.token;
  if (owner === undefined) throw new Error('fixture: no cookie');
  return `lynox_session=${owner}`;
}

/** Every request the engine sends outward to the provider's host while `run` runs. */
async function providerCalls(run: () => Promise<void>): Promise<string[]> {
  const real = globalThis.fetch;
  const seen: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('books.example.com')) seen.push(url);
    return real(input, init);
  });
  await run();
  return seen;
}

// Each test boots a real engine, which takes seconds under a loaded box.
describe('an engine without engine.db refuses a change to an API profile', { timeout: 60_000 }, () => {
  it('refuses the settings delete with the reason; the file and the profile stay', async () => {
    const { base, file } = await boot(true);
    const cookie = await ownerCookie();
    const before = readFileSync(file, 'utf8');
    const res = await fetch(`${base}/api/api-profiles/books-api`, { method: 'DELETE', headers: { cookie } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: REMOVE, code: 'engine_less' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    const list = await fetch(`${base}/api/api-profiles`, { headers: { cookie } });
    expect(await list.text()).toContain('books-api');
  });

  it('answers a delete of an id it does not have the same way', async () => {
    const { base } = await boot(true);
    const res = await fetch(`${base}/api/api-profiles/no-such-api`, { method: 'DELETE', headers: { cookie: await ownerCookie() } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: REMOVE, code: 'engine_less' });
  });

  it('refuses the OAuth start with the reason, and sends nobody to the provider', async () => {
    const { base, file } = await boot(true);
    const cookie = await ownerCookie();
    const before = readFileSync(file, 'utf8');
    let res: Response | undefined;
    const calls = await providerCalls(async () => {
      res = await fetch(`${base}/api/oauth/connect/books-api`, { headers: { cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' }, redirect: 'manual' });
    });
    expect(res!.status).toBe(409);
    expect(res!.headers.get('location')).toBeNull();
    // A start that goes to the provider sets the state cookie its callback reads; this one sets none.
    expect(res!.headers.get('set-cookie') ?? '').not.toContain('lynox_profile_oauth_state=');
    expect(await res!.text()).toContain(`${CONNECT_PAGE}${SELFHOST_CLOSE}${BACK_TO_APP}`);
    expect(calls).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses an OAuth callback with a valid state with the reason, before the code is spent at the provider', async () => {
    const { base, file } = await boot(true);
    const cookie = await ownerCookie();
    const before = readFileSync(file, 'utf8');
    const state = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const signed = signProfileOAuthState({ state, profileId: 'books-api', verifier: 'v'.repeat(43), by: { tag: 'owner' } }, SECRET, Math.floor(Date.now() / 1000));
    if (signed === null) throw new Error('fixture: no state cookie');
    let res: Response | undefined;
    const calls = await providerCalls(async () => {
      res = await fetch(`${base}/api/oauth/callback?code=c0de&state=${state}`, {
        headers: { cookie: `${cookie}; lynox_profile_oauth_state=${encodeURIComponent(signed)}` }, redirect: 'manual',
      });
    });
    expect(res!.status).toBe(409);
    expect(await res!.text()).toContain(`${SAVE_PAGE}${SELFHOST_CLOSE}${BACK_TO_APP}`);
    expect(calls).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('closes both OAuth pages with the managed paragraph on an instance a control plane runs', async () => {
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-engine-less-test');
    const { base } = await boot(true);
    const res = await fetch(`${base}/api/oauth/connect/books-api`, { headers: { cookie: await ownerCookie(), 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' }, redirect: 'manual' });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain(`${CONNECT_PAGE}${MANAGED_CLOSE}${BACK_TO_APP}`);
    expect(html).not.toContain('The log the engine writes');
    const state = '3f2504e0-4f89-11d3-9a0c-0305e82c3302';
    const signed = signProfileOAuthState({ state, profileId: 'books-api', verifier: 'v'.repeat(43), by: { tag: 'owner' } }, SECRET, Math.floor(Date.now() / 1000));
    if (signed === null) throw new Error('fixture: no state cookie');
    const back = await fetch(`${base}/api/oauth/callback?code=c0de&state=${state}`, {
      headers: { cookie: `${await ownerCookie()}; lynox_profile_oauth_state=${encodeURIComponent(signed)}` }, redirect: 'manual',
    });
    expect(back.status).toBe(409);
    expect(await back.text()).toContain(`${SAVE_PAGE}${MANAGED_CLOSE}${BACK_TO_APP}`);
  });

  it('closes with the helper paragraph on self-host when someone other than the owner started the connection', async () => {
    // Without engine.db no mandate is live, so a mandate session is turned away at the door and never
    // sees the start page. It can still come back from the provider, if it started on an engine that
    // restarted without engine.db in the meantime: that callback names the helper paragraph.
    const { base } = await boot(true);
    const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
    const mandate = loginSession(SECRET, {
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-7',
      mandate_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })?.token;
    if (mandate === undefined) throw new Error('fixture: no mandate cookie');
    const res = await fetch(`${base}/api/oauth/connect/books-api`, { headers: { cookie: `lynox_session=${mandate}`, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' }, redirect: 'manual' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This access has ended.', code: 'mandate_revoked' });
    const state = '3f2504e0-4f89-11d3-9a0c-0305e82c3303';
    const signed = signProfileOAuthState({ state, profileId: 'books-api', verifier: 'v'.repeat(43), by: { tag: 'mandate:ida@example.invalid', mandateId: 'TEST-MANDATE-7' } }, SECRET, Math.floor(Date.now() / 1000));
    if (signed === null) throw new Error('fixture: no state cookie');
    // The owner's session on the callback does not matter: the page is for whoever started it.
    const back = await fetch(`${base}/api/oauth/callback?code=c0de&state=${state}`, {
      headers: { cookie: `${await ownerCookie()}; lynox_profile_oauth_state=${encodeURIComponent(signed)}` }, redirect: 'manual',
    });
    expect(back.status).toBe(409);
    expect(await back.text()).toContain(`${SAVE_PAGE}${HELPER_CLOSE}${BACK_TO_APP}`);
  });

  it('tells a callback without a valid state nothing about engine.db', async () => {
    const { base } = await boot(true);
    const res = await fetch(`${base}/api/oauth/callback?code=c0de&state=st4te`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('engine.db');
  });

  it('control: an engine with engine.db deletes the same profile', async () => {
    const { base } = await boot(false);
    const res = await fetch(`${base}/api/api-profiles/books-api`, { method: 'DELETE', headers: { cookie: await ownerCookie() } });
    expect(res.status).toBe(200);
  });
});
