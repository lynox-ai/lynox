import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { EngineDb } from './engine-db.js';
import { DataStore } from './data-store.js';
import { BulkLedger, BULK_HALT_REASONS, BULK_JUDGED_RETENTION_MS, BULK_MAX_PREVIEWED_RUNS } from './bulk-ledger.js';
import { TriggerStore, bulkPreviewTriggerId } from './trigger-store.js';
import { bulkPlanTool, bulkStatusTool } from '../tools/builtin/bulk.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { dataStoreColumns } from './bulk-plan.js';
import { judgeMaxOutputTokens, judgeTemplate, normalizeJudgeRule } from './bulk-judge-rule.js';
import {
  BudgetError, CutOffError, ExtractShapeError, SchemaValueError, attachExtractionSpend, type callForStructuredJson,
} from './llm-helper.js';
import { JUDGE_MODELS, runBulkJudge, judgeErrorForTracker, classifyCallFailure, judgeWorstCaseUsd, JUDGE_CLAIM_STALE_MS, JUDGE_TOOL_OVERHEAD_TOKENS, type BulkJudgeDeps } from './bulk-judge.js';
import { getPricing } from './pricing.js';
import { modelCapability, type IAgent, type MemoryScopeRef } from '../types/index.js';
import { createManagedHook } from './managed-hook.js';
import { fireBeforeRunGate, reportMeteredCost } from './metered-request.js';
import type { LynoxHooks } from './engine.js';
import { TEST_STAMP } from '../../tests/helpers/row-stamp.js';

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
    stamp: TEST_STAMP,
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
  calls: { user: string; system: string; maxRetries: number | undefined; model: string; maxOutputTokens: number | undefined }[];
  reports: { runId: string; costUsd: number }[];
  booked: { runId: string; costUsd: number; tokensIn: number; tokensOut: number }[];
  captured: Error[];
}

/** Deps with a stub model call: `answer` decides per call what it returns or throws. */
function harness(answer: (user: string, n: number) => Promise<{ data: Record<string, unknown>; costUsd: number }> | { data: Record<string, unknown>; costUsd: number }, over: Partial<BulkJudgeDeps> = {}): Harness {
  const h: Harness = { calls: [], reports: [], booked: [], captured: [], deps: undefined as unknown as BulkJudgeDeps };
  let gates = 0;
  const call = (async (opts: Parameters<Call>[0]) => {
    h.calls.push({
      user: opts.user, system: opts.system ?? '', maxRetries: (opts as { maxRetries?: number }).maxRetries,
      model: opts.model, maxOutputTokens: opts.maxOutputTokens,
    });
    const r = await answer(opts.user, h.calls.length);
    return { data: r.data, inputTokens: 100, outputTokens: 10, costUsd: r.costUsd, modelId: 'claude-haiku-4-5' };
  }) as unknown as Call;
  h.deps = {
    ledger,
    resolveModel: (tier) => ({ tier, modelId: 'claude-haiku-4-5', client: {} as Anthropic }),
    gate: async () => ({ runId: `gate-${String(++gates)}`, blockedReason: null }),
    report: (runId, costUsd) => { h.reports.push({ runId, costUsd }); },
    bookSpend: (e) => { h.booked.push({ runId: e.runId, costUsd: e.costUsd, tokensIn: e.tokensIn, tokensOut: e.tokensOut }); },
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

  it('refuses a rule with a character the owner does not see, and plans none', async () => {
    writeFileSync(join(dir, 'workspace', 'skus.csv'), 'target\nA');
    const planRule = (rule: string): Promise<string> => bulkPlanTool.handler(
      { target_system: 'data_store', target_collection: 'products', source_file: 'skus.csv', judge: { ...RULE, rule } }, agent(),
    );
    for (const cp of [0xe0041, 0x202e, 0x200b]) {
      expect(await planRule(`Write a short title.${String.fromCodePoint(cp)}`)).toMatch(/judge\.rule holds a character a reader does not see/);
    }
    expect(ledger.listRuns()).toEqual([]);
    // Twin: a rule with a ZWNJ inside a Persian word and an RLM after a Hebrew word, where real
    // text puts them, is planned.
    const persian = String.fromCodePoint(0x0645, 0x06cc, 0x200c, 0x0631, 0x0648, 0x0645);
    const hebrew = String.fromCodePoint(0x05e9, 0x05dc, 0x05d5, 0x05dd, 0x200f);
    expect(await planRule(`Write a short title. ${persian} ${hebrew} end`)).toMatch(/Bulk run [0-9a-f-]{36}/);
  });

  it('refuses a field type its column cannot take, before any call is paid', async () => {
    store.createCollection({
      name: 'stock', scope, uniqueKey: ['sku'],
      columns: [{ name: 'sku', type: 'string' }, { name: 'qty', type: 'number' }, { name: 'live', type: 'boolean' }],
    });
    store.insertRecords({ collection: 'stock', records: [{ sku: 'A', qty: 1, live: true }], stamp: TEST_STAMP });
    writeFileSync(join(dir, 'workspace', 's.csv'), 'target\nA');
    const planStock = (schema: Record<string, unknown>): Promise<string> => bulkPlanTool.handler(
      { target_system: 'data_store', target_collection: 'stock', source_file: 's.csv', judge: { rule: 'x', schema } }, agent(),
    );
    expect(await planStock({ qty: { type: 'string', maxLength: 5 } })).toMatch(/qty the type string, which its number column does not take/);
    expect(await planStock({ live: { type: 'number' } })).toMatch(/which its boolean column does not take/);
    expect(ledger.listRuns()).toEqual([]);
    // Twin: the types the columns take are planned.
    expect(await planStock({ qty: { type: 'integer' }, live: { type: 'boolean' } })).toMatch(/Bulk run [0-9a-f-]{36}/);
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

  it('refuses a run whose stored rule planning would refuse today, even with its own hash, and arms nothing', async () => {
    // A run planned before planning refused hidden characters: its rule and hash are stored as
    // planning stored them then, so the hash the owner presents still matches.
    const legacy = async (rule: string): Promise<string> => {
      const id = await plan(['A']);
      const [stored, hash] = (ledger as unknown as { judgeColumns(j: unknown): [string, string] })
        .judgeColumns({ ...normalizeJudgeRule(RULE), rule });
      engineDb.getDb().prepare('UPDATE bulk_runs SET judge_rule = ?, judge_rule_hash = ? WHERE id = ?').run(stored, hash, id);
      return id;
    };
    const hidden = await legacy(`Write a short title.${String.fromCodePoint(0xe0041)}`);
    const out = start(hidden);
    expect(out).toMatchObject({ ok: false, reason: 'rule_refused' });
    expect((out as { message: string }).message).toMatch(/judge\.rule holds a character a reader does not see/);
    expect(new TriggerStore(engineDb).get(bulkPreviewTriggerId(hidden))).toBeUndefined();
    expect(ledger.getStatus(hidden)!.haltReason).toBe(BULK_HALT_REASONS.awaitingStart);
    // Twin: a run stored the same way with a rule planning takes starts.
    expect(start(await legacy('Write a short title, plainly.')).ok).toBe(true);
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
    // What the session's model reads about the run: counts, never a verdict or a value.
    const status = await bulkStatusTool.handler({ run_id: id }, agent());
    expect(status).toContain('without a verdict yet');
    expect(status).toContain('Model spend: $0.02 of a $1.00 limit.');
    for (const v of [MARK, 'new old a', 'old a']) expect(status).not.toContain(v);
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

  it('calls the resolved judge model, with a budget a thinking-only model answers within', async () => {
    const id = await plan(['A'], { rule: 'Pick a label.', schema: { title: { type: 'string', enum: ['short', 'long'] } } });
    expect(start(id).ok).toBe(true);
    const fireworks = JUDGE_MODELS.fireworks;
    const h = harness(() => ({ data: { title: 'short' }, costUsd: 0.01 }), {
      resolveModel: (tier) => ({ tier, modelId: fireworks, client: {} as Anthropic }),
    });
    await runBulkJudge(id, h.deps);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.model).toBe(fireworks);
    // The small schema's own bound is inside the model's silent region; the call is above it.
    expect(judgeMaxOutputTokens(ledger.getJudgeRuleForOwner(id)!.schema))
      .toBeLessThanOrEqual(modelCapability(fireworks)!.thinkingOnly!.emptyAtOrBelow);
    expect(h.calls[0]!.maxOutputTokens).toBeGreaterThan(modelCapability(fireworks)!.thinkingOnly!.emptyAtOrBelow);
    expect(ledger.getStatus(id)!.phase).toBe('previewed');
  });

  it('a row that is gone is invalid not_found, without a call', async () => {
    const id = await plan(['A', 'ZZ']);
    expect(start(id).ok).toBe(true);
    const h = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }));
    await runBulkJudge(id, h.deps);
    expect(h.calls).toHaveLength(1);
    expect(ledger.getStatus(id)!.invalidReasons).toMatchObject({ not_found: 1 });
  });

  it('a target read as absent (an external read that found nothing) is invalid not_found, without a call', async () => {
    const id = await plan(['A', 'B']);
    expect(start(id).ok).toBe(true);
    // Test seam: the state an external preview leaves for a target its host no longer has. A
    // data-store plan refuses a missing row already at plan time, so only the read reaches this.
    const db = engineDb.getDb();
    db.prepare('UPDATE bulk_targets SET before = ? WHERE run_id = ? AND seq = (SELECT MIN(seq) FROM bulk_targets WHERE run_id = ?)')
      .run(engineDb.enc(JSON.stringify({ absent: true })), id, id);
    const h = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }));
    await runBulkJudge(id, h.deps);
    expect(h.calls).toHaveLength(1);
    expect(ledger.getStatus(id)!.invalidReasons).toMatchObject({ not_found: 1 });
  });

  it('a target holding a credential is not sent: invalid secret_in_before — by the scan and by the vault', async () => {
    store.insertRecords({ collection: 'products', records: [
      { sku: 'S', title: 'key sk-live-abcdef', note: 'n' },
      { sku: 'V', title: 'vaulted', note: 'n' },
      // A vault value with a quote: escaped in the JSON, so only the value itself matches.
      { sku: 'Q', title: 'pa"ss', note: 'n' },
    ], stamp: TEST_STAMP });
    const id = await plan(['S', 'V', 'Q', 'A']);
    expect(start(id).ok).toBe(true);
    const h = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }), {
      maskVault: (t) => t.replace('vaulted', '***').replace('pa"ss', '***'),
    });
    await runBulkJudge(id, h.deps);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.user).toContain('old a');
    expect(ledger.getStatus(id)!.invalidReasons).toMatchObject({ secret_in_before: 3 });
  });

  it('a vault value inside a JSON column is found at any depth, a key included', async () => {
    store.createCollection({
      name: 'docs', scope, uniqueKey: ['sku'], columns: [{ name: 'sku', type: 'string' }, { name: 'meta', type: 'json' }],
    });
    store.insertRecords({ collection: 'docs', records: [
      { sku: 'N', meta: { a: [{ b: 'pa"ss' }] } },
      { sku: 'K', meta: { 'pa"ss': 1 } },
      { sku: 'C', meta: { a: [{ b: 'clean' }] } },
      // Column text that is a bare JSON string, or JSON behind a byte-order mark.
      { sku: 'S', meta: JSON.stringify('pa"ss') },
      { sku: 'B', meta: `\uFEFF${JSON.stringify({ a: 'pa"ss' })}` },
      // Nested past the depth the check follows: refused unread, and the run goes on.
      { sku: 'D', meta: '['.repeat(100) + ']'.repeat(100) },
    ], stamp: TEST_STAMP });
    writeFileSync(join(dir, 'workspace', 'd.csv'), 'target\nN\nK\nC\nS\nB\nD');
    const id = runIdOf(await bulkPlanTool.handler(
      { target_system: 'data_store', target_collection: 'docs', source_file: 'd.csv', judge: { rule: 'x', schema: { meta: { type: 'string', maxLength: 20 } } } }, agent(),
    ));
    expect(start(id).ok).toBe(true);
    const h = harness(() => ({ data: { meta: 'ok' }, costUsd: 0.01 }), { maskVault: (t) => t.replace('pa"ss', '***') });
    await runBulkJudge(id, h.deps);
    // Twin: the clean row is sent; the five holding the value, or too deep to tell, are not.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.user).toContain('clean');
    expect(ledger.getStatus(id)!.invalidReasons).toMatchObject({ secret_in_before: 5 });
    expect(ledger.getStatus(id)!.haltReason).toBeNull();
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
      attachExtractionSpend(e, { costUsd: 0.03, tier: 'fast', inputTokens: 700, outputTokens: 30 });
      throw e;
    });
    const out = await runBulkJudge(id, h.deps);
    expect(out.status).toBe('done');
    expect(ledger.getStatus(id)!.invalidReasons).toEqual({ cut_off: 1, verdict_invalid: 2 });
    expect(ledger.getStatus(id)!.costUsd).toBeCloseTo(0.09, 12);
    expect(h.reports).toHaveLength(3);
    // Booked with the reply's tokens, not as a call that read and wrote nothing.
    expect(h.booked.map((b) => [b.tokensIn, b.tokensOut])).toEqual([[700, 30], [700, 30], [700, 30]]);
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

  it('counts a failed extraction against the run\'s limit: it stops on the booked spend of answers that were no verdict', async () => {
    const id = await plan(['A', 'B', 'C']);
    // A limit in whole cents: room for two failed answers at 0.03 each, none for a further call.
    expect(start(id, 0.06).ok).toBe(true);
    const h = harness(() => {
      const e = new ExtractShapeError('no tool call');
      attachExtractionSpend(e, { costUsd: 0.03, tier: 'fast', inputTokens: 700, outputTokens: 30 });
      throw e;
    });
    const out = await runBulkJudge(id, h.deps);
    expect(out.status).toBe('halted');
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.costCap);
    // The third call never went out: the two answers that were no verdict filled the limit.
    expect(h.calls).toHaveLength(2);
    expect(ledger.getStatus(id)!.costUsd).toBeCloseTo(0.06, 12);
    expect(ledger.getStatus(id)!.costUsd).toBeLessThanOrEqual(0.06);
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

  it('a booking that fails keeps the others and the verdict, and stops the run before its next paid call', async () => {
    const id = await plan(['A', 'B']);
    expect(start(id).ok).toBe(true);
    const h = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }), {
      bookSpend: () => { throw new Error(`SQLITE_BUSY ${MARK}`); },
    });
    const out = await runBulkJudge(id, h.deps);
    expect(out.status).toBe('halted');
    expect(h.calls).toHaveLength(1);
    expect(h.reports).toHaveLength(1);
    const s = ledger.getStatus(id)!;
    expect([s.haltReason, s.costUsd, s.judge!.unjudged]).toEqual([BULK_HALT_REASONS.unavailable, 0.01, 1]);
    expect(h.captured.map((e) => e.message)).toEqual(['bulk_judge booking failed: Error']);
  });

  it('a booking that fails on the last target still halts the run: it is not finished as judged', async () => {
    const id = await plan(['A', 'B']);
    expect(start(id).ok).toBe(true);
    let n = 0;
    const h = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }), {
      bookSpend: () => { if (++n === 2) throw new Error('SQLITE_BUSY'); },
    });
    const out = await runBulkJudge(id, h.deps);
    expect(h.calls).toHaveLength(2);
    expect(out.status).toBe('halted');
    const s = ledger.getStatus(id)!;
    expect([s.phase, s.haltReason, s.judge!.unjudged]).toEqual(['planned', BULK_HALT_REASONS.unavailable, 0]);
  });

  it('a write after a paid call that throws frees the target: the run halts, and a restart judges it at once', async () => {
    const id = await plan(['A']);
    expect(start(id).ok).toBe(true);
    const spy = vi.spyOn(ledger, 'recordJudgement').mockImplementationOnce(() => { throw new Error(`SQLITE_BUSY ${MARK}`); });
    const h = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }));
    expect((await runBulkJudge(id, h.deps)).status).toBe('halted');
    spy.mockRestore();
    const s = ledger.getStatus(id)!;
    // Paid and booked once; the verdict is lost, the target is not.
    expect([s.haltReason, s.costUsd, s.judge!.unjudged]).toEqual([BULK_HALT_REASONS.unavailable, 0.01, 1]);
    expect(h.captured.map((e) => e.message)).toEqual(['bulk_judge after the call failed: Error']);
    // The owner starts it again: the target is judged now, not after its claim goes stale.
    expect(start(id).ok).toBe(true);
    const again = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }));
    expect((await runBulkJudge(id, again.deps)).status).toBe('done');
    expect(again.calls).toHaveLength(1);
    expect(ledger.getStatus(id)!.judge!.unjudged).toBe(0);
  });

  it('recording an invalid answer that throws frees the target too', async () => {
    const id = await plan(['A']);
    expect(start(id).ok).toBe(true);
    const spy = vi.spyOn(ledger, 'recordJudgement').mockImplementationOnce(() => { throw new Error('SQLITE_BUSY'); });
    const h = harness(() => { throw new CutOffError(); });
    expect((await runBulkJudge(id, h.deps)).status).toBe('halted');
    spy.mockRestore();
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.unavailable);
    expect(h.captured.map((e) => e.message)).toEqual(['bulk_judge after the call failed: Error']);
    expect(start(id).ok).toBe(true);
    const again = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }));
    expect((await runBulkJudge(id, again.deps)).status).toBe('done');
    expect(again.calls).toHaveLength(1);
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

describe('a run lost mid-judging', () => {
  it('goes on after a restart: no judged target is paid again, and the one in flight at most once more', async () => {
    const extra = 'DEFGHIJ'.split('');
    store.insertRecords({ collection: 'products', records: extra.map((sku) => ({ sku, title: `old ${sku.toLowerCase()}`, note: `${MARK}-${sku}` })), stamp: TEST_STAMP });
    const skus = ['A', 'B', 'C', ...extra];
    const n = skus.length;
    const id = await plan(skus);
    expect(start(id, 5).ok).toBe(true);
    // The first loop is lost at about 80 %: its ninth call never answers, as when the process dies
    // with that call in flight. Nothing after it runs, so its claim stays on the target.
    const lostAt = 9;
    const users: string[] = [];
    const lost = harness((user, k) => {
      users.push(user);
      return k === lostAt ? new Promise<never>(() => undefined) : { data: { title: title(user) }, costUsd: 0.01 };
    });
    void runBulkJudge(id, lost.deps);
    await vi.waitFor(() => { expect(lost.calls).toHaveLength(lostAt); });
    expect(ledger.getStatus(id)!.judge!.unjudged).toBe(n - (lostAt - 1));
    const judgedBefore = users.slice(0, lostAt - 1);

    // A restart while the lost claim is still live judges the rest, not the target in flight.
    const early = harness((user) => { users.push(user); return { data: { title: title(user) }, costUsd: 0.01 }; });
    expect((await runBulkJudge(id, early.deps)).status).not.toBe('done');
    expect(early.calls).toHaveLength(n - lostAt);
    expect(ledger.getStatus(id)!.judge!.unjudged).toBe(1);

    // Once the claim is stale, the target that was in flight is called once more, and nothing else.
    const late = harness((user) => { users.push(user); return { data: { title: title(user) }, costUsd: 0.01 }; }, { now: () => Date.now() + JUDGE_CLAIM_STALE_MS + 1 });
    expect((await runBulkJudge(id, late.deps)).status).toBe('done');
    expect(late.calls.map((c) => c.user)).toEqual([lost.calls[lostAt - 1]!.user]);
    expect(ledger.getStatus(id)!.judge!.unjudged).toBe(0);

    // In all: N + 1 calls, the one extra being the call lost in flight; no judged target twice.
    // The bound is per lost loop: a loop lost again mid-call leaves a fresh claim, and the target
    // is called once more after that claim goes stale too.
    expect(users).toHaveLength(n + 1);
    for (const u of judgedBefore) expect(users.filter((x) => x === u)).toHaveLength(1);
    expect(ledger.getPreview(id).map((t) => (t.after as { title: string }).title)).toEqual(skus.map((sku) => `new old ${sku.toLowerCase()}`));
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
    expect(ledger.expireStaleJudgedRuns()).toBe(1);
    expect(ledger.getStatus(id)).toBeNull();
    expect(new TriggerStore(engineDb).get(bulkPreviewTriggerId(id))).toBeUndefined();
    // The one inside its 30 days stays.
    expect(start(fresh).ok).toBe(true);
    expect(ledger.expireStaleJudgedRuns()).toBe(0);
    expect(ledger.getStatus(fresh)).not.toBeNull();
  });

  it('a run replaced by another start is still deleted 30 days after its own start: its images went to a model', async () => {
    const old = await plan(['A']);
    const started = Date.now() - BULK_JUDGED_RETENTION_MS - 60_000;
    expect(ledger.resumePreview(old, started, { judgeRuleHash: ledger.getJudgeRuleForOwner(old)!.hash, costCapUsd: 1 }).ok).toBe(true);
    const next = await plan(['B']);
    expect(start(next, 1, old).ok).toBe(true);
    expect(ledger.getStatus(old)!.haltReason).toBe(BULK_HALT_REASONS.superseded);
    expect(ledger.expireStaleJudgedRuns()).toBe(1);
    expect(ledger.getStatus(old)).toBeNull();
    expect(ledger.getStatus(next)).not.toBeNull();
  });

  it('a run whose planner\'s access ended is deleted 30 days after its start too', async () => {
    const GRANT = { kind: 'mandate' as const, email: 'helper@example.invalid', mandateId: 'grant-1' };
    const rule = normalizeJudgeRule(RULE);
    const id = ledger.recordDryRun({
      createdBy: 't', principal: GRANT, targetSystem: 'data_store', scope: 'products', targetCollection: 'products',
      targets: [{ key: 'A', before: { absent: false, value: { sku: 'A', title: 'old a', note: 'n' } }, after: judgeTemplate(rule) }],
      judge: rule,
    }).id;
    const started = Date.now() - BULK_JUDGED_RETENTION_MS - 60_000;
    expect(ledger.resumePreview(id, started, { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash, costCapUsd: 1 }).ok).toBe(true);
    expect(ledger.endIfPlannerEnded(id, { isLive: () => false, threadCreator: () => undefined, threadsKnown: true })).toBe(true);
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.mandateEnded);
    expect(ledger.expireStaleJudgedRuns()).toBe(1);
    expect(ledger.getStatus(id)).toBeNull();
  });

  it('control: an approved judged run is never swept, however old its start', async () => {
    const id = await plan(['A']);
    const started = Date.now() - BULK_JUDGED_RETENTION_MS - 60_000;
    expect(ledger.resumePreview(id, started, { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash, costCapUsd: 1 }).ok).toBe(true);
    const h = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }));
    expect((await runBulkJudge(id, h.deps)).status).toBe('done');
    expect(ledger.approve(id, { checksum: ledger.computeChecksum(id)!, approvedBy: 'test' }).ok).toBe(true);
    expect(ledger.expireStaleJudgedRuns()).toBe(0);
    expect(ledger.getStatus(id)!.phase).toBe('approved');
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

describe('against the real managed hook (PRD §6(e)): what reaches the control plane', () => {
  const bodies: { runs: { run_id: string; cost_cents: number }[] }[] = [];
  let allowed = true;
  beforeEach(() => {
    bodies.length = 0;
    allowed = true;
    vi.stubEnv('LYNOX_MANAGED_CONTROL_PLANE_URL', 'https://cp.test');
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-1');
    vi.stubEnv('LYNOX_HTTP_SECRET', 'secret');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (!String(url).endsWith('/status') && init?.body) bodies.push(JSON.parse(init.body) as typeof bodies[number]);
      return { ok: true, json: async () => ({ allowed, spend_gate: 'balance' }) };
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  async function hookHost(): Promise<{ host: { getHooks: () => LynoxHooks[]; getContext: () => null }; hook: LynoxHooks }> {
    const hook = createManagedHook();
    await hook.onInit?.();
    return { hook, host: { getHooks: () => [hook], getContext: () => null } };
  }

  it('debits every call: the cents of all flushes equal the sum of the calls, carried in micro-cents', async () => {
    const skus = Array.from({ length: 13 }, (_, i) => `K${String(i)}`);
    store.insertRecords({ collection: 'products', records: skus.map((sku) => ({ sku, title: `t ${sku}`, note: 'n' })), stamp: TEST_STAMP });
    const id = await plan(skus);
    expect(start(id, 5).ok).toBe(true);
    const { host, hook } = await hookHost();
    // Exact in micro-cents, so rounding does not carry the test: 1.234 + 0.567 cents, alternating.
    const costs = skus.map((_, i) => (i % 2 === 0 ? 0.01234 : 0.00567));
    const h = harness((user, n) => ({ data: { title: title(user) }, costUsd: costs[n - 1]! }), {
      gate: (tier) => fireBeforeRunGate(host as never, tier),
      report: (gateRunId, usd, tier) => reportMeteredCost(host as never, gateRunId, usd, tier),
    });
    expect((await runBulkJudge(id, h.deps)).status).toBe('done');
    await hook.onShutdown?.();
    const sent = bodies.flatMap((b) => b.runs);
    const micro = costs.reduce((n, c) => n + Math.round(c * 100_000), 0);
    expect(sent.reduce((n, r) => n + r.cost_cents, 0)).toBe(Math.floor(micro / 1000));
    // One gate per call: the reports carry distinct run ids.
    expect(new Set(sent.map((r) => r.run_id)).size).toBe(sent.length);
  });

  it('a refused credit blocks the next call before the model is called', async () => {
    allowed = false;
    const id = await plan(['A']);
    expect(start(id).ok).toBe(true);
    const { host, hook } = await hookHost();
    const h = harness((user) => ({ data: { title: title(user) }, costUsd: 0.01 }), {
      gate: (tier) => fireBeforeRunGate(host as never, tier),
      report: (gateRunId, usd, tier) => reportMeteredCost(host as never, gateRunId, usd, tier),
    });
    await runBulkJudge(id, h.deps);
    await hook.onShutdown?.();
    expect(h.calls).toHaveLength(0);
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.creditRefused);
  });
});

describe('judgeWorstCaseUsd — an upper bound on what one call can cost', () => {
  it('holds for text of one token per character, and counts the tool schema and its framing', () => {
    const p = getPricing('claude-haiku-4-5');
    const user = '数'.repeat(1_000);
    const schema = { type: 'object', properties: { t: { type: 'string', maxLength: 10 } } };
    // A thousand characters may be a thousand tokens; the helper's estimate would say ~286.
    const realistic = ((1_000 + JUDGE_TOOL_OVERHEAD_TOKENS) * p.input + 256 * p.output) / 1_000_000;
    expect(judgeWorstCaseUsd('claude-haiku-4-5', 'sys', user, schema, 256)).toBeGreaterThanOrEqual(realistic);
    expect(judgeWorstCaseUsd('claude-haiku-4-5', 'sys', 'x', { big: 'y'.repeat(5_000) }, 256))
      .toBeGreaterThan(judgeWorstCaseUsd('claude-haiku-4-5', 'sys', 'x', {}, 256));
    // The reply is paid at the output price, up to its whole cap.
    expect(judgeWorstCaseUsd('claude-haiku-4-5', 'sys', 'x', schema, 4_096) - judgeWorstCaseUsd('claude-haiku-4-5', 'sys', 'x', schema, 0))
      .toBeCloseTo((4_096 * p.output) / 1_000_000, 12);
  });
});
