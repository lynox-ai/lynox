import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { EngineDb } from './engine-db.js';
import { DataStore } from './data-store.js';
import { BulkLedger, BULK_HALT_REASONS } from './bulk-ledger.js';
import { normalizeJudgeRule, judgeTemplate } from './bulk-judge-rule.js';
import { WorkerLoop } from './worker-loop.js';
import type { Engine } from './engine.js';
import type { TaskManager } from './task-manager.js';
import type { NotificationRouter } from './notification-router.js';
import type { TriggerRecord, MemoryScopeRef } from '../types/index.js';

/**
 * PRD bulk-loop §6(a), error channel: a provider that refuses with a target's
 * text in its error — a schema refusal carrying the value, a 400 echoing the body — reaches
 * neither the run result, nor the notification, nor the error tracker. Through the real worker
 * dispatch and `executeBulkJudge`; only the model's client and the tracker are stand-ins.
 */

const captured = vi.hoisted(() => [] as Error[]);
vi.mock('./error-reporting.js', async (orig) => ({
  ...(await orig<typeof import('./error-reporting.js')>()),
  captureError: (err: unknown) => { captured.push(err as Error); },
}));
const model = vi.hoisted(() => ({ create: (async () => { throw new Error('unset'); }) as (...a: unknown[]) => Promise<unknown> }));
vi.mock('./bulk-judge.js', async (orig) => {
  const real = await orig<typeof import('./bulk-judge.js')>();
  return {
    ...real,
    resolveJudgeModel: (_uc: unknown, tier: 'fast') => ({
      tier, modelId: 'claude-haiku-4-5',
      client: { messages: { create: (...a: unknown[]) => model.create(...a) } } as unknown as Anthropic,
    }),
  };
});

const MARK = 'ZXQ-TARGET-CONTENT-7f3a';
const scope: MemoryScopeRef = { type: 'context', id: 'judge-worker' };

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;
let store: DataStore;

beforeEach(() => {
  captured.length = 0;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-judge-worker-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
  store = new DataStore(join(dir, 'datastore.db'));
  store.createCollection({ name: 'products', scope, uniqueKey: ['sku'], columns: [{ name: 'sku', type: 'string' }, { name: 'title', type: 'string' }] });
  store.insertRecords({ collection: 'products', records: [{ sku: 'A', title: `${MARK}-title` }] });
});
afterEach(() => {
  vi.restoreAllMocks();
  engineDb.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function startedRun(): string {
  const rule = normalizeJudgeRule({ rule: 'Write a short title.', schema: { title: { type: 'string', maxLength: 40 } } });
  const id = ledger.recordDryRun({
    createdBy: 't', principal: OWNER_PRINCIPAL, targetSystem: 'data_store', scope: 'products', targetCollection: 'products',
    targets: [{ key: 'A', before: { absent: false, value: { sku: 'A', title: `${MARK}-title` } }, after: judgeTemplate(rule) }],
    judge: rule,
  }).id;
  const out = ledger.resumePreview(id, Date.now(), { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash, costCapUsd: 1 });
  if (!out.ok) throw new Error('not started');
  return id;
}

async function tick(runId: string, hooks: unknown[] = []): Promise<{ records: string[]; notes: string[] }> {
  const records: string[] = [];
  const notes: string[] = [];
  const task = {
    id: 'trg-judge', title: 'Judge', description: '', status: 'open', assignee: 'lynox', scope_type: 'context', scope_id: '',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', next_run_at: '2026-01-01T09:00:00.000Z',
    source: 'cron', effect: 'bulk_judge', confirmed_at: '2026-01-01T00:00:00.000Z', bulk_run_id: runId,
  } as unknown as TriggerRecord;
  let due = true;
  const manager = {
    getDueTriggers: () => (due ? (due = false, [task]) : []),
    getExpiredWaitingTriggers: () => [],
    endWait: () => false,
    claimLease: () => 'claimed',
    renewLease: () => true,
    releaseLease: () => { /* none */ },
    getTrigger: () => task,
    recordTaskRun: (_id: string, result: string) => { records.push(result); },
    setEnabled: () => true,
  } as unknown as TaskManager;
  vi.spyOn(WorkerLoop.prototype as unknown as { bulkClientFactory: () => Promise<unknown> }, 'bulkClientFactory')
    .mockImplementation(async () => () => null);
  const engine = {
    getTaskManager: () => manager,
    getRunHistory: () => ({ getTrigger: () => task, updateTrigger: () => { /* none */ }, recordBulkJudgeCost: () => { /* none */ } }),
    getUserConfig: () => ({}),
    workerRunModelOverride: () => ({}),
    escalateToUser: () => null,
    getPromptStore: () => null,
    getSecretStore: () => null,
    getDataStore: () => store,
    getApiStore: () => null,
    getToolContext: () => ({ containment: null }),
    getBackupManager: () => null,
    getBulkLedger: () => ledger,
    getHooks: () => hooks,
    getContext: () => null,
    client: {},
  } as unknown as Engine;
  const router = {
    hasChannels: () => true,
    notify: async (n: { title: string; body: string }) => { notes.push(`${n.title}\n${n.body}`); },
  } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000);
  try {
    await loop.tick();
    // The tick starts the run and returns; the run records itself when it ends.
    await vi.waitFor(() => { if (records.length === 0) throw new Error('not yet'); }, { timeout: 5_000, interval: 10 });
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    loop.stop();
  }
  return { records, notes };
}

describe('bulk_judge through the worker: what leaves as an error', () => {
  it('a schema refusal carrying the target\'s text: the target is invalid, and the text is nowhere', async () => {
    model.create = async () => ({
      id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'tool_use', stop_sequence: null,
      content: [{ type: 'tool_use', id: 't', name: 'extract', input: { title: `${MARK} ${'x'.repeat(60)}` } }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const id = startedRun();
    const { records, notes } = await tick(id);
    expect(ledger.getStatus(id)!.invalidReasons).toEqual({ verdict_invalid: 1 });
    expect(records.length).toBeGreaterThan(0);
    // Positive control: the mark is in the ledger, decrypted — the run really read it.
    expect(JSON.stringify(ledger.getPreview(id))).toContain(MARK);
    for (const text of [...records, ...notes, ...captured.map((e) => `${e.name} ${e.message} ${String(e.stack)}`)]) {
      expect(text).not.toContain(MARK);
    }
  });

  it('a 400 echoing the request: the run halts, the target keeps no verdict, the tracker gets only class and status', async () => {
    model.create = async () => { throw Object.assign(new Error(`400 invalid_request: echoed ${MARK}`), { status: 400 }); };
    const id = startedRun();
    const { records, notes } = await tick(id);
    const s = ledger.getStatus(id)!;
    expect([s.haltReason, s.changes.invalid, s.judge!.unjudged]).toEqual([BULK_HALT_REASONS.unavailable, 0, 1]);
    await vi.waitFor(() => { if (captured.length === 0) throw new Error('not yet'); }, { timeout: 2_000, interval: 10 });
    expect(captured.map((e) => e.message)).toEqual(['bulk_judge call failed: Error (HTTP 400)']);
    for (const text of [...records, ...notes, ...captured.map((e) => `${e.message} ${String(e.stack)}`)]) {
      expect(text).not.toContain(MARK);
    }
  });

  it('a ledger that throws inside the judge: the run halts, and only the class is reported', async () => {
    model.create = async () => ({});
    const id = startedRun();
    vi.spyOn(ledger, 'claimJudge').mockImplementation(() => { throw new Error(`SQLITE_CORRUPT near ${MARK}`); });
    const { records, notes } = await tick(id);
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.unavailable);
    await vi.waitFor(() => { if (captured.length === 0) throw new Error('not yet'); }, { timeout: 2_000, interval: 10 });
    expect(captured.map((e) => e.message)).toEqual(['bulk_judge call failed: Error']);
    for (const text of [...records, ...notes]) expect(text).not.toContain(MARK);
  });

  it('a throw before the judge begins: the run halts the same way, and only the class is reported', async () => {
    model.create = async () => ({});
    const id = startedRun();
    vi.spyOn(ledger, 'getRunForPreview').mockImplementation(() => { throw new Error(`SQLITE_CORRUPT near ${MARK}`); });
    const { records, notes } = await tick(id);
    // The handler's own sentence: the throw reached its catch, not the loop's.
    expect(records).toEqual([`Bulk judge halted: ${BULK_HALT_REASONS.unavailable}.`]);
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.unavailable);
    await vi.waitFor(() => { if (captured.length === 0) throw new Error('not yet'); }, { timeout: 2_000, interval: 10 });
    expect(captured.map((e) => e.message)).toEqual(['bulk_judge call failed: Error']);
    for (const text of [...records, ...notes]) expect(text).not.toContain(MARK);
  });

  it('a halt that throws in the catch still lets the class reach the tracker', async () => {
    model.create = async () => ({});
    const id = startedRun();
    vi.spyOn(ledger, 'getRunForPreview').mockImplementation(() => { throw new Error(`SQLITE_CORRUPT near ${MARK}`); });
    vi.spyOn(ledger, 'haltPreview').mockImplementation(() => { throw new Error('SQLITE_BUSY'); });
    await tick(id);
    await vi.waitFor(() => { if (captured.length === 0) throw new Error('not yet'); }, { timeout: 2_000, interval: 10 });
    expect(captured.map((e) => e.message)).toContain('bulk_judge call failed: Error');
  });
});

describe('bulk_judge through the worker: run group', () => {
  it('an execution reports its spend in a group of its own, not in the bulk run\'s id', async () => {
    // A bulk run can be re-armed and started again over days; each execution is one run
    // group, so the cap per group never spans executions.
    model.create = async () => ({
      id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'tool_use', stop_sequence: null,
      content: [{ type: 'tool_use', id: 't', name: 'extract', input: { title: 'Short title' } }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const onAfterRun = vi.fn();
    const id = startedRun();
    await tick(id, [{ onAfterRun, onBeforeRun: vi.fn() }]);
    expect(onAfterRun, 'positive control: the judge reported spend').toHaveBeenCalled();
    const groups = onAfterRun.mock.calls.map((c) => (c[2] as { runGroupId?: string }).runGroupId);
    // The format the control plane accepts for a group; any other form is dropped there and
    // every report becomes its own group.
    expect(groups.every((g) => typeof g === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(g))).toBe(true);
    expect(new Set(groups).size).toBe(1);
    expect(groups[0]).not.toBe(id);
  });
});
