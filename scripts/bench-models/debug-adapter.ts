#!/usr/bin/env npx tsx
/**
 * Direct OpenAIAdapter test — bypasses Agent. Goal: figure out whether the
 * "DeepSeek 0 events" bench failure happens at the adapter level (parser
 * buffer bug) or the Agent level (event-handling mismatch).
 *
 * Usage:
 *   npx tsx scripts/bench-models/debug-adapter.ts deepseek
 *   npx tsx scripts/bench-models/debug-adapter.ts mistral
 *   npx tsx scripts/bench-models/debug-adapter.ts mistral-reasoning   # forces reasoning_effort
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

if (target === 'deepseek') {
  apiKey = cfg['openrouter_api_key']!;
  apiBaseURL = 'https://openrouter.ai/api/v1';
  openaiModelId = 'deepseek/deepseek-chat';
} else if (target === 'mistral' || target === 'mistral-reasoning') {
  apiKey = cfg['mistral_api_key']!;
  apiBaseURL = 'https://api.mistral.ai/v1';
  openaiModelId = 'mistral-large-2512';
  if (target === 'mistral-reasoning') {
    extraBody = { reasoning_effort: 'medium' };
  }
} else {
  throw new Error(`Unknown target: ${target}. Use deepseek | mistral | mistral-reasoning`);
}

const client = createLLMClient({
  provider: 'openai',
  apiKey,
  apiBaseURL,
  openaiModelId,
});

// Same shape as the bench's tool-chain scenario
const prompt = `You have two tools available: \`lookup_city_by_rank(rank)\` returns the name of the Nth-most-populated Swiss city, and \`lookup_city_population(city)\` returns its population.

Task: Find the COMBINED population of Switzerland's three most populated cities. Use the tools to look up each rank, then each population, then sum them. Report the total as a single integer in your final answer.

Do NOT guess. Use the tools.`;

const tools = [
  {
    name: 'lookup_city_by_rank',
    description: 'Return the name of the Nth-most-populated city in Switzerland. Ranks 1-5 supported.',
    input_schema: {
      type: 'object' as const,
      properties: { rank: { type: 'integer', minimum: 1, maximum: 5 } },
      required: ['rank'],
    },
  },
  {
    name: 'lookup_city_population',
    description: 'Return the population of a Swiss city by exact name.',
    input_schema: {
      type: 'object' as const,
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
];

const stream = client.beta.messages.stream({
  model: openaiModelId,
  max_tokens: 1024,
  messages: [{ role: 'user' as const, content: prompt }],
  tools,
  ...extraBody,
});

console.log(`\n=== Direct adapter test: target=${target} model=${openaiModelId} ===\n`);

let eventCount = 0;
const byType: Record<string, number> = {};
for await (const ev of stream) {
  eventCount++;
  const e = ev as { type: string };
  byType[e.type] = (byType[e.type] ?? 0) + 1;
  // Log first 30 events in full detail, then summarize
  if (eventCount <= 30) {
    console.log(`[${eventCount}]`, JSON.stringify(ev).slice(0, 240));
  }
}

console.log(`\n=== Summary ===`);
console.log(`Total events: ${eventCount}`);
for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t}: ${n}`);
}
