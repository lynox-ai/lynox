/**
 * Online A/B for extended-tool-description-on-use (v1).
 *
 * The kill-switch gate for the split: with the fat NARRATIVE prose moved OUT of
 * `definition.description` into `ToolEntry.detailedGuidance` (loaded on use), does
 * the model still SELECT + correctly CALL each split tool from the SHORT
 * description + the (unchanged) input_schema alone? Selection is driven purely by
 * the tool descriptions here (no system prompt), so this is the purest test that
 * the short description still carries the selection-critical signal.
 *
 * Runs on BOTH providers (provider-agnostic rule): Anthropic Haiku +, when
 * MISTRAL_API_KEY is set, Mistral Large (mistral-large-2512, the balanced tier's
 * real model — NEVER the -latest tag).
 *
 * Real API. Anthropic key via ~/.lynox/config.json or ANTHROPIC_API_KEY; Mistral
 * via MISTRAL_API_KEY. Skipped when the respective key is absent.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Agent } from '../../src/core/agent.js';
import { initLLMProvider } from '../../src/core/llm-client.js';
import { createToolContext } from '../../src/core/tool-context.js';
import * as builtinTools from '../../src/tools/builtin/index.js';
import type { ToolEntry } from '../../src/types/index.js';
import { getApiKey, hasApiKey, HAIKU } from './setup.js';

const ALL_BUILTINS = Object.values(builtinTools).filter(
  (v): v is ToolEntry =>
    typeof v === 'object' && v !== null && 'definition' in v &&
    typeof (v as { definition: unknown }).definition === 'object',
);
const byName = (n: string): ToolEntry => {
  const t = ALL_BUILTINS.find((x) => x.definition.name === n);
  if (!t) throw new Error(`builtin tool ${n} not found`);
  return t;
};

// The 3 split tools under test + real distractors so the model must actually
// CHOOSE (ask_user is the tempting wrong pick for the credential case).
const TOOLS: ToolEntry[] = [
  byName('artifact_save'),
  byName('ask_secret'),
  byName('memory_recall'),
  byName('api_setup'),
  byName('ask_user'),
  byName('read_file'),
];

interface Case {
  readonly label: string;
  readonly prompt: string;
  readonly expectTool: string;
  /** required fields the model must fill for a correct FIRST call */
  readonly requiredFields: readonly string[];
  /** if set: at least one call to expectTool must ROUTE to this action value
   *  (the api_setup action-routing chicken-egg — the routing lines stay in the
   *  short description, the per-action mechanics move to on-use guidance) */
  readonly expectAction?: string;
}

const CASES: readonly Case[] = [
  {
    label: 'artifact_save selected for a reusable document',
    prompt: 'Build a comparison table of three CRM tools (name, monthly price, best-for) and save it as a reusable artifact I can open later.',
    expectTool: 'artifact_save',
    requiredFields: ['title', 'content'],
  },
  {
    label: 'ask_secret selected for a credential (not ask_user)',
    prompt: 'I have my DataForSEO API key ready to hand over. Collect it from me securely and store it so you can use it for keyword research.',
    expectTool: 'ask_secret',
    requiredFields: [],
  },
  {
    label: 'memory_recall selected to look up stored knowledge',
    prompt: 'Look up what you already have saved about our past pricing decisions — search your stored knowledge for it.',
    expectTool: 'memory_recall',
    requiredFields: ['namespace'],
  },
  {
    // The sharpest chicken-egg: the per-action mechanics moved to on-use guidance,
    // so the model must ROUTE to `bootstrap` (draft from docs) from the short
    // description's action list alone — not from the removed bootstrap mechanics.
    label: 'api_setup routes to bootstrap from a docs URL',
    prompt: 'I want to use the OpenWeatherMap API. Its docs are at https://openweathermap.org/api — set up an API profile for it so the engine knows how to call it.',
    expectTool: 'api_setup',
    requiredFields: ['action'],
    expectAction: 'bootstrap',
  },
];

interface ToolUse { type: 'tool_use'; name: string; input: Record<string, unknown> }

function toolUsesOf(agent: Agent): ToolUse[] {
  const uses: ToolUse[] = [];
  for (const m of agent.getMessages()) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if ((b as { type?: string }).type === 'tool_use') uses.push(b as unknown as ToolUse);
      }
    }
  }
  return uses;
}

function skipOnServerError(err: unknown): void {
  const s = String((err as { status?: number })?.status ?? err);
  if (/429|5\d\d|overloaded|rate|timeout/i.test(s)) return; // transient — don't fail the A/B
  throw err;
}

async function runCase(agentFactory: () => Agent, c: Case): Promise<void> {
  const agent = agentFactory();
  try {
    await agent.send(c.prompt);
  } catch (err) {
    skipOnServerError(err);
    return;
  }
  const uses = toolUsesOf(agent);
  const hit = uses.find((u) => u.name === c.expectTool);
  expect(
    hit,
    `expected a tool_use for "${c.expectTool}" from the SHORT description; got: ${uses.map((u) => u.name).join(', ') || '(none)'}`,
  ).toBeTruthy();
  for (const f of c.requiredFields) {
    expect(
      hit?.input?.[f],
      `"${c.expectTool}" first call missing required field "${f}" (input: ${JSON.stringify(hit?.input)})`,
    ).toBeDefined();
  }
  if (c.expectAction !== undefined) {
    const actions = uses.filter((u) => u.name === c.expectTool).map((u) => u.input['action']);
    expect(
      actions.includes(c.expectAction),
      `expected "${c.expectTool}" to route to action "${c.expectAction}" from the short description; got actions: ${JSON.stringify(actions)}`,
    ).toBe(true);
  }
}

describe.skipIf(!hasApiKey())('Online A/B: extended-tool-descriptions — Anthropic (Haiku)', () => {
  let apiKey: string;
  beforeAll(() => { apiKey = getApiKey(); });

  it.each(CASES)('$label', async (c) => {
    await runCase(() => new Agent({
      name: `ab-haiku-${c.expectTool}`,
      model: HAIKU,
      apiKey,
      provider: 'anthropic',
      maxIterations: 3,
      tools: TOOLS,
      toolContext: createToolContext({}),
      promptUser: async () => 'ok',
      promptSecret: async () => ({ status: 'canceled' }),
    }), c);
  }, 60_000);
});

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY)('Online A/B: extended-tool-descriptions — Mistral (mistral-large-2512)', () => {
  beforeAll(async () => { await initLLMProvider('openai'); });

  it.each(CASES)('$label', async (c) => {
    await runCase(() => new Agent({
      name: `ab-mistral-${c.expectTool}`,
      model: 'mistral-large-2512',
      provider: 'openai',
      apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1',
      openaiModelId: 'mistral-large-2512',
      maxIterations: 3,
      tools: TOOLS,
      toolContext: createToolContext({}),
      promptUser: async () => 'ok',
      promptSecret: async () => ({ status: 'canceled' }),
    }), c);
  }, 60_000);
});
