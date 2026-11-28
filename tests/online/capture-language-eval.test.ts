/**
 * Online eval: the language of a fact the capture pass remembers.
 *
 * The capture pass runs after a turn on the fast model, with `CAPTURE_SYSTEM`, the excerpt from
 * `buildCaptureExcerpt` and the forced `CAPTURE_TOOL`, as `agent.ts` sends it. A German staging
 * instance kept twelve of twelve facts in English ("The operator requires a preview …"), shown
 * under the answer as "gemerkt — …".
 *
 * DE: five German turns, each with a fact worth keeping. Pass: the pass returned at least one
 *     fact, every fact reads as German, and no fact names the person by an excerpt label
 *     ("operator", "user"), which would show in the chip. A run with no fact is `empty`, a miss.
 *     The label check applies to EN and MAIL too.
 * EN: four English turns, the other direction: every fact must read as English. Two of them name
 *     German places and company forms ("Germany", "GmbH"); a first wording that named German in
 *     its example turned those German on deepseek, so this case is gated like DE.
 * MAIL: German turns about an English mail the assistant summarised; facts from it must read as
 *     German (the operator's language). Counted, not gated.
 * NONE: German turns with nothing durable in them; counts the runs that return no fact, so a drop
 *     in the pass's restraint shows next to the old arm. Counted, not gated.
 * LEGACY: the extractor that runs where durable memory is off (`EXTRACTION_PROMPT`, memory.ts),
 *     on a German answer; every entry must read as German. Counted, not gated.
 *
 * Every operator half carries the stamp the session puts in front of a message
 * (`withCurrentTimePrefix`, timezone Europe/Zurich, also for the English turns: an English operator
 * in Zurich is where the zone could pull toward German). max_tokens is the pass's own
 * `CAPTURE_FALLBACK_MAX_TOKENS`. Left out of this eval: the `[Loaded …]` preamble a mail opened in chat puts
 * into the operator half, and the helper model's betas.
 *
 * EVAL_ARM=old sends the texts as they were before the language sentences (the capture paragraph,
 * the tool field and the extractor line cut back), so the defect can be reproduced on the same
 * turns; the cut is checked before any call. Default arm: the current text.
 *
 * Runs: EVAL_RUNS per case and model (default 10, spread over the case's turns). The bars are
 * asserted only on the current arm with EVAL_RUNS >= 10, as a share of the runs that were not
 * skipped as transient (at least half the runs must count, so a run that only skips is red): DE at least 90 % per model; EN at least 90 % on Claude Haiku and at least
 * 60 % on deepseek, which turns some English turns into faithful German translations (same names,
 * same claim) — more often when they name German places or carry the Zurich stamp.
 * Keys: ANTHROPIC_API_KEY (Claude Haiku 4.5, the Anthropic presets' fast slot), FIREWORKS_API_KEY
 * (deepseek-v4p1-flash-1017, both Fireworks presets' fast slot); a model without a key is skipped.
 * Raw facts per run go to EVAL_DUMP (one JSON line each).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { createLLMClient, initLLMProvider } from '../../src/core/llm-client.js';
import { CAPTURE_FALLBACK_MAX_TOKENS, CAPTURE_SYSTEM, CAPTURE_TOOL, CAPTURE_TOOL_NAME, buildCaptureExcerpt } from '../../src/core/capture-fallback.js';
import { EXTRACTION_PROMPT } from '../../src/core/memory.js';
import { withCurrentTimePrefix } from '../../src/core/prompts.js';
import { HAIKU } from './setup.js';
import { controlFailures, factLanguage } from './capture-language-grader.js';

const broken = controlFailures();
if (broken.length > 0) throw new Error(`grader controls failed: ${broken.join('; ')}`);

const RUNS = Number(process.env['EVAL_RUNS'] ?? 10);
const ARM = process.env['EVAL_ARM'] === 'old' ? 'old' : 'new';
const GATED = ARM === 'new' && RUNS >= 10;
const DUMP = process.env['EVAL_DUMP'] ?? join(tmpdir(), 'capture-language-eval.jsonl');
const FIREWORKS_MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash-1017';
const FIREWORKS_BASE = 'https://api.fireworks.ai/inference/v1';

const LANGUAGE_PARAGRAPH = '\n\nWrite each fact in the language the operator writes in';
const NEW_TEXT_FIELD = 'The fact, as one self-contained sentence in the language the operator writes in.';
const LEGACY_LINE = '- Write each entry in the language the response below is written in; the example below is in English only because this prompt is.\n';

interface Prompt { system: string; tool: BetaTool; legacy: string }
function oldArm(): Prompt {
  const cut = CAPTURE_SYSTEM.indexOf(LANGUAGE_PARAGRAPH);
  if (cut < 0) throw new Error('old arm: the language paragraph is not in CAPTURE_SYSTEM');
  const tool = JSON.parse(JSON.stringify(CAPTURE_TOOL).replace(NEW_TEXT_FIELD, 'The fact, as one self-contained sentence.')) as BetaTool;
  if (JSON.stringify(tool).includes('language the operator')) throw new Error('old arm: the tool still asks for a language');
  if (!EXTRACTION_PROMPT.includes(LEGACY_LINE)) throw new Error('old arm: the extractor language line is not in EXTRACTION_PROMPT');
  return { system: CAPTURE_SYSTEM.slice(0, cut), tool, legacy: EXTRACTION_PROMPT.replace(LEGACY_LINE, '') };
}
const PROMPT: Prompt = ARM === 'old' ? oldArm() : { system: CAPTURE_SYSTEM, tool: CAPTURE_TOOL, legacy: EXTRACTION_PROMPT };
if (ARM === 'new' && !PROMPT.system.includes(LANGUAGE_PARAGRAPH.trim())) throw new Error('new arm: no language paragraph');

/**
 * The excerpt's labels for the person, which a fact must not carry into the chip. It also matches
 * "user" or "operator" in a legitimate fact ("User Story", a product called Operator); none of
 * the turns here has one, and a wrong hit errs toward a miss, never toward a pass.
 */
const PERSON_LABEL = /\b(operator|user|nutzer|benutzer)\b/i;
if (!PERSON_LABEL.test('Der Operator möchte eine Vorschau.') || !PERSON_LABEL.test('The user wants a preview.') || PERSON_LABEL.test('Jede Änderung am Shop wird zuerst als Vorschau gezeigt.')) throw new Error('PERSON_LABEL control failed');

const stamped = (q: string): string => withCurrentTimePrefix(q, 'Europe/Zurich') as string;

interface Turn { q: string; a: string }
const DE_TURNS: readonly Turn[] = [
  {
    q: 'Plane einen Massenlauf für meinen Shopify-Shop: bessere SEO-Titel und SEO-Beschreibungen für alle aktiven Produkte. Grundsätzlich gilt bei uns: Ich will jede Änderung am Shop zuerst in einer Vorschau sehen, bevor ich sie freigebe.',
    a: 'Gerne. Ich plane den Lauf über alle aktiven Produkte und zeige dir die neuen SEO-Titel und -Beschreibungen in der Laufvorschau. Erst nach deiner Freigabe wird etwas in den Shop geschrieben.',
  },
  {
    q: 'Wir verkaufen nur an Geschäftskunden in der Schweiz, nicht an Privatpersonen. Schreib mir bitte eine kurze Offerte für die Keller AG über 20 Stunden Beratung.',
    a: 'Hier ist ein Entwurf der Offerte an die Keller AG: 20 Stunden Beratung, zahlbar innert 30 Tagen. Sag mir, ob der Stundensatz so stimmt.',
  },
  {
    q: 'Unser Hauptlieferant für Wasserfilter ist die Brita AG, Bestellungen gehen bei uns immer am Montag raus. Erinnere mich bitte nächste Woche an die Nachbestellung.',
    a: 'Notiert: Ich erinnere dich am Montag an die Nachbestellung bei der Brita AG.',
  },
  {
    q: 'Ab sofort gilt bei uns: Stammkunden haben 30 Tage Zahlungsfrist, Neukunden zahlen im Voraus. Passe bitte die Rechnungsvorlage an.',
    a: 'Ich habe die Rechnungsvorlage angepasst: Für Stammkunden steht jetzt eine Frist von 30 Tagen, für Neukunden Vorauszahlung.',
  },
  {
    q: 'Peter Huber ist unser neuer Ansprechpartner bei der Druckerei Meier, er ersetzt Frau Keller. Schreib ihm bitte eine kurze Vorstellungsmail.',
    a: 'Hier ist ein Entwurf für die Mail an Peter Huber bei der Druckerei Meier, mit einer kurzen Vorstellung und der Bitte um ein erstes Telefonat.',
  },
];
const EN_TURNS: readonly Turn[] = [
  {
    q: 'We only sell to business customers in Germany, never to private persons. Please draft a short quote for Nordglas GmbH for 20 hours of consulting.',
    a: 'Here is a draft quote for Nordglas GmbH: 20 hours of consulting, payable within 30 days. Tell me whether the hourly rate is right.',
  },
  {
    q: 'Our main supplier for glass carafes is Nordglas GmbH, and we always place orders on Mondays. Remind me next week to reorder.',
    a: 'Noted: I will remind you on Monday to reorder from Nordglas GmbH.',
  },
  {
    q: 'We only sell to trade customers in the UK, never to consumers. Please draft a short quote for Harper & Sons Ltd for 20 hours of consulting.',
    a: 'Here is a draft quote for Harper & Sons Ltd: 20 hours of consulting, payable within 30 days. Tell me whether the hourly rate is right.',
  },
  {
    q: 'Our main supplier for water filters is Clearwater Supply Co, and we always place orders on Mondays. Remind me next week to reorder.',
    a: 'Noted: I will remind you on Monday to reorder from Clearwater Supply Co.',
  },
];
const MAIL_TURNS: readonly Turn[] = [
  {
    q: 'Was schreibt mir Nordglas in der letzten Mail? Fass es bitte kurz zusammen.',
    a: 'Nordglas schreibt (auf Englisch): "From January 1st our minimum order is 200 carafes, and delivery to Switzerland now takes ten working days." Kurz: Ab 1. Januar gilt eine Mindestbestellung von 200 Karaffen, und die Lieferung in die Schweiz dauert neu zehn Arbeitstage.',
  },
  {
    q: 'Lies mir die Antwort von Harper & Sons vor und sag mir, was sie wollen.',
    a: 'Harper & Sons schreiben: "We can only pay by bank transfer, and our accounts team needs invoices in PDF." Sie zahlen also nur per Überweisung und brauchen Rechnungen als PDF.',
  },
];
const NONE_TURNS: readonly Turn[] = [
  { q: 'Wie spät ist es gerade in Tokio?', a: 'In Tokio ist es gerade kurz nach 16 Uhr.' },
  { q: 'Rechne mir bitte 17 mal 23 aus.', a: '17 mal 23 ergibt 391.' },
  { q: 'Danke, das war alles für heute.', a: 'Gern geschehen, bis zum nächsten Mal.' },
];
const LEGACY_ANSWERS: readonly string[] = [
  'Ich habe die Rechnungsvorlage angepasst: Stammkunden haben ab sofort 30 Tage Zahlungsfrist, Neukunden zahlen im Voraus. Diese Regel gilt künftig für alle Rechnungen.',
  'Notiert: Euer Hauptlieferant für Wasserfilter ist die Brita AG, und Bestellungen gehen bei euch immer am Montag raus. Ich erinnere dich nächste Woche an die Nachbestellung.',
];

type CaseKey = 'DE' | 'EN' | 'MAIL' | 'NONE' | 'LEGACY';
interface Row { model: string; arm: string; case: CaseKey; run: number; ok: boolean; why: string; facts: string[] }
const rows: Row[] = [];
function record(r: Row): void {
  rows.push(r);
  appendFileSync(DUMP, `${JSON.stringify(r)}\n`);
}

function transient(err: unknown): boolean {
  const busy = (code: number): boolean => code === 429 || code >= 500;
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') return busy(status);
  const text = String(err);
  const coded = /API error (\d{3}):/.exec(text);
  if (coded) return busy(Number(coded[1]));
  return /overloaded|rate.?limit|timed? ?out/i.test(text);
}

type Client = ReturnType<typeof createLLMClient>;

async function runOne(model: string, client: Client, c: CaseKey, i: number, turn: Turn): Promise<void> {
  let facts: string[] = [];
  try {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: CAPTURE_FALLBACK_MAX_TOKENS,
      system: PROMPT.system,
      messages: [{ role: 'user', content: buildCaptureExcerpt(stamped(turn.q), turn.a) }],
      tools: [PROMPT.tool],
      tool_choice: { type: 'tool', name: CAPTURE_TOOL_NAME },
    });
    const response = await stream.finalMessage();
    const call = response.content.find((b) => b.type === 'tool_use');
    const input = call && call.type === 'tool_use' ? call.input as { facts?: Array<{ text?: unknown }> } : undefined;
    facts = (input?.facts ?? []).map((f) => (typeof f.text === 'string' ? f.text : '')).filter((t) => t.length > 0);
  } catch (err) {
    if (transient(err)) { record({ model, arm: ARM, case: c, run: i, ok: true, why: `SKIP transient: ${String(err).slice(0, 120)}`, facts: [] }); return; }
    throw err;
  }
  if (c === 'NONE') { record({ model, arm: ARM, case: c, run: i, ok: facts.length === 0, why: facts.length === 0 ? 'none' : `${facts.length} fact(s)`, facts }); return; }
  const want = c === 'EN' ? 'en' : 'de';
  if (facts.length === 0) { record({ model, arm: ARM, case: c, run: i, ok: false, why: 'empty', facts }); return; }
  const labelled = facts.find((f) => PERSON_LABEL.test(f));
  if (labelled !== undefined) { record({ model, arm: ARM, case: c, run: i, ok: false, why: `names the person by an excerpt label: ${labelled.slice(0, 120)}`, facts }); return; }
  const wrong = facts.filter((f) => factLanguage(f) !== want);
  record({ model, arm: ARM, case: c, run: i, ok: wrong.length === 0, why: wrong.length === 0 ? `all ${want}` : `${wrong.length}/${facts.length} not ${want}: ${wrong[0]!.slice(0, 120)}`, facts });
}

async function runLegacy(model: string, client: Client, i: number, answer: string): Promise<void> {
  let facts: string[] = [];
  try {
    const stream = client.beta.messages.stream({ model, max_tokens: 1024, messages: [{ role: 'user', content: PROMPT.legacy + answer }] });
    const response = await stream.finalMessage();
    const block = response.content.find((b) => b.type === 'text');
    const raw = block && block.type === 'text' ? block.text : '';
    const parsed = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? '{}') as Record<string, unknown>;
    facts = Object.values(parsed).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch (err) {
    if (transient(err)) { record({ model, arm: ARM, case: 'LEGACY', run: i, ok: true, why: `SKIP transient: ${String(err).slice(0, 120)}`, facts: [] }); return; }
    if (err instanceof SyntaxError) { record({ model, arm: ARM, case: 'LEGACY', run: i, ok: false, why: 'unparsable', facts: [] }); return; }
    throw err;
  }
  if (facts.length === 0) { record({ model, arm: ARM, case: 'LEGACY', run: i, ok: false, why: 'empty', facts }); return; }
  const wrong = facts.filter((f) => factLanguage(f) !== 'de');
  record({ model, arm: ARM, case: 'LEGACY', run: i, ok: wrong.length === 0, why: wrong.length === 0 ? 'all de' : `${wrong.length}/${facts.length} not de: ${wrong[0]!.slice(0, 120)}`, facts });
}

function passed(model: string, c: CaseKey): { pass: number; of: number } {
  const mine = rows.filter((r) => r.model === model && r.case === c && !r.why.startsWith('SKIP'));
  return { pass: mine.filter((r) => r.ok).length, of: mine.length };
}
const bar = (share: number, of: number): number => Math.ceil(share * of);

function suite(provider: 'anthropic' | 'openai', model: string, enShare: number, makeClient: () => Client): void {
  let client: Client;
  beforeAll(async () => { await initLLMProvider(provider); client = makeClient(); });

  it(`DE turns give German facts (${ARM} arm)`, async () => {
    for (let i = 0; i < RUNS; i++) await runOne(model, client, 'DE', i, DE_TURNS[i % DE_TURNS.length]!);
    const { pass, of } = passed(model, 'DE');
    console.log(`[capture-language] ${model} ${ARM} DE: ${pass}/${of} German`);
    if (GATED) { expect(of).toBeGreaterThanOrEqual(Math.ceil(RUNS / 2)); expect(pass).toBeGreaterThanOrEqual(bar(0.9, of)); }
  }, 600_000);

  it(`EN turns give English facts (${ARM} arm)`, async () => {
    for (let i = 0; i < RUNS; i++) await runOne(model, client, 'EN', i, EN_TURNS[i % EN_TURNS.length]!);
    const { pass, of } = passed(model, 'EN');
    console.log(`[capture-language] ${model} ${ARM} EN: ${pass}/${of} English`);
    if (GATED) { expect(of).toBeGreaterThanOrEqual(Math.ceil(RUNS / 2)); expect(pass).toBeGreaterThanOrEqual(bar(enShare, of)); }
  }, 600_000);

  it(`MAIL, NONE and LEGACY are counted (${ARM} arm)`, async () => {
    for (let i = 0; i < RUNS; i++) await runOne(model, client, 'MAIL', i, MAIL_TURNS[i % MAIL_TURNS.length]!);
    for (let i = 0; i < RUNS; i++) await runOne(model, client, 'NONE', i, NONE_TURNS[i % NONE_TURNS.length]!);
    for (let i = 0; i < RUNS; i++) await runLegacy(model, client, i, LEGACY_ANSWERS[i % LEGACY_ANSWERS.length]!);
    const f = (c: CaseKey): string => { const p = passed(model, c); return `${p.pass}/${p.of}`; };
    console.log(`[capture-language] ${model} ${ARM} MAIL ${f('MAIL')} German · NONE ${f('NONE')} without a fact · LEGACY ${f('LEGACY')} German`);
  }, 900_000);
}

afterAll(() => { console.log(`[capture-language] dump: ${DUMP}`); });

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];
describe.skipIf(!ANTHROPIC_KEY)(`capture language — ${HAIKU}`, () => {
  suite('anthropic', HAIKU, 0.9, () => createLLMClient({ provider: 'anthropic', apiKey: ANTHROPIC_KEY! }));
});

const FIREWORKS_KEY = process.env['FIREWORKS_API_KEY'];
describe.skipIf(!FIREWORKS_KEY)(`capture language — ${FIREWORKS_MODEL}`, () => {
  suite('openai', FIREWORKS_MODEL, 0.6, () => createLLMClient({ provider: 'openai', apiKey: FIREWORKS_KEY!, apiBaseURL: FIREWORKS_BASE, openaiModelId: FIREWORKS_MODEL }));
});
