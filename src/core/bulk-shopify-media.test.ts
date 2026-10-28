/**
 * A Shopify store's product images as the targets of an external bulk run (`shopify_media`), end
 * to end: the source, the media list read by product id, each image's `alt` as its before-image,
 * the approved write through `fileUpdate`, its probe and its undo — under the run's stored
 * contract, the in-memory copies that grant each exact body, and the real client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '23.227.38.65', family: 4 }]) },
}));

import dns from 'node:dns/promises';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setPinnedTransportForTests } from './network-guard.js';
import { EngineDb } from './engine-db.js';
import { BulkLedger, type BulkRunForPreview } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { BulkHostBudget, externalClient, graphqlWriteAnswer, parseBulkContract, type ExternalClient } from './bulk-external.js';
import { bulkRunContract, externalRunWriter } from './bulk-external-writer.js';
import { isOfferedListSource, listReadContract, maxListPages, parseListSource, type BulkListSource } from './bulk-list.js';
import { runBulkPreview, type BulkPreviewDeps } from './bulk-preview.js';
import { bulkWriterFor, runBulkEffect } from './bulk-apply.js';
import { shopifyMediaBeforeImage, shopifyMediaListPage } from './bulk-shopify.js';
import {
  SHOPIFY_MEDIA_LIST_PAGE_SIZE, SHOPIFY_MEDIA_PER_PRODUCT, SHOPIFY_READ_DOCUMENTS, SHOPIFY_WRITE_DOCUMENTS,
  shopifyMediaAltWriteBody, shopifyMediaListBody, shopifyTargetReadBody, shopifyWriteRequest,
} from './shopify-graphql.js';
import { createToolContext } from './tool-context.js';
import { mintStorePass } from './store-pass.js';
import { withShopifyApply, withShopifyRead, type ListQueryConstraints, type ShopifyReadPhase } from '../tools/permission-guard.js';
import { bulkPlanTool } from '../tools/builtin/bulk.js';
import { BULK_MAX_TARGETS } from './bulk-plan.js';
import type { IAgent } from '../types/index.js';

const HOST = 'acme.myshopify.com';
const ENDPOINT = `https://${HOST}/admin/api/2026-10/graphql.json`;
const product = (n: number): string => `gid://shopify/Product/${String(n)}`;
const image = (n: number): string => `gid://shopify/MediaImage/${String(n)}`;
const video = (n: number): string => `gid://shopify/ExternalVideo/${String(n)}`;
const scan = (): null => null;
const FLAG = 'LYNOX_FEATURE_SHOPIFY_BULK_READ';

// ── The parts ────────────────────────────────────────────────────────────────

describe('the media documents and bodies', () => {
  it('lists products after an id with their media, and reads one image by its GID', () => {
    expect(JSON.parse(shopifyMediaListBody(40)!)).toEqual({
      query: SHOPIFY_READ_DOCUMENTS.shopify_media_list,
      variables: { n: SHOPIFY_MEDIA_LIST_PAGE_SIZE, q: 'id:>40', m: SHOPIFY_MEDIA_PER_PRODUCT },
    });
    expect(shopifyMediaListBody(-1)).toBeNull();
    expect(JSON.parse(shopifyTargetReadBody(image(7))!)).toEqual({ query: SHOPIFY_READ_DOCUMENTS.shopify_media_read, variables: { id: image(7) } });
    expect(JSON.parse(shopifyTargetReadBody(product(7))!).query).toBe(SHOPIFY_READ_DOCUMENTS.shopify_product_read);
    expect(shopifyTargetReadBody(video(7))).toBeNull();
    expect(shopifyTargetReadBody('gid://shopify/MediaImage/0')).toBeNull();
  });

  it('writes an image\'s alt, a cleared one as the empty string, and nothing else', () => {
    expect(JSON.parse(shopifyMediaAltWriteBody(image(7), { alt: 'Blue mug' })!)).toEqual({ query: SHOPIFY_WRITE_DOCUMENTS.shopify_media_alt, variables: { id: image(7), alt: 'Blue mug' } });
    // Shopify ignores a written null and keeps the value; the empty string clears it.
    expect(JSON.parse(shopifyMediaAltWriteBody(image(7), { alt: null })!).variables).toEqual({ id: image(7), alt: '' });
    expect(shopifyMediaAltWriteBody(product(7), { alt: 'x' })).toBeNull();
    expect(shopifyMediaAltWriteBody(image(7), { alt: 'x', title: 'y' })).toBeNull();
    expect(shopifyMediaAltWriteBody(image(7), { title: 'y' })).toBeNull();
    expect(shopifyMediaAltWriteBody(image(7), {})).toBeNull();
    expect(shopifyMediaAltWriteBody(image(7), { alt: 3 })).toBeNull();
  });

  it('counts the 512 characters of an alt in characters, not bytes', () => {
    expect(shopifyMediaAltWriteBody(image(7), { alt: 'a'.repeat(512) })).not.toBeNull();
    expect(shopifyMediaAltWriteBody(image(7), { alt: 'a'.repeat(513) })).toBeNull();
    expect(shopifyMediaAltWriteBody(image(7), { alt: 'ä'.repeat(512) })).not.toBeNull();
    // One code point, two UTF-16 units: counted once.
    expect(shopifyMediaAltWriteBody(image(7), { alt: '😀'.repeat(512) })).not.toBeNull();
  });

  it('builds a write by its form, and nothing for a target of the other form\'s type', () => {
    expect(shopifyWriteRequest({ form: 'shopify_media_alt', gid: image(7), after: { alt: 'x' } })).toBe(shopifyMediaAltWriteBody(image(7), { alt: 'x' }));
    expect(shopifyWriteRequest({ form: 'shopify_media_alt', gid: product(7), after: { alt: 'x' } })).toBeNull();
    expect(shopifyWriteRequest({ form: 'shopify_product', gid: image(7), after: { title: 'x' } })).toBeNull();
  });

  it('takes a fileUpdate answer as written only when it returns the file', () => {
    const ok = (data: unknown) => ({ kind: 'ok', value: data }) as const;
    const written = ok({ fileUpdate: { files: [{ id: image(7), alt: 'x' }], userErrors: [] } });
    expect(graphqlWriteAnswer(written)).toEqual(written);
    expect(graphqlWriteAnswer(ok({ fileUpdate: { files: [], userErrors: [] } }))).toEqual({ kind: 'graphql_error' });
    expect(graphqlWriteAnswer(ok({ fileUpdate: { files: [], userErrors: [{ field: ['files'], message: 'm', code: 'NON_READY_STATE' }] } }))).toEqual({ kind: 'refused' });
  });

  it('selects the fileUpdate userErrors, with their code', () => {
    expect(SHOPIFY_WRITE_DOCUMENTS.shopify_media_alt).toMatch(/userErrors \{ field message code \}/);
  });
});

describe('shopifyMediaListPage', () => {
  const page = (...nodes: unknown[]): unknown => ({ products: { nodes } });
  const p = (n: number, media: unknown[], hasNextPage = false): unknown => ({ id: product(n), media: { nodes: media, pageInfo: { hasNextPage } } });

  it('takes each product\'s images as targets, leaves other media out, and moves the cursor to the last product', () => {
    const got = shopifyMediaListPage(page(
      p(10, [{ id: image(1), mediaContentType: 'IMAGE' }, { id: video(2), mediaContentType: 'EXTERNAL_VIDEO' }]),
      p(20, []),
      p(30, [{ id: image(3), mediaContentType: 'IMAGE' }]),
    ), 0);
    expect(got).toEqual({ kind: 'page', items: [{ key: image(1), id: image(1) }, { key: image(3), id: image(3) }], lastId: 30, count: 3 });
  });

  it('counts a product whose media go past the page as an invalid item, not a silent cut', () => {
    const got = shopifyMediaListPage(page(p(10, [{ id: image(1), mediaContentType: 'IMAGE' }], true)), 0);
    expect(got).toEqual({ kind: 'page', items: [{ key: image(1), id: image(1) }, { invalid: 'list_item_truncated' }], lastId: 10, count: 1 });
    // No page information is not "complete" either.
    const bare = shopifyMediaListPage(page({ id: product(10), media: { nodes: [] } }), 0);
    expect(bare).toEqual({ kind: 'page', items: [{ invalid: 'list_item_truncated' }], lastId: 10, count: 1 });
  });

  it('makes an image without a usable id invalid, and a product without one leaves the cursor', () => {
    const got = shopifyMediaListPage(page(
      p(10, [{ id: 'gid://shopify/MediaImage/x', mediaContentType: 'IMAGE' }, { mediaContentType: 'IMAGE' }, 'x']),
      { id: 'nope', media: { nodes: [] } },
    ), 0);
    expect(got).toEqual({ kind: 'page', items: [{ invalid: 'list_item_bad_id' }, { invalid: 'list_item_no_id' }, { invalid: 'list_item_not_object' }, { invalid: 'list_item_bad_id' }], lastId: 10, count: 2 });
  });

  it('refuses a page out of product order, and is no page where the nodes are not an array', () => {
    expect(shopifyMediaListPage(page(p(10, [])), 10)).toEqual({ kind: 'order' });
    expect(shopifyMediaListPage(page(p(20, []), p(10, [])), 0)).toEqual({ kind: 'order' });
    expect(shopifyMediaListPage({ products: { nodes: null } }, 0)).toEqual({ kind: 'not_a_list' });
  });

  it('leaves out, on a full page only, the unusable products after its last one', () => {
    const nodes = [...Array.from({ length: SHOPIFY_MEDIA_LIST_PAGE_SIZE - 1 }, (_, i) => p(i + 1, [])), { id: 'nope' }];
    const full = shopifyMediaListPage(page(...nodes), 0);
    expect(full).toMatchObject({ kind: 'page', items: [], lastId: SHOPIFY_MEDIA_LIST_PAGE_SIZE - 1, count: SHOPIFY_MEDIA_LIST_PAGE_SIZE });
    const short = shopifyMediaListPage(page(p(1, []), { id: 'nope' }), 0);
    expect(short).toMatchObject({ items: [{ invalid: 'list_item_bad_id' }] });
  });
});

describe('shopifyMediaBeforeImage', () => {
  it('is the image\'s alt, a missing one read as the empty string', () => {
    expect(shopifyMediaBeforeImage({ node: { id: image(1), alt: 'Mug' } }, image(1))).toEqual({ value: { alt: 'Mug' } });
    expect(shopifyMediaBeforeImage({ node: { id: image(1), alt: null } }, image(1))).toEqual({ value: { alt: '' } });
    expect(shopifyMediaBeforeImage({ node: { id: image(1) } }, image(1))).toEqual({ value: {} });
  });

  it('says why there is none: gone, not an image, another one, or no object', () => {
    expect(shopifyMediaBeforeImage({ node: null }, image(1))).toEqual({ invalid: 'not_found' });
    // The type condition answers `{}` for a node that is not an image (measured).
    expect(shopifyMediaBeforeImage({ node: {} }, image(1))).toEqual({ invalid: 'list_item_mismatch' });
    expect(shopifyMediaBeforeImage({ node: { id: image(2), alt: 'x' } }, image(1))).toEqual({ invalid: 'list_item_mismatch' });
    expect(shopifyMediaBeforeImage({}, image(1))).toEqual({ invalid: 'before_not_object' });
    expect(shopifyMediaBeforeImage(null, image(1))).toEqual({ invalid: 'before_not_object' });
  });
});

describe('a Shopify media list source', () => {
  const parse = (input: unknown, host = HOST): BulkListSource => parseListSource(host, input, 'PATCH', scan);

  it('is the images of the store\'s products, setting alt only, a cleared one as the empty string', () => {
    const s = parse({ form: 'shopify_media', after: { alt: 'Mug' } });
    expect(s).toEqual({ form: 'shopify_media', path: '', filters: {}, idField: 'id', method: null, after: { alt: 'Mug' } });
    expect(isOfferedListSource(s)).toBe(true);
    expect(parse({ form: 'shopify_media', after: { alt: null } }).after).toEqual({ alt: '' });
    expect(maxListPages('shopify_media')).toBe(Math.ceil(BULK_MAX_TARGETS / SHOPIFY_MEDIA_LIST_PAGE_SIZE) + 1);
    expect(listReadContract(HOST, s)).toMatchObject({ httpMethods: ['GET'], hostPatterns: [HOST], pathPatterns: [] });
  });

  it('is refused off a store host, with a path, filters or id field, for another field, and for an alt Shopify would not store', () => {
    expect(() => parse({ form: 'shopify_media', after: { alt: 'x' } }, 'shop.example.com')).toThrow(/shopify_media reads a store/);
    for (const key of ['path', 'filters', 'id_field']) {
      expect(() => parse({ form: 'shopify_media', [key]: key === 'filters' ? {} : 'x', after: { alt: 'x' } }), key).toThrow(new RegExp(`source_list\\.${key} is not given for form shopify_media`));
    }
    expect(() => parse({ form: 'shopify_media', after: { alt: 'x', title: 'y' } })).toThrow(/may only set: alt\./);
    expect(() => parse({ form: 'shopify_media', after: { title: 'y' } })).toThrow(/may only set: alt\./);
    expect(() => parse({ form: 'shopify_media', after: { alt: 3 } })).toThrow(/alt must be text, or null/);
    expect(() => parse({ form: 'shopify_media', after: { alt: 'a'.repeat(513) } })).toThrow(/longer than the 512 characters/);
    expect(parse({ form: 'shopify_media', after: { alt: 'a'.repeat(512) } }).after).toEqual({ alt: 'a'.repeat(512) });
  });
});

describe('the grants for a media run', () => {
  const base = { version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: ['GET'], hostPatterns: [HOST], pathPatterns: [], paramConstraints: {} } as const;

  it('mints the media list page, an image\'s read and its write, each under its own body only', async () => {
    const list = withShopifyRead(base, HOST, { phase: 'list', afterId: 0, form: 'shopify_media_list' });
    const products = withShopifyRead(base, HOST, { phase: 'list', afterId: 0, filters: {} });
    expect(await client(list).graphqlRead(ENDPOINT, { form: 'shopify_media_list', afterId: 0 })).not.toEqual({ kind: 'not_granted' });
    expect(await client(list).graphqlRead(ENDPOINT, { form: 'shopify_products_list', afterId: 0, filters: {} })).toEqual({ kind: 'not_granted' });
    expect(await client(products).graphqlRead(ENDPOINT, { form: 'shopify_media_list', afterId: 0 })).toEqual({ kind: 'not_granted' });
    const read = withShopifyRead(base, HOST, { phase: 'read', targets: [image(1)] });
    expect(await client(read).graphqlRead(ENDPOINT, { form: 'shopify_media_read', gid: image(2) })).toEqual({ kind: 'not_granted' });
    expect(() => withShopifyRead(base, HOST, { phase: 'read', targets: [video(1)] })).toThrow(/product or image GIDs/);
    expect(() => withShopifyApply(base, HOST, { reads: [image(1)], writes: [{ form: 'shopify_media_alt', gid: image(1), after: { alt: 'a'.repeat(513) } }] })).toThrow(/after-states their form can write/);
    expect(() => withShopifyApply(base, HOST, { reads: [image(1)], writes: [{ form: 'shopify_media_alt', gid: product(1), after: { alt: 'x' } }] })).toThrow(/after-states their form can write/);
  });
});

// ── End to end ────────────────────────────────────────────────────────────────

interface Media { id: string; type: 'IMAGE' | 'EXTERNAL_VIDEO'; alt: string | null }
interface Store {
  /** Product number → its media. */
  products: Map<number, Media[]>;
  requests: { url: string; query: string; variables: Record<string, unknown> }[];
  /** Answer a write of this image with this instead of applying it. */
  writeAnswer?: (id: string) => unknown;
}

function mediaOf(id: string): Media | undefined {
  for (const media of s.products.values()) {
    const m = media.find((x) => x.id === id);
    if (m !== undefined) return m;
  }
  return undefined;
}

/** A store whose product n×10 holds image n×10+1 (alt `A<n>`), image n×10+2 (no alt), and a video. */
function fill(n: number): void {
  for (let i = 1; i <= n; i++) {
    s.products.set(i * 10, [
      { id: image(i * 10 + 1), type: 'IMAGE', alt: `A${String(i)}` },
      { id: image(i * 10 + 2), type: 'IMAGE', alt: null },
      { id: video(i * 10 + 3), type: 'EXTERNAL_VIDEO', alt: null },
    ]);
  }
}

function serve(): () => void {
  vi.mocked(dns.lookup).mockResolvedValue([{ address: '23.227.38.65', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
  return setPinnedTransportForTests(async (req) => {
    const body = JSON.parse(req.body?.toString('utf8') ?? '{}') as { query?: string; variables?: Record<string, unknown> };
    const query = body.query ?? '';
    const variables = body.variables ?? {};
    s.requests.push({ url: req.url, query, variables });
    if (query.startsWith('mutation')) {
      const id = variables['id'] as string;
      const special = s.writeAnswer?.(id);
      if (special !== undefined) return new Response(JSON.stringify(special), { status: 200 });
      const m = mediaOf(id);
      // As Shopify applies `fileUpdate`: a null alt is ignored, a string (the empty one included) is stored.
      if (m !== undefined && typeof variables['alt'] === 'string') m.alt = variables['alt'];
      return new Response(JSON.stringify({ data: { fileUpdate: { files: m === undefined ? [] : [{ id, alt: m.alt }], userErrors: [] } } }), { status: 200 });
    }
    if (typeof variables['q'] === 'string') {
      const afterId = Number(/^id:>(\d+)$/.exec(variables['q'])![1]);
      const ids = [...s.products.keys()].filter((id) => id > afterId).sort((a, b) => a - b).slice(0, variables['n'] as number);
      const m = variables['m'] as number;
      return new Response(JSON.stringify({ data: { products: { nodes: ids.map((id) => {
        const media = s.products.get(id)!;
        return { id: product(id), media: { nodes: media.slice(0, m).map((x) => ({ id: x.id, mediaContentType: x.type })), pageInfo: { hasNextPage: media.length > m } } };
      }) } } }), { status: 200 });
    }
    const id = variables['id'] as string;
    const m = mediaOf(id);
    return new Response(JSON.stringify({ data: { node: m === undefined ? null : m.type === 'IMAGE' ? { id, alt: m.alt } : {} } }), { status: 200 });
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

let minted: (ShopifyReadPhase | 'none')[];
const workerClientFor = (run: BulkRunForPreview, _listQuery?: ListQueryConstraints, shopifyRead?: ShopifyReadPhase): ExternalClient | null => {
  minted.push(shopifyRead ?? 'none');
  const stored = parseBulkContract(run.contractJson);
  if (!stored) return null;
  return client(shopifyRead === undefined ? stored : withShopifyRead(stored, HOST, shopifyRead));
};

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;
let restore: () => void;
let s: Store;

const deps = (extra: Partial<BulkPreviewDeps> = {}): BulkPreviewDeps =>
  ({ ledger, clientFor: workerClientFor, budget: new BulkHostBudget(100_000, 0), sleep: async () => {}, shopifyEnabled: () => true, ...extra });

function startedList(after: Record<string, unknown> = { alt: 'New alt' }, form = 'shopify_media'): string {
  const src = parseListSource(HOST, { form, after }, 'PATCH', scan);
  const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source: src, readContract: listReadContract(HOST, src) });
  if (!out.ok) throw new Error(out.reason);
  const started = ledger.resumePreview(out.status.id, Date.now(), { listChecksum: ledger.listStartChecksum(out.status.id)! });
  if (!started.ok) throw new Error(started.reason);
  return out.status.id;
}

const targets = (id: string): { seq: number; key: string; change: string; error: string | null }[] =>
  (engineDb.getDb().prepare('SELECT seq, target_key, change, error FROM bulk_targets WHERE run_id = ? ORDER BY seq').all(id) as { seq: number; target_key: string; change: string; error: string | null }[])
    .map((r) => ({ seq: r.seq, key: engineDb.dec(r.target_key), change: r.change, error: r.error }));

async function previewed(after?: Record<string, unknown>): Promise<string> {
  const id = startedList(after);
  expect((await runBulkPreview(id, deps())).status).toBe('done');
  expect(ledger.resumePreview(id).ok).toBe(true);
  expect((await runBulkPreview(id, deps())).status).toBe('done');
  return id;
}

beforeEach(() => {
  minted = [];
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-shopify-media-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
  s = { products: new Map(), requests: [] };
  restore = serve();
});
afterEach(() => {
  restore();
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('reading a store\'s images', () => {
  it('lists the images of each product, not its video, each page under a grant for the media list\'s one body', async () => {
    fill(2);
    const id = startedList();
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(minted).toEqual([{ phase: 'list', afterId: 0, form: 'shopify_media_list' }]);
    expect(s.requests.map((r) => r.query)).toEqual([SHOPIFY_READ_DOCUMENTS.shopify_media_list]);
    expect(targets(id).map((t) => t.key)).toEqual([image(11), image(12), image(21), image(22)]);
  });

  it('reads the list page by page, after the last product of the page before', async () => {
    fill(SHOPIFY_MEDIA_LIST_PAGE_SIZE + 1);
    const id = startedList();
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(minted).toEqual([
      { phase: 'list', afterId: 0, form: 'shopify_media_list' },
      { phase: 'list', afterId: SHOPIFY_MEDIA_LIST_PAGE_SIZE * 10, form: 'shopify_media_list' },
    ]);
    expect(targets(id)).toHaveLength(2 * (SHOPIFY_MEDIA_LIST_PAGE_SIZE + 1));
    expect(targets(id).at(-1)!.key).toBe(image((SHOPIFY_MEDIA_LIST_PAGE_SIZE + 1) * 10 + 2));
  });

  it('reads each image\'s alt as its before-image, and classifies against it without a seo pair', async () => {
    fill(1);
    s.products.get(10)![0]!.alt = 'New alt';
    const id = await previewed();
    expect(minted.at(-1)).toEqual({ phase: 'read', targets: [image(11), image(12)] });
    expect(targets(id).map((t) => t.change)).toEqual(['unchanged', 'update']);
    expect(ledger.loadTarget(id, targets(id)[1]!.seq)!.after).toEqual({ absent: false, value: { alt: 'New alt' } });
    const before = engineDb.getDb().prepare('SELECT before FROM bulk_targets WHERE run_id = ? ORDER BY seq').all(id) as { before: string }[];
    expect(JSON.parse(engineDb.dec(before[1]!.before))).toEqual({ absent: false, value: { alt: '' } });
  });

  it('makes an image that is gone invalid', async () => {
    fill(1);
    const id = startedList();
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(ledger.resumePreview(id).ok).toBe(true);
    s.products.set(10, s.products.get(10)!.filter((m) => m.id !== image(11)));
    expect((await runBulkPreview(id, deps())).status).toBe('done');
    expect(targets(id).map((t) => [t.change, t.error])).toEqual([['invalid', 'not_found'], ['update', null]]);
  });
});

describe('applying a media run', () => {
  const apply = (id: string, effect: 'bulk_apply' | 'bulk_undo' = 'bulk_apply'): Promise<{ status: string }> => runBulkEffect(id, effect, {
    ledger, trailFor: () => null,
    // The worker's own writer: the form it reads and writes with comes from the run's rows.
    writerFor: (run) => bulkWriterFor(run, null, (r) => externalRunWriter(r, ledger, (rr, _q, _r, shopifyApply) => {
      const stored = rr.contractJson === null ? null : parseBulkContract(rr.contractJson);
      const granted = stored === null ? null : bulkRunContract(stored, rr.targetSystem, { shopifyApply });
      return granted === null ? null : client(granted);
    })),
  });
  const writes = (): Record<string, unknown>[] => s.requests.filter((r) => r.query.startsWith('mutation')).map((r) => r.variables);
  beforeEach(() => { vi.stubEnv(FLAG, '1'); });

  it('is the media form in its apply grant: image reads, and writes of alt through fileUpdate', async () => {
    fill(1);
    const id = await previewed();
    expect(ledger.shopifyApplyOf(id)).toEqual({ form: 'shopify_media_alt', reads: [image(11), image(12)], writes: [
      { form: 'shopify_media_alt', gid: image(11), after: { alt: 'New alt' } },
      { form: 'shopify_media_alt', gid: image(12), after: { alt: 'New alt' } },
    ] });
  });

  it('writes its probe, one image, and goes wide only after this run\'s probe is confirmed', async () => {
    fill(2);
    const id = await previewed();
    const checksum = ledger.computeChecksum(id)!;
    expect(ledger.approve(id, { checksum })).toEqual({ ok: false, reason: 'unmeasured_unconfirmed' });
    expect(ledger.approve(id, { checksum, unmeasuredConfirmed: true, maxTargets: 2 })).toEqual({ ok: false, reason: 'probe_required' });
    expect(ledger.approve(id, { checksum, unmeasuredConfirmed: true, maxTargets: 1 })).toMatchObject({ ok: true });
    s.requests.length = 0;
    await apply(id);
    expect(writes()).toEqual([{ id: image(11), alt: 'New alt' }]);
    expect(s.requests.every((r) => r.query === SHOPIFY_WRITE_DOCUMENTS.shopify_media_alt || r.query === SHOPIFY_READ_DOCUMENTS.shopify_media_read)).toBe(true);
    expect(mediaOf(image(11))!.alt).toBe('New alt');
    expect(mediaOf(image(12))!.alt).toBeNull();

    expect(ledger.resume(id, { checksum: ledger.computeChecksum(id)!, maxTargets: 4 })).toEqual({ ok: false, reason: 'probe_required' });
    expect(ledger.confirmProbe(id)).toEqual({ ok: true });
    expect(ledger.resume(id, { checksum: ledger.computeChecksum(id)!, maxTargets: 4 })).toMatchObject({ ok: true });
    await apply(id);
    expect(writes().map((w) => w['id'])).toEqual([image(11), image(12), image(21), image(22)]);
    expect(mediaOf(image(22))!.alt).toBe('New alt');
  });

  it('files its probe under the image form, and does not lend it to another run on the same store', async () => {
    fill(2);
    const first = await previewed();
    ledger.approve(first, { checksum: ledger.computeChecksum(first)!, unmeasuredConfirmed: true, maxTargets: 1 });
    await apply(first);
    expect(ledger.confirmProbe(first)).toEqual({ ok: true });
    expect(engineDb.getDb().prepare('SELECT host, method, kind FROM bulk_host_probes').all()).toEqual([{ host: HOST, method: 'POST', kind: 'unmeasured:shopify_media_alt' }]);
    mediaOf(image(11))!.alt = 'A1';
    engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'done' WHERE id = ?`).run(first);
    const second = await previewed();
    expect(ledger.approve(second, { checksum: ledger.computeChecksum(second)!, unmeasuredConfirmed: true, maxTargets: 2 })).toEqual({ ok: false, reason: 'probe_required' });
  });

  it('records an image the store refuses as not ready as refused, and the alt as it was', async () => {
    fill(1);
    s.writeAnswer = () => ({ data: { fileUpdate: { files: [], userErrors: [{ field: ['files'], message: 'Non-ready files cannot be updated.', code: 'NON_READY_STATE' }] } } });
    const id = await previewed();
    ledger.approve(id, { checksum: ledger.computeChecksum(id)!, unmeasuredConfirmed: true, maxTargets: 1 });
    await apply(id);
    expect(mediaOf(image(11))!.alt).toBe('A1');
    expect(ledger.getStatus(id)).toMatchObject({ applied: 0, failed: 1, sentUnknown: 0 });
  });

  it('does not count a write the store answers with no file as written', async () => {
    fill(1);
    s.writeAnswer = () => ({ data: { fileUpdate: { files: [], userErrors: [] } } });
    const id = await previewed();
    ledger.approve(id, { checksum: ledger.computeChecksum(id)!, unmeasuredConfirmed: true, maxTargets: 1 });
    await apply(id);
    // Sent, with no answer that says what the store did: left to be checked, not counted written.
    expect(ledger.getStatus(id)).toMatchObject({ applied: 0, failed: 1, sentUnknown: 1 });
  });

  it('takes back what it wrote, an alt the image did not have as the empty string', async () => {
    fill(1);
    const id = await previewed();
    ledger.approve(id, { checksum: ledger.computeChecksum(id)!, unmeasuredConfirmed: true, maxTargets: 1 });
    await apply(id);
    expect(ledger.confirmProbe(id)).toEqual({ ok: true });
    expect(ledger.resume(id, { checksum: ledger.computeChecksum(id)!, maxTargets: 2 })).toMatchObject({ ok: true });
    await apply(id);
    expect([mediaOf(image(11))!.alt, mediaOf(image(12))!.alt]).toEqual(['New alt', 'New alt']);

    const undo = ledger.planUndo(id);
    if (!undo.ok) throw new Error(undo.reason);
    expect(ledger.shopifyApplyOf(undo.status.id)?.form).toBe('shopify_media_alt');
    expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! })).toMatchObject({ ok: true });
    s.requests.length = 0;
    expect((await apply(undo.status.id, 'bulk_undo')).status).toBe('done');
    expect(writes()).toEqual([{ id: image(12), alt: '' }, { id: image(11), alt: 'A1' }]);
    expect([mediaOf(image(11))!.alt, mediaOf(image(12))!.alt]).toEqual(['A1', '']);
  });
});

describe('bulk_plan with a Shopify media source', () => {
  const agent = (): IAgent => ({ toolContext: { bulkLedger: ledger }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL }) as unknown as IAgent;
  const plan = (input: Record<string, unknown>): Promise<string> => bulkPlanTool.handler(
    { target_system: 'http', target_host: HOST, source_list: { form: 'shopify_media', after: { alt: 'x' } }, ...input } as Parameters<typeof bulkPlanTool.handler>[0], agent(),
  );

  it('records the run with the switch on, and refuses it with the switch off', async () => {
    vi.stubEnv(FLAG, '1');
    expect(await plan({})).toMatch(/List dry run recorded/);
    vi.unstubAllEnvs();
    engineDb.getDb().prepare('DELETE FROM bulk_runs').run();
    expect(await plan({})).toMatch(/switched off on this instance/);
  });

  it('refuses a judge and a write method, naming its form', async () => {
    vi.stubEnv(FLAG, '1');
    expect(await plan({ judge: { rule: 'r', fields: { alt: { type: 'string' } } } })).toMatch(/form shopify_media does not take judge/);
    expect(await plan({ write_method: 'PATCH' })).toMatch(/form shopify_media does not take write_method/);
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 0 });
  });
});
