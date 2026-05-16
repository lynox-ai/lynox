/**
 * Set-Bench cells. Two axes, twelve cells total.
 *
 * For each axis we ship:
 *   - **Anthropic baseline** (1 cell) — the bar we are measuring Mistral
 *     against.
 *   - **Mistral pinned snapshots** (2 cells) — the dated versions we wire
 *     through the engine's tier map.
 *   - **Mistral latest aliases** (2 cells) — what an inattentive operator
 *     gets when they leave `*-latest` in their config. Drift surface.
 *   - **One extra Mistral candidate** per axis — Magistral on tool-chain,
 *     Ministral on orchestration — to widen the field.
 *
 * Cost is computed from headline pricing per million tokens. Cache discount
 * is intentionally NOT modelled — bench runs are single-turn so cache hits
 * would be zero anyway.
 */

import type { SetBenchCell } from './types.js';

const MISTRAL = 'https://api.mistral.ai/v1';

const ANTHROPIC_KEY = 'ANTHROPIC_API_KEY';
const MISTRAL_KEY = 'MISTRAL_API_KEY';

// ── TOOL_CHAIN axis: sonnet-tier work, Anthropic Sonnet 4.6 as bar ─────

export const TOOL_CHAIN_CELLS: readonly SetBenchCell[] = [
  {
    label: 'anthropic-sonnet-4-6',
    axis: 'tool-chain',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    apiKeyEnv: ANTHROPIC_KEY,
    pricing: { inputPerMillion: 3, outputPerMillion: 15 },
    pinned: true,
  },
  // Mistral pinned
  {
    label: 'mistral-large-2512',
    axis: 'tool-chain',
    provider: 'openai',
    modelId: 'mistral-large-2512',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: { inputPerMillion: 2, outputPerMillion: 6 },
    pinned: true,
    providerExtras: { parallel_tool_calls: false },
  },
  {
    label: 'magistral-medium-2509',
    axis: 'tool-chain',
    provider: 'openai',
    modelId: 'magistral-medium-2509',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: { inputPerMillion: 2, outputPerMillion: 5 },
    pinned: true,
    providerExtras: { parallel_tool_calls: false },
  },
  // Mistral *-latest (drift surface)
  {
    label: 'mistral-large-latest',
    axis: 'tool-chain',
    provider: 'openai',
    modelId: 'mistral-large-latest',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: { inputPerMillion: 2, outputPerMillion: 6 },
    pinned: false,
    providerExtras: { parallel_tool_calls: false },
  },
  {
    label: 'magistral-medium-latest',
    axis: 'tool-chain',
    provider: 'openai',
    modelId: 'magistral-medium-latest',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: { inputPerMillion: 2, outputPerMillion: 5 },
    pinned: false,
    providerExtras: { parallel_tool_calls: false },
  },
  // Wildcard: mistral-medium (between small and large, tool-use capable)
  {
    label: 'mistral-medium-latest',
    axis: 'tool-chain',
    provider: 'openai',
    modelId: 'mistral-medium-latest',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: { inputPerMillion: 0.40, outputPerMillion: 2 },
    pinned: false,
    providerExtras: { parallel_tool_calls: false },
  },
];

// ── ORCHESTRATION axis: haiku-tier work, Anthropic Haiku 4.5 as bar ────

export const ORCHESTRATION_CELLS: readonly SetBenchCell[] = [
  {
    label: 'anthropic-haiku-4-5',
    axis: 'orchestration',
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    apiKeyEnv: ANTHROPIC_KEY,
    pricing: { inputPerMillion: 1, outputPerMillion: 5 },
    pinned: true,
  },
  // Mistral pinned
  {
    label: 'mistral-small-2603',
    axis: 'orchestration',
    provider: 'openai',
    modelId: 'mistral-small-2603',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: { inputPerMillion: 0.20, outputPerMillion: 0.60 },
    pinned: true,
  },
  // Mistral latest
  {
    label: 'mistral-small-latest',
    axis: 'orchestration',
    provider: 'openai',
    modelId: 'mistral-small-latest',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: { inputPerMillion: 0.20, outputPerMillion: 0.60 },
    pinned: false,
  },
  // Ministral 8B/3B (cheaper still — direct haiku-replacement candidates)
  {
    label: 'ministral-8b-2410',
    axis: 'orchestration',
    provider: 'openai',
    modelId: 'ministral-8b-2410',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: { inputPerMillion: 0.10, outputPerMillion: 0.10 },
    pinned: true,
  },
  {
    label: 'ministral-3b-2410',
    axis: 'orchestration',
    provider: 'openai',
    modelId: 'ministral-3b-2410',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: { inputPerMillion: 0.04, outputPerMillion: 0.04 },
    pinned: true,
  },
  // open-mistral-nemo (12B open-weight, tool-use capable, ~haiku price point)
  {
    label: 'open-mistral-nemo',
    axis: 'orchestration',
    provider: 'openai',
    modelId: 'open-mistral-nemo',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.15 },
    pinned: false,
  },
];

export const ALL_CELLS: readonly SetBenchCell[] = [
  ...TOOL_CHAIN_CELLS,
  ...ORCHESTRATION_CELLS,
];
