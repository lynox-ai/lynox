import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { EngineDb } from './engine-db.js';
import { DataStore } from './data-store.js';
import { BulkLedger } from './bulk-ledger.js';
import { bulkPlanTool } from '../tools/builtin/bulk.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { dataStoreColumns } from './bulk-plan.js';
import { JUDGE_MAX_FIELDS, normalizeJudgeRule } from './bulk-judge-rule.js';
import type { callForStructuredJson } from './llm-helper.js';
import {
  JUDGE_CONTEXT_CUT, JUDGE_CONTEXT_MAX_CHARS, JUDGE_CONTEXT_MAX_TOTAL, JUDGE_CONTEXT_TEXT,
  judgeContext, judgeUserMessage, runBulkJudge, type BulkJudgeDeps,
} from './bulk-judge.js';
import { hiddenCharIndexes } from './hidden-chars.js';
import type { IAgent, MemoryScopeRef } from '../types/index.js';
import { TEST_STAMP } from '../../tests/helpers/row-stamp.js';

/**
 * The context C of a judged run (PRD shopify-preset §20.2 item 7): fields the judge reads beside
 * the record and never writes — planned, checked twice for credentials, cut, and sent in a frame
 * of its own. The Shopify side (the read, the start view, the start's re-check) is in
 * `bulk-shopify.test.ts`.
 */

const scope: MemoryScopeRef = { type: 'context', id: 'bulk-judge-context-test' };
const RULE = { rule: 'Write a short title.', schema: { title: { type: 'string', maxLength: 40 } } };
const scan = (t: string): string | null => (t.includes('sk-live-') ? 'api_key' : null);
const noVault = (t: string): string => t;

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;
let store: DataStore;

function agent(): IAgent {
  return { toolContext: { bulkLedger: ledger, dataStore: store }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL } as unknown as IAgent;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-judge-ctx-')));
  const ws = join(dir, 'workspace');
  mkdirSync(ws);
  setTenantWorkspace(ws);
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
  store = new DataStore(join(dir, 'datastore.db'));
  store.createCollection({
    name: 'products', scope, uniqueKey: ['sku'],
    columns: [
      { name: 'sku', type: 'string' }, { name: 'title', type: 'string' },
      { name: 'brand', type: 'string' }, { name: 'note', type: 'string' }, { name: 'email', type: 'string' },
    ],
  });
  store.insertRecords({
    collection: 'products',
    records: [
      { sku: 'A', title: 'old a', brand: 'Acme', note: 'organic cotton', email: 'a@example.com' },
      { sku: 'B', title: 'old b', brand: 'Bolt', note: 'key sk-live-abcdef', email: 'b@example.com' },
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

async function plan(skus: string[], judge: unknown): Promise<string> {
  writeFileSync(join(dir, 'workspace', 'skus.csv'), ['target', ...skus].join('\n'));
  const out = await bulkPlanTool.handler(
    { target_system: 'data_store', target_collection: 'products', source_file: 'skus.csv', judge }, agent(),
  );
  const m = /Bulk run ([0-9a-f-]{36})/.exec(out);
  if (!m) throw new Error(`no run id in: ${out}`);
  return m[1]!;
}

function start(runId: string): boolean {
  const hash = ledger.getJudgeRuleForOwner(runId)!.hash;
  return ledger.resumePreview(runId, Date.now(), { judgeRuleHash: hash, costCapUsd: 1 }).ok;
}

type Call = typeof callForStructuredJson;
function harness(): { deps: BulkJudgeDeps; calls: { user: string; system: string }[] } {
  const calls: { user: string; system: string }[] = [];
  const call = (async (opts: Parameters<Call>[0]) => {
    calls.push({ user: opts.user, system: opts.system ?? '' });
    return { data: { keep: false, after: { title: 'new' } }, inputTokens: 100, outputTokens: 10, costUsd: 0.01, modelId: 'claude-haiku-4-5' };
  }) as unknown as Call;
  return {
    calls,
    deps: {
      ledger,
      resolveModel: (tier) => ({ tier, modelId: 'claude-haiku-4-5', client: {} as Anthropic }),
      gate: async () => ({ runId: 'gate', blockedReason: null }),
      report: () => {},
      bookSpend: () => {},
      budgetAllows: () => true,
      scanSecret: scan,
      maskVault: noVault,
      columns: (c) => dataStoreColumns(store, c),
      call,
    },
  };
}

describe('planning a context', () => {
  it('takes names the rule does not decide, and stores them in the rule', async () => {
    const id = await plan(['A'], { ...RULE, context: ['brand', 'note'] });
    expect(ledger.getJudgeRuleForOwner(id)!.context).toEqual(['brand', 'note']);
  });

  it.each([
    ['a field the rule decides', ['title'], /judge\.schema decides/],
    ['the key column', ['sku'], /must not name the id field/],
    ['a name that is no column', ['price'], /not a column of the target collection/],
    ['a name twice', ['brand', 'brand'], /twice/],
    ['no list', 'brand', /list of 0/],
    ['a name that is no field name', ['a.b'], /one top-level name/],
    ['more than the bound', Array.from({ length: JUDGE_MAX_FIELDS + 1 }, (_, i) => `c${String(i)}`), /list of 0/],
  ])('refuses %s', async (_what, context, message) => {
    await expect(plan(['A'], { ...RULE, context })).rejects.toThrow(message);
  });

  it('leaves the key out for no context or an empty one, so such a rule keeps the hash it had before C', () => {
    const none = normalizeJudgeRule(RULE);
    const empty = normalizeJudgeRule({ ...RULE, context: [] });
    expect(Object.hasOwn(none, 'context')).toBe(false);
    expect(Object.hasOwn(empty, 'context')).toBe(false);
    const hashOf = (j: unknown): string => (ledger as unknown as { judgeColumns(j: unknown): [string, string] }).judgeColumns(j)[1];
    // The hash of the rule as it was stored before C: the same three keys and the envelope.
    const before = { rule: RULE.rule, schema: none.schema, tier: 'fast', verdict: 'envelope' };
    expect(hashOf(none)).toBe(hashOf(before));
    expect(hashOf(empty)).toBe(hashOf(before));
    expect(hashOf(normalizeJudgeRule({ ...RULE, context: ['brand'] }))).not.toBe(hashOf(before));
  });
});

describe('the judge with a context', () => {
  it('sends the context in a frame of its own after the record, which holds only F, and says so in the system text', async () => {
    const id = await plan(['A'], { ...RULE, context: ['brand', 'note'] });
    expect(start(id)).toBe(true);
    const h = harness();
    await runBulkJudge(id, h.deps);
    expect(h.calls).toHaveLength(1);
    const user = h.calls[0]!.user;
    expect(user).toBe(judgeUserMessage({ title: 'old a' }, { brand: 'Acme', note: 'organic cotton' }));
    // The record is F alone: neither C nor a column outside both goes into it.
    const record = user.slice(user.indexOf('<record>'), user.indexOf('</record>'));
    expect(record).not.toContain('Acme');
    expect(user).not.toContain('a@example.com');
    expect(h.calls[0]!.system).toContain(JUDGE_CONTEXT_TEXT);
  });

  it('sends no context frame and no context sentence for a rule without one (twin)', async () => {
    const id = await plan(['A'], RULE);
    expect(start(id)).toBe(true);
    const h = harness();
    await runBulkJudge(id, h.deps);
    expect(h.calls[0]!.user).toBe(judgeUserMessage({ title: 'old a' }));
    expect(h.calls[0]!.user).not.toContain('<context>');
    expect(h.calls[0]!.system).not.toContain(JUDGE_CONTEXT_TEXT);
  });

  it('makes a target whose context holds a credential invalid, sends nothing of it, and names the field that held it', async () => {
    // `note` is the second field of C: the name the owner reads must be that one, not the first.
    const id = await plan(['A', 'B'], { ...RULE, context: ['brand', 'note'] });
    expect(start(id)).toBe(true);
    const h = harness();
    await runBulkJudge(id, h.deps);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.user).toContain('organic cotton');
    expect(h.calls.map((c) => c.user).join('\n')).not.toContain('sk-live-');
    const b = ledger.getPreview(id).find((t) => t.key === 'B')!;
    expect(b).toMatchObject({ change: 'invalid', error: 'secret_in_context', contextField: 'note' });
    expect(ledger.getPreview(id).find((t) => t.key === 'A')!.contextField).toBeUndefined();
  });

  it('keeps a kept target\'s after-state as its row: the context is not merged into it', async () => {
    const id = await plan(['A'], { ...RULE, context: ['brand'] });
    expect(start(id)).toBe(true);
    const h = harness();
    h.deps.call = (async () => ({ data: { keep: true }, inputTokens: 1, outputTokens: 1, costUsd: 0.01, modelId: 'claude-haiku-4-5' })) as unknown as Call;
    await runBulkJudge(id, h.deps);
    const row = engineDb.getDb().prepare('SELECT after_planned FROM bulk_targets WHERE run_id = ?').get(id) as { after_planned: string };
    // A data-store row is written whole, as it was read: `brand` is in it as the row held it, no more.
    expect(JSON.parse(engineDb.dec(row.after_planned))).toEqual({ sku: 'A', title: 'old a', brand: 'Acme', note: 'organic cotton', email: 'a@example.com' });
  });
});

describe('judgeContext: the two credential checks', () => {
  const check = { scanSecret: scan, maskVault: noVault };

  it('finds one in a list element, and names that field', () => {
    expect(judgeContext({ vendor: 'Acme', tags: ['a', 'x sk-live-1', 'c'] }, ['vendor', 'tags'], check)).toEqual({ secretField: 1 });
  });

  it('finds one an entity or a tag splits, where the written bytes do not show it whole', () => {
    expect(judgeContext({ d: '<p>key sk&#x2d;live-abc</p>' }, ['d'], check)).toEqual({ secretField: 0 });
    expect(judgeContext({ d: '<p>key sk-<b></b>live-abc</p>' }, ['d'], check)).toEqual({ secretField: 0 });
    expect(judgeContext({ d: '<a title="sk-live-abc">x</a>' }, ['d'], check)).toEqual({ secretField: 0 });
    // Twin: the same markup with no credential in any reading is sent.
    expect(judgeContext({ d: '<p>key sk&#x2d;dead-abc</p>' }, ['d'], check)).toHaveProperty('context');
  });

  it('finds one the cut would halve: the first check reads the value before any cut', () => {
    const long = `${'a'.repeat(JUDGE_CONTEXT_MAX_CHARS - 5)}sk-live-abcdef`;
    expect(judgeContext({ d: long }, ['d'], check)).toEqual({ secretField: 0 });
  });

  it('finds one a hidden character splits: the second check reads the context as it is sent', () => {
    const split = 'key sk-​live-abc';
    expect(hiddenCharIndexes(split).length).toBeGreaterThan(0);
    expect(scan(split)).toBeNull();
    expect(judgeContext({ d: split }, ['d'], check)).toEqual({ secretField: 0 });
  });

  it('finds one a hidden character splits where real text may carry one, which the sent text keeps', () => {
    // A soft hyphen between two letters stands in place: it is not removed from what is sent.
    const soft = 'key sk-li\u00ADve-abc';
    expect(hiddenCharIndexes(soft)).toEqual([]);
    expect(scan(soft)).toBeNull();
    expect(judgeContext({ d: soft }, ['d'], check)).toEqual({ secretField: 0 });
    expect(judgeContext({ d: 'key sk-de\u00ADad-abc' }, ['d'], check)).toHaveProperty('context');
  });

  it('finds one an entity spells a hidden character into, and one in a record nested in the value', () => {
    expect(judgeContext({ d: '<p>key sk-&#8203;live-abc</p>' }, ['d'], check)).toEqual({ secretField: 0 });
    expect(judgeContext({ a: 'x', meta: { k: 'sk-\u200Blive-abc' } }, ['a', 'meta'], check)).toEqual({ secretField: 1 });
    expect(judgeContext({ a: 'x', meta: { k: 'sk-\u200Bdead-abc' } }, ['a', 'meta'], check)).toHaveProperty('context');
  });

  it('names a credential spread over two fields\' JSON by the field it ends in', () => {
    // Neither value holds it alone; the context's JSON, in its sorted order, does from b on.
    const vault = { scanSecret: () => null, maskVault: (t: string) => t.replace('1","b":"p', '***') };
    expect(judgeContext({ a: 'p1', b: 'p2', c: 'z' }, ['a', 'b', 'c'], vault)).toEqual({ secretField: 1 });
    expect(judgeContext({ a: 'p1', b: 'p2', c: 'z' }, ['c', 'b', 'a'], vault)).toEqual({ secretField: 1 });
  });

  it('finds one in a value the vault knows, in the value and in the context sent', () => {
    expect(judgeContext({ a: 'x', b: 'my-pass' }, ['a', 'b'], { scanSecret: () => null, maskVault: (t) => t.replace('my-pass', '***') }))
      .toEqual({ secretField: 1 });
  });

  it('counts a value it cannot walk as a hit', () => {
    const deep = '['.repeat(100) + ']'.repeat(100);
    expect(judgeContext({ d: deep }, ['d'], check)).toEqual({ secretField: 0 });
  });
});

describe('judgeContext: what is sent', () => {
  const check = { scanSecret: scan, maskVault: noVault };
  const sent = (read: Record<string, unknown>, fields: string[]): Record<string, unknown> => {
    const out = judgeContext(read, fields, check);
    if (!('context' in out)) throw new Error('refused');
    return out.context;
  };

  it('takes each field of C, null where the target holds none, and nothing else', () => {
    expect(sent({ a: 'x', z: 'other' }, ['a', 'b'])).toEqual({ a: 'x', b: null });
  });

  it('removes hidden characters from what it sends', () => {
    expect(sent({ a: 'Bio​-Baumwolle', t: ['x​y'] }, ['a', 't'])).toEqual({ a: 'Bio-Baumwolle', t: ['xy'] });
  });

  it('cuts a text past its bound, marked', () => {
    const out = sent({ a: 'b'.repeat(JUDGE_CONTEXT_MAX_CHARS + 50) }, ['a'])['a'] as string;
    expect(Array.from(out)).toHaveLength(JUDGE_CONTEXT_MAX_CHARS);
    expect(out.endsWith(JUDGE_CONTEXT_CUT)).toBe(true);
    expect(sent({ a: 'b'.repeat(JUDGE_CONTEXT_MAX_CHARS) }, ['a'])['a']).toBe('b'.repeat(JUDGE_CONTEXT_MAX_CHARS));
  });

  it('cuts the whole to its bound from the back, in the rule\'s order', () => {
    const fields = ['a', 'b', 'c'];
    const out = sent({ a: 'x'.repeat(3_000), b: 'y'.repeat(3_000), c: 'z'.repeat(3_000) }, fields);
    expect(Array.from(JSON.stringify(out)).length).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_TOTAL);
    expect(out['a']).toBe('x'.repeat(3_000));
    expect(out['b']).toBe('y'.repeat(3_000));
    expect((out['c'] as string).endsWith(JUDGE_CONTEXT_CUT)).toBe(true);
  });

  it('sends a record as its JSON text, without hidden characters, and cuts it to the bounds', () => {
    expect(sent({ meta: { b: 'x\u200By', a: 1 } }, ['meta'])).toEqual({ meta: '{"a":1,"b":"xy"}' });
    expect(sent({ t: ['a', { k: 'v' }, 2] }, ['t'])).toEqual({ t: ['a', '{"k":"v"}', 2] });
    // Each text alone fits its own bound; together they pass the whole's, so the record — the last
    // field — is cut further, below its own bound.
    const big = sent({ a: 'x'.repeat(3_990), meta: { note: 'n'.repeat(60_000) } }, ['a', 'meta']);
    expect(Array.from(JSON.stringify(big)).length).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_TOTAL);
    expect(big['a']).toBe('x'.repeat(3_990));
    expect(Array.from(big['meta'] as string).length).toBeLessThan(JUDGE_CONTEXT_MAX_CHARS);
    expect((big['meta'] as string).endsWith(JUDGE_CONTEXT_CUT)).toBe(true);
  });

  it('cuts a list from its end, marked, when it is the field the whole is cut in', () => {
    const tags = Array.from({ length: 2_000 }, (_, i) => `tag-${String(i)}`);
    const out = sent({ a: 'x', tags }, ['a', 'tags']);
    const kept = out['tags'] as string[];
    expect(kept.at(-1)).toBe(JUDGE_CONTEXT_CUT);
    expect(kept.slice(0, -1)).toEqual(tags.slice(0, kept.length - 1));
    expect(Array.from(JSON.stringify(out)).length).toBeLessThanOrEqual(JUDGE_CONTEXT_MAX_TOTAL);
  });
});
