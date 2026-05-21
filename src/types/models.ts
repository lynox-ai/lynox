import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta.js';

// === 4.1 Model Tiers & Providers ===

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

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
  /** Model ID to send in requests (e.g. 'mistral-large-latest'). */
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
  'opus':   'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku':  'claude-haiku-4-5-20251001',
};

/** Vertex AI Claude model identifiers (Google Cloud). */
export const VERTEX_MODEL_MAP: Record<ModelTier, string> = {
  'opus':   'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku':  'claude-haiku-4-5',
};

/** Canonical Mistral base URL (used for tier-map detection). */
export const MISTRAL_API_BASE = 'https://api.mistral.ai/v1';

/**
 * Mistral tier-set for openai-provider mode.
 * Pinned to specific snapshots so behaviour stays reproducible across model
 * refreshes. `mistral-large-latest` would auto-roll silently — bad for cost
 * and behaviour-drift in managed-EU tenants.
 *   haiku  → mistral-small-2603     (cheap, orchestration)
 *   sonnet → mistral-large-2512     (workhorse, tool-use)
 *   opus   → magistral-medium-2509  (reasoning-heavy)
 */
export const MISTRAL_MODEL_MAP: Record<ModelTier, string> = {
  'opus':   'magistral-medium-2509',
  'sonnet': 'mistral-large-2512',
  'haiku':  'mistral-small-2603',
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
    tier: 'opus',
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
    tier: 'opus',
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
    tier: 'sonnet',
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
    tier: 'haiku',
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
    tier: 'haiku',
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
    tier: 'opus',
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
    tier: 'opus',
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
    tier: 'sonnet',
    contextWindow: 1_000_000,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: ONE_M_BETA,
    features: CLAUDE_FEATURES,
    pricing: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
    uiLabel: 'Claude Sonnet 4.6 (1M)',
  },
  // === Mistral tier-set (eu-sovereign managed via openai-compat) ===
  // cacheWrite/cacheRead mirror input rate — Mistral exposes
  // `prompt_cache_key` but bills the cached prefix at the standard input
  // rate. Setting these to zero would under-bill opportunistic cache hits.
  'mistral-small-2603': {
    id: 'mistral-small-2603',
    provider: 'openai',
    tier: 'haiku',
    contextWindow: 32_000,
    defaultMaxOutput: 8_192,
    maxContinuations: 5,
    betaHeaders: [],
    features: MISTRAL_FEATURES_SMALL,
    pricing: { input: 0.20, output: 0.60, cacheWrite: 0.20, cacheRead: 0.20 },
    uiLabel: 'Mistral Small',
  },
  'mistral-large-2512': {
    id: 'mistral-large-2512',
    provider: 'openai',
    tier: 'sonnet',
    contextWindow: 131_072,
    defaultMaxOutput: 16_000,
    maxContinuations: 10,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 2, output: 6, cacheWrite: 2, cacheRead: 2 },
    uiLabel: 'Mistral Large',
  },
  'magistral-medium-2509': {
    id: 'magistral-medium-2509',
    provider: 'openai',
    tier: 'opus',
    contextWindow: 131_072,
    defaultMaxOutput: 32_000,
    maxContinuations: 20,
    betaHeaders: [],
    features: MISTRAL_FEATURES_LARGE,
    pricing: { input: 2, output: 5, cacheWrite: 2, cacheRead: 2 },
    uiLabel: 'Magistral Medium',
  },
  // === Mistral bench-only roster (set-bench cost tracking; no tier routing) ===
  // contextWindow values from Mistral docs (2026-05). These models aren't
  // wired into MISTRAL_MODEL_MAP — they're only referenced by set-bench and
  // cost-guard so the user can opt-in via openai_model_id.
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

/** Effective context window after applying the user's optional cap. Mirrors
 *  Agent._effectiveContextWindow so server-side endpoints + session bookkeeping
 *  can compute the same value the agent actually uses internally — staging
 *  2026-05-18 shipped this with three separate copies of the formula that
 *  drifted (UI showed 423% because /sessions returned the native window
 *  while the agent had applied a smaller user cap). Single source of truth.
 *  Never returns more than the model's native window. */
export function effectiveContextWindow(model: string, userCap: number | undefined): number {
  const native = getContextWindow(model);
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

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// === Step Hints (LLM-driven per-step configuration) ===

/** Hints the LLM attaches to options or plan phases to configure the next step. */
export interface StepHint {
  model?: ModelTier | undefined;
  thinking?: ThinkingHint | undefined;
  effort?: EffortLevel | undefined;
}

/** Tier ordering for clamping — lower index = cheaper/faster. */
const TIER_ORDER: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

/** Clamp a requested tier to the maximum allowed tier. Returns requested if no cap set. */
export function clampTier(requested: ModelTier, maxTier: ModelTier | undefined): ModelTier {
  if (!maxTier) return requested;
  return TIER_ORDER[requested] > TIER_ORDER[maxTier] ? maxTier : requested;
}
