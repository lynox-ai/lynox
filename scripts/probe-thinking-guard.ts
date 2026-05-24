#!/usr/bin/env npx tsx
/**
 * Lightweight integration probe for the PRD-MISTRAL-AS-ANTHROPIC-ALTERNATIVE
 * §4.4 thinking-flag guard. Verifies the four scenarios:
 *
 *   1. Mistral provider + thinking=enabled + Mistral Large 3   → warning emitted, thinking ends up disabled
 *   2. Mistral provider + thinking=enabled + Magistral Medium   → NO warning, thinking still ends up disabled (existing isCustomProxy path)
 *   3. Mistral provider + thinking=disabled + any model         → NO warning
 *   4. Anthropic provider + thinking=enabled + Sonnet           → NO warning, thinking stays enabled
 *
 * This is a unit-style probe (no engine boot, no LLM calls). Stub the
 * dependencies the Agent constructor needs and assert on .getWarnings()
 * + .getThinking().
 */

import { Agent } from '../src/core/agent.js';
import type { AgentConfig, IMemory, ToolEntry } from '../src/types/index.js';

// Minimal stubs for Agent ctor deps
const noopMemory: IMemory = {
  add: async () => 0,
  rememberFact: async () => undefined,
  search: async () => [],
  getById: async () => null,
  remove: async () => undefined,
  list: async () => [],
  count: async () => 0,
};

const emptyTools: ToolEntry[] = [];

interface Scenario {
  name: string;
  config: AgentConfig;
  expectWarningCode: 'thinking_not_supported_on_model' | null;
  expectFinalThinkingType: 'enabled' | 'disabled' | 'adaptive';
}

const SCENARIOS: Scenario[] = [
  {
    name: 'Mistral provider + thinking=enabled + mistral-large-2512',
    config: {
      model: 'mistral-large-2512',
      provider: 'openai',
      apiBaseURL: 'https://api.mistral.ai/v1',
      apiKey: 'test-stub',
      openaiModelId: 'mistral-large-2512',
      thinking: { type: 'enabled', budget_tokens: 2048 },
      systemPrompt: 'test',
      memory: noopMemory,
      tools: emptyTools,
    },
    expectWarningCode: 'thinking_not_supported_on_model',
    expectFinalThinkingType: 'disabled', // silent-disable via isCustomProxy
  },
  {
    name: 'Mistral provider + thinking=enabled + magistral-medium-2509',
    config: {
      model: 'magistral-medium-2509',
      provider: 'openai',
      apiBaseURL: 'https://api.mistral.ai/v1',
      apiKey: 'test-stub',
      openaiModelId: 'mistral-large-2512',
      thinking: { type: 'enabled', budget_tokens: 2048 },
      systemPrompt: 'test',
      memory: noopMemory,
      tools: emptyTools,
    },
    expectWarningCode: null, // Magistral has reasoning natively — no warning
    expectFinalThinkingType: 'disabled', // still silent-disabled via isCustomProxy (existing behaviour)
  },
  {
    name: 'Mistral provider + thinking=disabled + any model',
    config: {
      model: 'mistral-large-2512',
      provider: 'openai',
      apiBaseURL: 'https://api.mistral.ai/v1',
      apiKey: 'test-stub',
      openaiModelId: 'mistral-large-2512',
      thinking: { type: 'disabled' },
      systemPrompt: 'test',
      memory: noopMemory,
      tools: emptyTools,
    },
    expectWarningCode: null,
    expectFinalThinkingType: 'disabled',
  },
  {
    name: 'Mistral provider + thinking=adaptive + mistral-large-2512 (default mode)',
    config: {
      model: 'mistral-large-2512',
      provider: 'openai',
      apiBaseURL: 'https://api.mistral.ai/v1',
      apiKey: 'test-stub',
      openaiModelId: 'mistral-large-2512',
      thinking: { type: 'adaptive' },
      systemPrompt: 'test',
      memory: noopMemory,
      tools: emptyTools,
    },
    expectWarningCode: null, // guard only fires on type === 'enabled'
    expectFinalThinkingType: 'disabled',
  },
  {
    name: 'Mistral provider + thinking=enabled + ministral-3b-2512 (prefix-match guard)',
    config: {
      model: 'ministral-3b-2512',
      provider: 'openai',
      apiBaseURL: 'https://api.mistral.ai/v1',
      apiKey: 'test-stub',
      openaiModelId: 'ministral-3b-2512',
      thinking: { type: 'enabled', budget_tokens: 2048 },
      systemPrompt: 'test',
      memory: noopMemory,
      tools: emptyTools,
    },
    // Verifies startsWith('magistral-') doesn't accidentally match 'ministral-'.
    expectWarningCode: 'thinking_not_supported_on_model',
    expectFinalThinkingType: 'disabled',
  },
  {
    name: 'OpenRouter (openai-compat) + thinking=enabled + non-magistral (hostname-gate)',
    config: {
      model: 'meta-llama/llama-3.1-70b-instruct',
      provider: 'openai',
      apiBaseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-stub',
      openaiModelId: 'meta-llama/llama-3.1-70b-instruct',
      thinking: { type: 'enabled', budget_tokens: 2048 },
      systemPrompt: 'test',
      memory: noopMemory,
      tools: emptyTools,
    },
    // Non-Mistral openai-compat must NOT get the Mistral-specific warning.
    expectWarningCode: null,
    expectFinalThinkingType: 'disabled',
  },
  {
    name: 'Anthropic provider + thinking=enabled + claude-sonnet-4-6',
    config: {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      thinking: { type: 'enabled', budget_tokens: 2048 },
      systemPrompt: 'test',
      memory: noopMemory,
      tools: emptyTools,
    },
    expectWarningCode: null,
    expectFinalThinkingType: 'enabled', // Anthropic + Sonnet supports thinking → flag passes through
  },
];

let pass = 0;
let fail = 0;

for (const scenario of SCENARIOS) {
  process.stdout.write(`# ${scenario.name}\n`);
  try {
    const agent = new Agent(scenario.config);
    const warnings = agent.getWarnings();
    const thinking = agent.getThinking();

    const gotWarningCode = warnings.length > 0 ? warnings[0]!.code : null;
    const wantWarningCode = scenario.expectWarningCode;
    const warningOk = gotWarningCode === wantWarningCode;

    const gotThinkingType = thinking.type;
    const wantThinkingType = scenario.expectFinalThinkingType;
    const thinkingOk = gotThinkingType === wantThinkingType;

    if (warningOk && thinkingOk) {
      process.stdout.write(`  ✓ warnings=[${gotWarningCode ?? 'none'}], thinking.type=${gotThinkingType}\n`);
      pass++;
    } else {
      process.stdout.write(`  ✗ FAIL\n`);
      if (!warningOk) process.stdout.write(`    expected warning.code = ${wantWarningCode}, got ${gotWarningCode}\n`);
      if (!thinkingOk) process.stdout.write(`    expected thinking.type = ${wantThinkingType}, got ${gotThinkingType}\n`);
      fail++;
    }
  } catch (e) {
    process.stdout.write(`  ✗ FAIL — exception: ${(e as Error).message}\n`);
    fail++;
  }
}

process.stdout.write(`\n# Summary: ${pass}/${pass + fail} passed\n`);
process.exit(fail > 0 ? 1 : 0);
