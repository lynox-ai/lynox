/**
 * Candidate models for the fitness run — the FREE pre-filter made explicit.
 *
 * A model earns a row here only with a `prefilter` reason: a public
 * agentic/tool-use leaderboard standing (BFCL v4, τ-bench) or a known fact.
 * The public leaderboards cost nothing and keep us from burning API budget
 * scoring models that can't even do baseline tool-use. The lynox-specific
 * capability suite (capabilities.ts) then runs ONLY on these survivors.
 *
 * Keep this list SMALL for a cheap run: the tier-routed fleet + a couple of
 * opt-in comparators. Dated snapshots only (fb_mistral_stable_tag).
 */
import { MODEL_CAPABILITIES } from '../../src/types/models.js';
import type { Candidate } from './types.js';

const MISTRAL_BASE = 'https://api.mistral.ai/v1';

/** Fitness floor for the context window (rafael 2026-07-19: "unter 200k ist zu
 *  wenig"). A model under this can't hold lynox's large-context jobs — tool
 *  results are 74-96% of the context (pj_context_tool), and the main chat +
 *  sub-agents + compaction all run over the full thread. It's a STRUCTURAL gate,
 *  free to check (no API): a model can ace every behaviour probe and still be
 *  unfit here. Tunable — this is a judgement threshold, not a hard law. */
export const MIN_CONTEXT_WINDOW = 200_000;

/** Native context window (tokens) for a candidate — read from lynox's OWN model
 *  registry (MODEL_CAPABILITIES), never re-declared here, so it stays in sync
 *  with what the engine actually ships. `undefined` = not in the registry. */
export function contextWindowOf(id: string): number | undefined {
  return MODEL_CAPABILITIES[id]?.contextWindow;
}

/** Per-million-token price {input, output, cacheRead} for a candidate, from the
 *  same registry. COST is a first-class axis for the BALANCED tier especially —
 *  the main chat is the highest-VOLUME job (every user turn) + re-reads a large
 *  cached prefix, so cacheRead + input dominate. Among the FIT models for a
 *  cost-critical tier, pick the cheapest, not the strongest. */
export function costOf(id: string): { input: number; output: number; cacheRead: number } | undefined {
  const p = MODEL_CAPABILITIES[id]?.pricing;
  return p ? { input: p.input, output: p.output, cacheRead: p.cacheRead } : undefined;
}

/** Candidates for the fleet + the models under active consideration. `tierHint`
 *  is the role each is a candidate FOR (its current OR proposed slot) — it is a
 *  LABEL, not a filter: the tier-fitness read judges EVERY context-clearing
 *  candidate against EVERY tier's gates (the full composition grid), so a new
 *  set (e.g. Large→balanced, Sonnet 5→deep) can be read off directly. */
export const FLEET: readonly Candidate[] = [
  // Anthropic tier map (models.ts ANTHROPIC MAP).
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', provider: 'anthropic', tierHint: 'fast',
    prefilter: 'shipped fast tier; strong BFCL/τ-bench tool-use for its size; 200k ctx' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', provider: 'anthropic', tierHint: 'balanced',
    prefilter: 'shipped balanced tier; top-tier agentic leaderboards; 200k ctx' },
  // Sonnet 5 — the PROPOSED deep model (rafael 2026-07-19): 1M native ctx + top
  // output quality. The harness had recommended Large for deep only because
  // Sonnet 5 was not a candidate; it belongs in the deep evaluation.
  { id: 'claude-sonnet-5', label: 'Sonnet 5', provider: 'anthropic', tierHint: 'deep',
    prefilter: 'proposed deep tier; 1M native ctx; highest output quality of the Sonnet line' },
  // Mistral tier map (MISTRAL_MODEL_MAP), EU-sovereign path.
  { id: 'mistral-large-2512', label: 'Mistral Large 3', provider: 'openai', apiBaseURL: MISTRAL_BASE, tierHint: 'balanced',
    prefilter: 'shipped Mistral deep tier; PROPOSED as balanced (main chat); Set-Bench v4 Mistral leader; 256k ctx' },
  { id: 'ministral-14b-2512', label: 'Ministral 14B', provider: 'openai', apiBaseURL: MISTRAL_BASE, tierHint: 'balanced',
    prefilter: 'shipped Mistral balanced tier; 262k ctx' },
  { id: 'ministral-8b-2512', label: 'Ministral 8B', provider: 'openai', apiBaseURL: MISTRAL_BASE, tierHint: 'fast',
    prefilter: 'shipped Mistral fast tier; 262k ctx' },
];

/** Opt-in comparators — candidates we might QUALIFY into the fleet. This is
 *  where discrimination shows: a genuinely weaker/cheaper model FAILS the jobs
 *  its tier would need, so the matrix says "unfit for tier X". Add a model here
 *  WITH a public-leaderboard reason before spending budget scoring it.
 *  `tierHint: null` = judge it for EVERY tier (where could it slot in?). */
export const COMPARATORS: readonly Candidate[] = [
  // Older, weaker Mistral — no vision (rejects images), weaker tool-use, and a
  // 128k context window (< the 200k floor). Unfit on THREE independent axes
  // (vision ✗, multi-turn ask→draft ✗, context ✗) — the cleanest demonstration
  // that the harness discriminates structurally, not just on behaviour.
  { id: 'open-mistral-nemo', label: 'Mistral Nemo', provider: 'openai', apiBaseURL: MISTRAL_BASE, tierHint: null,
    prefilter: 'older/weaker Mistral; low public agentic scores; probes: no vision (400), 128k context (< 200k floor)' },
  // The cheapest gen-3 — could it serve an even cheaper fast slot than 8B?
  { id: 'ministral-3b-2512', label: 'Ministral 3B', provider: 'openai', apiBaseURL: MISTRAL_BASE, tierHint: null,
    prefilter: 'cheapest gen-3 Mistral; candidate for a cheaper fast slot' },
];

export const ALL_CANDIDATES: readonly Candidate[] = [...FLEET, ...COMPARATORS];
