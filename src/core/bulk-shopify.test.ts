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
  isOfferedListSource, listPageUrl, listQueryParams, listReadContract, maxListPages, parseListSource, type BulkListSource,
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
import type Anthropic from '@anthropic-ai/sdk';
import { runBulkJudge, type BulkJudgeDeps } from './bulk-judge.js';
import { judgeTemplate, normalizeJudgeRule } from './bulk-judge-rule.js';
import type { callForStructuredJson } from './llm-helper.js';
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
  });

  it('is refused off a store host, with a path, filters or id field, and for a field the before-image has not', () => {
    expect(() => parse({ form: 'shopify', after: { title: 'x' } }, 'shop.example.com')).toThrow(/<store>\.myshopify\.com/);
    expect(() => parse({ form: 'shopify', after: { title: 'x' } }, 'admin.shopify.com')).toThrow(/<store>\.myshopify\.com/);
    for (const key of ['path', 'filters', 'id_field']) {
      expect(() => parse({ form: 'shopify', [key]: key === 'filters' ? {} : 'x', after: { title: 'x' } }), key).toThrow(new RegExp(`source_list\\.${key} is not given`));
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

const source = (after: Record<string, unknown> = { seo_title: 'New title' }): BulkListSource => parseListSource(HOST, { form: 'shopify', after }, 'PATCH', scan);

function startedList(after?: Record<string, unknown>): string {
  const src = source(after);
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
  ledger = new BulkLedger(engineDb, null);
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
    expect(minted).toEqual([{ phase: 'list', afterId: 0, form: 'shopify_products_list' }, { phase: 'list', afterId: 2500, form: 'shopify_products_list' }]);
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

  it('takes a judge whose fields are writable, and refuses one that names descriptionHtml or another field', async () => {
    const judged = (schema: Record<string, unknown>): Promise<string> => plan({ source_list: { form: 'shopify' }, judge: { rule: 'r', schema } });
    vi.stubEnv(FLAG, '1');
    try {
      expect(await judged({ title: { type: 'string', maxLength: 255 }, seo_title: { type: 'string', maxLength: 70 } })).toMatch(/List dry run recorded/);
      expect(await judged({ descriptionHtml: { type: 'string', maxLength: 2000 } })).toMatch(/cannot set descriptionHtml yet/);
      expect(await judged({ vendor: { type: 'string', maxLength: 50 } })).toMatch(/may only set: title, seo_title, seo_description/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 1 });
  });

  // A verdict the write document cannot carry would be judged and paid for, then fail every target.
  it.each([
    ['number', { title: { type: 'number' } }, /judge\.schema\.title must be type "string" for form shopify/],
    ['integer', { seo_title: { type: 'string', maxLength: 70 }, seo_description: { type: 'integer' } }, /judge\.schema\.seo_description must be type "string"/],
    ['boolean', { title: { type: 'boolean' } }, /judge\.schema\.title must be type "string"/],
  ])('refuses a judge whose field is a %s, and takes the same field as text', async (_type, schema, refusal) => {
    vi.stubEnv(FLAG, '1');
    try {
      expect(await plan({ source_list: { form: 'shopify' }, judge: { rule: 'r', schema } })).toMatch(refusal);
      expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 0 });
      const asText = Object.fromEntries(Object.keys(schema).map((f) => [f, { type: 'string', maxLength: 70 }]));
      expect(await plan({ source_list: { form: 'shopify' }, judge: { rule: 'r', schema: asText } })).toMatch(/List dry run recorded/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('names the writable fields first when a judge names a field the store cannot be written, whatever its type', async () => {
    vi.stubEnv(FLAG, '1');
    try {
      expect(await plan({ source_list: { form: 'shopify' }, judge: { rule: 'r', schema: { descriptionHtml: { type: 'boolean' } } } })).toMatch(/cannot set descriptionHtml yet/);
      expect(await plan({ source_list: { form: 'shopify' }, judge: { rule: 'r', schema: { vendor: { type: 'number' } } } })).toMatch(/may only set: title, seo_title, seo_description/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses an after-state that is not text or null, and takes text and null', async () => {
    vi.stubEnv(FLAG, '1');
    try {
      expect(await plan({ source_list: { form: 'shopify', after: { title: 5 } } })).toMatch(/may only hold text or null for form shopify/);
      expect(await plan({ source_list: { form: 'shopify', after: { seo_title: 'x', seo_description: true } } })).toMatch(/may only hold text or null for form shopify/);
      expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 0 });
      expect(await plan({ source_list: { form: 'shopify', after: { seo_title: 'x', seo_description: null } } })).toMatch(/List dry run recorded/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a judge on the image form: a judge is decided for products only', async () => {
    vi.stubEnv(FLAG, '1');
    try {
      expect(await plan({ source_list: { form: 'shopify_media' }, judge: { rule: 'r', schema: { alt: { type: 'string', maxLength: 512 } } } }))
        .toMatch(/source_list\.form shopify_media does not take judge yet/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 0 });
  });

  it('refuses a write method', async () => {
    vi.stubEnv(FLAG, '1');
    try {
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
    // Set up by hand, without a judge's model call: the ledger completes the verdict itself.
    engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'planned', halt_reason = NULL WHERE id = ?`).run(id);
    const [only] = targets(id);
    expect(ledger.claimJudge(id, only!.seq, 't', Date.now(), 60_000)).toBe(true);
    expect(ledger.recordJudgement(id, only!.seq, 't', { after: { seo_title: 'Judged' } })).toBe(true);
    expect(ledger.loadTarget(id, only!.seq)!.after).toEqual({ absent: false, value: { seo_title: 'Judged', seo_description: 'D1' } });
    expect(targets(id)[0]!.change).toBe('update');
  });
});

describe('a planned text of a Shopify run (PRD shopify-preset §20.2 item 5)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  /** Listed and read with the plan's `after`: one product, its title and seo as the store holds them. */
  async function planned(after: Record<string, unknown>, prepare?: () => void): Promise<[string, string | null]> {
    vi.stubEnv(FLAG, '1');
    fill(1);
    prepare?.();
    const id = startedList(after);
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(ledger.resumePreview(id).ok).toBe(true);
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    const t = ledger.getPreview(id)[0]!;
    return [t.change, t.error];
  }

  it('leaves a product out where the plan puts markup into its title or seo title', async () => {
    expect(await planned({ title: 'New <script>x()</script>' })).toEqual(['invalid', 'markup_in_text']);
    expect(await planned({ title: 'New <a href="https://evil.example/">deal</a>' })).toEqual(['invalid', 'markup_in_text']);
    expect(await planned({ seo_title: 'New <script>x()</script>' })).toEqual(['invalid', 'markup_in_text']);
    expect(await planned({ title: 'New title' })).toEqual(['update', null]);
  });

  it('does not hold the seo partner the store already holds against the plan', async () => {
    const held = (): void => { s.products.set(10, { ...s.products.get(10)!, seo: { title: 'Old', description: 'Size < 40, A -> B' } }); };
    expect(await planned({ seo_title: 'New title' }, held)).toEqual(['update', null]);
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

  it('writes exactly two of three when the owner took one out before approving, and leaves that product as it was', async () => {
    fill(3);
    const id = await previewed();
    const twenty = ledger.getPreview(id).find((t) => t.key === gid(20))!.seq;
    expect(ledger.deselectTarget(id, twenty, { checksum: ledger.computeChecksum(id)! }).ok).toBe(true);
    expect(ledger.approve(id, { checksum: ledger.computeChecksum(id)!, unmeasuredConfirmed: true, maxTargets: 1 })).toMatchObject({ ok: true });
    s.requests.length = 0;
    await apply(id);
    expect(ledger.confirmProbe(id)).toEqual({ ok: true });
    expect(ledger.resume(id, { checksum: ledger.computeChecksum(id)!, maxTargets: 2 })).toMatchObject({ ok: true });
    await apply(id);
    expect(writes().map((w) => w['id'])).toEqual([gid(10), gid(30)]);
    expect(s.products.get(20)!['seo']).toEqual({ title: null, description: 'D2' });
    // The minted apply grant names only the writing products: the deselected one gets no body.
    expect(ledger.shopifyApplyOf(id)!.writes.map((w) => w.gid)).not.toContain(gid(20));
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

// A judge on the Shopify form: planned with the rule's fields as the list's after-state, read like
// any Shopify run, judged after the owner's start.
describe('a judged Shopify run', () => {
  const RULE = { rule: 'Write a better SEO title.', schema: { seo_title: { type: 'string', maxLength: 70 } } };

  /** Planned, its list read, and started for judging: the state the worker's judge loop meets. */
  async function judgedRun(): Promise<string> {
    const judge = normalizeJudgeRule(RULE);
    const src = parseListSource(HOST, { form: 'shopify', after: judgeTemplate(judge) }, 'PATCH', scan);
    const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source: src, readContract: listReadContract(HOST, src), judge });
    if (!out.ok) throw new Error(out.reason);
    const id = out.status.id;
    if (!ledger.resumePreview(id, Date.now(), { listChecksum: ledger.listStartChecksum(id)! }).ok) throw new Error('list start');
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    const started = ledger.resumePreview(id, Date.now(), { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash, costCapUsd: 1 });
    if (!started.ok) throw new Error(started.reason);
    return id;
  }

  /** Judge deps over a stub model call; `onCall` runs before each answer. */
  function judgeDeps(id: string, onCall: (n: number) => void = () => {}): { deps: BulkJudgeDeps; calls: number } {
    const box = { calls: 0, deps: undefined as unknown as BulkJudgeDeps };
    const call = (async () => {
      onCall(++box.calls);
      return { data: { keep: false, after: { seo_title: `S${String(box.calls)}` } }, inputTokens: 100, outputTokens: 10, costUsd: 0.01, modelId: 'claude-haiku-4-5' };
    }) as unknown as typeof callForStructuredJson;
    box.deps = {
      ledger,
      readTargets: () => runBulkPreview(id, deps()),
      resolveModel: (tier) => ({ tier, modelId: 'claude-haiku-4-5', client: {} as Anthropic }),
      gate: async () => ({ runId: 'gate', blockedReason: null }),
      report: () => {},
      bookSpend: () => {},
      budgetAllows: () => true,
      scanSecret: () => null,
      maskVault: (t) => t,
      call,
    };
    return box;
  }

  it('halts before the next paid call once the operator switches Shopify off', async () => {
    fill(3);
    vi.stubEnv(FLAG, '1');
    try {
      const id = await judgedRun();
      const box = judgeDeps(id, (n) => { if (n === 1) vi.stubEnv(FLAG, '0'); });
      const out = await runBulkJudge(id, box.deps);
      expect(out.status).toBe('halted');
      expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.shopifyReadOff);
      expect(box.calls).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('completes a verdict over one seo field with its partner from the before-image, so the write keeps it', async () => {
    fill(2);
    vi.stubEnv(FLAG, '1');
    try {
      const id = await judgedRun();
      expect((await runBulkJudge(id, judgeDeps(id).deps)).status).toBe('done');
      // F = {seo_title}; the store holds seo.description D1, D2, which the verdict never named.
      expect(ledger.getPreview(id).map((t) => t.after)).toEqual([
        { seo_title: 'S1', seo_description: 'D1' },
        { seo_title: 'S2', seo_description: 'D2' },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /** One product judged to the seo title `title`; the store holds `before` as its seo title. */
  async function judgedOnce(title: string, before: string | null = null): Promise<[string, string | null]> {
    s.products.clear();
    fill(1);
    (s.products.get(10)!['seo'] as Record<string, unknown>)['title'] = before;
    vi.stubEnv(FLAG, '1');
    try {
      const id = await judgedRun();
      const box = judgeDeps(id);
      box.deps.call = (async () => ({
        data: { keep: false, after: { seo_title: title } }, inputTokens: 100, outputTokens: 10, costUsd: 0.01, modelId: 'claude-haiku-4-5',
      })) as unknown as typeof callForStructuredJson;
      expect((await runBulkJudge(id, box.deps)).status).toBe('done');
      const t = ledger.getPreview(id)[0]!;
      return [t.change, t.error];
    } finally {
      vi.unstubAllEnvs();
    }
  }

  // One run per case: a second judged run over the same list waits for the first to be superseded.
  it.each([
    ['a tag', 'New <b>title</b>', null],
    ['a closing bracket', 'New > title', null],
    ['a tag where the counts pass against a title that holds both', '<img src=x>', 'USB-C <> HDMI'],
  ])('leaves out a verdict that adds %s to a text field that is not HTML (S20-2)', async (_what, title, before) => {
    expect(await judgedOnce(title, before)).toEqual(['invalid', 'markup_in_text']);
  });

  it.each([
    ['brackets its field already held', 'USB-C <> HDMI, 2 m', 'USB-C <> HDMI'],
    ['an inch mark', 'Pipe 2" wide', null],
  ])('writes a verdict that adds %s (twin)', async (_what, title, before) => {
    expect(await judgedOnce(title, before)).toEqual(['update', null]);
  });

  it.each([
    ['a hidden character its field did not hold', 'New\u200btitle', null, 'invalid', 'hidden_char'],
    ['a hidden character its field held as often', 'New\u200btitle', 'Old\u200btitle', 'update', null],
    ['a hidden character more often than its field held it', 'N\u200bew\u200btitle', 'Old\u200btitle', 'invalid', 'hidden_char'],
  ])('judges a verdict with %s by count (M5)', async (_what, title, before, change, error) => {
    expect(await judgedOnce(title, before)).toEqual([change, error]);
  });

  it('judges every product while the switch is on (twin of the halt)', async () => {
    fill(3);
    vi.stubEnv(FLAG, '1');
    try {
      const id = await judgedRun();
      const box = judgeDeps(id);
      expect((await runBulkJudge(id, box.deps)).status).toBe('done');
      expect(box.calls).toBe(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
