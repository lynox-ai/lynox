// === 4.1 Model Tiers & Providers ===

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export type LLMProvider = 'anthropic' | 'bedrock' | 'vertex' | 'custom';

export const MODEL_MAP: Record<ModelTier, string> = {
  'opus':   'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku':  'claude-haiku-4-5-20251001',
};

/** Bedrock US cross-region inference profiles. */
export const BEDROCK_MODEL_MAP: Record<ModelTier, string> = {
  'opus':   'us.anthropic.claude-opus-4-6-v1',
  'sonnet': 'us.anthropic.claude-sonnet-4-6',
  'haiku':  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
};

/** Bedrock EU Cross-Region Inference — guaranteed EU data residency. */
export const BEDROCK_EU_MODEL_MAP: Record<ModelTier, string> = {
  'opus':   'eu.anthropic.claude-opus-4-6-v1',
  'sonnet': 'eu.anthropic.claude-sonnet-4-6',
  'haiku':  'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
};

export const VERTEX_MODEL_MAP: Record<ModelTier, string> = {
  'opus':   'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku':  'claude-haiku-4-5@20251001',
};

const ALL_MODEL_MAPS: Record<Exclude<LLMProvider, 'custom'>, Record<ModelTier, string>> = {
  anthropic: MODEL_MAP,
  bedrock: BEDROCK_MODEL_MAP,
  vertex: VERTEX_MODEL_MAP,
};

/**
 * Resolve a tier name to a provider-specific model ID.
 * For Bedrock, auto-selects EU or US cross-region inference profile based on awsRegion.
 */
export function getModelId(tier: ModelTier, provider: LLMProvider = 'anthropic', bedrockEu = false): string {
  if (provider === 'bedrock') {
    return bedrockEu ? BEDROCK_EU_MODEL_MAP[tier] : BEDROCK_MODEL_MAP[tier];
  }
  // 'custom' provider (LiteLLM etc.) uses standard Anthropic model IDs — proxy maps them
  if (provider === 'custom') return MODEL_MAP[tier];
  return ALL_MODEL_MAPS[provider][tier];
}

/**
 * Normalize a provider-specific model ID to its base Anthropic model ID.
 * E.g. 'eu.anthropic.claude-sonnet-4-6' → 'claude-sonnet-4-6'
 *      'us.anthropic.claude-opus-4-6-v1' → 'claude-opus-4-6'
 *      'claude-haiku-4-5@20251001' → 'claude-haiku-4-5-20251001' (Vertex)
 * Returns the input unchanged if already a base model ID or tier alias.
 */
export function normalizeModelId(model: string): string {
  // Strip Bedrock region prefix: 'eu.anthropic.' / 'us.anthropic.'
  let normalized = model.replace(/^(?:eu|us)\.anthropic\./, '');
  // Strip Bedrock version suffix: '-v1', '-v1:0'
  normalized = normalized.replace(/-v\d+(?::\d+)?$/, '');
  // Vertex uses @ instead of - for date suffix: 'claude-haiku-4-5@20251001'
  normalized = normalized.replace(/@(\d{8})/, '-$1');
  return normalized;
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

/** Look up context window size. Normalizes Bedrock/Vertex model IDs automatically. */
export function getContextWindow(model: string): number {
  return _CONTEXT_WINDOW[model] ?? _CONTEXT_WINDOW[normalizeModelId(model)] ?? 200_000;
}

/** Look up default max output tokens. Normalizes Bedrock/Vertex model IDs automatically. */
export function getDefaultMaxTokens(model: string): number {
  return _DEFAULT_MAX_TOKENS[model] ?? _DEFAULT_MAX_TOKENS[normalizeModelId(model)] ?? 16_000;
}

/** Look up max continuation attempts. Normalizes Bedrock/Vertex model IDs automatically. */
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

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
