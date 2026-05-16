/**
 * Set-Bench cells. Phase 3 PR D — extends Phase 2's tool-chain +
 * orchestration coverage with the 6 new use-case axes (kg-extraction,
 * dag-planning, memory-extraction, long-context, code-review,
 * multi-step-reasoning) and the full Mistral roster (pinned + latest).
 *
 * For each axis we ship:
 *   - **Anthropic baseline** — the tier-appropriate Claude bar:
 *       haiku-tier   → Haiku 4.5     (orchestration, kg-extraction,
 *                                     dag-planning, memory-extraction)
 *       sonnet-tier  → Sonnet 4.6    (tool-chain, long-context, code-review)
 *       opus-tier    → Opus 4.7      (multi-step-reasoning)
 *   - **Mistral pinned snapshots** — dated versions wired through the
 *     engine's tier map. Source-of-truth pricing in `src/core/pricing.ts`.
 *   - **Mistral *-latest aliases** — what an inattentive operator gets when
 *     they leave `*-latest` in their config. Same pricing as the pinned
 *     snapshot (Mistral bills the alias at the underlying snapshot rate).
 *     Drift surface — the pinned-vs-latest pass-rate delta is the report.
 *
 * Models with no pricing entry in `src/core/pricing.ts` (ministral-3b/8b,
 * open-mistral-nemo, mistral-medium-*, codestral, magistral-small) are
 * intentionally NOT added on the new axes — coverage tracks cost.ts, not
 * "every model the provider sells". Add a pricing entry first, then a cell.
 * Phase 2 orchestration + tool-chain cells already shipped a few of these
 * as exploratory candidates and are left untouched to preserve the Phase 2
 * baseline; see the PR-D commit message for the full skip list.
 *
 * Cost is computed from headline pricing per million tokens. Cache discount
 * is NOT modelled — bench runs are single-turn so cache hits would be zero.
 */

import type { SetBenchCell } from './types.js';

const MISTRAL = 'https://api.mistral.ai/v1';

const ANTHROPIC_KEY = 'ANTHROPIC_API_KEY';
const MISTRAL_KEY = 'MISTRAL_API_KEY';

// Pricing constants — single source of truth, mirrors src/core/pricing.ts.
// Each constant is also the value we assert in the per-axis cells below;
// the structural test in `tests/set-bench-scenarios.test.ts` pins these
// against `src/core/pricing.ts` so a future pricing change can't drift the
// cells silently.
const PRICE_HAIKU_4_5  = { inputPerMillion: 1, outputPerMillion: 5 } as const;
const PRICE_SONNET_4_6 = { inputPerMillion: 3, outputPerMillion: 15 } as const;
const PRICE_OPUS_4_7   = { inputPerMillion: 5, outputPerMillion: 25 } as const;
const PRICE_MISTRAL_SMALL_2603     = { inputPerMillion: 0.20, outputPerMillion: 0.60 } as const;
const PRICE_MISTRAL_LARGE_2512     = { inputPerMillion: 2,    outputPerMillion: 6    } as const;
const PRICE_MAGISTRAL_MEDIUM_2509  = { inputPerMillion: 2,    outputPerMillion: 5    } as const;

// ── TOOL_CHAIN axis: sonnet-tier work, Anthropic Sonnet 4.6 as bar ─────
// Phase 2 cells — left intact for the Phase 2 baseline. ministral-*, open-
// mistral-nemo, mistral-medium-* are exploratory candidates without
// pricing.ts entries; PR D does NOT extend them onto the new axes.

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
// Phase 2 cells — left intact for the Phase 2 baseline.

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

// ── KG_EXTRACTION axis: haiku-tier work, Anthropic Haiku 4.5 as bar ────
// Phase 3 PR D. Probes `entity-extractor-v2.ts` replacement claim.

export const KG_EXTRACTION_CELLS: readonly SetBenchCell[] = [
  {
    label: 'anthropic-haiku-4-5',
    axis: 'kg-extraction',
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    apiKeyEnv: ANTHROPIC_KEY,
    pricing: PRICE_HAIKU_4_5,
    pinned: true,
  },
  {
    label: 'mistral-small-2603',
    axis: 'kg-extraction',
    provider: 'openai',
    modelId: 'mistral-small-2603',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MISTRAL_SMALL_2603,
    pinned: true,
  },
  {
    label: 'mistral-small-latest',
    axis: 'kg-extraction',
    provider: 'openai',
    modelId: 'mistral-small-latest',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MISTRAL_SMALL_2603,
    pinned: false,
  },
];

// ── DAG_PLANNING axis: haiku-tier work, Anthropic Haiku 4.5 as bar ─────
// Phase 3 PR D. Probes `dag-planner.ts` replacement claim.

export const DAG_PLANNING_CELLS: readonly SetBenchCell[] = [
  {
    label: 'anthropic-haiku-4-5',
    axis: 'dag-planning',
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    apiKeyEnv: ANTHROPIC_KEY,
    pricing: PRICE_HAIKU_4_5,
    pinned: true,
  },
  {
    label: 'mistral-small-2603',
    axis: 'dag-planning',
    provider: 'openai',
    modelId: 'mistral-small-2603',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MISTRAL_SMALL_2603,
    pinned: true,
  },
  {
    label: 'mistral-small-latest',
    axis: 'dag-planning',
    provider: 'openai',
    modelId: 'mistral-small-latest',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MISTRAL_SMALL_2603,
    pinned: false,
  },
];

// ── MEMORY_EXTRACTION axis: haiku-tier work, Anthropic Haiku 4.5 as bar
// Phase 3 PR D. Probes `memory.ts` extraction replacement claim.

export const MEMORY_EXTRACTION_CELLS: readonly SetBenchCell[] = [
  {
    label: 'anthropic-haiku-4-5',
    axis: 'memory-extraction',
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    apiKeyEnv: ANTHROPIC_KEY,
    pricing: PRICE_HAIKU_4_5,
    pinned: true,
  },
  {
    label: 'mistral-small-2603',
    axis: 'memory-extraction',
    provider: 'openai',
    modelId: 'mistral-small-2603',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MISTRAL_SMALL_2603,
    pinned: true,
  },
  {
    label: 'mistral-small-latest',
    axis: 'memory-extraction',
    provider: 'openai',
    modelId: 'mistral-small-latest',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MISTRAL_SMALL_2603,
    pinned: false,
  },
];

// ── LONG_CONTEXT axis: sonnet-tier work, Anthropic Sonnet 4.6 as bar ───
// Phase 3 PR D. Probes the summarize-tool replacement claim. Mistral Large
// (131K) is the closest sovereign match to Sonnet's 200K window.

export const LONG_CONTEXT_CELLS: readonly SetBenchCell[] = [
  {
    label: 'anthropic-sonnet-4-6',
    axis: 'long-context',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    apiKeyEnv: ANTHROPIC_KEY,
    pricing: PRICE_SONNET_4_6,
    pinned: true,
  },
  {
    label: 'mistral-large-2512',
    axis: 'long-context',
    provider: 'openai',
    modelId: 'mistral-large-2512',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MISTRAL_LARGE_2512,
    pinned: true,
    providerExtras: { parallel_tool_calls: false },
  },
  {
    label: 'mistral-large-latest',
    axis: 'long-context',
    provider: 'openai',
    modelId: 'mistral-large-latest',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MISTRAL_LARGE_2512,
    pinned: false,
    providerExtras: { parallel_tool_calls: false },
  },
  {
    label: 'magistral-medium-2509',
    axis: 'long-context',
    provider: 'openai',
    modelId: 'magistral-medium-2509',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MAGISTRAL_MEDIUM_2509,
    pinned: true,
    providerExtras: { parallel_tool_calls: false },
  },
  {
    label: 'magistral-medium-latest',
    axis: 'long-context',
    provider: 'openai',
    modelId: 'magistral-medium-latest',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MAGISTRAL_MEDIUM_2509,
    pinned: false,
    providerExtras: { parallel_tool_calls: false },
  },
];

// ── CODE_REVIEW axis: sonnet-tier work, Anthropic Sonnet 4.6 as bar ────
// Phase 3 PR D. Probes the code-review-prompt replacement claim. Codestral
// is the obvious extra candidate but has no pricing.ts entry — add one
// first, then a cell.

export const CODE_REVIEW_CELLS: readonly SetBenchCell[] = [
  {
    label: 'anthropic-sonnet-4-6',
    axis: 'code-review',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    apiKeyEnv: ANTHROPIC_KEY,
    pricing: PRICE_SONNET_4_6,
    pinned: true,
  },
  {
    label: 'mistral-large-2512',
    axis: 'code-review',
    provider: 'openai',
    modelId: 'mistral-large-2512',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MISTRAL_LARGE_2512,
    pinned: true,
    providerExtras: { parallel_tool_calls: false },
  },
  {
    label: 'mistral-large-latest',
    axis: 'code-review',
    provider: 'openai',
    modelId: 'mistral-large-latest',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MISTRAL_LARGE_2512,
    pinned: false,
    providerExtras: { parallel_tool_calls: false },
  },
];

// ── MULTI_STEP_REASONING axis: opus-tier work, Anthropic Opus 4.7 as bar
// Phase 3 PR D. Probes the adaptive-thinking replacement claim. Magistral
// is the reasoning-native pick; Mistral Large is the workhorse fallback.

export const MULTI_STEP_REASONING_CELLS: readonly SetBenchCell[] = [
  {
    label: 'anthropic-opus-4-7',
    axis: 'multi-step-reasoning',
    provider: 'anthropic',
    modelId: 'claude-opus-4-7',
    apiKeyEnv: ANTHROPIC_KEY,
    pricing: PRICE_OPUS_4_7,
    pinned: true,
  },
  {
    label: 'magistral-medium-2509',
    axis: 'multi-step-reasoning',
    provider: 'openai',
    modelId: 'magistral-medium-2509',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MAGISTRAL_MEDIUM_2509,
    pinned: true,
    providerExtras: { parallel_tool_calls: false },
  },
  {
    label: 'magistral-medium-latest',
    axis: 'multi-step-reasoning',
    provider: 'openai',
    modelId: 'magistral-medium-latest',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MAGISTRAL_MEDIUM_2509,
    pinned: false,
    providerExtras: { parallel_tool_calls: false },
  },
  {
    label: 'mistral-large-2512',
    axis: 'multi-step-reasoning',
    provider: 'openai',
    modelId: 'mistral-large-2512',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MISTRAL_LARGE_2512,
    pinned: true,
    providerExtras: { parallel_tool_calls: false },
  },
  {
    label: 'mistral-large-latest',
    axis: 'multi-step-reasoning',
    provider: 'openai',
    modelId: 'mistral-large-latest',
    apiBaseURL: MISTRAL,
    apiKeyEnv: MISTRAL_KEY,
    pricing: PRICE_MISTRAL_LARGE_2512,
    pinned: false,
    providerExtras: { parallel_tool_calls: false },
  },
];

export const ALL_CELLS: readonly SetBenchCell[] = [
  ...TOOL_CHAIN_CELLS,
  ...ORCHESTRATION_CELLS,
  ...KG_EXTRACTION_CELLS,
  ...DAG_PLANNING_CELLS,
  ...MEMORY_EXTRACTION_CELLS,
  ...LONG_CONTEXT_CELLS,
  ...CODE_REVIEW_CELLS,
  ...MULTI_STEP_REASONING_CELLS,
];
