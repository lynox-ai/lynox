/**
 * Online eval: after a Shopify bulk run is planned, where does the model tell the user to find it?
 *
 * The run is reviewed and approved outside the chat, on the tab "Massenläufe" / "Bulk runs" under
 * "Aktivität & Kosten" / "Activity & Cost". Before bulk_plan's result named that path, the model guessed: a walk
 * found it naming the tab by its English label in a German interface. Now the result names it as fixed
 * text (`RUN_PLACE_NOTE`). This eval counts how often a reply names a place, and of those how often it
 * names the real one in the interface's language (RIGHT) and how often it also names something else —
 * a link, an address, another menu (OTHER), so the tool's text can be compared before and after a
 * change; every flagged reply is still read by hand against that path:
 * (p1) "set the SEO title of every product to one text" → form shopify, after.seo_title;
 * (p2) "write each product an SEO title from its name" → form shopify with a judge.
 *
 * `bulk_plan` is the real tool on a real ledger in a temporary directory, with the Shopify read
 * switched on; the other tools answer canned and nothing is sent anywhere. What the test asserts
 * is the structure (a plan was recorded). Whether the reply names a place is counted by a pattern
 * and judged by hand from the dump: with PLACE_DUMP set, every run's calls and final reply go to
 * that file. Runs per case and provider: PLACE_RUNS (default 3). Anthropic key via `getApiKey`,
 * Mistral via MISTRAL_API_KEY; a provider without a key is skipped, and a provider that refuses
 * for its usage limit is recorded as SKIP, not as a result.
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
import { HAIKU, getApiKey } from './setup.js';

const RUNS = Number(process.env['PLACE_RUNS'] ?? 3);
const STORE = 'acme-demo.myshopify.com';
const PRODUCT_STORE = {
  getByHostname: (h: string) => h === STORE ? { base_url: `https://${STORE}`, auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: STORE.split('.')[0] } } }, oauth_grant: { granted_scope: ['read_products', 'write_products'] } } : undefined,
};

const PRODUCTS = JSON.stringify({
  products: [
    { id: 1, title: 'Bergtee', product_type: 'Tee', vendor: 'Hof Sur' },
    { id: 2, title: 'Honig', product_type: 'Honig', vendor: 'Hof Sur' },
  ],
});

const SYSTEM = `${SYSTEM_PROMPT}${SHOPIFY_PRESET_PROMPT_SUFFIX}

## Connected API profiles
- Shopify store ${STORE} (Admin API, read and write scopes for products). Requests go through http_request to https://${STORE}/admin/api/2025-01/…; the engine attaches the credential.`;

const CASES = [
  { label: '(p1) one SEO title for every product', message: `Setz bei allen Produkten in meinem Shop ${STORE} den SEO-Titel auf „Direkt vom Hof“. Plan das als Massenlauf, ich gebe ihn dann frei.` },
  { label: '(p2) an SEO title per product from its name', message: `Schreib für jedes Produkt in meinem Shop ${STORE} einen SEO-Titel aus dem Produktnamen, höchstens 60 Zeichen. Plan das als Massenlauf, ich gebe ihn dann frei.` },
];

interface Plan { input: Record<string, unknown>; answer: string }

const ownerOn = (ledger: BulkLedger): IAgent =>
  ({ toolContext: { bulkLedger: ledger, apiStore: PRODUCT_STORE }, currentThreadId: 'place-eval', principal: OWNER_PRINCIPAL } as unknown as IAgent);

function realBulkPlan(owner: IAgent, plans: Plan[]): ToolEntry {
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
// A place in the app the reply points to, the real one included. Wide on purpose: it is a count for
// the hand judge, who reads every flagged reply in the dump; a word like "Seite" can be meant otherwise.
const PLACE = /\b(Tab|Reiter|Registerkarte|Menü|Menüpunkt|Bereich|Seite|Dashboard|Übersicht|Navigation|Sidebar|Seitenleiste)\b|Bulk[ -]?Runs?|Massenläufe|Aktivität|\bklick|\blink\b|https?:\/\//i;

// The real place in a German reply (the cases are German), menu and tab in either order of mention.
const RIGHT = /Aktivität\s*&\s*Kosten[\s\S]{0,40}Massenläufe|Massenläufe[\s\S]{0,40}Aktivität\s*&\s*Kosten/;
// What the note forbids beside it: a link or address, or a place word that is not part of the path.
const OTHER = /https?:\/\/|\bwww\.|\]\(|\b[\w-]+\.(?:ai|com|ch|cloud|app|io|net)\b|\/app\b|\/activity\b|\?tab=|\b(Dashboard|Sidebar|Seitenleiste|Einstellungen|Settings)\b|\bBulk[ -]?Runs?\b/i;
// A control on that page the reply names: the note gives none, so each is the model's guess. Wide,
// like PLACE, for the hand judge — a reply quoting a step as a heading is read in the dump.
const BUTTON = /klick\w*|\b(Buttons?|Knopf|Knöpfe|Schaltfläche(?:n)?)\b|\btipp\w*\s+auf\b/i;
// What the page cannot do, promised anyway: editing a value, discarding, rejecting or stopping the
// run, all-or-nothing writing. Wide, for the hand judge; "nicht anpassen" is read in the dump.
const PROMISE = /anpass\w*|bearbeit\w*|änder\w*|verwerf\w*|verworfen|ablehn\w*|abbrech\w*|abgebrochen|stopp\w*|alle oder keine|atomar/i;
// A list plan reads its targets only on a second start; the reply may still say so. Counted, not
// required: a reply without it is read by hand.
const SECOND = /zweit\w*|erneut|noch einmal|nochmal|wieder starten/i;

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
  if (table.length) console.log(`\nbulk_plan run place eval (${String(RUNS)} runs per case and provider)\n${table.join('\n')}`);
});

function skipped(err: unknown): string | null {
  const s = String((err as { status?: number })?.status ?? '') + ' ' + String((err as Error)?.message ?? err);
  if (/usage limit|spend limit|credit balance|billing/i.test(s)) return 'limit';
  if (/429|5\d\d|overloaded|rate|timeout/i.test(s)) return 'transient';
  return null;
}

async function runOnce(provider: string, make: (tools: ToolEntry[]) => Agent, label: string, message: string, i: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-place-eval-'));
  dirs.push(dir);
  const engineDb = new EngineDb(join(dir, 'engine.db'), 'place-eval-vault-key');
  const plans: Plan[] = [];
  const owner = ownerOn(new BulkLedger(engineDb, null));
  const agent = make([
    realBulkPlan(owner, plans),
    { ...(httpRequestTool as ToolEntry), handler: async () => PRODUCTS } as ToolEntry,
    // The real status tool on the same ledger, so a model that checks sees the run it planned.
    { ...(bulkStatusTool as ToolEntry), handler: async (input: unknown) => (bulkStatusTool as ToolEntry).handler(input, owner) } as ToolEntry,
    { ...(askUserTool as ToolEntry), handler: async () => 'Mach einfach, so wie beschrieben.' } as ToolEntry,
  ]);
  let reply = '';
  try {
    reply = await agent.send(message);
  } catch (err) {
    const why = skipped(err);
    if (why !== null) { table.push(`${provider}\t${label}\t#${String(i)}\tSKIP\t${why}`); return; }
    throw err;
  } finally {
    engineDb.close();
  }
  const recorded = plans.some((p) => RECORDED.test(p.answer));
  const place = reply.match(PLACE)?.[0] ?? null;
  const right = RIGHT.test(reply);
  // The case names its store; a reply repeating it is no link to the run.
  const other = reply.split(STORE).join('').match(OTHER)?.[0] ?? null;
  const button = reply.match(BUTTON)?.[0] ?? null;
  const promise = reply.match(PROMISE)?.[0] ?? null;
  const second = SECOND.test(reply);
  const dump = process.env['PLACE_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ provider, label, run: i, recorded, place, right, other, button, promise, second, plans, reply })}\n`);
  table.push(`${provider}\t${label}\t#${String(i)}\t${!recorded ? 'NO-PLAN' : `${place === null ? 'none' : `${right ? 'RIGHT' : 'PLACE?'}(${place})`}${other !== null ? ` OTHER(${other})` : ''}${button !== null ? ` BUTTON(${button})` : ''}${promise !== null ? ` PROMISE(${promise})` : ''}${second ? ' SECOND' : ''}`}\t${reply.replace(/\s+/g, ' ').slice(0, 160)}`);
  expect(recorded, 'no plan was recorded').toBe(true);
}

const runs = CASES.flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ ...c, i, name: `${c.label} #${String(i)}` })));
const base = { maxIterations: 8, systemPrompt: SYSTEM, promptUser: async () => 'ok', promptSecret: async () => 'canceled' as const };

let anthropicKey: string | undefined;
try { anthropicKey = getApiKey(); } catch { anthropicKey = undefined; }
describe.skipIf(!anthropicKey)('bulk_plan run place — Anthropic (Haiku)', () => {
  it.each(runs)('$name', async ({ label, message, i }) => {
    await runOnce('haiku', (tools) => new Agent({ ...base, tools, name: 'place-haiku', model: HAIKU, apiKey: anthropicKey!, provider: 'anthropic', toolContext: createToolContext({}) }), label, message, i);
  }, 180_000);
});

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY)('bulk_plan run place — Mistral (mistral-large-2512)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$name', async ({ label, message, i }) => {
    await runOnce('mistral', (tools) => new Agent({
      ...base, tools, name: 'place-mistral', model: 'mistral-large-2512', provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: 'mistral-large-2512', toolContext: createToolContext({}),
    }), label, message, i);
  }, 180_000);
});
