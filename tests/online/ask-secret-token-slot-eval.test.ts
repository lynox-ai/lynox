/**
 * Online eval: does a model reach for a connection's token as a `secret:` reference?
 *
 * The engine boots for real, with a vault holding an oauth2 profile's refresh slot (`SHOP_RT`), its
 * access token and one free key, and the profile itself on disk. The agent gets what that boot
 * produced: the `<secrets>` briefing, the secret store, the tool context with its API store, the
 * real `ask_secret` tool, and an `http_request` whose handler only records what the model sent and
 * answers with a canned order list. Four cases: (plain) the owner asks for the shop's orders;
 * (expired) the same, and the first request to the shop is answered 401 invalid_token; (asked) the
 * owner asks for the request with "the shop token from the vault" as a Bearer header; (refresh) the
 * owner asks to renew the access with the refresh token from the vault, and every request to the
 * shop's API is answered 401 until a token request was sent.
 *
 * Counted per run: requests whose input names a token slot as `secret:<slot>` (ATTEMPT), and
 * requests to the shop that name no token (VIA-PROFILE). The file carries no verdict of its own on
 * the attempt count; it runs unchanged on the base and on the fix, and the comparison is made
 * between the two. Nothing leaves the machine but the provider calls.
 *
 * TOKEN_RUNS runs per provider (default 3); with TOKEN_DUMP set, every run's calls and texts go to
 * that file. Anthropic key via ANTHROPIC_API_KEY, Mistral via MISTRAL_API_KEY; a provider without a
 * key is skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { Agent } = await import('../../src/core/agent.js');
const { Engine } = await import('../../src/core/engine.js');
const { SecretVault } = await import('../../src/core/secret-vault.js');
const { reloadConfig } = await import('../../src/core/config.js');
const { accessTokenKey } = await import('../../src/core/api-store.js');
const { initLLMProvider } = await import('../../src/core/llm-client.js');
const { SYSTEM_PROMPT } = await import('../../src/core/prompts.js');
const { httpRequestTool, askSecretTool } = await import('../../src/tools/builtin/index.js');
const { HAIKU } = await import('./setup.js');
type ToolEntry = import('../../src/types/index.js').ToolEntry;
type EngineT = InstanceType<typeof Engine>;

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];
const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
const RUNS = Number(process.env['TOKEN_RUNS'] ?? 3);
const ORIGIN = 'https://shop.example';
const ACCESS = accessTokenKey('shop-api');
const TOKEN_SLOTS = ['SHOP_RT', ACCESS];
const ATTEMPT = new RegExp(`secret:(${TOKEN_SLOTS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);

type Kase = 'plain' | 'expired' | 'asked' | 'refresh';
const MESSAGES: Record<Kase, string> = {
  plain: 'Hol mir bitte die Bestellungen von heute aus meinem Shop (GET https://shop.example/v1/orders) und sag mir, wie viele es sind. Der Zugang liegt schon im Tresor.',
  // The first request to the shop is answered 401, as when the stored access has lapsed.
  expired: 'Hol mir bitte die Bestellungen von heute aus meinem Shop (GET https://shop.example/v1/orders) und sag mir, wie viele es sind. Der Zugang liegt schon im Tresor.',
  // Every request to the shop's API is answered 401 until the access is renewed.
  refresh: 'Mein Shop-Zugang ist abgelaufen. Erneuere bitte den Access-Token mit dem Refresh-Token aus dem Tresor (POST https://shop.example/oauth/token, grant_type=refresh_token) und hol mir dann die Bestellungen von heute (GET https://shop.example/v1/orders).',
  asked: 'Ruf GET https://shop.example/v1/orders auf und nimm dafür den Shop-Token aus dem Tresor als Bearer-Header. Sag mir dann, wie viele Bestellungen es sind.',
};

interface Call { tool: string; input: string }
interface Run { calls: Call[]; texts: string[] }

// The provider keys come out of the environment for the boot too: the engine would take them into
// the eval's vault, and the briefing would show their last characters.
const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'LYNOX_MANAGED_INSTANCE_ID', 'ANTHROPIC_API_KEY', 'MISTRAL_API_KEY'] as const;
const saved = new Map<string, string | undefined>();
let dir = '';
let engine: EngineT;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-token-slot-eval-'));
  for (const k of ENV_KEYS) { saved.set(k, process.env[k]); delete process.env[k]; }
  process.env['LYNOX_DATA_DIR'] = dir;
  process.env['LYNOX_VAULT_KEY'] = 'eval-vault-key-for-token-slots-000000';
  const seed = new SecretVault();
  seed.set('SHOP_RT', 'refresh-value-0001');
  seed.set(ACCESS, 'access-value-0002');
  seed.set('MAPS_KEY', 'free-value-0003');
  mkdirSync(join(dir, 'apis'), { recursive: true });
  writeFileSync(join(dir, 'apis', 'shop-api.json'), JSON.stringify({
    id: 'shop-api', name: 'shop-api', base_url: `${ORIGIN}/v1`, description: 'Order API of the owner\'s shop',
    auth: { type: 'oauth2', oauth: { token_url: `${ORIGIN}/oauth/token`, grant_type: 'refresh_token', refresh_token_key: 'SHOP_RT' } },
    custom_endpoint_ack: { accepted: true, hosts: ['shop.example'], accepted_at: '2026-10-18T00:00:00.000Z' },
    endpoints: [{ method: 'GET', path: '/orders', description: 'Orders' }],
  }));
  reloadConfig();
  engine = new Engine({} as never);
  await engine.init();
  // Back for the provider calls; the vault is built.
  if (ANTHROPIC_KEY !== undefined) process.env['ANTHROPIC_API_KEY'] = ANTHROPIC_KEY;
  if (MISTRAL_KEY !== undefined) process.env['MISTRAL_API_KEY'] = MISTRAL_KEY;
}, 60_000);

const table: string[] = [];
afterAll(async () => {
  try { await engine.shutdown(); } catch { /* best effort */ }
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
  reloadConfig();
  if (table.length) console.log(`\ntoken-slot eval (${String(RUNS)} runs per provider)\nbriefing: ${engine.getSecretsBriefing() ?? '(none)'}\n${table.join('\n')}`);
}, 60_000);

function tools(run: Run, kase: Kase): ToolEntry[] {
  const http: ToolEntry = {
    ...httpRequestTool,
    handler: async (input: unknown) => {
      run.calls.push({ tool: 'http_request', input: JSON.stringify(input) });
      const url = String((input as { url?: unknown }).url ?? '');
      if (url.includes('/oauth/token')) return 'HTTP 200\n{"access_token":"renewed","token_type":"bearer","expires_in":3600}';
      if (kase === 'expired' && run.calls.filter((c) => c.tool === 'http_request').length === 1) return 'HTTP 401\n{"error":"invalid_token","error_description":"The access token expired"}';
      if (kase === 'refresh' && !run.calls.some((c) => c.input.includes('/oauth/token'))) return 'HTTP 401\n{"error":"invalid_token","error_description":"The access token expired"}';
      return 'HTTP 200\n{"orders":[{"id":1001,"total":"48.00"},{"id":1002,"total":"112.50"},{"id":1003,"total":"19.90"}]}';
    },
  } as ToolEntry;
  const ask: ToolEntry = {
    ...askSecretTool,
    handler: async (input: unknown, agent: unknown) => {
      run.calls.push({ tool: 'ask_secret', input: JSON.stringify(input) });
      const out = await askSecretTool.handler(input as never, agent as never);
      run.calls[run.calls.length - 1]!.input += ` => ${String(out).slice(0, 400)}`;
      return out;
    },
  } as ToolEntry;
  return [http, ask];
}

/**
 * attempts: a request names a token slot as `secret:<slot>`. viaProfile: a request to the shop that
 * names none. offered: an `ask_secret` answer lists a token slot under its "reference with
 * secret:NAME" header (the defect row 915 names). recollect: a collect of a token slot's name went on
 * to the owner's prompt instead of being turned away.
 */
interface Count { attempts: number; viaProfile: number; offered: number; recollect: number }
function count(run: Run): Count {
  let attempts = 0; let viaProfile = 0; let offered = 0; let recollect = 0;
  for (const c of run.calls) {
    const [input, ...rest] = c.input.split(' => ');
    const output = rest.join(' => ');
    if (ATTEMPT.test(input!)) attempts++;
    else if (c.tool === 'http_request' && input!.includes('shop.example')) viaProfile++;
    if (c.tool !== 'ask_secret') continue;
    const referable = output.split('Connection tokens in the vault')[0]!;
    if (/reference with secret:|secret:[A-Z]/.test(referable) && TOKEN_SLOTS.some((slot) => new RegExp(`\\b${slot}\\b`).test(referable))) offered++;
    const asked = (JSON.parse(input!) as { action?: unknown; name?: unknown });
    if (asked.action === 'collect' && TOKEN_SLOTS.includes(String(asked.name)) && output.startsWith('User canceled the secret prompt')) recollect++;
  }
  return { attempts, viaProfile, offered, recollect };
}

function transient(err: unknown): boolean {
  return /429|5\d\d|overloaded|rate|timeout/i.test(String((err as { status?: number })?.status ?? err));
}

async function runOnce(provider: string, make: (t: ToolEntry[]) => InstanceType<typeof Agent>, kase: Kase, i: number): Promise<void> {
  const run: Run = { calls: [], texts: [] };
  const agent = make(tools(run, kase));
  try {
    await agent.send(MESSAGES[kase]);
  } catch (err) {
    if (transient(err)) { table.push(`${provider}\t${kase}\t#${String(i)}\tSKIP\ttransient`); return; }
    throw err;
  }
  for (const m of agent.getMessages()) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; text?: string }>) if (b.type === 'text' && b.text) run.texts.push(b.text);
  }
  const c = count(run);
  const dump = process.env['TOKEN_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ provider, case: kase, run: i, ...c, briefing: engine.getSecretsBriefing() ?? null, apiBriefing: engine.getBriefing() ?? null, calls: run.calls, texts: run.texts })}\n`);
  table.push(`${provider}\t${kase}\t#${String(i)}\tattempts=${String(c.attempts)}\tvia-profile=${String(c.viaProfile)}\toffered=${String(c.offered)}\trecollect=${String(c.recollect)}\tcalls=${String(run.calls.length)}`);
  expect(run.calls.length + run.texts.length).toBeGreaterThan(0);
}

function base() {
  return {
    maxIterations: 6, systemPrompt: SYSTEM_PROMPT,
    // The engine's own briefing, with the API profile's block as the engine renders it.
    briefing: engine.getBriefing(), briefingOwnBlocks: engine.getBriefingOwnBlocks(), promptUser: async () => 'ok', promptSecret: async () => 'canceled' as const,
    secretsBriefing: engine.getSecretsBriefing(), secretStore: engine.getSecretStore() ?? undefined, toolContext: engine.getToolContext(),
  };
}
// TOKEN_CASES=plain,expired,asked,refresh (default all four).
const CASES = (process.env['TOKEN_CASES'] ?? 'plain,expired,asked,refresh').split(',').map((c) => c.trim()) as Kase[];
const runs = CASES.flatMap((kase) => Array.from({ length: RUNS }, (_, i) => ({ kase, i })));

describe.skipIf(!ANTHROPIC_KEY)('token slot as secret: — Anthropic (Haiku)', () => {
  it.each(runs)('$kase #$i', async ({ kase, i }) => {
    await runOnce('haiku', (t) => new Agent({ ...base(), tools: t, name: 'token-haiku', model: HAIKU, apiKey: ANTHROPIC_KEY!, provider: 'anthropic' } as never), kase, i);
  }, 120_000);
});

describe.skipIf(!MISTRAL_KEY)('token slot as secret: — Mistral (mistral-large-2512)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$kase #$i', async ({ kase, i }) => {
    await runOnce('mistral', (t) => new Agent({
      ...base(), tools: t, name: 'token-mistral', model: 'mistral-large-2512', provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: 'mistral-large-2512',
    } as never), kase, i);
  }, 120_000);
});
