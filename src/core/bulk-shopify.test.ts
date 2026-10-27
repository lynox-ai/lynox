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
import { BulkHostBudget, externalClient, externalWriter, graphqlWriteAnswer, parseBulkContract, type ExternalClient, type ExternalRead } from './bulk-external.js';
import {
  BULK_LIST_FORMS, SHOPIFY_FILTERED_LIST_FORM, isOfferedListSource, listPageUrl, listQueryParams, listReadContract, maxListPages, parseListSource,
  shopifyListFiltersOf, type BulkListSource,
} from './bulk-list.js';
import { runBulkPreview, type BulkPreviewDeps } from './bulk-preview.js';
import { bulkWriterFor, runBulkEffect } from './bulk-apply.js';
import { shopifyBeforeImage, shopifyListPage, shopifyPairedAfter, shopifyTargetIo } from './bulk-shopify.js';
import { shopifyProductWriteBody } from './shopify-graphql.js';
import { createToolContext } from './tool-context.js';
import { ApiStore } from './api-store.js';
import { SecretStore } from './secret-store.js';
import { WorkerLoop } from './worker-loop.js';
import { mintStorePass } from './store-pass.js';
import { withListQuery, withShopifyApply, withShopifyRead, type ListQueryConstraints, type ShopifyReadPhase } from '../tools/permission-guard.js';
import { bulkPlanTool } from '../tools/builtin/bulk.js';
import ts from 'typescript';
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

  it('leaves out, on a full page only, the unusable nodes after its last product: the next page holds them again', () => {
    const full = [...Array.from({ length: 248 }, (_, i) => ({ id: gid(i + 5) })), { id: 'x' }, { id: 'y' }];
    const got = shopifyListPage(page(...full), 4);
    expect(got).toMatchObject({ kind: 'page', lastId: 252, count: 250 });
    expect(got.kind === 'page' && got.items).toHaveLength(248);
    // Not on a short page, which is the last one, and not before the last product.
    expect(shopifyListPage(page({ id: gid(5) }, { id: 'x' }), 4)).toMatchObject({ items: [{ key: gid(5), id: gid(5) }, { invalid: 'list_item_bad_id' }] });
    const middle = [{ id: 'x' }, ...Array.from({ length: 249 }, (_, i) => ({ id: gid(i + 5) }))];
    expect(shopifyListPage(page(...middle), 4)).toMatchObject({ items: expect.arrayContaining([{ invalid: 'list_item_bad_id' }]) });
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
    const s = parse({ form: 'shopify', after: { seo_title: 'New', title: 'T' } });
    expect(s).toEqual({ form: 'shopify', path: '', filters: {}, idField: 'id', method: null, after: { seo_title: 'New', title: 'T' } });
    expect(isOfferedListSource(s)).toBe(true);
    expect(isOfferedListSource({ ...s, path: '/admin' })).toBe(false);
    expect(isOfferedListSource({ ...s, method: 'PATCH' })).toBe(false);
    // Filters belong to the filtered form only: under `shopify` they would be read as every product.
    expect(isOfferedListSource({ ...s, filters: { vendor: 'Acme' } })).toBe(false);
  });

  it('is refused off a store host, with a path or id field, and for a field the before-image has not', () => {
    expect(() => parse({ form: 'shopify', after: { title: 'x' } }, 'shop.example.com')).toThrow(/<store>\.myshopify\.com/);
    expect(() => parse({ form: 'shopify', after: { title: 'x' } }, 'admin.shopify.com')).toThrow(/<store>\.myshopify\.com/);
    for (const key of ['path', 'id_field']) {
      expect(() => parse({ form: 'shopify', [key]: 'x', after: { title: 'x' } }), key).toThrow(new RegExp(`source_list\\.${key} is not given`));
    }
    expect(() => parse({ form: 'shopify', after: { title: 'x', vendor: 'y' } })).toThrow(/may only set: title, seo_title, seo_description\./);
    expect(() => parse({ form: 'shopify', after: { id: 'x' } })).toThrow(/must not set the id field/);
    expect(() => parse({ form: 'shopify', after: {} })).toThrow(/non-empty object/);
  });

  it('does not write a description yet, and says the way on', () => {
    expect(() => parse({ form: 'shopify', after: { descriptionHtml: '<p>y</p>' } })).toThrow(/cannot set descriptionHtml yet: writing product descriptions comes with a later step of the Shopify form\. Set only: title, seo_title, seo_description\./);
    expect(() => parse({ form: 'shopify', after: { title: 'x', descriptionHtml: null } })).toThrow(/cannot set descriptionHtml yet/);
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
  /** Answer a product write with this instead of applying it. */
  writeAnswer?: (id: string) => unknown;
  /** Product number → its product type and vendor, for a filtered list; a product not here has neither. */
  groups?: Map<number, { product_type?: string; vendor?: string }>;
}

/** A write's variables applied to a product the way Shopify applies `productUpdate`. */
function applyWrite(p: Record<string, unknown>, v: Record<string, unknown>): void {
  if ('title' in v) p['title'] = v['title'];
  if ('descriptionHtml' in v) p['descriptionHtml'] = v['descriptionHtml'];
  if ('seoTitle' in v || 'seoDescription' in v) p['seo'] = { title: v['seoTitle'] ?? null, description: v['seoDescription'] ?? null };
}

function store(n: number): Store {
  const s: Store = { products: new Map(), requests: [] };
  for (let i = 1; i <= n; i++) s.products.set(i * 10, { title: `T${String(i)}`, descriptionHtml: `<p>${String(i)}</p>`, seo: { title: null, description: `D${String(i)}` } });
  return s;
}

function serve(s: Store): () => void {
  vi.mocked(dns.lookup).mockResolvedValue([{ address: '23.227.38.65', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
  return setPinnedTransportForTests(async (req) => {
    const body = JSON.parse(req.body?.toString('utf8') ?? '{}') as { query?: string; variables?: Record<string, unknown> };
    const variables = body.variables ?? {};
    s.requests.push({ method: req.method, url: req.url, variables });
    if (body.query?.startsWith('mutation') === true) {
      const id = variables['id'] as string;
      const special = s.writeAnswer?.(id);
      if (special !== undefined) return new Response(JSON.stringify(special), { status: 200 });
      const p = s.products.get(Number(id.slice(id.lastIndexOf('/') + 1)));
      if (p !== undefined) applyWrite(p, variables);
      return new Response(JSON.stringify({ data: { productUpdate: { product: p === undefined ? null : { id }, userErrors: [] } } }), { status: 200 });
    }
    if (typeof variables['q'] === 'string') {
      // The search as the store reads it, strictly: a `$q` of another shape fails the test.
      const m = /^id:>(\d+)((?: AND (?:product_type|vendor):"[^"]*")*)$/.exec(variables['q'])!;
      const afterId = Number(m[1]);
      const terms = [...m[2]!.matchAll(/ AND (product_type|vendor):"([^"]*)"/g)].map((t) => [t[1] as 'product_type' | 'vendor', t[2]!] as const);
      const special = s.listAnswer?.(afterId);
      if (special !== undefined) return new Response(JSON.stringify(special), { status: 200 });
      // Matched like Shopify matches a quoted value: whole value, letter case ignored (measured, M-F1).
      const inGroup = (id: number): boolean => terms.every(([k, v]) => s.groups?.get(id)?.[k]?.toLowerCase() === v.toLowerCase());
      const ids = [...s.products.keys()].filter((id) => id > afterId && inGroup(id)).sort((a, b) => a - b).slice(0, variables['n'] as number);
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

function startedList(src: BulkListSource = source()): string {
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
    expect(minted).toEqual([{ phase: 'list', afterId: 0, filters: {} }, { phase: 'list', afterId: 2500, filters: {} }]);
    const list = ledger.getListRun(id)!;
    expect(list).toMatchObject({ state: 'done', page: 2, lastId: 3000, calls: 2 });
    expect(ledger.getStatus(id)).toMatchObject({ total: 300, phase: 'planned', haltReason: BULK_HALT_REASONS.listed, writeForm: 'unmeasured' });
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

describe('reading a store\'s product list narrowed by a filter', () => {
  const filtered = (filters: Record<string, string>): BulkListSource =>
    parseListSource(HOST, { form: 'shopify', filters, after: { seo_title: 'New title' } }, 'PATCH', scan);
  /** Products 10..60; 20, 40 and 60 are tees, 40 and 60 of Acme, 50 an Acme mug. */
  function groups(): void {
    fill(6);
    s.groups = new Map([[20, { product_type: 'Tee' }], [40, { product_type: 'Tee', vendor: 'Acme' }], [50, { product_type: 'Mug', vendor: 'Acme' }], [60, { product_type: 'Tee', vendor: 'Acme' }]]);
  }
  /** Replace a planned run's stored source, then start it under the checksum of what is now stored. */
  function storedAs(id: string, src: unknown): void {
    engineDb.getDb().prepare('UPDATE bulk_runs SET list_source = ? WHERE id = ?').run(engineDb.enc(JSON.stringify(src)), id);
  }
  function planned(src: BulkListSource): string {
    const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source: src, readContract: listReadContract(HOST, src) });
    if (!out.ok) throw new Error(out.reason);
    return out.status.id;
  }
  function start(id: string): void {
    const started = ledger.resumePreview(id, Date.now(), { listChecksum: ledger.listStartChecksum(id)! });
    if (!started.ok) throw new Error(started.reason);
  }

  it('is stored under the filtered form, and sends the filter in $q of every page and every grant', async () => {
    groups();
    const src = filtered({ vendor: 'Acme', product_type: 'Tee' });
    expect(src).toEqual({ form: SHOPIFY_FILTERED_LIST_FORM, path: '', filters: { vendor: 'Acme', product_type: 'Tee' }, idField: 'id', method: null, after: { seo_title: 'New title' } });
    const id = startedList(src);
    const out = await runBulkPreview(id, deps());
    expect(out.status).toBe('done');
    // product_type before vendor, whatever order the planner wrote them in.
    expect(s.requests.map((r) => r.variables['q'])).toEqual(['id:>0 AND product_type:"Tee" AND vendor:"Acme"']);
    expect(minted).toEqual([{ phase: 'list', afterId: 0, filters: { vendor: 'Acme', product_type: 'Tee' } }]);
    expect(ledger.externalTargetKeys(id)).toEqual([gid(40), gid(60)]);
  });

  it('pages on from the last id with the same filter', async () => {
    fill(300);
    s.groups = new Map([...s.products.keys()].map((k) => [k, { product_type: 'Tee' }]));
    const id = startedList(filtered({ product_type: 'Tee' }));
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(s.requests.map((r) => r.variables['q'])).toEqual(['id:>0 AND product_type:"Tee"', 'id:>2500 AND product_type:"Tee"']);
  });

  it.each([
    [{ product_type: 'Hoodie Secret' }, 'product types'],
    [{ vendor: 'Hoodie Secret' }, 'vendors'],
    [{ product_type: 'Tee', vendor: 'Hoodie Secret' }, 'product types and vendors'],
  ])('says that no product matched %j, against what it names and without the value', async (filters, against) => {
    groups();
    const out = await runBulkPreview(startedList(filtered(filters)), deps());
    expect(out.status).toBe('done');
    expect(out.summary).toContain(`no product matched the list's filter; check its value against the store's ${against}. Tell the user in one sentence which value matched no product.`);
    expect(out.summary).not.toContain('Hoodie');
  });

  it('keeps the sentence of an empty list without a filter', async () => {
    const all = startedList();
    const summary = (await runBulkPreview(all, deps())).summary;
    expect(summary).toContain('the list holds no target that could be planned.');
    expect(summary).not.toContain('no product matched');
  });

  it.each([
    ['a value the rule no longer takes', { form: SHOPIFY_FILTERED_LIST_FORM, filters: { vendor: 'Acme OR x' } }, BULK_HALT_REASONS.listFilterWithdrawn],
    ['a key the rule does not know', { form: SHOPIFY_FILTERED_LIST_FORM, filters: { tag: 'Acme' } }, BULK_HALT_REASONS.listFilterWithdrawn],
    ['no filter at all', { form: SHOPIFY_FILTERED_LIST_FORM, filters: {} }, BULK_HALT_REASONS.listFilterWithdrawn],
    ['filters under the unfiltered form', { form: 'shopify', filters: { vendor: 'Acme' } }, BULK_HALT_REASONS.listFormWithdrawn],
  ])('halts before anything is minted or sent on a stored source with %s', async (_name, change, reason) => {
    groups();
    const id = planned(filtered({ vendor: 'Acme' }));
    storedAs(id, { ...filtered({ vendor: 'Acme' }), ...change });
    start(id);
    const out = await runBulkPreview(id, deps());
    expect(out.status).toBe('halted');
    expect(ledger.getStatus(id)!.haltReason).toBe(reason);
    expect(minted).toEqual([]);
    expect(s.requests).toEqual([]);
  });

  it('is refused by an engine from before the filter, which read a shopify source as every product', () => {
    // isOfferedListSource as it stood before the filtered form, verbatim but for the import names:
    // the filtered form is neither `shopify` nor a list form of its own, so the old engine halts.
    const before = (source: BulkListSource): boolean => {
      if (source.form === 'shopify') return source.path === '' && source.method === null;
      return Object.hasOwn(BULK_LIST_FORMS, source.form) && BULK_LIST_FORMS[source.form as keyof typeof BULK_LIST_FORMS].path.test(source.path);
    };
    expect(before(filtered({ vendor: 'Acme' }))).toBe(false);
    expect(before(source())).toBe(true);
  });

  it('binds the start checksum to the filter, in both directions', () => {
    const id = planned(filtered({ vendor: 'Acme' }));
    const shown = ledger.listStartChecksum(id)!;
    // Another value, no filter, and back to the shown one.
    storedAs(id, filtered({ vendor: 'Acmf' }));
    expect(ledger.listStartChecksum(id)).not.toBe(shown);
    expect(ledger.resumePreview(id, Date.now(), { listChecksum: shown })).toEqual({ ok: false, reason: 'checksum' });
    storedAs(id, source());
    expect(ledger.listStartChecksum(id)).not.toBe(shown);
    // Back to the source as recorded: the shown checksum holds again.
    storedAs(id, ledger.getListRun(planned(filtered({ vendor: 'Acme' })))!.source);
    expect(ledger.listStartChecksum(id)).toBe(shown);
    // And an unfiltered run's checksum moves when a filter is added.
    const all = planned(source());
    const shownAll = ledger.listStartChecksum(all)!;
    storedAs(all, filtered({ vendor: 'Acme' }));
    expect(ledger.resumePreview(all, Date.now(), { listChecksum: shownAll })).toEqual({ ok: false, reason: 'checksum' });
  });

  it('shows the owner the filters of a filtered list only', () => {
    expect(shopifyListFiltersOf({ source: filtered({ product_type: 'Tee', vendor: 'Acme' }) })).toEqual({ product_type: 'Tee', vendor: 'Acme' });
    expect(shopifyListFiltersOf({ source: source() })).toBeNull();
    expect(shopifyListFiltersOf(null)).toBeNull();
  });
});

describe('the cost a list read states', () => {
  it('counts every request of the tick, the page that ends it included', async () => {
    fill(300);
    s.listAnswer = (a) => (a > 0 ? { errors: [{ message: 'x', extensions: { code: 'THROTTLED' } }] } : undefined);
    const id = startedList();
    const out = await runBulkPreview(id, deps({ costPerCallUsd: 0.01 }));
    expect(out.status).toBe('pending');
    expect(s.requests).toHaveLength(2);
    expect(out.summary).toContain('2 API calls this tick');
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
    expect(JSON.parse(engineDb.dec(before[0]!.before))).toEqual({ absent: false, value: { seo_title: null, seo_description: 'D1' } });
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
    const page0 = { form: 'shopify_products_list', afterId: 0, filters: {} } as const;
    const read10 = { form: 'shopify_product_read', gid: gid(10) } as const;
    // Past the grant: what stops it is the missing stored credential, nothing is sent.
    expect(await factory(run, undefined, { phase: 'list', afterId: 0, filters: {} })!.graphqlRead(ENDPOINT, page0)).toEqual({ kind: 'no_credential' });
    expect(await factory(run, undefined, { phase: 'read', targets: [gid(10)] })!.graphqlRead(ENDPOINT, read10)).toEqual({ kind: 'no_credential' });
    // The stored contract alone grants no read; a grant holds its own body and no other.
    expect(await factory(run)!.graphqlRead(ENDPOINT, page0)).toEqual({ kind: 'not_granted' });
    expect(await factory(run, undefined, { phase: 'list', afterId: 5, filters: {} })!.graphqlRead(ENDPOINT, page0)).toEqual({ kind: 'not_granted' });
    expect(await factory(run, undefined, { phase: 'read', targets: [gid(20)] })!.graphqlRead(ENDPOINT, read10)).toEqual({ kind: 'not_granted' });
    expect(await factory(run, undefined, { phase: 'list', afterId: 0, filters: {} })!.graphqlRead(ENDPOINT, read10)).toEqual({ kind: 'not_granted' });
    // A grant it cannot mint — no store host, a key that is no product — is no client at all.
    expect(factory({ ...run, targetSystem: 'http:shop.example.com' }, undefined, { phase: 'list', afterId: 0, filters: {} })).toBeNull();
    expect(factory({ ...run, targetSystem: 'workspace' }, undefined, { phase: 'list', afterId: 0, filters: {} })).toBeNull();
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

  it('records a filtered list under its own form, and does not take that form as input', async () => {
    vi.stubEnv(FLAG, '1');
    try {
      expect(await plan({ source_list: { form: 'shopify', filters: { product_type: 'Tee' }, after: { title: 'x' } } })).toMatch(/List dry run recorded/);
      const id = (engineDb.getDb().prepare('SELECT id FROM bulk_runs').get() as { id: string }).id;
      expect(ledger.getListRun(id)!.source).toMatchObject({ form: SHOPIFY_FILTERED_LIST_FORM, filters: { product_type: 'Tee' } });
      engineDb.getDb().prepare('DELETE FROM bulk_runs').run();
      // The stored form is no input: it would skip the filter checks of the shopify form.
      expect(await plan({ source_list: { form: SHOPIFY_FILTERED_LIST_FORM, filters: { product_type: 'Tee' }, after: { title: 'x' } } })).toMatch(/source_list\.form must be one of: woocommerce, shopify\./);
      expect(await plan({ source_list: { form: 'shopify', filters: { product_type: 'Tee OR Mug' }, after: { title: 'x' } } })).toMatch(/OR, AND, NOT are not allowed as words/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 0 });
  });

  it('refuses a judge and a write method', async () => {
    vi.stubEnv(FLAG, '1');
    try {
      expect(await plan({ judge: { rule: 'r', fields: { title: { type: 'string' } } } })).toMatch(/does not take judge/);
      expect(await plan({ write_method: 'PATCH' })).toMatch(/does not take write_method/);
      expect(await plan({ source_list: { form: 'shopify', after: { descriptionHtml: '<p>x</p>' } } })).toMatch(/descriptions comes with a later step/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 0 });
  });
});

// Only the bulk client factory mints a Shopify read grant, and only the preview writes out what it
// grants: any other caller would be a way to a store's GraphQL API outside a bulk run's ledger rows.
// Read from the syntax tree, so a comment neither counts nor hides anything. It is a tripwire, not
// the boundary: that is what `withShopifyRead` checks in what it is handed.
describe('who mints a Shopify read grant', () => {
  const NAME = 'withShopifyRead';
  interface Found { mint: number; phase: number }
  function sources(d: string): string[] {
    return readdirSync(d).flatMap((name) => {
      const p = join(d, name);
      if (statSync(p).isDirectory()) return sources(p);
      return /\.(?:ts|mts|cts|tsx)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name) ? [p] : [];
    });
  }
  const nameOf = (n: ts.PropertyName | ts.BindingName | undefined): string | null =>
    n !== undefined && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : null;
  /** Every identifier or string that names the minting function (an alias, a destructure, a
   *  property, a re-export, an escape: the parser decodes it), and every object or type literal
   *  that has a `phase` with an `afterId` or `targets` — a read phase written out, in any order or
   *  quoting, shorthand included. */
  function scan(file: string, text: string): Found {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const found: Found = { mint: 0, phase: 0 };
    const visit = (node: ts.Node): void => {
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text.includes(NAME)) found.mint++;
      if (ts.isObjectLiteralExpression(node) || ts.isTypeLiteralNode(node)) {
        const members: readonly ts.Node[] = ts.isObjectLiteralExpression(node) ? node.properties : node.members;
        const names = new Set(members.map((m) => nameOf((m as { name?: ts.PropertyName }).name)));
        if (names.has('phase') && (names.has('afterId') || names.has('targets'))) found.phase++;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }
  function count(key: keyof Found): Record<string, number> {
    const root = join(__dirname, '..');
    const out: Record<string, number> = {};
    for (const f of sources(root)) {
      const n = scan(f, readFileSync(f, 'utf8'))[key];
      if (n > 0) out[f.slice(root.length + 1)] = n;
    }
    return out;
  }

  it('sees a call, an alias, a destructure, a property, a re-export and an escape — and not a comment', () => {
    for (const text of ['x = withShopifyRead(a, b, c)', "import { withShopifyRead as g } from './p.js'", 'const { withShopifyRead: w } = await import(m)', "pg['withShopifyRead'](a)", 'export { withShopifyRead } from "./p.js"', 'with\\u0053hopifyRead(a)']) {
      expect(scan('x.ts', text).mint, text).toBe(1);
    }
    expect(scan('x.ts', "const t = 'image/*'; withShopifyRead(a); // */\nconst u = 'a//b'; withShopifyRead(b);").mint).toBe(2);
    expect(scan('x.ts', '// withShopifyRead(a)\n/* withShopifyRead */ x').mint).toBe(0);
  });

  it('sees a read phase written out in any order, quoting or shorthand, and not another phase', () => {
    for (const text of ["f({ phase: 'list', afterId: n })", 'f({ targets: keys, "phase": "read" })', 'f({ phase, targets })', "type P = { readonly phase: 'list'; readonly afterId: number }"]) {
      expect(scan('x.ts', text).phase, text).toBe(1);
    }
    expect(scan('x.ts', "log.record({ phase: 'read', runId })").phase).toBe(0);
  });

  it('is named by its definition and the worker\'s bulk client contract, and nothing else', () => {
    // permission-guard: the definition. bulk-external-writer: the import from it and the one call
    // in `bulkRunContract`, which only the worker's bulk client factory calls.
    expect(count('mint')).toEqual({ 'tools/permission-guard.ts': 1, 'core/bulk-external-writer.ts': 2 });
    const callers = sources(join(__dirname, '..')).filter((f) => /\bbulkRunContract\b/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(join(__dirname, '..').length + 1));
    expect(callers.sort()).toEqual(['core/bulk-external-writer.ts', 'core/worker-loop.ts']);
  });

  it('is handed a phase written out only by the preview, at its two places', () => {
    // permission-guard: the two members of the phase type. bulk-preview: the list page and the read.
    expect(count('phase')).toEqual({ 'tools/permission-guard.ts': 2, 'core/bulk-preview.ts': 2 });
  });
});

describe('shopifyPairedAfter', () => {
  const value = { title: 'T', seo_title: 'ST', seo_description: 'SD' };

  it('adds the other seo field at its value when the after-state sets only one', () => {
    expect(shopifyPairedAfter({ seo_title: 'N' }, value)).toEqual({ seo_title: 'N', seo_description: 'SD' });
    expect(shopifyPairedAfter({ title: 'x', seo_description: 'N' }, value)).toEqual({ title: 'x', seo_description: 'N', seo_title: 'ST' });
    expect(shopifyPairedAfter({ seo_title: 'N' }, { seo_description: null })).toEqual({ seo_title: 'N', seo_description: null });
  });

  it('returns the after-state itself when both or neither are set', () => {
    for (const after of [{ title: 'x' }, { seo_title: 'a', seo_description: 'b' }]) expect(shopifyPairedAfter(after, value)).toBe(after);
  });

  it('adds a partner the product does not hold as missing', () => {
    const got = shopifyPairedAfter({ seo_title: 'N' }, { title: 'T' });
    expect(Object.hasOwn(got, 'seo_description')).toBe(true);
    expect(got['seo_description']).toBeUndefined();
  });
});

describe('the seo pair of a Shopify run', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const read = async (): Promise<string> => {
    vi.stubEnv(FLAG, '1');
    const id = startedList();
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(ledger.resumePreview(id).ok).toBe(true);
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    return id;
  };
  const targets = (id: string): { seq: number; key: string; change: string; error: string | null }[] =>
    (engineDb.getDb().prepare('SELECT seq, target_key, change, error FROM bulk_targets WHERE run_id = ? ORDER BY seq').all(id) as { seq: number; target_key: string; change: string; error: string | null }[])
      .map((r) => ({ seq: r.seq, key: engineDb.dec(r.target_key), change: r.change, error: r.error }));

  it('is completed from the product before the run is approved, so the write sends both', async () => {
    fill(2);
    const id = await read();
    const [first, second] = targets(id);
    expect([first!.change, second!.change]).toEqual(['update', 'update']);
    const after = ledger.loadTarget(id, first!.seq)!.after;
    expect(after).toEqual({ absent: false, value: { seo_title: 'New title', seo_description: 'D1' } });
    expect(shopifyProductWriteBody(first!.key, (after as { value: Record<string, unknown> }).value)).not.toBeNull();
    expect(ledger.loadTarget(id, second!.seq)!.after).toEqual({ absent: false, value: { seo_title: 'New title', seo_description: 'D2' } });
  });

  it('is classified against the completed after-state: a product that holds it already is unchanged', async () => {
    fill(2);
    s.products.set(10, { ...s.products.get(10)!, seo: { title: 'New title', description: 'D1' } });
    const id = await read();
    expect(targets(id).map((t) => t.change)).toEqual(['unchanged', 'update']);
  });

  it('makes a product that holds no seo invalid, not a write of one field', async () => {
    fill(2);
    s.products.set(10, { ...s.products.get(10)!, seo: null });
    const id = await read();
    expect(targets(id).map((t) => [t.change, t.error])).toEqual([['invalid', 'field_missing'], ['update', null]]);
  });

  it('is completed in a judge\'s verdict too, which may set one seo field', async () => {
    fill(1);
    const id = await read();
    // No judge runs on a store yet (`bulk_plan` refuses one); the ledger completes a verdict regardless.
    engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'planned', halt_reason = NULL WHERE id = ?`).run(id);
    const [only] = targets(id);
    expect(ledger.claimJudge(id, only!.seq, 't', Date.now(), 60_000)).toBe(true);
    expect(ledger.recordJudgement(id, only!.seq, 't', { after: { seo_title: 'Judged' } })).toBe(true);
    expect(ledger.loadTarget(id, only!.seq)!.after).toEqual({ absent: false, value: { seo_title: 'Judged', seo_description: 'D1' } });
    expect(targets(id)[0]!.change).toBe('update');
  });
});

describe('applying a Shopify run', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const previewed = async (): Promise<string> => {
    vi.stubEnv(FLAG, '1');
    const id = startedList();
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(ledger.resumePreview(id).ok).toBe(true);
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    return id;
  };
  /** The worker's writer: the run's stored contract, granted the run's own reads and writes. */
  const apply = (id: string, effect: 'bulk_apply' | 'bulk_undo' = 'bulk_apply'): Promise<{ status: string }> => runBulkEffect(id, effect, {
    ledger, trailFor: () => null,
    writerFor: (run) => bulkWriterFor(run, null, (r) => {
      const granted = ledger.shopifyApplyOf(r.id);
      const stored = r.contractJson === null ? null : parseBulkContract(r.contractJson);
      if (granted === null || stored === null) return null;
      const c = client(withShopifyApply(stored, HOST, granted));
      return externalWriter(c, { sleep: async () => {}, io: shopifyTargetIo(c, ENDPOINT) });
    }),
  });
  const writes = (): Record<string, unknown>[] => s.requests.filter((r) => 'seoTitle' in r.variables).map((r) => r.variables);

  it('writes its probe, one product with the whole seo pair, and goes wide only after this run\'s probe is confirmed', async () => {
    fill(3);
    const id = await previewed();
    expect(ledger.approve(id, { checksum: ledger.computeChecksum(id)!, unmeasuredConfirmed: true, maxTargets: 1 })).toMatchObject({ ok: true });
    s.requests.length = 0;
    await apply(id);
    expect(writes()).toEqual([{ id: gid(10), seoTitle: 'New title', seoDescription: 'D1' }]);
    expect(s.products.get(10)!['seo']).toEqual({ title: 'New title', description: 'D1' });
    expect(s.products.get(20)!['seo']).toEqual({ title: null, description: 'D2' });

    const checksum = ledger.computeChecksum(id)!;
    expect(ledger.resume(id, { checksum, maxTargets: 3 })).toEqual({ ok: false, reason: 'probe_required' });
    expect(ledger.confirmProbe(id)).toEqual({ ok: true });
    expect(ledger.resume(id, { checksum, maxTargets: 3 })).toMatchObject({ ok: true });
    await apply(id);
    expect(writes().map((w) => w['id'])).toEqual([gid(10), gid(20), gid(30)]);
    expect(s.products.get(30)!['seo']).toEqual({ title: 'New title', description: 'D3' });
  });

  it('does not lend its probe to another run on the same store', async () => {
    fill(2);
    const first = await previewed();
    ledger.approve(first, { checksum: ledger.computeChecksum(first)!, unmeasuredConfirmed: true, maxTargets: 1 });
    await apply(first);
    expect(ledger.confirmProbe(first)).toEqual({ ok: true });
    s.products.set(10, { ...s.products.get(10)!, seo: { title: null, description: 'D1' } });
    engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'done' WHERE id = ?`).run(first);
    const second = await previewed();
    expect(ledger.approve(second, { checksum: ledger.computeChecksum(second)!, unmeasuredConfirmed: true, maxTargets: 2 })).toEqual({ ok: false, reason: 'probe_required' });
  });

  it('records a write the store refuses with userErrors as refused, and the product as it was', async () => {
    fill(1);
    s.writeAnswer = () => ({ data: { productUpdate: { product: null, userErrors: [{ field: ['seo'], message: 'nope' }] } } });
    const id = await previewed();
    ledger.approve(id, { checksum: ledger.computeChecksum(id)!, unmeasuredConfirmed: true, maxTargets: 1 });
    await apply(id);
    expect(s.products.get(10)!['seo']).toEqual({ title: null, description: 'D1' });
    // Refused, not unclear: the store said it did not write, so nothing waits to be checked.
    expect(ledger.getStatus(id)).toMatchObject({ applied: 0, failed: 1, sentUnknown: 0 });
  });

  it('halts a run approved before the switch went off, before anything is sent', async () => {
    fill(2);
    const id = await previewed();
    expect(ledger.approve(id, { checksum: ledger.computeChecksum(id)!, unmeasuredConfirmed: true, maxTargets: 1 })).toMatchObject({ ok: true });
    vi.stubEnv(FLAG, '0');
    s.requests.length = 0;
    expect((await apply(id)).status).toBe('refused');
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.shopifyWriteOff);
    expect(s.requests).toEqual([]);
    expect(s.products.get(10)!['seo']).toEqual({ title: null, description: 'D1' });
  });

  it('takes back what it wrote, both seo fields, beyond one target and with the switch off', async () => {
    fill(2);
    const id = await previewed();
    ledger.approve(id, { checksum: ledger.computeChecksum(id)!, unmeasuredConfirmed: true, maxTargets: 1 });
    await apply(id);
    expect(ledger.confirmProbe(id)).toEqual({ ok: true });
    expect(ledger.resume(id, { checksum: ledger.computeChecksum(id)!, maxTargets: 2 })).toMatchObject({ ok: true });
    await apply(id);
    expect(s.products.get(20)!['seo']).toEqual({ title: 'New title', description: 'D2' });

    const undo = ledger.planUndo(id);
    if (!undo.ok) throw new Error(undo.reason);
    vi.stubEnv(FLAG, '0');
    // An undo takes back what an approved run wrote: no probe of its own, and not stopped by the switch.
    expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! })).toMatchObject({ ok: true });
    s.requests.length = 0;
    expect((await apply(undo.status.id, 'bulk_undo')).status).toBe('done');
    expect(writes()).toEqual([
      { id: gid(20), seoTitle: null, seoDescription: 'D2' },
      { id: gid(10), seoTitle: null, seoDescription: 'D1' },
    ]);
    expect(s.products.get(10)!['seo']).toEqual({ title: null, description: 'D1' });
    expect(s.products.get(20)!['seo']).toEqual({ title: null, description: 'D2' });
  });
});

describe('approving a Shopify run', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const previewed = async (): Promise<string> => {
    vi.stubEnv(FLAG, '1');
    fill(2);
    const id = startedList();
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(ledger.resumePreview(id).ok).toBe(true);
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(ledger.getStatus(id)!.phase).toBe('previewed');
    return id;
  };

  it('writes an unmeasured form: confirmed by name, one target before its own probe', async () => {
    const id = await previewed();
    const checksum = ledger.computeChecksum(id)!;
    expect(ledger.approve(id, { checksum })).toEqual({ ok: false, reason: 'unmeasured_unconfirmed' });
    expect(ledger.approve(id, { checksum, unmeasuredConfirmed: true, maxTargets: 2 })).toEqual({ ok: false, reason: 'probe_required' });
    expect(ledger.approve(id, { checksum, unmeasuredConfirmed: true, maxTargets: 1 })).toMatchObject({ ok: true });
  });

  it('is neither approved nor resumed while the store reads are switched off', async () => {
    const id = await previewed();
    vi.stubEnv(FLAG, '0');
    expect(ledger.approve(id, { checksum: ledger.computeChecksum(id)!, unmeasuredConfirmed: true, maxTargets: 1 })).toEqual({ ok: false, reason: 'shopify_off' });
    engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'approved', approval_checksum = ? WHERE id = ?`).run(ledger.computeChecksum(id), id);
    expect(ledger.resume(id, { checksum: ledger.computeChecksum(id)! })).toEqual({ ok: false, reason: 'shopify_off' });
  });
});

describe('graphqlWriteAnswer', () => {
  const ok = (value: unknown): ExternalRead => ({ kind: 'ok', value });
  const product = { id: 'gid://shopify/Product/10' };

  it('is ok only for one root with its object and an empty userErrors list', () => {
    expect(graphqlWriteAnswer(ok({ productUpdate: { product, userErrors: [] } }))).toEqual(ok({ productUpdate: { product, userErrors: [] } }));
  });

  it('is refused for a userErrors list that names an error, whatever the object holds', () => {
    const errors = [{ field: ['seo'], message: 'nope' }];
    expect(graphqlWriteAnswer(ok({ productUpdate: { product: null, userErrors: errors } }))).toEqual({ kind: 'refused' });
    expect(graphqlWriteAnswer(ok({ productUpdate: { product, userErrors: errors } }))).toEqual({ kind: 'refused' });
  });

  it('has no clear answer without data, without userErrors, with several roots, or with a null object', () => {
    for (const value of [
      null, undefined, [], 'x',
      { productUpdate: { product } },
      { productUpdate: { product, userErrors: null } },
      { productUpdate: null },
      { productUpdate: { product, userErrors: [] }, other: { userErrors: [] } },
      {},
      { productUpdate: { product: null, userErrors: [] } },
      { productUpdate: { userErrors: [], product: undefined } },
    ]) expect(graphqlWriteAnswer(ok(value)), JSON.stringify(value) ?? 'undefined').toEqual({ kind: 'graphql_error' });
  });

  it('passes an answer that is not ok through as it came', () => {
    for (const answer of [{ kind: 'graphql_error' }, { kind: 'failed' }, { kind: 'unauthorized' }] as ExternalRead[]) expect(graphqlWriteAnswer(answer)).toBe(answer);
  });
});
