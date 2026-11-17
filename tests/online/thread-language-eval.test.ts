/**
 * Online eval: does a chat answer, its follow-up chips and the thread title come in the language
 * the user wrote in?
 *
 * Seen on a staging instance: an English message got a Portuguese title, and one English turn got
 * German chips under an English answer. Measured before the fix (dev keys, this file's old arm):
 * the Anthropic preset's main model answered English questions in German in most runs, its chips
 * with it; the Fireworks presets' fast model titled English messages in German, Portuguese,
 * Russian or Romanian in about half its runs.
 *
 * TURN: one user message, stamped as the session stamps it (`withCurrentTimePrefix`, Europe/Zurich,
 *   and in the new arm the language `messageLanguage` reads from it), sent with `SYSTEM_PROMPT` and
 *   the Web UI suffix and the `suggest_follow_ups` tool, to each preset's main model. Pass: the
 *   answer text and every chip (label and task) read as the message's language. A run without
 *   answer text or without chips is counted, not graded. Left out: the session's other prompt
 *   parts (memory, briefing, date block, other tools).
 * TITLE: the title call as the session sends it (`llmTitlePrompt` + the message; old arm the
 *   general `LLM_TITLE_PROMPT`), to each preset's fast model. Pass: a judge (see `JUDGE_MODEL`, its
 *   controls run first) reads the title as the message's language.
 *
 * EVAL_ARM=old reproduces the defect on the same messages. Bars (new arm, EVAL_RUNS >= 6): at least
 * 90 % of the graded runs per model and case, and at least a third of the runs graded.
 * Keys: ANTHROPIC_API_KEY (Sonnet 5, Haiku 4.5), FIREWORKS_API_KEY (glm-5p3, minimax-m3,
 * deepseek-v4p1-flash-1017, the judge). Raw results go to EVAL_DUMP.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLLMClient, initLLMProvider } from '../../src/core/llm-client.js';
import { SYSTEM_PROMPT, WEB_UI_SYSTEM_PROMPT_SUFFIX, withCurrentTimePrefix } from '../../src/core/prompts.js';
import { suggestFollowUpsTool } from '../../src/tools/builtin/suggest-follow-ups.js';
import { LLM_TITLE_PROMPT, llmTitlePrompt, sanitizeLLMTitle } from '../../src/core/session.js';
import { messageLanguage, type MessageLanguage } from '../../src/core/message-language.js';
import { HAIKU } from './setup.js';

const RUNS = Number(process.env['EVAL_RUNS'] ?? 6);
const ARM = process.env['EVAL_ARM'] === 'old' ? 'old' : 'new';
const GATED = ARM === 'new' && RUNS >= 6;
const DUMP = process.env['EVAL_DUMP'] ?? join(tmpdir(), 'thread-language-eval.jsonl');
const FIREWORKS_BASE = 'https://api.fireworks.ai/inference/v1';
// EVAL_NO_ANTHROPIC=1 leaves the Anthropic models out (a key at its workspace limit).
const ANTHROPIC_KEY = process.env['EVAL_NO_ANTHROPIC'] === '1' ? undefined : process.env['ANTHROPIC_API_KEY'];
const FIREWORKS_KEY = process.env['FIREWORKS_API_KEY'];

const EN: readonly string[] = [
  'What should I check before raising my prices by 5 %?',
  'Give me three ideas for a newsletter subject line about our spring sale.',
  'Explain in two sentences what a VAT reverse charge is.',
  'Please draft a short quote for Nordglas GmbH for 20 hours of consulting.',
  'Please make exactly these three tool calls, one after the other, without asking: 1) api_setup with action "list". 2) api_setup with action "view" and id "does-not-exist". 3) read_file with path "/workspace/does-not-exist.txt". Then reply in one short sentence.',
  'Summarize what I should know about the open invoices from Keller AG in Zürich.',
];
const DE: readonly string[] = [
  'Was sollte ich prüfen, bevor ich meine Preise um 5 % erhöhe?',
  'Gib mir drei Ideen für eine Newsletter-Betreffzeile zu unserem Frühlingsverkauf.',
  'Erkläre in zwei Sätzen, was das Reverse-Charge-Verfahren bei der Mehrwertsteuer ist.',
  'Schreib mir bitte eine kurze Offerte für die Keller AG über 20 Stunden Beratung.',
  'Welche Rechnungen sollte ich diesen Monat noch nachfassen, und wie formuliere ich die Mahnung?',
  'Plane einen Massenlauf für meinen Shopify-Shop: bessere SEO-Titel für alle aktiven Produkte.',
];
for (const [want, set] of [['en', EN], ['de', DE]] as const) {
  for (const m of set) if (messageLanguage(m) !== want) throw new Error(`case message not read as ${want}: ${m}`);
}

/** Function-word grader for the answer text and the chips (long enough for it); `?` = undecided. */
const DE_W = new Set(['der', 'den', 'dem', 'des', 'das', 'und', 'oder', 'ist', 'sind', 'wird', 'hat', 'haben', 'nicht', 'kein', 'keine', 'ein', 'eine', 'einen', 'einem', 'einer', 'mit', 'für', 'von', 'vom', 'zum', 'zur', 'im', 'auf', 'bei', 'nach', 'aus', 'über', 'alle', 'wir', 'unsere', 'nur', 'auch', 'wenn', 'wie', 'zu', 'meine', 'meinen', 'mein', 'deine', 'dein', 'ich', 'du', 'dir', 'dich', 'welche', 'erstelle', 'zeige', 'prüfe', 'schreibe', 'erkläre', 'ob', 'diese', 'dieser', 'sie', 'ihr', 'ihre']);
const EN_W = new Set(['the', 'a', 'and', 'or', 'is', 'are', 'be', 'has', 'have', 'not', 'no', 'with', 'for', 'of', 'to', 'from', 'by', 'on', 'at', 'all', 'each', 'every', 'its', 'their', 'they', 'it', 'we', 'our', 'only', 'when', 'how', 'my', 'your', 'i', 'you', 'which', 'what', 'create', 'show', 'check', 'write', 'explain', 'whether', 'into', 'about', 'this', 'that', 'these']);
function textLanguage(t: string): MessageLanguage | '?' {
  let de = 0;
  let en = 0;
  for (const raw of t.split(/[^\p{L}']+/u)) {
    if (raw.length === 0) continue;
    const w = raw.toLowerCase();
    if (DE_W.has(w)) de += 1;
    else if (EN_W.has(w)) en += 1;
    else if (/^[a-zäöüß]+$/.test(raw) && /[äöüß]/.test(raw)) de += 1;
  }
  return de > en ? 'de' : en > de ? 'en' : '?';
}
const GRADER_CONTROLS: ReadonlyArray<readonly [string, MessageLanguage]> = [
  ['A/B-Test-Varianten erstellen. Erstelle drei Varianten der Betreffzeile für einen A/B-Test.', 'de'],
  ['Details zu einem Profil. Zeige die Konfigurationsdetails des API-Profils dataforseo an.', 'de'],
  ['List the 12 API profiles. Show the details of the 12 registered API profiles.', 'en'],
  ['Beim VAT Reverse Charge stellt der Lieferant seine Rechnung ohne Mehrwertsteuer aus.', 'de'],
  ['The VAT reverse charge shifts the responsibility for reporting VAT from the seller to the buyer.', 'en'],
];
for (const [t, want] of GRADER_CONTROLS) if (textLanguage(t) !== want) throw new Error(`grader control failed: ${t}`);

type Client = ReturnType<typeof createLLMClient>;
interface Row { model: string; arm: string; case: string; run: number; ok: boolean | null; why: string; out: unknown }
const rows: Row[] = [];
function record(r: Row): void {
  rows.push(r);
  appendFileSync(DUMP, `${JSON.stringify(r)}\n`);
}
function transient(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return /overloaded|rate.?limit|timed? ?out|API error (429|5\d\d)/i.test(String(err));
}

function stamped(message: string): string {
  const language = ARM === 'new' ? messageLanguage(message) : null;
  return withCurrentTimePrefix(message, 'Europe/Zurich', language) as string;
}

async function runTurn(model: string, client: Client, want: MessageLanguage, run: number, message: string): Promise<void> {
  const name = `TURN-${want.toUpperCase()}`;
  let text = '';
  let chips: Array<{ label?: unknown; task?: unknown }> | null = null;
  try {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 6000,
      system: SYSTEM_PROMPT + WEB_UI_SYSTEM_PROMPT_SUFFIX,
      messages: [{ role: 'user', content: stamped(message) }],
      tools: [suggestFollowUpsTool.definition],
    });
    const response = await stream.finalMessage();
    text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim();
    const call = response.content.find((b) => b.type === 'tool_use' && b.name === suggestFollowUpsTool.definition.name);
    const input = call && call.type === 'tool_use' ? call.input as { suggestions?: unknown } : undefined;
    chips = Array.isArray(input?.suggestions) && input.suggestions.length > 0 ? input.suggestions as Array<{ label?: unknown; task?: unknown }> : null;
  } catch (err) {
    if (transient(err)) { record({ model, arm: ARM, case: name, run, ok: null, why: `SKIP transient: ${String(err).slice(0, 120)}`, out: null }); return; }
    throw err;
  }
  const answer = text === '' ? null : textLanguage(text) === want;
  record({ model, arm: ARM, case: `${name}-answer`, run, ok: answer, why: text === '' ? 'no answer text' : `answer ${textLanguage(text)}`, out: text.slice(0, 300) });
  const chipLangs = chips?.map((c) => textLanguage(`${String(c.label ?? '')}. ${String(c.task ?? '')}`)) ?? null;
  // A chip too short for the grader (`?`) does not fail the set; one in the other language does.
  const chipsOk = chipLangs === null ? null : chipLangs.some((l) => l === want) && chipLangs.every((l) => l === want || l === '?');
  record({ model, arm: ARM, case: `${name}-chips`, run, ok: chipsOk, why: chipLangs === null ? 'no chips' : `chips ${chipLangs.join(',')}`, out: chips });
}

/**
 * The title judge: Fireworks deepseek-v4p1-flash (reasoning off, as the adapter sends small calls).
 * It was Claude Haiku until the Anthropic dev key ran out. Before the switch this judge read the 48
 * titles of an old-arm run as Haiku had, all 48, the six wrong-language ones among them; numbers
 * from the two judges are reported apart. It grades its own model's titles too: the controls and
 * that comparison are what that rests on.
 */
const JUDGE_MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash-1017';
let judge: Client | null = null;
async function titleLanguage(title: string): Promise<string> {
  const stream = judge!.beta.messages.stream({
    model: JUDGE_MODEL,
    max_tokens: 8,
    messages: [{ role: 'user', content: `Which language are the ordinary words of this short title in? Ignore names of companies, products and places entirely: "Weber GmbH Bern Payment Reminder" is English because of "Payment Reminder", "Acme Inc Lieferschein" is German because of "Lieferschein". Answer with exactly one word: German, English, or Other.\n\nTitle: ${title}` }],
  });
  const response = await stream.finalMessage();
  const block = response.content.find((b) => b.type === 'text');
  const word = (block && block.type === 'text' ? block.text : '').trim().toLowerCase();
  return word.startsWith('german') ? 'de' : word.startsWith('english') ? 'en' : 'other';
}
const JUDGE_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['Sequência de três chamadas de ferramentas', 'other'],
  ['Три инструментальных вызова подряд', 'other'],
  ['Nordglas GmbH Angebot erstellen', 'de'],
  ['Keller AG Zürich offene Rechnungen', 'de'],
  ['Nordglas Consulting Quote Draft', 'en'],
  ['Keller AG Zürich Open Invoices', 'en'],
  ['Offerte für die Keller AG', 'de'],
];

async function runTitle(model: string, client: Client, want: MessageLanguage, run: number, message: string): Promise<void> {
  const name = `TITLE-${want.toUpperCase()}`;
  let title = '';
  try {
    const prompt = ARM === 'new' ? llmTitlePrompt(message) : LLM_TITLE_PROMPT;
    const stream = client.beta.messages.stream({ model, max_tokens: 64, messages: [{ role: 'user', content: prompt + message.slice(0, 2000) }] });
    const response = await stream.finalMessage();
    const block = response.content.find((b) => b.type === 'text');
    title = sanitizeLLMTitle(block && block.type === 'text' ? block.text : '');
  } catch (err) {
    if (transient(err)) { record({ model, arm: ARM, case: name, run, ok: null, why: `SKIP transient: ${String(err).slice(0, 120)}`, out: null }); return; }
    throw err;
  }
  if (title === '') { record({ model, arm: ARM, case: name, run, ok: null, why: 'no title (the placeholder stays)', out: '' }); return; }
  const got = await titleLanguage(title);
  record({ model, arm: ARM, case: name, run, ok: got === want, why: `title ${got}`, out: title });
}

function tally(model: string, c: string): { pass: number; graded: number; of: number } {
  const mine = rows.filter((r) => r.model === model && r.case === c);
  const graded = mine.filter((r) => r.ok !== null);
  return { pass: graded.filter((r) => r.ok === true).length, graded: graded.length, of: mine.length };
}
function report(model: string, c: string): void {
  const t = tally(model, c);
  console.log(`[thread-language] ${model} ${ARM} ${c}: ${t.pass}/${t.graded} in the message's language (${t.of - t.graded} not graded)`);
  if (GATED) {
    // Sonnet 5 often ends the turn with a chip call and no answer text, in both arms (10 and 12 of
    // 16 in a side count): those runs say nothing about the language, so the bar asks for a third.
    expect(t.graded).toBeGreaterThanOrEqual(Math.ceil(t.of / 3));
    expect(t.pass).toBeGreaterThanOrEqual(Math.ceil(0.9 * t.graded));
  }
}

beforeAll(async () => {
  if (!FIREWORKS_KEY) return;
  await initLLMProvider('openai');
  judge = createLLMClient({ provider: 'openai', apiKey: FIREWORKS_KEY, apiBaseURL: FIREWORKS_BASE, openaiModelId: JUDGE_MODEL });
  for (const [title, want] of JUDGE_CONTROLS) {
    const got = await titleLanguage(title);
    if (got !== want) throw new Error(`judge control failed: "${title}" read as ${got}, not ${want}`);
  }
});
afterAll(() => { console.log(`[thread-language] dump: ${DUMP}`); });

function turnSuite(provider: 'anthropic' | 'openai', model: string, makeClient: () => Client): void {
  let client: Client;
  beforeAll(async () => { await initLLMProvider(provider); client = makeClient(); });
  for (const [want, set] of [['en', EN], ['de', DE]] as const) {
    it(`a ${want} message gets its answer and chips in ${want} (${ARM} arm)`, async () => {
      await Promise.all(Array.from({ length: RUNS }, (_, i) => runTurn(model, client, want, i, set[i % set.length]!)));
      report(model, `TURN-${want.toUpperCase()}-answer`);
      report(model, `TURN-${want.toUpperCase()}-chips`);
    }, 900_000);
  }
}

function titleSuite(provider: 'anthropic' | 'openai', model: string, makeClient: () => Client): void {
  let client: Client;
  beforeAll(async () => { await initLLMProvider(provider); client = makeClient(); });
  for (const [want, set] of [['en', EN], ['de', DE]] as const) {
    it(`a ${want} first message gets a ${want} title (${ARM} arm)`, async () => {
      for (let i = 0; i < RUNS; i++) await runTitle(model, client, want, i, set[i % set.length]!);
      report(model, `TITLE-${want.toUpperCase()}`);
    }, 600_000);
  }
}

const fireworks = (model: string) => (): Client => createLLMClient({ provider: 'openai', apiKey: FIREWORKS_KEY!, apiBaseURL: FIREWORKS_BASE, openaiModelId: model });
const anthropic = (): Client => createLLMClient({ provider: 'anthropic', apiKey: ANTHROPIC_KEY! });

describe.skipIf(!ANTHROPIC_KEY)('thread language — claude-sonnet-5 (main)', () => turnSuite('anthropic', 'claude-sonnet-5', anthropic));
describe.skipIf(!FIREWORKS_KEY)('thread language — glm-5p3 (main)', () => turnSuite('openai', 'accounts/fireworks/models/glm-5p3', fireworks('accounts/fireworks/models/glm-5p3')));
describe.skipIf(!FIREWORKS_KEY)('thread language — minimax-m3 (main)', () => turnSuite('openai', 'accounts/fireworks/models/minimax-m3', fireworks('accounts/fireworks/models/minimax-m3')));
describe.skipIf(!ANTHROPIC_KEY || !FIREWORKS_KEY)(`thread language — ${HAIKU} (title)`, () => titleSuite('anthropic', HAIKU, anthropic));
describe.skipIf(!FIREWORKS_KEY)('thread language — deepseek-v4p1-flash-1017 (title)', () => titleSuite('openai', 'accounts/fireworks/models/deepseek-v4p1-flash-1017', fireworks('accounts/fireworks/models/deepseek-v4p1-flash-1017')));
