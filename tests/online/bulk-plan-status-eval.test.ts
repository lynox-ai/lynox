/**
 * Online eval: when the owner asks for a bulk run over a store's active products, does the model
 * name the status filter, and does it leave it out when the owner asks for every product?
 *
 * A store's product search lists every status unless a status narrows it: a store's drafts and
 * archived products, and its gift cards, are targets otherwise. bulk_plan now takes `filters.status`. This eval records the
 * filters of every plan:
 * (s1) "the active products" → status active;
 * (s2) "every product" → no status;
 * (s3) "the tea products the shop sells, not the drafts" → product_type plus status active.
 * `bulk_plan` is the real tool on a real ledger in a temporary directory; the other tools answer
 * canned and nothing is sent anywhere. With STATUS_DUMP set, every run's calls and reply go to that
 * file. Runs per case and provider: STATUS_RUNS (default 3).
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

const RUNS = Number(process.env['STATUS_RUNS'] ?? 3);
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
  { label: '(s1) active products', want: { status: 'active' }, message: `Setz bei allen aktiven Produkten in meinem Shop ${STORE} den SEO-Titel auf „Direkt vom Hof“. Plan das als Massenlauf, ich gebe ihn dann frei.` },
  { label: '(s2) every product', want: null, message: `Setz bei wirklich allen Produkten in meinem Shop ${STORE}, auch Entwürfen und archivierten, den SEO-Titel auf „Direkt vom Hof“. Plan das als Massenlauf, ich gebe ihn dann frei.` },
  { label: '(s3) tea the shop sells', want: { product_type: 'Tee', status: 'active' }, message: `Setz bei den Tee-Produkten in meinem Shop ${STORE}, die ich verkaufe — keine Entwürfe, nichts Archiviertes —, den SEO-Titel auf „Direkt vom Hof“. Plan das als Massenlauf, ich gebe ihn dann frei.` },
];

interface Plan { input: Record<string, unknown>; answer: string }

const ownerOn = (ledger: BulkLedger): IAgent =>
  ({ toolContext: { bulkLedger: ledger, apiStore: PRODUCT_STORE }, currentThreadId: 'status-eval', principal: OWNER_PRINCIPAL } as unknown as IAgent);

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
  if (table.length) console.log(`\nbulk_plan status eval (${String(RUNS)} runs per case and provider)\n${table.join('\n')}`);
});

function skipped(err: unknown): string | null {
  const s = String((err as { status?: number })?.status ?? '') + ' ' + String((err as Error)?.message ?? err);
  if (/usage limit|spend limit|credit balance|billing/i.test(s)) return 'limit';
  if (/429|5\d\d|overloaded|rate|timeout/i.test(s)) return 'transient';
  return null;
}

async function runOnce(provider: string, make: (tools: ToolEntry[]) => Agent, label: string, message: string, want: Record<string, string> | null, i: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-status-eval-'));
  dirs.push(dir);
  const engineDb = new EngineDb(join(dir, 'engine.db'), 'status-eval-vault-key');
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
  const recorded = plans.filter((p) => RECORDED.test(p.answer));
  const last = recorded[recorded.length - 1];
  const filters = ((last?.input['source_list'] as { filters?: Record<string, unknown> } | undefined)?.filters) ?? null;
  // A hit names exactly the wanted filters: a status that replaced the group is a miss.
  const status = filters === null ? null : (filters['status'] ?? null);
  const hit = want === null ? status === null : JSON.stringify(Object.entries(filters ?? {}).sort()) === JSON.stringify(Object.entries(want).sort());
  const dump = process.env['STATUS_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ provider, label, run: i, recorded: recorded.length > 0, filters, hit, plans, reply })}\n`);
  table.push(`${provider}\t${label}\t#${String(i)}\t${recorded.length === 0 ? 'NO-PLAN' : hit ? 'HIT' : 'MISS'}\t${JSON.stringify(filters)}\t${reply.replace(/\s+/g, ' ').slice(0, 120)}`);
  expect(recorded.length > 0, 'no plan was recorded').toBe(true);
}

const runs = CASES.flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ ...c, i, name: `${c.label} #${String(i)}` })));
const base = { maxIterations: 8, systemPrompt: SYSTEM, promptUser: async () => 'ok', promptSecret: async () => 'canceled' as const };

let anthropicKey: string | undefined;
try { anthropicKey = getApiKey(); } catch { anthropicKey = undefined; }
describe.skipIf(!anthropicKey)('bulk_plan status — Anthropic (Haiku)', () => {
  it.each(runs)('$name', async ({ label, message, want, i }) => {
    await runOnce('haiku', (tools) => new Agent({ ...base, tools, name: 'status-haiku', model: HAIKU, apiKey: anthropicKey!, provider: 'anthropic', toolContext: createToolContext({}) }), label, message, want, i);
  }, 180_000);
});

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY)('bulk_plan status — Mistral (mistral-large-2512)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$name', async ({ label, message, want, i }) => {
    await runOnce('mistral', (tools) => new Agent({
      ...base, tools, name: 'status-mistral', model: 'mistral-large-2512', provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: 'mistral-large-2512', toolContext: createToolContext({}),
    }), label, message, want, i);
  }, 180_000);
});
