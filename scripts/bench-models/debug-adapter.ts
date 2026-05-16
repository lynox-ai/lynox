#!/usr/bin/env npx tsx
/**
 * Direct OpenAIAdapter test — bypasses Agent. Used to isolate adapter-level
 * stream-parsing bugs from Agent-level / model-level failures.
 *
 * Usage:
 *   npx tsx scripts/bench-models/debug-adapter.ts <target>
 *
 *   target = deepseek | mistral | mistral-reasoning | llama | gpt-41 | gemini
 *
 * Reads keys from ~/.lynox/config.json (chmod 600).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLLMClient } from '../../src/core/llm-client.js';

const target = process.argv[2] ?? 'deepseek';

const cfg = JSON.parse(readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8')) as Record<string, string>;

let apiKey: string;
let apiBaseURL: string;
let openaiModelId: string;
let extraBody: Record<string, unknown> = {};

const OR = 'https://openrouter.ai/api/v1';

switch (target) {
  case 'deepseek':          apiKey = cfg['openrouter_api_key']!; apiBaseURL = OR; openaiModelId = 'deepseek/deepseek-chat'; break;
  case 'mistral':           apiKey = cfg['mistral_api_key']!;    apiBaseURL = 'https://api.mistral.ai/v1'; openaiModelId = 'mistral-large-2512'; break;
  case 'mistral-reasoning': apiKey = cfg['mistral_api_key']!;    apiBaseURL = 'https://api.mistral.ai/v1'; openaiModelId = 'mistral-large-2512'; extraBody = { reasoning_effort: 'high' }; break;
  case 'mistral-seq':       apiKey = cfg['mistral_api_key']!;    apiBaseURL = 'https://api.mistral.ai/v1'; openaiModelId = 'mistral-large-2512'; extraBody = { parallel_tool_calls: false }; break;
  case 'llama':             apiKey = cfg['openrouter_api_key']!; apiBaseURL = OR; openaiModelId = 'meta-llama/llama-3.3-70b-instruct'; break;
  case 'llama-seq':         apiKey = cfg['openrouter_api_key']!; apiBaseURL = OR; openaiModelId = 'meta-llama/llama-3.3-70b-instruct'; extraBody = { parallel_tool_calls: false }; break;
  case 'gpt-41':            apiKey = cfg['openrouter_api_key']!; apiBaseURL = OR; openaiModelId = 'openai/gpt-4.1'; break;
  case 'gemini':            apiKey = cfg['openrouter_api_key']!; apiBaseURL = OR; openaiModelId = 'google/gemini-2.5-pro'; break;
  default: throw new Error(`Unknown target: ${target}`);
}

const client = createLLMClient({
  provider: 'openai',
  apiKey,
  apiBaseURL,
  openaiModelId,
});

const prompt = `You have two tools available: \`lookup_city_by_rank(rank)\` returns the name of the Nth-most-populated Swiss city, and \`lookup_city_population(city)\` returns its population.

Task: Find the COMBINED population of Switzerland's three most populated cities. Use the tools to look up each rank, then each population, then sum them. Report the total as a single integer in your final answer.

Do NOT guess. Use the tools.`;

const tools = [
  {
    name: 'lookup_city_by_rank',
    description: 'Return the name of the Nth-most-populated city in Switzerland. Ranks 1-5 supported.',
    input_schema: { type: 'object' as const, properties: { rank: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['rank'] },
  },
  {
    name: 'lookup_city_population',
    description: 'Return the population of a Swiss city by exact name.',
    input_schema: { type: 'object' as const, properties: { city: { type: 'string' } }, required: ['city'] },
  },
];

const stream = client.beta.messages.stream({
  model: openaiModelId,
  max_tokens: 1024,
  messages: [{ role: 'user' as const, content: prompt }],
  tools,
  ...extraBody,
});

console.log(`\n=== ${target} (${openaiModelId}) extras=${JSON.stringify(extraBody)} ===\n`);

let eventCount = 0;
const byType: Record<string, number> = {};
for await (const ev of stream) {
  eventCount++;
  const e = ev as { type: string };
  byType[e.type] = (byType[e.type] ?? 0) + 1;
  if (eventCount <= 15 || eventCount % 20 === 0) {
    console.log(`[${eventCount}]`, JSON.stringify(ev).slice(0, 200));
  }
}

console.log(`\nTotal events: ${eventCount}`);
for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t}: ${n}`);
}
