import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLynoxDir } from './config.js';
import { normalizeModelId } from '../types/models.js';

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7':           { input: 5,    output: 25, cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-opus-4-6':           { input: 5,    output: 25, cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-sonnet-4-6':         { input: 3,    output: 15, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5-20251001': { input: 1,    output: 5,  cacheWrite: 1.25,  cacheRead: 0.10 },
};

let overridePricing: Record<string, ModelPricing> | null = null;

function loadPricingOverride(): Record<string, ModelPricing> | null {
  try {
    const raw = readFileSync(join(getLynoxDir(), 'pricing.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, ModelPricing>;
  } catch {
    return null;
  }
}

export function getPricing(model: string): ModelPricing {
  if (overridePricing === null) {
    overridePricing = loadPricingOverride() ?? {};
  }
  const base = normalizeModelId(model);
  return overridePricing[model] ?? overridePricing[base]
    ?? DEFAULT_PRICING[model] ?? DEFAULT_PRICING[base]
    ?? DEFAULT_PRICING['claude-opus-4-6']!;
}

export function calculateCost(model: string, usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
}): number {
  const p = getPricing(model);
  return (usage.input_tokens / 1_000_000) * p.input
       + (usage.output_tokens / 1_000_000) * p.output
       + ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * p.cacheWrite
       + ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * p.cacheRead;
}
