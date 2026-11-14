/**
 * Online eval (G1, ux U-175): the planner rule that a Shopify filter takes one value as text or
 * several as a list, of which a product matches any one — "one run for several groups, not a run
 * per group".
 *
 * (C1) The owner names three product types for one change. PASS: every plan recorded has
 *      product_type a list holding the three (any order). FAIL PER-GROUP: a plan for one type.
 * (C2) The owner names one product type. PASS: every plan recorded has it as text, not a list of
 *      one (a list of one is refused; a model that sends one has to plan again).
 * (C3) Two product types of one vendor. PASS: every plan has product_type a list of the two and
 *      vendor the one value as text.
 * A run with no plan recorded is FAIL NONE, read by hand: it says nothing about the list form.
 *
 * `bulk_plan` is the real tool on a real ledger; the store read answers a canned product list.
 * Every run's reply, calls and verdict go to LIST_DUMP when it is set. Runs per case: LIST_RUNS (default 10).
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../../src/core/agent.js';
import { initLLMProvider } from '../../src/core/llm-client.js';
import { createToolContext } from '../../src/core/tool-context.js';
import { SYSTEM_PROMPT, SHOPIFY_PRESET_PROMPT_SUFFIX } from '../../src/core/prompts.js';
import { EngineDb } from '../../src/core/engine-db.js';
import { BulkLedger } from '../../src/core/bulk-ledger.js';
import { OWNER_PRINCIPAL } from '../../src/core/request-principal.js';
import { askUserTool, bulkPlanTool, bulkStatusTool, httpRequestTool } from '../../src/tools/builtin/index.js';
import type { IAgent, ToolEntry } from '../../src/types/index.js';
import { HAIKU } from './setup.js';

const RUNS = Number(process.env['LIST_RUNS'] ?? 10);
const STORE = 'acme-demo.myshopify.com';

const PRODUCTS = JSON.stringify({
  products: [
    { id: 1, title: 'Dichtungsset', vendor: 'Müller AG', product_type: 'Zubehör' },
    { id: 2, title: 'Aktivkohlefilter 10"', vendor: 'Müller AG', product_type: 'Filter' },
    { id: 3, title: 'Ersatzkartusche Basic', vendor: 'Aqua Pro', product_type: 'Kartuschen' },
    { id: 4, title: 'Wasserflasche 1 l', vendor: 'Aqua Pro', product_type: 'Flaschen' },
    { id: 5, title: 'Sedimentfilter', vendor: 'Aqua Pro', product_type: 'Filter' },
  ],
});

const SYSTEM = `${SYSTEM_PROMPT}${SHOPIFY_PRESET_PROMPT_SUFFIX}

## Connected API profiles
- Shopify store ${STORE} (Admin API, read and write scopes for products). Requests go through http_request to https://${STORE}/admin/api/2025-01/…; the engine attaches the credential.`;

interface Run { plans: { input: Record<string, unknown>; answer: string }[]; reads: number; asks: number; reply: string }
interface Case { label: string; message: string; verdict: (r: Run) => { ok: boolean; why: string } }

const filterOf = (input: Record<string, unknown>): Record<string, unknown> => {
  const list = typeof input['source_list'] === 'object' && input['source_list'] !== null ? input['source_list'] as Record<string, unknown> : {};
  return typeof list['filters'] === 'object' && list['filters'] !== null ? list['filters'] as Record<string, unknown> : {};
};
const RECORDED = /^List dry run recorded/;
const recorded = (r: Run): Record<string, unknown>[] => r.plans.filter((p) => RECORDED.test(p.answer)).map((p) => filterOf(p.input));
const sameSet = (v: unknown, want: string[]): boolean => Array.isArray(v) && v.length === want.length && want.every((w) => v.includes(w));

// The rule's question is the FORM of what is recorded: one run over a list, not a run per group.
// A plan recorded again with the same filters (a model that plans twice) is counted, not failed:
// it is not what this rule is about. No plan at all is its own verdict, read by hand.
const verdictOf = (want: (f: Record<string, unknown>) => boolean, perGroup: (f: Record<string, unknown>) => boolean) => (r: Run): { ok: boolean; why: string } => {
  const f = recorded(r);
  if (f.length === 0) return { ok: false, why: `NONE: no plan recorded (reads ${String(r.reads)}, asks ${String(r.asks)})` };
  if (f.every(want)) return { ok: true, why: f.length === 1 ? 'LIST: one plan' : `LIST: ${String(f.length)} plans, all the same form` };
  if (f.some(perGroup)) return { ok: false, why: `PER-GROUP: ${JSON.stringify(f)}` };
  return { ok: false, why: `OTHER: ${JSON.stringify(f)}` };
};
const types = (f: Record<string, unknown>): unknown => f['product_type'];

const CASES: Case[] = [
  {
    label: '(C1) three product types, one change',
    message: `Schreib für alle Produkte der Produkttypen Zubehör, Filter und Kartuschen in meinem Shop ${STORE} einen SEO-Titel aus dem Produktnamen, höchstens 60 Zeichen. Plan das als Massenlauf, ich gebe ihn dann frei.`,
    verdict: verdictOf((f) => sameSet(types(f), ['Zubehör', 'Filter', 'Kartuschen']) && f['vendor'] === undefined, (f) => typeof types(f) === 'string'),
  },
  {
    label: '(C2) one product type',
    message: `Schreib für alle Produkte vom Produkttyp Filter in meinem Shop ${STORE} einen SEO-Titel aus dem Produktnamen, höchstens 60 Zeichen. Plan das als Massenlauf, ich gebe ihn dann frei.`,
    verdict: verdictOf((f) => types(f) === 'Filter' && f['vendor'] === undefined, () => false),
  },
  {
    label: '(C3) two product types of one vendor',
    message: `Schreib für alle Produkte der Produkttypen Zubehör und Filter, aber nur vom Anbieter Müller AG, in meinem Shop ${STORE} einen SEO-Titel aus dem Produktnamen, höchstens 60 Zeichen. Plan das als Massenlauf, ich gebe ihn dann frei.`,
    verdict: verdictOf((f) => sameSet(types(f), ['Zubehör', 'Filter']) && f['vendor'] === 'Müller AG', (f) => typeof types(f) === 'string'),
  },
];

const table: string[] = [];
const dirs: string[] = [];
let flagBefore: string | undefined;
beforeAll(() => {
  flagBefore = process.env['LYNOX_FEATURE_SHOPIFY_BULK_READ'];
  process.env['LYNOX_FEATURE_SHOPIFY_BULK_READ'] = '1';
});
afterAll(() => {
  if (flagBefore === undefined) delete process.env['LYNOX_FEATURE_SHOPIFY_BULK_READ'];
  else process.env['LYNOX_FEATURE_SHOPIFY_BULK_READ'] = flagBefore;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (table.length) console.log(`\nfilter list eval (${String(RUNS)} runs per case)\n${table.join('\n')}`);
});

function transient(err: unknown): boolean {
  return /429|5\d\d|overloaded|rate|timeout/i.test(String((err as { status?: number })?.status ?? err));
}

async function runCase(provider: string, make: (tools: ToolEntry[]) => Agent, c: Case, i: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-list-eval-'));
  dirs.push(dir);
  const engineDb = new EngineDb(join(dir, 'engine.db'), 'list-eval-vault-key');
  const run: Run = { plans: [], reads: 0, asks: 0, reply: '' };
  const ledger = new BulkLedger(engineDb, null);
  const owner = { toolContext: { bulkLedger: ledger }, currentThreadId: 'list-eval', principal: OWNER_PRINCIPAL } as unknown as IAgent;
  const agent = make([
    { ...(bulkPlanTool as ToolEntry), handler: async (input: unknown) => {
      const answer = await (bulkPlanTool as ToolEntry).handler(input, owner);
      run.plans.push({ input: (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>, answer });
      return answer;
    } } as ToolEntry,
    { ...(httpRequestTool as ToolEntry), handler: async () => { run.reads++; return PRODUCTS; } } as ToolEntry,
    { ...(bulkStatusTool as ToolEntry), handler: async () => 'No bulk runs recorded.' } as ToolEntry,
    { ...(askUserTool as ToolEntry), handler: async () => { run.asks++; return 'Ja, genau so.'; } } as ToolEntry,
  ]);
  try {
    run.reply = String(await agent.send(c.message));
  } catch (err) {
    if (transient(err)) { table.push(`${provider}\t${c.label}\t#${String(i)}\tSKIP\ttransient`); return; }
    throw err;
  } finally {
    engineDb.close();
  }
  const v = c.verdict(run);
  const dump = process.env['LIST_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ provider, case: c.label, run: i, ok: v.ok, why: v.why, reads: run.reads, asks: run.asks, plans: run.plans, reply: run.reply })}\n`);
  table.push(`${provider}\t${c.label}\t#${String(i)}\t${v.ok ? 'PASS' : 'FAIL'}\t${v.why}`);
}

const ONLY = process.env['LIST_CASES']?.split(',').map((x) => `(${x.trim()})`);
const runs = CASES.filter((c) => !ONLY || ONLY.some((o) => c.label.startsWith(o))).flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ c, i, label: `${c.label} #${String(i)}` })));
const base = { maxIterations: 8, systemPrompt: SYSTEM, promptUser: async () => 'ok', promptSecret: async () => 'canceled' as const };

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];
describe.skipIf(!ANTHROPIC_KEY)('filter list — Anthropic (Haiku)', () => {
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('haiku', (tools) => new Agent({ ...base, tools, name: 'list-haiku', model: HAIKU, apiKey: ANTHROPIC_KEY!, provider: 'anthropic', toolContext: createToolContext({}) }), c, i);
  }, 180_000);
});

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY)('filter list — Mistral (mistral-large-2512, temperature 0)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('mistral', (tools) => new Agent({
      ...base, tools, name: 'list-mistral', model: 'mistral-large-2512', provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: 'mistral-large-2512', toolContext: createToolContext({}),
    }), c, i);
  }, 180_000);
});
