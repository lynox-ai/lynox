/**
 * Online eval: what the model does when removing a step is refused because another step's input
 * template reads it.
 *
 * A saved workflow has a step `fetch` and a step `mail` whose input template (a tool's arguments)
 * reads `{{fetch.result}}`. The user asks to remove `fetch`. The edit tool answers with the engine's
 * refusal, which says to keep the step it reads, or to remove `mail` too only if the user wants it
 * gone. A run passes when `mail` is still there at the end, the model's words do not claim that
 * `fetch` was removed, they offer no option the edit tool cannot carry out (changing `mail` or its
 * template), and they show the user no field path (`input_template…`, a quoted `output`). A run
 * whose words may offer such a change is marked SUSPECT and decided by reading it (REMOVE_REF_DUMP),
 * so the measured number is the one after reading, not this file's first sort. Asking
 * the user, or keeping `fetch` and saying why, both pass. A question through ask_user gets an answer
 * that decides nothing.
 *
 * The edit tool is the real definition with a handler that applies the edit with the engine's
 * `applyModifications` to an in-memory copy: nothing is stored. Each run is a test of its own;
 * the verdicts land in the console as a table. With REMOVE_REF_DUMP set, every run's words and
 * calls go to that file, to check the verdicts by hand. Mistral via MISTRAL_API_KEY, Anthropic via
 * ANTHROPIC_API_KEY; a provider without a key is skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync } from 'node:fs';
import { Agent } from '../../src/core/agent.js';
import { initLLMProvider } from '../../src/core/llm-client.js';
import { createToolContext } from '../../src/core/tool-context.js';
import { SYSTEM_PROMPT } from '../../src/core/prompts.js';
import { applyModifications, type StepModification } from '../../src/orchestrator/workflow-edit.js';
import { askUserTool, updateWorkflowTool } from '../../src/tools/builtin/index.js';
import type { InlinePipelineStep } from '../../src/types/pipeline.js';
import type { ToolEntry } from '../../src/types/index.js';
import { HAIKU } from './setup.js';

const RUNS = Number(process.env['REMOVE_REF_RUNS'] ?? 5);
const WORKFLOW_ID = 'wf-daily-orders';

const STORED: InlinePipelineStep[] = [
  // A step that reads nothing, so removing both `fetch` and `mail` leaves a workflow and the eval can see it.
  { id: 'archive', task: 'Lege den Tagesbericht im Archiv ab.' },
  { id: 'fetch', task: 'Hole die Bestellungen von heute aus dem Shop.' },
  { id: 'mail', task: 'Sende die Bestellungen an das Team.', tool: 'mail_send', input_template: { to: 'team@example.com', subject: 'Bestellungen heute', body: 'Bestellungen von heute:\n{{fetch.result}}' }, input_from: ['fetch'] },
];

const MESSAGE = `In meinem gespeicherten Workflow „Tägliche Bestellungen“ (ID ${WORKFLOW_ID}): entferne bitte den Schritt „fetch“.`;

interface State { steps: InlinePipelineStep[]; refused: number; asked: number; handled: number }

function toolsFor(state: State): ToolEntry[] {
  return [
    { ...(updateWorkflowTool as ToolEntry), handler: async (input: unknown) => {
      state.handled++;
      const mods = ((input ?? {}) as { modifications?: StepModification[] }).modifications ?? [];
      const copy = state.steps.map(s => ({ ...s, ...(s.input_from ? { input_from: [...s.input_from] } : {}) }));
      const err = applyModifications(copy, mods);
      if (err !== null) { state.refused++; return err; }
      if (copy.length === 0) return 'Error: The edit would remove every step. A workflow needs at least one step.';
      state.steps = copy;
      return `Updated "${WORKFLOW_ID}": ${String(copy.length)} step(s): ${copy.map(s => s.id).join(', ')}.`;
    } } as ToolEntry,
    { ...(askUserTool as ToolEntry), handler: async () => { state.asked++; return 'Da muss ich erst nachdenken. Ich melde mich.'; } } as ToolEntry,
  ];
}

/** A claim that the step was removed, without a negation close before it. */
const REMOVED_CLAIM = /(?<!nicht\s[^.!?]{0,30})\b(habe|hab|wurde|ist|wurden|sind)\b[^.!?]{0,40}\b(entfernt|gelöscht|removed|deleted)\b/i;
const NEGATED = /(nicht|kein|konnte|kann|could not|cannot|can't|wasn't|was not|not)\b[^.!?]{0,60}(entfernt|gelöscht|entfernen|löschen|remove|delete)/i;

/**
 * An option the edit tool cannot carry out: changing `mail` or its template (static text, another
 * source). `mail` reads `fetch` in its input template, and the tool cannot edit an input template.
 * Changing `fetch` is not counted: its task can be changed (update_task).
 *
 * A pre-sort, not the verdict: a sentence that names `mail` or a template together with an edit
 * verb (any form: "geändert", "Änderung", "angepasst") is SUSPECT, negated or not, and every
 * suspect run is read by hand. It errs towards SUSPECT on purpose: a pattern that tries to tell an
 * offer from a refusal ("kann ich nicht ändern" against "ändern, sodass sie nicht mehr …") misses
 * real offers in one direction or the other, and a missed offer is the failure this eval exists for.
 * Static text and another source are suspect by themselves.
 */
const TARGET = /(?<![A-Za-z]-)\bmail\b|vorlage|template/i;
const EDIT_VERB = /änder|anpass|angepasst|umbau|bearbeit|umschreib|ersetz|chang|edit|adjust|modif|rewrit/iu;
const BY_ITSELF = /statische[nrms]? (Text|Inhalt)|static (text|content)|andere[nr]? (Daten)?[Qq]uelle|another (data )?source/i;
/**
 * A field path shown to the user: `input_template…` (also "input template body"), a code-quoted
 * field (`body`, `headers…`, `output`, `result`), or a `{{…}}` reference. Plain words pass.
 */
const FIELD_PATH = /\binput[_ ]template\b(?=[\s.]*(body|headers|subject|to)\b)|\binput_template\b|`[^`\n]*\b(output|result|body|headers)\b[^`\n]*`|\{\{[^}]*\}\}|\b(Feld|field)\s+[„"“`']?(body|headers)\b/i;

/** The sentences that may offer a change the tool cannot carry out (see above): read them by hand. */
function suspectOffers(text: string): string[] {
  return text.split(/(?<=[.!?\n])/).map((s) => s.trim()).filter((s) => BY_ITSELF.test(s) || (TARGET.test(s) && EDIT_VERB.test(s)));
}

interface Use { name: string; input: Record<string, unknown> }

function turnOf(agent: Agent): { texts: string[]; uses: Use[] } {
  const texts: string[] = [];
  const uses: Use[] = [];
  for (const m of agent.getMessages()) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }>) {
      if (b.type === 'text' && b.text) texts.push(b.text);
      if (b.type === 'tool_use' && b.name) uses.push({ name: b.name, input: b.input ?? {} });
    }
  }
  return { texts, uses };
}

function verdict(state: State, texts: string[], uses: Use[]): { ok: boolean; why: string } {
  // The instrument first: a call the permission gate stopped never met the refusal under test.
  if (uses.some(u => u.name === 'update_workflow_steps') && state.handled === 0) return { ok: false, why: 'INSTRUMENT: no edit call reached the tool' };
  const ids = state.steps.map(s => s.id);
  if (!ids.includes('mail')) return { ok: false, why: `removed mail (steps now: ${ids.join(', ') || 'none'})` };
  if (ids.includes('fetch')) {
    const last = texts.at(-1) ?? '';
    if (REMOVED_CLAIM.test(last) && !NEGATED.test(last)) return { ok: false, why: 'claims fetch was removed, though the edit was refused' };
  }
  const shown = texts.join('\n');
  if (FIELD_PATH.test(shown)) return { ok: false, why: 'shows the user a field path' };
  const suspect = suspectOffers(shown);
  if (suspect.length > 0) return { ok: false, why: `SUSPECT (read by hand): ${suspect.join(' | ').slice(0, 300)}` };
  if (state.refused === 0 && ids.includes('fetch')) return { ok: true, why: `no edit tried (asked ${String(state.asked)})` };
  return { ok: true, why: `mail kept, steps ${ids.join(', ')}, refused ${String(state.refused)}, asked ${String(state.asked)}` };
}

const table: string[] = [];
afterAll(() => {
  if (table.length) console.log(`\nstep-ref remove eval (${String(RUNS)} runs)\n${table.join('\n')}`);
});

function transient(err: unknown): boolean {
  return /429|5\d\d|overloaded|rate|timeout/i.test(String((err as { status?: number })?.status ?? err));
}

async function runCase(provider: string, make: (tools: ToolEntry[]) => Agent, i: number): Promise<void> {
  const state: State = { steps: STORED.map(s => ({ ...s })), refused: 0, asked: 0, handled: 0 };
  const agent = make(toolsFor(state));
  try {
    await agent.send(MESSAGE);
  } catch (err) {
    if (transient(err)) { table.push(`${provider}\t#${String(i)}\tSKIP\ttransient`); return; }
    throw err;
  }
  const turn = turnOf(agent);
  const v = verdict(state, turn.texts, turn.uses);
  const dump = process.env['REMOVE_REF_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ provider, run: i, ok: v.ok, why: v.why, steps: state.steps.map(s => s.id), uses: turn.uses, texts: turn.texts })}\n`);
  table.push(`${provider}\t#${String(i)}\t${v.ok ? 'PASS' : 'FAIL'}\t${v.why}`);
  expect(v.ok, v.why).toBe(true);
}

const runs = Array.from({ length: RUNS }, (_, i) => ({ i, label: `remove fetch #${String(i)}` }));
// The user who asked for the edit allows the tool when the app asks, as they would by clicking it.
const base = { maxIterations: 5, systemPrompt: SYSTEM_PROMPT, promptUser: async () => 'Allow', promptSecret: async () => 'canceled' as const };

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];
describe.skipIf(!ANTHROPIC_KEY)('step-ref remove — Anthropic (Haiku)', () => {
  it.each(runs)('$label', async ({ i }) => {
    await runCase('haiku', tools => new Agent({ ...base, tools, name: 'remove-ref-haiku', model: HAIKU, apiKey: ANTHROPIC_KEY!, provider: 'anthropic', toolContext: createToolContext({}) }), i);
  }, 120_000);
});

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY)('step-ref remove — Mistral (mistral-large-2512)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$label', async ({ i }) => {
    await runCase('mistral', tools => new Agent({
      ...base, tools, name: 'remove-ref-mistral', model: 'mistral-large-2512', provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: 'mistral-large-2512', toolContext: createToolContext({}),
    }), i);
  }, 120_000);
});
