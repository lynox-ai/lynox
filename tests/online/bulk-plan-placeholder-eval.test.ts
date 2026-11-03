/**
 * Online eval: when `bulk_plan` refuses a placeholder in a list's fixed `after`, does the user
 * learn what the run cannot do, and does the model stop instead of circling?
 *
 * A list's `after` is written as it stands into every target, so `{{name}}`, `{title}` and the
 * like are refused (`checkAfter`, src/core/bulk-list.ts). Two wishes are then not plannable:
 * (u1) braces as literal text in every product's SEO title — a judge could write it, a fixed
 *      text cannot;
 * (u2) a different alt text per image — form shopify_media takes no judge.
 * Per run the dump keeps every bulk_plan call and answer and the model's final answer; the
 * verdict is printed, not asserted:
 * - `placeholderRecorded`: a plan with a placeholder in `after` was recorded (must stay 0);
 * - `refusals`: how often the placeholder refusal came back (3 or more = a retry circle);
 * - `told`: the final answer says the run cannot do it (a German negation near "Klammer",
 *   "{Sale}", "Alt-Text" or "Bild"), checked by hand on the dump as well.
 * Each case runs RUNS times per provider (PH_RUNS, default 3); PH_DUMP names the dump file.
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

const RUNS = Number(process.env['PH_RUNS'] ?? 3);
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

const PLACEHOLDER = /\{\{|\{%|\$\{|<%|%%[\p{L}\p{N}_]+%%|\{\s*\$?[\p{L}\p{N}_][\p{L}\p{N}_. -]*\}/u;
const REFUSED = /^Error: source_list\.after holds a placeholder/;
const RECORDED = /^List dry run recorded/;
const afterHolds = (input: Record<string, unknown>): boolean => {
  const list = typeof input['source_list'] === 'object' && input['source_list'] !== null ? input['source_list'] as Record<string, unknown> : {};
  const after = typeof list['after'] === 'object' && list['after'] !== null ? list['after'] as Record<string, unknown> : {};
  return Object.values(after).some((v) => typeof v === 'string' && PLACEHOLDER.test(v));
};

interface Case { label: string; message: string; told: RegExp }
const NEG = /(nicht|kein|leider|nur (einen|ein|denselben|den gleichen))/i;
const CASES: Case[] = [
  {
    label: '(u1) braces as literal text in every SEO title',
    message: `Setz bei allen Produkten in meinem Shop ${STORE} den SEO-Titel auf genau „{Sale} Bergprodukte vom Hof“, mit den geschweiften Klammern. Plan das als Massenlauf, ich gebe ihn dann frei.`,
    told: /(Klammer|\{Sale\}|fest(en)? Text)/i,
  },
  {
    label: '(u2) a different alt text per image',
    message: `Gib jedem Produktbild in meinem Shop ${STORE} einen eigenen Alt-Text, der das jeweilige Produkt beschreibt. Plan das als Massenlauf, ich gebe ihn dann frei.`,
    told: /(Alt-?Text|Bild)/i,
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
  if (table.length) console.log(`\nbulk_plan placeholder eval (${String(RUNS)} runs per case)\n${table.join('\n')}`);
});

function transient(err: unknown): boolean {
  return /429|5\d\d|overloaded|rate|timeout/i.test(String((err as { status?: number })?.status ?? err));
}

async function runCase(provider: string, make: (tools: ToolEntry[]) => Agent, c: Case, i: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-ph-eval-'));
  dirs.push(dir);
  const engineDb = new EngineDb(join(dir, 'engine.db'), 'ph-eval-vault-key');
  const plans: Plan[] = [];
  const agent = make([
    realBulkPlan(new BulkLedger(engineDb, null), plans),
    { ...(httpRequestTool as ToolEntry), handler: async () => PRODUCTS } as ToolEntry,
    { ...(bulkStatusTool as ToolEntry), handler: async () => 'No bulk runs recorded.' } as ToolEntry,
    { ...(askUserTool as ToolEntry), handler: async () => 'Mach einfach, so wie beschrieben.' } as ToolEntry,
  ]);
  let final = '';
  try {
    final = await agent.send(c.message);
  } catch (err) {
    if (transient(err)) { table.push(`${provider}\t${c.label}\t#${String(i)}\tSKIP\ttransient`); return; }
    throw err;
  } finally {
    engineDb.close();
  }
  const placeholderRecorded = plans.some((p) => RECORDED.test(p.answer) && afterHolds(p.input));
  const refusals = plans.filter((p) => REFUSED.test(p.answer)).length;
  const told = c.told.test(final) && NEG.test(final);
  const recorded = plans.filter((p) => RECORDED.test(p.answer)).length;
  const dump = process.env['PH_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ provider, case: c.label, run: i, placeholderRecorded, refusals, told, recorded, handled: plans.length, final, plans })}\n`);
  table.push(`${provider}\t${c.label}\t#${String(i)}\tplaceholderRecorded=${String(placeholderRecorded)}\trefusals=${String(refusals)}\ttold=${String(told)}\trecorded=${String(recorded)}`);
  expect(placeholderRecorded).toBe(false);
}

// PH_CASES=u1 runs only that case.
const ONLY = process.env['PH_CASES']?.split(',').map((x) => `(${x.trim()})`);
const runs = CASES.filter((c) => !ONLY || ONLY.some((o) => c.label.startsWith(o))).flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ c, i, label: `${c.label} #${String(i)}` })));
const base = { maxIterations: 8, systemPrompt: SYSTEM, promptUser: async () => 'ok', promptSecret: async () => ({ status: 'canceled' as const }) };

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];
describe.skipIf(!ANTHROPIC_KEY)('bulk_plan placeholder — Anthropic (Haiku)', () => {
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('haiku', (tools) => new Agent({ ...base, tools, name: 'ph-haiku', model: HAIKU, apiKey: ANTHROPIC_KEY!, provider: 'anthropic', toolContext: createToolContext({}) }), c, i);
  }, 180_000);
});

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY)('bulk_plan placeholder — Mistral (mistral-large-2512)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('mistral', (tools) => new Agent({
      ...base, tools, name: 'ph-mistral', model: 'mistral-large-2512', provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: 'mistral-large-2512', toolContext: createToolContext({}),
    }), c, i);
  }, 180_000);
});
