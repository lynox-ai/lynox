import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { EngineDb } from './engine-db.js';
import { DataStore } from './data-store.js';
import { BulkLedger, BULK_HALT_REASONS, BULK_JUDGED_RETENTION_MS, BULK_MAX_PREVIEWED_RUNS } from './bulk-ledger.js';
import { TriggerStore, bulkPreviewTriggerId } from './trigger-store.js';
import { bulkPlanTool } from '../tools/builtin/bulk.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { dataStoreColumns } from './bulk-plan.js';
import {
  BudgetError, CutOffError, ExtractShapeError, SchemaValueError, attachExtractionSpend, type callForStructuredJson,
} from './llm-helper.js';
import { runBulkJudge, judgeErrorForTracker, classifyCallFailure, JUDGE_CLAIM_STALE_MS, type BulkJudgeDeps } from './bulk-judge.js';
import type { IAgent, MemoryScopeRef } from '../types/index.js';

/**
 * The bulk judge (PRD bulk-loop §3.1 `bulk_judge`, 3.2): a model decides each target's new values
 * under the owner's rule, every answered call is booked, and nothing it reads leaves as text.
 */

const scope: MemoryScopeRef = { type: 'context', id: 'bulk-judge-test' };
const MARK = 'ZXQ-TARGET-CONTENT';
const RULE = { rule: 'Write a short title.', schema: { title: { type: 'string', maxLength: 40 } } };

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;
let store: DataStore;

function agent(): IAgent {
  return { toolContext: { bulkLedger: ledger, dataStore: store }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL } as unknown as IAgent;
}

function runIdOf(result: string): string {
  const m = /Bulk run ([0-9a-f-]{36})/.exec(result);
  if (!m) throw new Error(`no run id in: ${result}`);
  return m[1]!;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-judge-')));
  const ws = join(dir, 'workspace');
  mkdirSync(ws);
  setTenantWorkspace(ws);
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
  store = new DataStore(join(dir, 'datastore.db'));
  store.createCollection({
    name: 'products', scope, uniqueKey: ['sku'],
    columns: [{ name: 'sku', type: 'string' }, { name: 'title', type: 'string' }, { name: 'note', type: 'string' }],
  });
  store.insertRecords({
    collection: 'products',
    records: [
      { sku: 'A', title: 'old a', note: `${MARK}-a` },
      { sku: 'B', title: 'old b', note: `${MARK}-b` },
      { sku: 'C', title: 'old c', note: `${MARK}-c` },
    ],
  });
});

afterEach(() => {
  clearTenantWorkspace();
  engineDb.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function plan(skus: string[], judge: unknown = RULE): Promise<string> {
  const ws = join(dir, 'workspace');
  writeFileSync(join(ws, 'skus.csv'), ['target', ...skus].join('\n'));
  const out = await bulkPlanTool.handler(
    { target_system: 'data_store', target_collection: 'products', source_file: 'skus.csv', judge }, agent(),
  );
  return runIdOf(out);
}

function start(runId: string, cap = 1, supersedes?: string): ReturnType<BulkLedger['resumePreview']> {
  const hash = ledger.getJudgeRuleForOwner(runId)!.hash;
  return ledger.resumePreview(runId, Date.now(), { judgeRuleHash: hash, costCapUsd: cap, supersedes });
}

type Call = typeof callForStructuredJson;
interface Harness {
  deps: BulkJudgeDeps;
  calls: { user: string; system: string; maxRetries: number | undefined }[];
  reports: { runId: string; costUsd: number }[];
  booked: { runId: string; costUsd: number }[];
  captured: Error[];
}

/** Deps with a stub model call: `answer` decides per call what it returns or throws. */
function harness(answer: (user: string, n: number) => Promise<{ data: Record<string, unknown>; costUsd: number }> | { data: Record<string, unknown>; costUsd: number }, over: Partial<BulkJudgeDeps> = {}): Harness {
  const h: Harness = { calls: [], reports: [], booked: [], captured: [], deps: undefined as unknown as BulkJudgeDeps };
  let gates = 0;
  const call = (async (opts: Parameters<Call>[0]) => {
    h.calls.push({ user: opts.user, system: opts.system ?? '', maxRetries: (opts as { maxRetries?: number }).maxRetries });
    const r = await answer(opts.user, h.calls.length);
    return { data: r.data, inputTokens: 100, outputTokens: 10, costUsd: r.costUsd, modelId: 'claude-haiku-4-5' };
  }) as unknown as Call;
  h.deps = {
    ledger,
    resolveModel: (tier) => ({ tier, modelId: 'claude-haiku-4-5', client: {} as Anthropic }),
    gate: async () => ({ runId: `gate-${String(++gates)}`, blockedReason: null }),
    report: (runId, costUsd) => { h.reports.push({ runId, costUsd }); },
    bookSpend: (e) => { h.booked.push({ runId: e.runId, costUsd: e.costUsd }); },
    budgetAllows: () => true,
    scanSecret: (t) => (t.includes('sk-live-') ? 'api_key' : null),
    maskVault: (t) => t,
    columns: (c) => dataStoreColumns(store, c),
    captureError: (e) => { h.captured.push(e); },
    call,
    ...over,
  };
  return h;
}

const title = (user: string): string => {
  const m = /"title":"([^"]*)"/.exec(user);
  return `new ${m ? m[1]! : '?'}`;
};

describe('bulk_plan with judge — planned, waiting for the owner\'s start', () => {
  it('lands planned and halted awaitingStart with the template, and calls nothing', async () => {
    const id = await plan(['A', 'B']);
    const s = ledger.getStatus(id)!;
    expect(s.phase).toBe('planned');
    expect(s.haltReason).toBe(BULK_HALT_REASONS.awaitingStart);
    expect(s.judge).toEqual({ tier: 'fast', unjudged: 2 });
    // A target without its verdict shows no after-state and no changed fields.
    const p = ledger.getPreview(id);
    expect(p.map((t) => [t.after, t.changedFields])).toEqual([[null, null], [null, null]]);
  });

  it('refuses a workspace target and an atomic run', async () => {
    const ws = join(dir, 'workspace');
    writeFileSync(join(ws, 'f.csv'), 'target\na.md');
    expect(await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'f.csv', judge: RULE }, agent())).toMatch(/judge needs target_system/);
    expect(await bulkPlanTool.handler(
      { target_system: 'data_store', target_collection: 'products', source_file: 'f.csv', judge: RULE, atomic: true }, agent(),
    )).toMatch(/cannot be atomic/);
    expect(ledger.listRuns()).toEqual([]);
  });

  it('refuses a field that is not a column, and the key column', async () => {
    await expect(plan(['A'], { rule: 'x', schema: { price: { type: 'number' } } })).rejects.toThrow();
    await expect(plan(['A'], { rule: 'x', schema: { sku: { type: 'string', maxLength: 5 } } })).rejects.toThrow();
  });
});

describe('the start: rule hash, a limit in whole cents, supersedes', () => {
  it('refuses without the rule hash, a wrong hash, and a limit that is not whole cents', async () => {
    const id = await plan(['A']);
    expect(ledger.resumePreview(id, Date.now(), { costCapUsd: 1 })).toEqual({ ok: false, reason: 'checksum' });
    expect(ledger.resumePreview(id, Date.now(), { judgeRuleHash: 'nope', costCapUsd: 1 })).toEqual({ ok: false, reason: 'checksum' });
    const hash = ledger.getJudgeRuleForOwner(id)!.hash;
    for (const cap of [undefined, 0, -1, 0.005, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(ledger.resumePreview(id, Date.now(), { judgeRuleHash: hash, costCapUsd: cap })).toEqual({ ok: false, reason: 'cost_cap' });
    }
    const ok = ledger.resumePreview(id, Date.now(), { judgeRuleHash: hash, costCapUsd: 0.37 });
    expect(ok.ok).toBe(true);
    expect(new TriggerStore(engineDb).get(bulkPreviewTriggerId(id))?.effect).toBe('bulk_judge');
  });

  it('a second judged start names the first; with supersedes it ends it, keeping its spend, and drops its trigger', async () => {
    const first = await plan(['A']);
    expect(start(first).ok).toBe(true);
    ledger.addJudgeCost(first, 0.2);
    const second = await plan(['B']);
    expect(start(second)).toEqual({ ok: false, reason: 'supersede_required', supersedable: { id: first, costUsd: 0.2 } });
    // Nothing moved on the refusal.
    expect(ledger.getStatus(first)!.phase).toBe('planned');
    expect(start(second, 1, 'some-other-id')).toMatchObject({ ok: false, reason: 'supersede_required' });
    expect(start(second, 1, first).ok).toBe(true);
    const old = ledger.getStatus(first)!;
    expect([old.phase, old.haltReason, old.costUsd]).toEqual(['aborted', BULK_HALT_REASONS.superseded, 0.2]);
    expect(new TriggerStore(engineDb).get(bulkPreviewTriggerId(first))).toBeUndefined();
  });

  it('an unstarted judged run is not one a start must name', async () => {
    await plan(['A']);
    const second = await plan(['B']);
    expect(start(second).ok).toBe(true);
  });
});

describe('runBulkJudge over data-store rows', () => {
  it('judges every target, merges the verdict into the row without nulling another column, books every call', async () => {
    const id = await plan(['A', 'B']);
    expect(start(id).ok).toBe(true);
    const h = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }));
    const out = await runBulkJudge(id, h.deps);
    expect(out.status).toBe('done');
    // Counts only: nothing of a target in what the session reads.
    expect(out.summary).not.toContain(MARK);
    expect(out.summary).not.toContain('old a');
    const p = ledger.getPreview(id);
    expect(p.map((t) => t.after)).toEqual([
      { sku: 'A', title: 'new old a', note: `${MARK}-a` },
      { sku: 'B', title: 'new old b', note: `${MARK}-b` },
    ]);
    expect(p.map((t) => t.changedFields)).toEqual([1, 1]);
    // Only F went to the model: the note column never did.
    expect(h.calls.every((c) => !c.user.includes(MARK))).toBe(true);
    expect(h.calls.every((c) => c.maxRetries === 0)).toBe(true);
    // Booked into the run, to the control plane under each call's own gate id, and into the day.
    expect(ledger.getStatus(id)!.costUsd).toBeCloseTo(0.02, 12);
    expect(h.reports).toEqual([{ runId: 'gate-1', costUsd: 0.01 }, { runId: 'gate-2', costUsd: 0.01 }]);
    expect(h.booked).toHaveLength(2);
    // Previewed, and approvable with the checksum over the verdicts.
    const s = ledger.getStatus(id)!;
    expect(s.phase).toBe('previewed');
    const checksum = ledger.computeChecksum(id)!;
    expect(ledger.approve(id, { checksum, approvedBy: 'test' }).ok).toBe(true);
  });

  it('a row that is gone is invalid not_found, without a call', async () => {
    const id = await plan(['A', 'ZZ']);
    expect(start(id).ok).toBe(true);
    const h = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }));
    await runBulkJudge(id, h.deps);
    expect(h.calls).toHaveLength(1);
    expect(ledger.getStatus(id)!.invalidReasons).toMatchObject({ not_found: 1 });
  });

  it('a target holding a credential is not sent: invalid secret_in_before — by the scan and by the vault', async () => {
    store.insertRecords({ collection: 'products', records: [{ sku: 'S', title: 'key sk-live-abcdef', note: 'n' }, { sku: 'V', title: 'vaulted', note: 'n' }] });
    const id = await plan(['S', 'V', 'A']);
    expect(start(id).ok).toBe(true);
    const h = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }), {
      maskVault: (t) => t.replace('vaulted', '***'),
    });
    await runBulkJudge(id, h.deps);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.user).toContain('old a');
    expect(ledger.getStatus(id)!.invalidReasons).toMatchObject({ secret_in_before: 2 });
  });

  it('a verdict carrying a credential is invalid secret_in_after', async () => {
    const id = await plan(['A']);
    expect(start(id).ok).toBe(true);
    const h = harness(() => ({ data: { title: 'sk-live-zzzzzz' }, costUsd: 0.01 }));
    await runBulkJudge(id, h.deps);
    expect(ledger.getStatus(id)!.invalidReasons).toMatchObject({ secret_in_after: 1 });
    expect(ledger.getStatus(id)!.costUsd).toBeCloseTo(0.01, 12);
  });

  it('an answer that is no verdict makes the target invalid, and is booked all the same', async () => {
    const id = await plan(['A', 'B', 'C']);
    expect(start(id).ok).toBe(true);
    const errs = [new CutOffError(), new SchemaValueError(`value ${MARK} too long`, 'title', 'maxLength'), new ExtractShapeError('no tool call')];
    const h = harness((_u, n) => {
      const e = errs[n - 1]!;
      attachExtractionSpend(e, { costUsd: 0.03, tier: 'fast' });
      throw e;
    });
    const out = await runBulkJudge(id, h.deps);
    expect(out.status).toBe('done');
    expect(ledger.getStatus(id)!.invalidReasons).toEqual({ cut_off: 1, verdict_invalid: 2 });
    expect(ledger.getStatus(id)!.costUsd).toBeCloseTo(0.09, 12);
    expect(h.reports).toHaveLength(3);
    expect(h.booked).toHaveLength(3);
    // A run with nothing valid left closes with nothing to write.
    expect(ledger.getStatus(id)!.phase).toBe('previewed');
  });

  it('a provider 429 or 5xx waits; the target keeps no verdict and is tried again', async () => {
    const id = await plan(['A']);
    expect(start(id).ok).toBe(true);
    for (const status of [429, 529, 503]) {
      const h = harness(() => { throw Object.assign(new Error(`provider said ${MARK}`), { status }); });
      const out = await runBulkJudge(id, h.deps);
      expect(out.status).toBe('pending');
      expect(ledger.getStatus(id)!.judge!.unjudged).toBe(1);
      expect(ledger.getStatus(id)!.haltReason).toBeNull();
    }
    const ok = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }));
    expect((await runBulkJudge(id, ok.deps)).status).toBe('done');
  });

  it('any other failure halts the run, never invalid, and reports only the class', async () => {
    const id = await plan(['A']);
    expect(start(id).ok).toBe(true);
    const h = harness(() => { throw Object.assign(new Error(`OpenAI-compatible API error 400: echoed ${MARK}`), {}); });
    const out = await runBulkJudge(id, h.deps);
    expect(out.status).toBe('halted');
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.unavailable);
    expect(ledger.getStatus(id)!.judge!.unjudged).toBe(1);
    expect(ledger.getStatus(id)!.changes.invalid).toBe(0);
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]!.message).toBe('bulk_judge call failed: Error (HTTP 400)');
    expect(out.summary).not.toContain(MARK);
  });

  it('stops before the call that could pass the run\'s limit — no gate, no call', async () => {
    const id = await plan(['A', 'B']);
    expect(start(id, 0.01).ok).toBe(true);
    let gates = 0;
    const h = harness((user) => ({ data: { title: title(user) }, costUsd: 0.009 }), {
      gate: async () => { gates++; return { runId: `g${String(gates)}`, blockedReason: null }; },
    });
    const out = await runBulkJudge(id, h.deps);
    expect(out.status).toBe('halted');
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.costCap);
    expect(gates).toBe(h.calls.length);
    expect(ledger.getStatus(id)!.costUsd).toBeLessThanOrEqual(0.01);
  });

  it('the daily limit and a refused gate halt with fixed reasons, before the call', async () => {
    const a = await plan(['A']);
    expect(start(a).ok).toBe(true);
    const day = harness(() => ({ data: { title: 'x' }, costUsd: 0.01 }), { budgetAllows: () => false });
    await runBulkJudge(a, day.deps);
    expect([ledger.getStatus(a)!.haltReason, day.calls.length]).toEqual([BULK_HALT_REASONS.spendLimit, 0]);

    const b = await plan(['B']);
    expect(start(b, 1, a).ok).toBe(true);
    const credit = harness(() => ({ data: { title: 'x' }, costUsd: 0.01 }), {
      gate: async () => ({ runId: 'g', blockedReason: 'Your credit is used up.' }),
    });
    await runBulkJudge(b, credit.deps);
    expect([ledger.getStatus(b)!.haltReason, credit.calls.length]).toEqual([BULK_HALT_REASONS.creditRefused, 0]);
  });

  it('no allowed model halts judgeModel', async () => {
    const id = await plan(['A']);
    expect(start(id).ok).toBe(true);
    const h = harness(() => ({ data: { title: 'x' }, costUsd: 0.01 }), { resolveModel: () => null });
    await runBulkJudge(id, h.deps);
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.judgeModel);
  });

  it('refuses a run that was not started', async () => {
    const id = await plan(['A']);
    const h = harness(() => ({ data: { title: 'x' }, costUsd: 0.01 }));
    const out = await runBulkJudge(id, h.deps);
    expect(out.status).not.toBe('done');
    expect(h.calls).toHaveLength(0);
  });
});

describe('two loops over one run (a lost lease)', () => {
  it('pays each target at most once while the claims are live', async () => {
    const id = await plan(['A', 'B', 'C']);
    expect(start(id).ok).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const shared = { calls: 0 };
    const answer = async (user: string): Promise<{ data: Record<string, unknown>; costUsd: number }> => {
      shared.calls++;
      await gate;
      return { data: { title: title(user) }, costUsd: 0.01 };
    };
    const one = harness(answer);
    const two = harness(answer);
    const both = Promise.all([runBulkJudge(id, one.deps), runBulkJudge(id, two.deps)]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await both;
    expect(shared.calls).toBe(3);
    expect(ledger.getStatus(id)!.phase).toBe('previewed');
  });

  it('the loser of an expired claim does not overwrite the winner\'s verdict', async () => {
    const id = await plan(['A']);
    expect(start(id).ok).toBe(true);
    const [seq] = ledger.listUnjudged(id);
    const t0 = Date.now();
    expect(ledger.claimJudge(id, seq!, 'old', t0, JUDGE_CLAIM_STALE_MS)).toBe(true);
    expect(ledger.claimJudge(id, seq!, 'new', t0 + 1, JUDGE_CLAIM_STALE_MS)).toBe(false);
    expect(ledger.claimJudge(id, seq!, 'new', t0 + JUDGE_CLAIM_STALE_MS + 1, JUDGE_CLAIM_STALE_MS)).toBe(true);
    // The loser's call answers first: its token no longer holds, so it records nothing.
    expect(ledger.recordJudgement(id, seq!, 'old', { after: { sku: 'A', title: 'loser', note: null } })).toBe(false);
    expect(ledger.recordJudgement(id, seq!, 'new', { after: { sku: 'A', title: 'winner', note: null } })).toBe(true);
    expect((ledger.getPreview(id)[0]!.after as { title: string }).title).toBe('winner');
  });
});

describe('keeping and ending judged runs', () => {
  it('a started judged run is kept from the prune; a superseded one joins it', async () => {
    const kept = await plan(['A']);
    expect(start(kept).ok).toBe(true);
    for (let i = 0; i < BULK_MAX_PREVIEWED_RUNS + 2; i++) await plan(['B']);
    expect(ledger.getStatus(kept)).not.toBeNull();
    const next = await plan(['C']);
    expect(start(next, 1, kept).ok).toBe(true);
    for (let i = 0; i < BULK_MAX_PREVIEWED_RUNS + 2; i++) await plan(['B']);
    expect(ledger.getStatus(kept)).toBeNull();
  });

  it('the retention sweep ends a started judged run 30 days after its start, with its trigger', async () => {
    const id = await plan(['A']);
    const started = Date.now() - BULK_JUDGED_RETENTION_MS - 60_000;
    const hash = ledger.getJudgeRuleForOwner(id)!.hash;
    expect(ledger.resumePreview(id, started, { judgeRuleHash: hash, costCapUsd: 1 }).ok).toBe(true);
    const fresh = await plan(['B']);
    expect(start(fresh, 1, id).ok).toBe(true);
    // The superseded one is aborted, not swept; the fresh one is inside its 30 days.
    expect(ledger.expireStaleJudgedRuns()).toBe(0);
    const old = await plan(['C']);
    expect(ledger.resumePreview(old, started, { judgeRuleHash: ledger.getJudgeRuleForOwner(old)!.hash, costCapUsd: 1, supersedes: fresh }).ok).toBe(true);
    expect(ledger.expireStaleJudgedRuns()).toBe(1);
    expect(ledger.getStatus(old)).toBeNull();
    expect(new TriggerStore(engineDb).get(bulkPreviewTriggerId(old))).toBeUndefined();
  });
});

describe('what leaves as an error', () => {
  it('the tracker gets class, status and schema path — never a value or a message', () => {
    expect(judgeErrorForTracker(new SchemaValueError(`value "${MARK}" too long`, 'title', 'maxLength')).message)
      .toBe('bulk_judge call failed: SchemaValueError at title');
    expect(judgeErrorForTracker(Object.assign(new Error(MARK), { status: 401 })).message).toBe('bulk_judge call failed: Error (HTTP 401)');
    expect(judgeErrorForTracker(new Error(MARK), 'bulk_apply').message).toBe('bulk_apply failed: Error');
  });

  it('classifies: only a non-verdict answer is invalid', () => {
    expect(classifyCallFailure(new CutOffError(), false)).toEqual({ kind: 'invalid', reason: 'cut_off' });
    expect(classifyCallFailure(new BudgetError('big', { estimatedInputTokens: 1, estimatedCostUsd: 1 }), false)).toEqual({ kind: 'invalid', reason: 'target_too_large' });
    expect(classifyCallFailure(new Error('timeout'), true)).toEqual({ kind: 'wait' });
    expect(classifyCallFailure(Object.assign(new Error('x'), { status: 500 }), false)).toEqual({ kind: 'wait' });
    expect(classifyCallFailure(new Error('ECONNRESET'), false)).toMatchObject({ kind: 'halt' });
  });
});
