/**
 * Tier-1 static cost-regression guard.
 *
 * This file is the cheap half of the Agent-Efficiency cost defence. It runs in
 * every `npx vitest run` / CI invocation with **zero LLM spend and zero
 * network** — it never constructs an Agent or Session, never starts the
 * engine, never calls a model. It only measures *static* text: the system
 * prompt, the static prompt suffixes, and the serialized builtin tool
 * definitions.
 *
 * The complementary **Tier-2 live bench** is
 * `scripts/agent-efficiency/measure.ts --compare` — accurate end-to-end cost
 * numbers, but it costs real LLM spend and needs a live engine, so it can
 * only run periodically. Tier 1 catches the *common, structural* regressions
 * for free; Tier 2 catches the behavioural ones.
 *
 * Why guard the static prefix: it is the single biggest cost lever. The
 * system prompt + tool definitions form the cacheable prefix sent on every
 * turn (PRD-AGENT-EFFICIENCY §2: a ~19k-token static prefix). If a PR bloats
 * it, *every* turn of *every* conversation gets more expensive. Nothing else
 * currently guards its size.
 *
 * HOW TO REACT TO A FAILURE — this is a budget check, like a bundle-size
 * gate. When a guard trips:
 *   - If the growth is an accident (a stray multi-KB prompt section, a
 *     verbose new tool description) — trim it; that is the whole point.
 *   - If the growth is *legitimate and intended* — bump the budget constant
 *     below **deliberately**, in this file, as a one-line reviewable change.
 *     The failure is the forcing function: it makes prefix growth a
 *     conscious, reviewed decision instead of silent cost creep.
 *
 * Measurement uses `estimateTokens` from llm-helper (the repo's existing
 * offline char→token estimator, ~3.5 chars/token). Precision is not the
 * goal — consistency is. The same estimator is used to compute the baselines
 * baked into the budget constants below, so the guard is internally
 * consistent run-to-run.
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens } from './llm-helper.js';
import {
  SYSTEM_PROMPT,
  WEB_UI_SYSTEM_PROMPT_SUFFIX,
  WORKER_PROMPT_SUFFIX,
  PIPELINE_PROMPT_SUFFIX,
  DATASTORE_PROMPT_SUFFIX,
  CRM_PROMPT_SUFFIX,
  GOOGLE_PROMPT_SUFFIX,
  DEVELOPER_PROMPT_SUFFIX,
  NO_WEB_SEARCH_PROMPT_SUFFIX,
  WEB_SEARCH_FALLBACK_PROMPT_SUFFIX,
} from './prompts.js';
import * as builtinTools from '../tools/builtin/index.js';
import type { ToolEntry } from '../types/index.js';

/**
 * Every static text fragment that can become part of the cached prompt
 * prefix. `SYSTEM_PROMPT` is always present; `WEB_UI_SYSTEM_PROMPT_SUFFIX`
 * is appended on the primary Web UI surface; the remaining suffixes are
 * appended conditionally (per deployment feature state) by Session — but
 * they are all *static* literals, so a PR that bloats any of them inflates
 * the cached prefix for the deployments where that feature is on.
 *
 * Explicitly EXCLUDED — these are DYNAMIC, computed per run, and therefore
 * not part of the stable cacheable prefix this guard protects:
 *   - `modelIdentityContext(provider, modelId)` — depends on runtime config
 *   - `currentDateContext()` — depends on wallclock
 *   - the per-run `[Now: …]` marker from `withCurrentTimePrefix`
 *   - the optional `**Language override**` line (depends on config)
 */
const STATIC_PROMPT_FRAGMENTS: readonly string[] = [
  SYSTEM_PROMPT,
  WEB_UI_SYSTEM_PROMPT_SUFFIX,
  WORKER_PROMPT_SUFFIX,
  PIPELINE_PROMPT_SUFFIX,
  DATASTORE_PROMPT_SUFFIX,
  CRM_PROMPT_SUFFIX,
  GOOGLE_PROMPT_SUFFIX,
  DEVELOPER_PROMPT_SUFFIX,
  // Conditional, mutually-exclusive — at most one is appended per session.
  // The fix/websearch-default-honesty-fallback PR introduced these to stop
  // the agent silently fabricating search results when web_research isn't
  // wired up. They count toward the static budget because Session appends
  // them verbatim (no per-turn templating) for the matching deployments.
  NO_WEB_SEARCH_PROMPT_SUFFIX,
  WEB_SEARCH_FALLBACK_PROMPT_SUFFIX,
];

/** All builtin `ToolEntry` objects exported from the builtin tools barrel. */
const BUILTIN_TOOLS: readonly ToolEntry[] = Object.values(builtinTools).filter(
  (v): v is ToolEntry =>
    typeof v === 'object' &&
    v !== null &&
    'definition' in v &&
    typeof (v as { definition: unknown }).definition === 'object',
);

/**
 * Serialize a tool's wire-shape `definition` (`name`, `description`,
 * `input_schema`) exactly as it is sent to the model. JSON serialization is
 * a stable, deterministic proxy for the on-the-wire size.
 */
function serializeToolDefinition(tool: ToolEntry): string {
  return JSON.stringify(tool.definition);
}

/** Token size of the full static cacheable prefix: prompt fragments + tools. */
function measureStaticPrefixTokens(): number {
  const promptText = STATIC_PROMPT_FRAGMENTS.join('');
  const toolText = BUILTIN_TOOLS.map(serializeToolDefinition).join('');
  return estimateTokens(promptText + toolText);
}

// ── Budget constants ─────────────────────────────────────────────────────
//
// Each budget = measured baseline + ~15 % headroom. The headroom is wide
// enough that an ordinary small prompt tweak (a sentence, a clarifying
// clause, a tightened tool description) does NOT trip the guard, but tight
// enough that a real bloat — a new heavy tool, a multi-KB prompt section,
// a verbose schema — does. Bumping a budget is an intentional, one-line,
// reviewable change.
//
// Baselines measured on origin/main @ 8560d3b3, 2026-05-21, via
// `estimateTokens` (≈3.5 chars/token):
//   - static cacheable prefix (8 static prompt fragments + 33 builtin
//     tool definitions): 17107 tokens
//   - largest single tool definition: `api_setup` at 992 tokens

/**
 * Budget for the full static cacheable prefix (system prompt + all static
 * prompt suffixes + every builtin tool definition), in estimated tokens.
 * Baseline 17107 → +~15 % headroom → 19674.
 * 2026-06-03: deliberate bump to 19900 — added the `edit_file` tool definition
 * (targeted file/artifact edits, replaces full rewrites → net token WIN at
 * runtime) plus artifact-revision + high-stakes-grounding prompt guidance.
 * 2026-06-04: bump to 20100 — this release adds `artifact_history` +
 * `artifact_restore` (version recovery; ~52 tokens) AND the ask_user
 * `multiSelect` schema property + description growth (~66 tokens). They ship
 * together; the combined static prefix measures 20018. Descriptions kept lean.
 * 2026-06-06: bump to 20140 — round-2 adds a lean `artifact_save` directive
 * (~31 tokens) steering HTML/slide-deck artifacts to be mobile-ready (fluid
 * widths) + light unless asked, fixing the "presentations dark + not mobile-
 * ready" report at its root. Cheap now that the prefix is cache-read priced.
 */
const STATIC_PREFIX_BUDGET = 20140;

/**
 * Budget for any single builtin tool's serialized `definition`, in estimated
 * tokens. Baseline (largest = `api_setup`) 992 → +~15 % headroom → 1141.
 */
const PER_TOOL_DEFINITION_BUDGET = 1141;

describe('Tier-1 cost-regression guard', () => {
  // Sanity: the imports resolved to real content. A zero here would silently
  // make both budget assertions pass for the wrong reason.
  it('loads the static prompt fragments and builtin tools', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(1000);
    expect(BUILTIN_TOOLS.length).toBeGreaterThan(20);
  });

  // Guard A — static cacheable-prefix budget.
  it('keeps the static cacheable prefix within STATIC_PREFIX_BUDGET', () => {
    const measured = measureStaticPrefixTokens();
    expect(
      measured,
      `Static cacheable prefix is ${measured} tokens, budget is ${STATIC_PREFIX_BUDGET}. ` +
        `This prefix (system prompt + static suffixes + ${BUILTIN_TOOLS.length} tool definitions) ` +
        `is sent on every turn — growth multiplies cost across the whole fleet. ` +
        `If this growth is intended, bump STATIC_PREFIX_BUDGET deliberately in cost-regression.test.ts.`,
    ).toBeLessThanOrEqual(STATIC_PREFIX_BUDGET);
  });

  // Guard B — per-tool definition size cap.
  it('keeps every builtin tool definition within PER_TOOL_DEFINITION_BUDGET', () => {
    const offenders = BUILTIN_TOOLS.map((tool) => ({
      name: tool.definition.name,
      tokens: estimateTokens(serializeToolDefinition(tool)),
    })).filter((t) => t.tokens > PER_TOOL_DEFINITION_BUDGET);

    expect(
      offenders,
      `Tool definition(s) over the ${PER_TOOL_DEFINITION_BUDGET}-token per-tool budget: ` +
        `${offenders.map((o) => `${o.name} (${o.tokens} tokens)`).join(', ')}. ` +
        `A single verbose tool description bloats the cached prefix for every turn. ` +
        `Trim the description/schema, or bump PER_TOOL_DEFINITION_BUDGET deliberately ` +
        `in cost-regression.test.ts.`,
    ).toEqual([]);
  });
});
