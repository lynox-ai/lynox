/**
 * A Shopify store as the source of an external bulk run, read end to end: the plan, the list
 * read by id through the store's GraphQL API, the before-images, and the switch that stops it —
 * under the run's stored read contract, the in-memory copy that grants each exact body
 * (`withShopifyRead`), and the real client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '23.227.38.65', family: 4 }]) },
}));

import dns from 'node:dns/promises';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setPinnedTransportForTests } from './network-guard.js';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, type BulkRunForPreview } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { BulkHostBudget, externalClient, parseBulkContract, type ExternalClient } from './bulk-external.js';
import {
  isOfferedListSource, listPageUrl, listQueryParams, listReadContract, maxListPages, parseListSource, type BulkListSource,
} from './bulk-list.js';
import { runBulkPreview, type BulkPreviewDeps } from './bulk-preview.js';
import { shopifyBeforeImage, shopifyListPage } from './bulk-shopify.js';
import { createToolContext } from './tool-context.js';
import { ApiStore } from './api-store.js';
import { SecretStore } from './secret-store.js';
import { WorkerLoop } from './worker-loop.js';
import { mintStorePass } from './store-pass.js';
import { withListQuery, withShopifyRead, type ListQueryConstraints, type ShopifyReadPhase } from '../tools/permission-guard.js';
import { bulkPlanTool } from '../tools/builtin/bulk.js';
import { BULK_MAX_TARGETS } from './bulk-plan.js';
import type { IAgent } from '../types/index.js';

const HOST = 'acme.myshopify.com';
const ENDPOINT = `https://${HOST}/admin/api/2026-10/graphql.json`;
const gid = (n: number): string => `gid://shopify/Product/${String(n)}`;
const scan = (): null => null;
const FLAG = 'LYNOX_FEATURE_SHOPIFY_BULK_READ';

describe('shopifyListPage', () => {
  const page = (...nodes: unknown[]): unknown => ({ products: { nodes } });

  it('takes the nodes in id order, moving the cursor to the last product id', () => {
    expect(shopifyListPage(page({ id: gid(5) }, { id: gid(9) }), 4)).toEqual({
      kind: 'page', items: [{ key: gid(5), id: gid(5) }, { key: gid(9), id: gid(9) }], lastId: 9, count: 2,
    });
    expect(shopifyListPage(page(), 4)).toEqual({ kind: 'page', items: [], lastId: 4, count: 0 });
  });

  it('refuses a page that does not continue after the last id, or goes back within itself', () => {
    expect(shopifyListPage(page({ id: gid(4) }), 4)).toEqual({ kind: 'order' });
    expect(shopifyListPage(page({ id: gid(7) }, { id: gid(6) }), 4)).toEqual({ kind: 'order' });
    expect(shopifyListPage(page({ id: gid(7) }, { id: gid(7) }), 4)).toEqual({ kind: 'order' });
  });

  it('makes an unusable node an invalid target that leaves the cursor where it was', () => {
    const got = shopifyListPage(page('x', {}, { id: 7 }, { id: 'gid://shopify/Collection/8' }, { id: gid(9) }), 4);
    expect(got).toEqual({
      kind: 'page', lastId: 9, count: 5,
      items: [{ invalid: 'list_item_not_object' }, { invalid: 'list_item_no_id' }, { invalid: 'list_item_bad_id' }, { invalid: 'list_item_bad_id' }, { key: gid(9), id: gid(9) }],
    });
    expect(shopifyListPage(page({ id: 'nope' }), 4)).toMatchObject({ lastId: 4 });
  });

  it('is no page where the nodes are not an array', () => {
    for (const data of [null, [], { products: null }, { products: { nodes: {} } }, { products: { edges: [] } }]) {
      expect(shopifyListPage(data, 0), JSON.stringify(data)).toEqual({ kind: 'not_a_list' });
    }
  });
});

describe('shopifyBeforeImage', () => {
  it('makes the product\'s fields flat, taking only those the answer holds', () => {
    const product = { id: gid(3), title: 'Mug', descriptionHtml: '<p>x</p>', seo: { title: 'T', description: null }, vendor: 'v' };
    expect(shopifyBeforeImage({ product }, gid(3))).toEqual({ value: { title: 'Mug', descriptionHtml: '<p>x</p>', seo_title: 'T', seo_description: null } });
    expect(shopifyBeforeImage({ product: { id: gid(3), seo: null } }, gid(3))).toEqual({ value: {} });
  });

  it('says why there is none: gone, another product, or not a product', () => {
    expect(shopifyBeforeImage({ product: null }, gid(3))).toEqual({ invalid: 'not_found' });
    expect(shopifyBeforeImage({ product: { id: gid(4), title: 'x' } }, gid(3))).toEqual({ invalid: 'list_item_mismatch' });
    for (const data of [null, {}, { product: 'x' }, { product: [] }]) {
      expect(shopifyBeforeImage(data, gid(3)), JSON.stringify(data)).toEqual({ invalid: 'before_not_object' });
    }
  });
});

describe('a Shopify list source', () => {
  const parse = (input: unknown, host = HOST): BulkListSource => parseListSource(host, input, 'PATCH', scan);

  it('is the store\'s products: no path, filters, id field or write verb', () => {
    const s = parse({ form: 'shopify', after: { seo_title: 'New', descriptionHtml: '<p>y</p>' } });
    expect(s).toEqual({ form: 'shopify', path: '', filters: {}, idField: 'id', method: null, after: { seo_title: 'New', descriptionHtml: '<p>y</p>' } });
    expect(isOfferedListSource(s)).toBe(true);
    expect(isOfferedListSource({ ...s, path: '/admin' })).toBe(false);
    expect(isOfferedListSource({ ...s, method: 'PATCH' })).toBe(false);
  });

  it('is refused off a store host, with a path, filters or id field, and for a field the before-image has not', () => {
    expect(() => parse({ form: 'shopify', after: { title: 'x' } }, 'shop.example.com')).toThrow(/<store>\.myshopify\.com/);
    expect(() => parse({ form: 'shopify', after: { title: 'x' } }, 'admin.shopify.com')).toThrow(/<store>\.myshopify\.com/);
    for (const key of ['path', 'filters', 'id_field']) {
      expect(() => parse({ form: 'shopify', [key]: key === 'filters' ? {} : 'x', after: { title: 'x' } }), key).toThrow(new RegExp(`source_list\\.${key} is not given`));
    }
    expect(() => parse({ form: 'shopify', after: { title: 'x', vendor: 'y' } })).toThrow(/may only set: title, descriptionHtml, seo_title, seo_description/);
    expect(() => parse({ form: 'shopify', after: { id: 'x' } })).toThrow(/must not set the id field/);
    expect(() => parse({ form: 'shopify', after: {} })).toThrow(/non-empty object/);
  });

  it('is read under a contract that names no path and grants no write verb, with no page address or query', () => {
    const s = parse({ form: 'shopify', after: { title: 'x' } });
    expect(listReadContract(HOST, s)).toMatchObject({ httpMethods: ['GET'], hostPatterns: [HOST], pathPatterns: [] });
    expect(listQueryParams(s)).toBeUndefined();
    expect(() => listPageUrl(HOST, s, 1)).toThrow(/no page address/);
    expect(maxListPages('shopify')).toBe(Math.ceil(BULK_MAX_TARGETS / 250) + 1);
  });
});

// ── End to end ────────────────────────────────────────────────────────────────

interface Store {
  /** Product number → its fields. */
  products: Map<number, Record<string, unknown>>;
  /** Every request: its method and the variables of its body. */
  requests: { method: string; url: string; variables: Record<string, unknown> }[];
  /** Answer a list page after this id with this instead. */
  listAnswer?: (afterId: number) => unknown;
  /** Answer a product read with this instead. */
  productAnswer?: (id: string) => unknown;
}

function store(n: number): Store {
  const s: Store = { products: new Map(), requests: [] };
  for (let i = 1; i <= n; i++) s.products.set(i * 10, { title: `T${String(i)}`, descriptionHtml: `<p>${String(i)}</p>`, seo: { title: null, description: `D${String(i)}` } });
  return s;
}

function serve(s: Store): () => void {
  vi.mocked(dns.lookup).mockResolvedValue([{ address: '23.227.38.65', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
  return setPinnedTransportForTests(async (req) => {
    const body = JSON.parse(req.body?.toString('utf8') ?? '{}') as { variables?: Record<string, unknown> };
    const variables = body.variables ?? {};
    s.requests.push({ method: req.method, url: req.url, variables });
    if (typeof variables['q'] === 'string') {
      const afterId = Number(/^id:>(\d+)$/.exec(variables['q'])![1]);
      const special = s.listAnswer?.(afterId);
      if (special !== undefined) return new Response(JSON.stringify(special), { status: 200 });
      const ids = [...s.products.keys()].filter((id) => id > afterId).sort((a, b) => a - b).slice(0, variables['n'] as number);
      return new Response(JSON.stringify({ data: { products: { nodes: ids.map((id) => ({ id: gid(id) })) } } }), { status: 200 });
    }
    const id = variables['id'] as string;
    const special = s.productAnswer?.(id);
    if (special !== undefined) return new Response(JSON.stringify(special), { status: 200 });
    const n = Number(id.slice(id.lastIndexOf('/') + 1));
    const p = s.products.get(n);
    return new Response(JSON.stringify({ data: { product: p === undefined ? null : { id, ...p } } }), { status: 200 });
  });
}

function client(contract: NonNullable<ReturnType<typeof parseBulkContract>>): ExternalClient {
  return externalClient({
    contract,
    hostPolicy: createToolContext({}),
    ackHosts: undefined,
    attach: async (_u, headers, _m, out) => {
      headers['X-Shopify-Access-Token'] = 'fixture';
      if (out !== undefined) out.pass = mintStorePass(`https://${HOST}`, 'X-Shopify-Access-Token', 'fixture');
      return { id: 'fixture', grantId: 'grant-1' };
    },
    rateLimit: () => null,
    scan,
    connectedAccount: () => true,
    recordRead: null,
  });
}

/** What the worker's client factory is handed, call by call. */
let minted: (ShopifyReadPhase | 'none')[];

/** The client the worker builds: from the run's OWN stored contract, each grant only on a copy. */
const workerClientFor = (run: BulkRunForPreview, listQuery?: ListQueryConstraints, shopifyRead?: ShopifyReadPhase): ExternalClient | null => {
  minted.push(shopifyRead ?? 'none');
  const stored = parseBulkContract(run.contractJson);
  if (!stored) return null;
  if (shopifyRead !== undefined) return client(withShopifyRead(stored, HOST, shopifyRead));
  return client(listQuery === undefined ? stored : withListQuery(stored, listQuery));
};

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;
let restore: () => void;
let s: Store;

const deps = (extra: Partial<BulkPreviewDeps> = {}): BulkPreviewDeps =>
  ({ ledger, clientFor: workerClientFor, budget: new BulkHostBudget(100_000, 0), sleep: async () => {}, shopifyEnabled: () => true, ...extra });

const source = (): BulkListSource => parseListSource(HOST, { form: 'shopify', after: { seo_title: 'New title' } }, 'PATCH', scan);

function startedList(): string {
  const src = source();
  const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source: src, readContract: listReadContract(HOST, src) });
  if (!out.ok) throw new Error(out.reason);
  const started = ledger.resumePreview(out.status.id, Date.now(), { listChecksum: ledger.listStartChecksum(out.status.id)! });
  if (!started.ok) throw new Error(started.reason);
  return out.status.id;
}

beforeEach(() => {
  minted = [];
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-shopify-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
  s = store(0);
  restore = serve(s);
});
afterEach(() => {
  restore();
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

function fill(n: number): void {
  for (const [k, v] of store(n).products) s.products.set(k, v);
}

describe('reading a store\'s product list', () => {
  it('reads page after page from the last id, each page under a grant minted for its one body, then halts for the owner', async () => {
    fill(300);
    const id = startedList();
    const out = await runBulkPreview(id, deps());
    expect(out.status).toBe('done');
    // Two pages: 250 products, then the 50 after the 250th id (2500).
    expect(s.requests.map((r) => [r.method, r.url, r.variables['q']])).toEqual([['POST', ENDPOINT, 'id:>0'], ['POST', ENDPOINT, 'id:>2500']]);
    expect(minted).toEqual([{ phase: 'list', afterId: 0 }, { phase: 'list', afterId: 2500 }]);
    const list = ledger.getListRun(id)!;
    expect(list).toMatchObject({ state: 'done', page: 2, lastId: 3000, calls: 2 });
    expect(ledger.getStatus(id)).toMatchObject({ total: 300, phase: 'planned', haltReason: BULK_HALT_REASONS.listed, writeForm: null });
    expect(ledger.externalTargetKeys(id).slice(0, 2)).toEqual([gid(10), gid(20)]);
    // The contract it closes with grants no write verb and names no path.
    expect(parseBulkContract(ledger.getListRun(id)!.contractJson)).toMatchObject({ httpMethods: ['GET'], pathPatterns: [] });
  });

  it('goes on in a later tick from the last id recorded, not from the start', async () => {
    fill(300);
    const id = startedList();
    // The first tick's time runs out once its first page is sent.
    const out1 = await runBulkPreview(id, deps({ now: () => (s.requests.length === 0 ? 0 : 1e12) }));
    expect(out1.status).toBe('pending');
    expect(ledger.getListRun(id)).toMatchObject({ state: 'pending', page: 1, lastId: 2500 });
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(s.requests.map((r) => r.variables['q'])).toEqual(['id:>0', 'id:>2500']);
  });

  it.each([
    ['a page out of id order', (a: number) => (a === 0 ? { data: { products: { nodes: [{ id: gid(20) }, { id: gid(10) }] } } } : undefined), BULK_HALT_REASONS.listOrder],
    ['a GraphQL error the engine has no row for', () => ({ errors: [{ message: 'x', extensions: { code: 'BAD_USER_INPUT' } }], data: null }), BULK_HALT_REASONS.listReadFailed],
    ['a closed store', () => ({ errors: [{ message: 'x', extensions: { code: 'SHOP_INACTIVE' } }] }), BULK_HALT_REASONS.shopInactive],
    ['a document too costly', () => ({ errors: [{ message: 'x', extensions: { code: 'MAX_COST_EXCEEDED' } }] }), BULK_HALT_REASONS.formCost],
    ['nodes that are not a list', () => ({ data: { products: { nodes: {} } } }), BULK_HALT_REASONS.listNotAList],
    ['a full page of unusable ids', () => ({ data: { products: { nodes: Array.from({ length: 250 }, () => ({ id: 'x' })) } } }), BULK_HALT_REASONS.listNoProgress],
  ])('halts on %s, recording nothing of that page', async (_name, answer, reason) => {
    fill(3);
    s.listAnswer = answer;
    const id = startedList();
    const out = await runBulkPreview(id, deps());
    expect(out.status).toBe('halted');
    expect(ledger.getStatus(id)!.haltReason).toBe(reason);
    if (reason !== BULK_HALT_REASONS.listNoProgress) expect(ledger.getStatus(id)!.total).toBe(0);
    expect(out.summary).not.toContain('gid://');
  });
});

describe('reading a listed store\'s before-images', () => {
  async function listed(n: number): Promise<string> {
    fill(n);
    const id = startedList();
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(ledger.resumePreview(id).ok).toBe(true);
    minted = [];
    s.requests.length = 0;
    return id;
  }

  it('reads each product under one grant for the listed targets, its fields made flat over the after-state', async () => {
    const id = await listed(3);
    const out = await runBulkPreview(id, deps());
    expect(out.status).toBe('done');
    expect(minted).toEqual([{ phase: 'read', targets: [gid(10), gid(20), gid(30)] }]);
    expect(s.requests.map((r) => [r.method, r.variables['id']])).toEqual([['POST', gid(10)], ['POST', gid(20)], ['POST', gid(30)]]);
    expect(ledger.getStatus(id)).toMatchObject({ phase: 'previewed', changes: { invalid: 0 } });
    const before = engineDb.getDb().prepare('SELECT before FROM bulk_targets WHERE run_id = ? ORDER BY seq').all(id) as { before: string }[];
    expect(JSON.parse(engineDb.dec(before[0]!.before))).toEqual({ absent: false, value: { seo_title: null } });
  });

  it.each([
    ['a product that is gone', { data: { product: null } }, 'not_found'],
    ['another product', { data: { product: { id: gid(99), seo: { title: 'x' } } } }, 'list_item_mismatch'],
    ['a GraphQL error', { errors: [{ message: 'x', extensions: { code: 'BAD_USER_INPUT' } }] }, 'read_failed'],
  ])('makes the target invalid for %s', async (_name, answer, error) => {
    const id = await listed(2);
    s.productAnswer = (g) => (g === gid(10) ? answer : undefined);
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    const rows = engineDb.getDb().prepare('SELECT change, error FROM bulk_targets WHERE run_id = ? ORDER BY seq').all(id);
    expect(rows).toEqual([{ change: 'invalid', error }, { change: 'update', error: null }]);
  });

  it('halts the run on a closed store', async () => {
    const id = await listed(2);
    s.productAnswer = () => ({ errors: [{ message: 'x', extensions: { code: 'SHOP_INACTIVE' } }] });
    expect((await runBulkPreview(id, deps())).status).toBe('halted');
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.shopInactive);
    expect(s.requests).toHaveLength(1);
  });
});

describe('a listed store with an unusable id', () => {
  it('reads only the listed products: an invalid target is no key the read grant is minted for', async () => {
    fill(2);
    s.listAnswer = (a) => (a === 0 ? { data: { products: { nodes: [{ id: gid(10) }, { id: 'nope' }, { id: gid(20) }] } } } : undefined);
    const id = startedList();
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(ledger.resumePreview(id).ok).toBe(true);
    minted = [];
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(minted).toEqual([{ phase: 'read', targets: [gid(10), gid(20)] }]);
    expect(ledger.getStatus(id)).toMatchObject({ phase: 'previewed', invalidReasons: { list_item_bad_id: 1 } });
  });
});

describe('the worker\'s client for a Shopify run', () => {
  type Factory = (run: Pick<BulkRunForPreview, 'id' | 'targetSystem' | 'contractJson' | 'delegatedPlanner'>, listQuery?: ListQueryConstraints, shopifyRead?: ShopifyReadPhase) => ExternalClient | null;

  it('grants exactly the reads it was handed, on a copy of the stored contract', async () => {
    const id = startedList();
    const engine = { getApiStore: () => new ApiStore(), getSecretStore: () => new SecretStore(), getToolContext: () => createToolContext({}), getAuditLog: () => null };
    const factory = await (WorkerLoop.prototype as unknown as { bulkClientFactory: (this: unknown) => Promise<Factory> }).bulkClientFactory.call({ engine });
    const run = { id, targetSystem: `http:${HOST}`, contractJson: ledger.getListRun(id)!.contractJson, delegatedPlanner: null };
    const page0 = { form: 'shopify_products_list', afterId: 0 } as const;
    const read10 = { form: 'shopify_product_read', gid: gid(10) } as const;
    // Past the grant: what stops it is the missing stored credential, nothing is sent.
    expect(await factory(run, undefined, { phase: 'list', afterId: 0 })!.graphqlRead(ENDPOINT, page0)).toEqual({ kind: 'no_credential' });
    expect(await factory(run, undefined, { phase: 'read', targets: [gid(10)] })!.graphqlRead(ENDPOINT, read10)).toEqual({ kind: 'no_credential' });
    // The stored contract alone grants no read; a grant holds its own body and no other.
    expect(await factory(run)!.graphqlRead(ENDPOINT, page0)).toEqual({ kind: 'not_granted' });
    expect(await factory(run, undefined, { phase: 'list', afterId: 5 })!.graphqlRead(ENDPOINT, page0)).toEqual({ kind: 'not_granted' });
    expect(await factory(run, undefined, { phase: 'read', targets: [gid(20)] })!.graphqlRead(ENDPOINT, read10)).toEqual({ kind: 'not_granted' });
    expect(await factory(run, undefined, { phase: 'list', afterId: 0 })!.graphqlRead(ENDPOINT, read10)).toEqual({ kind: 'not_granted' });
    // A grant it cannot mint — no store host, a key that is no product — is no client at all.
    expect(factory({ ...run, targetSystem: 'http:shop.example.com' }, undefined, { phase: 'list', afterId: 0 })).toBeNull();
    expect(factory({ ...run, targetSystem: 'workspace' }, undefined, { phase: 'list', afterId: 0 })).toBeNull();
    expect(factory(run, undefined, { phase: 'read', targets: ['https://acme.myshopify.com/x'] })).toBeNull();
    expect(s.requests).toEqual([]);
  });
});

describe('the switch', () => {
  it('halts a run on its next tick once it is off, before anything is minted or sent — in the list and in the reads', async () => {
    fill(3);
    const id = startedList();
    expect((await runBulkPreview(id, deps({ shopifyEnabled: () => false }))).status).toBe('halted');
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.shopifyReadOff);
    expect(minted).toEqual([]);
    expect(s.requests).toEqual([]);

    const id2 = (() => { engineDb.getDb().prepare('DELETE FROM bulk_runs').run(); return startedList(); })();
    expect((await runBulkPreview(id2, deps())).status).toBe('done');
    expect(ledger.resumePreview(id2).ok).toBe(true);
    minted = [];
    s.requests.length = 0;
    expect((await runBulkPreview(id2, deps({ shopifyEnabled: () => false }))).status).toBe('halted');
    expect(ledger.getStatus(id2)!.haltReason).toBe(BULK_HALT_REASONS.shopifyReadOff);
    expect(minted).toEqual([]);
    expect(s.requests).toEqual([]);
  });

  it('is the engine flag when the worker gives no answer of its own', async () => {
    fill(3);
    const id = startedList();
    vi.stubEnv(FLAG, '0');
    try {
      expect((await runBulkPreview(id, deps({ shopifyEnabled: undefined }))).status).toBe('halted');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.shopifyReadOff);
  });
});

describe('bulk_plan with a Shopify source', () => {
  const agent = (): IAgent => ({ toolContext: { bulkLedger: ledger }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL }) as unknown as IAgent;
  const plan = (input: Record<string, unknown>): Promise<string> => bulkPlanTool.handler(
    { target_system: 'http', target_host: HOST, source_list: { form: 'shopify', after: { title: 'x' } }, ...input } as Parameters<typeof bulkPlanTool.handler>[0], agent(),
  );

  it('records the run with the switch on, and refuses it with the switch off', async () => {
    vi.stubEnv(FLAG, '1');
    try {
      expect(await plan({})).toMatch(/List dry run recorded/);
    } finally {
      vi.unstubAllEnvs();
    }
    engineDb.getDb().prepare('DELETE FROM bulk_runs').run();
    expect(await plan({})).toMatch(/switched off on this instance/);
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 0 });
  });

  it('refuses a judge and a write method', async () => {
    vi.stubEnv(FLAG, '1');
    try {
      expect(await plan({ judge: { rule: 'r', fields: { title: { type: 'string' } } } })).toMatch(/does not take judge/);
      expect(await plan({ write_method: 'PATCH' })).toMatch(/does not take write_method/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 0 });
  });
});

// Only the bulk client factory mints a Shopify read grant: any other caller would be a way to a
// store's GraphQL API outside a bulk run's ledger rows.
describe('who mints a Shopify read grant', () => {
  const CALLER = /\bwithShopifyRead\s*\(/g;
  function sources(d: string): string[] {
    return readdirSync(d).flatMap((name) => {
      const p = join(d, name);
      if (statSync(p).isDirectory()) return sources(p);
      return /\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name) ? [p] : [];
    });
  }

  it('matches the call shapes it looks for', () => {
    expect('x = withShopifyRead(a, b, c)'.match(CALLER)).toHaveLength(1);
    expect('withShopifyRead (a)'.match(CALLER)).toHaveLength(1);
    expect('export function withShopifyRead(contract'.match(CALLER)).toHaveLength(1);
  });

  it('is the worker\'s bulk client factory, and nothing else', () => {
    const root = join(__dirname, '..');
    const found: Record<string, number> = {};
    for (const f of sources(root)) {
      const n = readFileSync(f, 'utf8').match(CALLER)?.length ?? 0;
      if (n > 0) found[f.slice(root.length + 1)] = n;
    }
    // The definition, and the one call in `bulkClientFactory`.
    expect(found).toEqual({ 'tools/permission-guard.ts': 1, 'core/worker-loop.ts': 1 });
  });
});
