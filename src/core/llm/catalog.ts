/**
 * Static LLM model catalog. Pricing here is approximate "headline" USD
 * per 1M tokens — real cost accounting goes through `core/pricing.ts`
 * (cache discounts etc.). Catalog is frozen so consumers can pass it
 * by reference without risk of cross-request mutation.
 */

import type { LLMProvider, ModelTier } from '../../types/models.js';
import {
  MODEL_MAP,
  VERTEX_MODEL_MAP,
  MISTRAL_MODEL_MAP,
  SERVED_BALANCED_SONNET_IDS,
} from '../../types/models.js';

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

/**
 * One selectable main-chat model in standard (non-hybrid) routing. Mirrors the
 * reachable `(default_tier[, balanced_model])` config combos for a provider so
 * the UI can render the "Main chat model" picker without mirroring the engine's
 * tier→model maps (drift-free — computed here where the maps live).
 */
export interface MainChatModel {
  /** Catalog model id this option represents (label/pricing looked up in `models`). */
  id: string;
  /** Routing band written to `config.default_tier` when picked. */
  tier: ModelTier;
  /**
   * For the Anthropic balanced band only: the served-Sonnet variant to write to
   * `config.balanced_model` so the picker round-trips (Sonnet 4.6 vs Sonnet 5).
   * Absent for bands with a single reachable model.
   */
  balanced_model?: string;
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
  /**
   * The models pickable as the MAIN chat model in standard routing — one per
   * reachable band, the Anthropic balanced band split by served-Sonnet variant.
   * Excludes same-band catalog extras standard-mode tier-routing can't reach
   * (e.g. Ministral 3B — `fast` resolves to 8B). Absent for free-text providers.
   * Computed at module load (see the freeze block below), never hand-authored.
   */
  main_chat_models?: ReadonlyArray<MainChatModel>;
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
    id: 'claude-sonnet-5',
    tier: 'balanced',
    label: 'Sonnet 5',
    context_window: 1_000_000,
    pricing: { input: 3, output: 15 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Newest balanced model — 1M native context, near-Opus capability, same $3/$15 rate as Sonnet 4.6 (intro $2/$10 through 2026-08-31). Opt-in via balanced_model.',
  },
  {
    id: 'claude-opus-4-6',
    tier: 'deep',
    label: 'Opus 4.6',
    context_window: 1_000_000,
    pricing: { input: 5, output: 25 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Highest capability; ~1.7× the cost of Sonnet — reserve for deep reasoning.',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    tier: 'fast',
    label: 'Haiku 4.5',
    context_window: 200_000,
    pricing: { input: 1, output: 5 },
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
    pricing: { input: 5, output: 25 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'GCP region (configurable)',
  },
  {
    id: 'claude-haiku-4-5',
    tier: 'fast',
    label: 'Haiku 4.5 (Vertex)',
    context_window: 200_000,
    pricing: { input: 1, output: 5 },
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
 * Tier mapping (updated 2026-05-29): ministral-8b ↔ fast, ministral-14b ↔
 * balanced, mistral-large-2512 ↔ deep. magistral-medium dropped from the catalog
 * — Mistral deprecated the Magistral family (retires 2026-07-31) and Set-Bench
 * v4 (fair judge panel) showed it never beats mistral-large-2512 at 6× the
 * cost. ministral-3b stays listed as the cheapest opt-in orchestration model.
 */
const MISTRAL_MODELS: ReadonlyArray<CatalogModel> = [
  {
    id: 'mistral-large-2512',
    tier: 'deep',
    label: 'Mistral Large 3',
    context_window: 256_000,
    pricing: { input: 0.50, output: 1.50 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Mistral quality leader — the deep tier. Set-Bench v4 top Mistral scorer on the open-ended analysis axes; no Mistral model beats it. 256k context, native prompt-cache, multimodal input.',
  },
  {
    id: 'ministral-14b-2512',
    tier: 'balanced',
    label: 'Ministral 14B',
    context_window: 262_144,
    pricing: { input: 0.20, output: 0.20 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Recommended balanced default. Gen-3 mid model, text+vision. 100% pass on every Set-Bench axis at near-Large quality and ~6× lower cost.',
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
    notes: 'EU-sovereign option. Pinned to api.mistral.ai — no base URL needed. Tier-aware: ministral / mistral-large picked from the model dropdown.',
  },
  {
    provider: 'custom',
    display_name: 'Anthropic-compatible endpoint (experimental)',
    models: [],
    requires_base_url: true,
    requires_region: false,
    default_residency: 'e.g. LiteLLM in Anthropic mode, or an Anthropic-API-compatible gateway',
    notes: 'Experimental — wired but not regularly tested. Anthropic wire (POST /v1/messages) against a custom base URL. Model ID is free-text — the endpoint routes.',
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

/**
 * Canonical tier→model map for a catalogued provider entry, or `null` for
 * free-text providers (openai-compat / custom) whose model is user-typed.
 * These are the same maps the engine's tier router resolves through, so the
 * derived picker options can never drift from what a `default_tier` write
 * actually reaches on the wire.
 */
function tierMapForEntry(entry: CatalogProviderEntry): Record<ModelTier, string> | null {
  if (entry.models.length === 0) return null;
  if (entry.provider === 'anthropic') return MODEL_MAP;
  if (entry.provider === 'vertex') return VERTEX_MODEL_MAP;
  if (entry.provider === 'openai' && entry.preset_id === 'mistral') return MISTRAL_MODEL_MAP;
  return null;
}

/**
 * Build the standard-mode "main chat model" options for a provider entry: one
 * per reachable band (fast / balanced / deep), the Anthropic balanced band split
 * into its served-Sonnet variants (4.6 / 5) since that provider resolves balanced
 * via `resolveBalancedModel(config.balanced_model)`. A band is only offered if the
 * catalog actually lists the model its tier resolves to — so Ministral 3B (a fast
 * extra that `fast`→8B never reaches) is correctly excluded, and no option can
 * point at a label the catalog doesn't carry.
 */
function buildMainChatModels(entry: CatalogProviderEntry): MainChatModel[] | undefined {
  const map = tierMapForEntry(entry);
  if (!map) return undefined;
  const has = (id: string): boolean => entry.models.some((m) => m.id === id);
  const out: MainChatModel[] = [];
  if (has(map.fast)) out.push({ id: map.fast, tier: 'fast' });
  if (entry.provider === 'anthropic') {
    // Every served-Sonnet the catalog lists is a reachable balanced pick via the
    // `balanced_model` override; carry it so the picker round-trips the choice.
    for (const m of entry.models) {
      if (m.tier === 'balanced' && SERVED_BALANCED_SONNET_IDS.has(m.id)) {
        out.push({ id: m.id, tier: 'balanced', balanced_model: m.id });
      }
    }
  } else if (has(map.balanced)) {
    out.push({ id: map.balanced, tier: 'balanced' });
  }
  if (has(map.deep)) out.push({ id: map.deep, tier: 'deep' });
  return out.length > 0 ? out : undefined;
}

// Deep-freeze at module load: protects the singleton against accidental
// mutation when consumers hand `LLM_CATALOG` straight to `jsonResponse`
// (the response body shares the reference until serialization).
for (const entry of LLM_CATALOG) {
  const mainChat = buildMainChatModels(entry);
  if (mainChat) {
    for (const opt of mainChat) Object.freeze(opt);
    entry.main_chat_models = Object.freeze(mainChat);
  }
  Object.freeze(entry.models);
  for (const m of entry.models) {
    Object.freeze(m);
    if (m.capabilities) Object.freeze(m.capabilities);
    if (m.pricing) Object.freeze(m.pricing);
  }
  Object.freeze(entry);
}
Object.freeze(LLM_CATALOG);
