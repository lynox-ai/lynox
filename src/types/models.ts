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
 * Pure function — no side effects. Engine init wires the result via
 * `setOpenAIModelResolver()`.
 */
export function getOpenAIModelMap(apiBaseURL: string | undefined): Record<ModelTier, string> | null {
  if (!apiBaseURL) return null;
  if (apiBaseURL.includes('mistral.ai')) return MISTRAL_MODEL_MAP;
  return null;
}

// Process-global tier→model resolver for openai-compat providers.
// Set once at engine bootstrap by `setOpenAIModelResolver()` based on the
// active config. Without this, `getModelId(tier, 'openai')` would return
// Anthropic IDs which downstream Mistral/OpenAI endpoints reject.
let _openaiModelMap: Record<ModelTier, string> | null = null;
let _openaiFallbackModelId: string | null = null;

/**
 * Configure the active openai-compat tier→model resolver. Called by engine
 * bootstrap once `userConfig` is loaded. Pass `null` (or omit fields) to
 * reset to legacy behaviour (returns Anthropic IDs — fine for tests).
 */
export function setOpenAIModelResolver(opts: {
  map?: Record<ModelTier, string> | null;
  fallbackModelId?: string | null;
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

const _CONTEXT_WINDOW: Record<string, number> = {
  'claude-opus-4-6':         1_000_000,
  'claude-sonnet-4-6':         200_000,
  'claude-haiku-4-5-20251001': 200_000,
  // Mistral set — large + magistral both 128K, small 32K (per Mistral docs)
  'mistral-small-2603':         32_000,
  'mistral-large-2512':        131_072,
  'magistral-medium-2509':     131_072,
  // Tier-keyed aliases (provider-independent)
  'opus':   1_000_000,
  'sonnet':   200_000,
  'haiku':    200_000,
};

const _DEFAULT_MAX_TOKENS: Record<string, number> = {
  'claude-opus-4-6':         32_000,
  'claude-sonnet-4-6':       16_000,
  'claude-haiku-4-5-20251001': 8_192,
  // Mistral set
  'mistral-small-2603':       8_192,
  'mistral-large-2512':      16_000,
  'magistral-medium-2509':   32_000,
  // Tier-keyed aliases
  'opus':   32_000,
  'sonnet': 16_000,
  'haiku':   8_192,
};

const _MAX_CONTINUATIONS: Record<string, number> = {
  'claude-opus-4-6':           20,
  'claude-sonnet-4-6':         10,
  'claude-haiku-4-5-20251001':  5,
  // Mistral set — mirror tier ordering (small=5 / large=10 / magistral=20)
  'mistral-small-2603':         5,
  'mistral-large-2512':        10,
  'magistral-medium-2509':     20,
  // Tier-keyed aliases
  'opus':   20,
  'sonnet': 10,
  'haiku':   5,
};

/** Look up context window size. Normalizes provider-prefixed model IDs automatically. */
export function getContextWindow(model: string): number {
  return _CONTEXT_WINDOW[model] ?? _CONTEXT_WINDOW[normalizeModelId(model)] ?? 200_000;
}

/** Look up default max output tokens. Normalizes provider-prefixed model IDs automatically. */
export function getDefaultMaxTokens(model: string): number {
  return _DEFAULT_MAX_TOKENS[model] ?? _DEFAULT_MAX_TOKENS[normalizeModelId(model)] ?? 16_000;
}

/** Look up max continuation attempts. Normalizes provider-prefixed model IDs automatically. */
export function getMaxContinuations(model: string): number {
  return _MAX_CONTINUATIONS[model] ?? _MAX_CONTINUATIONS[normalizeModelId(model)] ?? 10;
}

// Re-export raw maps for backward compatibility (e.g. tier-keyed lookups via MODEL_MAP[tier])
export const CONTEXT_WINDOW = _CONTEXT_WINDOW;
export const DEFAULT_MAX_TOKENS = _DEFAULT_MAX_TOKENS;
export const MAX_CONTINUATIONS = _MAX_CONTINUATIONS;

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
