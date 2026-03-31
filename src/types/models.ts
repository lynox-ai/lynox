// === 4.1 Model Tiers ===

export type ModelTier = 'opus' | 'sonnet' | 'haiku';
export const MODEL_TIER_SET: ReadonlySet<ModelTier> = new Set(['opus', 'sonnet', 'haiku']);

export const MODEL_MAP: Record<ModelTier, string> = {
  'opus':   'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku':  'claude-haiku-4-5-20251001',
};

/** Approximate characters per token for context estimation. */
export const CHARS_PER_TOKEN = 3.5;

export const CONTEXT_WINDOW: Record<string, number> = {
  'claude-opus-4-6':         1_000_000,
  'claude-sonnet-4-6':         200_000,
  'claude-haiku-4-5-20251001': 200_000,
};

/** Model-aware default max_tokens output. Opus gets more headroom for long-form output. */
export const DEFAULT_MAX_TOKENS: Record<string, number> = {
  'claude-opus-4-6':         32_000,
  'claude-sonnet-4-6':       16_000,
  'claude-haiku-4-5-20251001': 8_192,
};

/** Model-aware max continuation attempts. Opus can sustain more with 1M context. */
export const MAX_CONTINUATIONS: Record<string, number> = {
  'claude-opus-4-6':           20,
  'claude-sonnet-4-6':         10,
  'claude-haiku-4-5-20251001':  5,
};

// === Thinking & Effort ===

export type ThinkingMode =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'adaptive' }
  | { type: 'disabled' };

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
export const EFFORT_LEVEL_SET: ReadonlySet<EffortLevel> = new Set(['low', 'medium', 'high', 'max']);
