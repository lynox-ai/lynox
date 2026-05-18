import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLynoxDir } from './config.js';
import { modelCapability, normalizeModelId } from '../types/models.js';
import type { ModelPricing } from '../types/models.js';

export type { ModelPricing };

/** Fallback when neither override nor registry has an entry — Opus base
 *  rate as the conservative default (matches pre-registry behaviour). */
const FALLBACK_PRICING: ModelPricing = {
  input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50,
};

let overridePricing: Record<string, ModelPricing> | null = null;

function loadPricingOverride(): Record<string, ModelPricing> | null {
  try {
    const raw = readFileSync(join(getLynoxDir(), 'pricing.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Trusted-source cast: only an operator with write access to ~/.lynox can
    // place this file. A malformed entry produces NaN in calculateCost, which
    // fails cost-guard comparisons closed (fail-safe) rather than under-billing.
    return parsed as Record<string, ModelPricing>;
  } catch {
    return null;
  }
}

/** @internal — test-only hook to inject the override cache without touching
 *  the filesystem. Pass `null` to clear, an object to seed. */
export function _resetOverridePricingForTests(value: Record<string, ModelPricing> | null): void {
  overridePricing = value;
}

export function getPricing(model: string): ModelPricing {
  if (overridePricing === null) {
    overridePricing = loadPricingOverride() ?? {};
  }
  const base = normalizeModelId(model);
  // Override file wins (operator opt-in), then registry, then conservative fallback.
  return overridePricing[model] ?? overridePricing[base]
    ?? modelCapability(model)?.pricing
    ?? FALLBACK_PRICING;
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
