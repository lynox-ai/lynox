#!/usr/bin/env npx tsx
/**
 * Token factor, old model → candidate, measured with Anthropic's `count_tokens` (free; it
 * needs a valid key, and no model is run).
 *
 * The prices of the 5.5 models are listed per token, and Claude models from 4.7 on
 * count about 30% more tokens for the same text (Anthropic pricing page). Whether a
 * switch costs more per turn depends on that factor for lynox's own requests, so this
 * counts the same request under both models of each pair.
 *
 * Usage:
 *   npx tsx scripts/model-fitness/token-factor.ts                 # the built-in bodies below
 *   npx tsx scripts/model-fitness/token-factor.ts <raw-body.json>…  # captured bodies (replay.ts format)
 * Key: ANTHROPIC_API_KEY, else `anthropic_api_key` or `api_key` in ~/.lynox/config.json
 * (the order tests/online/setup.ts reads them in).
 *
 * The built-in bodies hold no user data: the base system prompt with the web-UI suffix,
 * every tool definition `src/tools/builtin` exports, and two short business texts written
 * for this script. They are not the request a session sends: the session composes its
 * system prompt from more parts, registers some tools only behind settings and adds
 * integration tools. They measure the factor per kind of content; the size of a real
 * turn, and a thread's history, need captured bodies, which stay outside the repository.
 *
 * Two numbers per pair:
 * - `billed`: the ratio of the counts as they stand, which is what a switch is paid on.
 * - `content`: the ratio after taking off each model's fixed part for a body of the same
 *   shape. That part is small without tools and some hundred tokens with them (a tool-use
 *   preamble that differs by model), so the floor is counted with a lone "ok", plus one
 *   minimal tool when the body carries tools.
 *
 * The same-tokenizer pairs are the controls. Sonnet 5 → Sonnet 5.5 and Opus 5 → Opus 5.5
 * must show `content` 1.00, or the counting itself is off. Haiku 4.5 → Sonnet 4.6 checks the
 * old side: the 4.x models share a tokenizer (a plain text counts the same on all three),
 * but Sonnet 4.6 renders tool definitions about 2% shorter, and the floor does not take
 * that off. On bodies with tools that control shows about 0.98, and the balanced pair's
 * `content` factor is that much higher than the fast and deep ones for the same text.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SYSTEM_PROMPT, WEB_UI_SYSTEM_PROMPT_SUFFIX } from '../../src/core/prompts.js';
import * as builtin from '../../src/tools/builtin/index.js';
import { isDirectInvocation } from './replay.js';

export const PAIRS: ReadonlyArray<{ tier: string; from: string; to: string; control?: true }> = [
  { tier: 'fast', from: 'claude-haiku-4-5-20251001', to: 'claude-haiku-5-5' },
  { tier: 'balanced', from: 'claude-sonnet-4-6', to: 'claude-sonnet-5-5' },
  { tier: 'deep', from: 'claude-opus-4-6', to: 'claude-opus-5-5' },
  { tier: 'balanced', from: 'claude-sonnet-5', to: 'claude-sonnet-5-5', control: true },
  { tier: 'deep', from: 'claude-opus-5', to: 'claude-opus-5-5', control: true },
  { tier: '4.x', from: 'claude-haiku-4-5-20251001', to: 'claude-sonnet-4-6', control: true },
];

interface Body { label: string; system?: unknown; messages: unknown; tools?: unknown }

interface ToolDefinition { name: string; description?: string; input_schema: unknown }

/** Every built-in tool definition the engine exports, as the API takes it. */
function builtinToolDefinitions(): ToolDefinition[] {
  return Object.values(builtin)
    .filter((v): v is { definition: ToolDefinition } => typeof v === 'object' && v !== null && 'definition' in v)
    .map(({ definition: d }) => ({ name: d.name, ...(d.description ? { description: d.description } : {}), input_schema: d.input_schema }));
}

const GERMAN_TEXT = 'Bitte fasse die offenen Rechnungen vom letzten Quartal zusammen und sortiere sie nach '
  + 'Fälligkeit. Markiere alle, die länger als dreissig Tage überfällig sind, und schlage für jede '
  + 'einen kurzen, freundlichen Erinnerungstext vor. Die Beträge sind in Schweizer Franken.';
const ENGLISH_TEXT = 'Please summarise last quarter\'s open invoices and sort them by due date. Flag every '
  + 'invoice more than thirty days overdue, and draft a short, friendly reminder for each. The '
  + 'amounts are in Swiss francs.';

export function builtinBodies(): Body[] {
  const tools = builtinToolDefinitions();
  const ask = [{ role: 'user', content: 'ok' }];
  return [
    { label: 'base system prompt + web-UI suffix + all exported built-in tools', system: SYSTEM_PROMPT + WEB_UI_SYSTEM_PROMPT_SUFFIX, messages: ask, tools },
    { label: 'system prompt only', system: SYSTEM_PROMPT + WEB_UI_SYSTEM_PROMPT_SUFFIX, messages: ask },
    { label: `tool definitions only (${String(tools.length)})`, messages: ask, tools },
    { label: 'German business text', messages: [{ role: 'user', content: GERMAN_TEXT }] },
    { label: 'English business text', messages: [{ role: 'user', content: ENGLISH_TEXT }] },
  ];
}

function rawBodies(paths: string[]): Body[] {
  return paths.map(p => {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { system?: unknown; messages: unknown; tools?: unknown };
    return { label: p, system: raw.system, messages: raw.messages, tools: raw.tools };
  });
}

function apiKey(): string {
  if (process.env['ANTHROPIC_API_KEY']) return process.env['ANTHROPIC_API_KEY'];
  const cfg = JSON.parse(readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8')) as Record<string, unknown>;
  for (const field of ['anthropic_api_key', 'api_key']) {
    const key = cfg[field];
    if (typeof key === 'string' && key !== '') return key;
  }
  throw new Error('No Anthropic key: set ANTHROPIC_API_KEY, or anthropic_api_key or api_key in ~/.lynox/config.json');
}

async function countTokens(key: string, model: string, body: Body): Promise<number> {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: body.messages,
      ...(body.system !== undefined ? { system: body.system } : {}),
      ...(body.tools !== undefined ? { tools: body.tools } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`count_tokens ${model} on "${body.label}": ${String(res.status)} ${text.slice(0, 200)}`);
  return (JSON.parse(text) as { input_tokens: number }).input_tokens;
}

/** Does the body carry tools? Its floor is then counted with one. */
export function hasTools(body: Body): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

/** The smallest request of a body's shape: a lone "ok", plus one minimal tool if the body has tools. */
export function floorBody(withTools: boolean): Body {
  return {
    label: withTools ? 'floor with a tool' : 'floor',
    messages: [{ role: 'user', content: 'ok' }],
    ...(withTools ? { tools: [{ name: 'x', input_schema: { type: 'object', properties: {} } }] } : {}),
  };
}

/**
 * The factor over the content: each count minus its model's floor. A body no larger than
 * the floor has no content to compare, and is an error rather than a ratio of noise.
 */
export function contentFactor(count: { from: number; to: number }, floor: { from: number; to: number }): number {
  const from = count.from - floor.from;
  if (from <= 0) throw new Error(`no content above the floor (${String(count.from)} vs ${String(floor.from)})`);
  return (count.to - floor.to) / from;
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  const bodies = paths.length > 0 ? rawBodies(paths) : builtinBodies();
  const key = apiKey();
  let head = '?';
  try { head = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  console.log(`token-factor at ${head}, ${new Date().toISOString()}, bodies: ${paths.length > 0 ? 'captured files' : 'built-in'}`);
  const floors = new Map<string, number>();
  const floorOf = async (model: string, withTools: boolean): Promise<number> => {
    const k = `${model}|${String(withTools)}`;
    if (!floors.has(k)) floors.set(k, await countTokens(key, model, floorBody(withTools)));
    return floors.get(k)!;
  };
  for (const body of bodies) {
    const withTools = hasTools(body);
    console.log(`\n${body.label}`);
    for (const pair of PAIRS) {
      const [from, to] = await Promise.all([countTokens(key, pair.from, body), countTokens(key, pair.to, body)]);
      const content = contentFactor({ from, to }, { from: await floorOf(pair.from, withTools), to: await floorOf(pair.to, withTools) });
      const tag = pair.control ? '  (control, same tokenizer)' : '';
      console.log(`  ${pair.tier.padEnd(8)} ${pair.from} ${String(from).padStart(7)} → ${pair.to} ${String(to).padStart(7)}  billed ×${(to / from).toFixed(3)}  content ×${content.toFixed(3)}${tag}`);
    }
  }
  console.log(`\nfloors: ${[...floors].map(([k, n]) => `${k} ${String(n)}`).join(', ')}`);
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
