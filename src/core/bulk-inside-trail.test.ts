import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { DataStore } from './data-store.js';
import { BulkLedger, BULK_CLAIM_STALE_MS, BULK_HALT_REASONS, externalHostOf, type PlannedTarget } from './bulk-ledger.js';
import { runBulkEffect, type TargetWriter } from './bulk-apply.js';
import { namedTarget, newCorrelationId, type AuditEntry } from './audit-log.js';
import { TriggerStore } from './trigger-store.js';
import { WorkerLoop, bulkRunTrail } from './worker-loop.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { bulkPlanTool } from '../tools/builtin/bulk.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { IAgent, MemoryScopeRef } from '../types/index.js';
import { TEST_STAMP } from '../../tests/helpers/row-stamp.js';

// 660b: a bulk run inside the instance — files, or rows of the data store — that a delegated
// session planned writes the same pair a run outside does (PRD customer-granted-operator-access
// §3.9), naming the store, never a target. The owner's own run writes none.

vi.setConfig({ testTimeout: 30_000 });

const HELPER_TAG = 'mandate:helper@example.invalid';
const HELPER = { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'grant-1' };
const COLLECTION = 'secret_prices';
const scope: MemoryScopeRef = { type: 'context', id: 'bulk-inside-trail-test' };

let dir: string;
let ws: string;
let engineDb: EngineDb;
let ledger: BulkLedger;
let store: DataStore;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-inside-')));
  ws = join(dir, 'workspace');
  mkdirSync(ws);
  setTenantWorkspace(ws);
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
  store = new DataStore(join(dir, 'datastore.db'));
});

afterEach(() => {
  clearTenantWorkspace();
  engineDb.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function agent(): IAgent {
  return { toolContext: { bulkLedger: ledger, dataStore: store }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL } as unknown as IAgent;
}

function runIdOf(result: string): string {
  const m = /Bulk run ([0-9a-f-]{36})/.exec(result);
  if (!m) throw new Error(`no run id in: ${result}`);
  return m[1]!;
}

function approve(runId: string): void {
  const out = ledger.approve(runId, { checksum: ledger.computeChecksum(runId)! });
  if (!out.ok) throw new Error(`approve refused: ${out.reason}`);
}

/** The run as a delegated session's: the planner tag and grant the planning would have stamped. */
function plannedByHelper(runId: string): void {
  engineDb.getDb().prepare('UPDATE bulk_runs SET principal = ?, mandate_id = ? WHERE id = ?').run(HELPER_TAG, 'grant-1', runId);
}

async function planFiles(): Promise<string> {
  mkdirSync(join(ws, 'pages'));
  writeFileSync(join(ws, 'pages/a.md'), 'old a\n');
  writeFileSync(join(ws, 'src.json'), JSON.stringify([{ target: 'pages/a.md', after: 'new a\n' }, { target: 'pages/b.md', after: 'new b\n' }]));
  return runIdOf(await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'src.json' }, agent()));
}

async function planRows(): Promise<string> {
  store.createCollection({ name: COLLECTION, scope, uniqueKey: ['sku'], columns: [{ name: 'sku', type: 'string' }, { name: 'price', type: 'number' }] });
  store.insertRecords({ collection: COLLECTION, records: [{ sku: 'S1', price: 1 }, { sku: 'S2', price: 2 }], stamp: TEST_STAMP });
  writeFileSync(join(ws, 'prices.json'), JSON.stringify([{ target: 'S1', price: 10 }, { target: 'S2', price: 20 }]));
  return runIdOf(await bulkPlanTool.handler({ target_system: 'data_store', target_collection: COLLECTION, source_file: 'prices.json' }, agent()));
}

interface Recorded { rows: AuditEntry[]; getAuditLog: ReturnType<typeof vi.fn> }

/** One worker tick off the due bulk triggers, against a recording audit log. `failing` makes every row throw. */
async function tick(recorded: Recorded): Promise<void> {
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
    getToolContext: () => ({ containment: null }),
    getBulkLedger: () => ledger,
    getDataStore: () => store,
    getAuditLog: recorded.getAuditLog,
    getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
    getUserConfig: () => ({}),
    getEngineDb: () => null,
    getMandateEnds: () => null,
  } as unknown as Engine;
  const loop = new WorkerLoop(engine, { hasChannels: () => false, notify: vi.fn() } as unknown as NotificationRouter, 60_000);
  await loop.tick();
  await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 20_000 });
}

function recording(opts: { failing?: boolean; written?: () => number } = {}): Recorded & { writtenAtRecord: number[] } {
  const rows: AuditEntry[] = [];
  const writtenAtRecord: number[] = [];
  const log = {
    record: (e: AuditEntry) => {
      if (opts.failing) throw new Error('disk full');
      writtenAtRecord.push(opts.written?.() ?? -1);
      rows.push(e);
    },
  };
  return { rows, writtenAtRecord, getAuditLog: vi.fn(() => log) };
}

const filesWritten = (): number => ['pages/a.md', 'pages/b.md'].filter((f) => existsSync(join(ws, f)) && readFileSync(join(ws, f), 'utf-8').startsWith('new')).length;
const rowsWritten = (): number => store.queryRecords({ collection: COLLECTION, limit: 10 }).rows.filter((r) => (r['price'] as number) >= 10).length;

describe('a bulk run inside the instance that a delegated session planned', () => {
  it.each([
    ['workspace', 'files', planFiles, filesWritten],
    ['data_store', 'data_store', planRows, rowsWritten],
  ] as const)('on %s writes a row before its first write and one after, naming the store as %s', async (_system, storeName, plan, written) => {
    const runId = await plan();
    approve(runId);
    plannedByHelper(runId);
    const r = recording({ written });
    await tick(r);
    expect(ledger.getStatus(runId)).toMatchObject({ phase: 'done', applied: 2 });
    expect(r.rows.map((e) => [e.principal, e.action, e.target, e.phase, e.runId])).toEqual([
      [HELPER, 'bulk:apply', `store=${storeName} approved_by=owner`, 'attempt', runId],
      [HELPER, 'bulk:apply', `store=${storeName} approved_by=owner outcome=done written=2 failed=0`, 'done', runId],
    ]);
    expect(r.writtenAtRecord, 'the row before is written before any target, the row after once both are').toEqual([0, 2]);
    expect(new Set(r.rows.map((e) => e.correlationId)).size).toBe(1);
    // A call writes many targets: the row names none of them, and a collection's name is content.
    expect(JSON.stringify(r.rows)).not.toMatch(/secret_prices|pages\/|new a|S1/);
  });

  it.each([
    ['workspace', planFiles, filesWritten],
    ['data_store', planRows, rowsWritten],
  ] as const)('on %s writes nothing when its row before cannot be written, and halts saying so', async (_system, plan, written) => {
    const runId = await plan();
    approve(runId);
    plannedByHelper(runId);
    await tick(recording({ failing: true }));
    expect(written()).toBe(0);
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.runUnrecorded);
  });

  it('the owner\'s own run inside the instance writes no row, and the log is not even fetched', async () => {
    const runId = await planFiles();
    approve(runId);
    const r = recording();
    await tick(r);
    expect(ledger.getStatus(runId)).toMatchObject({ phase: 'done', applied: 2 });
    expect(r.rows).toEqual([]);
    expect(r.getAuditLog).not.toHaveBeenCalled();
  });

  it('the undo of such a run is the owner\'s, and writes no row', async () => {
    const runId = await planFiles();
    approve(runId);
    plannedByHelper(runId);
    const r = recording();
    await tick(r);
    expect(r.rows, 'control: the run itself wrote its pair').toHaveLength(2);
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    approve(undo.status.id);
    const u = recording();
    await tick(u);
    expect(ledger.getStatus(undo.status.id)).toMatchObject({ phase: 'done' });
    expect(readFileSync(join(ws, 'pages/a.md'), 'utf-8')).toBe('old a\n');
    expect(u.rows).toEqual([]);
  });
});

describe('an atomic run inside the instance whose row cannot be written in its second call', () => {
  /** In-memory targets, so a dead loop's claim can hold one of them over the first call. */
  function memory(initial: Record<string, string>): { writer: TargetWriter; state: Map<string, string> } {
    const state = new Map(Object.entries(initial));
    return {
      state,
      writer: {
        async read(key) { return state.has(key) ? { absent: false, value: state.get(key)! } : { absent: true }; },
        async write(key, after) {
          if (after.absent) state.delete(key); else state.set(key, after.value as string);
          return 'ok';
        },
      },
    };
  }

  it('halts half written, unrolled, writes nothing in that call, and a resume finishes it', async () => {
    const targets: PlannedTarget[] = [
      { key: 'k0', before: { absent: false, value: 'v0' }, after: 'w0' },
      { key: 'k1', before: { absent: false, value: 'v1' }, after: 'w1' },
    ];
    const runId = ledger.recordDryRun({ createdBy: 't', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'mem', targets, atomic: true }).id;
    approve(runId);
    plannedByHelper(runId);
    const { writer, state } = memory({ k0: 'v0', k1: 'v1' });
    const tools = { namedTarget, newCorrelationId, externalHostOf };
    const deps = (log: ReturnType<typeof recording>, now?: () => number) => ({
      ledger, writerFor: () => writer, trailFor: (run: Parameters<typeof bulkRunTrail>[0]) => bulkRunTrail(run, log.getAuditLog() as never, tools), ...(now ? { now } : {}),
    });

    // A dead loop holds k1: the first call writes k0 and leaves the run pending.
    expect(ledger.claimTarget(runId, 1)).toBe(true);
    const first = recording();
    expect((await runBulkEffect(runId, 'bulk_apply', deps(first))).status).toBe('pending');
    expect([...state]).toEqual([['k0', 'w0'], ['k1', 'v1']]);
    expect(first.rows.map((e) => e.phase)).toEqual(['attempt', 'returned']);

    // Its claim gone stale, the second call could write k1 — but its row cannot be written.
    const later = (): number => Date.now() + BULK_CLAIM_STALE_MS + 1_000;
    const second = await runBulkEffect(runId, 'bulk_apply', deps(recording({ failing: true }), later));
    expect(second.status).toBe('halted');
    expect([...state], 'nothing written in that call, and k0 is not rolled back').toEqual([['k0', 'w0'], ['k1', 'v1']]);
    expect(ledger.getStatus(runId)).toMatchObject({ phase: 'writing', haltReason: BULK_HALT_REASONS.runUnrecorded });

    // Once the log writes again, a resume finishes the run.
    expect(ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! }).ok).toBe(true);
    const third = recording();
    expect((await runBulkEffect(runId, 'bulk_apply', deps(third, later))).status).toBe('done');
    expect([...state]).toEqual([['k0', 'w0'], ['k1', 'w1']]);
    expect(third.rows.map((e) => [e.phase, e.target])).toEqual([
      ['attempt', 'store=files approved_by=owner'],
      ['done', 'store=files approved_by=owner outcome=done written=1 failed=0'],
    ]);
  });
});
