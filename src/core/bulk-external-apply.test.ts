import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn() },
}));

import dns from 'node:dns/promises';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, type BulkRunForApply } from './bulk-ledger.js';
import {
  BulkHostBudget, externalClient, externalWriter, mintBulkContract, parseBulkContract, planExternal, type ExternalClient,
} from './bulk-external.js';
import type { CapabilityContract } from '../types/capability-contract.js';
import { runBulkPreview } from './bulk-preview.js';
import { bulkWriterFor, runBulkEffect, type TargetWriter } from './bulk-apply.js';
import { setPinnedTransportForTests, type PinnedTransportInput } from './network-guard.js';
import { createToolContext } from './tool-context.js';
import { TriggerStore } from './trigger-store.js';
import { WorkerLoop } from './worker-loop.js';
import { ApiStore } from './api-store.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import { detectSecretInContent } from '../tools/builtin/http.js';

/**
 * Build plan B, the write half (§1.4, §2.3–§2.4, §4 F5/F7): an approved external run is
 * PATCHed field by field, read back, and taken back against what the host kept — tested
 * against a shop that normalises what it is sent and keeps fields of its own.
 */

const HOST = 'shop.example.com';
const TOKEN = 'not-a-real-token-only-a-fixture';

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

interface Shop {
  items: Map<string, Record<string, unknown>>;
  requests: { method: string; path: string; body: unknown; auth: string | undefined }[];
  /** Per `METHOD path`, answered instead: a status and headers. */
  special: Map<string, { status: number; headers?: Record<string, string> }>;
}

/** A price as the shop stores it: always two decimals. */
const normalise = (v: unknown): unknown => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v).toFixed(2) : v);

function shop(): Shop {
  const s: Shop = { items: new Map(), requests: [], special: new Map() };
  for (let i = 0; i < 4; i++) {
    s.items.set(`/products/${String(i)}`, { id: i, title: `Item ${String(i)}`, price: '12.00', updated_at: 't0' });
  }
  return s;
}

function serve(s: Shop): () => void {
  vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
  let clock = 0;
  return setPinnedTransportForTests(async (input: PinnedTransportInput) => {
    const path = new URL(input.url).pathname;
    const body = input.body === undefined ? undefined : JSON.parse(input.body.toString('utf8')) as unknown;
    const auth = Object.entries(input.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
    s.requests.push({ method: input.method, path, body, auth });
    const sp = s.special.get(`${input.method} ${path}`);
    if (sp) return new Response(null, { status: sp.status, headers: sp.headers ?? {} });
    const item = s.items.get(path);
    if (!item) return new Response(null, { status: 404 });
    if (input.method === 'PATCH') {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) item[k] = normalise(v);
      item['updated_at'] = `t${String(++clock)}`;
      return new Response(null, { status: 204 });
    }
    if (input.method !== 'GET') return new Response(null, { status: 405 });
    return new Response(JSON.stringify(item), { status: 200 });
  });
}

const url = (i: number | string): string => `https://${HOST}/products/${String(i)}`;

function client(opts: { attach?: boolean; contract?: CapabilityContract; rateLimit?: () => string | null } = {}): ExternalClient {
  return externalClient({
    contract: opts.contract ?? mintBulkContract(HOST, [0, 1, 2, 3, 'x'].map(url)),
    hostPolicy: createToolContext({}),
    ackHosts: undefined,
    attach: async (_u, headers) => {
      if (opts.attach === false) return false;
      headers['authorization'] = `Bearer ${TOKEN}`;
      return true;
    },
    rateLimit: opts.rateLimit ?? (() => null),
  });
}

/** The writer as the worker builds it: from the run's OWN stored contract, or none. */
const contractWriter = (run: BulkRunForApply) => bulkWriterFor(run, null, (r) => {
  const contract = parseBulkContract(r.contractJson);
  return contract ? externalWriter(client({ contract }), { sleep: noSleep }) : null;
});

const noSleep = async (): Promise<void> => {};
/** The writer the worker builds, over this test's client. */
const writerFor = (c: ExternalClient) => (run: BulkRunForApply) => bulkWriterFor(run, null, () => externalWriter(c, { sleep: noSleep }));

/** Plan, preview and approve an external run: what an owner does before the first write. */
async function approvedRun(rows: { target: string; after: unknown }[], c: ExternalClient = client()): Promise<string> {
  const targets = planExternal(rows, HOST, detectSecretInContent);
  const out = ledger.recordExternalPlan({
    createdBy: 't', host: HOST, targets, contract: mintBulkContract(HOST, targets.filter((t) => !('invalid' in t)).map((t) => t.key)),
  });
  if (!out.ok) throw new Error(out.reason);
  if (!ledger.resumePreview(out.status.id).ok) throw new Error('not started');
  const preview = await runBulkPreview(out.status.id, { ledger, clientFor: () => c, budget: new BulkHostBudget(10_000, 0), sleep: noSleep });
  if (preview.status !== 'done') throw new Error(`preview ${preview.status}`);
  const approved = ledger.approve(out.status.id, { checksum: ledger.computeChecksum(out.status.id)! });
  if (!approved.ok) throw new Error(approved.reason);
  return out.status.id;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-ext-apply-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
});

afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('applying an external run', () => {
  it('patches exactly the planned fields, reads each target back, and the first tick after approval writes (§6 P5)', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client();
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }, { target: url(1), after: { price: '9.5', title: 'New' } }], c);
      s.requests.length = 0;
      const out = await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor: writerFor(c) });
      // Approval → first tick: no checksum halt, although the run carries a contract.
      expect(out.status).toBe('done');
      expect(ledger.getStatus(runId)).toMatchObject({ phase: 'done', applied: 2, failed: 0, conflicts: 0, haltReason: null });
      // The shop kept its own fields, and normalised the price.
      expect(s.items.get('/products/0')).toEqual({ id: 0, title: 'Item 0', price: '15.00', updated_at: 't1' });
      // Only GET and PATCH, and a PATCH carries the planned fields and nothing else.
      expect(new Set(s.requests.map((r) => r.method))).toEqual(new Set(['GET', 'PATCH']));
      expect(s.requests.filter((r) => r.method === 'PATCH').map((r) => [r.path, r.body])).toEqual([
        ['/products/0', { price: '15' }], ['/products/1', { price: '9.5', title: 'New' }],
      ]);
      // What the host kept is stored — encrypted, like the images.
      const rows = engineDb.getDb().prepare('SELECT after_actual, result FROM bulk_targets WHERE run_id = ? ORDER BY seq').all(runId) as { after_actual: string; result: string }[];
      expect(rows.map((r) => JSON.parse(engineDb.dec(r.after_actual)) as unknown)).toEqual([
        { value: { price: '15.00' }, estimated: false }, { value: { price: '9.50', title: 'New' }, estimated: false },
      ]);
      expect(rows.every((r) => !r.after_actual.includes('15.00') && !r.result.includes('written'))).toBe(true);
      expect(rows.map((r) => engineDb.dec(r.result))).toEqual(['written', 'written']);
    } finally {
      restore();
    }
  });

  it('undoes against what the host kept, not what was sent, and restores exactly the fields', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }, { target: url(1), after: { price: '20' } }]);
      // Both runs write under their own stored contract — the undo's is copied from its source.
      await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor: contractWriter });
      // Someone else changes target 1 in between: that one is a conflict, not overwritten.
      s.items.get('/products/1')!['price'] = '21.00';

      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      const approved = ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! });
      expect(approved.ok).toBe(true);
      const out = await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, writerFor: contractWriter });
      expect(out.status).toBe('done');
      // Target 0: the host normalised '15' to '15.00'; expecting '15' would have been a
      // conflict. It is restored.
      expect(s.items.get('/products/0')!['price']).toBe('12.00');
      expect(s.items.get('/products/1')!['price']).toBe('21.00');
      expect(ledger.getStatus(undo.status.id)).toMatchObject({ applied: 1, conflicts: 1 });
      expect(s.items.get('/products/0')!['title']).toBe('Item 0');
    } finally {
      restore();
    }
  });

  it('counts a target already holding the planned value as applied, and records what it holds', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client();
      const runId = await approvedRun([{ target: url(0), after: { price: '15.00' } }], c);
      s.items.get('/products/0')!['price'] = '15.00';
      s.requests.length = 0;
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor: writerFor(c) })).status).toBe('done');
      expect(s.requests.map((r) => r.method)).toEqual(['GET']);
      const row = engineDb.getDb().prepare('SELECT after_actual FROM bulk_targets WHERE run_id = ?').get(runId) as { after_actual: string };
      expect(JSON.parse(engineDb.dec(row.after_actual))).toEqual({ value: { price: '15.00' }, estimated: false });
    } finally {
      restore();
    }
  });

  it('a failed read-back keeps the write and stores what was sent, marked as estimated', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client();
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }], c);
      let gets = 0;
      const flaky: ExternalClient = {
        get sent() { return c.sent; },
        patch: (u, b, sig) => c.patch(u, b, sig),
        async get(u, sig) { return ++gets === 2 ? { kind: 'failed' } : c.get(u, sig); },
      };
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor: writerFor(flaky) })).status).toBe('done');
      const row = engineDb.getDb().prepare('SELECT after_actual FROM bulk_targets WHERE run_id = ?').get(runId) as { after_actual: string };
      expect(JSON.parse(engineDb.dec(row.after_actual))).toEqual({ value: { price: '15' }, estimated: true });
    } finally {
      restore();
    }
  });

  it('never follows a redirect on a write: the target fails with its own reason, nothing else is sent', async () => {
    const s = shop();
    s.special.set('PATCH /products/0', { status: 302, headers: { location: `https://${HOST}/products/1` } });
    const restore = serve(s);
    try {
      const c = client();
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }, { target: url(2), after: { price: '15' } }], c);
      s.requests.length = 0;
      await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor: writerFor(c) });
      const errors = engineDb.getDb().prepare('SELECT seq, error FROM bulk_targets WHERE run_id = ? ORDER BY seq').all(runId);
      expect(errors).toEqual([{ seq: 0, error: 'redirect' }, { seq: 1, error: null }]);
      expect(s.requests.filter((r) => r.path === '/products/1')).toEqual([]);
      expect(s.items.get('/products/1')!['price']).toBe('12.00');
    } finally {
      restore();
    }
  });

  it('halts at the first target on a refused or missing credential, leaving it unwritten and resumable', async () => {
    const s = shop();
    s.special.set('PATCH /products/0', { status: 401 });
    const restore = serve(s);
    try {
      const c = client();
      const runId = await approvedRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '15' } })), c);
      const out = await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor: writerFor(c) });
      expect(out.status).toBe('halted');
      expect(ledger.getStatus(runId)).toMatchObject({ haltReason: BULK_HALT_REASONS.unauthorized, applied: 0, failed: 0 });
      expect(s.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
      // Released, not failed: the resume takes it again.
      expect(ledger.listPending(runId)).toEqual([0, 1, 2]);
      const claims = engineDb.getDb().prepare('SELECT seq, claimed_at FROM bulk_targets WHERE run_id = ? ORDER BY seq').all(runId);
      expect(claims).toEqual([0, 1, 2].map((seq) => ({ seq, claimed_at: null })));

      s.special.clear();
      const resumed = ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! });
      expect(resumed.ok).toBe(true);
      const noCred = client({ attach: false });
      const before = s.requests.length;
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor: writerFor(noCred) })).status).toBe('halted');
      expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.credential);
      expect(s.requests.length).toBe(before);
    } finally {
      restore();
    }
  });

  it('waits out one 429 on a write, then writes', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client();
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }], c);
      s.special.set('PATCH /products/0', { status: 429, headers: { 'retry-after': '2' } });
      const slept: number[] = [];
      const once: ExternalClient = {
        get sent() { return c.sent; },
        get: (u, sig) => c.get(u, sig),
        async patch(u, b, sig) {
          const r = await c.patch(u, b, sig);
          s.special.delete('PATCH /products/0');
          return r;
        },
      };
      const out = await runBulkEffect(runId, 'bulk_apply', {
        ledger, writerFor: (run) => bulkWriterFor(run, null, () => externalWriter(once, { sleep: async (ms) => { slept.push(ms); } })),
      });
      expect(out.status).toBe('done');
      expect(slept).toEqual([2_000]);
      expect(s.items.get('/products/0')!['price']).toBe('15.00');
    } finally {
      restore();
    }
  });

  it('an undo from an estimated read-back finds the normalised target a conflict, and leaves it', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client();
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }], c);
      let gets = 0;
      const flaky: ExternalClient = {
        get sent() { return c.sent; },
        patch: (u, b, sig) => c.patch(u, b, sig),
        async get(u, sig) { return ++gets === 2 ? { kind: 'failed' } : c.get(u, sig); },
      };
      await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor: writerFor(flaky) });
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! });
      await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, writerFor: writerFor(c) });
      // It expected '15' (what was sent); the shop holds '15.00'. Not overwritten.
      expect(ledger.getStatus(undo.status.id)).toMatchObject({ applied: 0, conflicts: 1 });
      expect(s.items.get('/products/0')!['price']).toBe('15.00');
    } finally {
      restore();
    }
  });

  it('waits a second on a spent profile rate limit, then writes', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }]);
      // The first check (the write's read) finds the limit spent; the one after the wait does not.
      let checks = 0;
      const c = client({ rateLimit: () => (++checks === 1 ? 'spent' : null) });
      const slept: number[] = [];
      const out = await runBulkEffect(runId, 'bulk_apply', {
        ledger, writerFor: (run) => bulkWriterFor(run, null, () => externalWriter(c, { sleep: async (ms) => { slept.push(ms); } })),
      });
      expect(out.status).toBe('done');
      expect(slept).toEqual([1_000]);
      expect(s.items.get('/products/0')!['price']).toBe('15.00');
    } finally {
      restore();
    }
  });

  it('halts a write its contract does not grant, before anything is sent', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }]);
      // The same host and paths, reading only: the PATCH is not granted.
      const readOnly = client({ contract: { ...mintBulkContract(HOST, [url(0)]), httpMethods: ['GET'] } });
      s.requests.length = 0;
      const out = await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor: writerFor(readOnly) });
      expect(out.status).toBe('halted');
      expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.contract);
      expect(s.requests.map((r) => r.method)).toEqual(['GET']);
    } finally {
      restore();
    }
  });

  it('a local target found already written records no read-back image', async () => {
    const run = ledger.recordDryRun({
      createdBy: 't', targetSystem: 'workspace', scope: 'w',
      targets: [{ key: '/k', before: { absent: false, value: 'old' }, after: 'new' }],
    });
    ledger.approve(run.id, { checksum: ledger.computeChecksum(run.id)! });
    const already: TargetWriter = { async read() { return { absent: false, value: 'new' }; }, async write() { return 'written'; } };
    expect((await runBulkEffect(run.id, 'bulk_apply', { ledger, writerFor: () => already })).status).toBe('done');
    expect(engineDb.getDb().prepare('SELECT after_actual FROM bulk_targets WHERE run_id = ?').get(run.id)).toEqual({ after_actual: null });
  });

  it('never deletes an external target, and halts a run whose writer is missing', async () => {
    const w = externalWriter(client(), { sleep: noSleep });
    await expect(w.write(url(0), { absent: true })).rejects.toThrow(/only ever patched/);
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }]);
      const out = await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor: (run) => bulkWriterFor(run, null, null) });
      expect(out.status).toBe('refused');
      expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.unavailable);
    } finally {
      restore();
    }
  });

  it('writes through a real worker tick off the approval\'s trigger, with the stored credential', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }]);
      const apiStore = new ApiStore();
      apiStore.register({
        id: 'shop', name: 'Shop', base_url: `https://${HOST}/`, description: 'Shop',
        auth: { type: 'bearer', vault_keys: ['SHOP_TOKEN'] },
        custom_endpoint_ack: { accepted: true, hosts: [HOST], accepted_at: '2026-09-30T00:00:00.000Z' },
      });
      const triggers = new TriggerStore(engineDb);
      expect(triggers.getDue().map((t) => [t.effect, t.bulk_run_id])).toEqual([['bulk_apply', runId]]);
      const recordTaskRun = vi.fn((id: string, result: string, status: 'success' | 'failed' | 'timeout') => {
        triggers.updateFields(id, { status: status === 'success' ? 'completed' : 'failed' });
        triggers.updateRunResult(id, { lastRunAt: new Date().toISOString(), lastRunResult: result, lastRunStatus: status, nextRunAt: null });
      });
      const engine = {
        getTaskManager: () => ({
          getDueTriggers: () => triggers.getDue(), getExpiredWaitingTriggers: () => [], endWait: () => false,
          getTrigger: (id: string) => triggers.getById(id), recordTaskRun,
        }),
        getBulkLedger: () => ledger,
        getDataStore: () => null,
        getApiStore: () => apiStore,
        getSecretStore: () => ({ resolve: (k: string) => (k === 'SHOP_TOKEN' ? TOKEN : null) }),
        getToolContext: () => createToolContext({}),
        getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
        getUserConfig: () => ({}),
      } as unknown as Engine;
      const loop = new WorkerLoop(engine, { hasChannels: () => false, notify: vi.fn() } as unknown as NotificationRouter, 60_000);
      s.requests.length = 0;
      await loop.tick();
      await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 10_000 });
      expect(recordTaskRun.mock.calls[0]![2]).toBe('success');
      expect(s.items.get('/products/0')!['price']).toBe('15.00');
      expect(ledger.getStatus(runId)).toMatchObject({ phase: 'done', applied: 1 });
      expect(s.requests.map((r) => [r.method, r.auth])).toEqual([
        ['GET', `Bearer ${TOKEN}`], ['PATCH', `Bearer ${TOKEN}`], ['GET', `Bearer ${TOKEN}`],
      ]);
    } finally {
      restore();
    }
  });
});
