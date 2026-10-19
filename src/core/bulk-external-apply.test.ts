import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OWNER_PRINCIPAL } from './request-principal.js';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn() },
}));

// The writes here go to a fixture shop whose `/products/<id>` nobody has measured. These tests
// are about the write mechanics, under the probe a MEASURED form has (one confirmed probe per
// host, verb and kind); `bulk-write-forms.test.ts` covers the table and the unmeasured path.
// The describe 'an unmeasured write form' turns the stand-in off and gets the real table.
const formFixture = vi.hoisted(() => ({ measured: true }));
vi.mock('./bulk-write-forms.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./bulk-write-forms.js')>();
  const stand = (host: string, method: string | null): boolean => formFixture.measured && host === 'shop.example.com' && method !== null;
  return {
    ...real,
    isMeasuredWriteForm: (host: string, path: string, method: string) => stand(host, method) || real.isMeasuredWriteForm(host, path, method),
    writeFormOf: (host: string, paths: readonly string[], method: string | null) =>
      stand(host, method) && paths.length > 0 ? 'measured' : real.writeFormOf(host, paths, method),
  };
});

import dns from 'node:dns/promises';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, resourceKindOf, type BulkRunForApply } from './bulk-ledger.js';
import type { AttachedConnection } from './bulk-connection.js';
import {
  BulkHostBudget, externalClient, externalWriter, mintBulkContract, parseBulkContract, planExternal, writeMethodOf,
  type BulkWriteMethod, type ExternalClient,
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
import { bulkStatusTool } from '../tools/builtin/bulk.js';
import type { IAgent } from '../types/index.js';
import { bindingsAsMigrated } from '../../tests/helpers/vault-bindings.js';

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
  /** A PUT that replaces the resource with the body — the failure the probe is for. */
  replacingPut?: boolean;
  /** Paths whose write is applied and then answered 502: it landed, the answer says it failed. */
  landThenFail?: Set<string>;
  /** `METHOD path` whose request reaches the shop and whose connection then breaks. */
  dropAfter?: Set<string>;
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
    if (s.dropAfter?.has(`${input.method} ${path}`)) throw new Error('connection reset');
    const sp = s.special.get(`${input.method} ${path}`);
    if (sp) return new Response(null, { status: sp.status, headers: sp.headers ?? {} });
    const item = s.items.get(path);
    if (!item) return new Response(null, { status: 404 });
    if (input.method === 'PUT' && s.replacingPut) {
      for (const k of Object.keys(item)) if (k !== 'id') delete item[k];
    }
    if (input.method === 'PATCH' || input.method === 'PUT' || input.method === 'POST') {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) item[k] = normalise(v);
      item['updated_at'] = `t${String(++clock)}`;
      if (s.landThenFail?.has(path)) return new Response(null, { status: 502 });
      return new Response(null, { status: 204 });
    }
    if (input.method !== 'GET') return new Response(null, { status: 405 });
    return new Response(JSON.stringify(item), { status: 200 });
  });
}

const url = (i: number | string): string => `https://${HOST}/products/${String(i)}`;

function client(opts: { attach?: boolean; methods?: string[]; contract?: CapabilityContract; rateLimit?: () => string | null; scan?: (text: string) => string | null; connectedAccount?: (url: string) => boolean; connection?: (url: string, method: string) => AttachedConnection | null } = {}): ExternalClient {
  return externalClient({
    contract: opts.contract ?? mintBulkContract(HOST, [0, 1, 2, 3, 'x'].map(url)),
    hostPolicy: createToolContext({}),
    ackHosts: undefined,
    attach: async (u, headers, method) => {
      opts.methods?.push(method);
      if (opts.attach === false) return null;
      headers['authorization'] = `Bearer ${TOKEN}`;
      return opts.connection ? opts.connection(u, method) : { id: 'fixture', grantId: 'grant-1' };
    },
    rateLimit: opts.rateLimit ?? (() => null),
    scan: opts.scan ?? detectSecretInContent,
    connectedAccount: opts.connectedAccount ?? (() => false),
    recordRead: null,
  });
}

/** The writer as the worker builds it: from the run's OWN stored contract, or none. */
const contractWriter = (run: BulkRunForApply) => bulkWriterFor(run, null, (r) => {
  const contract = parseBulkContract(r.contractJson);
  const method = contract ? writeMethodOf(contract) : null;
  return contract && method ? externalWriter(client({ contract }), { method, sleep: noSleep }) : null;
});

const noSleep = async (): Promise<void> => {};
/** The writer the worker builds, over this test's client. */
const writerFor = (c: ExternalClient) => (run: BulkRunForApply) => bulkWriterFor(run, null, () => externalWriter(c, { sleep: noSleep }));

/** Plan, preview and approve an external run: what an owner does before the first write. */
/** A probe the owner confirmed for the host and verb — the fixture for tests that are not
 *  about the probe itself. */
function seedProbe(method: BulkWriteMethod = 'PATCH', kind = '/products/', probePath = `${kind}900`): void {
  // A probe vouches only through the one target its run wrote (`probeWroteMeasuredForm`), so
  // the fixture carries that run and that target too.
  const runId = `fixture-probe-${method}-${kind}-${probePath}`;
  const db = engineDb.getDb();
  db.prepare(`INSERT OR IGNORE INTO bulk_runs (id, rule_hash, target_system, undo, phase, targets_total, targets_applied)
    VALUES (?, 'fixture', ?, 'restorable', 'done', 1, 1)`).run(runId, `http:${HOST}`);
  db.prepare(`INSERT OR IGNORE INTO bulk_targets (run_id, seq, target_key, change, applied_at, result)
    VALUES (?, 0, ?, 'update', '2026-09-30T00:00:00.000Z', ?)`).run(runId, engineDb.enc(`https://${HOST}${probePath}`), engineDb.enc('written'));
  db.prepare('INSERT OR REPLACE INTO bulk_host_probes (host, method, kind, run_id, confirmed_at) VALUES (?, ?, ?, ?, ?)')
    .run(HOST, method, kind, runId, '2026-09-30T00:00:00.000Z');
}

async function previewedRun(
  rows: { target: string; after: unknown }[], c: ExternalClient = client(), method: BulkWriteMethod = 'PATCH',
  planScan: (text: string) => string | null = detectSecretInContent,
): Promise<string> {
  const targets = planExternal(rows, HOST, planScan);
  const out = ledger.recordExternalPlan({
    createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, targets, contract: mintBulkContract(HOST, targets.filter((t) => !('invalid' in t)).map((t) => t.key), method),
  });
  if (!out.ok) throw new Error(out.reason);
  if (!ledger.resumePreview(out.status.id).ok) throw new Error('not started');
  const preview = await runBulkPreview(out.status.id, { ledger, clientFor: () => c, budget: new BulkHostBudget(10_000, 0), sleep: noSleep });
  if (preview.status !== 'done') throw new Error(`preview ${preview.status}`);
  return out.status.id;
}

/** Plan, preview and approve an external run with a confirmed probe for its verb. */
async function approvedRun(
  rows: { target: string; after: unknown }[], c: ExternalClient = client(), method: BulkWriteMethod = 'PATCH',
  planScan: (text: string) => string | null = detectSecretInContent,
): Promise<string> {
  const runId = await previewedRun(rows, c, method, planScan);
  seedProbe(method);
  const approved = ledger.approve(runId, { checksum: ledger.computeChecksum(runId)! });
  if (!approved.ok) throw new Error(approved.reason);
  return runId;
}

// Built at run time so no pattern scan reads a key in this file.
const LOOKS_LIKE_A_KEY = ['sk', 'ant', 'x'.repeat(24)].join('-');

/** The error recorded on each failed target of a run, in target order. */
function targetErrors(runId: string): string[] {
  return (engineDb.getDb().prepare('SELECT error FROM bulk_targets WHERE run_id = ? AND error IS NOT NULL ORDER BY seq').all(runId) as { error: string }[])
    .map((r) => r.error);
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
      const out = await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
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
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: contractWriter });
      // Someone else changes target 1 in between: that one is a conflict, not overwritten.
      s.items.get('/products/1')!['price'] = '21.00';

      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      const approved = ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! });
      expect(approved.ok).toBe(true);
      const out = await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: contractWriter });
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

  it('a write that landed although its answer said it failed is part of the undo, and is taken back', async () => {
    const s = shop();
    s.landThenFail = new Set(['/products/1']);
    const restore = serve(s);
    try {
      // Values the shop keeps as sent, so what the host holds is exactly what was planned.
      const runId = await approvedRun([{ target: url(0), after: { price: '15.00' } }, { target: url(1), after: { price: '20.00' } }]);
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: contractWriter });
      expect(ledger.getStatus(runId)).toMatchObject({ applied: 1, failed: 1 });
      expect(s.items.get('/products/1')!['price']).toBe('20.00');

      s.landThenFail.clear();
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      expect(undo.status.total).toBe(2);
      expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! }).ok).toBe(true);
      expect((await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: contractWriter })).status).toBe('done');
      expect(s.items.get('/products/0')!['price']).toBe('12.00');
      expect(s.items.get('/products/1')!['price']).toBe('12.00');
      expect(ledger.getStatus(runId)!.phase).toBe('undone');
    } finally {
      restore();
    }
  });

  it('a failed write that landed stays in the undo after a resume turned its retry into a conflict', async () => {
    const s = shop();
    s.landThenFail = new Set(['/products/1']);
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15.00' } }, { target: url(1), after: { price: '20' } }]);
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: contractWriter });
      expect(s.items.get('/products/1')!['price']).toBe('20.00');
      s.landThenFail.clear();
      // The resume clears the failure and retries: the target no longer holds its before-image,
      // so the retry records a conflict — the failed write's own mark is gone.
      expect(ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! }).ok).toBe(true);
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: contractWriter });
      expect(ledger.getStatus(runId)).toMatchObject({ applied: 1, conflicts: 1 });

      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      // Both targets may hold the run's write, so both are in the undo.
      expect(undo.status.total).toBe(2);
      expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! }).ok).toBe(true);
      await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: contractWriter });
      expect(ledger.getStatus(runId)!.phase).not.toBe('undone');
    } finally {
      restore();
    }
  });

  it('a failed write that landed and was normalised by the host is a conflict, and the run is not reported undone', async () => {
    const s = shop();
    s.landThenFail = new Set(['/products/1']);
    const restore = serve(s);
    try {
      // The shop stores '20' as '20.00': the undo expects what was planned, finds what was kept.
      const runId = await approvedRun([{ target: url(0), after: { price: '15.00' } }, { target: url(1), after: { price: '20' } }]);
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: contractWriter });
      expect(s.items.get('/products/1')!['price']).toBe('20.00');
      s.landThenFail.clear();
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! }).ok).toBe(true);
      expect((await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: contractWriter })).status).toBe('done');
      expect(ledger.getStatus(undo.status.id)).toMatchObject({ applied: 1, conflicts: 1 });
      expect(s.items.get('/products/1')!['price']).toBe('20.00');
      // What may still hold the run's write is standing: the run is not undone.
      expect(ledger.getStatus(runId)!.phase).not.toBe('undone');
      expect(ledger.getStatus(runId)!.phase).toMatch(/^(done|writing)$/);
    } finally {
      restore();
    }
  });

  it('a failed write that never landed is found unchanged by the undo and left alone', async () => {
    const s = shop();
    s.special.set('PATCH /products/1', { status: 502 });
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15.00' } }, { target: url(1), after: { price: '20.00' } }]);
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: contractWriter });
      s.special.clear();
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! }).ok).toBe(true);
      expect(undo.status.total).toBe(2);
      s.requests.length = 0;
      expect((await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: contractWriter })).status).toBe('done');
      // Target 1 already holds its before-state: read, not written.
      expect(s.requests.filter((r) => r.method === 'GET').map((r) => r.path)).toContain('/products/1');
      expect(s.requests.filter((r) => r.method === 'PATCH').map((r) => r.path)).toEqual(['/products/0']);
      expect(ledger.getStatus(runId)!.phase).toBe('undone');
      expect(s.items.get('/products/1')!['price']).toBe('12.00');
    } finally {
      restore();
    }
  });


  it('a plan refuses a target whose address looks like a secret: it is never requested', () => {
    const [target] = planExternal([{ target: url(LOOKS_LIKE_A_KEY), after: { price: '1' } }], HOST, detectSecretInContent);
    expect(target).toMatchObject({ invalid: 'secret_in_target' });
  });

  it('sends nothing whose address or body looks like it carries a secret', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const keyed = url(LOOKS_LIKE_A_KEY);
      const c = client({ contract: mintBulkContract(HOST, [url(0), keyed]) });
      expect(await c.write(url(0), 'PATCH', { note: `token ${LOOKS_LIKE_A_KEY}` })).toEqual({ kind: 'secret' });
      expect(await c.get(keyed)).toEqual({ kind: 'secret' });
      // The same calls without the key go out: the refusal is the scan, not something else.
      expect((await c.write(url(0), 'PATCH', { note: 'plain' })).kind).not.toBe('secret');
      expect((await c.get(url(0))).kind).not.toBe('secret');
      expect(s.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['PATCH /products/0', 'GET /products/0']);
    } finally {
      restore();
    }
  });

  it('a run over more paths than a saved workflow\'s grant may name still reads and writes under its own contract', async () => {
    // Both are `reviewed`, and both go through `contractGrants`. The form a workflow's grant
    // must have (`reviewedContractShapeError`, at most MAX_REVIEWED_PATHS paths) is checked
    // only where a workflow is saved; checking it at dispatch would halt every bulk run
    // larger than that.
    const s = shop();
    for (let i = 4; i < 30; i++) s.items.set(`/products/${String(i)}`, { id: i, title: `Item ${String(i)}`, price: '12.00', updated_at: 't0' });
    const restore = serve(s);
    try {
      const many = Array.from({ length: 30 }, (_, i) => url(i));
      const c = client({ contract: mintBulkContract(HOST, many) });
      expect((await c.get(url(29))).kind).toBe('ok');
      expect((await c.write(url(29), 'PATCH', { price: '13.00' })).kind).toBe('ok');
    } finally {
      restore();
    }
  });

  it('a small run halted by one such target writes the rest on resume, and leaves that one failed', async () => {
    const s = shop();
    s.items.set(`/products/${LOOKS_LIKE_A_KEY}`, { id: 9, title: 'Keyed', price: '12.00' });
    const restore = serve(s);
    try {
      // Planned without the scan so the keyed target gets as far as the write.
      const keyed = url(LOOKS_LIKE_A_KEY);
      const c = client({ contract: mintBulkContract(HOST, [keyed, url(1), url(2)]) });
      const runId = await approvedRun(
        [{ target: keyed, after: { price: '15.00' } }, { target: url(1), after: { price: '15.00' } }, { target: url(2), after: { price: '15.00' } }],
        client({ scan: () => null, contract: mintBulkContract(HOST, [keyed, url(1), url(2)]) }), 'PATCH', () => null,
      );
      const writer = (run: BulkRunForApply) => bulkWriterFor(run, null, () => externalWriter(c, { sleep: noSleep }));
      s.requests.length = 0;
      // One failure in three is over the failure-rate rule: the run halts at once.
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writer })).status).toBe('halted');
      expect(ledger.getStatus(runId)!.failed).toBe(1);
      expect(ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! }).ok).toBe(true);
      // The resume sets the halt's count back, but that target stays failed — and counted.
      expect(ledger.getStatus(runId)!.failed).toBe(1);
      const done = await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writer });
      expect(done.status).toBe('done');
      expect([s.items.get('/products/1')!['price'], s.items.get('/products/2')!['price']]).toEqual(['15.00', '15.00']);
      expect(targetErrors(runId)).toEqual(['secret']);
      expect(ledger.getStatus(runId)).toMatchObject({ applied: 2, failed: 1 });
      expect(done.summary).toContain('Applied 2, failed 1,');
      const agent = { toolContext: { bulkLedger: ledger } } as unknown as IAgent;
      expect(await bulkStatusTool.handler({ run_id: runId }, agent)).toContain('Applied 2, failed 1, conflicts 0, undone 0.');
      expect(s.requests.filter((r) => r.path.includes(LOOKS_LIKE_A_KEY))).toEqual([]);
    } finally {
      restore();
    }
  });

  it('a plan refuses a target whose address decodes to something that looks like a secret', () => {
    const [target] = planExternal([{ target: url(LOOKS_LIKE_A_KEY.replace(/-/g, '%2D')), after: { price: '1' } }], HOST, detectSecretInContent);
    expect(target).toMatchObject({ invalid: 'secret_in_target' });
  });

  it('scans the address in the form the host decodes it to', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const encoded = url(LOOKS_LIKE_A_KEY.replace(/-/g, '%2D'));
      const c = client({ contract: mintBulkContract(HOST, [encoded, url(0)]) });
      expect(await c.get(encoded)).toEqual({ kind: 'secret' });
      expect((await c.get(url(0))).kind).not.toBe('secret');
      expect(s.requests.map((r) => r.path)).toEqual(['/products/0']);
    } finally {
      restore();
    }
  });

  it('the credential the engine attaches is not what is scanned: a stored token that looks like a key still goes out', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = externalClient({
        contract: mintBulkContract(HOST, [url(0)]),
        hostPolicy: createToolContext({}),
        ackHosts: undefined,
        attach: async (_u, headers) => { headers['authorization'] = `Bearer ${LOOKS_LIKE_A_KEY}`; return { id: 'fixture', grantId: 'grant-1' }; },
        rateLimit: () => null,
        scan: detectSecretInContent,
        connectedAccount: () => false,
        recordRead: null,
      });
      expect((await c.write(url(0), 'PATCH', { note: 'plain' })).kind).not.toBe('secret');
      expect(s.requests.map((r) => [r.method, r.auth])).toEqual([['PATCH', `Bearer ${LOOKS_LIKE_A_KEY}`]]);
    } finally {
      restore();
    }
  });

  // The contract granted a PATCH; a slot that turns it into a DELETE (or names another write,
  // re-targets it, or changes how its body is read) after that check must not go out. The
  // denylist keeps such a slot from being attached; this fake attach goes past it, to test the
  // comparison behind it. The body holds a form override in a JSON string: as JSON it names
  // nothing, read as the form the Content-Type slot declares it names a DELETE.
  it.each([
    ['x-http-method-override', 'DELETE'],
    ['x-method-override', 'PUT'],
    ['x-forwarded-host', 'internal.example'],
    ['content-type', 'application/x-www-form-urlencoded'],
  ])('SECURITY: an attach that sets %s halts the write and sends nothing', async (name, value) => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = externalClient({
        contract: mintBulkContract(HOST, [url(0)]),
        hostPolicy: createToolContext({}),
        ackHosts: undefined,
        attach: async (_u, headers) => { headers['authorization'] = `Bearer ${TOKEN}`; headers[name] = value; return { id: 'fixture', grantId: 'grant-1' }; },
        connectedAccount: () => false,
        recordRead: null,
        rateLimit: () => null,
        scan: detectSecretInContent,
      });
      expect((await c.write(url(0), 'PATCH', { note: 'a&_method=DELETE&b' })).kind).toBe('no_credential');
      expect(s.requests).toEqual([]);
    } finally {
      restore();
    }
  });

  it('SECURITY: a read whose attach sets a method override sends nothing either', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = externalClient({
        contract: mintBulkContract(HOST, [url(0)]),
        hostPolicy: createToolContext({}),
        ackHosts: undefined,
        attach: async (_u, headers) => { headers['x-http-method-override'] = 'DELETE'; return { id: 'fixture', grantId: 'grant-1' }; },
        connectedAccount: () => false,
        recordRead: null,
        rateLimit: () => null,
        scan: detectSecretInContent,
      });
      expect((await c.get(url(0))).kind).toBe('no_credential');
      expect(s.requests).toEqual([]);
    } finally {
      restore();
    }
  });

  it('an undo that would write back a value that looks like a secret fails that target, and sends nothing for it', async () => {
    const s = shop();
    s.items.get('/products/0')!['note'] = `old ${LOOKS_LIKE_A_KEY}`;
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { note: 'clean' } }]);
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: contractWriter });
      expect(s.items.get('/products/0')!['note']).toBe('clean');
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! }).ok).toBe(true);
      s.requests.length = 0;
      await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: contractWriter });
      // The target fails on its own; the run's failure rules decide what follows.
      expect(ledger.getStatus(undo.status.id)!.failed).toBe(1);
      expect(targetErrors(undo.status.id)).toEqual(['secret']);
      expect(s.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      expect(s.items.get('/products/0')!['note']).toBe('clean');
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
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');
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
        track: () => c.track(),
        write: (u, m, b, sig, on) => c.write(u, m, b, sig, on),
        async get(u, sig) { return ++gets === 2 ? { kind: 'failed' } : c.get(u, sig); },
      };
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(flaky) })).status).toBe('done');
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
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
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
      const out = await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
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
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(noCred) })).status).toBe('halted');
      expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.credential);
      expect(s.requests.length).toBe(before);
    } finally {
      restore();
    }
  });

  // The attach refuses a write through a profile that skips its provider and lets a read go
  // (`attachEngineManagedAuth`): it can only tell them apart by the method it is handed.
  it('hands the credential attach the method each request is sent with', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const methods: string[] = [];
      const c = client({ methods });
      await c.get(url(0));
      await c.write(url(0), 'PATCH', { price: '15' });
      // A body that names another method is handed as the method a server reads it as, the one
      // the contract was checked against.
      expect(await c.write(url(1), 'POST', { _method: 'PATCH', price: '16' })).not.toEqual({ kind: 'not_granted' });
      expect(methods).toEqual(['GET', 'PATCH', 'PATCH']);
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
        track: () => c.track(),
        get: (u, sig) => c.get(u, sig),
        async write(u, m, b, sig, on) {
          const r = await c.write(u, m, b, sig, on);
          s.special.delete('PATCH /products/0');
          return r;
        },
      };
      const out = await runBulkEffect(runId, 'bulk_apply', {
        ledger, trailFor: () => null, writerFor: (run) => bulkWriterFor(run, null, () => externalWriter(once, { sleep: async (ms) => { slept.push(ms); } })),
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
        track: () => c.track(),
        write: (u, m, b, sig, on) => c.write(u, m, b, sig, on),
        async get(u, sig) { return ++gets === 2 ? { kind: 'failed' } : c.get(u, sig); },
      };
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(flaky) });
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! });
      await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: writerFor(c) });
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
        ledger, trailFor: () => null, writerFor: (run) => bulkWriterFor(run, null, () => externalWriter(c, { sleep: async (ms) => { slept.push(ms); } })),
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
      const out = await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(readOnly) });
      expect(out.status).toBe('halted');
      expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.contract);
      expect(s.requests.map((r) => r.method)).toEqual(['GET']);
    } finally {
      restore();
    }
  });

  it('a local target found already written records no read-back image', async () => {
    const run = ledger.recordDryRun({
      createdBy: 't', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'w',
      targets: [{ key: '/k', before: { absent: false, value: 'old' }, after: 'new' }],
    });
    ledger.approve(run.id, { checksum: ledger.computeChecksum(run.id)! });
    const already: TargetWriter = { async read() { return { absent: false, value: 'new' }; }, async write() { return 'written'; } };
    expect((await runBulkEffect(run.id, 'bulk_apply', { ledger, trailFor: () => null, writerFor: () => already })).status).toBe('done');
    expect(engineDb.getDb().prepare('SELECT after_actual FROM bulk_targets WHERE run_id = ?').get(run.id)).toEqual({ after_actual: null });
  });

  it('never deletes an external target, and halts a run whose writer is missing', async () => {
    const w = externalWriter(client(), { sleep: noSleep });
    await expect(w.write(url(0), { absent: true })).rejects.toThrow(/never removed/);
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }]);
      const out = await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: (run) => bulkWriterFor(run, null, null) });
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
      // PUT, not the default: the worker takes the verb from the run's contract.
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }], client(), 'PUT');
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
          claimLease: triggers.claimLease.bind(triggers), renewLease: triggers.renewLease.bind(triggers), releaseLease: triggers.releaseLease.bind(triggers),
          getTrigger: (id: string) => triggers.getById(id), recordTaskRun,
        }),
        getBulkLedger: () => ledger,
        getDataStore: () => null,
        getApiStore: () => apiStore,
        getSecretStore: () => ({ resolve: (k: string) => (k === 'SHOP_TOKEN' ? TOKEN : null) }),
        getToolContext: () => ({ ...createToolContext({}), vaultNameBindings: bindingsAsMigrated(apiStore) }),
        getAuditLog: () => null,
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
        ['GET', `Bearer ${TOKEN}`], ['PUT', `Bearer ${TOKEN}`], ['GET', `Bearer ${TOKEN}`],
      ]);
    } finally {
      restore();
    }
  });

  // PRD customer-granted-operator-access §3.9: the reads an apply makes for a run a delegated
  // session planned — the target before it is written, and after — are rows under the planner,
  // each before it is sent. (The write itself is a row of its own concern.)
  it('records the reads of an apply a delegated session planned, before each is sent', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }], client(), 'PUT');
      engineDb.getDb().prepare('UPDATE bulk_runs SET principal = ?, mandate_id = ? WHERE id = ?').run('mandate:helper@example.invalid', 'grant-1', runId);
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
      const recs: Array<{ principal: unknown; action: string; target?: string; phase?: string; correlationId?: string; runId?: string }> = [];
      const sentAtRecord: number[] = [];
      const engine = {
        getTaskManager: () => ({
          getDueTriggers: () => triggers.getDue(), getExpiredWaitingTriggers: () => [], endWait: () => false,
          claimLease: triggers.claimLease.bind(triggers), renewLease: triggers.renewLease.bind(triggers), releaseLease: triggers.releaseLease.bind(triggers),
          getTrigger: (id: string) => triggers.getById(id), recordTaskRun,
        }),
        getBulkLedger: () => ledger,
        getDataStore: () => null,
        getApiStore: () => apiStore,
        getSecretStore: () => ({ resolve: (k: string) => (k === 'SHOP_TOKEN' ? TOKEN : null) }),
        getToolContext: () => ({ ...createToolContext({}), vaultNameBindings: bindingsAsMigrated(apiStore) }),
        getAuditLog: () => ({ record: (e: (typeof recs)[number]) => { sentAtRecord.push(s.requests.length); recs.push(e); } }),
        getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
        getUserConfig: () => ({}),
      } as unknown as Engine;
      const loop = new WorkerLoop(engine, { hasChannels: () => false, notify: vi.fn() } as unknown as NotificationRouter, 60_000);
      s.requests.length = 0;
      await loop.tick();
      await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 10_000 });
      expect(s.requests.map((r) => r.method)).toEqual(['GET', 'PUT', 'GET']);
      const planner = { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'grant-1' };
      // The run's own pair around them: planned by the session, approved by the owner, and how
      // many targets were written (PRD customer-granted-operator-access §3.9, one pair per call).
      expect(recs.map((r) => [r.principal, r.action, r.target, r.phase, r.runId])).toEqual([
        [planner, 'bulk:apply', `host=${HOST} approved_by=owner`, 'attempt', runId],
        [planner, 'bulk:read', `GET ${HOST}/products/0`, 'read', runId],
        [planner, 'bulk:read', `GET ${HOST}/products/0`, 'read', runId],
        [planner, 'bulk:apply', `host=${HOST} approved_by=owner outcome=done written=1 failed=0`, 'done', runId],
      ]);
      expect(sentAtRecord, 'the run row before anything is sent, each read row before its read, the last after the run').toEqual([0, 0, 2, 3]);
      expect(new Set(recs.filter((r) => r.action === 'bulk:apply').map((r) => r.correlationId)).size, 'the pair shares one correlation id').toBe(1);
      expect(JSON.stringify(recs), 'nothing written reaches a row').not.toMatch(/15\.00|"15"|price/);
    } finally {
      restore();
    }
  });

  it('the worker\'s own client reads the store: an unmeasured write to a connected account is not sent', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      // PUT, not the default: the worker takes the verb from the run's contract.
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }], client(), 'PUT');
      const apiStore = new ApiStore();
      apiStore.register({
        id: 'shop', name: 'Shop', base_url: `https://${HOST}/`, description: 'Shop',
        // A bearer credential the worker can attach, on a profile that names a built-in provider:
        // the check reads only `preset_id`, and the reads before the write still go out.
        auth: { type: 'bearer', vault_keys: ['SHOP_TOKEN'], oauth: { preset_id: 'example-shop' } } as never,
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
          claimLease: triggers.claimLease.bind(triggers), renewLease: triggers.renewLease.bind(triggers), releaseLease: triggers.releaseLease.bind(triggers),
          getTrigger: (id: string) => triggers.getById(id), recordTaskRun,
        }),
        getBulkLedger: () => ledger,
        getDataStore: () => null,
        getApiStore: () => apiStore,
        getSecretStore: () => ({ resolve: (k: string) => (k === 'SHOP_TOKEN' ? TOKEN : null) }),
        getToolContext: () => ({ ...createToolContext({}), vaultNameBindings: bindingsAsMigrated(apiStore) }),
        getAuditLog: () => null,
        getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
        getUserConfig: () => ({}),
      } as unknown as Engine;
      const loop = new WorkerLoop(engine, { hasChannels: () => false, notify: vi.fn() } as unknown as NotificationRouter, 60_000);
      // The run was approved under this file's stand-in, which counts every form on HOST as
      // measured; the worker now reads the real table, where `/products/0` is not a measured form.
      formFixture.measured = false;
      s.requests.length = 0;
      await loop.tick();
      await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 10_000 });
      expect(s.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      expect(s.items.get('/products/0')!['price']).not.toBe('15.00');
    } finally {
      formFixture.measured = true;
      restore();
    }
  });

  it('the worker\'s own client scans what it sends: a target whose address looks like a secret fails, nothing is sent', async () => {
    const s = shop();
    const key = LOOKS_LIKE_A_KEY;
    s.items.set(`/products/${key}`, { id: 9, title: 'Keyed', price: '12.00' });
    const restore = serve(s);
    try {
      // Plan and preview run without the scan, so the run reaches approval; what the worker
      // builds for the write is the client under test.
      const runId = await approvedRun(
        [{ target: url(key), after: { price: '15' } }],
        client({ scan: () => null, contract: mintBulkContract(HOST, [url(key)]) }), 'PATCH', () => null,
      );
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
          getDueTriggers: () => triggers.getDue(), getExpiredWaitingTriggers: () => [], endWait: () => false,
          claimLease: triggers.claimLease.bind(triggers), renewLease: triggers.renewLease.bind(triggers), releaseLease: triggers.releaseLease.bind(triggers),
          getTrigger: (id: string) => triggers.getById(id), recordTaskRun,
        }),
        getBulkLedger: () => ledger,
        getDataStore: () => null,
        getApiStore: () => apiStore,
        getSecretStore: () => ({ resolve: (k: string) => (k === 'SHOP_TOKEN' ? TOKEN : null) }),
        getToolContext: () => ({ ...createToolContext({}), vaultNameBindings: bindingsAsMigrated(apiStore) }),
        getAuditLog: () => null,
        getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
        getUserConfig: () => ({}),
      } as unknown as Engine;
      const loop = new WorkerLoop(engine, { hasChannels: () => false, notify: vi.fn() } as unknown as NotificationRouter, 60_000);
      s.requests.length = 0;
      await loop.tick();
      await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 10_000 });
      expect(targetErrors(runId)).toEqual(['secret']);
      expect(s.requests).toEqual([]);
      expect(s.items.get(`/products/${key}`)!['price']).toBe('12.00');
    } finally {
      restore();
    }
  });
});

describe('the write verb and the one-target probe', () => {
  it('a run approved for one target sends its verb to one target even when that write fails, and may retry it', async () => {
    const s = shop();
    // 25 targets, so one failure stays under the failure-rate halt: only the approval's bound
    // can stop the run after it.
    for (let i = 4; i < 25; i++) s.items.set(`/products/${String(i)}`, { id: i, title: `Item ${String(i)}`, price: '12.00', updated_at: 't0' });
    s.special.set('PATCH /products/0', { status: 502 });
    const restore = serve(s);
    try {
      const keys = Array.from({ length: 25 }, (_, i) => url(i));
      const c = client({ contract: mintBulkContract(HOST, keys) });
      const runId = await previewedRun(keys.map((target) => ({ target, after: { price: '15' } })), c);
      const checksum = ledger.computeChecksum(runId)!;
      expect(ledger.approve(runId, { checksum, maxTargets: 1 }).ok).toBe(true);

      const first = await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      expect(first.status).toBe('halted');
      // At its bound, but the one write failed: not the planned halt.
      expect(first.planned).toBeUndefined();
      // The failed write may have reached its target: the approval for one is spent.
      expect(s.requests.filter((r) => r.method === 'PATCH').map((r) => r.path)).toEqual(['/products/0']);
      expect(ledger.getStatus(runId)).toMatchObject({ applied: 0, failed: 1, haltReason: BULK_HALT_REASONS.maxTargets });

      // A resume retries the same target — no new one receives the verb.
      s.special.delete('PATCH /products/0');
      expect(ledger.resume(runId, { checksum }).ok).toBe(true);
      const second = await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      expect(second.status).toBe('halted');
      // A run approved for one target before any probe holds, stopped after that one written:
      // the planned halt the owner continues from.
      expect(second.planned).toBe(true);
      expect(s.requests.filter((r) => r.method === 'PATCH').map((r) => r.path)).toEqual(['/products/0', '/products/0']);
      expect(ledger.getStatus(runId)).toMatchObject({ applied: 1, haltReason: BULK_HALT_REASONS.maxTargets });
    } finally {
      restore();
    }
  });

  it('a write answered with a redirect counts as sent: the approval for one is spent and the undo takes it back', async () => {
    const s = shop();
    for (let i = 4; i < 25; i++) s.items.set(`/products/${String(i)}`, { id: i, title: `Item ${String(i)}`, price: '12.00', updated_at: 't0' });
    // A host may apply a write and answer it with a redirect to the result.
    s.special.set('PATCH /products/0', { status: 303 });
    const restore = serve(s);
    try {
      const keys = Array.from({ length: 25 }, (_, i) => url(i));
      const c = client({ contract: mintBulkContract(HOST, keys) });
      const runId = await previewedRun(keys.map((target) => ({ target, after: { price: '15' } })), c);
      expect(ledger.approve(runId, { checksum: ledger.computeChecksum(runId)!, maxTargets: 1 }).ok).toBe(true);

      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('halted');
      expect(s.requests.filter((r) => r.method === 'PATCH').map((r) => r.path)).toEqual(['/products/0']);
      expect(ledger.getStatus(runId)).toMatchObject({ applied: 0, haltReason: BULK_HALT_REASONS.maxTargets });

      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      expect(undo.status.total).toBe(1);
    } finally {
      restore();
    }
  });

  it('a write whose connection broke after the request left spends the approval', async () => {
    const s = shop();
    for (let i = 4; i < 25; i++) s.items.set(`/products/${String(i)}`, { id: i, title: `Item ${String(i)}`, price: '12.00', updated_at: 't0' });
    s.dropAfter = new Set(['PATCH /products/0']);
    const restore = serve(s);
    try {
      const keys = Array.from({ length: 25 }, (_, i) => url(i));
      const c = client({ contract: mintBulkContract(HOST, keys) });
      const runId = await previewedRun(keys.map((target) => ({ target, after: { price: '15' } })), c);
      expect(ledger.approve(runId, { checksum: ledger.computeChecksum(runId)!, maxTargets: 1 }).ok).toBe(true);

      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('halted');
      expect(s.requests.filter((r) => r.method === 'PATCH').map((r) => r.path)).toEqual(['/products/0']);
      expect(ledger.getStatus(runId)).toMatchObject({ applied: 0, haltReason: BULK_HALT_REASONS.maxTargets });
    } finally {
      restore();
    }
  });

  it('a write stopped before its request left does not spend the approval', async () => {
    const s = shop();
    for (let i = 4; i < 25; i++) s.items.set(`/products/${String(i)}`, { id: i, title: `Item ${String(i)}`, price: '12.00', updated_at: 't0' });
    const restore = serve(s);
    try {
      const keys = Array.from({ length: 25 }, (_, i) => url(i));
      // The scan at the request stops the first target's body, which the plan let through.
      const c = client({ contract: mintBulkContract(HOST, keys), scan: (text) => (text.includes('MARKED') ? 'x' : null) });
      const runId = await previewedRun(keys.map((target, i) => ({ target, after: { price: i === 0 ? 'MARKED' : '15' } })), c, 'PATCH', () => null);
      expect(ledger.approve(runId, { checksum: ledger.computeChecksum(runId)!, maxTargets: 1 }).ok).toBe(true);

      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('halted');
      // Nothing went to the first target, so the one target approved is the next one.
      expect(s.requests.filter((r) => r.method === 'PATCH').map((r) => r.path)).toEqual(['/products/1']);
      expect(ledger.getStatus(runId)).toMatchObject({ applied: 1, haltReason: BULK_HALT_REASONS.maxTargets });
    } finally {
      restore();
    }
  });

  it('under a maximum, a resume goes past a target never sent to and retries a later one that may hold the verb', async () => {
    const s = shop();
    for (let i = 4; i < 25; i++) s.items.set(`/products/${String(i)}`, { id: i, title: `Item ${String(i)}`, price: '12.00', updated_at: 't0' });
    const restore = serve(s);
    try {
      const keys = Array.from({ length: 25 }, (_, i) => url(i));
      const c = client({ contract: mintBulkContract(HOST, keys) });
      const runId = await previewedRun(keys.map((target) => ({ target, after: { price: '15' } })), c);
      seedProbe();
      const checksum = ledger.computeChecksum(runId)!;
      expect(ledger.approve(runId, { checksum, maxTargets: 2 }).ok).toBe(true);
      // The first target changed since the preview (a conflict, nothing sent); the third fails.
      s.items.get('/products/0')!['price'] = '13.00';
      s.special.set('PATCH /products/2', { status: 502 });

      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('halted');
      expect(s.requests.filter((r) => r.method === 'PATCH').map((r) => r.path)).toEqual(['/products/1', '/products/2']);

      s.special.delete('PATCH /products/2');
      expect(ledger.resume(runId, { checksum }).ok).toBe(true);
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('halted');
      // The failed target is retried; the one never sent to is not written past the maximum.
      expect(s.requests.filter((r) => r.method === 'PATCH').map((r) => r.path)).toEqual(['/products/1', '/products/2', '/products/2']);
      expect(ledger.getStatus(runId)).toMatchObject({ applied: 2, haltReason: BULK_HALT_REASONS.maxTargets });
    } finally {
      restore();
    }
  });

  it('approves an unprobed external run for one target only, and widens it after the owner confirms the probe', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client();
      const runId = await previewedRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '15' } })), c);
      const checksum = ledger.computeChecksum(runId)!;
      expect(ledger.getStatus(runId)).toMatchObject({ writeMethod: 'PATCH', probeConfirmed: false });
      const agent = { toolContext: { bulkLedger: ledger } } as unknown as IAgent;
      expect(await bulkStatusTool.handler({ run_id: runId }, agent))
        .toContain('Writes with PATCH. It can be applied to one target first; more only after the user has checked that one.');
      expect(ledger.approve(runId, { checksum })).toEqual({ ok: false, reason: 'probe_required' });
      expect(ledger.approve(runId, { checksum, maxTargets: 3 })).toEqual({ ok: false, reason: 'probe_required' });
      expect(ledger.approve(runId, { checksum, maxTargets: 1 }).ok).toBe(true);

      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('halted');
      expect(ledger.getStatus(runId)).toMatchObject({ applied: 1, haltReason: BULK_HALT_REASONS.maxTargets });
      expect(s.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
      // Not yet confirmed: the resume cannot widen it.
      expect(ledger.resume(runId, { checksum, maxTargets: 3 })).toEqual({ ok: false, reason: 'probe_required' });

      expect(ledger.confirmProbe(runId, { confirmedBy: '{"auth":"bearer"}' })).toEqual({ ok: true });
      expect(ledger.getStatus(runId)!.probeConfirmed).toBe(true);
      expect(ledger.resume(runId, { checksum, maxTargets: 3 }).ok).toBe(true);
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');
      expect(ledger.getStatus(runId)).toMatchObject({ phase: 'done', applied: 3 });
    } finally {
      restore();
    }
  });

  it('a target found already holding its value proves nothing, and a probe is per verb', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client();
      s.items.get('/products/0')!['price'] = '15.00';
      const already = await previewedRun([{ target: url(0), after: { price: '15.00' } }], c);
      // Unchanged targets are not written at all; nothing to approve.
      expect(ledger.approve(already, { checksum: ledger.computeChecksum(already)! })).toEqual({ ok: false, reason: 'nothing_to_apply' });

      engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'aborted'`).run();
      const run = await previewedRun([{ target: url(1), after: { price: '15.00' } }], c);
      expect(ledger.approve(run, { checksum: ledger.computeChecksum(run)!, maxTargets: 1 }).ok).toBe(true);
      // The host already holds it by the time the run writes: recorded `already`.
      s.items.get('/products/1')!['price'] = '15.00';
      await runBulkEffect(run, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      expect(ledger.confirmProbe(run)).toEqual({ ok: false, reason: 'not_a_probe' });

      // A PATCH probe does not vouch for PUT.
      seedProbe('PATCH');
      engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'aborted'`).run();
      const put = await previewedRun([2, 3].map((i) => ({ target: url(i), after: { price: '9' } })), client({ contract: mintBulkContract(HOST, [url(2), url(3)], 'PUT') }), 'PUT');
      expect(ledger.approve(put, { checksum: ledger.computeChecksum(put)! })).toEqual({ ok: false, reason: 'probe_required' });
    } finally {
      restore();
    }
  });

  it('writes with the run\'s verb — PUT or POST to the resource URL — and the contract grants no other', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      for (const method of ['PUT', 'POST'] as const) {
        engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'aborted'`).run();
        s.requests.length = 0;
        const runId = await approvedRun([{ target: url(0), after: { price: method === 'PUT' ? '16' : '17' } }], client(), method);
        expect(ledger.getStatus(runId)!.writeMethod).toBe(method);
        expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: contractWriter })).status).toBe('done');
        expect(s.requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.path])).toEqual([[method, '/products/0']]);
      }
      // A PATCH through a PUT run's contract is refused before it is sent.
      engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'aborted'`).run();
      const runId = await approvedRun([{ target: url(1), after: { price: '5' } }], client(), 'PUT');
      s.requests.length = 0;
      const patching = (run: BulkRunForApply) => bulkWriterFor(run, null, (r) =>
        externalWriter(client({ contract: parseBulkContract(r.contractJson)! }), { method: 'PATCH', sleep: noSleep }));
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: patching })).status).toBe('halted');
      expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.contract);
      expect(s.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    } finally {
      restore();
    }
  });

  it('a PUT that replaces the whole resource costs one target during the probe, not N', async () => {
    const s = shop();
    s.replacingPut = true;
    const restore = serve(s);
    try {
      const c = client({ contract: mintBulkContract(HOST, [0, 1, 2].map(url), 'PUT') });
      const runId = await previewedRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '15' } })), c, 'PUT');
      expect(ledger.approve(runId, { checksum: ledger.computeChecksum(runId)!, maxTargets: 1 }).ok).toBe(true);
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: (run) => bulkWriterFor(run, null, () => externalWriter(c, { method: 'PUT', sleep: noSleep })) });
      // What the owner sees when checking the probe: the title is gone on the one target…
      expect(s.items.get('/products/0')).toEqual({ id: 0, price: '15.00', updated_at: 't1' });
      // …and on no other.
      expect(s.items.get('/products/1')!['title']).toBe('Item 1');
      expect(s.items.get('/products/2')!['title']).toBe('Item 2');
    } finally {
      restore();
    }
  });

  it('a field the provider requires is sent unchanged, named as such, and a foreign change to it makes the undo a conflict', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client();
      // `title` stands in for a field the provider requires on every edit (bexio's name_1).
      const runId = await approvedRun([{ target: url(0), after: { title: 'Item 0', price: '15' } }], c);
      expect(ledger.getPreview(runId)[0]!.sentUnchanged).toEqual(['title']);
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      s.items.get('/products/0')!['title'] = 'Renamed by someone else';
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! });
      await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      expect(ledger.getStatus(undo.status.id)).toMatchObject({ applied: 0, conflicts: 1 });
      expect(s.items.get('/products/0')).toMatchObject({ title: 'Renamed by someone else', price: '15.00' });
    } finally {
      restore();
    }
  });

  it('names a resource kind by its path without the last segment', () => {
    expect(resourceKindOf('/2.0/article/7')).toBe('/2.0/article/');
    expect(resourceKindOf('/2.0/contact/7/')).toBe('/2.0/contact/');
    expect(resourceKindOf('/wp-json/wc/v3/products/794')).toBe('/wp-json/wc/v3/products/');
  });

  it('a probe vouches for its kind of resource only, and a run over two kinds needs both', async () => {
    const s = shop();
    s.items.set('/contacts/1', { id: 1, name_1: 'Acme', note: 'x', updated_at: 't0' });
    const restore = serve(s);
    try {
      const c = client({ contract: mintBulkContract(HOST, [url(0), url(1), `https://${HOST}/contacts/1`], 'PUT') });
      // Contacts only: the products the run also writes are not vouched for.
      seedProbe('PUT', '/contacts/');
      const mixed = await previewedRun([
        { target: url(0), after: { price: '1' } }, { target: url(1), after: { price: '1' } },
        { target: `https://${HOST}/contacts/1`, after: { note: 'y' } },
      ], c, 'PUT');
      expect(ledger.approve(mixed, { checksum: ledger.computeChecksum(mixed)! })).toEqual({ ok: false, reason: 'probe_required' });
      // Products only is not enough either.
      engineDb.getDb().prepare('DELETE FROM bulk_host_probes').run();
      seedProbe('PUT', '/products/');
      expect(ledger.approve(mixed, { checksum: ledger.computeChecksum(mixed)! })).toEqual({ ok: false, reason: 'probe_required' });
      seedProbe('PUT', '/contacts/');
      expect(ledger.approve(mixed, { checksum: ledger.computeChecksum(mixed)! }).ok).toBe(true);
    } finally {
      restore();
    }
  });

  it('only a stopped apply run that wrote one target is a probe — not one still approved, not an undo', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client({ contract: mintBulkContract(HOST, [url(0), url(1)], 'PUT') });
      const runId = await previewedRun([0, 1].map((i) => ({ target: url(i), after: { price: '15' } })), c, 'PUT');
      const checksum = ledger.computeChecksum(runId)!;
      expect(ledger.approve(runId, { checksum, maxTargets: 1 }).ok).toBe(true);
      // Approved, not yet written: nothing to vouch for.
      expect(ledger.confirmProbe(runId)).toEqual({ ok: false, reason: 'not_a_probe' });
      // One target written but the run still writing (not halted, not done): not yet.
      ledger.setPhase(runId, ['approved'], 'writing');
      expect(ledger.claimTarget(runId, 0)).toBe(true);
      ledger.recordApplied({ id: runId, kind: 'apply', sourceRunId: null }, 0, 'written');
      expect(ledger.confirmProbe(runId)).toEqual({ ok: false, reason: 'not_a_probe' });
      engineDb.getDb().prepare('UPDATE bulk_targets SET applied_at = NULL, result = NULL, claimed_at = NULL WHERE run_id = ?').run(runId);
      engineDb.getDb().prepare('UPDATE bulk_runs SET targets_applied = 0 WHERE id = ?').run(runId);
      const putWriter = (run: BulkRunForApply) => bulkWriterFor(run, null, () => externalWriter(c, { method: 'PUT', sleep: noSleep }));
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: putWriter });
      // Stopped at its cap with one target written: this one is a probe, and it records PUT.
      expect(ledger.confirmProbe(runId)).toEqual({ ok: true });
      expect(engineDb.getDb().prepare('SELECT host, method, kind, run_id FROM bulk_host_probes').all())
        .toEqual([{ host: HOST, method: 'PUT', kind: '/products/', run_id: runId }]);
      // The undo of that one write is none: an undo writes back, it tests nothing new.
      engineDb.getDb().prepare('DELETE FROM bulk_host_probes').run();
      engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'done', halt_reason = NULL WHERE id = ?`).run(runId);
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! }).ok).toBe(true);
      await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: putWriter });
      expect(ledger.getStatus(undo.status.id)!.applied).toBe(1);
      expect(ledger.confirmProbe(undo.status.id)).toEqual({ ok: false, reason: 'not_a_probe' });
    } finally {
      restore();
    }
  });
});

describe('an unmeasured write form', () => {
  beforeEach(() => { formFixture.measured = false; });
  afterEach(() => { formFixture.measured = true; });

  const agent = (): IAgent => ({ toolContext: { bulkLedger: ledger } }) as unknown as IAgent;

  it('is marked in the status, kept out of the model\'s text, and approved only with the literal confirmation', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await previewedRun([0, 1, 2].map((i) => ({ target: url(i), after: { price: '15' } })));
      const checksum = ledger.computeChecksum(runId)!;
      expect(ledger.getStatus(runId)).toMatchObject({ writeForm: 'unmeasured', probeConfirmed: false });
      const text = await bulkStatusTool.handler({ run_id: runId }, agent());
      expect(text).not.toMatch(/unmeasured|not checked/i);
      expect(ledger.approve(runId, { checksum, maxTargets: 1 })).toEqual({ ok: false, reason: 'unmeasured_unconfirmed' });
      expect(ledger.approve(runId, { checksum, maxTargets: 1, unmeasuredConfirmed: false })).toEqual({ ok: false, reason: 'unmeasured_unconfirmed' });
      // Confirmed, it is still one target first: no probe of its own yet.
      expect(ledger.approve(runId, { checksum, maxTargets: 3, unmeasuredConfirmed: true })).toEqual({ ok: false, reason: 'probe_required' });
      expect(ledger.approve(runId, { checksum, maxTargets: 1, unmeasuredConfirmed: true }).ok).toBe(true);
    } finally {
      restore();
    }
  });

  it('needs its own probe in every run: neither a probe on record nor an earlier run\'s probe widens it', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client();
      const first = await previewedRun([0, 1].map((i) => ({ target: url(i), after: { price: '15' } })), c);
      const firstSum = ledger.computeChecksum(first)!;
      expect(ledger.approve(first, { checksum: firstSum, maxTargets: 1, unmeasuredConfirmed: true }).ok).toBe(true);
      expect((await runBulkEffect(first, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('halted');
      expect(ledger.confirmProbe(first)).toEqual({ ok: true });
      expect(ledger.getStatus(first)!.probeConfirmed).toBe(true);
      expect(ledger.resume(first, { checksum: firstSum, maxTargets: 2 }).ok).toBe(true);
      expect((await runBulkEffect(first, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');

      // The same host, verb and kind of resource, in a second run: the first run's probe
      // is on record for them, and still the second run writes one target first.
      const second = await previewedRun([2, 3].map((i) => ({ target: url(i), after: { price: '16' } })), c);
      expect(engineDb.getDb().prepare('SELECT run_id FROM bulk_host_probes WHERE host = ? AND method = ? AND kind = ?')
        .get(HOST, 'PATCH', 'unmeasured:/products/')).toEqual({ run_id: first });
      expect(ledger.getStatus(second)!.probeConfirmed).toBe(false);
      expect(ledger.approve(second, { checksum: ledger.computeChecksum(second)!, maxTargets: 2, unmeasuredConfirmed: true }))
        .toEqual({ ok: false, reason: 'probe_required' });
    } finally {
      restore();
    }
  });

  it('a measured form keeps the old rule: one probe on record widens any later run', async () => {
    formFixture.measured = true;
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await previewedRun([0, 1].map((i) => ({ target: url(i), after: { price: '15' } })));
      seedProbe();
      expect(ledger.getStatus(runId)).toMatchObject({ writeForm: 'measured', probeConfirmed: true });
      expect(ledger.approve(runId, { checksum: ledger.computeChecksum(runId)! }).ok).toBe(true);
    } finally {
      restore();
    }
  });

  it('takes an undo back in full, without a confirmation or a probe of its own', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client();
      const runId = await previewedRun([0, 1].map((i) => ({ target: url(i), after: { price: '15' } })), c);
      const checksum = ledger.computeChecksum(runId)!;
      expect(ledger.approve(runId, { checksum, maxTargets: 1, unmeasuredConfirmed: true }).ok).toBe(true);
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      expect(ledger.confirmProbe(runId)).toEqual({ ok: true });
      expect(ledger.resume(runId, { checksum, maxTargets: 2 }).ok).toBe(true);
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');

      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      expect(undo.status).toMatchObject({ kind: 'undo', writeForm: 'unmeasured', probeConfirmed: true });
      // Every target at once, with no confirmation: the source's approver gave it.
      expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! }).ok).toBe(true);
      expect((await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');
      expect(s.items.get('/products/0')!['price']).toBe('12.00');
      expect(s.items.get('/products/1')!['price']).toBe('12.00');
    } finally {
      restore();
    }
  });

  it('counts a probe only for the form it was written to: a measured target does not vouch for an unmeasured one', async () => {
    const s = shop();
    const woo = (id: string): string => `https://${HOST}/wp-json/wc/v3/products/${id}`;
    s.items.set('/wp-json/wc/v3/products/7', { id: 7, price: '12.00' });
    s.items.set('/wp-json/wc/v3/products/batch', { id: 'batch', price: '12.00' });
    const restore = serve(s);
    try {
      // Same kind of resource; the measured product is written first and becomes the probe.
      const c = client({ contract: mintBulkContract(HOST, [woo('7'), woo('batch')]) });
      const runId = await previewedRun([{ target: woo('7'), after: { price: '15' } }, { target: woo('batch'), after: { price: '15' } }], c);
      const checksum = ledger.computeChecksum(runId)!;
      expect(ledger.getStatus(runId)!.writeForm).toBe('unmeasured');
      expect(ledger.approve(runId, { checksum, maxTargets: 1, unmeasuredConfirmed: true }).ok).toBe(true);
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      expect(s.items.get('/wp-json/wc/v3/products/7')!['price']).toBe('15.00');
      expect(ledger.confirmProbe(runId)).toEqual({ ok: true });
      expect(ledger.getStatus(runId)!.probeConfirmed).toBe(false);
      expect(ledger.resume(runId, { checksum, maxTargets: 2 })).toEqual({ ok: false, reason: 'probe_required' });
      expect(s.items.get('/wp-json/wc/v3/products/batch')!['price']).toBe('12.00');
    } finally {
      restore();
    }
  });

  it('keeps a probe written to an unmeasured target from widening a measured run', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client();
      const unmeasured = await previewedRun([0, 1].map((i) => ({ target: url(i), after: { price: '15' } })), c);
      expect(ledger.approve(unmeasured, { checksum: ledger.computeChecksum(unmeasured)!, maxTargets: 1, unmeasuredConfirmed: true }).ok).toBe(true);
      await runBulkEffect(unmeasured, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      expect(ledger.confirmProbe(unmeasured)).toEqual({ ok: true });
      engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'aborted' WHERE id = ?`).run(unmeasured);

      // The same host, verb and kind, now a measured form (the stand-in): it needs a probe
      // written to a measured target, and the unmeasured one is not that.
      formFixture.measured = true;
      const measured = await previewedRun([2, 3].map((i) => ({ target: url(i), after: { price: '16' } })), c);
      expect(ledger.getStatus(measured)).toMatchObject({ writeForm: 'measured', probeConfirmed: false });
      expect(ledger.approve(measured, { checksum: ledger.computeChecksum(measured)!, maxTargets: 2 })).toEqual({ ok: false, reason: 'probe_required' });
    } finally {
      restore();
    }
  });

  // Probes confirmed before the write forms were told apart sit under the plain kind wherever
  // they landed. What a probe vouches for is read from the one target its run wrote.
  const WOO_KIND = '/wp-json/wc/v3/products/';
  const woo = (id: string): string => `https://${HOST}${WOO_KIND}${id}`;
  async function measuredWooRun(s: ReturnType<typeof shop>, c: ExternalClient): Promise<string> {
    for (const id of ['1', '2']) s.items.set(`${WOO_KIND}${id}`, { id: Number(id), price: '12.00' });
    const runId = await previewedRun(['1', '2'].map((id) => ({ target: woo(id), after: { price: '15' } })), c);
    expect(ledger.getStatus(runId)!.writeForm).toBe('measured');
    return runId;
  }

  it('a probe under the plain kind widens a measured run only if its own target was a measured form', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client({ contract: mintBulkContract(HOST, [woo('1'), woo('2')]) });
      const runId = await measuredWooRun(s, c);
      const checksum = ledger.computeChecksum(runId)!;
      seedProbe('PATCH', WOO_KIND, `${WOO_KIND}batch`);
      expect(ledger.getStatus(runId)!.probeConfirmed).toBe(false);
      expect(ledger.approve(runId, { checksum, maxTargets: 2 })).toEqual({ ok: false, reason: 'probe_required' });
      seedProbe('PATCH', WOO_KIND, `${WOO_KIND}900`);
      expect(ledger.getStatus(runId)!.probeConfirmed).toBe(true);
      expect(ledger.approve(runId, { checksum, maxTargets: 2 }).ok).toBe(true);
    } finally {
      restore();
    }
  });

  it('a probe run that went on wide after its probe still vouches for later runs', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client({ contract: mintBulkContract(HOST, [woo('1'), woo('2')]) });
      const probeRun = await measuredWooRun(s, c);
      const checksum = ledger.computeChecksum(probeRun)!;
      expect(ledger.approve(probeRun, { checksum, maxTargets: 1 }).ok).toBe(true);
      await runBulkEffect(probeRun, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      expect(ledger.confirmProbe(probeRun)).toEqual({ ok: true });
      expect(ledger.resume(probeRun, { checksum, maxTargets: 2 }).ok).toBe(true);
      expect((await runBulkEffect(probeRun, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');

      const later = await previewedRun(['3', '4'].map((id) => {
        s.items.set(`${WOO_KIND}${id}`, { id: Number(id), price: '12.00' });
        return { target: woo(id), after: { price: '16' } };
      }), client({ contract: mintBulkContract(HOST, [woo('3'), woo('4')]) }));
      expect(ledger.getStatus(later)!.probeConfirmed).toBe(true);
      expect(ledger.approve(later, { checksum: ledger.computeChecksum(later)!, maxTargets: 2 }).ok).toBe(true);
    } finally {
      restore();
    }
  });

  it('the probe target is the run\'s first applied one, not a later one', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client({ contract: mintBulkContract(HOST, [woo('1'), woo('2')]) });
      const runId = await measuredWooRun(s, c);
      // An old probe run, filed under the plain kind: its probe target was measured, a later
      // target it wrote was not. Which one it vouches through decides.
      const probeRun = 'fixture-old-probe';
      const db = engineDb.getDb();
      db.prepare(`INSERT INTO bulk_runs (id, rule_hash, target_system, undo, phase, targets_total, targets_applied)
        VALUES (?, 'fixture', ?, 'restorable', 'done', 2, 2)`).run(probeRun, `http:${HOST}`);
      const target = db.prepare(`INSERT INTO bulk_targets (run_id, seq, target_key, change, applied_at, result) VALUES (?, ?, ?, 'update', ?, ?)`);
      target.run(probeRun, 0, engineDb.enc(`https://${HOST}${WOO_KIND}900`), '2026-09-30T00:00:00.000Z', engineDb.enc('written'));
      target.run(probeRun, 1, engineDb.enc(`https://${HOST}${WOO_KIND}batch`), '2026-09-30T01:00:00.000Z', engineDb.enc('written'));
      db.prepare('INSERT OR REPLACE INTO bulk_host_probes (host, method, kind, run_id, confirmed_at) VALUES (?, ?, ?, ?, ?)')
        .run(HOST, 'PATCH', WOO_KIND, probeRun, '2026-09-30T00:30:00.000Z');
      expect(ledger.getStatus(runId)!.probeConfirmed).toBe(true);
      // The same targets the other way round in time: the probe target was the unmeasured one.
      db.prepare(`UPDATE bulk_targets SET applied_at = ? WHERE run_id = ? AND seq = 0`).run('2026-09-30T02:00:00.000Z', probeRun);
      expect(ledger.getStatus(runId)!.probeConfirmed).toBe(false);
    } finally {
      restore();
    }
  });

  it('takes back a measured run in full also when the probe it was written under no longer holds', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client({ contract: mintBulkContract(HOST, [woo('1'), woo('2')]) });
      const runId = await measuredWooRun(s, c);
      seedProbe('PATCH', WOO_KIND, `${WOO_KIND}900`);
      expect(ledger.approve(runId, { checksum: ledger.computeChecksum(runId)!, maxTargets: 2 }).ok).toBe(true);
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');
      seedProbe('PATCH', WOO_KIND, `${WOO_KIND}batch`);
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      expect(undo.status).toMatchObject({ kind: 'undo', writeForm: 'measured', probeConfirmed: true });
      expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! }).ok).toBe(true);
      expect((await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');
      expect(s.items.get(`${WOO_KIND}1`)!['price']).toBe('12.00');
      expect(s.items.get(`${WOO_KIND}2`)!['price']).toBe('12.00');
    } finally {
      restore();
    }
  });

  it('an undo sends each target only the fields its source sent there, even from a wider before-image', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client({ contract: mintBulkContract(HOST, [woo('1'), woo('2')]) });
      const runId = await measuredWooRun(s, c);
      seedProbe('PATCH', WOO_KIND, `${WOO_KIND}900`);
      expect(ledger.approve(runId, { checksum: ledger.computeChecksum(runId)!, maxTargets: 2 }).ok).toBe(true);
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');
      // The host holds the field too. Without the cut the undo would not send it either: it reads
      // the target over its own fields, finds them unlike what the source left (over the sent
      // field), and books every target as a conflict, so nothing is restored. The cut is what lets
      // the undo through with exactly the field the source sent.
      for (const id of ['1', '2']) s.items.get(`${WOO_KIND}${id}`)!['title'] = 'kept by the host';
      // A before-image stored wider than what the source sent: a field no probe has seen.
      engineDb.getDb().prepare('UPDATE bulk_targets SET before = ? WHERE run_id = ?')
        .run(engineDb.enc(JSON.stringify({ absent: false, value: { price: '12.00', title: 'never sent' } })), runId);
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! }).ok).toBe(true);
      s.requests.length = 0;
      expect((await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');
      const sent = s.requests.filter((r) => r.method === 'PATCH').map((r) => r.body);
      expect(sent).toEqual([{ price: '12.00' }, { price: '12.00' }]);
      expect(s.items.get(`${WOO_KIND}1`)!['title']).toBe('kept by the host');
    } finally {
      restore();
    }
  });

  it('a resume checks the probe also when it keeps the cap a run was approved wide with', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client({ contract: mintBulkContract(HOST, [woo('1'), woo('2')]) });
      const runId = await measuredWooRun(s, c);
      const checksum = ledger.computeChecksum(runId)!;
      seedProbe('PATCH', WOO_KIND, `${WOO_KIND}900`);
      expect(ledger.approve(runId, { checksum, maxTargets: 2 }).ok).toBe(true);
      ledger.halt(runId, BULK_HALT_REASONS.expired);
      expect(ledger.resume(runId, { checksum }).ok).toBe(true);
      // The probe stops holding (here: the one on record turns out to be on an unmeasured path).
      ledger.halt(runId, BULK_HALT_REASONS.expired);
      seedProbe('PATCH', WOO_KIND, `${WOO_KIND}batch`);
      expect(ledger.resume(runId, { checksum })).toEqual({ ok: false, reason: 'probe_required' });
      expect(ledger.resume(runId, { checksum, maxTargets: 1 }).ok).toBe(true);
    } finally {
      restore();
    }
  });

  it('the effect writes one target at most when the probe a wide approval rested on no longer holds', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client({ contract: mintBulkContract(HOST, [woo('1'), woo('2')]) });
      const control = await measuredWooRun(s, c);
      seedProbe('PATCH', WOO_KIND, `${WOO_KIND}900`);
      expect(ledger.approve(control, { checksum: ledger.computeChecksum(control)!, maxTargets: 2 }).ok).toBe(true);
      expect((await runBulkEffect(control, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');
      expect(s.items.get(`${WOO_KIND}2`)!['price']).toBe('15.00');

      engineDb.getDb().prepare(`DELETE FROM bulk_host_probes`).run();
      const wide = await previewedRun(['3', '4'].map((id) => {
        s.items.set(`${WOO_KIND}${id}`, { id: Number(id), price: '12.00' });
        return { target: woo(id), after: { price: '15' } };
      }), client({ contract: mintBulkContract(HOST, [woo('3'), woo('4')]) }));
      seedProbe('PATCH', WOO_KIND, `${WOO_KIND}900`);
      expect(ledger.approve(wide, { checksum: ledger.computeChecksum(wide)!, maxTargets: 2 }).ok).toBe(true);
      seedProbe('PATCH', WOO_KIND, `${WOO_KIND}batch`);
      const out = await runBulkEffect(wide, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(client({ contract: mintBulkContract(HOST, [woo('3'), woo('4')]) })) });
      expect(out.status).toBe('halted');
      expect(ledger.getStatus(wide)!.haltReason).toBe(BULK_HALT_REASONS.probeRequired);
      // Approved for two, held to one because the probe stopped holding: not the approval's
      // bound, so not a planned halt.
      expect(out.planned).toBeUndefined();
      expect([s.items.get(`${WOO_KIND}3`)!['price'], s.items.get(`${WOO_KIND}4`)!['price']].sort()).toEqual(['12.00', '15.00']);
    } finally {
      restore();
    }
  });
});

describe('a run writes to a connected account only in a measured form', () => {
  const BEXIO = 'api.bexio.com';
  const payment = `https://${BEXIO}/2.0/kb_invoice/7/payment`;
  const contact = `https://${BEXIO}/2.0/contact/7`;
  function bexioClient(connected: boolean, slot: Record<string, string> = {}): { c: ExternalClient; sent: string[]; restore: () => void } {
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    const sent: string[] = [];
    const restore = setPinnedTransportForTests(async (input: PinnedTransportInput) => {
      sent.push(`${input.method} ${new URL(input.url).pathname}`);
      return new Response(null, { status: 204 });
    });
    const c = externalClient({
      contract: mintBulkContract(BEXIO, [payment, contact], 'POST'),
      hostPolicy: createToolContext({}),
      ackHosts: undefined,
      attach: async (_u, headers) => { headers['authorization'] = `Bearer ${TOKEN}`; Object.assign(headers, slot); return { id: 'fixture', grantId: 'grant-1' }; },
      rateLimit: () => null,
      scan: detectSecretInContent,
      connectedAccount: () => connected,
      recordRead: null,
    });
    return { c, sent, restore };
  }

  it('does not send an unmeasured write (booking a payment), whatever the run\'s approval', async () => {
    const { c, sent, restore } = bexioClient(true);
    try {
      expect((await c.write(payment, 'POST', { amount: 10 })).kind).toBe('not_granted');
      expect(sent).toEqual([]);
    } finally {
      restore();
    }
  });

  it('control: sends the measured form there', async () => {
    const { c, sent, restore } = bexioClient(true);
    try {
      expect((await c.write(contact, 'POST', { name_1: 'Muster' })).kind).not.toBe('not_granted');
      expect(sent).toEqual(['POST /2.0/contact/7']);
    } finally {
      restore();
    }
  });

  // The measured form is decided before the credential is attached; a slot that then turns the
  // measured POST into a DELETE must not go out with it on the account the decision was about.
  it('SECURITY: does not send a measured write whose attach turns it into another method', async () => {
    const { c, sent, restore } = bexioClient(true, { 'x-http-method-override': 'DELETE' });
    try {
      expect((await c.write(contact, 'POST', { name_1: 'Muster' })).kind).toBe('no_credential');
      expect(sent).toEqual([]);
    } finally {
      restore();
    }
  });

  it('control: an account without a built-in provider gets the unmeasured write as before', async () => {
    const { c, sent, restore } = bexioClient(false);
    try {
      await c.write(payment, 'POST', { amount: 10 });
      expect(sent).toEqual(['POST /2.0/kb_invoice/7/payment']);
    } finally {
      restore();
    }
  });
});


// The worker's own client, as a run gets it (`bulkClientFactory`): a profile on bexio's API that
// does not go through the provider gets no credential for a write and keeps it for a read.
describe('the worker attaches a run\'s credential by the method it sends', () => {
  it('gives a write through a pasted-token profile on the bexio API no credential, and a read its credential', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const store = new ApiStore();
      store.register({
        id: 'bexio-pat', name: 'bexio', base_url: 'https://api.bexio.com', description: 'bexio',
        auth: { type: 'bearer', vault_keys: ['BEXIO_PAT'] },
        custom_endpoint_ack: { accepted: true, hosts: ['api.bexio.com'], accepted_at: '2026-10-15T00:00:00.000Z' },
      });
      const vault = {
        resolve: (n: string): string | null => (n === 'BEXIO_PAT' ? 'pat-value' : null),
        resolveSecretRefs: (x: unknown): unknown => x,
        extractSecretNames: (): string[] => [],
        isEnvironmentSecret: (): boolean => false,
        listNames: (): string[] => ['BEXIO_PAT'],
      };
      const engine = { getApiStore: () => store, getSecretStore: () => vault, getToolContext: () => ({ ...createToolContext({}), vaultNameBindings: bindingsAsMigrated(store) }), getAuditLog: () => null };
      const factory = await (WorkerLoop.prototype as unknown as {
        bulkClientFactory: (this: unknown) => Promise<(contractJson: string | null) => ExternalClient | null>;
      }).bulkClientFactory.call({ engine });
      const target = 'https://api.bexio.com/products/0';
      const c = factory({ id: 'r', contractJson: JSON.stringify(mintBulkContract('api.bexio.com', [target])), delegatedPlanner: null })!;
      expect(await c.write(target, 'PATCH', { price: '15' })).toEqual({ kind: 'no_credential' });
      expect(s.requests).toEqual([]);
      expect((await c.get(target)).kind).not.toBe('no_credential');
      expect(s.requests.map((r) => [r.method, r.auth])).toEqual([['GET', 'Bearer pat-value']]);
    } finally {
      restore();
    }
  });

  // The worker asks whether a target is a connected account in every form of its host, as the
  // tool does: a target written with a root dot is the same account as the profile without one.
  // The control without a preset is not refused as a connected account; where it stops after
  // that (today: at the credential, none is attached for the dotted host) is not its subject.
  it.each([
    ['example-shop', true],
    [undefined, false],
  ] as const)('refuses an unmeasured write to a connected account named with a root dot (preset %s: refused as connected %s)', async (presetId, refusedAsConnected) => {
    const s = shop();
    const restore = serve(s);
    formFixture.measured = false;
    try {
      const store = new ApiStore();
      store.register({
        id: 'shop', name: 'Shop', base_url: `https://${HOST}/`, description: 'Shop',
        auth: { type: 'bearer', vault_keys: ['SHOP_TOKEN'], ...(presetId === undefined ? {} : { oauth: { preset_id: presetId } }) } as never,
        custom_endpoint_ack: { accepted: true, hosts: [HOST], accepted_at: '2026-10-15T00:00:00.000Z' },
      });
      const vault = {
        resolve: (n: string): string | null => (n === 'SHOP_TOKEN' ? TOKEN : null),
        resolveSecretRefs: (x: unknown): unknown => x,
        extractSecretNames: (): string[] => [],
        isEnvironmentSecret: (): boolean => false,
        listNames: (): string[] => ['SHOP_TOKEN'],
      };
      const engine = { getApiStore: () => store, getSecretStore: () => vault, getToolContext: () => ({ ...createToolContext({}), vaultNameBindings: bindingsAsMigrated(store) }), getAuditLog: () => null };
      const factory = await (WorkerLoop.prototype as unknown as {
        bulkClientFactory: (this: unknown) => Promise<(contractJson: string | null) => ExternalClient | null>;
      }).bulkClientFactory.call({ engine });
      const target = `https://${HOST}./products/0`;
      const c = factory({ id: 'r', contractJson: JSON.stringify(mintBulkContract(`${HOST}.`, [target])), delegatedPlanner: null })!;
      const result = await c.write(target, 'PATCH', { price: '15' });
      if (refusedAsConnected) {
        expect(result).toEqual({ kind: 'not_granted' });
        expect(s.requests).toEqual([]);
      } else {
        expect(result).not.toEqual({ kind: 'not_granted' });
      }
    } finally {
      formFixture.measured = true;
      restore();
    }
  });
});

// PRD connection-attribution A7: the connection and grant whose credential each target's requests
// carried, per target, because a re-consent can land mid-run.
describe('the connection and grant of each bulk target (A7)', () => {
  type Row = { seq: number; read_connection_id: string | null; read_grant_id: string | null; write_connection_id: string | null; write_grant_id: string | null };
  const rowsOf = (runId: string): Row[] => engineDb.getDb().prepare(
    'SELECT seq, read_connection_id, read_grant_id, write_connection_id, write_grant_id FROM bulk_targets WHERE run_id = ? ORDER BY seq',
  ).all(runId) as Row[];
  const runOf = (runId: string): unknown => engineDb.getDb().prepare('SELECT first_connection_id AS connection_id, first_grant_id AS grant_id FROM bulk_runs WHERE id = ?').get(runId);
  const shopGrant = (grantId: string | null): AttachedConnection => ({ id: 'shop', grantId });

  it('records the grant each target was read and written under, and none it did not carry', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      // Target 0 under g1 throughout. Target 1 is read under g1, and its write goes out under g2: a
      // re-consent between its check and its write. Its read-back is under g2 again.
      let writing = false;
      const c = client({ connection: (u, method) => shopGrant(writing && u === url(1) && (method !== 'GET' || s.requests.some((r) => r.method === 'PATCH' && r.path === '/products/1')) ? 'g2' : 'g1') });
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }, { target: url(1), after: { price: '20' } }], c);
      expect(rowsOf(runId).map((r) => [r.read_connection_id, r.read_grant_id, r.write_connection_id]), 'the preview reads each before-image under g1, nothing is written yet')
        .toEqual([['shop', 'g1', null], ['shop', 'g1', null]]);
      writing = true;
      const out = await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      expect(out.status).toBe('done');
      expect(rowsOf(runId)).toEqual([
        { seq: 0, read_connection_id: 'shop', read_grant_id: 'g1', write_connection_id: 'shop', write_grant_id: 'g1' },
        // Its check went out under g1 and its write under g2: the target holds data of both, so its
        // write grant is unknown rather than either one.
        { seq: 1, read_connection_id: 'shop', read_grant_id: 'g1', write_connection_id: 'shop', write_grant_id: null },
      ]);
      expect(runOf(runId), 'the run keeps its first grant as a summary').toEqual({ connection_id: 'shop', grant_id: 'g1' });
    } finally {
      restore();
    }
  });

  it('records the write of a target whose answer said it failed, and none for a target never sent to', async () => {
    const s = shop();
    s.landThenFail = new Set(['/products/0']);
    const restore = serve(s);
    try {
      const c = client({ connection: () => shopGrant('g1') });
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }], c);
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      expect(targetErrors(runId)).toEqual(['write_failed']);
      expect(rowsOf(runId)[0]).toMatchObject({ write_connection_id: 'shop', write_grant_id: 'g1' });
    } finally {
      restore();
    }
  });

  it('a re-consent between the write and its read-back leaves the write grant unknown: the stored after-image is the newer grant\'s', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      let writing = false;
      const c = client({ connection: (_u, method) => shopGrant(writing && method === 'GET' && s.requests.some((r) => r.method === 'PATCH') ? 'g2' : 'g1') });
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }], c);
      writing = true;
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');
      expect(rowsOf(runId)[0]).toMatchObject({ write_connection_id: 'shop', write_grant_id: null });
    } finally {
      restore();
    }
  });

  it('a write the host refused after it left halts the run and still records whose credential it carried', async () => {
    const s = shop();
    s.special.set('PATCH /products/0', { status: 401 });
    const restore = serve(s);
    try {
      const c = client({ connection: () => shopGrant('g1') });
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }], c);
      const out = await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      expect(out.status).toBe('halted');
      // The target is released, not recorded: only the mark made as the write left names it.
      const row = engineDb.getDb().prepare('SELECT write_sent, applied_at, error FROM bulk_targets WHERE run_id = ?').get(runId);
      expect(row).toEqual({ write_sent: 1, applied_at: null, error: null });
      expect(rowsOf(runId)[0]).toMatchObject({ write_connection_id: 'shop', write_grant_id: 'g1' });
    } finally {
      restore();
    }
  });

  it('a target found changed is a conflict, recorded with the connection its check was read under', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      let grant = 'g1';
      const c = client({ connection: () => shopGrant(grant) });
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }], c);
      s.items.get('/products/0')!['price'] = '13.00';
      grant = 'g2';
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      expect(targetErrors(runId)).toEqual(['conflict']);
      expect(rowsOf(runId)[0]).toMatchObject({ read_grant_id: 'g1', write_connection_id: 'shop', write_grant_id: 'g2' });
    } finally {
      restore();
    }
  });

  it('each target counts only its own requests: one wholly under the next grant names that grant', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      let writing = false;
      const c = client({ connection: (u) => shopGrant(writing && u === url(1) ? 'g2' : 'g1') });
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }, { target: url(1), after: { price: '20' } }], c);
      writing = true;
      expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) })).status).toBe('done');
      expect(rowsOf(runId).map((r) => r.write_grant_id)).toEqual(['g1', 'g2']);
    } finally {
      restore();
    }
  });

  it('records nothing for a request whose credential could not be attached', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }], client({ connection: () => shopGrant('g1') }));
      const out = await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(client({ attach: false })) });
      expect(out.status).toBe('halted');
      expect(rowsOf(runId)[0]).toMatchObject({ write_connection_id: null, write_grant_id: null });
    } finally {
      restore();
    }
  });

  it('counts only requests that were sent: one stopped by the rate limit after its attach carried nothing', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      let limited = true;
      const c = client({ connection: () => shopGrant(limited ? 'g-limited' : 'g1'), rateLimit: () => (limited ? 'spent' : null) });
      const track = c.track();
      expect((await c.get(url(0))).kind).toBe('rate_limited');
      expect(track(), 'attached but not sent').toBeNull();
      limited = false;
      expect((await c.get(url(0))).kind).toBe('ok');
      expect(track()).toEqual(shopGrant('g1'));
      expect(c.track()(), 'a new mark starts empty').toBeNull();
    } finally {
      restore();
    }
  });

  it('the ledger merges each side across stages: a grant once unknown is never named again, the run keeps its first', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }, { target: url(1), after: { price: '20' } }], client({ connection: () => shopGrant('g0') }));
      expect(runOf(runId), 'the preview recorded the run\'s first connection').toEqual({ connection_id: 'shop', grant_id: 'g0' });
      // A write leaving under g1 is recorded as it leaves, before the target is.
      ledger.markSent(runId, 0, shopGrant('g1'));
      expect(rowsOf(runId)[0]).toMatchObject({ write_connection_id: 'shop', write_grant_id: 'g1' });
      // The same grant again keeps it; a resume under g2 makes it unknown; g1 again does not bring it back.
      ledger.recordFailed(runId, 0, 'write_failed', shopGrant('g1'));
      expect(rowsOf(runId)[0]).toMatchObject({ write_connection_id: 'shop', write_grant_id: 'g1' });
      ledger.markSent(runId, 0, shopGrant('g2'));
      expect(rowsOf(runId)[0]).toMatchObject({ write_connection_id: 'shop', write_grant_id: null });
      ledger.recordApplied({ id: runId, kind: 'apply', sourceRunId: null }, 0, 'written', Date.now(), null, shopGrant('g1'));
      expect(rowsOf(runId)[0]).toMatchObject({ write_connection_id: 'shop', write_grant_id: null });
      // Another connection's write keeps the first id, with an unknown grant.
      ledger.markSent(runId, 1, { id: 'other', grantId: 'g9' });
      ledger.markSent(runId, 1, shopGrant('g9'));
      expect(rowsOf(runId)[1]).toMatchObject({ write_connection_id: 'other', write_grant_id: null });
      // The run's summary stays the first one recorded.
      expect(runOf(runId)).toEqual({ connection_id: 'shop', grant_id: 'g0' });
      // A target recorded once is not recorded again: the second recordApplied changes nothing.
      ledger.recordApplied({ id: runId, kind: 'apply', sourceRunId: null }, 1, 'written', Date.now(), null, shopGrant('g7'));
      ledger.recordApplied({ id: runId, kind: 'apply', sourceRunId: null }, 1, 'written', Date.now(), null, { id: 'late', grantId: 'g8' });
      expect(rowsOf(runId)[1]).toMatchObject({ write_connection_id: 'other', write_grant_id: null });
      // Neither side touches the other.
      expect(rowsOf(runId).map((r) => [r.read_connection_id, r.read_grant_id])).toEqual([['shop', 'g0'], ['shop', 'g0']]);
    } finally {
      restore();
    }
  });

  it('a read that makes the target invalid records no connection, and a read is recorded with its image only', async () => {
    const out = ledger.recordExternalPlan({
      createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, targets: planExternal([{ target: url(0), after: { price: '1' } }, { target: url(1), after: { price: '2' } }], HOST, detectSecretInContent),
      contract: mintBulkContract(HOST, [url(0), url(1)]),
    });
    if (!out.ok) throw new Error(out.reason);
    const runId = out.status.id;
    expect(ledger.resumePreview(runId).ok).toBe(true);
    expect(ledger.recordRead(runId, 0, { invalid: 'not_found' }, shopGrant('g1'))).toBe(true);
    expect(ledger.recordRead(runId, 1, { before: { price: '9' } }, shopGrant('g1'))).toBe(true);
    // A second read of a target already read stores nothing, so it records nothing either.
    expect(ledger.recordRead(runId, 1, { before: { price: '9' } }, shopGrant('g2'))).toBe(false);
    expect(rowsOf(runId).map((r) => [r.read_connection_id, r.read_grant_id])).toEqual([[null, null], ['shop', 'g1']]);
  });

  // Through a real worker tick: the worker's own client maps the attached profile to its id and
  // grant. An empty grant (a file-loaded profile) is none.
  it.each([['grant-shop', 'grant-shop'], ['', null]] as const)('the worker records the attached profile and its grant %j', async (held, recorded) => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }], client({ connection: () => shopGrant('preview-grant') }), 'PUT');
      const apiStore = new ApiStore();
      apiStore.register({
        id: 'shop', name: 'Shop', base_url: `https://${HOST}/`, description: 'Shop',
        auth: { type: 'bearer', vault_keys: ['SHOP_TOKEN'] },
        custom_endpoint_ack: { accepted: true, hosts: [HOST], accepted_at: '2026-09-30T00:00:00.000Z' },
        oauth_grant: { grant_id: held },
      });
      expect(apiStore.get('shop')?.oauth_grant?.grant_id, 'the fixture holds the grant it was given').toBe(held);
      const triggers = new TriggerStore(engineDb);
      const recordTaskRun = vi.fn((id: string, result: string, status: 'success' | 'failed' | 'timeout') => {
        triggers.updateFields(id, { status: status === 'success' ? 'completed' : 'failed' });
        triggers.updateRunResult(id, { lastRunAt: new Date().toISOString(), lastRunResult: result, lastRunStatus: status, nextRunAt: null });
      });
      const engine = {
        getTaskManager: () => ({
          getDueTriggers: () => triggers.getDue(), getExpiredWaitingTriggers: () => [], endWait: () => false,
          claimLease: triggers.claimLease.bind(triggers), renewLease: triggers.renewLease.bind(triggers), releaseLease: triggers.releaseLease.bind(triggers),
          getTrigger: (id: string) => triggers.getById(id), recordTaskRun,
        }),
        getBulkLedger: () => ledger,
        getDataStore: () => null,
        getApiStore: () => apiStore,
        getSecretStore: () => ({ resolve: (k: string) => (k === 'SHOP_TOKEN' ? TOKEN : null) }),
        getToolContext: () => ({ ...createToolContext({}), vaultNameBindings: bindingsAsMigrated(apiStore) }),
        getAuditLog: () => null,
        getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
        getUserConfig: () => ({}),
      } as unknown as Engine;
      const loop = new WorkerLoop(engine, { hasChannels: () => false, notify: vi.fn() } as unknown as NotificationRouter, 60_000);
      await loop.tick();
      await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 10_000 });
      expect(recordTaskRun.mock.calls[0]![2]).toBe('success');
      expect(rowsOf(runId)[0]).toMatchObject({ write_connection_id: 'shop', write_grant_id: recorded });
    } finally {
      restore();
    }
  });

  // A run in flight at the upgrade to v43: its earlier half recorded nothing, which is unknown.
  it('a write first sent before v43 recorded anything leaves the write grant unknown, whatever the retry carried', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }, { target: url(1), after: { price: '20' } }], client({ connection: () => shopGrant('g1') }));
      // Target 0 was sent to by the earlier image, which recorded no connection; target 1 never.
      engineDb.getDb().prepare('UPDATE bulk_targets SET write_sent = 1 WHERE run_id = ? AND seq = 0').run(runId);
      ledger.markSent(runId, 0, shopGrant('g2'));
      ledger.markSent(runId, 1, shopGrant('g2'));
      expect(rowsOf(runId).map((r) => [r.write_connection_id, r.write_grant_id])).toEqual([['shop', null], ['shop', 'g2']]);
    } finally {
      restore();
    }
  });

  it('an undo of a target read before v43 and written after it leaves the read grant unknown', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      const c = client({ connection: () => shopGrant('g2') });
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }, { target: url(1), after: { price: '20' } }], c);
      // Target 0's preview ran on the earlier image: its read side was never recorded.
      engineDb.getDb().prepare('UPDATE bulk_targets SET read_connection_id = NULL, read_grant_id = NULL WHERE run_id = ? AND seq = 0').run(runId);
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: writerFor(c) });
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      // Newest first: target 1 (both sides g2), then target 0 (read unknown, write g2).
      expect(rowsOf(undo.status.id).map((r) => [r.read_connection_id, r.read_grant_id])).toEqual([['shop', 'g2'], ['shop', null]]);
    } finally {
      restore();
    }
  });

  it('an undo target is read under both sides of its source target, merged', async () => {
    const s = shop();
    const restore = serve(s);
    try {
      let grant = 'g1';
      const c = client({ connection: () => shopGrant(grant) });
      const runId = await approvedRun([{ target: url(0), after: { price: '15' } }, { target: url(1), after: { price: '20' } }], c);
      // Target 0 is written under the grant it was read under; target 1, after a re-consent, under g2.
      const writer = externalWriter(c, { sleep: noSleep });
      const switching = { ...writer, write: async (key: string, after: Parameters<typeof writer.write>[1], onSend?: () => void) => {
        if (key === url(1)) grant = 'g2';
        return writer.write(key, after, onSend);
      } };
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: (run) => bulkWriterFor(run, null, () => switching) });
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      // The undo plans target 1 first (newest first): its before-image is what g2 wrote, its after
      // what g1 read, so its read grant is unknown. Target 0 holds g1 on both sides.
      expect(rowsOf(undo.status.id).map((r) => [r.read_connection_id, r.read_grant_id, r.write_connection_id])).toEqual([
        ['shop', null, null], ['shop', 'g1', null],
      ]);
    } finally {
      restore();
    }
  });
});

