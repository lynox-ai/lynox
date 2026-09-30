import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn() },
}));

import dns from 'node:dns/promises';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, BULK_MAX_PREVIEWED_RUNS, canonicalJson, type PlannedTarget } from './bulk-ledger.js';
import {
  BULK_RETRY_AFTER_CAP_MS, BulkHostBudget, beforeOverFields, canonicalHost, externalClient, externalTargetKey,
  mintBulkContract, parseBulkContract, planExternal, retryAfterMs, type ExternalClient, type ExternalRead,
} from './bulk-external.js';
import { runBulkPreview, type BulkPreviewDeps } from './bulk-preview.js';
import { setPinnedTransportForTests, type PinnedTransportInput } from './network-guard.js';
import { TriggerStore, bulkPreviewTriggerId } from './trigger-store.js';
import { WorkerLoop } from './worker-loop.js';
import { ApiStore } from './api-store.js';
import { createToolContext, applyNetworkPolicy } from './tool-context.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { bulkPlanTool, bulkStatusTool } from '../tools/builtin/bulk.js';
import { detectSecretInContent } from '../tools/builtin/http.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { IAgent } from '../types/index.js';

/**
 * Build plan B, the read half (§2, §3, §6): an external bulk run is planned without a
 * request, read by the `bulk_preview` worker effect against a shop that answers the way
 * a shop does — server fields, normalised values — and compared over the field set F.
 */

const HOST = 'shop.example.com';
const TOKEN = 'not-a-real-token-only-a-fixture';
const MARK = 'ZXQ-SHOP-MARK';

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

// ── A shop behind the pinned transport ─────────────────────────────────────────

interface Shop {
  items: Map<string, Record<string, unknown>>;
  requests: PinnedTransportInput[];
  /** Per path, answered instead of the item — a status and headers. */
  special: Map<string, { status: number; headers?: Record<string, string>; body?: string }>;
}

function shop(): Shop {
  const s: Shop = { items: new Map(), requests: [], special: new Map() };
  for (let i = 0; i < 5; i++) {
    // Server fields beside the writable ones, and a price the shop stores normalised.
    s.items.set(`/products/${String(i)}`, { id: i, title: `Item ${String(i)} ${MARK}`, price: '12.00', updated_at: '2026-09-01T00:00:00Z' });
  }
  return s;
}

function serve(s: Shop): () => void {
  vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
  return setPinnedTransportForTests(async (input) => {
    s.requests.push(input);
    const path = new URL(input.url).pathname;
    const sp = s.special.get(path);
    if (sp) return new Response(sp.body ?? null, { status: sp.status, headers: sp.headers ?? {} });
    const item = s.items.get(path);
    if (!item) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(JSON.stringify(item), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

const url = (i: number | string): string => `https://${HOST}/products/${String(i)}`;

function contractFor(keys: string[]): ReturnType<typeof mintBulkContract> {
  return mintBulkContract(HOST, keys);
}

/** A client wired like the worker's, with an attach that fills the header. */
function client(opts: { attach?: boolean; rateLimit?: string | null; keys?: string[]; policy?: 'deny-all' } = {}): ExternalClient {
  const ctx = createToolContext({});
  if (opts.policy) applyNetworkPolicy(ctx, opts.policy, undefined);
  return externalClient({
    contract: contractFor(opts.keys ?? [0, 1, 2, 3, 4, 5, 9, 'x'].map(url)),
    hostPolicy: ctx,
    ackHosts: undefined,
    attach: async (_u, headers) => {
      if (opts.attach === false) return false;
      headers['authorization'] = `Bearer ${TOKEN}`;
      return true;
    },
    rateLimit: () => opts.rateLimit ?? null,
  });
}

/** Plan an external run and, unless `start` is false, start its read as the owner does. */
function planRun(rows: { target: string; after: unknown }[], start = true): string {
  const targets = planExternal(rows, HOST, detectSecretInContent);
  const keys = targets.filter((t) => !('invalid' in t)).map((t) => t.key);
  const out = ledger.recordExternalPlan({ createdBy: 't', host: HOST, targets, contract: contractFor(keys) });
  if (!out.ok) throw new Error(out.reason);
  if (start && out.status.phase === 'planned' && !ledger.resumePreview(out.status.id).ok) throw new Error('not started');
  return out.status.id;
}

const noSleep = async (): Promise<void> => {};
const previewDeps = (c: ExternalClient, extra: Partial<BulkPreviewDeps> = {}): BulkPreviewDeps =>
  ({ ledger, clientFor: () => c, budget: new BulkHostBudget(10_000, 0), sleep: noSleep, ...extra });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-preview-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
});

afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Planning: keys, F, and what a plan refuses ─────────────────────────────────

describe('planning an external run', () => {
  it('keys a target by its canonical https URL on the one host, and refuses every other shape', () => {
    expect(canonicalHost('Shop.Example.COM.')).toBe(HOST);
    for (const bad of ['1.2.3.4', 'shop.example.com:8443', 'shop.example.com/x', 'user@shop.example.com', 'localhost', '']) {
      expect(canonicalHost(bad)).toBeNull();
    }
    expect(externalTargetKey(HOST, 'https://SHOP.example.com/products/%7E1')).toBe(`https://${HOST}/products/%7E1`);
    for (const bad of [
      `http://${HOST}/p/1`, `https://other.example.com/p/1`, `https://${HOST}:8443/p/1`, `https://u:p@${HOST}/p/1`,
      `https://${HOST}/p/1?x=1`, `https://${HOST}/p/1?`, `https://${HOST}/p/1#f`, `https://${HOST}/p/*`, 'not a url',
    ]) {
      expect(externalTargetKey(HOST, bad), bad).toBeNull();
    }
  });

  it('marks what it cannot plan with a fixed reason, and refuses a doubled target', () => {
    const planned = planExternal([
      { target: url(0), after: { price: '15.00' } },
      { target: `http://${HOST}/products/1`, after: { price: '1' } },
      { target: url(2), after: [] },
      { target: url(3), after: {} },
      { target: url(4), after: { variants: [1] } },
      { target: url(5), after: { note: { a: 1 } } },
      { target: url(6), after: { token: 'sk-ant-api03-' + 'A'.repeat(90) } },
    ], HOST, detectSecretInContent);
    expect(planned.map((t) => ('invalid' in t ? t.invalid : 'ok'))).toEqual([
      'ok', 'bad_url', 'after_not_object', 'after_not_object', 'field_not_scalar', 'field_not_scalar', 'secret_in_after',
    ]);
    expect(() => planExternal([{ target: url(0), after: { a: 1 } }, { target: url(0), after: { a: 2 } }], HOST, detectSecretInContent))
      .toThrow(/more than once/);
  });

  it('mints the run contract at plan time: GET and PATCH on the host and exactly its paths', () => {
    const c = mintBulkContract(HOST, [url(1), url(0), url(1)]);
    expect(c).toMatchObject({ origin: 'reviewed', grantedTools: ['http_request'], httpMethods: ['GET', 'PATCH'], hostPatterns: [HOST] });
    expect(c.pathPatterns).toEqual(['/products/0', '/products/1']);
    expect(parseBulkContract(JSON.stringify(c))).toEqual(c);
    expect(parseBulkContract('{"grantedTools":[]}')).toBeNull();
  });

  it('records the run as planned and waiting for the owner, arms nothing, and sends nothing (the start gate)', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = planRun([{ target: url(0), after: { price: '15.00' } }, { target: url(9), after: [] }], false);
      const st = ledger.getStatus(runId)!;
      expect([st.phase, st.targetSystem, st.unread, st.changes.invalid]).toEqual(['planned', `http:${HOST}`, 1, 1]);
      // The gate itself, asserted as state: halted with its fixed reason, no trigger at all.
      expect(st.haltReason).toBe(BULK_HALT_REASONS.awaitingStart);
      const triggers = new TriggerStore(engineDb);
      expect(triggers.getById(bulkPreviewTriggerId(runId))).toBeUndefined();
      expect(triggers.getDue()).toEqual([]);
      // Waiting for its start, it does not hold the one-external-run slot.
      expect(planRun([{ target: url(1), after: { price: '1' } }], false)).toBeTruthy();
      // The owner's start arms the preview trigger, due at once.
      expect(ledger.resumePreview(runId).ok).toBe(true);
      expect(ledger.getStatus(runId)!.haltReason).toBeNull();
      expect(triggers.getDue().map((t) => [t.id, t.effect, t.bulk_run_id])).toEqual([[bulkPreviewTriggerId(runId), 'bulk_preview', runId]]);
      expect(s.requests).toEqual([]);
      // Nothing is approvable before the preview: no checksum is offered for a planned run.
      expect(ledger.approve(runId, { checksum: ledger.computeChecksum(runId)! })).toEqual({ ok: false, reason: 'wrong_phase' });
    } finally {
      restore();
    }
  });

  it('refuses a second external plan while one is still reading, and allows it once that one halted', () => {
    const first = planRun([{ target: url(0), after: { price: '1' } }]);
    const targets = planExternal([{ target: url(1), after: { price: '1' } }], HOST, detectSecretInContent);
    const again = (): ReturnType<BulkLedger['recordExternalPlan']> =>
      ledger.recordExternalPlan({ createdBy: 't', host: HOST, targets, contract: contractFor([url(1)]) });
    expect(again()).toEqual({ ok: false, reason: 'external_in_progress' });
    ledger.halt(first, BULK_HALT_REASONS.credential);
    expect(again().ok).toBe(true);
  });

  it('a plan with no valid target is complete as planned and arms nothing', () => {
    const runId = planRun([{ target: `http://${HOST}/x`, after: { a: 1 } }]);
    expect(ledger.getStatus(runId)!.phase).toBe('previewed');
    expect(new TriggerStore(engineDb).getDue()).toEqual([]);
  });
});

// ── Reading one target ────────────────────────────────────────────────────────

describe('the read of one target', () => {
  it('projects the response onto F and refuses what the undo could not restore', () => {
    const after = { price: '15.00', title: 'x' };
    expect(beforeOverFields({ id: 1, price: '12.00', title: 'y', updated_at: 'z' }, after)).toEqual({ before: { price: '12.00', title: 'y' } });
    // Present-and-null is a value; absent is not (Object.hasOwn, not a serialised form).
    expect(beforeOverFields({ price: null, title: 'y' }, after)).toEqual({ before: { price: null, title: 'y' } });
    expect(beforeOverFields({ title: 'y' }, after)).toEqual({ invalid: 'field_missing' });
    // `undefined` is no JSON value: present in the object, still not a scalar a PATCH could restore.
    expect(beforeOverFields({ price: undefined, title: 'y' }, after)).toEqual({ invalid: 'field_not_scalar' });
    expect(beforeOverFields(Object.create({ price: '1', title: 'y' }) as unknown, after)).toEqual({ invalid: 'before_not_object' });
    expect(beforeOverFields([{ price: '1' }], after)).toEqual({ invalid: 'before_not_object' });
    expect(beforeOverFields({ price: ['1'], title: 'y' }, after)).toEqual({ invalid: 'field_not_scalar' });
  });

  it('answers each response in the fixed vocabulary, following no redirect', async () => {
    const s = shop();
    s.special.set('/products/1', { status: 302, headers: { location: `https://${HOST}/products/0` } });
    s.special.set('/products/2', { status: 401 });
    s.special.set('/products/3', { status: 429, headers: { 'retry-after': '7' } });
    s.special.set('/products/4', { status: 200, body: 'not json' });
    const restore = serve(s);
    try {
      const c = client();
      const kinds: ExternalRead['kind'][] = [];
      for (const i of [0, 1, 2, 3, 4, 'x']) kinds.push((await c.get(url(i))).kind);
      expect(kinds).toEqual(['ok', 'redirect', 'unauthorized', 'retry_after', 'not_json', 'not_found']);
      // One request per call: the 302 was an answer, not a hop.
      expect(s.requests.map((r) => new URL(r.url).pathname)).toEqual(['/products/0', '/products/1', '/products/2', '/products/3', '/products/4', '/products/x']);
      expect(s.requests.every((r) => r.method === 'GET' && r.headers['authorization'] === `Bearer ${TOKEN}`)).toBe(true);
      expect(await c.get(url(3))).toEqual({ kind: 'retry_after', ms: 7_000 });
    } finally {
      restore();
    }
  });

  it('sends nothing without a credential, outside its contract, under a blocking policy or a spent rate limit', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      expect(await client({ attach: false }).get(url(0))).toEqual({ kind: 'no_credential' });
      expect(await client({ keys: [url(1)] }).get(url(0))).toEqual({ kind: 'not_granted' });
      expect(await client({ policy: 'deny-all' }).get(url(0))).toEqual({ kind: 'blocked' });
      expect(await client({ rateLimit: 'spent' }).get(url(0))).toEqual({ kind: 'rate_limited' });
      expect(s.requests).toEqual([]);
      // …and the same client does send when nothing stands in the way (the witness).
      expect((await client().get(url(0))).kind).toBe('ok');
      expect(s.requests).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('caps Retry-After at a minute, however it is given', () => {
    expect(retryAfterMs('3', 0)).toBe(3_000);
    expect(retryAfterMs('86400', 0)).toBe(BULK_RETRY_AFTER_CAP_MS);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(retryAfterMs(null, 0)).toBe(BULK_RETRY_AFTER_CAP_MS);
    expect(retryAfterMs('soon', 0)).toBe(BULK_RETRY_AFTER_CAP_MS);
  });
});

// ── The host budget ───────────────────────────────────────────────────────────

describe('the host budget (§6 Q3(c))', () => {
  it('paces requests per host and caps them per sliding hour, consuming only what it grants', () => {
    const b = new BulkHostBudget(3, 200);
    expect(b.take(HOST, 0)).toBe(0);
    expect(b.take(HOST, 50)).toBe(150);
    expect(b.take('other.example.com', 50)).toBe(0);
    expect(b.take(HOST, 200)).toBe(0);
    expect(b.take(HOST, 400)).toBe(0);
    // Three in the hour: the fourth waits until the first leaves the window.
    expect(b.take(HOST, 1_000)).toBe(3_600_000 - 1_000);
    expect(b.take(HOST, 3_600_001)).toBe(0);
  });
});

// ── The preview effect ───────────────────────────────────────────────────────

describe('the preview effect', () => {
  it('reads a run against the shop, compares over F and closes it as previewed', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = planRun([
        { target: url(0), after: { price: '12.00' } }, // what the shop holds → unchanged
        { target: url(1), after: { price: '15.00' } }, // → update
        { target: url(9), after: { price: '1.00' } }, // 404 → invalid
        { target: url(2), after: { price: '1.00', color: 'red' } }, // no such field → invalid
      ]);
      const out = await runBulkPreview(runId, previewDeps(client()));
      expect(out.status).toBe('done');
      const st = ledger.getStatus(runId)!;
      expect([st.phase, st.unread, st.changes.update, st.changes.unchanged, st.changes.invalid]).toEqual(['previewed', 0, 1, 1, 2]);
      expect(st.invalidReasons).toEqual({ not_found: 1, field_missing: 1 });
      const preview = ledger.getPreview(runId);
      // The before-image holds F only: no server field, no title with the shop's text.
      expect(preview[1]!.before).toEqual({ absent: false, value: { price: '12.00' } });
      expect(preview[1]!.diff).toEqual({ kind: 'fields', fields: [{ field: 'price', before: '12.00', after: '15.00' }] });
      expect(JSON.stringify(preview)).not.toContain(MARK);
      expect(out.summary).not.toContain(MARK);
      // Reviewable, and the write side is not built: approval is refused, nothing sent.
      const sent = s.requests.length;
      expect(ledger.approve(runId, { checksum: ledger.computeChecksum(runId)! })).toEqual({ ok: false, reason: 'external_not_writable' });
      expect(s.requests.length).toBe(sent);
    } finally {
      restore();
    }
  });

  it('a normalised value the shop stores differently is a change, not a match', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = planRun([{ target: url(0), after: { price: '12' } }]);
      await runBulkPreview(runId, previewDeps(client()));
      expect(ledger.getStatus(runId)!.changes.update).toBe(1);
    } finally {
      restore();
    }
  });

  it('refuses a run that is not planned or is halted, and reads nothing', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = planRun([{ target: url(0), after: { price: '1' } }]);
      ledger.halt(runId, BULK_HALT_REASONS.timeBudget);
      expect((await runBulkPreview(runId, previewDeps(client()))).status).toBe('refused');
      const local = ledger.recordDryRun({ createdBy: 't', targetSystem: 'workspace', scope: 'w', targets: [] as PlannedTarget[] });
      expect((await runBulkPreview(local.id, previewDeps(client()))).status).toBe('refused');
      expect((await runBulkPreview('nope', previewDeps(client()))).status).toBe('refused');
      expect(s.requests).toEqual([]);
    } finally {
      restore();
    }
  });

  it('halts at the first target without a credential, and the owner\'s resume reads on', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = planRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '1' } })));
      const out = await runBulkPreview(runId, previewDeps(client({ attach: false })));
      expect(out.status).toBe('halted');
      expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.credential);
      expect(s.requests).toEqual([]);

      const again = ledger.resumePreview(runId);
      expect(again.ok).toBe(true);
      expect((await runBulkPreview(runId, previewDeps(client()))).status).toBe('done');
      expect(ledger.resumePreview(runId)).toEqual({ ok: false, reason: 'wrong_phase' });
    } finally {
      restore();
    }
  });

  it('halts on a refused credential and on a host that keeps failing, not on one bad target', async () => {
    const s = shop();
    s.special.set('/products/1', { status: 401 });
    const restore = serve(s);
    try {
      const runId = planRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '1' } })));
      expect((await runBulkPreview(runId, previewDeps(client()))).status).toBe('halted');
      expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.unauthorized);
      expect(s.requests).toHaveLength(2);
    } finally {
      restore();
    }
    const s2 = shop();
    for (const i of [0, 1, 3, 4, 5]) s2.special.set(`/products/${String(i)}`, { status: 503 });
    const restore2 = serve(s2);
    try {
      ledger = new BulkLedger(engineDb);
      engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'aborted'`).run();
      const runId = planRun([0, 1, 2, 3, 4, 5].map((i) => ({ target: url(i), after: { price: '1' } })));
      expect((await runBulkPreview(runId, previewDeps(client()))).status).toBe('halted');
      const st = ledger.getStatus(runId)!;
      // 0, 1 failed, 2 read and broke the streak, then 3, 4, 5: the third in a row halts.
      expect(st.haltReason).toBe(BULK_HALT_REASONS.consecutiveFailures);
      // A failing host drops no target: the five stay unread for the resume.
      expect([st.unread, st.changes.invalid]).toEqual([5, 0]);
      s2.special.clear();
      expect(ledger.resumePreview(runId).ok).toBe(true);
      expect((await runBulkPreview(runId, previewDeps(client()))).status).toBe('done');
      // Five items exist; the shop has no /products/5, which the resume found out.
      expect([ledger.getStatus(runId)!.changes.update, ledger.getStatus(runId)!.invalidReasons]).toEqual([5, { not_found: 1 }]);
    } finally {
      restore2();
    }
  });

  it('waits out one 429 and ends the tick on a second, due again when the host said', async () => {
    const s = shop();
    let hits = 0;
    const restore = setPinnedTransportForTests(async (input) => {
      s.requests.push(input);
      hits++;
      if (hits === 1 || hits >= 3) return new Response(null, { status: 429, headers: { 'retry-after': '1' } });
      return new Response(JSON.stringify({ price: '12.00' }), { status: 200 });
    });
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    try {
      const runId = planRun([0, 1].map((i) => ({ target: url(i), after: { price: '1' } })));
      const slept: number[] = [];
      const out = await runBulkPreview(runId, previewDeps(client(), { sleep: async (ms) => { slept.push(ms); }, now: () => 1_000 }));
      expect(slept).toEqual([1_000, 1_000]);
      expect(out).toMatchObject({ status: 'pending', retryAt: 2_000 });
      expect(ledger.getStatus(runId)!.unread).toBe(1);
    } finally {
      restore();
    }
  });

  it('ends the tick on a Retry-After longer than a second instead of sleeping it', async () => {
    const s = shop();
    s.special.set('/products/0', { status: 429, headers: { 'retry-after': '30' } });
    const restore = serve(s);
    try {
      const runId = planRun([0].map((i) => ({ target: url(i), after: { price: '1' } })));
      const slept: number[] = [];
      const out = await runBulkPreview(runId, previewDeps(client(), { sleep: async (ms) => { slept.push(ms); }, now: () => 0 }));
      expect(out).toMatchObject({ status: 'pending', retryAt: 30_000 });
      expect(slept).toEqual([]);
      expect(s.requests).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('reads a target that failed once again after the others, and gives up on it the second time', async () => {
    const s = shop();
    s.special.set('/products/1', { status: 502 });
    const restore = serve(s);
    try {
      const runId = planRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '1' } })));
      const first = await runBulkPreview(runId, previewDeps(client()));
      expect(first.status).toBe('pending');
      expect([ledger.getStatus(runId)!.unread, ledger.getStatus(runId)!.changes.invalid]).toEqual([1, 0]);
      // Marked, it is last in line.
      expect(ledger.listUnread(runId)).toEqual([1]);
      const second = await runBulkPreview(runId, previewDeps(client()));
      expect(second.status).toBe('done');
      expect(ledger.getStatus(runId)!.invalidReasons).toEqual({ read_failed: 1 });
      expect(s.requests.map((r) => new URL(r.url).pathname)).toEqual(['/products/0', '/products/1', '/products/2', '/products/1']);
    } finally {
      restore();
    }
  });

  it('puts a target that failed once behind every target not yet tried, and a success clears the mark', () => {
    const runId = planRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '1' } })));
    expect(ledger.recordReadFailure(runId, 0)).toBe('retry');
    expect(ledger.listUnread(runId)).toEqual([1, 2, 0]);
    expect(ledger.recordRead(runId, 0, { before: { price: '2' } })).toBe(true);
    // The mark is gone, not only uncounted: a later apply skips any target holding an error.
    expect(ledger.getPreview(runId)[0]!.error).toBeNull();
    expect(ledger.getStatus(runId)!.invalidReasons).toEqual({});
    expect(ledger.recordReadFailure(runId, 1)).toBe('retry');
    expect(ledger.recordReadFailure(runId, 1)).toBe('invalid');
    expect(ledger.recordReadFailure(runId, 1)).toBeNull();
    ledger.halt(runId, BULK_HALT_REASONS.timeBudget);
    expect(ledger.recordReadFailure(runId, 2)).toBeNull();
  });

  it('a halt from the worker keeps the reason a preview already set', () => {
    const runId = planRun([{ target: url(0), after: { price: '1' } }]);
    ledger.haltPreview(runId, BULK_HALT_REASONS.credential);
    ledger.haltPreview(runId, BULK_HALT_REASONS.unavailable);
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.credential);
  });

  it('marks a target the host refuses (4xx) or answers too large as invalid, and reads on', async () => {
    const s = shop();
    s.special.set('/products/0', { status: 400 });
    s.special.set('/products/1', { status: 200, body: JSON.stringify({ price: '1', pad: 'x'.repeat(1024 * 1024) }) });
    const restore = serve(s);
    try {
      const runId = planRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '1' } })));
      expect((await runBulkPreview(runId, previewDeps(client()))).status).toBe('done');
      expect(ledger.getStatus(runId)!.invalidReasons).toEqual({ read_failed: 1, target_too_large: 1 });
    } finally {
      restore();
    }
  });

  it('a body that breaks off while streaming is a failed read, not an exception', async () => {
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    const restore = setPinnedTransportForTests(async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new Error('socket hang up')); },
    }), { status: 200 }));
    try {
      expect(await client().get(url(0))).toEqual({ kind: 'failed' });
    } finally {
      restore();
    }
  });

  it('halts through the effect on a private address, a target outside the contract, and the time budget', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      vi.mocked(dns.lookup).mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
      const a = planRun([{ target: url(0), after: { price: '1' } }]);
      expect((await runBulkPreview(a, previewDeps(client()))).status).toBe('halted');
      expect(ledger.getStatus(a)!.haltReason).toBe(BULK_HALT_REASONS.blocked);
      expect(s.requests).toEqual([]);
      vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);

      const b = planRun([{ target: url(1), after: { price: '1' } }]);
      expect((await runBulkPreview(b, previewDeps(client({ keys: [url(0)] })))).status).toBe('halted');
      expect(ledger.getStatus(b)!.haltReason).toBe(BULK_HALT_REASONS.contract);
      expect(s.requests).toEqual([]);

      const c = planRun([0, 1].map((i) => ({ target: url(i), after: { price: '1' } })));
      let t = 0;
      const slow: ExternalClient = { get sent() { return 0; }, async get(u, sig) { t += 61_000; return client().get(u, sig); } };
      expect((await runBulkPreview(c, previewDeps(slow, { now: () => t }))).status).toBe('halted');
      expect(ledger.getStatus(c)!.haltReason).toBe(BULK_HALT_REASONS.timeBudget);
      expect(ledger.getStatus(c)!.unread).toBe(1);
    } finally {
      restore();
    }
  });

  it('spends the host budget before each request, and waits rather than going over it', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = planRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '1' } })));
      const budget = new BulkHostBudget(2, 0);
      const out = await runBulkPreview(runId, previewDeps(client(), { budget, now: () => 0 }));
      expect(out).toMatchObject({ status: 'pending', retryAt: 3_600_000 });
      expect(s.requests).toHaveLength(2);
      // Pacing below a second is slept through, not ended.
      engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'aborted' WHERE id = ?`).run(runId);
      const second = planRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '2' } })));
      const slept: number[] = [];
      const paced = new BulkHostBudget(100, 200);
      let t = 10_000;
      const out2 = await runBulkPreview(second, previewDeps(client(), { budget: paced, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } }));
      expect(out2.status).toBe('done');
      expect(slept).toEqual([200, 200]);
    } finally {
      restore();
    }
  });

  it('the budget is shared: two runs on one host draw from one', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const budget = new BulkHostBudget(3, 0);
      const a = planRun([0, 1].map((i) => ({ target: url(i), after: { price: '1' } })));
      await runBulkPreview(a, previewDeps(client(), { budget, now: () => 0 }));
      engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'aborted' WHERE id = ?`).run(a);
      const b = planRun([2, 3].map((i) => ({ target: url(i), after: { price: '1' } })));
      const out = await runBulkPreview(b, previewDeps(client(), { budget, now: () => 1 }));
      expect(out.status).toBe('pending');
      expect(s.requests).toHaveLength(3);
    } finally {
      restore();
    }
  });

  it('does not read a target again, and stops between targets when the tick is stopped', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = planRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '1' } })));
      const controller = new AbortController();
      const c = client();
      const stopping: ExternalClient = {
        get sent() { return c.sent; },
        async get(u, signal) {
          const r = await c.get(u, signal);
          controller.abort();
          return r;
        },
      };
      const first = await runBulkPreview(runId, previewDeps(stopping, { signal: controller.signal }));
      expect(first.status).toBe('pending');
      expect(s.requests).toHaveLength(1);
      await runBulkPreview(runId, previewDeps(c));
      expect(s.requests.map((r) => new URL(r.url).pathname)).toEqual(['/products/0', '/products/1', '/products/2']);
      expect(ledger.getStatus(runId)!.phase).toBe('previewed');
    } finally {
      restore();
    }
  });

  it('states what the calls cost on a per-call profile, counting only requests that went out', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const refused = planRun([0, 1].map((i) => ({ target: url(i), after: { price: '1' } })));
      const none = await runBulkPreview(refused, previewDeps(client({ attach: false }), { costPerCallUsd: 0.002 }));
      expect(none.summary).not.toMatch(/API calls/);
      ledger.resumePreview(refused);
      const out = await runBulkPreview(refused, previewDeps(client(), { costPerCallUsd: 0.002 }));
      expect(out.summary).toContain('2 API calls this tick at $0.002 each ($0.0040).');
      expect(s.requests).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('stops reading a run that was halted between two targets', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = planRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '1' } })));
      const c = client();
      const halting: ExternalClient = {
        get sent() { return c.sent; },
        async get(u, signal) {
          const r = await c.get(u, signal);
          ledger.halt(runId, BULK_HALT_REASONS.timeBudget);
          return r;
        },
      };
      expect((await runBulkPreview(runId, previewDeps(halting))).status).toBe('halted');
      expect(s.requests).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('never closes a preview while a target is unread (§6 Q4)', () => {
    const runId = planRun([0, 1].map((i) => ({ target: url(i), after: { price: '1' } })));
    expect(ledger.recordRead(runId, 0, { before: { price: '2' } })).toBe(true);
    expect(ledger.finishPreview(runId)).toBe(false);
    expect(ledger.getStatus(runId)!.phase).toBe('planned');
    // A read is recorded once, and not into a halted run.
    expect(ledger.recordRead(runId, 0, { before: { price: '3' } })).toBe(false);
    ledger.halt(runId, BULK_HALT_REASONS.timeBudget);
    expect(ledger.recordRead(runId, 1, { before: { price: '3' } })).toBe(false);
  });

  it('a displaced planned run takes its trigger with it, and a running preview stops on it (§6 Q3(b))', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = planRun([0, 1].map((i) => ({ target: url(i), after: { price: '1' } })));
      const c = client();
      const displacing: ExternalClient = {
        get sent() { return c.sent; },
        async get(u, signal) {
          const r = await c.get(u, signal);
          for (let i = 0; i < BULK_MAX_PREVIEWED_RUNS; i++) {
            ledger.recordDryRun({ createdBy: 't', targetSystem: 'workspace', scope: `w${String(i)}`, targets: [] as PlannedTarget[] });
          }
          return r;
        },
      };
      const out = await runBulkPreview(runId, previewDeps(displacing));
      expect(out.status).toBe('halted');
      expect(ledger.getStatus(runId)).toBeNull();
      expect(new TriggerStore(engineDb).getById(bulkPreviewTriggerId(runId))).toBeUndefined();
      expect(s.requests).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

// ── The checksum ─────────────────────────────────────────────────────────────

describe('the approval checksum of an external run', () => {
  it('covers the contract, and leaves a local run\'s digest what it was', () => {
    const runId = planRun([{ target: url(0), after: { price: '1' } }]);
    const before = ledger.computeChecksum(runId);
    const widened = { ...contractFor([url(0)]), hostPatterns: ['*'] };
    engineDb.getDb().prepare('UPDATE bulk_runs SET contract_json = ? WHERE id = ?').run(JSON.stringify(widened), runId);
    expect(ledger.computeChecksum(runId)).not.toBe(before);

    // A local run: the digest over exactly the parts it had before contracts existed.
    const local = ledger.recordDryRun({
      createdBy: 't', targetSystem: 'workspace', scope: 'w',
      targets: [{ key: '/a', before: { absent: false, value: 'x' }, after: 'y' }],
    });
    const row = engineDb.getDb().prepare('SELECT * FROM bulk_runs WHERE id = ?').get(local.id) as Record<string, string | number | null>;
    const t = engineDb.getDb().prepare('SELECT * FROM bulk_targets WHERE run_id = ?').get(local.id) as Record<string, string>;
    const expected = engineDb.keyedHash([
      'bulk-approval-v1', String(row['kind']), String(row['target_system']), '', String(row['atomic']), '', String(row['rule_hash']),
      '0', engineDb.dec(t['target_key']!), t['change']!, engineDb.dec(t['before']!), engineDb.dec(t['after_planned']!),
    ]);
    expect(ledger.computeChecksum(local.id)).toBe(expected);
  });
});

// ── Through the model tool and a real worker tick ─────────────────────────────

/** A worker loop over this file's ledger, with a real ApiStore profile for the host and
 *  a vault that holds (or does not hold) its token. */
function workerFor(opts: { ack?: boolean; token?: string | null; costUsd?: number; rateLimit?: () => string | null } = {}) {
  const apiStore = new ApiStore();
  apiStore.register({
    id: 'shop', name: 'Shop', base_url: `https://${HOST}/`, description: 'Shop',
    auth: { type: 'bearer', vault_keys: ['SHOP_TOKEN'] },
    ...(opts.ack === false ? {} : { custom_endpoint_ack: { accepted: true, hosts: [HOST], accepted_at: '2026-09-30T00:00:00.000Z' } }),
    ...(opts.costUsd !== undefined ? { cost: { model: 'per_call' as const, rate_usd: opts.costUsd } } : {}),
  });
  if (opts.rateLimit) apiStore.checkRateLimit = opts.rateLimit;
  const token = opts.token === undefined ? TOKEN : opts.token;
  const triggers = new TriggerStore(engineDb);
  const recordTaskRun = vi.fn((id: string, result: string, status: 'success' | 'failed' | 'timeout') => {
    triggers.updateFields(id, { status: status === 'success' ? 'completed' : 'failed' });
    triggers.updateRunResult(id, { lastRunAt: new Date().toISOString(), lastRunResult: result, lastRunStatus: status, nextRunAt: null });
  });
  const engine = {
    getTaskManager: () => ({
      getDueTriggers: () => triggers.getDue(),
      getExpiredWaitingTriggers: () => [],
      endWait: () => false,
      getTrigger: (id: string) => triggers.getById(id),
      recordTaskRun,
    }),
    getBulkLedger: () => ledger,
    getApiStore: () => apiStore,
    getSecretStore: () => ({ resolve: (k: string) => (k === 'SHOP_TOKEN' ? token : null) }),
    getToolContext: () => createToolContext({}),
    getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
    getUserConfig: () => ({}),
  } as unknown as Engine;
  const notify = vi.fn(async () => {});
  const loop = new WorkerLoop(engine, { hasChannels: () => true, notify } as unknown as NotificationRouter, 60_000);
  const tick = async (): Promise<void> => {
    await loop.tick();
    await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 10_000 });
  };
  return { tick, recordTaskRun, notify, triggers };
}

describe('bulk_plan → trigger → worker tick → previewed', () => {
  it('plans through the tool, reads through the worker with the stored credential, reports counts only', async () => {
    const ws = join(dir, 'workspace');
    mkdirSync(ws);
    setTenantWorkspace(ws);
    const s = shop();
    const restore = serve(s);
    try {
      writeFileSync(join(ws, 'src.json'), JSON.stringify([
        { target: url(0), after: { price: '15.00' } },
        { target: url(1), after: { price: '12.00' } },
      ]));
      const agent = { toolContext: { bulkLedger: ledger }, currentThreadId: 'thread-1' } as unknown as IAgent;
      const planned = await bulkPlanTool.handler({ target_system: 'http', target_host: 'SHOP.example.com.', source_file: 'src.json' }, agent);
      expect(planned).toContain('Nothing is read either until the user starts it outside this chat.');
      expect(planned).toContain('phase planned');
      expect(planned).toContain(`Halted: ${BULK_HALT_REASONS.awaitingStart}.`);
      expect(planned).not.toContain(MARK);
      expect(s.requests).toEqual([]);
      const runId = /Bulk run ([0-9a-f-]{36})/.exec(planned)![1]!;
      // The owner starts it; while it reads, a second external plan is refused.
      expect(ledger.resumePreview(runId).ok).toBe(true);
      expect(await bulkPlanTool.handler({ target_system: 'http', target_host: HOST, source_file: 'src.json' }, agent)).toMatch(/another external dry run/);

      const apiStore = new ApiStore();
      apiStore.register({
        id: 'shop', name: 'Shop', base_url: `https://${HOST}/`, description: 'Shop',
        auth: { type: 'bearer', vault_keys: ['SHOP_TOKEN'] },
        custom_endpoint_ack: { accepted: true, hosts: [HOST], accepted_at: '2026-09-30T00:00:00.000Z' },
      });
      const triggers = new TriggerStore(engineDb);
      const recordTaskRun = vi.fn((id: string, result: string, status: 'success' | 'failed' | 'timeout') => {
        triggers.updateFields(id, { status: status === 'success' ? 'completed' : 'failed' });
        triggers.updateRunResult(id, { lastRunAt: new Date().toISOString(), lastRunResult: result, lastRunStatus: status, nextRunAt: null });
      });
      const engine = {
        getTaskManager: () => ({
          getDueTriggers: () => triggers.getDue(),
          getExpiredWaitingTriggers: () => [],
          endWait: () => false,
          getTrigger: (id: string) => triggers.getById(id),
          recordTaskRun,
        }),
        getBulkLedger: () => ledger,
        getApiStore: () => apiStore,
        getSecretStore: () => ({ resolve: (k: string) => (k === 'SHOP_TOKEN' ? TOKEN : null) }),
        getToolContext: () => createToolContext({}),
        getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
        getUserConfig: () => ({}),
      } as unknown as Engine;
      const notify = vi.fn(async () => {});
      const loop = new WorkerLoop(engine, { hasChannels: () => true, notify } as unknown as NotificationRouter, 60_000);
      await loop.tick();
      await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 10_000 });

      expect(recordTaskRun.mock.calls[0]![2]).toBe('success');
      const auth = (h: Record<string, string>): string | undefined => Object.entries(h).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
      expect(s.requests.map((r) => [r.method, auth(r.headers)])).toEqual([['GET', `Bearer ${TOKEN}`], ['GET', `Bearer ${TOKEN}`]]);
      const status = await bulkStatusTool.handler({ run_id: runId }, agent);
      expect(status).toContain('phase previewed');
      expect(status).toContain('update 1');
      expect(status).toContain('unchanged 1');
      expect(status).not.toContain(MARK);
      expect(status).not.toContain('pathPatterns');
      expect(JSON.stringify([recordTaskRun.mock.calls, notify.mock.calls])).not.toContain(MARK);
      expect(triggers.getDue()).toEqual([]);
      expect(canonicalJson(ledger.getPreview(runId).map((p) => p.before))).toBe(canonicalJson([
        { absent: false, value: { price: '12.00' } }, { absent: false, value: { price: '12.00' } },
      ]));
    } finally {
      restore();
      clearTenantWorkspace();
    }
  });

  it('sends nothing and halts, notifying the owner, when the profile has no acceptance or the vault no token', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      for (const opts of [{ ack: false }, { token: null }]) {
        engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'aborted'`).run();
        const runId = planRun([{ target: url(0), after: { price: '1' } }]);
        const w = workerFor(opts);
        await w.tick();
        expect(w.recordTaskRun.mock.calls[0]![2], JSON.stringify(opts)).toBe('failed');
        expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.credential);
        expect(JSON.stringify(w.notify.mock.calls)).toContain(BULK_HALT_REASONS.credential);
        expect(w.triggers.getDue()).toEqual([]);
      }
      expect(s.requests).toEqual([]);
    } finally {
      restore();
    }
  });

  it('re-arms the trigger for when the host said to come back, and keeps the run planned', async () => {
    const s = shop();
    s.special.set('/products/0', { status: 429, headers: { 'retry-after': '30' } });
    const restore = serve(s);
    try {
      const runId = planRun([{ target: url(0), after: { price: '1' } }]);
      const w = workerFor();
      const before = Date.now();
      await w.tick();
      expect(w.recordTaskRun.mock.calls[0]![2]).toBe('success');
      const t = w.triggers.getById(bulkPreviewTriggerId(runId))!;
      expect(t.status).toBe('open');
      const due = Date.parse(t.next_run_at!);
      expect(due).toBeGreaterThanOrEqual(before + 29_000);
      expect(due).toBeLessThanOrEqual(Date.now() + 31_000);
      expect(ledger.getStatus(runId)!.phase).toBe('planned');
      expect(w.notify).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('states the cost of a per-call profile in the run result', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      planRun([0, 1].map((i) => ({ target: url(i), after: { price: '1' } })));
      const w = workerFor({ costUsd: 0.01 });
      await w.tick();
      expect(w.recordTaskRun.mock.calls[0]![1]).toContain('2 API calls this tick at $0.01 each ($0.0200).');
    } finally {
      restore();
    }
  });

  it('a preview that throws halts its run instead of orphaning it', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = planRun([{ target: url(0), after: { price: '1' } }]);
      const w = workerFor({ rateLimit: () => { throw new Error('boom'); } });
      await w.tick();
      expect(w.recordTaskRun.mock.calls[0]![2]).toBe('failed');
      const st = ledger.getStatus(runId)!;
      expect([st.phase, st.haltReason]).toEqual(['planned', BULK_HALT_REASONS.unavailable]);
      // Halted, it no longer holds the slot, and the owner can resume it.
      expect(ledger.resumePreview(runId).ok).toBe(true);
    } finally {
      restore();
    }
  });
});
