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
    tier: 'balanced',
    label: 'Sonnet 4.6',
    context_window: 200_000,
    pricing: { input: 3, output: 15 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Recommended default — best balance of cost, latency, and capability.',
  },
  {
    id: 'claude-opus-4-6',
    tier: 'deep',
    label: 'Opus 4.6',
    context_window: 1_000_000,
    pricing: { input: 15, output: 75 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Highest capability; ~5× the cost of Sonnet — reserve for deep reasoning.',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    tier: 'fast',
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
    tier: 'balanced',
    label: 'Sonnet 4.6 (Vertex)',
    context_window: 200_000,
    pricing: { input: 3, output: 15 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'GCP region (configurable)',
  },
  {
    id: 'claude-opus-4-6',
    tier: 'deep',
    label: 'Opus 4.6 (Vertex)',
    context_window: 1_000_000,
    pricing: { input: 15, output: 75 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'GCP region (configurable)',
  },
  {
    id: 'claude-haiku-4-5',
    tier: 'fast',
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
 * Tier mapping (updated 2026-05-24): ministral-3b/8b ↔ haiku,
 * mistral-large-3 ↔ sonnet, magistral-medium ↔ opus. mistral-small-2603
 * retired from catalog 2026-05-24 in favor of Ministral gen 3 (replacement
 * for Mistral's own retired ministral-3b/8b-2410 effective 2025-12).
 */
const MISTRAL_MODELS: ReadonlyArray<CatalogModel> = [
  {
    id: 'mistral-large-2512',
    tier: 'balanced',
    label: 'Mistral Large 3',
    context_window: 256_000,
    pricing: { input: 0.50, output: 1.50 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Recommended for chat. 6× cheaper than Anthropic Sonnet at comparable agent-runtime quality. 256k context, native prompt-cache, multimodal input.',
  },
  {
    id: 'magistral-medium-2509',
    tier: 'deep',
    label: 'Magistral Medium 1.2',
    context_window: 131_072,
    pricing: { input: 2, output: 5 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Reasoning specialist — native reasoning chains, ~30-40s typical latency. Best for batch / deep analysis. Tool-routing reliability is lower than the chat-tier (5/8 bench axes had failures including 70% pass on workflow-composition); not a Sonnet/Opus replacement for interactive chat.',
  },
  {
    id: 'ministral-3b-2512',
    tier: 'fast',
    label: 'Ministral 3B',
    context_window: 262_144,
    pricing: { input: 0.10, output: 0.10 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Cheapest Mistral model. Orchestration, classification, routing.',
  },
  {
    id: 'ministral-8b-2512',
    tier: 'fast',
    label: 'Ministral 8B',
    context_window: 262_144,
    pricing: { input: 0.15, output: 0.15 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Recommended fast-tier default. 100% pass on all 8 bench axes at $0.00006–$0.00038 warm per loop.',
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
    notes: 'EU-sovereign option. Pinned to api.mistral.ai — no base URL needed. Tier-aware: ministral / mistral-large / magistral picked from the model dropdown.',
  },
  {
    provider: 'openai',
    preset_id: 'openai-compat',
    display_name: 'OpenAI-compatible endpoint (experimental)',
    models: [],
    requires_base_url: true,
    requires_region: false,
    default_residency: 'depends on the operator-configured endpoint',
    notes: 'Experimental — wired but not regularly tested. Generic OpenAI wire (POST /chat/completions) for Groq, OpenRouter, LMStudio, LiteLLM in OpenAI mode, or any custom OpenAI-API-compatible server. Tool-calling reliability varies sharply by model and endpoint.',
  },
  {
    provider: 'vertex',
    display_name: 'Google Vertex AI (Claude) — experimental',
    models: VERTEX_MODELS,
    requires_base_url: false,
    requires_region: true,
    default_residency: 'GCP region (configurable)',
    notes: 'Experimental — wired but not regularly tested. Same Claude family routed through Vertex. Requires GCP project + region.',
  },
  {
    provider: 'custom',
    display_name: 'Anthropic-compatible endpoint (experimental)',
    models: [],
    requires_base_url: true,
    requires_region: false,
    default_residency: 'e.g. LiteLLM in Anthropic mode, self-hosted Claude proxy',
    notes: 'Experimental — wired but not regularly tested. Anthropic wire (POST /v1/messages) against a custom base URL. Model ID is free-text — the endpoint routes.',
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

/**
 * Disambiguate which catalog preset matches a persisted (provider,
 * api_base_url) pair. UI uses this on load so a returning user lands on
 * the same picker tile they previously saved.
 *
 * Matching is hostname-based (URL parser, NOT substring), mirroring
 * `getOpenAIModelMap` in `types/models.ts`. A hostile/misconfigured
 * api_base_url like `https://attacker.example.com/?proxy=mistral.ai`
 * therefore CANNOT accidentally activate the Mistral preset.
 *
 * Fallback order when no preset matches:
 *   1. Single-entry provider → that entry
 *   2. Multi-preset provider, no baseUrl supplied → the preset that
 *      `requires_base_url=true` (generic/free-text), so the user sees
 *      the input they need to fill in
 *   3. Otherwise → the first candidate (defensive — shouldn't happen
 *      in a well-formed catalog)
 *
 * `catalog` defaults to the live `LLM_CATALOG` but accepts an override
 * for unit testing. Pure function.
 */
export function resolveCatalogKey(
  provider: LLMProvider,
  baseUrl: string | undefined,
  catalog: LLMCatalog = LLM_CATALOG,
): string {
  const candidates = catalog.filter((p) => p.provider === provider);
  if (candidates.length === 0) return provider;
  if (candidates.length === 1) return catalogEntryKey(candidates[0]!);

  if (baseUrl) {
    let host: string;
    try { host = new URL(baseUrl).hostname.toLowerCase(); }
    catch { host = ''; }
    if (host) {
      const matched = candidates.find((c) => {
        if (!c.base_url_default) return false;
        let defHost: string;
        try { defHost = new URL(c.base_url_default).hostname.toLowerCase(); }
        catch { return false; }
        // Apex + `api.*` + subdomain variants all match the preset:
        //   defHost='api.mistral.ai' matches 'api.mistral.ai',
        //   'mistral.ai' (apex), 'eu.mistral.ai' (subdomain).
        // Crucially does NOT match 'api.mistral.ai.attacker.com'
        // because the suffix check requires a leading `.`.
        if (host === defHost) return true;
        const apex = defHost.replace(/^api\./, '');
        return host === apex || host.endsWith(`.${apex}`);
      });
      if (matched) return catalogEntryKey(matched);
    }
  }
  const generic = candidates.find((c) => c.requires_base_url);
  return catalogEntryKey(generic ?? candidates[0]!);
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
