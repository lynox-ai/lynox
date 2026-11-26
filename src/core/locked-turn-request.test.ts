/**
 * A locked turn's requests, as they leave the engine (U-185). A REAL Engine,
 * Session and Agent run the setup a helper's turn ran in an earlier eval (S1: a Shopify store,
 * walked through the docs, a profile bootstrapped and created, a key asked for), with every
 * (tool, action) pair that turn called. Only the provider's stream and the network are stubbed:
 * the search provider, the reranker, the page read, the docs fetch and the docs extraction.
 *
 * The check is over every request the agent sent in the turn (system, tool definitions, the
 * messages): no text there sends the model to collect a key with `ask_secret`. The tool keeps its
 * name, and the locked texts that say it stores nothing are allowed by their exact words; no
 * other mention of the name may remain, and no known paraphrase of the step.
 *
 * What this shows is that the texts this script reaches are swapped. It does not show that no
 * other text exists: a path this script does not take is not read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Script { events: Array<Record<string, unknown>>; yielded: number }

const { calls, scripts } = vi.hoisted(() => ({
  calls: [] as Array<{ params: unknown }>,
  scripts: [] as Script[],
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        stream: (params: unknown) => ({
          // Helper calls of the run read the whole message at once; they are not the agent's.
          finalMessage: async () => ({ content: [{ type: 'text', text: '' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
          [Symbol.asyncIterator]() {
            calls.push({ params });
            const script = scripts.shift();
            if (!script) throw new Error('no scripted reply left');
            return {
              next: async () => (script.yielded < script.events.length
                ? { done: false, value: script.events[script.yielded++] }
                : { done: true, value: undefined }),
              return: async () => ({ done: true, value: undefined }),
            };
          },
        }),
      },
    };
  }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

// The docs page bootstrap fetches, and the extraction it runs over it.
vi.mock('../tools/builtin/http.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tools/builtin/http.js')>();
  return {
    ...real,
    fetchWithValidatedRedirects: async (url: string, ...rest: Parameters<typeof real.fetchWithValidatedRedirects> extends [unknown, ...infer R] ? R : never) => {
      if (!url.startsWith('https://shopify.dev/')) return real.fetchWithValidatedRedirects(url, ...rest);
      return { response: new Response('<html><head><title>Shopify Admin API</title></head><body><h1>Admin API</h1><p>Authenticate with an access token in the X-Shopify-Access-Token header.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }), finalUrl: url };
    },
  };
});
vi.mock('./llm-helper.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./llm-helper.js')>();
  return {
    ...real,
    callForStructuredJson: async (opts: Parameters<typeof real.callForStructuredJson>[0]) => {
      if (!opts.system.startsWith('You read API documentation pages')) return real.callForStructuredJson(opts);
      return { data: { description: 'Shopify Admin API', auth: { type: 'header', header_name: 'X-Shopify-Access-Token' }, endpoints: [], guidelines: [], avoid: [], notes: [] }, inputTokens: 1, outputTokens: 1, costUsd: 0 };
    },
  };
});
vi.mock('../integrations/search/search-reranker.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../integrations/search/search-reranker.js')>();
  return { ...real, rerankSearchResults: async (_q: string, results: unknown[]) => ({ results }) };
});

import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { DuckDuckGoProvider } from '../integrations/search/search-provider.js';
import * as extractor from '../integrations/search/content-extractor.js';
import { MANDATE_SECRET_REFUSAL } from '../tools/builtin/ask-secret.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import type { LynoxConfig } from '../types/config.js';

const MANDATE = { kind: 'mandate', email: 'setup@example.org', display: 'Setup Partner', mandateId: 'M-1', mandateExp: Math.floor(Date.now() / 1000) + 30 * 86400 } as RequestPrincipal;
const usage = { input_tokens: 100, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null };

function toolCall(id: string, name: string, input: Record<string, unknown>): void {
  scripts.push({ yielded: 0, events: [
    { type: 'message_start', message: { usage: { ...usage } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ] });
}
function textReply(text: string): void {
  scripts.push({ yielded: 0, events: [
    { type: 'message_start', message: { usage: { ...usage } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ] });
}

/**
 * The S1 turn: every (tool, action) pair the earlier eval's runs called (`toolCalls` of the
 * valid arms), each once, and what its result must carry to show it reached its success path.
 * connect is the one called on its error path. A result that starts with `Error:` elsewhere fails.
 */
const PROFILE = {
  id: 'shop-admin', name: 'Shop Admin', base_url: 'https://acme.myshopify.com/admin/api/2025-01', description: 'Shopify Admin API of the acme store',
  auth: { type: 'header', header_name: 'X-Shopify-Access-Token', vault_keys: ['SHOP_ADMIN_TOKEN'] },
  endpoints: [{ method: 'GET', path: '/products.json', description: 'List products' }],
  guidelines: ['Use the versioned path.'],
  avoid: ['Do not page past 250 items per call.'],
};
/** With the exchange switched on, a Shopify profile goes through the built-in preset only. */
const PRESET_PROFILE = {
  id: 'shop-admin', name: 'Shop Admin', base_url: 'https://acme.myshopify.com/admin/api/2026-10', description: 'Shopify Admin API of the acme store',
  auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: 'acme' }, scope: 'read_products' } },
};
const s1For = (exchange: string | undefined): typeof S1 => S1.map((c) => (c.id === 's4' && exchange !== undefined
  ? { ...c, input: { action: 'create', profile: PRESET_PROFILE } }
  : c));
const S1: ReadonlyArray<{ id: string; tool: string; input: Record<string, unknown>; reached: string }> = [
  { id: 's1', tool: 'web_research', input: { action: 'search', query: 'Shopify custom app access token OAuth scopes' }, reached: 'source="web_search"' },
  { id: 's2', tool: 'web_research', input: { action: 'read', url: 'https://shopify.dev/docs/api/admin-rest' }, reached: 'source="web_page"' },
  { id: 's3', tool: 'api_setup', input: { action: 'bootstrap', docs_url: 'https://shopify.dev/docs/api/admin-rest' }, reached: 'Bootstrapped draft profile' },
  { id: 's4', tool: 'api_setup', input: { action: 'create', profile: PROFILE }, reached: 'Next steps:' },
  { id: 's5', tool: 'ask_user', input: { question: 'Which store?' }, reached: 'acme' },
  { id: 's6', tool: 'ask_secret', input: { action: 'collect', name: 'SHOP_ADMIN_TOKEN', prompt: 'Paste the Shopify token' }, reached: MANDATE_SECRET_REFUSAL },
  { id: 's7', tool: 'ask_secret', input: { name: 'SHOP_ADMIN_TOKEN', prompt: 'Shopify Admin API token' }, reached: MANDATE_SECRET_REFUSAL },
  { id: 's8', tool: 'ask_secret', input: { action: 'list' }, reached: 'not listed in this session' },
  { id: 's9', tool: 'api_setup', input: { action: 'connect', id: 'shop-admin' }, reached: 'Error:' },
];

/**
 * The texts that name the tool and say it does not help there: allowed by their exact words. The
 * last one is the answer for a name a helper's profile may not read (`withheldText`), which a
 * locked turn reaches on a preset profile; it says asking does not change it, which stays true.
 */
const ALLOWED = [
  'Asking for the value with ask_secret does not change this.',
  'In this session ask_secret stores nothing and opens no input: it returns how a key gets stored here.',
  '3. `ask_secret` stores nothing in this session and opens no input; its result says how the key gets stored.',
];
const OWNER_RULE_1 = '1. Collect credentials ONLY via `ask_secret`.';
const LOCKED_RULE_1 = '1. This session runs for a person the owner let in, not for the owner.';

/** The step said another way. Calibrated: none of these is in a locked request. */
const PARAPHRASES: readonly RegExp[] = [
  /secure (?:prompt|dialog|input|field)/i,
  /secret prompt/i,
  /sichere (?:Abfrage|Eingabe)/i,
  /(?<!\b(?:never|not|n't) )\b(?:ask|have) (?:the user|them)\b[^.]{0,80}\b(?:provide|store|enter|paste)\b[^.]{0,60}\b(?:key|token|secret|credential)/i,
];

/** Every string the requests carry, by where it sits: the tool name aside. */
function textsOf(params: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key: string): void => {
    if (typeof v === 'string') { if (key !== 'name') out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  const p = params as { system?: unknown; tools?: unknown; messages?: unknown };
  walk(p.system, 'system'); walk(p.tools, 'tools'); walk(p.messages, 'messages');
  return out;
}
function findings(texts: readonly string[]): string[] {
  const hits: string[] = [];
  for (const t of texts) {
    let rest = t;
    for (const a of ALLOWED) rest = rest.split(a).join('');
    for (const m of rest.matchAll(/ask_secret/g)) hits.push(`ask_secret: …${rest.slice(Math.max(0, m.index - 60), m.index + 40)}…`);
    for (const re of PARAPHRASES) { const m = re.exec(rest); if (m) hits.push(`paraphrase: ${m[0]}`); }
  }
  return hits;
}

const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'ANTHROPIC_API_KEY', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_EMBEDDING_PROVIDER', 'LYNOX_SHOPIFY_EXCHANGE', 'SEARXNG_URL', 'ORIGIN', 'ANTHROPIC_BASE_URL', 'LYNOX_BILLING_TIER'] as const;
const saved = new Map<string, string | undefined>();
const dirs: string[] = [];
const engines: Engine[] = [];
function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

beforeEach(() => {
  calls.length = 0;
  scripts.length = 0;
  vi.spyOn(DuckDuckGoProvider.prototype, 'search').mockResolvedValue([
    { title: 'Shopify access scopes', url: 'https://docs.example.invalid/api/access-scopes', snippet: 'read_products write_products' },
    // The page s2 reads: a search listed it, so the read after the search's foreign content passes
    // the origin check, which a locked turn would otherwise refuse (this script is about its texts).
    { title: 'Shopify Admin REST API', url: 'https://shopify.dev/docs/api/admin-rest', snippet: 'Admin REST API reference' },
  ]);
  vi.spyOn(extractor, 'extractContent').mockResolvedValue({
    title: 'Shopify Admin REST API', url: 'https://shopify.dev/docs/api/admin-rest', wordCount: 40, content: 'Create a custom app, then copy the Admin API access token.', truncated: false,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
  engines.length = 0;
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  saved.clear();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  reloadConfig();
}, 30_000);

async function runS1(principal: RequestPrincipal, exchange: string | undefined): Promise<{ texts: string[]; results: Map<string, string>; requests: number; snapshot: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-locked-'));
  dirs.push(dir);
  for (const k of ENV_KEYS) setEnv(k, undefined);
  setEnv('LYNOX_DATA_DIR', dir);
  setEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  setEnv('LYNOX_EMBEDDING_PROVIDER', 'local');
  setEnv('ORIGIN', 'https://tenant.lynox.example');
  setEnv('LYNOX_SHOPIFY_EXCHANGE', exchange);
  reloadConfig();
  const engine = new Engine({} as LynoxConfig);
  engines.push(engine);
  await engine.init();
  // The pool supplies the model key, as on a customer's managed instance: the provider list a
  // switched-on exchange applies admits only that key. Set after the start, which would
  // otherwise wire the managed hook to a control plane this test does not have.
  setEnv('LYNOX_BILLING_TIER', 'managed');
  engine.getMandateEnds()?.record(MANDATE as never, Math.floor(Date.now() / 1000));
  const session = engine.createSession({ principal } as never);
  // A person at the screen who answers: the store, and yes to what a save asks.
  session.promptUser = async (_q: unknown, options?: string[]): Promise<string> =>
    options && options.length > 0 ? (options.find((o) => !/deny|decline|cancel|no\b/i.test(o)) ?? options[0]!) : 'acme';
  for (const c of s1For(exchange)) toolCall(c.id, c.tool, c.input);
  textReply('Done.');
  await session.run('Verbinde meinen Shopify-Store acme.', { principal });
  const results = new Map<string, string>();
  for (const m of session.getAgent()!.getMessages() as Array<{ content: unknown }>) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type: string; tool_use_id?: string; content?: unknown }>) {
      if (b.type !== 'tool_result') continue;
      const c = b.content;
      results.set(b.tool_use_id ?? '', typeof c === 'string' ? c : JSON.stringify(c));
    }
  }
  // The prompt the run history records for this run: the one the turn was sent.
  const history = engine.getRunHistory()!;
  const run = history.getRecentRuns(1, 0, { sessionId: session.sessionId })[0]!;
  const snapshot = history.getPromptSnapshot(run.prompt_hash)?.prompt_text ?? '';
  return { texts: calls.flatMap((c) => textsOf(c.params)), results, requests: calls.length, snapshot };
}

describe('a locked S1 turn sends no text that collects a key with ask_secret', { timeout: 120_000 }, () => {
  it.each([['off', undefined], ['on', '1']] as const)('LYNOX_SHOPIFY_EXCHANGE %s', async (_label, exchange) => {
    const locked = await runS1(MANDATE, exchange);
    // Every call reached the path it is here for: its marker, and no error but connect's.
    expect(locked.requests).toBe(S1.length + 1);
    for (const c of s1For(exchange)) {
      const r = locked.results.get(c.id) ?? '';
      // connect on the preset profile may hand out its link, or say why not: either is its answer.
      if (c.id === 's9') { expect(r.includes('Error:') || r.includes('/api/oauth/connect/'), `${c.id}: ${r.slice(0, 200)}`).toBe(true); continue; }
      expect(r, `${c.id} ${c.tool}`).toContain(c.reached);
      if (c.reached !== 'Error:') expect(r.trimStart().startsWith('Error:'), `${c.id} ${c.tool}: ${r.slice(0, 200)}`).toBe(false);
    }
    expect(findings(locked.texts)).toEqual([]);
    // The run history records the prompt the locked turn was sent, not the owner's.
    expect(locked.snapshot).toContain(LOCKED_RULE_1);
    expect(locked.snapshot).not.toContain(OWNER_RULE_1);

    // Positive control on the same machinery: the owner's same turn carries the owner's texts,
    // and the check finds them.
    calls.length = 0;
    const owner = await runS1(OWNER_PRINCIPAL, exchange);
    const hits = findings(owner.texts);
    expect(owner.snapshot).toContain(OWNER_RULE_1);
    expect(owner.snapshot).not.toContain(LOCKED_RULE_1);
    expect(hits.filter((h) => h.startsWith('ask_secret:')).length).toBeGreaterThan(10);
    expect(hits.some((h) => h.startsWith('paraphrase:'))).toBe(true);
  });

  it('the check finds a reworded step that does not name the tool', () => {
    expect(findings(['When the token is ready, have the user enter the API token in the secure input.'])).toEqual([
      'paraphrase: secure input',
      'paraphrase: have the user enter the API token',
    ]);
    expect(findings(['Then collect it with ask_secret.'])).toHaveLength(1);
    expect(findings([ALLOWED[0]!, ALLOWED[1]!])).toEqual([]);
    // A ban is not the step: the connect guidance says never to ask for a pasted token.
    expect(findings(['never ask the user to paste a token for a profile that can connect'])).toEqual([]);
  });
});
