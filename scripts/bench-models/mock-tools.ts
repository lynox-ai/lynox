/**
 * Deterministic mock tools used by the tool-chain scenarios.
 *
 * Why mock tools, not real `http_request`: the HN bench measures the
 * MODEL's ability to chain tool calls, not network reliability. Real
 * APIs introduce rate-limit noise, regional outages, and provider-side
 * tool-format quirks that would bias the comparison. Deterministic
 * in-process tools strip that variance — pass/fail reflects the model.
 *
 * The tool surface is intentionally tiny (two tools, exact-match inputs)
 * so a competent model with working tool-calling support cannot fail
 * the schema. If a model misuses these tools, the failure is on the
 * tool-call mechanism, not on the data.
 */
import type { ToolEntry, ToolContext } from '../../src/types/index.js';

/**
 * Ground truth for the population-lookup tool-chain scenario. Drawn from
 * 2023 BFS estimates rounded to nearest thousand; absolute correctness is
 * less important than the agent making the right tool calls AND combining
 * the returned values. The judge + passCheck verify both.
 */
const SWISS_CITIES_BY_RANK: readonly { rank: number; name: string; population: number }[] = [
  { rank: 1, name: 'Zürich',      population: 421_900 },
  { rank: 2, name: 'Geneva',      population: 203_800 },
  { rank: 3, name: 'Basel',       population: 173_800 },
  { rank: 4, name: 'Bern',        population: 134_600 },
  { rank: 5, name: 'Lausanne',    population: 140_200 },
];

/** Combined population of the top-3 cities — the canonical correct answer. */
export const SWISS_TOP3_POPULATION_TOTAL = SWISS_CITIES_BY_RANK
  .filter(c => c.rank <= 3)
  .reduce((sum, c) => sum + c.population, 0);

interface LookupCityByRankInput { rank: number }
interface LookupCityPopulationInput { city: string }

export const lookupCityByRankTool: ToolEntry<LookupCityByRankInput> = {
  definition: {
    name: 'lookup_city_by_rank',
    description: 'Return the name of the Nth-most-populated city in Switzerland. Ranks 1-5 supported. Use this to discover city names, then `lookup_city_population` for each name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        rank: { type: 'integer', minimum: 1, maximum: 5, description: 'Rank (1 = largest).' },
      },
      required: ['rank'],
    },
  },
  handler: async (input): Promise<string> => {
    const row = SWISS_CITIES_BY_RANK.find(c => c.rank === input.rank);
    if (!row) return `Error: no city at rank ${String(input.rank)}. Valid ranks: 1-5.`;
    return row.name;
  },
};

export const lookupCityPopulationTool: ToolEntry<LookupCityPopulationInput> = {
  definition: {
    name: 'lookup_city_population',
    description: 'Return the population of a Swiss city by exact name (case-sensitive). Returns integer population count. Only the cities returned by `lookup_city_by_rank` are guaranteed to resolve.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'Exact city name as returned by lookup_city_by_rank.' },
      },
      required: ['city'],
    },
  },
  handler: async (input): Promise<string> => {
    const row = SWISS_CITIES_BY_RANK.find(c => c.name === input.city);
    if (!row) {
      return `Error: city "${input.city}" not found. Valid cities are exactly those returned by lookup_city_by_rank (case-sensitive).`;
    }
    return String(row.population);
  },
};

export const TOOL_CHAIN_TOOLS: readonly ToolEntry<unknown>[] = [
  lookupCityByRankTool as ToolEntry<unknown>,
  lookupCityPopulationTool as ToolEntry<unknown>,
];

/**
 * Return tools the bench should register for a scenario. Most scenarios
 * are chat-only and get an empty list — adding a tool to a chat scenario
 * could change agent behavior on tool-tolerant models even if the tool
 * isn't called.
 */
export function getToolsForScenario(scenarioId: string): readonly ToolEntry<unknown>[] {
  if (scenarioId === 'tool-chain-population-lookup') return TOOL_CHAIN_TOOLS;
  return [];
}

// `ToolContext` re-exported here so run-one can build one without touching
// internal paths. Keeps the bench scripts off `src/core/tool-context`.
export type { ToolContext };
