/**
 * Set-Bench v4 cells. Narrow scope: Anthropic + Mistral natively. OpenAI
 * and Google adapters exist in the engine but haven't been parity-verified
 * across the 8 lynox-real-world axes — surfacing benched numbers for them
 * before that verification would risk publishing silent-degradation
 * results (tool-call format quirks, missing prompt-cache, structured-output
 * parsing differences). They re-enter the panel post-launch once each
 * passes a feature-parity smoke (see backlog).
 *
 * Model panel (refreshed 2026-05-29 against docs.mistral.ai/models/overview):
 *   - haiku-class:  Anthropic Haiku 4.5 + Mistral ministral-3b-2512 + ministral-8b-2512
 *   - mid-class:    Mistral ministral-14b-2512 (Ministral 3 14B, new gen-3 mid model)
 *   - sonnet-class: Anthropic Sonnet 4.6 + Mistral mistral-large-latest + mistral-large-2512 (pinned)
 *   - opus-class:   Anthropic Opus 4.7 + Mistral mistral-medium-2604 (Medium 3.5)
 *
 * magistral-medium-2509 was DROPPED from the panel 2026-05-29: Mistral
 * deprecated the entire Magistral reasoning family (magistral-medium-2509
 * retires 2026-07-31, magistral-small-2509 already retired 2026-04-30).
 * The deep/reasoning tier candidate is now mistral-medium-2604 (Medium 3.5,
 * agentic/coding-optimised) measured against mistral-large-2512 (Large 3,
 * hybrid reasoning) — this run picks the Magistral successor.
 *
 * Each model runs against ALL 8 axes — the same panel × 8 axes = the
 * matrix the page renders.
 *
 * Pricing sourced from `src/core/pricing.ts`. Anthropic cache rates:
 * read = 10% of input rate, write = 125% (Anthropic's published
 * multipliers). Mistral does not expose a native prompt-cache field;
 * cache rates are left undefined (warm = cold for those cells).
 */

import { ALL_AXES } from './types.js';
import type { SetBenchCell } from './types.js';

export const MISTRAL = 'https://api.mistral.ai/v1';

// Mistral's openai-compat API rejects parallel tool_use on large/magistral
// (Phase 2 finding) — keep this off for every Mistral cell.
const MISTRAL_PROVIDER_EXTRAS = { parallel_tool_calls: false } as const;

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
// Mistral exposes native prompt cache via `prompt_tokens_details.cached_tokens`
// in the SSE stream; cached input is billed at 10% of the input rate
// (per Mistral pricing docs 2026-05-24). Write cost is implicit/automatic — no
// separate cacheWritePerMillion field needed.
//
// Models 2410 → 2512: Mistral retired ministral-3b/8b-2410 on 2025-12-31;
// replacement gen 3 models (-2512) have multimodal input + larger context
// (256k vs 128k). Pricing went up modestly (3b: +150%, 8b: +50%) for the
// gen-3 capabilities.
// Mistral Large 3 (Dec 2025): 75% price cut vs Large 2. Was $2/$6, now $0.50/$1.50.
// Pricing verified 2026-05-29 against mistral.ai/pricing.
const PRICE_MINISTRAL_3B_2512 = {
  inputPerMillion: 0.10, outputPerMillion: 0.10, cacheReadPerMillion: 0.010,
} as const;
const PRICE_MINISTRAL_8B_2512 = {
  inputPerMillion: 0.15, outputPerMillion: 0.15, cacheReadPerMillion: 0.015,
} as const;
// Ministral 3 14B (gen-3 mid model, Dec 2025): text + vision, fills the gap
// between 8B and Large 3.
const PRICE_MINISTRAL_14B_2512 = {
  inputPerMillion: 0.20, outputPerMillion: 0.20, cacheReadPerMillion: 0.020,
} as const;
const PRICE_MISTRAL_LARGE_2512 = {
  inputPerMillion: 0.50, outputPerMillion: 1.50, cacheReadPerMillion: 0.05,
} as const;
// Mistral Medium 3.5 (v26.04, dated snapshot mistral-medium-2604): agentic/
// coding-optimised, Magistral successor candidate for the deep/reasoning tier.
const PRICE_MISTRAL_MEDIUM_2604 = {
  inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.15,
} as const;

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
  label: 'mistral-ministral-3b-2512',
  provider: 'openai',
  modelId: 'ministral-3b-2512',
  apiBaseURL: MISTRAL,
  apiKeyEnv: MISTRAL_KEY,
  pricing: PRICE_MINISTRAL_3B_2512,
  pinned: true,
  providerExtras: MISTRAL_PROVIDER_EXTRAS,
};

const MINISTRAL_8B: CellTemplate = {
  label: 'mistral-ministral-8b-2512',
  provider: 'openai',
  modelId: 'ministral-8b-2512',
  apiBaseURL: MISTRAL,
  apiKeyEnv: MISTRAL_KEY,
  pricing: PRICE_MINISTRAL_8B_2512,
  pinned: true,
  providerExtras: MISTRAL_PROVIDER_EXTRAS,
};

const MINISTRAL_14B: CellTemplate = {
  label: 'mistral-ministral-14b-2512',
  provider: 'openai',
  modelId: 'ministral-14b-2512',
  apiBaseURL: MISTRAL,
  apiKeyEnv: MISTRAL_KEY,
  pricing: PRICE_MINISTRAL_14B_2512,
  pinned: true,
  providerExtras: MISTRAL_PROVIDER_EXTRAS,
};

const MISTRAL_LARGE_LATEST: CellTemplate = {
  label: 'mistral-large-latest',
  provider: 'openai',
  modelId: 'mistral-large-latest',
  apiBaseURL: MISTRAL,
  apiKeyEnv: MISTRAL_KEY,
  pricing: PRICE_MISTRAL_LARGE_2512,
  pinned: false,
  providerExtras: MISTRAL_PROVIDER_EXTRAS,
};

const MISTRAL_LARGE_2512: CellTemplate = {
  label: 'mistral-large-2512',
  provider: 'openai',
  modelId: 'mistral-large-2512',
  apiBaseURL: MISTRAL,
  apiKeyEnv: MISTRAL_KEY,
  pricing: PRICE_MISTRAL_LARGE_2512,
  pinned: true,
  providerExtras: MISTRAL_PROVIDER_EXTRAS,
};

// Mistral Medium 3.5 — the deep/reasoning-tier candidate that replaces the
// deprecated magistral-medium-2509 (retires 2026-07-31). Dated snapshot is
// `mistral-medium-2604` (v26.04); verified against the live GET /v1/models
// list 2026-05-29 (the docs-overview "mistral-medium-3504" ID is rejected
// by the API with invalid_model — aliases mistral-medium-3.5 / -latest also
// resolve here, but we pin the dated snapshot per the drift-discipline note).
const MISTRAL_MEDIUM_2604: CellTemplate = {
  label: 'mistral-medium-2604',
  provider: 'openai',
  modelId: 'mistral-medium-2604',
  apiBaseURL: MISTRAL,
  apiKeyEnv: MISTRAL_KEY,
  pricing: PRICE_MISTRAL_MEDIUM_2604,
  pinned: true,
  providerExtras: MISTRAL_PROVIDER_EXTRAS,
};

const ALL_MODELS: readonly CellTemplate[] = [
  HAIKU_4_5,
  SONNET_4_6,
  OPUS_4_7,
  MINISTRAL_3B,
  MINISTRAL_8B,
  MINISTRAL_14B,
  MISTRAL_LARGE_LATEST,
  MISTRAL_LARGE_2512,
  MISTRAL_MEDIUM_2604,
];

/**
 * Cross-product of all 9 models × all 8 axes = 72 cells. Every cell
 * runs every axis once per --runs N. Default n=10 → 720 model calls
 * per full matrix. Ballpark spend with the seeded scenarios: ~$7.
 */
export const ALL_CELLS: readonly SetBenchCell[] = ALL_AXES.flatMap((axis) =>
  ALL_MODELS.map((m): SetBenchCell => ({ ...m, axis })),
);
