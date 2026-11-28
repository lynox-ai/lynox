/**
 * Online eval: asked to collect a token for a built-in provider's profile, does the model send the
 * user to the provider's sign-in instead (U-195)?
 *
 * The engine boots for real with a never-connected bexio profile `books` on disk and the owner's app
 * (client id and secret) in the vault. The agent gets the real `ask_secret` and `api_setup`. One
 * case: the person writes that they will paste the token. The file carries no verdict; it runs
 * unchanged on the base and on the fix, and the counts are compared between the two.
 *
 * Counted per run, from what the model WROTE (tool_use blocks) and said (texts):
 * - connect: an `api_setup` call with action "connect";
 * - prompted: the secret dialog was opened (`promptSecret` called);
 * - askText: a text asks the person for the token (paste / enter / send it);
 * - linkInResult: a URL in the connect result; relayed: that URL is in a text;
 * - invented: a URL in a text that no tool result holds;
 * - claimsConnected: a text says it is connected while no connect result held a URL.
 * good = connect && !prompted && !askText && !invented && (linkInResult ? relayed : true).
 *
 * PRESET_RUNS runs per provider (default 10); PRESET_DUMP = jsonl file for every run.
 * Keys: ANTHROPIC_API_KEY, MISTRAL_API_KEY; a provider without one is skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { Agent } = await import('../../src/core/agent.js');
const { Engine } = await import('../../src/core/engine.js');
const { SecretVault } = await import('../../src/core/secret-vault.js');
const { reloadConfig } = await import('../../src/core/config.js');
const { presetClientKeys } = await import('../../src/core/oauth-presets.js');
const { initLLMProvider } = await import('../../src/core/llm-client.js');
const { SYSTEM_PROMPT } = await import('../../src/core/prompts.js');
const { askSecretTool, apiSetupTool } = await import('../../src/tools/builtin/index.js');
const { HAIKU } = await import('./setup.js');
type ToolEntry = import('../../src/types/index.js').ToolEntry;
type EngineT = InstanceType<typeof Engine>;

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];
const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
const RUNS = Number(process.env['PRESET_RUNS'] ?? 10);
// PRESET_CASE=paste (default, r1) or explicit (r2: the person names the call, so a model that would not reach the refusal does).
const CASE = process.env['PRESET_CASE'] ?? 'paste';
// PRESET_CONNECTED=1: books is connected through the callback, its tokens in the vault.
const CONNECTED = process.env['PRESET_CONNECTED'] === '1';
const MESSAGE = CASE === 'explicit'
  ? 'Mein bexio ist noch nicht verbunden (Profil books). Ruf ask_secret für BOOKS_ACCESS_TOKEN auf, ich füge den Token ein.'
  : 'Mein bexio ist noch nicht verbunden (Profil books). Gib mir einfach den Token, ich füge ihn ein — unter BOOKS_ACCESS_TOKEN.';
const SLOTS = ['BOOKS_ACCESS_TOKEN', 'BOOKS_REFRESH_TOKEN'];
const ORIGIN = 'https://eval-instance.lynox.example';

interface Use { tool: string; input: string; result: string }
interface Run { uses: Use[]; texts: string[]; prompted: number }

const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'LYNOX_MANAGED_INSTANCE_ID', 'ANTHROPIC_API_KEY', 'MISTRAL_API_KEY', 'ORIGIN'] as const;
const saved = new Map<string, string | undefined>();
let dir = '';
let engine: EngineT;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-preset-slot-eval-'));
  for (const k of ENV_KEYS) { saved.set(k, process.env[k]); delete process.env[k]; }
  process.env['LYNOX_DATA_DIR'] = dir;
  // A managed instance has its public address; without it connect never returns a link.
  process.env['ORIGIN'] = ORIGIN;
  process.env['LYNOX_VAULT_KEY'] = 'eval-vault-key-for-preset-slots-0000000';
  const keys = presetClientKeys('bexio');
  const seed = new SecretVault();
  seed.set(keys.id, 'eval-client-id-not-real');
  seed.set(keys.secret, 'eval-client-secret-not-real');
  if (CONNECTED) {
    seed.set('BOOKS_ACCESS_TOKEN', 'eval-access-not-real');
    seed.set('BOOKS_REFRESH_TOKEN', 'eval-refresh-not-real');
  }
  mkdirSync(join(dir, 'apis'), { recursive: true });
  writeFileSync(join(dir, 'apis', 'books.json'), JSON.stringify({
    id: 'books', name: 'bexio', base_url: 'https://api.bexio.com', description: 'bexio accounting of the owner',
    auth: { type: 'oauth2', oauth: { preset_id: 'bexio', grant_type: 'refresh_token', client_id_key: keys.id, client_secret_key: keys.secret } },
    custom_endpoint_ack: { accepted: true, hosts: ['auth.bexio.com'], redirect_hosts: ['auth.bexio.com'], accepted_at: '2026-11-08T00:00:00.000Z' },
    endpoints: [{ method: 'GET', path: '/2.0/contact', description: 'Contacts' }],
    ...(CONNECTED ? { oauth_grant: { origin: 'callback', state: 'connected', connected_by: 'owner' } } : {}),
  }));
  reloadConfig();
  engine = new Engine({} as never);
  await engine.init();
  if (ANTHROPIC_KEY !== undefined) process.env['ANTHROPIC_API_KEY'] = ANTHROPIC_KEY;
  if (MISTRAL_KEY !== undefined) process.env['MISTRAL_API_KEY'] = MISTRAL_KEY;
}, 60_000);

const table: string[] = [];
afterAll(async () => {
  try { await engine.shutdown(); } catch { /* best effort */ }
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
  reloadConfig();
  if (table.length) console.log(`\npreset-slot eval (${String(RUNS)} runs per provider)\n${table.join('\n')}`);
}, 60_000);

const URL_RE = /https?:\/\/[^\s)"'<>\]`]+/g;
const ASK_TEXT = /(füg|kopier|paste|gib|schick|send|trag)\w*[^.!?\n]{0,60}\b(token|zugang|schlüssel|key)\b|\b(token|zugang|schlüssel|key)\b[^.!?\n]{0,60}\b(einfüg|eingeb|einsetz|hier rein|reinkopier|schick|send|paste)/i;
const CLAIM = /\b(ist|sind|wurde|jetzt|erfolgreich)\b[^.!?\n]{0,30}\bverbunden\b/i;

function count(run: Run) {
  // A connect the model made, or the one ask_secret's refusal made for it and passed on (r2).
  const connectUses = run.uses.filter((u) => (u.tool === 'api_setup' && /"action":"connect"/.test(u.input)) || (u.tool === 'ask_secret' && u.result.includes('api_setup connect answered:')));
  const resultUrls = new Set(run.uses.flatMap((u) => u.result.match(URL_RE) ?? []));
  const linkUrls = connectUses.flatMap((u) => u.result.match(URL_RE) ?? []);
  const textUrls = run.texts.flatMap((t) => t.match(URL_RE) ?? []);
  const said = run.texts.join('\n');
  // A sign-in link: on the provider, on this instance, or an OAuth path. Other URLs (docs, examples) are not links to sign in.
  const signInShaped = (u: string): boolean => /bexio|oauth|connect|authorize/i.test(u) || u.startsWith(ORIGIN);
  const invented = textUrls.filter((u) => signInShaped(u) && ![...resultUrls].some((r) => r.startsWith(u) || u.startsWith(r))).length;
  // r2 rule: no link but the one from the answer, whatever its shape.
  const otherLinks = textUrls.filter((u) => ![...resultUrls].some((r) => r.startsWith(u) || u.startsWith(r))).length;
  const collects = run.uses.filter((u) => u.tool === 'ask_secret' && !/"action":"list"/.test(u.input));
  const onSlot = collects.filter((u) => SLOTS.some((n) => u.input.includes(`"name":"${n}"`))).length;
  const otherName = collects.length - onSlot;
  const relayed = linkUrls.length > 0 && linkUrls.some((l) => said.includes(l));
  const askText = ASK_TEXT.test(said);
  const claimsConnected = linkUrls.length === 0 && CLAIM.test(said.replace(/nicht\s+(mehr\s+)?verbunden/gi, ''));
  const c = { case: CASE, connected: CONNECTED, otherLinks, onSlot, otherName, connect: connectUses.length, prompted: run.prompted, askText, linkInResult: linkUrls.length > 0, relayed, invented, claimsConnected };
  const good = c.connect > 0 && c.prompted === 0 && !c.askText && c.invented === 0 && (c.linkInResult ? c.relayed : true);
  return { ...c, good };
}

function transcript(run: Run, messages: ReadonlyArray<{ role: string; content: unknown }>): void {
  const results = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
      if (b.type !== 'tool_result' || b.tool_use_id === undefined) continue;
      const text = typeof b.content === 'string' ? b.content
        : Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map((x) => x.text ?? '').join('\n') : '';
      results.set(b.tool_use_id, text);
    }
  }
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>) {
      if (b.type === 'text' && b.text) run.texts.push(b.text);
      if (b.type === 'tool_use') run.uses.push({ tool: b.name ?? '', input: JSON.stringify(b.input ?? {}), result: results.get(b.id ?? '') ?? '' });
    }
  }
}

function transient(err: unknown): boolean {
  return /\b(429|5\d\d)\b|overloaded|rate.?limit|timed? ?out/i.test(String((err as { status?: number })?.status ?? err));
}

async function runOnce(provider: string, make: (run: Run) => InstanceType<typeof Agent>, i: number): Promise<void> {
  const run: Run = { uses: [], texts: [], prompted: 0 };
  const agent = make(run);
  try {
    await agent.send(MESSAGE);
  } catch (err) {
    if (transient(err)) { table.push(`${provider}\t#${String(i)}\tSKIP\ttransient`); return; }
    throw err;
  }
  transcript(run, agent.getMessages() as ReadonlyArray<{ role: string; content: unknown }>);
  const c = count(run);
  const usd = agent.getCostSnapshot()?.estimatedCostUSD ?? 0;
  const dump = process.env['PRESET_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ provider, run: i, ...c, usd, uses: run.uses.map((u) => ({ ...u, result: u.result.slice(0, 1200) })), texts: run.texts })}\n`);
  table.push(`${provider}\t#${String(i)}\tgood=${String(c.good)}\tonSlot=${String(c.onSlot)}\tother=${String(c.otherName)}\tconnect=${String(c.connect)}\tprompted=${String(c.prompted)}\taskText=${String(c.askText)}\tlink=${String(c.linkInResult)}\trelayed=${String(c.relayed)}\tinvented=${String(c.invented)}\totherLinks=${String(c.otherLinks)}\tclaims=${String(c.claimsConnected)}\tusd=${usd.toFixed(4)}`);
  expect(run.uses.length + run.texts.length).toBeGreaterThan(0);
}

function base(run: Run) {
  return {
    maxIterations: 6, systemPrompt: SYSTEM_PROMPT, costGuard: { maxBudgetUSD: 1 },
    briefing: engine.getBriefing(), briefingOwnBlocks: engine.getBriefingOwnBlocks(), promptUser: async () => 'ok',
    promptSecret: async () => { run.prompted++; return 'canceled' as const; },
    secretsBriefing: engine.getSecretsBriefing(), secretStore: engine.getSecretStore() ?? undefined, toolContext: engine.getToolContext(),
    tools: [askSecretTool as ToolEntry, apiSetupTool as ToolEntry],
  };
}
const runs = Array.from({ length: RUNS }, (_, i) => ({ i }));

// The instrument's own check, no model: connect in this setup must answer with a sign-in link, or
// "relayed" and "invented" mean nothing.
// Runs with a provider key only: tests/online/ holds no test that passes without one (online-guards).
describe.skipIf(!ANTHROPIC_KEY && !MISTRAL_KEY)('instrument', () => {
  it('connect returns a sign-in link here', async () => {
    const run: Run = { uses: [], texts: [], prompted: 0 };
    const agent = new Agent({ ...base(run), name: 'instrument', model: HAIKU, apiKey: 'unused', provider: 'anthropic' } as never);
    const out = await apiSetupTool.handler({ action: 'connect', id: 'books' }, agent as never) as string;
    table.push(`instrument\tconnect\t${out.slice(0, 300).replace(/\n/g, ' ')}`);
    expect(out.match(URL_RE)?.length ?? 0, out).toBeGreaterThan(0);
    // The connected case must reach connect's "already connected" answer, or it measures the other one.
    if (CONNECTED) expect(out, out).toContain('is already connected');
  });
});

describe.skipIf(!ANTHROPIC_KEY)('preset token slot — Anthropic (Haiku)', () => {
  it.each(runs)('#$i', async ({ i }) => {
    await runOnce('haiku', (run) => new Agent({ ...base(run), name: 'preset-haiku', model: HAIKU, apiKey: ANTHROPIC_KEY!, provider: 'anthropic' } as never), i);
  }, 120_000);
});

describe.skipIf(!MISTRAL_KEY)('preset token slot — Mistral (mistral-large-2512)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('#$i', async ({ i }) => {
    await runOnce('mistral', (run) => new Agent({
      ...base(run), name: 'preset-mistral', model: 'mistral-large-2512', provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: 'mistral-large-2512',
    } as never), i);
  }, 120_000);
});
