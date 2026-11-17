/**
 * Each refusal of a request to a Shopify store names its own cause (`core/shopify-host.ts`), driven
 * through `http_request` against the real store-pass checks: a self-hosted instance, a managed one
 * that misses a part, the control plane's two kinds of answer, and the positive control, a request
 * that is sent. Each test names the sentence of its cause and none of the others.
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
import * as host from '../../core/shopify-host.js';
import { fetchWithValidatedRedirects, httpRequestTool } from './http.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';

const ORIGIN = 'https://acme.myshopify.com';
const URL_OK = `${ORIGIN}/admin/api/2025-10/shop.json`;
const TOKEN = 'shpat-store-value';
const KEY = 'vault-key-of-this-instance';
const bind = (id: string, origin: string, value: string): string => createHmac('sha256', KEY).update(`${id}|${origin}|${value}`).digest('hex');

const ENV = {
  LYNOX_MANAGED_CONTROL_PLANE_URL: 'https://cp.example.invalid',
  LYNOX_MANAGED_INSTANCE_ID: 'inst-1',
  LYNOX_HTTP_SECRET: 's',
};

/** Every refusal sentence, so a test can check that its own is the only one in the answer. */
const SENTENCES = Object.entries(host).filter(([n, v]) => n.startsWith('SHOPIFY_') && typeof v === 'string') as Array<[string, string]>;

function shopProfile(): ApiProfile {
  return {
    id: 'shop-acme', name: 'Acme', base_url: ORIGIN, description: 'stub',
    auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: 'acme' }, client_id_key: 'S_CID', client_secret_key: 'S_CSECRET' } },
    custom_endpoint_ack: { accepted: true, hosts: ['acme.myshopify.com'], accepted_at: '2026-10-18T00:00:00.000Z' },
    oauth_grant: { origin: 'callback', state: 'connected', store_binding: bind('shop-acme', ORIGIN, TOKEN) },
  } as ApiProfile;
}

let dir: string;
let engineDb: EngineDb;
let ctx: ToolContext;
let cpAnswer: () => Promise<Response>;
let cpAsked: number;
let received: string[];
/** The vault names a request read: step 6a refuses before the vault is read. */
let vaultRead: string[];
let restoreTransport: () => void;

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.mocked(dns.lookup).mockResolvedValue([{ address: '1.2.3.4', family: 4 }] as never);
  dir = mkdtempSync(join(tmpdir(), 'lynox-store-reasons-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), '');
  cpAnswer = async () => new Response('{"ok":true}', { status: 200 });
  cpAsked = 0;
  received = [];
  vaultRead = [];
  const store = new ApiStore();
  store.register(shopProfile());
  ctx = createToolContext({});
  ctx.shellIsolation = { kind: 'sidecar', socket: '/run/lynox/shell.sock', root: {} } as never;
  ctx.apiStore = store;
  ctx.exactClearance = new ExactClearance(
    { url: 'https://cp.example.invalid', instanceId: 'inst-1', secret: 's' },
    { isSet: () => false, set: () => undefined },
    { fetch: (async () => { cpAsked++; return cpAnswer(); }) as unknown as typeof fetch },
  );
  ctx.storeBindingDigest = bind;
  ctx.containment = new Containment(engineDb.getDb(), null);
  ctx.vaultNameBindings = bindingsAsMigrated(store);
  ctx.threadStore = { getThread: (id: string) => ({ id, skip_extraction: 1 }), updateThread: () => undefined } as never;
  restoreTransport = setPinnedTransportForTests(async (input) => {
    received.push(input.url);
    return new Response('{"shop":{"name":"Acme"}}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  restoreTransport();
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function agent(opts: { vault?: boolean } = {}): never {
  return {
    toolContext: ctx,
    sessionCounters: { httpRequests: 0, writeBytes: 0 },
    principal: OWNER_PRINCIPAL,
    currentThreadId: 'thread-1',
    governingContract: () => ({ contract: undefined, withheld: 'none' }),
    ...(opts.vault === false ? {} : {
      secretStore: {
        resolve: (n: string) => { vaultRead.push(n); return n === accessTokenKey('shop-acme') ? TOKEN : null; },
        containsSecret: () => false,
        maskSecrets: (t: string) => t,
        listNames: () => [accessTokenKey('shop-acme')],
      },
    }),
  } as never;
}

async function request(a: never = agent()): Promise<string> {
  try {
    return await httpRequestTool.handler({ url: URL_OK, method: 'GET', headers: {} }, a);
  } catch (err) {
    if (err instanceof ToolSoftFailure) return err.agentVisibleResult;
    return `thrown: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** No other refusal sentence than `own` is in the answer, and nothing reached the store. */
function onlyThat(out: string, own: string): void {
  for (const [name, sentence] of SENTENCES) if (sentence !== own) expect(out, name).not.toContain(sentence);
  expect(received).toEqual([]);
}

describe('a request to a connected store', () => {
  it('control: with every part in place and the control plane clearing, it is sent', async () => {
    const out = await request();
    expect(received).toEqual([URL_OK]);
    for (const [name, sentence] of SENTENCES) expect(out, name).not.toContain(sentence);
  });
});

describe('the instance', () => {
  it('self-hosted (no control plane): Shopify only on an instance lynox runs, and nothing is asked', async () => {
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', '');
    const out = await request();
    expect(out).toContain(host.SHOPIFY_SELF_HOSTED);
    onlyThat(out, host.SHOPIFY_SELF_HOSTED);
    expect(cpAsked).toBe(0);
  });

  it.each([
    ['without its binding digest', () => { ctx.storeBindingDigest = undefined as never; }],
    ['without its clearance', () => { ctx.exactClearance = null; }],
    ['without the sidecar', () => { ctx.shellIsolation = { kind: 'local' } as never; }],
  ])('managed, %s: not set up, lynox has to fix it', async (_label, drop) => {
    drop();
    const out = await request();
    expect(out).toContain(host.SHOPIFY_NOT_SET_UP);
    onlyThat(out, host.SHOPIFY_NOT_SET_UP);
    expect(cpAsked).toBe(0);
  });

  it('managed, without a vault for the pass: not set up, instead of a page refusal at the send', async () => {
    const out = await request(agent({ vault: false }));
    expect(out).toContain(host.SHOPIFY_NOT_SET_UP);
    onlyThat(out, host.SHOPIFY_NOT_SET_UP);
  });
});

// The control plane's answer decides the sentence, never the time: both kinds back off for 60 s.
describe('the control plane', () => {
  it.each([
    ['refuses (below the floor)', async () => new Response('{"ok":false,"reason":"below_floor"}', { status: 409 }), host.SHOPIFY_NOT_CLEARED],
    ['refuses (not a tenant host)', async () => new Response('{"ok":false,"reason":"not_tenant_host"}', { status: 403 }), host.SHOPIFY_NOT_CLEARED],
    ['does not answer in time', async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, host.SHOPIFY_UNCONFIRMED],
    ['cannot be reached', async () => { throw new Error('ECONNREFUSED'); }, host.SHOPIFY_UNCONFIRMED],
    ['answers 503', async () => new Response('{}', { status: 503 }), host.SHOPIFY_UNCONFIRMED],
    ['is busy', async () => new Response('{"ok":false,"reason":"busy"}', { status: 409 }), host.SHOPIFY_UNCONFIRMED],
  ] as const)('%s: its sentence at the ask, and the same while the refusal holds', async (_label, answer, own) => {
    cpAnswer = answer;
    const first = await request();
    expect(first).toContain(own);
    onlyThat(first, own);
    expect(cpAsked).toBe(1);
    // Control for the assert below: the first request did read the vault (the mint path).
    expect(vaultRead.length).toBeGreaterThan(0);
    // The second request is refused before anything is read for it (step 6a), with the same cause.
    vaultRead = [];
    const second = await request();
    expect(vaultRead).toEqual([]);
    expect(second).toContain(own);
    onlyThat(second, own);
    expect(cpAsked).toBe(1);
  });

  it('a marker engine.db cannot write: not set up, though the control plane cleared it', async () => {
    ctx.exactClearance = new ExactClearance(
      { url: 'https://cp.example.invalid', instanceId: 'inst-1', secret: 's' },
      { isSet: () => false, set: () => { throw new Error('engine.db read-only'); } },
      { fetch: (async () => { cpAsked++; return cpAnswer(); }) as unknown as typeof fetch },
    );
    const out = await request();
    expect(out).toContain(host.SHOPIFY_NOT_SET_UP);
    onlyThat(out, host.SHOPIFY_NOT_SET_UP);
    expect(cpAsked).toBe(1);
  });

  it('control: once the backoff has run out, the control plane is asked again and the request is sent', async () => {
    let now = 1_000_000;
    let refuse = true;
    ctx.exactClearance = new ExactClearance(
      { url: 'https://cp.example.invalid', instanceId: 'inst-1', secret: 's' },
      { isSet: () => false, set: () => undefined },
      { fetch: (async () => { cpAsked++; return refuse ? new Response('{"ok":false,"reason":"busy"}', { status: 409 }) : new Response('{"ok":true}'); }) as unknown as typeof fetch, now: () => now },
    );
    expect(await request()).toContain(host.SHOPIFY_UNCONFIRMED);
    refuse = false;
    now += 60_000;
    await request();
    expect(cpAsked).toBe(2);
    expect(received).toEqual([URL_OK]);
  });
});

// The redirect refusal is for a hop, never for the first request: a page fetch of a store address
// without a pass (discovery, a connector, a calendar) is refused as a page, and a hop into a store
// from another host as a redirect.
describe('the validated redirect follower without a pass', () => {
  it('a store address as the first request is refused as a page, not as a redirect', async () => {
    const thrown = await fetchWithValidatedRedirects(`${ORIGIN}/products`, {}, { surface: 'discovery' }, ctx).then(() => null, (e: unknown) => e as Error);
    expect(thrown?.message).toBe(`Blocked: ${host.SHOPIFY_PAGES}`);
    expect(received).toEqual([]);
  });
});
