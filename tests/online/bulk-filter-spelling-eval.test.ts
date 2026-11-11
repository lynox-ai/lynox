/**
 * Online eval (ux U-143): two texts a model reads about a filtered Shopify list whose search
 * folds diacritics (PRD shopify-preset §22.4, `not_in_filter`).
 *
 * (A) `listNoneLeft`: the run's summary when the search listed products and every one was spelled
 *     otherwise than the filter. The summary is pushed to the owner; here the owner brings it into
 *     the chat and asks what it means. PASS: the reply does not say or suggest that the store has
 *     no such products, and it names planning again with the spelling the store shows (or plans so).
 * (B) The planner rule "each the value as the store shows it (letter case of A-Z aside, nothing
 *     else)": the owner writes `Gemuse`, the store holds `Gemüse`. PASS: the recorded filter is
 *     `Gemüse`, or no plan with `Gemuse` is recorded and the model read the store or asked first.
 *
 * `bulk_plan` is the real tool on a real ledger; the store read answers a canned product list.
 * Every run's reply, calls and verdict go to SPELL_DUMP when it is set: the verdicts here are a
 * first sort, the raw replies are read by hand. Runs per case: SPELL_RUNS (default 10).
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
import { BULK_NOTICES } from '../../src/core/bulk-notices.js';
import { OWNER_PRINCIPAL } from '../../src/core/request-principal.js';
import { askUserTool, bulkPlanTool, bulkStatusTool, httpRequestTool } from '../../src/tools/builtin/index.js';
import type { IAgent, ToolEntry } from '../../src/types/index.js';
import { HAIKU } from './setup.js';

const RUNS = Number(process.env['SPELL_RUNS'] ?? 10);
const STORE = 'acme-demo.myshopify.com';

const PRODUCTS = JSON.stringify({
  products: [
    { id: 1, title: 'Rüebli', body_html: '<p>Bio-Karotten vom Hof.</p>', vendor: 'Hof Sur', product_type: 'Gemüse', tags: 'bio' },
    { id: 2, title: 'Lauch', body_html: '<p>Frischer Lauch.</p>', vendor: 'Hof Sur', product_type: 'Gemüse', tags: 'bio' },
    { id: 3, title: 'Äpfel', body_html: '<p>Tafeläpfel.</p>', vendor: 'Hof Sur', product_type: 'Obst', tags: 'bio' },
  ],
});

const SYSTEM = `${SYSTEM_PROMPT}${SHOPIFY_PRESET_PROMPT_SUFFIX}

## Connected API profiles
- Shopify store ${STORE} (Admin API, read and write scopes for products). Requests go through http_request to https://${STORE}/admin/api/2025-01/…; the engine attaches the credential.`;

const NONE_LEFT = `${BULK_NOTICES.de.listNoneLeft('product_type')} ${BULK_NOTICES.de.previewCounts(0, 2, 0, 2)}`;

interface Run { plans: { input: Record<string, unknown>; answer: string }[]; reads: number; asks: number; reply: string }

interface Case {
  label: string;
  message: string;
  verdict: (r: Run) => { ok: boolean; why: string };
}

const filterOf = (input: Record<string, unknown>): Record<string, unknown> => {
  const list = typeof input['source_list'] === 'object' && input['source_list'] !== null ? input['source_list'] as Record<string, unknown> : {};
  return typeof list['filters'] === 'object' && list['filters'] !== null ? list['filters'] as Record<string, unknown> : {};
};
const RECORDED = /^List dry run recorded/;
const recordedTypes = (r: Run): unknown[] => r.plans.filter((p) => RECORDED.test(p.answer)).map((p) => filterOf(p.input)['product_type']);
// "There are none": the claim U-143 is about. A first sort only; every reply is read by hand.
const SAYS_NONE = /(keine|kein)\s+(solchen\s+|passenden\s+)?(Produkte|Gemüse|Gemuse)[^.]*\b(gibt|vorhanden|hat|führ)|gibt es (im Shop )?keine|hat (dein Shop )?keine (Produkte|Gemüse)|no (such )?products (exist|of that)|has no (such )?products/i;
const NAMES_SPELLING = /Schreibweise|geschrieben|Gemüse|ü statt u|spell/i;

const CASES: Case[] = [
  {
    label: '(A) listNoneLeft brought into the chat',
    message: `Ich habe zu meinem Massenlauf über die Gemuse-Produkte in ${STORE} diese Meldung bekommen:\n\n„${NONE_LEFT}“\n\nWas heisst das, und was mache ich jetzt?`,
    verdict: (r) => {
      if (SAYS_NONE.test(r.reply)) return { ok: false, why: 'reply says or suggests the store has none' };
      if (recordedTypes(r).includes('Gemüse')) return { ok: true, why: 'planned again with the store spelling' };
      if (NAMES_SPELLING.test(r.reply)) return { ok: true, why: 'names the spelling and planning again' };
      return { ok: false, why: 'names neither the spelling nor planning again' };
    },
  },
  {
    label: '(B) the owner writes Gemuse, the store holds Gemüse',
    message: `Schreib für alle Produkte vom Produkttyp Gemuse in meinem Shop ${STORE} einen SEO-Titel aus dem Produktnamen, höchstens 60 Zeichen. Plan das als Massenlauf, ich gebe ihn dann frei.`,
    verdict: (r) => {
      const types = recordedTypes(r);
      if (types.includes('Gemüse')) return { ok: true, why: 'filter recorded as Gemüse' };
      if (types.length > 0) return { ok: false, why: `filter recorded as ${JSON.stringify(types)}` };
      if (r.reads > 0 || r.asks > 0) return { ok: true, why: `no plan recorded; read ${String(r.reads)}, asked ${String(r.asks)}` };
      return { ok: false, why: 'no plan recorded, neither read nor asked' };
    },
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
  if (table.length) console.log(`\nfilter spelling eval (${String(RUNS)} runs per case)\n${table.join('\n')}`);
});

function transient(err: unknown): boolean {
  return /429|5\d\d|overloaded|rate|timeout/i.test(String((err as { status?: number })?.status ?? err));
}

async function runCase(provider: string, make: (tools: ToolEntry[]) => Agent, c: Case, i: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-spell-eval-'));
  dirs.push(dir);
  const engineDb = new EngineDb(join(dir, 'engine.db'), 'spell-eval-vault-key');
  const run: Run = { plans: [], reads: 0, asks: 0, reply: '' };
  const ledger = new BulkLedger(engineDb, null);
  const owner = { toolContext: { bulkLedger: ledger }, currentThreadId: 'spell-eval', principal: OWNER_PRINCIPAL } as unknown as IAgent;
  const agent = make([
    { ...(bulkPlanTool as ToolEntry), handler: async (input: unknown) => {
      const answer = await (bulkPlanTool as ToolEntry).handler(input, owner);
      run.plans.push({ input: (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>, answer });
      return answer;
    } } as ToolEntry,
    { ...(httpRequestTool as ToolEntry), handler: async () => { run.reads++; return PRODUCTS; } } as ToolEntry,
    { ...(bulkStatusTool as ToolEntry), handler: async () => 'No bulk runs recorded.' } as ToolEntry,
    { ...(askUserTool as ToolEntry), handler: async () => { run.asks++; return 'So, wie es im Shop steht.'; } } as ToolEntry,
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
  const dump = process.env['SPELL_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ provider, case: c.label, run: i, ok: v.ok, why: v.why, reads: run.reads, asks: run.asks, plans: run.plans, reply: run.reply })}\n`);
  table.push(`${provider}\t${c.label}\t#${String(i)}\t${v.ok ? 'PASS' : 'FAIL'}\t${v.why}`);
}

const ONLY = process.env['SPELL_CASES']?.split(',').map((x) => `(${x.trim()})`);
const runs = CASES.filter((c) => !ONLY || ONLY.some((o) => c.label.startsWith(o))).flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ c, i, label: `${c.label} #${String(i)}` })));
const base = { maxIterations: 8, systemPrompt: SYSTEM, promptUser: async () => 'ok', promptSecret: async () => 'canceled' as const };

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];
describe.skipIf(!ANTHROPIC_KEY)('filter spelling — Anthropic (Haiku)', () => {
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('haiku', (tools) => new Agent({ ...base, tools, name: 'spell-haiku', model: HAIKU, apiKey: ANTHROPIC_KEY!, provider: 'anthropic', toolContext: createToolContext({}) }), c, i);
  }, 180_000);
});

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY)('filter spelling — Mistral (mistral-large-2512, temperature 0)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('mistral', (tools) => new Agent({
      ...base, tools, name: 'spell-mistral', model: 'mistral-large-2512', provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: 'mistral-large-2512', toolContext: createToolContext({}),
    }), c, i);
  }, 180_000);
});
