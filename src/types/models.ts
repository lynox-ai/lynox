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

/** Approximate characters per token for context estimation. */
export const CHARS_PER_TOKEN = 3.5;

export const CONTEXT_WINDOW: Record<string, number> = {
  'claude-opus-4-6':         1_000_000,
  'claude-sonnet-4-6':         200_000,
  'claude-haiku-4-5-20251001': 200_000,
  // Tier-keyed aliases (provider-independent)
  'opus':   1_000_000,
  'sonnet':   200_000,
  'haiku':    200_000,
};

/** Model-aware default max_tokens output. Opus gets more headroom for long-form output. */
export const DEFAULT_MAX_TOKENS: Record<string, number> = {
  'claude-opus-4-6':         32_000,
  'claude-sonnet-4-6':       16_000,
  'claude-haiku-4-5-20251001': 8_192,
  // Tier-keyed aliases
  'opus':   32_000,
  'sonnet': 16_000,
  'haiku':   8_192,
};

/** Model-aware max continuation attempts. Opus can sustain more with 1M context. */
export const MAX_CONTINUATIONS: Record<string, number> = {
  'claude-opus-4-6':           20,
  'claude-sonnet-4-6':         10,
  'claude-haiku-4-5-20251001':  5,
  // Tier-keyed aliases
  'opus':   20,
  'sonnet': 10,
  'haiku':   5,
};

// === Thinking & Effort ===

export type ThinkingMode =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'adaptive' }
  | { type: 'disabled' };

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
