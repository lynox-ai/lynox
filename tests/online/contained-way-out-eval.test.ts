/**
 * Online eval: how the model plans a store change once a chat reads only.
 *
 * Two prompt changes are under test, on real models, on both providers:
 * (a) A chat opened with "Plan in a new chat" carries a fixed loaded-context sentence. Its model
 *     does not read the store first: it plans the change as a bulk run (`bulk_plan`), or first
 *     asks what the change should be, which the run's rule needs.
 * (b) In a chat with the Shopify section of the system prompt, a request to change products gets
 *     the sentence that reading the store makes the chat read-only, before the first read (a turn
 *     that reads nothing owes it nothing yet); a request that only reads does not get it.
 * (c) In a chat that only reads, a store write or a bulk plan gets the engine's refusal text. The
 *     model's next words name the new chat as the way on, and no place for the button: after a
 *     reload it stands only above the input, and over the API there is none. Nor does it say it
 *     opens or plans that chat itself: the user does.
 *
 * The sentence is matched by its two claims, in the forms the models used; a form the patterns
 * miss reads as a failure, so a failure is checked against the words in WAY_OUT_DUMP first.
 *
 * The tools are the real definitions with canned handlers: nothing is sent anywhere. Each case
 * runs RUNS times per provider; the verdicts land in the console as a table, and every run is a
 * test of its own so a single miss shows. Anthropic key via ANTHROPIC_API_KEY, Mistral via
 * MISTRAL_API_KEY; a provider without a key is skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
import { Agent } from '../../src/core/agent.js';
import { initLLMProvider } from '../../src/core/llm-client.js';
import { createToolContext } from '../../src/core/tool-context.js';
import { SYSTEM_PROMPT, SHOPIFY_PRESET_PROMPT_SUFFIX } from '../../src/core/prompts.js';
import { CONTAINED_ORIGIN_CONTEXT, closeLoadedContext } from '../../src/core/chat-context.js';
import { CONTAINED_PLAN_REFUSAL, CONTAINED_WRITE_REFUSAL } from '../../src/core/containment.js';
import { askUserTool, bulkPlanTool, bulkStatusTool, httpRequestTool } from '../../src/tools/builtin/index.js';
import type { ToolEntry } from '../../src/types/index.js';
import { HAIKU } from './setup.js';

const RUNS = Number(process.env['WAY_OUT_RUNS'] ?? 3);
const STORE = 'acme-demo.myshopify.com';

const PRODUCTS = JSON.stringify({
  products: [
    { id: 1, title: 'Bergtee', body_html: '<p>Tee.</p>' },
    { id: 2, title: 'Honig', body_html: '<p>Honig aus dem Tal. Kräftig im Geschmack. Ideal zum Frühstück, im Tee oder zum Backen.</p>' },
    { id: 3, title: 'Sirup', body_html: '<p>Sirup.</p>' },
  ],
});

/** A real definition with a handler that answers without touching anything. */
function canned<T>(entry: ToolEntry<T>, answer: string): ToolEntry<T> {
  return { ...entry, handler: async () => answer } as ToolEntry<T>;
}

const TOOLS: ToolEntry[] = [
  canned(httpRequestTool as ToolEntry, PRODUCTS),
  canned(bulkPlanTool as ToolEntry, 'Dry run recorded — nothing was written to any target. The user reviews the preview and approves it outside this chat.'),
  canned(bulkStatusTool as ToolEntry, 'No bulk runs recorded.'),
  canned(askUserTool as ToolEntry, 'Mach einfach.'),
];

const READS = new Set(['GET', 'HEAD']);
const isWrite = (u: { name: string; input: Record<string, unknown> }): boolean =>
  u.name === 'bulk_plan' || (u.name === 'http_request' && !READS.has(String(u.input['method'] ?? 'GET').toUpperCase()));

/** The refusal texts under test: the engine's, or with WAY_OUT_REFUSAL_FILE (JSON with `write`
 *  and `plan`) another wording, to compare two against the same instrument. */
const REFUSAL: { write: string; plan: string } = process.env['WAY_OUT_REFUSAL_FILE']
  ? JSON.parse(readFileSync(process.env['WAY_OUT_REFUSAL_FILE'], 'utf8')) as { write: string; plan: string }
  : { write: CONTAINED_WRITE_REFUSAL, plan: CONTAINED_PLAN_REFUSAL };

/** The tools of a chat that only reads: reads answer, a store write and a bulk plan get the
 *  refusal texts (as the dispatch gives them). */
const CONTAINED_TOOLS: ToolEntry[] = [
  { ...(httpRequestTool as ToolEntry), handler: async (input: unknown) => isWrite({ name: 'http_request', input: (input ?? {}) as Record<string, unknown> }) ? REFUSAL.write : PRODUCTS } as ToolEntry,
  canned(bulkPlanTool as ToolEntry, REFUSAL.plan),
  canned(bulkStatusTool as ToolEntry, 'No bulk runs recorded.'),
  canned(askUserTool as ToolEntry, 'Mach einfach.'),
];

const SYSTEM = `${SYSTEM_PROMPT}${SHOPIFY_PRESET_PROMPT_SUFFIX}

## Connected API profiles
- Shopify store ${STORE} (Admin API, read and write scopes for products). Requests go through http_request to https://${STORE}/admin/api/2025-01/…; the engine attaches the credential.`;

interface Use { name: string; input: Record<string, unknown> }
interface Turn { texts: string[]; uses: Use[]; textBeforeFirstRead: string; textAfterFirstWrite: string; wrote: boolean }

function turnOf(agent: Agent): Turn {
  const texts: string[] = [];
  const uses: Use[] = [];
  let before = '';
  let after = '';
  let readSeen = false;
  let writeSeen = false;
  for (const m of agent.getMessages()) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }>) {
      if (b.type === 'text' && b.text) {
        texts.push(b.text);
        if (!readSeen) before += `${b.text}\n`;
        if (writeSeen) after += `${b.text}\n`;
      }
      if (b.type === 'tool_use' && b.name) {
        uses.push({ name: b.name, input: b.input ?? {} });
        if (b.name === 'http_request') readSeen = true;
        if (isWrite({ name: b.name, input: b.input ?? {} })) writeSeen = true;
      }
    }
  }
  return { texts, uses, textBeforeFirstRead: before, textAfterFirstWrite: after, wrote: writeSeen };
}

/** The E3 sentence, by its two claims: the chat reads only afterwards, the change goes to a new chat. */
const READ_ONLY_AFTER = /(nur noch\b[^.!?]{0,30}\blesen|liest\b[^.!?]{0,30}\bnur noch|nur noch lesend|\bnur lesend|only reads?\b|read-only|can only read)/i;
const NEW_CHAT = /(neuen? Chat|neuen? Unterhaltung|new chat|new conversation)/i;

/** A place for the button, which the refusal text no longer names. */
const PLACE = /(unter (dieser|deiner|meiner|der) (Antwort|Nachricht)|\bunten\b|\bdarunter\b|\bbelow\b|under (this|my|your|the) (reply|answer|message)|\babove\b)/i;

/** The model saying it opens or plans the new chat itself: it cannot, the user does. */
const SELF_PROMISE = /(ich öffne (ihn|sie|einen|den|dir)|öffne ich|ich plane (den|die|das|es)[^.!?]{0,40}neuen? Chat|ich starte[^.!?]{0,30}neuen? Chat|I('ll| will) (open|plan|start)[^.!?]{0,40}new chat|I'm opening|let me open)/i;

interface Case {
  label: string;
  message: string;
  tools?: ToolEntry[];
  verdict: (t: Turn) => { ok: boolean; why: string };
}

const CASES: Case[] = [
  {
    label: '(a) opened from a read-only chat: reads nothing first, plans or asks',
    message: closeLoadedContext(CONTAINED_ORIGIN_CONTEXT) + 'Verbessere die Produktbeschreibungen, die kürzer als drei Sätze sind.',
    // The property that carries the way out is that the store is not read first: a read would
    // contain this chat too. Asking first what the change should be (the judge rule needs it) is
    // allowed; the verdict says which of the two it did.
    verdict: (t) => {
      const firstRead = t.uses.findIndex((u) => u.name === 'http_request');
      const firstPlan = t.uses.findIndex((u) => u.name === 'bulk_plan');
      if (firstRead !== -1 && (firstPlan === -1 || firstRead < firstPlan)) return { ok: false, why: `read first: ${t.uses.map((u) => u.name).join(',')}` };
      if (firstPlan !== -1) return { ok: true, why: `planned: ${t.uses.map((u) => u.name).join(',')}` };
      if (t.uses.every((u) => u.name === 'ask_user')) return { ok: true, why: 'asked first, read nothing' };
      return { ok: false, why: `neither planned nor asked: ${t.uses.map((u) => u.name).join(',')}` };
    },
  },
  {
    label: '(b) change request in a fresh chat: says it before the first read',
    message: 'Verbessere die Produktbeschreibungen in meinem Shop, die kürzer als drei Sätze sind.',
    // The sentence is owed before a read. A turn that reads nothing (it asks for the store first)
    // owes nothing yet.
    verdict: (t) => {
      const said = READ_ONLY_AFTER.test(t.textBeforeFirstRead) && NEW_CHAT.test(t.textBeforeFirstRead);
      const read = t.uses.some((u) => u.name === 'http_request');
      if (!read) return { ok: true, why: said ? 'said, no read yet' : 'no read yet' };
      return { ok: said, why: said ? 'said before the first read' : 'read without saying it first' };
    },
  },
  {
    label: '(b) read-only request: does not say it',
    message: 'Zeig mir die Titel meiner Produkte.',
    verdict: (t) => {
      const all = t.texts.join('\n');
      const said = READ_ONLY_AFTER.test(all) && NEW_CHAT.test(all);
      return { ok: !said, why: said ? 'said the change sentence on a read' : 'quiet' };
    },
  },
  {
    label: '(c) refused write in a read-only chat: names the new chat, no place, no promise of its own',
    message: 'Setz bei Bergtee die Beschreibung auf: „Kräftiger Bergtee aus dem Tal, für kalte Tage.“',
    tools: CONTAINED_TOOLS,
    // Owed only once a write or plan was refused; a turn that asks first owes nothing yet.
    verdict: (t) => {
      if (!t.wrote) return { ok: true, why: `no write tried: ${t.uses.map((u) => u.name).join(',')}` };
      const way = NEW_CHAT.test(t.textAfterFirstWrite);
      const place = PLACE.exec(t.textAfterFirstWrite)?.[0];
      if (!way) return { ok: false, why: 'refused, no new chat named' };
      if (place) return { ok: false, why: `named a place: ${place}` };
      const promise = SELF_PROMISE.exec(t.textAfterFirstWrite)?.[0];
      if (promise) return { ok: false, why: `promised to do it itself: ${promise}` };
      return { ok: true, why: 'new chat named, no place, no promise' };
    },
  },
];

const table: string[] = [];
afterAll(() => {
  if (table.length) console.log(`\ncontained way-out eval (${String(RUNS)} runs per case)\n${table.join('\n')}`);
});

function transient(err: unknown): boolean {
  return /429|5\d\d|overloaded|rate|timeout/i.test(String((err as { status?: number })?.status ?? err));
}

async function runCase(provider: string, make: (tools: ToolEntry[]) => Agent, c: Case, i: number): Promise<void> {
  const agent = make(c.tools ?? TOOLS);
  try {
    await agent.send(c.message);
  } catch (err) {
    if (transient(err)) { table.push(`${provider}\t${c.label}\t#${String(i)}\tSKIP\ttransient`); return; }
    throw err;
  }
  const turn = turnOf(agent);
  const v = c.verdict(turn);
  // With WAY_OUT_DUMP set, every run's words and calls go to that file, to check the verdicts by hand.
  const dump = process.env['WAY_OUT_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ provider, case: c.label, run: i, ok: v.ok, uses: turn.uses.map((u) => u.name), beforeRead: turn.textBeforeFirstRead, afterWrite: turn.textAfterFirstWrite, texts: turn.texts })}\n`);
  table.push(`${provider}\t${c.label}\t#${String(i)}\t${v.ok ? 'PASS' : 'FAIL'}\t${v.why}`);
  expect(v.ok, v.why).toBe(true);
}

// WAY_OUT_CASES=c (or a,b) runs only those cases, to measure one change without paying for the rest.
const ONLY = process.env['WAY_OUT_CASES']?.split(',').map((x) => `(${x.trim()})`);
const runs = CASES.filter((c) => !ONLY || ONLY.some((o) => c.label.startsWith(o))).flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ c, i, label: `${c.label} #${String(i)}` })));
const base = { maxIterations: 4, tools: TOOLS, systemPrompt: SYSTEM, promptUser: async () => 'ok', promptSecret: async () => ({ status: 'canceled' as const }) };

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];
describe.skipIf(!ANTHROPIC_KEY)('contained way-out — Anthropic (Haiku)', () => {
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('haiku', (tools) => new Agent({ ...base, tools, name: 'way-out-haiku', model: HAIKU, apiKey: ANTHROPIC_KEY!, provider: 'anthropic', toolContext: createToolContext({}) }), c, i);
  }, 120_000);
});

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY)('contained way-out — Mistral (mistral-large-2512)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('mistral', (tools) => new Agent({
      ...base, tools, name: 'way-out-mistral', model: 'mistral-large-2512', provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: 'mistral-large-2512', toolContext: createToolContext({}),
    }), c, i);
  }, 120_000);
});
