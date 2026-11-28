/**
 * A store connection whose token is due and that cannot be renewed as it stands (here: its refresh
 * token is not in the vault), driven through the real refresh (`core/store-token-refresh.ts`): the
 * attach finds the token due and asks for a refresh first, the store then answers 401, and the
 * request's renewal asks again inside the refresh window. Both a chat request (`http_request`) and
 * a bulk run's request (`attachStoredCredential`) must then say to connect the store again, not that
 * nothing ran this time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({ default: { lookup: vi.fn() } }));

import dns from 'node:dns/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { accessTokenKey, ApiStore, type ApiProfile } from '../../core/api-store.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { ExactClearance } from '../../core/exact-clearance.js';
import { EngineDb } from '../../core/engine-db.js';
import { Containment } from '../../core/containment.js';
import { createToolContext, type ToolContext } from '../../core/tool-context.js';
import { setPinnedTransportForTests } from '../../core/network-guard.js';
import { ToolSoftFailure } from '../../core/tool-soft-failure.js';
import { resetStoreRefreshForTests, type StoreRefreshOutcome } from '../../core/store-token-refresh.js';
import { attachStoredCredential, httpRequestTool } from './http.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';

const ORIGIN = 'https://acme.myshopify.com';
const URL_OK = `${ORIGIN}/admin/api/2025-10/shop.json`;
const ID = 'shop-acme';
const TOKEN = 'shpat-store-value';
const KEY = 'vault-key-of-this-instance';
const bind = (id: string, origin: string, value: string): string => createHmac('sha256', KEY).update(`${id}|${origin}|${value}`).digest('hex');

const ENV = {
  LYNOX_SHOPIFY_EXCHANGE: '1',
  LYNOX_MANAGED_CONTROL_PLANE_URL: 'https://cp.example.invalid',
  LYNOX_MANAGED_INSTANCE_ID: 'inst-1',
  LYNOX_HTTP_SECRET: 's',
};

/** The vault of this test: the access token and the preset's client, but no refresh token. */
const vault = new Map<string, string>();

function dueProfile(): ApiProfile {
  return {
    id: ID, name: 'Acme', base_url: ORIGIN, description: 'stub',
    auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: 'acme' }, client_id_key: 'SHOPIFY_CLIENT_ID', client_secret_key: 'SHOPIFY_CLIENT_SECRET', token_expires_at: Date.now() - 60_000 } },
    custom_endpoint_ack: { accepted: true, hosts: ['acme.myshopify.com'], accepted_at: '2026-10-18T00:00:00.000Z' },
    oauth_grant: { origin: 'callback', state: 'connected', store_binding: bind(ID, ORIGIN, TOKEN) },
  } as ApiProfile;
}

let dir: string;
let engineDb: EngineDb;
let containment: Containment;
let ctx: ToolContext;
let restoreTransport: () => void;
/** Each request the stub store got. */
let received: string[];

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.mocked(dns.lookup).mockResolvedValue([{ address: '1.2.3.4', family: 4 }] as never);
  resetStoreRefreshForTests();
  dir = mkdtempSync(join(tmpdir(), 'lynox-store-refresh-window-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), '');
  containment = new Containment(engineDb.getDb(), null);
  received = [];
  vault.clear();
  vault.set(accessTokenKey(ID), TOKEN);
  vault.set('SHOPIFY_CLIENT_ID', 'cid');
  vault.set('SHOPIFY_CLIENT_SECRET', 'csecret');
  const store = new ApiStore();
  store.register(dueProfile());
  ctx = createToolContext({});
  ctx.shellIsolation = { kind: 'sidecar', socket: '/run/lynox/shell.sock', root: {} } as never;
  ctx.apiStore = store;
  ctx.exactClearance = new ExactClearance(
    { url: 'https://cp.example.invalid', instanceId: 'inst-1', secret: 's' },
    { isSet: () => false, set: () => undefined },
    { fetch: (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch },
  );
  ctx.storeBindingDigest = bind;
  ctx.containment = containment;
  ctx.vaultNameBindings = bindingsAsMigrated(store);
  const skipped: string[] = [];
  ctx.threadStore = {
    getThread: (id: string) => ({ id, skip_extraction: skipped.includes(id) ? 1 : 0 }),
    updateThread: (id: string, u: { skip_extraction?: boolean }) => { if (u.skip_extraction === true) skipped.push(id); },
  } as never;
  restoreTransport = setPinnedTransportForTests(async (input) => {
    received.push(input.url);
    return new Response('{"errors":"[API] Invalid API key or access token"}', { status: 401, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  restoreTransport();
  resetStoreRefreshForTests();
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const secretStore = {
  resolve: (n: string) => vault.get(n) ?? null,
  set: (n: string, v: string) => { vault.set(n, v); },
  containsSecret: () => false,
  maskSecrets: (t: string) => t,
  listNames: () => [...vault.keys()],
};

describe('a store whose token is due and cannot be renewed as it stands', () => {
  it('a chat request that gets a 401 says to connect the store again, and nothing of sending once more', async () => {
    const agent = {
      toolContext: ctx,
      sessionCounters: { httpRequests: 0, writeBytes: 0 },
      principal: OWNER_PRINCIPAL,
      currentThreadId: 'thread-1',
      originThreadId: undefined,
      governingContract: () => ({ contract: undefined, withheld: 'none' }),
      secretStore,
    } as never;
    let out: string;
    try {
      out = await httpRequestTool.handler({ url: URL_OK, method: 'GET', headers: {} }, agent);
    } catch (err) {
      out = err instanceof ToolSoftFailure ? err.agentVisibleResult : `thrown: ${err instanceof Error ? err.message : String(err)}`;
    }
    expect(received).toEqual([URL_OK]);
    expect(out).toContain(`To connect it, call api_setup with action "connect" and id "${ID}"`);
    expect(out).not.toContain('did not renew the access token for this store this time');
  });

  it('a bulk run\'s request that gets a 401 hears from its renewal that the store cannot be renewed as it stands', async () => {
    const out: { renew?: (() => Promise<StoreRefreshOutcome>) | undefined; reconnect?: 'ended' | 'client-misnamed' | undefined } = {};
    const attached = await attachStoredCredential(URL_OK, {}, false, {
      hostPolicy: { networkPolicy: undefined, allowedHosts: undefined, allowedWildcards: [], enforceHttps: false },
      apiStore: ctx.apiStore!,
      secretStore: secretStore as never,
      principal: OWNER_PRINCIPAL, mandateEnds: null, secretReleases: null,
      exactClearance: ctx.exactClearance, storeBindingDigest: ctx.storeBindingDigest,
      containment,
      vaultNameBindings: ctx.vaultNameBindings,
      shellIsolation: ctx.shellIsolation,
    }, { bulkRunId: 'run-1' }, out as never);
    // The attach asked for the refresh, found it cannot run, and still attached the token it has.
    expect(attached?.id).toBe(ID);
    expect(out.reconnect).toBeUndefined();
    expect(typeof out.renew).toBe('function');
    // The 401 that token gets: the renewal, inside the window, names why, which halts the run with
    // the reason to connect the store again (`bulk-external.ts`).
    expect(await out.renew!()).toBe('ineligible');
  });
});
