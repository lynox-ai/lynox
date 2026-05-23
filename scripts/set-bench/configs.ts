/**
 * Set-Bench v4 cells. Narrow scope: Anthropic + Mistral natively. OpenAI
 * and Google adapters exist in the engine but haven't been parity-verified
 * across the 8 lynox-real-world axes — surfacing benched numbers for them
 * before that verification would risk publishing silent-degradation
 * results (tool-call format quirks, missing prompt-cache, structured-output
 * parsing differences). They re-enter the panel post-launch once each
 * passes a feature-parity smoke (see backlog).
 *
 * Model panel (per lynox.ai/bench):
 *   - haiku-class:  Anthropic Haiku 4.5 + Mistral ministral-3b-2410 + ministral-8b-2410
 *   - sonnet-class: Anthropic Sonnet 4.6 + Mistral mistral-large-latest + mistral-large-2512 (pinned)
 *   - opus-class:   Anthropic Opus 4.7 + Mistral magistral-medium-2509
 *
 * Each model runs against ALL 8 axes — the same panel × 8 axes = the
 * matrix the page renders.
 *
 * Pricing sourced from `src/core/pricing.ts`. Anthropic cache rates:
 * read = 10% of input rate, write = 125% (Anthropic's published
 * multipliers). Mistral does not expose a native prompt-cache field;
 * cache rates are left undefined (warm = cold for those cells).
 */

import type { SetBenchCell } from './types.js';

export const MISTRAL = 'https://api.mistral.ai/v1';

const ANTHROPIC_KEY = 'ANTHROPIC_API_KEY';
const MISTRAL_KEY = 'MISTRAL_API_KEY';

// ── Anthropic pricing (per million tokens, USD) ─────────────────
// Mirrors src/core/pricing.ts. Cache-read / cache-write computed from
// Anthropic's published 10% / 125% multipliers on the input rate.
const PRICE_HAIKU_4_5 = {
  inputPerMillion: 1, outputPerMillion: 5,
  cacheReadPerMillion: 0.10, cacheWritePerMillion: 1.25,
} as const;
const PRICE_SONNET_4_6 = {
  inputPerMillion: 3, outputPerMillion: 15,
  cacheReadPerMillion: 0.30, cacheWritePerMillion: 3.75,
} as const;
const PRICE_OPUS_4_7 = {
  inputPerMillion: 5, outputPerMillion: 25,
  cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25,
} as const;

// ── Mistral pricing (per million tokens, USD) ───────────────────
// No prompt-cache field exposed → cacheRead/Write unset, warm == cold.
const PRICE_MINISTRAL_3B_2410 = { inputPerMillion: 0.04, outputPerMillion: 0.04 } as const;
const PRICE_MINISTRAL_8B_2410 = { inputPerMillion: 0.10, outputPerMillion: 0.10 } as const;
const PRICE_MISTRAL_LARGE_2512 = { inputPerMillion: 2, outputPerMillion: 6 } as const;
const PRICE_MAGISTRAL_MEDIUM_2509 = { inputPerMillion: 2, outputPerMillion: 5 } as const;

// All 8 axes the v4 bench covers — every model runs every axis.
const AXES = [
  'multi-turn-loop-completion',
  'sub-agent-spawn-orchestration',
  'memory-grounded-reasoning',
  'workflow-composition',
  'long-context-with-tools',
  'tool-chain-with-backtrack',
  'cron-task-cold-start',
  'real-world-grounded-strategy',
] as const;

type CellTemplate = Omit<SetBenchCell, 'axis'>;

const HAIKU_4_5: CellTemplate = {
  label: 'anthropic-haiku-4-5',
  provider: 'anthropic',
  modelId: 'claude-haiku-4-5-20251001',
  apiKeyEnv: ANTHROPIC_KEY,
  pricing: PRICE_HAIKU_4_5,
  pinned: true,
};

const SONNET_4_6: CellTemplate = {
  label: 'anthropic-sonnet-4-6',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  apiKeyEnv: ANTHROPIC_KEY,
  pricing: PRICE_SONNET_4_6,
  pinned: true,
};

const OPUS_4_7: CellTemplate = {
  label: 'anthropic-opus-4-7',
  provider: 'anthropic',
  modelId: 'claude-opus-4-7',
  apiKeyEnv: ANTHROPIC_KEY,
  pricing: PRICE_OPUS_4_7,
  pinned: true,
};

const MINISTRAL_3B: CellTemplate = {
  label: 'mistral-ministral-3b-2410',
  provider: 'openai',
  modelId: 'ministral-3b-2410',
  apiBaseURL: MISTRAL,
  apiKeyEnv: MISTRAL_KEY,
  pricing: PRICE_MINISTRAL_3B_2410,
  pinned: true,
};

const MINISTRAL_8B: CellTemplate = {
  label: 'mistral-ministral-8b-2410',
  provider: 'openai',
  modelId: 'ministral-8b-2410',
  apiBaseURL: MISTRAL,
  apiKeyEnv: MISTRAL_KEY,
  pricing: PRICE_MINISTRAL_8B_2410,
  pinned: true,
};

const MISTRAL_LARGE_LATEST: CellTemplate = {
  label: 'mistral-large-latest',
  provider: 'openai',
  modelId: 'mistral-large-latest',
  apiBaseURL: MISTRAL,
  apiKeyEnv: MISTRAL_KEY,
  pricing: PRICE_MISTRAL_LARGE_2512,
  pinned: false,
};

const MISTRAL_LARGE_2512: CellTemplate = {
  label: 'mistral-large-2512',
  provider: 'openai',
  modelId: 'mistral-large-2512',
  apiBaseURL: MISTRAL,
  apiKeyEnv: MISTRAL_KEY,
  pricing: PRICE_MISTRAL_LARGE_2512,
  pinned: true,
};

const MAGISTRAL_MEDIUM: CellTemplate = {
  label: 'mistral-magistral-medium-2509',
  provider: 'openai',
  modelId: 'magistral-medium-2509',
  apiBaseURL: MISTRAL,
  apiKeyEnv: MISTRAL_KEY,
  pricing: PRICE_MAGISTRAL_MEDIUM_2509,
  pinned: true,
};

const ALL_MODELS: readonly CellTemplate[] = [
  HAIKU_4_5,
  SONNET_4_6,
  OPUS_4_7,
  MINISTRAL_3B,
  MINISTRAL_8B,
  MISTRAL_LARGE_LATEST,
  MISTRAL_LARGE_2512,
  MAGISTRAL_MEDIUM,
];

/**
 * Cross-product of all 8 models × all 8 axes = 64 cells. Every cell
 * runs every axis once per --runs N. Default n=10 → 640 model calls
 * per full matrix. Ballpark spend with the seeded scenarios: ~$5.
 */
export const ALL_CELLS: readonly SetBenchCell[] = AXES.flatMap((axis) =>
  ALL_MODELS.map((m): SetBenchCell => ({ ...m, axis })),
);
