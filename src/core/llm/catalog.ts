/**
 * Static LLM model catalog. Pricing here is approximate "headline" USD
 * per 1M tokens — real cost accounting goes through `core/pricing.ts`
 * (cache discounts etc.). Catalog is frozen so consumers can pass it
 * by reference without risk of cross-request mutation.
 */

import type { LLMProvider, ModelTier } from '../../types/models.js';

export interface CatalogModel {
  id: string;
  /** Tier alias for the Claude family (also drives `default_tier` config + spawn role mapping). */
  tier?: ModelTier;
  label: string;
  context_window: number;
  /** Headline pricing per 1M tokens. Cache discounts NOT modelled — see `core/pricing.ts`. */
  pricing?: { input: number; output: number };
  capabilities?: ReadonlyArray<'vision' | 'tool_use' | 'extended_thinking'>;
  residency: string;
  notes?: string;
}

export interface CatalogProviderEntry {
  provider: LLMProvider;
  display_name: string;
  /** Empty array signals free-text fallback — user types model ID themselves. */
  models: ReadonlyArray<CatalogModel>;
  requires_base_url: boolean;
  requires_region: boolean;
  default_residency: string;
  notes?: string;
}

export type LLMCatalog = ReadonlyArray<CatalogProviderEntry>;

const ANTHROPIC_MODELS: ReadonlyArray<CatalogModel> = [
  {
    id: 'claude-sonnet-4-6',
    tier: 'sonnet',
    label: 'Sonnet 4.6',
    context_window: 200_000,
    pricing: { input: 3, output: 15 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Recommended default — best balance of cost, latency, and capability.',
  },
  {
    id: 'claude-opus-4-6',
    tier: 'opus',
    label: 'Opus 4.6',
    context_window: 1_000_000,
    pricing: { input: 15, output: 75 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Highest capability; ~5× the cost of Sonnet — reserve for deep reasoning.',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    tier: 'haiku',
    label: 'Haiku 4.5',
    context_window: 200_000,
    pricing: { input: 0.80, output: 4 },
    capabilities: ['vision', 'tool_use'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Fastest tier — ideal for high-volume orchestration and classification.',
  },
];

const VERTEX_MODELS: ReadonlyArray<CatalogModel> = [
  {
    id: 'claude-sonnet-4-6',
    tier: 'sonnet',
    label: 'Sonnet 4.6 (Vertex)',
    context_window: 200_000,
    pricing: { input: 3, output: 15 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'GCP region (configurable)',
  },
  {
    id: 'claude-opus-4-6',
    tier: 'opus',
    label: 'Opus 4.6 (Vertex)',
    context_window: 1_000_000,
    pricing: { input: 15, output: 75 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'GCP region (configurable)',
  },
  {
    id: 'claude-haiku-4-5',
    tier: 'haiku',
    label: 'Haiku 4.5 (Vertex)',
    context_window: 200_000,
    pricing: { input: 0.80, output: 4 },
    capabilities: ['vision', 'tool_use'],
    residency: 'GCP region (configurable)',
  },
];

const MISTRAL_MODELS: ReadonlyArray<CatalogModel> = [
  {
    id: 'mistral-large-latest',
    label: 'Mistral Large',
    context_window: 128_000,
    pricing: { input: 2, output: 6 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Highest quality EU-sovereign option.',
  },
  {
    id: 'mistral-medium-latest',
    label: 'Mistral Medium',
    context_window: 128_000,
    pricing: { input: 0.40, output: 2 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
  },
  {
    id: 'mistral-small-latest',
    label: 'Mistral Small',
    context_window: 128_000,
    pricing: { input: 0.20, output: 0.60 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Fast + cheap; suitable for routing and quick replies.',
  },
];

export const LLM_CATALOG: LLMCatalog = [
  {
    provider: 'anthropic',
    display_name: 'Anthropic',
    models: ANTHROPIC_MODELS,
    requires_base_url: false,
    requires_region: false,
    default_residency: 'US (Anthropic; DPA + GDPR)',
  },
  {
    provider: 'vertex',
    display_name: 'Google Vertex AI (Claude)',
    models: VERTEX_MODELS,
    requires_base_url: false,
    requires_region: true,
    default_residency: 'GCP region (configurable)',
    notes: 'Same Claude family routed through Vertex. Requires GCP project + region.',
  },
  {
    provider: 'openai',
    display_name: 'Mistral (OpenAI-compatible)',
    models: MISTRAL_MODELS,
    requires_base_url: true,
    requires_region: false,
    default_residency: 'EU-Paris (Mistral SAS)',
    notes: 'Mistral via OpenAI-compatible endpoint. Base URL defaults to https://api.mistral.ai/v1.',
  },
  {
    provider: 'custom',
    display_name: 'Custom (Anthropic-compatible)',
    models: [],
    requires_base_url: true,
    requires_region: false,
    default_residency: 'Depends on endpoint',
    notes: 'LiteLLM-style proxies. Model ID is free-text; the endpoint is responsible for routing.',
  },
];

/** Look up a single provider entry. Returns undefined when the provider isn't catalogued. */
export function getCatalogForProvider(provider: LLMProvider): CatalogProviderEntry | undefined {
  return LLM_CATALOG.find((entry) => entry.provider === provider);
}

// Deep-freeze at module load: protects the singleton against accidental
// mutation when consumers hand `LLM_CATALOG` straight to `jsonResponse`
// (the response body shares the reference until serialization).
for (const entry of LLM_CATALOG) {
  Object.freeze(entry.models);
  for (const m of entry.models) {
    Object.freeze(m);
    if (m.capabilities) Object.freeze(m.capabilities);
    if (m.pricing) Object.freeze(m.pricing);
  }
  Object.freeze(entry);
}
Object.freeze(LLM_CATALOG);
