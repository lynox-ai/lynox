#!/usr/bin/env npx tsx
/**
 * How often a model answers the engine's forced-tool callers WITHOUT the tool call.
 *
 * Some models reject a forced `tool_choice`; the client boundary then sends `auto` and a
 * reply without the call comes back as a named miss (`src/core/llm-wire-rules.ts`). Whether
 * that happens more than now and then decides whether a caller needs structured outputs
 * before the model change. This script counts it per caller, through each caller's REAL
 * code path, so the request is the one the engine sends and the count is the one the engine
 * keeps (`forcedToolMissCounts`, `forcedToolCutOffCounts`).
 *
 * The callers' own requests are not captured anywhere — only the main agent's body is
 * (`captureRawWireBody`). So each caller's INPUT is derived from a captured main-agent body:
 * the last question and answer, the last user goal, the last web search and its results.
 * That is a limit of this measurement and every verdict quoting it must say so.
 *
 * Usage:  npx tsx scripts/model-fitness/caller-replay.ts <raw-body.json>... --models <id,id> [--dry-run]
 * Keys:   ANTHROPIC_API_KEY env, else ~/.lynox/config.json. Anthropic models only.
 *
 * Every run starts with a positive control: a stub reply without the tool, through the same
 * boundary and the same counter. If the counter does not see it, no quota from the run means
 * anything, and the script exits 1 before it spends a cent.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { createLLMClient } from '../../src/core/llm-client.js';
import {
  forcedToolCutOffCounts, forcedToolMissCounts, reportForcedToolCutOff, reportForcedToolMiss,
  settleForcedTool, withWireRules,
} from '../../src/core/llm-wire-rules.js';
import { FOLLOW_UP_FALLBACK_MAX_TOKENS, FOLLOW_UP_TOOL_NAME, buildFollowUpRequest, lastUserText } from '../../src/core/follow-up-fallback.js';
import { CAPTURE_FALLBACK_MAX_TOKENS, CAPTURE_TOOL_NAME, buildCaptureRequest } from '../../src/core/capture-fallback.js';
import { suggestFollowUpsTool } from '../../src/tools/builtin/suggest-follow-ups.js';
import { planDAG } from '../../src/core/dag-planner.js';
import { rerankSearchResults } from '../../src/integrations/search/search-reranker.js';
import type { SearchResult } from '../../src/integrations/search/search-provider.js';
import { callForStructuredJson, type ExtractSchema } from '../../src/core/llm-helper.js';
import { isDirectInvocation } from './replay.js';

/** The forced-tool callers a model change is measured on, by the site name each one counts its misses under. */
export const CALLER_SITES = ['agent.follow_up', 'agent.capture', 'search-reranker', 'llm-helper', 'dag-planner'] as const;
export type CallerSite = typeof CALLER_SITES[number];

/** What a captured main-agent body offers the callers as input. Absent = this body has none. */
export interface CallerInputs {
  /** The last answered turn: the user's question and the assistant's answer to it. */
  turn?: { question: string; answer: string } | undefined;
  /** The user's latest request, the goal the planner is asked to decompose. */
  goal?: string | undefined;
  /** The last web search in the body and the results it returned. */
  search?: { query: string; results: SearchResult[] } | undefined;
}

type Block = { type: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown };

function blocksOf(msg: BetaMessageParam): Block[] {
  return typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content as unknown as Block[]);
}

function textOf(msg: BetaMessageParam): string {
  return blocksOf(msg).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
}

/**
 * The results of one `web_research` search, read back from the text the tool returned
 * (`formatSearchResults` in src/integrations/search/web-search-tool.ts):
 * `N. **title**`, then the url and the snippet on their own indented lines.
 */
export function parseSearchResults(text: string): SearchResult[] {
  const out: SearchResult[] = [];
  const re = /^\d+\. \*\*(.+)\*\*\n {3}(\S+)\n {3}(.*)$/gm;
  for (const m of text.matchAll(re)) {
    out.push({ title: m[1]!, url: m[2]!, snippet: m[3]! });
  }
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[]).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

/** Derive each caller's input from a captured main-agent body (see the file comment). */
export function deriveCallerInputs(messages: readonly BetaMessageParam[]): CallerInputs {
  const inputs: CallerInputs = {};
  const goal = lastUserText(messages);
  if (goal) inputs.goal = goal;

  // The answer the follow-up and capture passes read is the assistant's final text of a
  // turn, and the question is the user text before it — in a body for turn N that is the
  // last assistant text and the user text that preceded it.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant') continue;
    const answer = textOf(msg);
    if (!answer) continue;
    const question = lastUserText(messages.slice(0, i));
    if (question) inputs.turn = { question, answer };
    break;
  }

  // The last search: a `web_research` call with action search, and its tool_result.
  for (let i = messages.length - 1; i >= 0 && !inputs.search; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant') continue;
    for (const b of blocksOf(msg)) {
      const input = b.input as { action?: unknown; query?: unknown } | undefined;
      if (b.type !== 'tool_use' || b.name !== 'web_research' || input?.action !== 'search' || typeof input.query !== 'string') continue;
      const reply = messages.slice(i + 1).flatMap(blocksOf).find(r => r.type === 'tool_result' && r.tool_use_id === b.id);
      const results = reply ? parseSearchResults(resultText(reply.content)) : [];
      if (results.length >= 2) inputs.search = { query: input.query, results };
    }
  }
  return inputs;
}

/** The caller a site reads its input from; a body without that input skips the site. */
export function inputFor(site: CallerSite, inputs: CallerInputs): boolean {
  switch (site) {
    case 'agent.follow_up':
    case 'agent.capture':
      return inputs.turn !== undefined;
    case 'search-reranker':
      return inputs.search !== undefined;
    case 'llm-helper':
    case 'dag-planner':
      return inputs.goal !== undefined;
  }
}

/** How many model calls a run makes: one per body, site with input, and model. For the budget gate. */
export function plannedCalls(bodies: readonly CallerInputs[], models: readonly string[]): number {
  let n = 0;
  for (const inputs of bodies) for (const site of CALLER_SITES) if (inputFor(site, inputs)) n += models.length;
  return n;
}

export type CallerOutcome = 'called' | 'missed' | 'cut_off' | 'skipped' | 'error';

/** What the counters say one call did: a miss beats a cut-off, either beats a clean call. */
export function outcomeOf(site: string, before: { miss: Record<string, number>; cut: Record<string, number> }, after: { miss: Record<string, number>; cut: Record<string, number> }): CallerOutcome {
  if ((after.miss[site] ?? 0) > (before.miss[site] ?? 0)) return 'missed';
  if ((after.cut[site] ?? 0) > (before.cut[site] ?? 0)) return 'cut_off';
  return 'called';
}

/** A neutral extraction for the generic helper: the input is the user's request, the schema small. */
const HELPER_SYSTEM = 'Summarise the user request below in one sentence and name its main object.';
const HELPER_SCHEMA: ExtractSchema = {
  type: 'object',
  properties: { summary: { type: 'string' }, object: { type: 'string' } },
  required: ['summary', 'object'],
};

/**
 * One caller, one model, one body, through the caller's own code. `client` is the test and
 * control seam for the two passes the agent runs on its helper client and for the helper;
 * the planner and the reranker build their own client from the key, as they do in the engine.
 */
export async function runCaller(site: CallerSite, inputs: CallerInputs, model: string, key: string, client?: Anthropic): Promise<{ outcome: CallerOutcome; error?: string }> {
  if (!inputFor(site, inputs)) return { outcome: 'skipped' };
  const c = client ?? createLLMClient({ provider: 'anthropic', apiKey: key });
  const before = { miss: forcedToolMissCounts(), cut: forcedToolCutOffCounts() };
  try {
    switch (site) {
      case 'agent.follow_up': {
        const t = inputs.turn!;
        const request = buildFollowUpRequest(t.question, t.answer, suggestFollowUpsTool.definition);
        const stream = c.beta.messages.stream({ model, max_tokens: FOLLOW_UP_FALLBACK_MAX_TOKENS, ...request, tool_choice: { type: 'tool', name: FOLLOW_UP_TOOL_NAME } });
        const { message, missed } = await settleForcedTool(stream.finalMessage());
        reportForcedToolMiss(site, missed);
        reportForcedToolCutOff(site, model, message);
        break;
      }
      case 'agent.capture': {
        const t = inputs.turn!;
        const request = buildCaptureRequest(t.question, t.answer);
        const stream = c.beta.messages.stream({ model, max_tokens: CAPTURE_FALLBACK_MAX_TOKENS, ...request, tool_choice: { type: 'tool', name: CAPTURE_TOOL_NAME } });
        const { message, missed } = await settleForcedTool(stream.finalMessage());
        reportForcedToolMiss(site, missed);
        reportForcedToolCutOff(site, model, message);
        break;
      }
      case 'search-reranker': {
        const s = inputs.search!;
        await rerankSearchResults(s.query, s.results, { enabled: true }, {
          provider: 'anthropic', apiKey: key, apiBaseURL: undefined, openaiModelId: model, openaiAuth: undefined, modelPinnedByProfile: true,
        });
        break;
      }
      case 'llm-helper':
        await callForStructuredJson({ system: HELPER_SYSTEM, user: inputs.goal!, schema: HELPER_SCHEMA, model, client: c });
        break;
      case 'dag-planner':
        await planDAG(inputs.goal!, { model, apiKey: key, provider: 'anthropic' });
        break;
    }
  } catch (err) {
    // A shape error after a missed call still counted the miss; read the counter first.
    const o = outcomeOf(site, before, { miss: forcedToolMissCounts(), cut: forcedToolCutOffCounts() });
    if (o !== 'called') return { outcome: o };
    return { outcome: 'error', error: err instanceof Error ? err.message : String(err) };
  }
  return { outcome: outcomeOf(site, before, { miss: forcedToolMissCounts(), cut: forcedToolCutOffCounts() }) };
}

/**
 * A client whose every reply is text without a tool call, behind the real boundary. Through
 * it, a model that rejects a forced choice must come back as a miss — proof the counter counts.
 */
export function noToolStubClient(): Anthropic {
  const reply = { content: [{ type: 'text', text: 'No.' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' };
  const messages = { create: async () => reply, stream: () => ({ finalMessage: async () => reply }) };
  return withWireRules({ messages, beta: { messages } } as unknown as Anthropic);
}

/** The model the control runs as: one whose registry entry rejects a forced choice. */
export const CONTROL_MODEL = 'claude-opus-5-5';

/** True when the stub's text-only reply is counted as a miss on both stub-fed paths. */
export async function positiveControl(): Promise<boolean> {
  const inputs: CallerInputs = { turn: { question: 'q', answer: 'a' }, goal: 'g' };
  const a = await runCaller('agent.follow_up', inputs, CONTROL_MODEL, 'stub', noToolStubClient());
  const b = await runCaller('llm-helper', inputs, CONTROL_MODEL, 'stub', noToolStubClient());
  return a.outcome === 'missed' && b.outcome === 'missed';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const modelsIdx = argv.indexOf('--models');
  const models = modelsIdx >= 0 ? (argv[modelsIdx + 1] ?? '').split(',').filter(Boolean) : [];
  const files = argv.filter((a, i) => !a.startsWith('--') && i !== modelsIdx + 1);
  if (files.length === 0 || models.length === 0) {
    console.error('usage: caller-replay.ts <raw-body.json>... --models <id,id> [--dry-run]');
    process.exit(1);
  }
  const bodies = files.map(f => ({ file: f, inputs: deriveCallerInputs((JSON.parse(readFileSync(f, 'utf8')) as { messages: BetaMessageParam[] }).messages) }));
  const calls = plannedCalls(bodies.map(b => b.inputs), models);
  console.log(`\n${String(bodies.length)} bodies × ${String(models.length)} models: ${String(calls)} model calls planned`);
  for (const b of bodies) {
    console.log(`  ${b.file}: ${CALLER_SITES.filter(s => inputFor(s, b.inputs)).join(', ') || '(no caller has input)'}`);
  }

  if (!(await positiveControl())) {
    console.error('\n✗ POSITIVE CONTROL FAILED: a text-only reply was not counted as a miss. No quota from this run means anything.\n');
    process.exit(1);
  }
  console.log('✓ positive control: a text-only reply is counted as a miss\n');
  if (argv.includes('--dry-run')) return;

  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8')) as Record<string, unknown>; } catch { /* env only */ }
  const key = process.env['ANTHROPIC_API_KEY'] ?? (typeof cfg['anthropic_api_key'] === 'string' ? cfg['anthropic_api_key'] : '');
  if (!key) { console.error('no Anthropic key'); process.exit(1); }

  for (const model of models) {
    console.log(`${model}:`);
    for (const site of CALLER_SITES) {
      const tally: Record<CallerOutcome, number> = { called: 0, missed: 0, cut_off: 0, skipped: 0, error: 0 };
      const errors = new Set<string>();
      for (const b of bodies) {
        const r = await runCaller(site, b.inputs, model, key);
        tally[r.outcome]++;
        if (r.error) errors.add(r.error);
      }
      const ran = tally.called + tally.missed + tally.cut_off;
      console.log(`  ${site.padEnd(16)} no tool_use ${String(tally.missed)}/${String(ran)}  · cut off ${String(tally.cut_off)}  · error ${String(tally.error)}  · no input ${String(tally.skipped)}`);
      if (errors.size) console.log(`      errors: ${[...errors].join(' | ')}`);
    }
  }
  console.log('\nNot covered: the inputs are derived from main-agent bodies, not the callers\' real requests.\n');
}

if (isDirectInvocation(import.meta.url, process.argv[1])) void main();
