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

const ALL_MODEL_MAPS: Record<Exclude<LLMProvider, 'custom' | 'openai'>, Record<ModelTier, string>> = {
  anthropic: MODEL_MAP,
  vertex: VERTEX_MODEL_MAP,
};

/**
 * Resolve a tier name to a provider-specific model ID.
 */
export function getModelId(tier: ModelTier, provider: LLMProvider = 'anthropic'): string {
  // 'custom' provider (LiteLLM etc.) uses standard Anthropic model IDs — proxy maps them
  if (provider === 'custom') return MODEL_MAP[tier];
  // 'openai' provider uses model ID from profile — tier is ignored (caller sets model directly)
  if (provider === 'openai') return MODEL_MAP[tier];
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
  // Tier-keyed aliases (provider-independent)
  'opus':   1_000_000,
  'sonnet':   200_000,
  'haiku':    200_000,
};

const _DEFAULT_MAX_TOKENS: Record<string, number> = {
  'claude-opus-4-6':         32_000,
  'claude-sonnet-4-6':       16_000,
  'claude-haiku-4-5-20251001': 8_192,
  // Tier-keyed aliases
  'opus':   32_000,
  'sonnet': 16_000,
  'haiku':   8_192,
};

const _MAX_CONTINUATIONS: Record<string, number> = {
  'claude-opus-4-6':           20,
  'claude-sonnet-4-6':         10,
  'claude-haiku-4-5-20251001':  5,
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
