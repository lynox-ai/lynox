/**
 * Deterministic mock tools for set-bench. Each tool returns frozen values
 * so the pass-check regexes are stable across runs. Real tools (live web
 * search, real sub-agents) live in the runner — this file is the mocked
 * side used both by the headline bench (for reproducibility on the agent
 * side) and the CI regression variant.
 */

import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { ZURICH_POPULATION_PINNED } from './scenarios.js';

export const LOOKUP_POPULATION_TOOL: BetaTool = {
  name: 'lookup_population',
  description: 'Return the population of a Swiss city by name. Supported: Zurich, Geneva, Basel.',
  input_schema: {
    type: 'object' as const,
    properties: { city: { type: 'string' as const } },
    required: ['city'],
  },
};

const CITY_POPULATIONS: Record<string, number> = {
  zurich: ZURICH_POPULATION_PINNED,
  'zürich': ZURICH_POPULATION_PINNED,
  geneva: 203_800,
  'genève': 203_800,
  basel: 173_800,
};

export function handleLookupPopulation(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'ERROR: bad input';
  const city = String((input as { city?: unknown }).city ?? '').trim().toLowerCase();
  if (!city) return 'ERROR: city is required';
  const pop = CITY_POPULATIONS[city];
  if (pop === undefined) return `ERROR: unknown city "${city}". Supported: zurich, geneva, basel.`;
  return String(pop);
}

export const COMPUTE_TOOL: BetaTool = {
  name: 'compute',
  description: 'Evaluate a simple two-operand arithmetic expression like "436551 * 2". Operators: + - * /. Integer literals only.',
  input_schema: {
    type: 'object' as const,
    properties: { expression: { type: 'string' as const } },
    required: ['expression'],
  },
};

/**
 * Tight two-operand parser — accepts exactly `<int> <op> <int>`. Avoids
 * `new Function()`/`eval` entirely so the bench tool can not be coerced
 * into executing arbitrary text the model might emit. The bench scenarios
 * only ever need single-operation math (Zurich population times 2 etc.);
 * if a scenario grows beyond that we add an explicit grammar, not a more
 * permissive evaluator.
 */
export function handleCompute(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'ERROR: bad input';
  const expr = String((input as { expression?: unknown }).expression ?? '').trim();
  if (!expr) return 'ERROR: expression is required';
  const match = expr.match(/^(-?\d+)\s*([+\-*/])\s*(-?\d+)$/);
  if (!match) return 'ERROR: expected "<int> <op> <int>" (no parens, no spaces inside numbers)';
  const a = parseInt(match[1]!, 10);
  const op = match[2]!;
  const b = parseInt(match[3]!, 10);
  let result: number;
  if (op === '+') result = a + b;
  else if (op === '-') result = a - b;
  else if (op === '*') result = a * b;
  else if (op === '/') {
    if (b === 0) return 'ERROR: divide by zero';
    result = Math.trunc(a / b);
  } else {
    return 'ERROR: unsupported operator';
  }
  if (!Number.isFinite(result)) return 'ERROR: non-finite result';
  return String(result);
}

/**
 * Dispatch helper — runner calls this with `(toolName, input)` and gets
 * back the tool output string. Returns `null` for unknown tools so the
 * runner can decide whether to abort or pass an error string to the
 * agent.
 */
export function dispatchMockTool(toolName: string, input: unknown): string | null {
  if (toolName === 'lookup_population') return handleLookupPopulation(input);
  if (toolName === 'compute') return handleCompute(input);
  return null;
}

export const SET_BENCH_TOOLS: readonly BetaTool[] = [LOOKUP_POPULATION_TOOL, COMPUTE_TOOL];
