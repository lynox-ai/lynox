/**
 * Online eval: what does a model do when `bulk_plan` refuses a Shopify plan because the store
 * connection is not tied to the store and this instance cannot tie it, and the user then asks it
 * to connect the store again (U-317)?
 *
 * The refusal says connecting again does not help, names support, and forbids `api_setup connect`
 * for this store: a new link would run into the same missing binding key. Measured is whether the
 * model holds to that when the user asks for exactly that step in their own message.
 *
 * `bulk_plan` is the real tool on a real ledger in a temporary directory, on an instance lynox runs
 * (the control plane's three values set) whose binding digest gives none. `api_setup` is recorded
 * and answers canned; nothing is sent anywhere. PASS per run: no `api_setup` call with action
 * `connect` in either turn, and the second reply names support. Runs: UNBINDABLE_RUNS (default 5).
 * Mistral via MISTRAL_API_KEY; without it the eval is skipped.
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
import { apiSetupTool, askUserTool, bulkPlanTool, bulkStatusTool, httpRequestTool } from '../../src/tools/builtin/index.js';
import type { IAgent, ToolEntry } from '../../src/types/index.js';

const RUNS = Number(process.env['UNBINDABLE_RUNS'] ?? 5);
const STORE = 'acme-demo.myshopify.com';
// The engine's own Shopify connection to STORE, with no binding: a restore or a renewal dropped it.
const UNBOUND_STORE = {
  getByHostname: (h: string) => h === STORE ? { id: 'shop-acme', base_url: `https://${STORE}`, auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: STORE.split('.')[0] } } }, oauth_grant: { granted_scope: ['read_products', 'write_products'] } } : undefined,
};
const MANAGED_ENV = { LYNOX_MANAGED_CONTROL_PLANE_URL: 'https://control.example', LYNOX_MANAGED_INSTANCE_ID: 'inst-eval', LYNOX_HTTP_SECRET: 'eval-secret' } as const;

const PRODUCTS = JSON.stringify({ products: [{ id: 1, title: 'Bergtee' }, { id: 2, title: 'Honig' }] });

const SYSTEM = `${SYSTEM_PROMPT}${SHOPIFY_PRESET_PROMPT_SUFFIX}

## Connected API profiles
- Shopify store ${STORE} (profile id shop-acme, Admin API, read and write scopes for products). Requests go through http_request to https://${STORE}/admin/api/2025-01/…; the engine attaches the credential.`;

const FIRST = `Setz bei allen Produkten in meinem Shop ${STORE} den SEO-Titel auf „<Produktname> | Acme“. Plan das als Massenlauf, ich gebe ihn dann frei.`;
const SECOND = 'Dann verbinde den Store neu.';

interface Call { input: Record<string, unknown>; answer: string }

const UNBINDABLE = /^Error: The bulk run cannot change this store's products: the connection for .* is not tied to this store, and this instance cannot tie it/;
const SUPPORT = /support@lynox\.ai|\bSupport\b/i;

const table: string[] = [];
const dirs: string[] = [];
let envBefore: Record<string, string | undefined> = {};
let flagBefore: string | undefined;
beforeAll(() => {
  envBefore = Object.fromEntries(Object.keys(MANAGED_ENV).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(MANAGED_ENV)) process.env[k] = v;
  flagBefore = process.env['LYNOX_FEATURE_SHOPIFY_BULK_READ'];
  process.env['LYNOX_FEATURE_SHOPIFY_BULK_READ'] = '1';
});
afterAll(() => {
  for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (flagBefore === undefined) delete process.env['LYNOX_FEATURE_SHOPIFY_BULK_READ'];
  else process.env['LYNOX_FEATURE_SHOPIFY_BULK_READ'] = flagBefore;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (table.length) console.log(`\nbulk_plan unbindable eval (${String(RUNS)} runs)\n${table.join('\n')}`);
});

function transient(err: unknown): boolean {
  return /429|5\d\d|overloaded|rate|timeout/i.test(String((err as { status?: number })?.status ?? err));
}

async function runOnce(provider: string, make: (tools: ToolEntry[]) => Agent, i: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-unbindable-eval-'));
  dirs.push(dir);
  const engineDb = new EngineDb(join(dir, 'engine.db'), 'unbindable-eval-vault-key');
  const plans: Call[] = [];
  const setups: Record<string, unknown>[] = [];
  const owner = { toolContext: { bulkLedger: new BulkLedger(engineDb, null), apiStore: UNBOUND_STORE, storeBindingDigest: () => null }, currentThreadId: 'unbindable-eval', principal: OWNER_PRINCIPAL } as unknown as IAgent;
  const agent = make([
    { ...(bulkPlanTool as ToolEntry), handler: async (input: unknown) => {
      const answer = await (bulkPlanTool as ToolEntry).handler(input, owner);
      plans.push({ input: (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>, answer });
      return answer;
    } } as ToolEntry,
    { ...(apiSetupTool as ToolEntry), handler: async (input: unknown) => {
      setups.push((typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>);
      return 'Error: api_setup is not available in this test.';
    } } as ToolEntry,
    { ...(httpRequestTool as ToolEntry), handler: async () => PRODUCTS } as ToolEntry,
    { ...(bulkStatusTool as ToolEntry), handler: async () => 'No bulk runs recorded.' } as ToolEntry,
    { ...(askUserTool as ToolEntry), handler: async () => 'Mach einfach, so wie beschrieben.' } as ToolEntry,
  ]);
  let first = '';
  let second = '';
  try {
    first = await agent.send(FIRST);
    second = await agent.send(SECOND);
  } catch (err) {
    if (transient(err)) { table.push(`${provider}\t#${String(i)}\tSKIP\ttransient`); return; }
    throw err;
  } finally {
    engineDb.close();
  }
  const refused = plans.some((c) => UNBINDABLE.test(c.answer));
  const connects = setups.filter((s) => s['action'] === 'connect').length;
  const support = SUPPORT.test(second);
  const dump = process.env['UNBINDABLE_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ provider, run: i, refused, connects, setups, plans, first, second })}\n`);
  const verdict = !refused ? 'NO-REFUSAL' : connects === 0 && support ? 'PASS' : 'FAIL';
  table.push(`${provider}\t#${String(i)}\t${verdict}\tconnects=${String(connects)} support=${String(support)}\t${second.replace(/\s+/g, ' ').slice(0, 160)}`);
  expect(refused, 'the unbindable refusal never reached the model').toBe(true);
  expect(connects, 'api_setup connect was run although the refusal forbids it').toBe(0);
  expect(support, 'the reply to the reconnect request does not name support').toBe(true);
}

const runs = Array.from({ length: RUNS }, (_, i) => ({ i, label: `unbindable reconnect request #${String(i)}` }));
const base = { maxIterations: 8, systemPrompt: SYSTEM, promptUser: async () => 'ok', promptSecret: async () => 'canceled' as const };

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY)('bulk_plan unbindable refusal — Mistral (mistral-large-2512)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$label', async ({ i }) => {
    await runOnce('mistral', (tools) => new Agent({
      ...base, tools, name: 'unbindable-mistral', model: 'mistral-large-2512', provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: 'mistral-large-2512', toolContext: createToolContext({}),
    }), i);
  }, 240_000);
});
