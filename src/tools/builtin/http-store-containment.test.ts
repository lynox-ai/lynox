/**
 * The containment at the credential funnel (`http.ts › mintStorePassFor`): a request to a store
 * contains its thread or its bulk run after every refusal and before its pass exists, and is
 * refused when it has no container or its row cannot be written. Driven through `http_request`
 * with a stub store that looks at the record when the request arrives, and through
 * `attachStoredCredential` for a bulk run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({ default: { lookup: vi.fn() } }));

// The mint, observed: what the record said at the moment the pass was made.
const minted = vi.hoisted(() => ({ sawContained: [] as boolean[], probe: null as null | (() => boolean) }));
vi.mock('../../core/store-pass.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/store-pass.js')>();
  return {
    ...actual,
    mintStorePass: (...args: Parameters<typeof actual.mintStorePass>) => {
      minted.sawContained.push(minted.probe?.() ?? false);
      return actual.mintStorePass(...args);
    },
  };
});

import dns from 'node:dns/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { accessTokenKey, ApiStore, type ApiProfile } from '../../core/api-store.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { ExactClearance } from '../../core/exact-clearance.js';
import { EngineDb } from '../../core/engine-db.js';
import { BulkLedger } from '../../core/bulk-ledger.js';
import { Containment, CONTAINED_WRITE_REFUSAL_AT_SEND as CONTAINED_WRITE_REFUSAL } from '../../core/containment.js';
import type { ContainmentMirror } from '../../core/history-markers.js';
import { createToolContext, type ToolContext } from '../../core/tool-context.js';
import { setPinnedTransportForTests } from '../../core/network-guard.js';
import { ToolSoftFailure } from '../../core/tool-soft-failure.js';
import { attachStoredCredential, httpRequestTool } from './http.js';
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
let containment: Containment;
let ctx: ToolContext;
let cpAnswer: () => Response;
/** How often the control plane was asked: its clearance records the instance, so a request refused for a reason that writes nothing must not reach it. */
let cpAsked: number;
let skipSet: string[];
let restoreTransport: () => void;
/** What the stub store saw of the record when each request arrived. */
let atReceipt: { url: string; contained: boolean }[];
let storeAnswer: () => Promise<Response>;

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.mocked(dns.lookup).mockResolvedValue([{ address: '1.2.3.4', family: 4 }] as never);
  dir = mkdtempSync(join(tmpdir(), 'lynox-funnel-contained-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), '');
  containment = new Containment(engineDb.getDb(), null);
  cpAnswer = () => new Response('{"ok":true}', { status: 200 });
  cpAsked = 0;
  skipSet = [];
  atReceipt = [];
  minted.sawContained = [];
  minted.probe = () => containment.isContained({ threadId: 'thread-1', bulkRunId: 'run-1' });
  storeAnswer = async () => new Response('{"shop":{"name":"Acme"}}', { status: 200, headers: { 'content-type': 'application/json' } });
  const store = new ApiStore();
  store.register(shopProfile());
  ctx = createToolContext({});
  // The process's shell mode (`shell-isolation.ts`): a store pass needs the sidecar.
  ctx.shellIsolation = { kind: 'sidecar', socket: '/run/lynox/shell.sock', root: {} } as never;
  ctx.apiStore = store;
  ctx.exactClearance = new ExactClearance(
    { url: 'https://cp.example.invalid', instanceId: 'inst-1', secret: 's' },
    { isSet: () => false, set: () => undefined },
    { fetch: (async () => { cpAsked++; return cpAnswer(); }) as unknown as typeof fetch },
  );
  ctx.storeBindingDigest = bind;
  ctx.containment = containment;
  ctx.vaultNameBindings = bindingsAsMigrated(store);
  ctx.threadStore = {
    getThread: (id: string) => ({ id, skip_extraction: skipSet.includes(id) ? 1 : 0 }),
    updateThread: (id: string, u: { skip_extraction?: boolean }) => { if (u.skip_extraction === true) skipSet.push(id); },
  } as never;
  restoreTransport = setPinnedTransportForTests(async (input) => {
    atReceipt.push({ url: input.url, contained: containment.isContained({ threadId: 'thread-1' }) || containment.isContained({ threadId: 'thread-parent' }) });
    return storeAnswer();
  });
});

afterEach(() => {
  restoreTransport();
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function agent(thread: { current?: string; origin?: string }): never {
  return {
    toolContext: ctx,
    sessionCounters: { httpRequests: 0, writeBytes: 0 },
    principal: OWNER_PRINCIPAL,
    currentThreadId: thread.current,
    originThreadId: thread.origin,
    governingContract: () => ({ contract: undefined, withheld: 'none' }),
    secretStore: {
      resolve: (n: string) => (n === accessTokenKey('shop-acme') ? TOKEN : null),
      containsSecret: () => false,
      maskSecrets: (t: string) => t,
      listNames: () => [accessTokenKey('shop-acme')],
    },
  } as never;
}

async function request(a: never, headers: Record<string, string> = {}): Promise<string> {
  try {
    return await httpRequestTool.handler({ url: URL_OK, method: 'GET', headers }, a);
  } catch (err) {
    if (err instanceof ToolSoftFailure) return err.agentVisibleResult;
    return `thrown: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const containedRows = (): { container_kind: string; container_id: string; kind: string; connection_id: string }[] =>
  engineDb.getDb().prepare('SELECT container_kind, container_id, kind, connection_id FROM contained').all() as never;

describe('a request to the store under a thread', () => {
  it('contains the thread before the pass is minted, and the store sees the record when the request arrives', async () => {
    const out = await request(agent({ current: 'thread-1' }));
    expect(atReceipt, out).toEqual([{ url: URL_OK, contained: true }]);
    expect(minted.sawContained).toEqual([true]);
    expect(containedRows()).toEqual([{ container_kind: 'thread', container_id: 'thread-1', kind: 'api', connection_id: 'shop-acme' }]);
    // And the thread's private flag, so the readers of private mode stand down too.
    expect(skipSet).toEqual(['thread-1']);
    // The positive control for the `cpAsked` asserts below: a request that is sent asks once.
    expect(cpAsked).toBe(1);
  });

  it('a spawned child, which has no thread of its own, contains the chat it was spawned from', async () => {
    await request(agent({ origin: 'thread-parent' }));
    expect(atReceipt).toHaveLength(1);
    expect(containedRows()).toEqual([{ container_kind: 'thread', container_id: 'thread-parent', kind: 'api', connection_id: 'shop-acme' }]);
  });

  it('a request that fails at the store leaves the thread contained', async () => {
    storeAnswer = async () => { throw new Error('connection reset'); };
    const out = await request(agent({ current: 'thread-1' }));
    expect(out).toMatch(/connection reset|failed/i);
    expect(atReceipt).toHaveLength(1);
    expect(containment.isContained({ threadId: 'thread-1' })).toBe(true);
  });
});

describe('a refused request contains nothing', () => {
  it('a refusal before the funnel\'s end (a credential header the model wrote)', async () => {
    const out = await request(agent({ current: 'thread-1' }), { 'X-Shopify-Access-Token': 'mine' });
    expect(out).toMatch(/credential header of its own/);
    expect(containedRows()).toEqual([]);
    expect(skipSet).toEqual([]);
    expect(atReceipt).toEqual([]);
  });

  it('the control plane\'s refusal', async () => {
    cpAnswer = () => new Response('{"ok":false,"reason":"below_floor"}', { status: 200 });
    await request(agent({ current: 'thread-1' }));
    expect(containedRows()).toEqual([]);
    expect(minted.sawContained).toEqual([]);
    expect(atReceipt).toEqual([]);
  });

  it('a binding that does not hold', async () => {
    ctx.storeBindingDigest = () => 'f'.repeat(64);
    await request(agent({ current: 'thread-1' }));
    expect(containedRows()).toEqual([]);
    expect(atReceipt).toEqual([]);
  });
});

describe('no container, or no record, means no request', () => {
  it('an agent with no chat (a saved workflow run without one) is refused before the control plane is asked, and the pass is never minted', async () => {
    const out = await request(agent({}));
    expect(out).toMatch(/sent only for a chat or a bulk run, and this one runs for neither/);
    expect(cpAsked).toBe(0);
    expect(minted.sawContained).toEqual([]);
    expect(atReceipt).toEqual([]);
    expect(containedRows()).toEqual([]);
  });

  it('a containment row that cannot be written refuses', async () => {
    engineDb.getDb().exec('DROP TRIGGER contained_written_once; DROP TABLE contained;');
    minted.probe = () => false;
    const out = await request(agent({ current: 'thread-1' }));
    expect(out).toMatch(/could not record that this chat or run reads the store/);
    expect(minted.sawContained).toEqual([]);
    expect(atReceipt).toEqual([]);
    // Nor is the private flag set for a request that never left.
    expect(skipSet).toEqual([]);
  });

  it('a copy in history.db that does not hold refuses: the funnel reads both records back', async () => {
    // A write the copy swallows, as `INSERT OR IGNORE` does with a refused row (cut S3-E).
    const swallowing = { write: () => undefined, connections: () => [], has: () => false, threadIds: () => new Set() } as unknown as ContainmentMirror;
    ctx.containment = new Containment(engineDb.getDb(), swallowing);
    minted.probe = () => false;
    const out = await request(agent({ current: 'thread-1' }));
    expect(out).toMatch(/could not record that this chat or run reads the store/);
    expect(minted.sawContained).toEqual([]);
    expect(atReceipt).toEqual([]);
  });

  it('a private flag that cannot be written refuses, and the containment row stays', async () => {
    ctx.threadStore = { getThread: () => ({ skip_extraction: 0 }), updateThread: () => { throw new Error('history.db is locked'); } } as never;
    const out = await request(agent({ current: 'thread-1' }));
    expect(out).toMatch(/could not record/);
    expect(atReceipt).toEqual([]);
    expect(containment.isContained({ threadId: 'thread-1' })).toBe(true);
  });

  it('a thread row that does not exist, whose update changes nothing and throws nothing, refuses', async () => {
    ctx.threadStore = { getThread: () => undefined, updateThread: () => undefined } as never;
    const out = await request(agent({ current: 'thread-1' }));
    expect(out).toMatch(/could not record/);
    expect(atReceipt).toEqual([]);
    expect(containment.isContained({ threadId: 'thread-1' })).toBe(true);
  });

  it('no thread store refuses a thread\'s request', async () => {
    ctx.threadStore = null;
    const out = await request(agent({ current: 'thread-1' }));
    expect(out).toMatch(/could not record/);
    expect(atReceipt).toEqual([]);
    expect(cpAsked).toBe(0);
  });

  it('no containment store refuses', async () => {
    ctx.containment = null;
    const out = await request(agent({ current: 'thread-1' }));
    expect(out).toMatch(/could not record/);
    expect(atReceipt).toEqual([]);
    expect(cpAsked).toBe(0);
  });
});

describe('a bulk run\'s request (attachStoredCredential)', () => {
  const attach = async (runId: string, over: Partial<{ containment: Containment | null }> = {}): Promise<{ attached: Awaited<ReturnType<typeof attachStoredCredential>>; pass: unknown }> => {
    const out: { pass?: unknown } = {};
    const attached = await attachStoredCredential(URL_OK, {}, false, {
      apiStore: ctx.apiStore!,
      secretStore: { resolve: (n: string) => (n === accessTokenKey('shop-acme') ? TOKEN : null) } as never,
      principal: OWNER_PRINCIPAL, mandateEnds: null, secretReleases: null,
      exactClearance: ctx.exactClearance, storeBindingDigest: ctx.storeBindingDigest,
      containment: over.containment === undefined ? containment : over.containment,
      vaultNameBindings: ctx.vaultNameBindings,
      shellIsolation: ctx.shellIsolation,
    }, { bulkRunId: runId }, out as never);
    return { attached, pass: out.pass };
  };

  it('contains the run, not a thread, before the pass is minted', async () => {
    const r = await attach('run-1');
    expect(r.attached).not.toBeNull();
    expect(r.pass).toBeDefined();
    expect(minted.sawContained).toEqual([true]);
    expect(containedRows()).toEqual([{ container_kind: 'bulk_run', container_id: 'run-1', kind: 'api', connection_id: 'shop-acme' }]);
    expect(skipSet).toEqual([]);
  });

  it('a run planned in a clean chat that then reads the store contains the run and leaves the chat clean', async () => {
    // The rule is read at the run's insert: a contained planning chat passes its containment
    // on, but what the run reads later does not flow back into the chat (its summary and its
    // notifications carry counts and fixed text only), so the chat is not contained by it.
    const run = new BulkLedger(engineDb, null).recordDryRun({
      createdBy: 'chat-clean', planningThread: 'chat-clean', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'mem',
      targets: [{ key: 'k0', before: { absent: false, value: 'v0' }, after: 'w0' }],
    });
    expect(containment.isContained({ bulkRunId: run.id })).toBe(false);
    expect((await attach(run.id)).attached).not.toBeNull();
    expect(containment.isContained({ bulkRunId: run.id })).toBe(true);
    expect(containment.isContained({ threadId: 'chat-clean' })).toBe(false);
    expect(skipSet).toEqual([]);
  });

  it('is refused without a record to write into, or with an empty run id', async () => {
    expect((await attach('run-1', { containment: null })).attached).toBeNull();
    expect((await attach('')).attached).toBeNull();
    expect(minted.sawContained).toEqual([]);
    expect(containedRows()).toEqual([]);
    // Both write nothing, so neither reaches the control plane, whose clearance records the instance.
    expect(cpAsked).toBe(0);
  });
});

describe('a contained chat reads the store and writes nowhere', () => {
  const ORIGIN_B = 'https://beta.myshopify.com';
  const TOKEN_B = 'shpat-other-value';
  const GRAPHQL = `${ORIGIN}/admin/api/2025-10/graphql.json`;
  const PRODUCT = `${ORIGIN}/admin/api/2025-10/products/1.json`;
  const json = { 'Content-Type': 'application/json' };
  let asked: number;

  beforeEach(() => {
    asked = 0;
    ctx.apiStore!.register({
      ...shopProfile(), id: 'shop-beta', name: 'Beta', base_url: ORIGIN_B,
      auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: 'beta' }, client_id_key: 'B_CID', client_secret_key: 'B_CSECRET' } },
      custom_endpoint_ack: { accepted: true, hosts: ['beta.myshopify.com'], accepted_at: '2026-10-18T00:00:00.000Z' },
      oauth_grant: { origin: 'callback', state: 'connected', store_binding: bind('shop-beta', ORIGIN_B, TOKEN_B) },
    } as ApiProfile);
    ctx.vaultNameBindings = bindingsAsMigrated(ctx.apiStore!);
  });

  /** An owner who answers Allow to every question: a refusal below is the containment's, not a missing consent. */
  function owner(thread: string): never {
    const a = agent({ current: thread }) as unknown as Record<string, unknown>;
    return {
      ...a,
      promptUser: async () => { asked++; return 'Allow'; },
      secretStore: {
        ...(a['secretStore'] as object),
        resolve: (n: string) => (n === accessTokenKey('shop-acme') ? TOKEN : n === accessTokenKey('shop-beta') ? TOKEN_B : null),
        listNames: () => [accessTokenKey('shop-acme'), accessTokenKey('shop-beta')],
      },
    } as never;
  }

  async function send(a: never, input: { url: string; method: string; headers?: Record<string, string>; body?: string }): Promise<string> {
    try {
      return await httpRequestTool.handler(input, a);
    } catch (err) {
      if (err instanceof ToolSoftFailure) return err.agentVisibleResult;
      return `thrown: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const containForA = (): void => containment.contain({ kind: 'thread', id: 'thread-1' }, { kind: 'api', connectionId: 'shop-acme' });
  const rowsOf = (thread: string): string[] => containedRows().filter((r) => r.container_id === thread).map((r) => r.connection_id).sort();

  it('a write to its own store is refused before anything is asked or sent, though the owner would allow it', async () => {
    containForA();
    const out = await send(owner('thread-1'), { url: PRODUCT, method: 'PUT', headers: json, body: '{"product":{"title":"x"}}' });
    expect(out).toContain(CONTAINED_WRITE_REFUSAL);
    expect(asked).toBe(0);
    expect(atReceipt).toEqual([]);
  });

  it('the same write from a chat that has not read the store is asked and sent (the positive control)', async () => {
    const out = await send(owner('thread-2'), { url: PRODUCT, method: 'PUT', headers: json, body: '{"product":{"title":"x"}}' });
    expect(out).not.toContain(CONTAINED_WRITE_REFUSAL);
    expect(asked, out).toBe(1);
    expect(atReceipt.map((r) => r.url)).toEqual([PRODUCT]);
  });

  it('contained for A, a write to store B is refused and leaves no row for B', async () => {
    containForA();
    const out = await send(owner('thread-1'), { url: `${ORIGIN_B}/admin/api/2025-10/products/1.json`, method: 'PUT', headers: json, body: '{"product":{"title":"x"}}' });
    expect(out).toContain(CONTAINED_WRITE_REFUSAL);
    expect(atReceipt).toEqual([]);
    expect(rowsOf('thread-1')).toEqual(['shop-acme']);
  });

  it('contained for A, a read of store B is sent and contains the chat for B as well', async () => {
    containForA();
    const out = await send(owner('thread-1'), { url: `${ORIGIN_B}/admin/api/2025-10/shop.json`, method: 'GET' });
    expect(out).not.toContain(CONTAINED_WRITE_REFUSAL);
    expect(atReceipt.map((r) => r.url), out).toEqual([`${ORIGIN_B}/admin/api/2025-10/shop.json`]);
    expect(rowsOf('thread-1')).toEqual(['shop-acme', 'shop-beta']);
  });

  it('a GraphQL query is the one POST it sends', async () => {
    containForA();
    const out = await send(owner('thread-1'), { url: GRAPHQL, method: 'POST', headers: json, body: JSON.stringify({ query: '{ shop { name } }' }) });
    expect(out).not.toContain(CONTAINED_WRITE_REFUSAL);
    expect(atReceipt.map((r) => r.url), out).toEqual([GRAPHQL]);
  });

  it.each([
    ['a mutation', { query: 'mutation { webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: { uri: "https://x.example" }) { userErrors { message } } }' }],
    ['a mutation picked by operationName behind a query', { query: 'query A { shop { name } } mutation B { orderInvoiceSend(id: "1") { userErrors { message } } }', operationName: 'B' }],
  ])('a GraphQL write is refused: %s', async (_label, doc) => {
    containForA();
    const out = await send(owner('thread-1'), { url: GRAPHQL, method: 'POST', headers: json, body: JSON.stringify(doc) });
    expect(out).toContain(CONTAINED_WRITE_REFUSAL);
    expect(asked).toBe(0);
    expect(atReceipt).toEqual([]);
  });

  it('a GraphQL query that also names another write as a method override is refused', async () => {
    containForA();
    const out = await send(owner('thread-1'), { url: GRAPHQL, method: 'POST', headers: { ...json, 'X-HTTP-Method-Override': 'DELETE' }, body: JSON.stringify({ query: '{ shop { name } }' }) });
    expect(out).toContain(CONTAINED_WRITE_REFUSAL);
    expect(atReceipt).toEqual([]);
  });

  it('a REST POST to its store is refused (webhooks)', async () => {
    containForA();
    const out = await send(owner('thread-1'), { url: `${ORIGIN}/admin/api/2025-10/webhooks.json`, method: 'POST', headers: json, body: '{"webhook":{"address":"https://x.example"}}' });
    expect(out).toContain(CONTAINED_WRITE_REFUSAL);
    expect(asked).toBe(0);
    expect(atReceipt).toEqual([]);
  });

  it('a method override that is not text is refused before anything is sent', async () => {
    containForA();
    const out = await send(owner('thread-1'), { url: PRODUCT, method: 'GET', headers: { 'X-HTTP-Method-Override': 1 as unknown as string } });
    expect(out).not.toMatch(/"product"|"shop"/);
    expect(asked).toBe(0);
    expect(atReceipt).toEqual([]);
  });

  it('a GET that carries a write as a method override is refused', async () => {
    containForA();
    const out = await send(owner('thread-1'), { url: `${PRODUCT}?_method=DELETE`, method: 'GET' });
    expect(out).toContain(CONTAINED_WRITE_REFUSAL);
    expect(atReceipt).toEqual([]);
  });
});
