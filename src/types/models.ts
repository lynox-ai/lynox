import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta.js';

// === 4.1 Model Tiers & Providers ===

/**
 * Provider-agnostic capability tiers. Renamed 2026-05-29 from the legacy
 * Anthropic-brand names (`opus`/`sonnet`/`haiku`) because lynox is now
 * provider-agnostic — the brand names leaked into tool schemas + config and
 * caused models on non-Anthropic providers to mislabel themselves (a Mistral
 * tenant reporting its `balanced` tier as "Sonnet"). The tier names describe
 * the cost/capability band; each provider resolves them to a concrete model
 * via the `*_MODEL_MAP`s below.
 *   fast     — cheapest/lowest-latency (status checks, formatting)
 *   balanced — default workhorse (data queries, content, tool use)
 *   deep     — reasoning-heavy (strategy, multi-source analysis)
 * Legacy names are still accepted at input boundaries via {@link normalizeTier}.
 */
export type ModelTier = 'deep' | 'balanced' | 'fast';

/** Legacy Anthropic-brand tier aliases → provider-agnostic names. Single
 *  source of truth; also reused by `ModelTierSchema` in types/schemas.ts. */
export const LEGACY_TIER_ALIASES: Record<string, ModelTier> = {
  opus: 'deep',
  sonnet: 'balanced',
  haiku: 'fast',
};

/**
 * Normalize a tier string to the canonical provider-agnostic name, accepting
 * both the current names (`fast`/`balanced`/`deep`) and the legacy
 * Anthropic-brand names (`haiku`/`sonnet`/`opus`). Returns `undefined` for
 * anything unrecognized so callers can fall back to their own default.
 * Applied at every input boundary (config load, env vars, tool inputs) so
 * persisted `config.json` files and `LYNOX_DEFAULT_TIER` env vars written
 * before the rename keep working.
 */
export function normalizeTier(value: string | undefined): ModelTier | undefined {
  if (value === undefined) return undefined;
  if (value === 'fast' || value === 'balanced' || value === 'deep') return value;
  return LEGACY_TIER_ALIASES[value];
}

export type LLMProvider = 'anthropic' | 'vertex' | 'custom' | 'openai';

/** Named model profile for non-Claude providers (Mistral, Gemini, Grok, etc.). */
export interface ModelProfile {
  /** Provider type — always 'openai' (OpenAI-compatible API). */
  provider: 'openai';
  /** API base URL (e.g. 'https://api.mistral.ai/v1'). */
  api_base_url: string;
  /** API key for this provider. Ignored if `auth: 'google-vertex'` (OAuth token generated from service account). */
  api_key: string;
  /** Authentication mode. 'static' (default) uses api_key as-is. 'google-vertex' generates OAuth tokens from GOOGLE_APPLICATION_CREDENTIALS. */
  auth?: 'static' | 'google-vertex' | undefined;
  /** Model ID to send in requests (e.g. 'mistral-large-2512'). */
  model_id: string;
  /** Context window size in tokens. Default: 200000. */
  context_window?: number | undefined;
  /** Max output tokens. Default: 16000. */
  max_tokens?: number | undefined;
  /** Max continuation attempts. Default: 5. */
  max_continuations?: number | undefined;
  /** Pricing per million tokens (for cost guards). */
  pricing?: { input: number; output: number } | undefined;
}

export const MODEL_MAP: Record<ModelTier, string> = {
  'deep':     'claude-opus-4-6',
  'balanced': 'claude-sonnet-4-6',
  'fast':     'claude-haiku-4-5-20251001',
};

/** Vertex AI Claude model identifiers (Google Cloud). */
export const VERTEX_MODEL_MAP: Record<ModelTier, string> = {
  'deep':     'claude-opus-4-6',
  'balanced': 'claude-sonnet-4-6',
  'fast':     'claude-haiku-4-5',
};

/** Canonical Mistral base URL (used for tier-map detection). */
export const MISTRAL_API_BASE = 'https://api.mistral.ai/v1';

/**
 * Mistral tier-set for openai-provider mode.
 * Pinned to specific snapshots so behaviour stays reproducible across model
 * refreshes. `mistral-large-latest` would auto-roll silently — bad for cost
 * and behaviour-drift in managed-EU tenants.
 *   fast     → ministral-8b-2512      (gen 3 edge model, replaces retired mistral-small-2603)
 *   balanced → ministral-14b-2512     (near-large quality at ~6× lower cost)
 *   deep     → mistral-large-2512     (Mistral quality leader, tool-use)
 * (Keep this block in sync with MISTRAL_MODEL_MAP below — the values are
 *  pinned by tests/doc-drift.test.ts.)
 *
 * Updated 2026-05-24: ministral-3b/8b-2410 retired 2025-12-31, mistral-small-2603 deprecated.
 * fast-tier moves to ministral-8b-2512 (gen 3 edge, ~$0.15/M, multimodal, 256k ctx).
 */
// Refreshed 2026-05-29 (Set-Bench v4, fair judge panel): Mistral deprecated
// the Magistral reasoning family (magistral-medium-2509 retires 2026-07-31),
// so `deep` moves to mistral-large-2512 — the Mistral quality leader, which
// medium-2604 (the nominal Magistral successor) never beats at 6× the cost.
// `balanced` adopts ministral-14b-2512 (100% pass, near-large quality at ~6×
// lower cost), giving a clean fast→balanced→deep capability ladder.
export const MISTRAL_MODEL_MAP: Record<ModelTier, string> = {
  'deep':     'mistral-large-2512',
  'balanced': 'ministral-14b-2512',
  'fast':     'ministral-8b-2512',
};

const ALL_MODEL_MAPS: Record<Exclude<LLMProvider, 'custom' | 'openai'>, Record<ModelTier, string>> = {
  anthropic: MODEL_MAP,
  vertex: VERTEX_MODEL_MAP,
};

/**
 * Derive a tier→model map for the openai-compat provider, based on the
 * configured `api_base_url`. Returns `null` for unknown providers so callers
 * can fall back to the single configured `openai_model_id`.
 *
 * Matches by URL hostname (not substring) so a misconfigured base URL like
 * `https://attacker.example.com/?proxy=mistral.ai` doesn't accidentally
 * activate the Mistral tier-map. Invalid URLs return `null`.
 *
 * Pure function — no side effects. Engine init wires the result via
 * `setOpenAIModelResolver()`.
 */
export function getOpenAIModelMap(apiBaseURL: string | undefined): Record<ModelTier, string> | null {
  if (!apiBaseURL) return null;
  let host: string;
  try {
    host = new URL(apiBaseURL).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'api.mistral.ai' || host.endsWith('.mistral.ai')) return MISTRAL_MODEL_MAP;
  return null;
}

/**
 * Process-global tier→model resolver for openai-compat providers. Set once
 * at engine bootstrap by `setOpenAIModelResolver()` based on the active
 * config. Without this, `getModelId(tier, 'openai')` would return Anthropic
 * IDs which downstream Mistral/OpenAI endpoints reject.
 */
let _openaiModelMap: Record<ModelTier, string> | null = null;
let _openaiFallbackModelId: string | null = null;

/**
 * Configure the active openai-compat tier→model resolver. Called by engine
 * bootstrap once `userConfig` is loaded. Pass `null` (or omit fields) to
 * reset to legacy behaviour (returns Anthropic IDs — fine for tests).
 */
export function setOpenAIModelResolver(opts: {
  map?: Record<ModelTier, string> | null | undefined;
  fallbackModelId?: string | null | undefined;
}): void {
  if (opts.map !== undefined) _openaiModelMap = opts.map;
  if (opts.fallbackModelId !== undefined) _openaiFallbackModelId = opts.fallbackModelId;
}

/** Inspect the currently-registered openai tier map (mostly for tests + debug). */
export function getActiveOpenAIModelMap(): Record<ModelTier, string> | null {
  return _openaiModelMap;
}

/**
 * Resolve a tier name to a provider-specific model ID.
 */
export function getModelId(tier: ModelTier, provider: LLMProvider = 'anthropic'): string {
  // 'custom' provider (LiteLLM etc.) uses standard Anthropic model IDs — proxy maps them
  if (provider === 'custom') return MODEL_MAP[tier];
  if (provider === 'openai') {
    // Prefer the active openai tier→model map (registered by engine bootstrap
    // for known providers — e.g. MISTRAL_MODEL_MAP for managed-EU). Fall back
    // to the configured single `openai_model_id` when no map is registered.
    // Final fallback to Anthropic IDs preserves legacy test behaviour where
    // the resolver isn't bootstrapped.
    return _openaiModelMap?.[tier] ?? _openaiFallbackModelId ?? MODEL_MAP[tier];
  }
  return ALL_MODEL_MAPS[provider][tier];
}

/**
 * Normalize a provider-specific model ID to its base Anthropic model ID.
 * E.g. 'claude-sonnet-4-6@20260101' → 'claude-sonnet-4-6'
 * Returns the input unchanged if already a base model ID or tier alias.
 */
export function normalizeModelId(model: string): string {
  // Defense-in-depth: capability lookups route through here and are
  // contractually "safe on unknown ids" (modelCapabilityOrFallback returns a
  // fallback rather than throwing). A missed tier-normalization boundary can
  // hand us undefined (e.g. MODEL_MAP[<legacy-tier>] → undefined); guard so it
  // degrades to the fallback capability instead of a `.replace of undefined`
  // TypeError → 500.
  if (typeof model !== 'string') return '';
  // Strip Vertex AI version suffix: '@YYYYMMDD'
  return model.replace(/@\d{8}$/, '');
}

/** Approximate characters per token for context estimation. */
export const CHARS_PER_TOKEN = 3.5;

// === 4.2 Model Capability Registry ===

/** Pricing per million tokens. cacheWrite/cacheRead default to input rate
 *  for providers without separate cache tiers (e.g. Mistral). */
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Capability flags surfaced to UI + agent (e.g. show-all-grayed pattern). */
export interface ModelFeatures {
  vision: boolean;
  extendedThinking: boolean;
  toolUse: boolean;
  promptCaching: boolean;
  pdfInput: boolean;
}

/**
 * Single source of truth for per-model facts. Keyed by canonical provider
 * model id (no tier aliases). Replaces the pre-2026-05-18 scattered
 * _CONTEXT_WINDOW / _DEFAULT_MAX_TOKENS / _MAX_CONTINUATIONS / pricing maps
 * that drifted (staging "Kontext: 423%" bug came from three sites with the
 * same formula and two stale copies — see commit ed428cc8 follow-up).
 */
export interface ModelCapability {
  /** Provider's canonical id (e.g. 'claude-sonnet-4-6', 'mistral-large-2512'). */
  id: string;
  /** Provider this model belongs to. */
  provider: LLMProvider;
  /** Tier classification. `null` for utility / bench-only models without tier routing. */
  tier: ModelTier | null;
  /** Native context window in tokens. */
  contextWindow: number;
  /** Default max output tokens when caller doesn't specify. */
  defaultMaxOutput: number;
  /** Max continuation attempts the Agent will run for this model. */
  maxContinuations: number;
  /** Beta headers required to unlock this variant (e.g. ['context-1m-2025-08-07']). */
  betaHeaders: AnthropicBeta[];
  /** Capability flags. */
  features: ModelFeatures;
  /** Pricing per million tokens. */
  pricing: ModelPricing;
  /** Human-readable label for UI dropdowns / pills. */
  uiLabel: string;
}

const CLAUDE_FEATURES: ModelFeatures = {
  vision: true,
  extendedThinking: true,
  toolUse: true,
  promptCaching: true,
  pdfInput: true,
};

const MISTRAL_FEATURES_LARGE: ModelFeatures = {
  vision: false,
  extendedThinking: false,
  toolUse: true,
  promptCaching: true,
  pdfInput: false,
};

const MISTRAL_FEATURES_SMALL: ModelFeatures = {
  vision: false,
  extendedThinking: false,
  toolUse: true,
  promptCaching: true,
  pdfInput: false,
};

const ONE_M_BETA: AnthropicBeta[] = ['context-1m-2025-08-07'];

export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  // === Anthropic Claude (direct + custom proxy) ===
  'claude-opus-4-7': {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    tier: 'deep',
    contextWindow: 1_000_000,
    defaultMaxOutput: 32_000,
    maxContinuations: 20,
    betaHeaders: [],
    features: CLAUDE_FEATURES,
    pricing: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
    uiLabel: 'Claude Opus 4.7',
  },
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    tier: 'deep',
    contextWindow: 1_000_000,
    defaultMaxOutput: 32_000,
    maxContinuations: 20,
    betaHeaders: [],
    features: CLAUDE_FEATURES,
    pricing: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
    uiLabel: 'Claude Opus 4.6',
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    tier: 'balanced',
    contextWindow: 200_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: CLAUDE_FEATURES,
    pricing: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
    uiLabel: 'Claude Sonnet 4.6',
  },
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    tier: 'fast',
    contextWindow: 200_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: CLAUDE_FEATURES,
    pricing: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
    uiLabel: 'Claude Haiku 4.5',
  },
  // Vertex AI variant — same model, different id surface (no date suffix).
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    provider: 'vertex',
    tier: 'fast',
    contextWindow: 200_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: CLAUDE_FEATURES,
    pricing: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
    uiLabel: 'Claude Haiku 4.5',
  },
  // 1M-context beta variants — Anthropic's identifier for the 1M-context
  // beta when `anthropic-beta: context-1m-2025-08-07` is on. Without these
  // explicit entries the lookup falls through to the 200k default (only
  // @YYYYMMDD gets stripped, not bracket suffixes), which historically caused
  // the staging "Kontext: 423%" UI mismatch when an extended-Sonnet session
  // was treated as 200k for trim/percentage calc. Pricing mirrors the base
  // model for now — Anthropic may levy a 1M-tier premium later; revisit when
  // that lands.
  'claude-opus-4-7[1m]': {
    id: 'claude-opus-4-7[1m]',
    provider: 'anthropic',
    tier: 'deep',
    contextWindow: 1_000_000,
    defaultMaxOutput: 32_000,
    maxContinuations: 20,
    betaHeaders: ONE_M_BETA,
    features: CLAUDE_FEATURES,
    pricing: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
    uiLabel: 'Claude Opus 4.7 (1M)',
  },
  'claude-opus-4-6[1m]': {
    id: 'claude-opus-4-6[1m]',
    provider: 'anthropic',
    tier: 'deep',
    contextWindow: 1_000_000,
    defaultMaxOutput: 32_000,
    maxContinuations: 20,
    betaHeaders: ONE_M_BETA,
    features: CLAUDE_FEATURES,
    pricing: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
    uiLabel: 'Claude Opus 4.6 (1M)',
  },
  'claude-sonnet-4-6[1m]': {
    id: 'claude-sonnet-4-6[1m]',
    provider: 'anthropic',
    tier: 'balanced',
    contextWindow: 1_000_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: ONE_M_BETA,
    features: CLAUDE_FEATURES,
    pricing: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
    uiLabel: 'Claude Sonnet 4.6 (1M)',
  },
  // === Mistral tier-set (eu-sovereign managed via openai-compat) ===
  // cacheRead = 10% of input per Mistral pricing docs (2026-05-24).
  // Mistral exposes `prompt_cache_key` opt-in; cached input billed at 10%.
  // Cache-write is implicit (no separate billing field per Mistral terms).
  'ministral-3b-2512': {
    id: 'ministral-3b-2512',
    provider: 'openai',
    tier: 'fast',
    contextWindow: 262_144,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.10, output: 0.10, cacheWrite: 0.10, cacheRead: 0.010 },
    uiLabel: 'Ministral 3B',
  },
  'ministral-8b-2512': {
    id: 'ministral-8b-2512',
    provider: 'openai',
    tier: 'fast',
    contextWindow: 262_144,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.15, output: 0.15, cacheWrite: 0.15, cacheRead: 0.015 },
    uiLabel: 'Ministral 8B',
  },
  // Ministral 3 14B (Dec 2025): gen-3 mid model, text+vision, 262k context.
  // The `balanced` tier as of 2026-05-29 — Set-Bench v4 showed 100% pass and
  // near-Large quality at ~6× lower cost than mistral-large-2512.
  'ministral-14b-2512': {
    id: 'ministral-14b-2512',
    provider: 'openai',
    tier: 'balanced',
    contextWindow: 262_144,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.20, output: 0.20, cacheWrite: 0.20, cacheRead: 0.02 },
    uiLabel: 'Ministral 14B',
  },
  // Mistral Large 3 (Dec 2025): 256k context, $0.50/$1.50 (75% price cut vs Large 2),
  // multimodal input (text+image), structured-outputs, function-calling, prefix-cache.
  // The `deep` tier as of 2026-05-29 (replaced the deprecated magistral-medium-2509);
  // the Mistral quality leader on Set-Bench v4.
  'mistral-large-2512': {
    id: 'mistral-large-2512',
    provider: 'openai',
    tier: 'deep',
    contextWindow: 256_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 0.50, output: 1.50, cacheWrite: 0.50, cacheRead: 0.05 },
    uiLabel: 'Mistral Large 3',
  },
  // DEPRECATED by Mistral — magistral-medium-2509 retires 2026-07-31. No longer
  // tier-routed (tier:null); kept for cost-guard + back-compat of legacy configs
  // that pinned it via openai_model_id. Set-Bench v4: never beat mistral-large-2512.
  'magistral-medium-2509': {
    id: 'magistral-medium-2509',
    provider: 'openai',
    tier: null,
    contextWindow: 131_072,
    defaultMaxOutput: 32_000,
    maxContinuations: 20,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 2, output: 5, cacheWrite: 2, cacheRead: 0.20 },
    uiLabel: 'Magistral Medium 1.2',
  },
  // === Mistral bench-only / legacy roster (cost tracking; no tier routing) ===
  // contextWindow values from Mistral docs (2026-05). These models aren't
  // wired into MISTRAL_MODEL_MAP — they're only referenced by set-bench and
  // cost-guard so the user can opt-in via openai_model_id.
  //
  // Note: ministral-3b/8b-2410 + mistral-small-2603 retired by Mistral 2025-12.
  // Kept here for backwards-compat of legacy configs + cost-guard. New code
  // should use the gen-3 ministral-3b/8b-2512 entries above (tier:'fast').
  'mistral-small-2603': {
    id: 'mistral-small-2603',
    provider: 'openai',
    tier: null,
    contextWindow: 32_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.20, output: 0.60, cacheWrite: 0.20, cacheRead: 0.20 },
    uiLabel: 'Mistral Small (deprecated)',
  },
  'ministral-8b-2410': {
    id: 'ministral-8b-2410',
    provider: 'openai',
    tier: null,
    contextWindow: 32_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.10, output: 0.10, cacheWrite: 0.10, cacheRead: 0.10 },
    uiLabel: 'Ministral 8B',
  },
  'ministral-3b-2410': {
    id: 'ministral-3b-2410',
    provider: 'openai',
    tier: null,
    contextWindow: 32_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.04, output: 0.04, cacheWrite: 0.04, cacheRead: 0.04 },
    uiLabel: 'Ministral 3B',
  },
  'open-mistral-nemo': {
    id: 'open-mistral-nemo',
    provider: 'openai',
    tier: null,
    contextWindow: 128_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.15, output: 0.15, cacheWrite: 0.15, cacheRead: 0.15 },
    uiLabel: 'Mistral Nemo',
  },
  'mistral-medium-2508': {
    id: 'mistral-medium-2508',
    provider: 'openai',
    tier: null,
    contextWindow: 128_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 0.40, output: 2, cacheWrite: 0.40, cacheRead: 0.40 },
    uiLabel: 'Mistral Medium 3.1',
  },
  'mistral-medium-latest': {
    id: 'mistral-medium-latest',
    provider: 'openai',
    tier: null,
    contextWindow: 128_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 0.40, output: 2, cacheWrite: 0.40, cacheRead: 0.40 },
    uiLabel: 'Mistral Medium (latest)',
  },
  'codestral-2508': {
    id: 'codestral-2508',
    provider: 'openai',
    tier: null,
    contextWindow: 256_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 0.30, output: 0.90, cacheWrite: 0.30, cacheRead: 0.30 },
    uiLabel: 'Codestral',
  },
  'codestral-latest': {
    id: 'codestral-latest',
    provider: 'openai',
    tier: null,
    contextWindow: 256_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 0.30, output: 0.90, cacheWrite: 0.30, cacheRead: 0.30 },
    uiLabel: 'Codestral (latest)',
  },
  'magistral-small-2509': {
    id: 'magistral-small-2509',
    provider: 'openai',
    tier: null,
    contextWindow: 40_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.50, output: 1.50, cacheWrite: 0.50, cacheRead: 0.50 },
    uiLabel: 'Magistral Small',
  },
  'magistral-small-latest': {
    id: 'magistral-small-latest',
    provider: 'openai',
    tier: null,
    contextWindow: 40_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.50, output: 1.50, cacheWrite: 0.50, cacheRead: 0.50 },
    uiLabel: 'Magistral Small (latest)',
  },
};

/** Resolve a model id (canonical or @-suffixed Vertex variant) to its
 *  capability entry. Returns `undefined` for unknown models — callers must
 *  decide whether that's a hard error or a soft fallback. */
export function modelCapability(model: string): ModelCapability | undefined {
  return MODEL_CAPABILITIES[model] ?? MODEL_CAPABILITIES[normalizeModelId(model)];
}

/** Backstop for unknown model ids. Matches the pre-registry hard-coded
 *  fallbacks in getContextWindow / getDefaultMaxTokens / getMaxContinuations. */
const FALLBACK_CAPABILITY = {
  contextWindow: 200_000,
  defaultMaxOutput: 16_000,
  maxContinuations: 10,
} as const;

/** Resolve a model id to its capability entry, falling back to a sensible
 *  default capability if the id is unknown. Used by helpers like
 *  `getContextWindow` that historically returned safe defaults rather than
 *  throwing on unknown ids. */
function modelCapabilityOrFallback(model: string): {
  contextWindow: number;
  defaultMaxOutput: number;
  maxContinuations: number;
} {
  return modelCapability(model) ?? FALLBACK_CAPABILITY;
}

/** Look up context window size. Normalizes provider-prefixed model IDs automatically. */
export function getContextWindow(model: string): number {
  return modelCapabilityOrFallback(model).contextWindow;
}

/** Floor for a user-supplied context-window cap. Stops an absurdly small
 *  `max_context_window_tokens` setting from starving the system prompt + tool
 *  definitions and bricking every request. */
export const MIN_EFFECTIVE_CONTEXT_WINDOW_TOKENS = 32_000;

/** Resolve a model's NATIVE context window across all tiers (self-host / BYOK /
 *  managed), with a clear precedence that the bare id-based `getContextWindow`
 *  cannot express:
 *
 *    1. An explicitly DECLARED window always wins — `ModelProfile.context_window`
 *       (BYOK named profile) or `openai_context_window` (self-host global
 *       openai-compat switch). The operator knows their model's real window
 *       better than any id lookup can.
 *    2. A KNOWN registry id → its registered window (managed Mistral resolves
 *       via MISTRAL_MODEL_MAP to e.g. `ministral-14b-2512`, provider `openai`,
 *       262k; direct Anthropic ids likewise).
 *       BUT: under an openai/custom provider, `getModelId` falls back to an
 *       Anthropic id when no tier map and no `openai_model_id` are configured
 *       (see getModelId above). Trusting that id would surface a misleading
 *       Claude window for a self-host model — so an Anthropic-provider id under
 *       a custom provider is treated as "unknown" and gets the honest default.
 *    3. Unknown id → honest 200k default, never an invented cap.
 *
 *  Pure + side-effect-free; the single place tier-specific window logic lives. */
export function resolveNativeContextWindow(
  model: string,
  provider?: LLMProvider | undefined,
  declaredWindow?: number | undefined,
): number {
  if (declaredWindow !== undefined && declaredWindow > 0) return declaredWindow;
  const known = modelCapability(model);
  if (known) {
    const isCustomProvider = provider === 'openai' || provider === 'custom';
    // Anthropic-fallback trap: a Claude id reaching here under a custom
    // provider means the tier resolver fell back — don't trust its window.
    if (isCustomProvider && known.provider === 'anthropic') return FALLBACK_CAPABILITY.contextWindow;
    return known.contextWindow;
  }
  return FALLBACK_CAPABILITY.contextWindow;
}

/** Effective context window after applying the user's optional cap. Mirrors
 *  Agent._effectiveContextWindow so server-side endpoints + session bookkeeping
 *  can compute the same value the agent actually uses internally — staging
 *  2026-05-18 shipped this with three separate copies of the formula that
 *  drifted (UI showed 423% because /sessions returned the native window
 *  while the agent had applied a smaller user cap). Single source of truth.
 *
 *  `opts` carries the provider + any declared window so custom/BYOK/self-host
 *  models resolve their real native window via `resolveNativeContextWindow`
 *  instead of the bare-id 200k fallback. Omitting `opts` preserves the legacy
 *  id-only behaviour (all pre-existing 2-arg callers unchanged).
 *  Never returns more than the model's native window. */
export function effectiveContextWindow(
  model: string,
  userCap: number | undefined,
  opts?: { provider?: LLMProvider | undefined; declaredWindow?: number | undefined } | undefined,
): number {
  const native = resolveNativeContextWindow(model, opts?.provider, opts?.declaredWindow);
  if (userCap !== undefined && userCap > 0) {
    return Math.min(native, Math.max(userCap, MIN_EFFECTIVE_CONTEXT_WINDOW_TOKENS));
  }
  return native;
}

/** Look up default max output tokens. Normalizes provider-prefixed model IDs automatically. */
export function getDefaultMaxTokens(model: string): number {
  return modelCapabilityOrFallback(model).defaultMaxOutput;
}

/** Look up max continuation attempts. Normalizes provider-prefixed model IDs automatically. */
export function getMaxContinuations(model: string): number {
  return modelCapabilityOrFallback(model).maxContinuations;
}

// === Thinking & Effort ===

export type ThinkingMode =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'adaptive' }
  | { type: 'disabled' };

export type ThinkingHint = ThinkingMode['type'];

/**
 * Structured warning produced by the engine that the HTTP-API surfaces as a
 * `warning` SSE event so the web-UI can render a user-facing toast. Used
 * when the engine has to silently degrade behaviour to avoid a customer-
 * facing API error (e.g. `thinking=enabled` requested on a non-reasoning
 * Mistral model — the call still works but reasoning is disabled).
 *
 * `modelId` is an internal enum (no user-supplied content), `code` is a
 * stable identifier the UI uses to pick the right i18n string + icon,
 * `hint` is a short fallback English message for clients without i18n.
 */
export interface AgentWarning {
  readonly code: 'thinking_not_supported_on_model';
  readonly modelId: string;
  readonly hint: string;
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// === Step Hints (LLM-driven per-step configuration) ===

/** Hints the LLM attaches to options or plan phases to configure the next step. */
export interface StepHint {
  model?: ModelTier | undefined;
  thinking?: ThinkingHint | undefined;
  effort?: EffortLevel | undefined;
}

/** Tier ordering for clamping — lower index = cheaper/faster. */
const TIER_ORDER: Record<ModelTier, number> = { fast: 0, balanced: 1, deep: 2 };

/** Clamp a requested tier to the maximum allowed tier. Returns requested if no cap set. */
export function clampTier(requested: ModelTier, maxTier: ModelTier | undefined): ModelTier {
  if (!maxTier) return requested;
  return TIER_ORDER[requested] > TIER_ORDER[maxTier] ? maxTier : requested;
}
