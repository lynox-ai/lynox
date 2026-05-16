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
  /**
   * Wire-level provider — what the engine sends to `createLLMClient`. Multiple
   * UI entries can share a `provider` (e.g. both 'Mistral (EU-Paris)' and
   * generic 'OpenAI-compatible endpoint' serialise to provider='openai'); the
   * UI keys buttons off `preset_id ?? provider` to disambiguate them.
   */
  provider: LLMProvider;
  /**
   * Optional UI-only identifier for catalog entries that share a `provider`.
   * Stable across rebuilds — used as a localStorage key and the UI button
   * identity. Omit when the provider field is itself unique.
   */
  preset_id?: string;
  display_name: string;
  /** Empty array signals free-text fallback — user types model ID themselves. */
  models: ReadonlyArray<CatalogModel>;
  requires_base_url: boolean;
  requires_region: boolean;
  default_residency: string;
  /**
   * Pre-filled api_base_url for this preset. Used when `requires_base_url` is
   * false but the entry still needs a non-default URL (e.g. Mistral preset
   * implies api.mistral.ai without making the user type it).
   */
  base_url_default?: string;
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

/**
 * Mistral models pinned to dated snapshots — mirrors MISTRAL_MODEL_MAP in
 * types/models.ts so the EU-sovereign tier router and the user-facing
 * catalog stay aligned. `*-latest` aliases auto-roll silently → bad for
 * cost predictability + behaviour-drift in managed-EU tenants.
 *
 * Tier mapping: small ↔ haiku, large ↔ sonnet, magistral-medium ↔ opus
 * (see types/models.ts for the cost/quality rationale).
 */
const MISTRAL_MODELS: ReadonlyArray<CatalogModel> = [
  {
    id: 'mistral-large-2512',
    tier: 'sonnet',
    label: 'Mistral Large',
    context_window: 131_072,
    pricing: { input: 2, output: 6 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Recommended default — tool-calling workhorse on EU-sovereign mode.',
  },
  {
    id: 'magistral-medium-2509',
    tier: 'opus',
    label: 'Magistral Medium',
    context_window: 131_072,
    pricing: { input: 2, output: 5 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Reasoning-heavy variant — slower, better at multi-step planning.',
  },
  {
    id: 'mistral-small-2603',
    tier: 'haiku',
    label: 'Mistral Small',
    context_window: 32_000,
    pricing: { input: 0.20, output: 0.60 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Fast + cheap; suitable for routing, classification, and quick replies.',
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
  // Mistral is rendered as a first-class native option (its own button above
  // the generic OpenAI-compatible entry) so EU-sovereign customers don't
  // have to know they're going through the OpenAI wire format. Same
  // `provider: 'openai'` under the hood — disambiguated in the UI via
  // `preset_id`. The hostname-match in `getOpenAIModelMap` activates the
  // tier router regardless of which preset the user picked.
  {
    provider: 'openai',
    preset_id: 'mistral',
    display_name: 'Mistral',
    models: MISTRAL_MODELS,
    requires_base_url: false,
    requires_region: false,
    base_url_default: 'https://api.mistral.ai/v1',
    default_residency: 'EU-Paris (Mistral SAS; DPA + GDPR)',
    notes: 'EU-sovereign option. Pinned to api.mistral.ai — no base URL needed. Tier-aware: small / large / magistral picked from the model dropdown.',
  },
  {
    provider: 'openai',
    preset_id: 'openai-compat',
    display_name: 'OpenAI-compatible endpoint',
    models: [],
    requires_base_url: true,
    requires_region: false,
    default_residency: 'depends on the operator-configured endpoint',
    notes: 'Generic OpenAI wire (POST /chat/completions). Use for Groq, OpenRouter, LMStudio, LiteLLM in OpenAI mode, or any custom OpenAI-API-compatible server.',
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
    provider: 'custom',
    display_name: 'Anthropic-compatible endpoint',
    models: [],
    requires_base_url: true,
    requires_region: false,
    default_residency: 'e.g. LiteLLM in Anthropic mode, self-hosted Claude proxy',
    notes: 'Anthropic wire (POST /v1/messages) against a custom base URL. Model ID is free-text — the endpoint routes.',
  },
];

/**
 * Stable UI key per catalog entry. Multiple entries can share a `provider`
 * (Mistral + generic OpenAI-compatible both serialise to `'openai'`), so
 * `preset_id` is the disambiguator. Falls back to `provider` when omitted.
 */
export function catalogEntryKey(entry: CatalogProviderEntry): string {
  return entry.preset_id ?? entry.provider;
}

/** Look up a single provider entry. Returns undefined when the provider isn't catalogued. */
export function getCatalogForProvider(provider: LLMProvider): CatalogProviderEntry | undefined {
  return LLM_CATALOG.find((entry) => entry.provider === provider);
}

/** Look up a catalog entry by its UI key (preset_id or provider). */
export function getCatalogEntryByKey(key: string): CatalogProviderEntry | undefined {
  return LLM_CATALOG.find((entry) => catalogEntryKey(entry) === key);
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
