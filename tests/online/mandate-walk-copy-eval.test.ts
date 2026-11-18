/**
 * Online eval (U-256): what the chat tells the person after `task_create` holds back a scheduled
 * agent task until the owner confirms it, and the language of a thread's title.
 *
 * M: the chat runs as a mandate (a helper with delegated access). The helper asks, in German, for a
 *    weekly report every Monday at 07:00 that lynox runs. `task_create` is the real tool on a real
 *    TaskManager in a temp directory; its report says the owner confirms under Automation ›
 *    Triggers and the helper cannot. Pass: a trigger was created through task_create, the answer
 *    after the first task_create call asks the helper to confirm nothing themselves, and names the
 *    owner as the one who confirms. Counted, not judged: whether it names the place
 *    (Automation › Triggers, the Trigger tab).
 *    When the first turn makes no trigger (the model asks where the data lives), the chat gets one
 *    scripted German follow-up (`FOLLOW_UP`), which also answers any ask_user; the dump marks it.
 *    Each tool call is dumped with the result the model received (600 characters).
 * O: control for M, the same message from the owner. Pass: a trigger was created, the answer tells
 *    the user they confirm it, names Triggers, and says no owner confirms it.
 * T: the title path as the session runs it: `llmTitlePrompt(message)` + the first message, one direct
 *    messages call (max_tokens 64) through the provider's client, then `sanitizeLLMTitle`. Five
 *    German first messages (T-de, gating) and two English ones (T-en, control, no pass bar).
 *
 * The verdicts are patterns (mandate-walk-copy-grader.ts); its controls run when this file loads,
 * so a broken grader fails the file before any model call, keys or not. The raw answers are in
 * EVAL_DUMP (one JSON line per run) to be read by hand.
 *
 * Runs per case and provider: EVAL_RUNS (default 10). T-de spreads its runs over the five
 * messages, T-en runs each English message once per provider. The pass bars (M, O, T-de: at least
 * 9 of 10 per provider) are asserted only when EVAL_RUNS >= 10; a single run never fails on its
 * own. Keys: ANTHROPIC_API_KEY (Claude Haiku 4.5), MISTRAL_API_KEY (mistral-medium-2604); a
 * provider without a key is skipped. EVAL_CASES=M,O,T runs only those.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../../src/core/agent.js';
import { createLLMClient, initLLMProvider } from '../../src/core/llm-client.js';
import { createToolContext } from '../../src/core/tool-context.js';
import { SYSTEM_PROMPT, WEB_UI_SYSTEM_PROMPT_SUFFIX, currentDateContext } from '../../src/core/prompts.js';
import { RunHistory } from '../../src/core/run-history.js';
import { EngineDb } from '../../src/core/engine-db.js';
import { TaskManager } from '../../src/core/task-manager.js';
import { llmTitlePrompt, sanitizeLLMTitle } from '../../src/core/session.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from '../../src/core/request-principal.js';
import { askUserTool, taskCreateTool, taskListTool } from '../../src/tools/builtin/index.js';
import type { ToolEntry } from '../../src/types/index.js';
import { testAuditLog } from '../helpers/audit-log.js';
import { HAIKU } from './setup.js';
import { controlFailures, namesPlace, titleLanguage, verdictMandate, verdictOwner, type Verdict } from './mandate-walk-copy-grader.js';

// The grader is checked on known sentences when the file loads, before a single model call.
const broken = controlFailures();
if (broken.length > 0) throw new Error(`grader controls failed: ${broken.join('; ')}`);

const RUNS = Number(process.env['EVAL_RUNS'] ?? 10);
const GATED = RUNS >= 10;
const DUMP = process.env['EVAL_DUMP'] ?? join(tmpdir(), 'mandate-walk-copy-eval.jsonl');
const MISTRAL_MODEL = 'mistral-medium-2604';
const MISTRAL_BASE = 'https://api.mistral.ai/v1';
const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'helper@example.org', mandateId: 'grant-1' };

const MESSAGE = 'Hallo, ich helfe hier bei der Buchhaltung mit. Richte bitte einen Wochenbericht ein, den lynox jeden Montag um 07:00 Uhr erstellt: Umsatz der Vorwoche pro Produktgruppe, als kurze Zusammenfassung.';

const TITLE_DE = [
  'Kannst du mir eine Offerte für die Firma Keller AG schreiben? 20 Stunden Beratung zu 140 CHF, zahlbar in 30 Tagen.',
  'Ich muss den Lagerbestand für unsere Gartenmöbel prüfen. Welche Artikel haben weniger als 5 Stück an Lager?',
  'Schreib bitte eine freundliche Zahlungserinnerung an einen Kunden, dessen Rechnung seit drei Wochen offen ist.',
  'Hilf mir, einen Newsletter für unsere Herbstaktion zu entwerfen: 15 % Rabatt auf alle Wanderschuhe bis Ende Oktober.',
  'Wie viele Kundenanfragen haben wir diese Woche erhalten, und welche sind noch unbeantwortet?',
];
const TITLE_EN = [
  'Can you draft a short reply to a supplier who is two weeks late with our delivery?',
  'Please summarize last month\'s sales by product category for our team meeting.',
];

const SYSTEM = `${SYSTEM_PROMPT}${WEB_UI_SYSTEM_PROMPT_SUFFIX}${currentDateContext()}`;

type CaseKey = 'M' | 'O' | 'T-de' | 'T-en';
interface Row { model: string; case: CaseKey; run: number; ok: boolean; why: string; answer?: string; title?: string; place?: boolean; followUp?: boolean; toolCalls: Call[] }
const rows: Row[] = [];

function record(row: Row): void {
  rows.push(row);
  appendFileSync(DUMP, `${JSON.stringify(row)}\n`);
}

let root = '';
afterAll(() => {
  if (rows.length > 0) {
    const lines: string[] = [];
    const keys = [...new Set(rows.map((r) => `${r.model}\t${r.case}`))];
    for (const k of keys) {
      const [model, c] = k.split('\t') as [string, CaseKey];
      const of = rows.filter((r) => r.model === model && r.case === c && !r.why.startsWith('SKIP'));
      const pass = of.filter((r) => r.ok).length;
      const place = c === 'M' ? `\tplace named ${String(of.filter((r) => r.place === true).length)}/${String(of.length)}` : '';
      lines.push(`${model}\t${c}\t${String(pass)}/${String(of.length)}${place}`);
    }
    console.log(`\nmandate walk copy eval (EVAL_RUNS=${String(RUNS)}, dump ${DUMP})\n${rows.map((r) => `${r.model}\t${r.case}\t#${String(r.run)}\t${r.ok ? 'PASS' : 'FAIL'}\t${r.why}`).join('\n')}\n\nsummary\n${lines.join('\n')}`);
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

function transient(err: unknown): boolean {
  const busy = (code: number): boolean => code === 429 || code >= 500;
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') return busy(status);
  const text = String(err);
  // The OpenAI-compatible adapter puts the status in the message: judge by it, not by the body.
  const coded = /API error (\d{3}):/.exec(text);
  if (coded) return busy(Number(coded[1]));
  return /overloaded|rate.?limit|timed? ?out/i.test(text);
}

interface Store { tm: TaskManager; history: RunHistory; close: () => void }
/** A fresh TaskManager per run, on a run history in its own temp directory (as the unit tests). */
function store(tag: string): Store {
  if (!root) root = mkdtempSync(join(tmpdir(), 'mandate-walk-copy-'));
  const dir = mkdtempSync(join(root, `${tag}-`));
  const history = new RunHistory(join(dir, 'h.db'));
  const engine = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engine);
  const tm = new TaskManager(history);
  return { tm, history, close: () => { try { engine.close(); } catch { /* closed */ } history.close(); } };
}

const FOLLOW_UP = 'Die Zahlen liegen in bexio, das ist schon verbunden. Leg die Aufgabe bitte jetzt an.';

interface Call { name: string; input: Record<string, unknown>; result?: string }
type Block = { type?: string; text?: string; name?: string; id?: string; tool_use_id?: string; input?: Record<string, unknown>; content?: unknown };

/** A tool result's text, as the model received it (string, or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return (content as Block[]).map((b) => (b.type === 'text' && b.text ? b.text : '')).join('\n');
  return '';
}

/**
 * Every tool call with the result it got (cut to 600 characters), and the assistant's texts, each
 * marked whether it comes after the first task_create call that did not answer with an error: the
 * answer graded is what the model said once it had the report of a created row.
 */
function transcript(agent: Agent): { toolCalls: Call[]; texts: Array<{ text: string; afterCreate: boolean }> } {
  const results = new Map<string, string>();
  for (const m of agent.getMessages()) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, resultText(b.content));
  }
  const toolCalls: Call[] = [];
  const texts: Array<{ text: string; afterCreate: boolean }> = [];
  let seenCreate = false;
  for (const m of agent.getMessages()) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) {
      if (b.type === 'tool_use' && b.name) {
        const result = b.id !== undefined ? results.get(b.id) : undefined;
        toolCalls.push({ name: b.name, input: b.input ?? {}, ...(result !== undefined ? { result: result.slice(0, 600) } : {}) });
        if (b.name === 'task_create' && result !== undefined && !/^error\b/i.test(result.trim())) seenCreate = true;
      }
      if (b.type === 'text' && b.text) texts.push({ text: b.text, afterCreate: seenCreate });
    }
  }
  return { toolCalls, texts };
}

type Make = (cfg: { tools: ToolEntry[]; toolContext: ReturnType<typeof createToolContext>; principal: RequestPrincipal }) => Agent;

async function runChat(model: string, make: Make, c: 'M' | 'O', i: number): Promise<Verdict | null> {
  const s = store(`${model}-${c}-${String(i)}`);
  const ctx = createToolContext({});
  ctx.taskManager = s.tm;
  // The workflow lookup task_create performs reads engine.db through the run history.
  ctx.runHistory = s.history;
  // A mandate's writes leave rows in the actor trail and are refused without one.
  ctx.auditLog = testAuditLog().log;
  const tools: ToolEntry[] = [
    taskCreateTool as ToolEntry,
    taskListTool as ToolEntry,
    // A question back gets the same answer as the scripted follow-up turn below.
    { ...(askUserTool as ToolEntry), handler: async () => FOLLOW_UP } as ToolEntry,
  ];
  const agent = make({ tools, toolContext: ctx, principal: c === 'M' ? MANDATE : OWNER_PRINCIPAL });
  // One scripted follow-up when the first turn made no trigger (it asked where the data lives).
  let followUp = false;
  try {
    await agent.send(MESSAGE);
    if (s.tm.listTriggers().length === 0) {
      followUp = true;
      await agent.send(FOLLOW_UP);
    }
  } catch (err) {
    s.close();
    if (transient(err)) { rows.push({ model, case: c, run: i, ok: true, why: `SKIP transient: ${String(err).slice(0, 120)}`, toolCalls: [] }); return null; }
    throw err;
  }
  const { toolCalls, texts } = transcript(agent);
  const triggers = s.tm.listTriggers();
  s.close();
  // A trigger exists and task_create was the call that could have made it (the only writer here).
  const created = toolCalls.some((u) => u.name === 'task_create') && triggers.length > 0;
  // The answer after the first task_create call that created a row; without one, everything said.
  const after = texts.filter((t) => t.afterCreate).map((t) => t.text).join('\n');
  const answer = after.length > 0 ? after : texts.map((t) => t.text).join('\n');
  const v = c === 'M' ? verdictMandate(created, answer) : verdictOwner(created, answer);
  record({ model, case: c, run: i, ok: v.ok, why: `${v.why}${followUp ? ' [after follow-up]' : ''}`, answer, place: namesPlace(answer), followUp, toolCalls });
  return v;
}

type TitleClient = { model: string; client: ReturnType<typeof createLLMClient> };

async function runTitle(model: string, tc: TitleClient, c: 'T-de' | 'T-en', i: number, message: string): Promise<void> {
  let title = '';
  try {
    const stream = tc.client.beta.messages.stream({
      model: tc.model,
      max_tokens: 64,
      messages: [{ role: 'user', content: llmTitlePrompt(message) + message.slice(0, 2000) }],
    });
    const response = await stream.finalMessage();
    const block = response.content.find((b) => b.type === 'text');
    title = block && block.type === 'text' ? sanitizeLLMTitle(block.text) : '';
  } catch (err) {
    if (transient(err)) { rows.push({ model, case: c, run: i, ok: true, why: `SKIP transient: ${String(err).slice(0, 120)}`, toolCalls: [] }); return; }
    throw err;
  }
  const want = c === 'T-de' ? 'de' : 'en';
  const got = titleLanguage(title);
  record({ model, case: c, run: i, ok: got === want, why: `${got}: ${title}`, title, toolCalls: [] });
}

const ONLY = process.env['EVAL_CASES']?.split(',').map((x) => x.trim());
const wants = (c: string): boolean => !ONLY || ONLY.includes(c);
const runs = Array.from({ length: RUNS }, (_, i) => ({ i, label: `#${String(i)}` }));
const base = { maxIterations: 6, systemPrompt: SYSTEM, promptUser: async () => FOLLOW_UP, promptSecret: async () => 'canceled' as const };

/** The pass bar, asserted only over a full set of runs. */
function bar(model: string, c: CaseKey): void {
  const of = rows.filter((r) => r.model === model && r.case === c && !r.why.startsWith('SKIP'));
  const pass = of.filter((r) => r.ok).length;
  if (!GATED) return;
  expect(pass, `${model} ${c}: ${String(pass)}/${String(of.length)}`).toBeGreaterThanOrEqual(Math.ceil(of.length * 0.9));
}

function suite(model: string, label: string, makeChat: () => Make, makeTitle: () => TitleClient, provider: 'anthropic' | 'openai'): void {
  describe(label, () => {
    beforeAll(async () => { await initLLMProvider(provider); });
    if (wants('M')) {
      it.each(runs)(`M mandate asks for a weekly report $label`, async ({ i }) => { await runChat(model, makeChat(), 'M', i); }, 180_000);
      it('M pass bar', () => { bar(model, 'M'); });
    }
    if (wants('O')) {
      it.each(runs)(`O owner asks for a weekly report $label`, async ({ i }) => { await runChat(model, makeChat(), 'O', i); }, 180_000);
      it('O pass bar', () => { bar(model, 'O'); });
    }
    if (wants('T')) {
      it.each(runs)(`T-de German first message -> German title $label`, async ({ i }) => {
        await runTitle(model, makeTitle(), 'T-de', i, TITLE_DE[i % TITLE_DE.length]!);
      }, 60_000);
      it('T-de pass bar', () => { bar(model, 'T-de'); });
      it.each(TITLE_EN.map((m, i) => ({ m, i })))('T-en English first message -> English title #$i', async ({ m, i }) => {
        await runTitle(model, makeTitle(), 'T-en', i, m);
      }, 60_000);
    }
  });
}

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];
describe.skipIf(!ANTHROPIC_KEY)('mandate walk copy — Anthropic (Haiku)', () => {
  suite('haiku', 'Claude Haiku 4.5',
    () => ({ tools, toolContext, principal }) => new Agent({ ...base, tools, toolContext, principal, name: 'walk-haiku', model: HAIKU, apiKey: ANTHROPIC_KEY!, provider: 'anthropic' }),
    () => ({ model: HAIKU, client: createLLMClient({ provider: 'anthropic', apiKey: ANTHROPIC_KEY! }) }),
    'anthropic');
});

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY)(`mandate walk copy — Mistral (${MISTRAL_MODEL})`, () => {
  suite('mistral', MISTRAL_MODEL,
    () => ({ tools, toolContext, principal }) => new Agent({
      ...base, tools, toolContext, principal, name: 'walk-mistral', model: MISTRAL_MODEL, provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: MISTRAL_BASE, openaiModelId: MISTRAL_MODEL,
    }),
    () => ({ model: MISTRAL_MODEL, client: createLLMClient({ provider: 'openai', apiKey: MISTRAL_KEY!, apiBaseURL: MISTRAL_BASE, openaiModelId: MISTRAL_MODEL }) }),
    'openai');
});
