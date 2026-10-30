/**
 * Online eval: does a model still plan a Shopify bulk run right when the `bulk_plan` schema names
 * the Shopify forms but not their rules?
 *
 * The rules of the forms `shopify` and `shopify_media` (which fields `after` or a judge may set, no
 * path, filters or id_field, no judge for images, the alt text's length) live in the refusals of
 * `planList` and `parseListSource`. A model that guesses wrong learns them from the refusal and
 * plans again. This eval measures what that costs, on real models, on both providers:
 * (s1) "set the SEO description of every product to one text" → form shopify, after.seo_description;
 * (s2) "set the alt text of every product image to one text" → form shopify_media, after.alt;
 * (s3) "write each product an SEO title from its name" → form shopify with a judge that sets seo_title.
 * A run passes when the plan it records is in that form and sets that field, however many calls
 * it took. How many it took is the price, counted apart: `handled` is the calls that reached
 * `bulk_plan`'s handler, and `first` that the first of them was recorded right. Both are a lower
 * bound: a call the dispatch validator refuses never reaches the handler.
 *
 * `bulk_plan` is the real tool on a real ledger in a temporary directory, with the Shopify read
 * switched on, so a wrong plan gets the engine's own refusal. The other tools answer canned:
 * nothing is sent anywhere. Each case runs RUNS times per provider (FORM_RUNS, default 3); with
 * FORM_DUMP set, every run's calls and answers go to that file. Anthropic key via
 * ANTHROPIC_API_KEY, Mistral via MISTRAL_API_KEY; a provider without a key is skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const RUNS = Number(process.env['FORM_RUNS'] ?? 3);
const STORE = 'acme-demo.myshopify.com';

const PRODUCTS = JSON.stringify({
  products: [
    { id: 1, title: 'Bergtee', images: [{ id: 11, alt: '' }] },
    { id: 2, title: 'Honig', images: [{ id: 21, alt: 'Honig' }] },
  ],
});

const SYSTEM = `${SYSTEM_PROMPT}${SHOPIFY_PRESET_PROMPT_SUFFIX}

## Connected API profiles
- Shopify store ${STORE} (Admin API, read and write scopes for products). Requests go through http_request to https://${STORE}/admin/api/2025-01/…; the engine attaches the credential.`;

interface Plan { input: Record<string, unknown>; answer: string }

interface Case {
  label: string;
  message: string;
  /** Whether a recorded plan is the right one. */
  right: (input: Record<string, unknown>) => boolean;
}

const listOf = (input: Record<string, unknown>): Record<string, unknown> =>
  typeof input['source_list'] === 'object' && input['source_list'] !== null ? input['source_list'] as Record<string, unknown> : {};
const keysOf = (v: unknown): string[] => (typeof v === 'object' && v !== null ? Object.keys(v) : []);

const CASES: Case[] = [
  {
    label: '(s1) one SEO description for every product',
    message: `Setz bei allen Produkten in meinem Shop ${STORE} die SEO-Beschreibung auf „Handgemacht in der Schweiz, direkt vom Hof.“ Plan das als Massenlauf, ich gebe ihn dann frei.`,
    right: (input) => listOf(input)['form'] === 'shopify' && keysOf(listOf(input)['after']).includes('seo_description'),
  },
  {
    label: '(s2) one alt text for every product image',
    message: `Gib allen Produktbildern in meinem Shop ${STORE} den Alt-Text „Produktfoto Acme“. Plan das als Massenlauf, ich gebe ihn dann frei.`,
    right: (input) => listOf(input)['form'] === 'shopify_media' && keysOf(listOf(input)['after']).includes('alt'),
  },
  {
    label: '(s3) an SEO title per product, decided from its name',
    message: `Schreib für jedes Produkt in meinem Shop ${STORE} einen SEO-Titel aus dem Produktnamen, höchstens 60 Zeichen. Plan das als Massenlauf, ich gebe ihn dann frei.`,
    right: (input) => {
      const judge = typeof input['judge'] === 'object' && input['judge'] !== null ? input['judge'] as Record<string, unknown> : {};
      return listOf(input)['form'] === 'shopify' && keysOf(judge['schema']).includes('seo_title');
    },
  },
];

/** `bulk_plan` itself, on a ledger of its own per run; every call and answer is kept. */
function realBulkPlan(ledger: BulkLedger, plans: Plan[]): ToolEntry {
  const owner = { toolContext: { bulkLedger: ledger }, currentThreadId: 'form-eval', principal: OWNER_PRINCIPAL } as unknown as IAgent;
  return {
    ...(bulkPlanTool as ToolEntry),
    handler: async (input: unknown) => {
      const answer = await (bulkPlanTool as ToolEntry).handler(input, owner);
      plans.push({ input: (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>, answer });
      return answer;
    },
  } as ToolEntry;
}

const RECORDED = /^List dry run recorded/;

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
  if (table.length) console.log(`\nbulk_plan Shopify form eval (${String(RUNS)} runs per case)\n${table.join('\n')}`);
});

function transient(err: unknown): boolean {
  return /429|5\d\d|overloaded|rate|timeout/i.test(String((err as { status?: number })?.status ?? err));
}

async function runCase(provider: string, make: (tools: ToolEntry[]) => Agent, c: Case, i: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-form-eval-'));
  dirs.push(dir);
  const engineDb = new EngineDb(join(dir, 'engine.db'), 'form-eval-vault-key');
  const plans: Plan[] = [];
  const agent = make([
    realBulkPlan(new BulkLedger(engineDb, null), plans),
    { ...(httpRequestTool as ToolEntry), handler: async () => PRODUCTS } as ToolEntry,
    { ...(bulkStatusTool as ToolEntry), handler: async () => 'No bulk runs recorded.' } as ToolEntry,
    { ...(askUserTool as ToolEntry), handler: async () => 'Mach einfach, so wie beschrieben.' } as ToolEntry,
  ]);
  try {
    await agent.send(c.message);
  } catch (err) {
    if (transient(err)) { table.push(`${provider}\t${c.label}\t#${String(i)}\tSKIP\ttransient`); return; }
    throw err;
  } finally {
    engineDb.close();
  }
  const at = plans.findIndex((p) => RECORDED.test(p.answer));
  const recorded = at === -1 ? undefined : plans[at];
  // Handler calls up to the recorded one: after it, a further plan only gets "another external
  // dry run", so those calls do not count.
  const handled = at === -1 ? plans.length : at + 1;
  let why: string;
  let ok = false;
  if (recorded === undefined) why = plans.length === 0 ? 'no bulk_plan call reached the handler' : `no plan recorded in ${String(plans.length)} handled calls`;
  else if (!c.right(recorded.input)) why = `recorded, but not the asked form and field: ${JSON.stringify(recorded.input['source_list'])}`;
  else { ok = true; why = handled === 1 ? 'right on the first handled call' : `right on handled call ${String(handled)}`; }
  const dump = process.env['FORM_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ provider, case: c.label, run: i, ok, handled, first: ok && handled === 1, plans })}\n`);
  table.push(`${provider}\t${c.label}\t#${String(i)}\t${ok ? 'PASS' : 'FAIL'}\t${why}`);
  expect(ok, why).toBe(true);
}

// FORM_CASES=s1 (or s1,s3) runs only those cases.
const ONLY = process.env['FORM_CASES']?.split(',').map((x) => `(${x.trim()})`);
const runs = CASES.filter((c) => !ONLY || ONLY.some((o) => c.label.startsWith(o))).flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ c, i, label: `${c.label} #${String(i)}` })));
const base = { maxIterations: 8, systemPrompt: SYSTEM, promptUser: async () => 'ok', promptSecret: async () => ({ status: 'canceled' as const }) };

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];
describe.skipIf(!ANTHROPIC_KEY)('bulk_plan Shopify form — Anthropic (Haiku)', () => {
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('haiku', (tools) => new Agent({ ...base, tools, name: 'form-haiku', model: HAIKU, apiKey: ANTHROPIC_KEY!, provider: 'anthropic', toolContext: createToolContext({}) }), c, i);
  }, 180_000);
});

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY)('bulk_plan Shopify form — Mistral (mistral-large-2512)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('mistral', (tools) => new Agent({
      ...base, tools, name: 'form-mistral', model: 'mistral-large-2512', provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: 'mistral-large-2512', toolContext: createToolContext({}),
    }), c, i);
  }, 180_000);
});
