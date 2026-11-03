/**
 * Online eval: what does a model tell the user when `bulk_plan` refuses an image plan because the
 * store connection may not write image alt texts (ux U-126)?
 *
 * The Shopify connection lynox sets up never asks for `write_files` or `write_themes`, which
 * `fileUpdate` needs, so today every image plan over it gets `SHOPIFY_MEDIA_NO_SCOPE`. The refusal
 * asks the model to say so in one sentence, to offer to write alt texts in the chat from the
 * product names and what the user says about the images, and not to suggest a reconnect.
 *
 * `bulk_plan` is the real tool on a real ledger in a temporary directory, over a store connection
 * granted the product scopes only; the other tools answer canned and nothing is sent anywhere.
 * A run is measured from the first answer that carries the refusal of the image plan or the note
 * the product rules and the store hint carry (`SHOPIFY_MEDIA_NOTE`). What the test asserts is the
 * structure (one of them came, no plan was tried after it, no run was recorded); the
 * reply is judged by hand against ux's criteria, from the dump: with MEDIA_DUMP set, every run's
 * calls and final reply go to that file. Runs per provider: MEDIA_RUNS (default 3). Anthropic key
 * as the other online tests read it (`getApiKey`), Mistral via MISTRAL_API_KEY; a provider without
 * a key is skipped.
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

const RUNS = Number(process.env['MEDIA_RUNS'] ?? 3);
const STORE = 'acme-demo.myshopify.com';
// The engine's own Shopify connection to STORE, granted what the preset asks for: no image scope.
const PRODUCT_ONLY_STORE = {
  getByHostname: (h: string) => h === STORE ? { base_url: `https://${STORE}`, auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: STORE.split('.')[0] } } }, oauth_grant: { granted_scope: ['read_products', 'write_products'] } } : undefined,
};

const PRODUCTS = JSON.stringify({
  products: [
    { id: 1, title: 'Bergtee', images: [{ id: 11, alt: '' }] },
    { id: 2, title: 'Honig', images: [{ id: 21, alt: 'Honig' }] },
  ],
});

const SYSTEM = `${SYSTEM_PROMPT}${SHOPIFY_PRESET_PROMPT_SUFFIX}

## Connected API profiles
- Shopify store ${STORE} (Admin API, read and write scopes for products). Requests go through http_request to https://${STORE}/admin/api/2025-01/…; the engine attaches the credential.`;

const MESSAGE = `Gib allen Produktbildern in meinem Shop ${STORE} den Alt-Text „Produktfoto Acme“. Plan das als Massenlauf, ich gebe ihn dann frei.`;

interface Call { input: Record<string, unknown>; answer: string }

const formOf = (input: Record<string, unknown>): unknown =>
  typeof input['source_list'] === 'object' && input['source_list'] !== null ? (input['source_list'] as Record<string, unknown>)['form'] : undefined;

function realBulkPlan(ledger: BulkLedger, calls: Call[]): ToolEntry {
  const owner = { toolContext: { bulkLedger: ledger, apiStore: PRODUCT_ONLY_STORE }, currentThreadId: 'media-eval', principal: OWNER_PRINCIPAL } as unknown as IAgent;
  return {
    ...(bulkPlanTool as ToolEntry),
    handler: async (input: unknown) => {
      const answer = await (bulkPlanTool as ToolEntry).handler(input, owner);
      calls.push({ input: (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>, answer });
      return answer;
    },
  } as ToolEntry;
}

const REFUSED = /^Error: source_list\.form shopify_media writes image alt texts/;
// The note the product rules and the store hint carry on a connection without the image scope.
const NOTED = /Image alt texts: a bulk run cannot change them in this store/;

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
  if (table.length) console.log(`\nbulk_plan image refusal eval (${String(RUNS)} runs per provider)\n${table.join('\n')}`);
});

function transient(err: unknown): boolean {
  return /429|5\d\d|overloaded|rate|timeout/i.test(String((err as { status?: number })?.status ?? err));
}

async function runOnce(provider: string, make: (tools: ToolEntry[]) => Agent, i: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-media-eval-'));
  dirs.push(dir);
  const engineDb = new EngineDb(join(dir, 'engine.db'), 'media-eval-vault-key');
  const calls: Call[] = [];
  const agent = make([
    realBulkPlan(new BulkLedger(engineDb, null), calls),
    { ...(httpRequestTool as ToolEntry), handler: async () => PRODUCTS } as ToolEntry,
    { ...(bulkStatusTool as ToolEntry), handler: async () => 'No bulk runs recorded.' } as ToolEntry,
    { ...(askUserTool as ToolEntry), handler: async () => 'Mach einfach, so wie beschrieben.' } as ToolEntry,
  ]);
  let reply = '';
  let runs = 0;
  try {
    reply = await agent.send(MESSAGE);
    runs = (engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get() as { n: number }).n;
  } catch (err) {
    if (transient(err)) { table.push(`${provider}\t#${String(i)}\tSKIP\ttransient`); return; }
    throw err;
  } finally {
    engineDb.close();
  }
  // Reached: the refusal or the note, whichever came first. After it, any further plan counts:
  // another form is a way out that does not exist, the image form again is a retry.
  const refusedAt = calls.findIndex((c) => REFUSED.test(c.answer) || NOTED.test(c.answer));
  const replanned = refusedAt === -1 ? 0 : calls.slice(refusedAt + 1).length;
  const how = refusedAt === -1 ? 'none' : REFUSED.test(calls[refusedAt]!.answer) ? 'refusal' : 'note';
  const dump = process.env['MEDIA_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ provider, run: i, reached: how, replanned, runs, calls, reply })}\n`);
  const verdict = refusedAt === -1 ? 'NO-REFUSAL' : replanned > 0 || runs > 0 ? 'FAIL' : 'JUDGE';
  table.push(`${provider}\t#${String(i)}\t${verdict}\tvia=${how} replanned=${String(replanned)} runs=${String(runs)}\t${reply.replace(/\s+/g, ' ').slice(0, 160)}`);
  expect(refusedAt, 'neither the refusal nor the note reached the model').not.toBe(-1);
  expect(replanned, 'a plan was tried again after the refusal or the note').toBe(0);
  expect(runs).toBe(0);
}

const runs = Array.from({ length: RUNS }, (_, i) => ({ i, label: `image refusal #${String(i)}` }));
const base = { maxIterations: 8, systemPrompt: SYSTEM, promptUser: async () => 'ok', promptSecret: async () => ({ status: 'canceled' as const }) };

let anthropicKey: string | undefined;
try { anthropicKey = getApiKey(); } catch { anthropicKey = undefined; }
describe.skipIf(!anthropicKey)('bulk_plan image refusal — Anthropic (Haiku)', () => {
  it.each(runs)('$label', async ({ i }) => {
    await runOnce('haiku', (tools) => new Agent({ ...base, tools, name: 'media-haiku', model: HAIKU, apiKey: anthropicKey!, provider: 'anthropic', toolContext: createToolContext({}) }), i);
  }, 180_000);
});

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY)('bulk_plan image refusal — Mistral (mistral-large-2512)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$label', async ({ i }) => {
    await runOnce('mistral', (tools) => new Agent({
      ...base, tools, name: 'media-mistral', model: 'mistral-large-2512', provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: 'mistral-large-2512', toolContext: createToolContext({}),
    }), i);
  }, 180_000);
});
