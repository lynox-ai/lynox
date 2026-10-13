import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn() },
}));

import dns from 'node:dns/promises';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, type BulkRunForPreview } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { BulkHostBudget, externalClient, parseBulkContract, type ExternalClient } from './bulk-external.js';
import { listPageUrl, listQueryParams, listReadContract, maxListPages, parseListSource, type BulkListSource } from './bulk-list.js';
import { ApiStore } from './api-store.js';
import { SecretStore } from './secret-store.js';
import { WorkerLoop } from './worker-loop.js';
import { runBulkPreview, type BulkPreviewDeps } from './bulk-preview.js';
import { BULK_MAX_SOURCE_BYTES } from './bulk-plan.js';
import { setPinnedTransportForTests, type PinnedTransportInput } from './network-guard.js';
import { createToolContext } from './tool-context.js';
import { detectSecretInContent } from '../tools/builtin/http.js';
import { withListQuery, type ListQueryConstraints } from '../tools/permission-guard.js';

/**
 * A list as the source of an external bulk run (PRD bulk-loop §3.2), read end to end: the
 * run's stored read contract, the in-memory copy that grants the page query, the real client
 * and its checks, a shop that pages like WooCommerce.
 */

const HOST = 'shop.example.com';
const PATH = '/wp-json/wc/v3/products';
const PROVIDER_TEXT = 'PROVIDER-AUTHORED-TEXT';

interface Shop {
  items: Map<number, Record<string, unknown>>;
  requests: { method: string; path: string; search: string }[];
  /** Answer every list page with this instead. */
  listAnswer?: (page: number) => Response | null;
  /** Answer every item GET with this id instead of its own. */
  itemIdOverride?: Map<number, unknown>;
  /** The bytes of every list page body served from `items`. */
  listBytes: number;
}

function shop(n: number): Shop {
  const s: Shop = { items: new Map(), requests: [], listBytes: 0 };
  for (let i = 1; i <= n; i++) s.items.set(i, { id: i, name: `${PROVIDER_TEXT} ${String(i)}`, status: 'publish' });
  return s;
}

function serve(s: Shop): () => void {
  vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
  return setPinnedTransportForTests(async (input: PinnedTransportInput) => {
    const u = new URL(input.url);
    s.requests.push({ method: input.method, path: u.pathname, search: u.search });
    if (u.pathname === PATH) {
      const page = Number(u.searchParams.get('page'));
      const special = s.listAnswer?.(page);
      if (special) return special;
      const per = Number(u.searchParams.get('per_page'));
      const all = [...s.items.values()].sort((a, b) => (a['id'] as number) - (b['id'] as number));
      const body = JSON.stringify(all.slice((page - 1) * per, page * per));
      s.listBytes += Buffer.byteLength(body, 'utf8');
      return new Response(body, { status: 200 });
    }
    const id = Number(u.pathname.slice(PATH.length + 1));
    const item = s.items.get(id);
    if (!item) return new Response(null, { status: 404 });
    const body = s.itemIdOverride?.has(id) ? { ...item, id: s.itemIdOverride.get(id) } : item;
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

function client(contract: NonNullable<ReturnType<typeof parseBulkContract>>): ExternalClient {
  return externalClient({
    contract,
    hostPolicy: createToolContext({}),
    ackHosts: undefined,
    attach: async (_u, headers) => { headers['authorization'] = 'Basic fixture'; return true; },
    rateLimit: () => null,
    scan: detectSecretInContent,
  });
}

/** The client the worker builds: from the run's OWN stored contract, the page query only on a copy. */
const workerClientFor = (run: BulkRunForPreview, listQuery?: ListQueryConstraints): ExternalClient | null => {
  const stored = parseBulkContract(run.contractJson);
  if (!stored) return null;
  return client(listQuery === undefined ? stored : withListQuery(stored, listQuery));
};

const noSleep = async (): Promise<void> => {};
const deps = (extra: Partial<BulkPreviewDeps> = {}): BulkPreviewDeps =>
  ({ ledger, clientFor: workerClientFor, budget: new BulkHostBudget(100_000, 0), sleep: noSleep, ...extra });

const source: BulkListSource = parseListSource(HOST, { path: PATH, filters: { category: '12' }, after: { status: 'draft' } }, 'PUT', detectSecretInContent);

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-list-read-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function startedList(): string {
  const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source, readContract: listReadContract(HOST, source) });
  if (!out.ok) throw new Error(out.reason);
  const started = ledger.resumePreview(out.status.id, Date.now(), { listChecksum: ledger.listStartChecksum(out.status.id)! });
  if (!started.ok) throw new Error(started.reason);
  return out.status.id;
}

describe('reading a list', () => {
  it('reads the list page by page under the read contract, then halts for the owner with every target known', async () => {
    const s = shop(120);
    const restore = serve(s);
    try {
      const id = startedList();
      const out = await runBulkPreview(id, deps());
      expect(out.status).toBe('done');
      expect(ledger.getStatus(id)).toMatchObject({ phase: 'planned', total: 120, haltReason: BULK_HALT_REASONS.listed });
      // Three pages, each address as the engine builds it, and nothing else sent.
      expect(s.requests).toEqual([1, 2, 3].map((p) => ({
        method: 'GET', path: PATH, search: `?category=12&orderby=id&order=asc&per_page=50&page=${String(p)}`,
      })));
      // The write contract now names exactly the listed targets, with the run's verb.
      const contract = parseBulkContract(ledger.getListRun(id)!.contractJson)!;
      expect(contract.httpMethods).toEqual(['GET', 'PUT']);
      expect(contract.pathPatterns).toHaveLength(120);
      expect(contract.pathPatterns).toContain(`${PATH}/7`);
    } finally {
      restore();
    }
  });

  it('then, started again, reads each target at its own address and is ready for review', async () => {
    const s = shop(3);
    const restore = serve(s);
    try {
      const id = startedList();
      await runBulkPreview(id, deps());
      s.requests.length = 0;
      expect(ledger.resumePreview(id).ok).toBe(true);
      const out = await runBulkPreview(id, deps());
      expect(out.status).toBe('done');
      expect(ledger.getStatus(id)).toMatchObject({ phase: 'previewed', total: 3, changes: { update: 3 } });
      expect(s.requests.map((r) => `${r.method} ${r.path}${r.search}`)).toEqual([1, 2, 3].map((i) => `GET ${PATH}/${String(i)}`));
    } finally {
      restore();
    }
  });

  it('is refused by the stored contract alone: the page query is granted only on the in-memory copy', async () => {
    const s = shop(3);
    const restore = serve(s);
    try {
      const id = startedList();
      const out = await runBulkPreview(id, deps({ clientFor: (run) => workerClientFor(run) }));
      expect(out.status).toBe('halted');
      expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.contract);
      expect(s.requests).toEqual([]);
    } finally {
      restore();
    }
  });

  it('goes on from the page after the last one recorded when a tick ends', async () => {
    const s = shop(120);
    const restore = serve(s);
    try {
      const id = startedList();
      let t = 0;
      // The tick's time runs out right after the first page.
      const first = await runBulkPreview(id, deps({ now: () => t, budget: { take: () => { t += 10_000_000; return 0; } } as unknown as BulkHostBudget }));
      expect(first.status).toBe('pending');
      expect(ledger.getListRun(id)!.page).toBe(1);
      s.requests.length = 0;
      await runBulkPreview(id, deps());
      expect(s.requests.map((r) => new URL(`https://${HOST}${r.path}${r.search}`).searchParams.get('page'))).toEqual(['2', '3']);
      expect(ledger.getStatus(id)!.total).toBe(120);
    } finally {
      restore();
    }
  });

  it('marks a listed target read back as another element as not the one listed', async () => {
    const s = shop(2);
    s.itemIdOverride = new Map([[2, 99]]);
    const restore = serve(s);
    try {
      const id = startedList();
      await runBulkPreview(id, deps());
      ledger.resumePreview(id);
      await runBulkPreview(id, deps());
      expect(ledger.getStatus(id)!.invalidReasons).toEqual({ list_item_mismatch: 1 });
      expect(ledger.getStatus(id)!.changes.update).toBe(1);
    } finally {
      restore();
    }
  });
});

describe('what stops a list read — each with a fixed reason, nothing of the provider\'s', () => {
  async function stopsWith(s: Shop, reason: string, setup?: (id: string) => void): Promise<void> {
    const restore = serve(s);
    try {
      const id = startedList();
      setup?.(id);
      const out = await runBulkPreview(id, deps());
      expect(out.status).toBe('halted');
      expect(ledger.getStatus(id)!.haltReason).toBe(reason);
      expect(out.summary).not.toContain(PROVIDER_TEXT);
      expect(ledger.getStatus(id)!.total).toBeLessThanOrEqual(5000);
    } finally {
      restore();
    }
  }

  it('a page that is not a JSON array', async () => {
    const s = shop(3);
    s.listAnswer = () => new Response(JSON.stringify({ products: [...s.items.values()], note: PROVIDER_TEXT }), { status: 200 });
    await stopsWith(s, BULK_HALT_REASONS.listNotAList);
  });

  it('a page the host will not serve', async () => {
    const s = shop(3);
    s.listAnswer = () => new Response(PROVIDER_TEXT, { status: 404 });
    await stopsWith(s, BULK_HALT_REASONS.listUnreadable);
  });

  it('a page that redirects', async () => {
    const s = shop(3);
    s.listAnswer = () => new Response(null, { status: 302, headers: { location: `https://${HOST}/wp-json/wc/v3/customers` } });
    await stopsWith(s, BULK_HALT_REASONS.listUnreadable);
  });

  it('a host that fails three times in a row — and one failure is tried again on the same page', async () => {
    const s = shop(3);
    let calls = 0;
    s.listAnswer = () => (++calls <= 3 ? new Response(PROVIDER_TEXT, { status: 503 }) : null);
    await stopsWith(s, BULK_HALT_REASONS.consecutiveFailures);
    expect(s.requests.every((r) => r.search.endsWith('page=1'))).toBe(true);
  });

  it('a list that ignores the page asked for', async () => {
    const s = shop(120);
    s.listAnswer = () => new Response(JSON.stringify([...s.items.values()].slice(0, 50)), { status: 200 });
    await stopsWith(s, BULK_HALT_REASONS.listNoProgress);
    expect(s.requests).toHaveLength(2);
  });

  it('a list longer than a run may hold', async () => {
    await stopsWith(shop(5100), BULK_HALT_REASONS.listTooLarge);
  });

  it('a page larger than what is left of the source budget — and none of it is recorded', async () => {
    const s = shop(50);
    let id = '';
    await stopsWith(s, BULK_HALT_REASONS.listTooLarge, (runId) => {
      id = runId;
      engineDb.getDb().prepare('UPDATE bulk_runs SET list_bytes = ? WHERE id = ?').run(BULK_MAX_SOURCE_BYTES - 100, runId);
    });
    // The page is cut off at what is left, not read whole and refused on the next one.
    expect(s.requests).toHaveLength(1);
    expect(ledger.getStatus(id)!.total).toBe(0);
  });

  it('a source budget already spent — then nothing is sent', async () => {
    const s = shop(50);
    await stopsWith(s, BULK_HALT_REASONS.listTooLarge, (runId) => {
      engineDb.getDb().prepare('UPDATE bulk_runs SET list_bytes = ? WHERE id = ?').run(BULK_MAX_SOURCE_BYTES, runId);
    });
    expect(s.requests).toEqual([]);
  });

  it('a list that adds one element per page past the page cap — a halt, not a page it may not ask for', async () => {
    const s = shop(0);
    // Each full page repeats one element and adds one: progress, but never a short page.
    s.listAnswer = (page) => new Response(JSON.stringify([{ id: page }, ...Array.from({ length: 49 }, () => ({ id: 1 }))]), { status: 200 });
    await stopsWith(s, BULK_HALT_REASONS.listTooLarge);
    expect(s.requests).toHaveLength(maxListPages('woocommerce'));
  });

  it('a credential the host does not accept', async () => {
    const s = shop(3);
    s.listAnswer = () => new Response(PROVIDER_TEXT, { status: 401 });
    await stopsWith(s, BULK_HALT_REASONS.unauthorized);
  });
});

describe('what a list read keeps count of', () => {
  it('counts every page\'s bytes against the source budget', async () => {
    const s = shop(120);
    const restore = serve(s);
    try {
      const id = startedList();
      await runBulkPreview(id, deps());
      expect(s.listBytes).toBeGreaterThan(0);
      expect(ledger.getListRun(id)!.bytes).toBe(s.listBytes);
    } finally {
      restore();
    }
  });

  it('counts failures in a row, not in all: a host failing once on every page is read to the end', async () => {
    const s = shop(120);
    const failed = new Set<number>();
    s.listAnswer = (page) => {
      if (failed.has(page)) return null;
      failed.add(page);
      return new Response(PROVIDER_TEXT, { status: 503 });
    };
    const restore = serve(s);
    try {
      const id = startedList();
      const out = await runBulkPreview(id, deps());
      expect(out.status).toBe('done');
      expect(ledger.getStatus(id)).toMatchObject({ total: 120, haltReason: BULK_HALT_REASONS.listed });
    } finally {
      restore();
    }
  });

  it('stops for a run halted between two pages, even once the tick\'s time is up', async () => {
    const s = shop(120);
    const restore = serve(s);
    try {
      const id = startedList();
      let t = 0;
      const record = ledger.recordListPage.bind(ledger);
      vi.spyOn(ledger, 'recordListPage').mockImplementation((runId, page) => {
        const out = record(runId, page);
        // The owner halts the run while the page is recorded, and the tick runs out.
        ledger.halt(runId, BULK_HALT_REASONS.contract);
        t += 1e12;
        return out;
      });
      const out = await runBulkPreview(id, deps({ now: () => t }));
      expect(out.status).toBe('halted');
      expect(s.requests).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

describe('the worker\'s client for a list read', () => {
  it('grants the page query on its in-memory copy of the stored read contract', async () => {
    const s = shop(3);
    const restore = serve(s);
    try {
      const id = startedList();
      const engine = { getApiStore: () => new ApiStore(), getSecretStore: () => new SecretStore(), getToolContext: () => createToolContext({}) };
      const factory = await (WorkerLoop.prototype as unknown as {
        bulkClientFactory: (this: unknown) => Promise<(contractJson: string | null, listQuery?: ListQueryConstraints) => ExternalClient | null>;
      }).bulkClientFactory.call({ engine });
      const run = ledger.getListRun(id)!;
      const url = listPageUrl(HOST, run.source, 1);
      // Past the contract: what stops it is the missing stored credential, nothing is sent.
      expect(await factory(run.contractJson, listQueryParams(run.source))!.get(url)).toEqual({ kind: 'no_credential' });
      // The stored contract alone grants no query.
      expect(await factory(run.contractJson)!.get(url)).toEqual({ kind: 'not_granted' });
      expect(s.requests).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe('a list with no usable element', () => {
  it('ends the run with nothing to read', async () => {
    const s = shop(0);
    s.listAnswer = () => new Response(JSON.stringify([{ name: PROVIDER_TEXT }, { id: '../orders' }]), { status: 200 });
    const restore = serve(s);
    try {
      const id = startedList();
      const out = await runBulkPreview(id, deps());
      expect(out.status).toBe('done');
      expect(out.summary).not.toContain(PROVIDER_TEXT);
      expect(ledger.getStatus(id)).toMatchObject({ phase: 'previewed', haltReason: null, invalidReasons: { list_item_no_id: 1, list_item_bad_id: 1 } });
    } finally {
      restore();
    }
  });
});
