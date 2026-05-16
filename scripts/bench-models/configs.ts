import type { BenchConfig } from './types.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';
const OPUS_46 = 'claude-opus-4-6';
const OPUS_47 = 'claude-opus-4-7';

const MISTRAL_BASE = 'https://api.mistral.ai/v1';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/** Phase 1 config matrix: 3 models × 2 effort levels = 6 configs. */
export const PHASE_1_CONFIGS: readonly BenchConfig[] = [
  { label: 'haiku',           tier: 'anthropic-native', provider: 'anthropic', modelId: HAIKU,   apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'none',   thinking: 'disabled' },
  { label: 'sonnet-medium',   tier: 'anthropic-native', provider: 'anthropic', modelId: SONNET,  apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'medium', thinking: 'adaptive' },
  { label: 'sonnet-high',     tier: 'anthropic-native', provider: 'anthropic', modelId: SONNET,  apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'high',   thinking: 'adaptive' },
  { label: 'opus-medium',     tier: 'anthropic-native', provider: 'anthropic', modelId: OPUS_46, apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'medium', thinking: 'adaptive' },
  { label: 'opus-high',       tier: 'anthropic-native', provider: 'anthropic', modelId: OPUS_46, apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'high',   thinking: 'adaptive' },
  { label: 'opus-max',        tier: 'anthropic-native', provider: 'anthropic', modelId: OPUS_46, apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'max',    thinking: 'adaptive' },
];

/**
 * Phase 2 matrix: Opus 4.7 with xhigh effort, targeting scenarios Phase 1
 * didn't cover (tool use, long context, agent orchestration, creative).
 */
export const PHASE_2_CONFIGS: readonly BenchConfig[] = [
  { label: 'haiku',           tier: 'anthropic-native', provider: 'anthropic', modelId: HAIKU,   apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'none',   thinking: 'disabled' },
  { label: 'sonnet-high',     tier: 'anthropic-native', provider: 'anthropic', modelId: SONNET,  apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'high',   thinking: 'adaptive' },
  { label: 'opus-47-high',    tier: 'anthropic-native', provider: 'anthropic', modelId: OPUS_47, apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'high',   thinking: 'adaptive' },
  { label: 'opus-47-xhigh',   tier: 'anthropic-native', provider: 'anthropic', modelId: OPUS_47, apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'xhigh',  thinking: 'adaptive' },
];

/**
 * Phase 3 matrix: opus-47-high dropped (strictly dominated by xhigh per Phase 2).
 * Focus on the 3 non-dominated configs for the final Managed-Opus decision.
 */
export const PHASE_3_CONFIGS: readonly BenchConfig[] = [
  { label: 'haiku',           tier: 'anthropic-native', provider: 'anthropic', modelId: HAIKU,   apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'none',   thinking: 'disabled' },
  { label: 'sonnet-high',     tier: 'anthropic-native', provider: 'anthropic', modelId: SONNET,  apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'high',   thinking: 'adaptive' },
  { label: 'opus-47-xhigh',   tier: 'anthropic-native', provider: 'anthropic', modelId: OPUS_47, apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'xhigh',  thinking: 'adaptive' },
];

/**
 * HN companion-post matrix — 8 configs across 3 provider camps. Picked to
 * give the HN audience the comparison they ALWAYS demand in comments:
 *   - frontier closed-source (Anthropic, OpenAI, Google)
 *   - frontier open-weights (DeepSeek, Llama, Mistral)
 *   - cost / quality / pass-rate per model, on the SAME 4 scenarios.
 *
 * `provider`/`apiBaseURL`/`openaiModelId` are the runtime knobs; `tier` is
 * just the report-grouping label. OpenRouter routes 4 of these through the
 * same `openai`-provider path with the same base URL — the only thing that
 * differs per slug is `openaiModelId`. Mistral has its own base URL because
 * we want to test the lynox-native Mistral path, not Mistral-via-OpenRouter.
 *
 * Auth: `apiKeyEnv` is resolved at run time. Set the three env vars before
 * the run; the runner refuses to start any config whose key is missing.
 */
/**
 * Per-config pricing in $/M tokens. Anthropic configs omit this and let the
 * runner read `core/pricing.ts::getPricing()` — the OSS source of truth for
 * the engine. Non-Anthropic configs MUST supply pricing because `getPricing`
 * silently falls back to opus rates for unknown model IDs, which would
 * inflate the open-weights tier ~5× and make the HN comparison dishonest.
 *
 * Pricing reference (verified against provider docs 2026-05; HN-post should
 * link the doc-page of each rate):
 *   - mistral-large-latest: $2 / $6   (Mistral docs)
 *   - openai/gpt-4.1:       $2 / $8   (OpenRouter, passthrough OpenAI)
 *   - deepseek/deepseek-chat: $0.27 / $1.10 (OpenRouter, passthrough DeepSeek)
 *   - meta-llama/llama-3.3-70b-instruct: $0.59 / $0.79 (OpenRouter avg)
 *   - google/gemini-2.5-pro: $1.25 / $5 (OpenRouter, passthrough Google)
 *
 * OpenRouter adds ~5% on top — out-of-scope for the comparison; we publish
 * provider-list rates so the HN reader can cross-check.
 */
export const HN_BENCH_CONFIGS: readonly BenchConfig[] = [
  // ── Anthropic native ── (pricing via core/pricing.ts)
  { label: 'claude-sonnet-46',  tier: 'anthropic-native', provider: 'anthropic', modelId: SONNET,  apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'high',   thinking: 'adaptive' },
  { label: 'claude-haiku-45',   tier: 'anthropic-native', provider: 'anthropic', modelId: HAIKU,   apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'none',   thinking: 'disabled' },
  { label: 'claude-opus-47',    tier: 'anthropic-native', provider: 'anthropic', modelId: OPUS_47, apiKeyEnv: 'ANTHROPIC_API_KEY', effort: 'xhigh',  thinking: 'adaptive' },

  // ── Mistral native ──
  // Pinned to `mistral-large-2512` (2025-12 release) instead of the generic
  // `mistral-large-latest` alias because Mistral applies per-model rate
  // limits and the `latest` alias inherits the lowest-tier limit (15 RPM).
  // The dated 2512 build has 6 RPS = 360 RPM on this workspace.
  //
  // `providerExtras.parallel_tool_calls: false` is the critical knob —
  // Mistral defaults to parallel tool execution which emits 3+ tool_uses
  // per turn. With parallel off, Mistral converges in ~6 turns (one tool
  // per turn) instead of looping past `maxIterations`. Verified via direct
  // API probe 2026-05-16.
  {
    label: 'mistral-large',  tier: 'mistral-native', provider: 'openai',
    modelId: 'mistral-large-2512', apiBaseURL: MISTRAL_BASE, openaiModelId: 'mistral-large-2512',
    apiKeyEnv: 'MISTRAL_API_KEY', effort: 'none', thinking: 'disabled',
    pricing: { inputPerMillion: 2, outputPerMillion: 6 },
    providerExtras: { parallel_tool_calls: false },
  },

  // ── OpenRouter (open-weights + frontier-non-Anthropic) ──
  {
    label: 'gpt-41', tier: 'openrouter', provider: 'openai',
    modelId: 'openai/gpt-4.1', apiBaseURL: OPENROUTER_BASE, openaiModelId: 'openai/gpt-4.1',
    apiKeyEnv: 'OPENROUTER_API_KEY', effort: 'none', thinking: 'disabled',
    pricing: { inputPerMillion: 2, outputPerMillion: 8 },
  },
  {
    label: 'deepseek-v3', tier: 'openrouter', provider: 'openai',
    modelId: 'deepseek/deepseek-chat', apiBaseURL: OPENROUTER_BASE, openaiModelId: 'deepseek/deepseek-chat',
    apiKeyEnv: 'OPENROUTER_API_KEY', effort: 'none', thinking: 'disabled',
    pricing: { inputPerMillion: 0.27, outputPerMillion: 1.10 },
  },
  {
    label: 'llama-33-70b', tier: 'openrouter', provider: 'openai',
    modelId: 'meta-llama/llama-3.3-70b-instruct', apiBaseURL: OPENROUTER_BASE, openaiModelId: 'meta-llama/llama-3.3-70b-instruct',
    apiKeyEnv: 'OPENROUTER_API_KEY', effort: 'none', thinking: 'disabled',
    pricing: { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  },
  {
    label: 'gemini-25-pro', tier: 'openrouter', provider: 'openai',
    modelId: 'google/gemini-2.5-pro', apiBaseURL: OPENROUTER_BASE, openaiModelId: 'google/gemini-2.5-pro',
    apiKeyEnv: 'OPENROUTER_API_KEY', effort: 'none', thinking: 'disabled',
    pricing: { inputPerMillion: 1.25, outputPerMillion: 5 },
  },
];

/** Smoke-test config: single cheapest run to validate infra. */
export const SMOKE_CONFIG: BenchConfig = PHASE_1_CONFIGS[0]!;

export function getConfig(label: string): BenchConfig | undefined {
  return HN_BENCH_CONFIGS.find(c => c.label === label)
      ?? PHASE_1_CONFIGS.find(c => c.label === label)
      ?? PHASE_2_CONFIGS.find(c => c.label === label)
      ?? PHASE_3_CONFIGS.find(c => c.label === label);
}
