import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLynoxDir } from './config.js';
import { modelCapability, normalizeModelId } from '../types/models.js';
import type { ModelPricing } from '../types/models.js';

export type { ModelPricing };

/** Fallback when neither override nor registry has an entry — Opus base
 *  rate as the conservative default. cacheWrite mirrors the registry's 1h-TTL
 *  rate (2× input): an unknown model billed through the Anthropic path gets the
 *  same 1h cache_control, so the fallback must not under-price its writes. */
const FALLBACK_PRICING: ModelPricing = {
  input: 5, output: 25, cacheWrite: 10, cacheRead: 0.50,
};

let overridePricing: Record<string, ModelPricing> | null = null;

/** A usable override entry has four finite, non-negative per-Mtok rates. */
function isValidPricing(v: unknown): v is ModelPricing {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (['input', 'output', 'cacheWrite', 'cacheRead'] as const).every((k) => {
    const n = p[k];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0;
  });
}

function loadPricingOverride(): Record<string, ModelPricing> | null {
  try {
    const raw = readFileSync(join(getLynoxDir(), 'pricing.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Validate every entry before trusting it. A malformed entry (missing,
    // NaN, or negative field) would poison calculateCost with NaN — and since
    // `NaN >= cap` is false, EVERY budget layer (cost-guard, session budget,
    // managed debit) then fails OPEN, not closed. Drop bad entries (warn) so a
    // single typo in an operator's pricing.json can't disable billing.
    const validated: Record<string, ModelPricing> = {};
    for (const [model, pricing] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidPricing(pricing)) {
        validated[model] = pricing;
      } else {
        process.stderr.write(`[pricing] ignoring malformed pricing.json override for "${model}"\n`);
      }
    }
    return validated;
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
