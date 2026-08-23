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

// The Durable Knowledge Substrate (DK.1) tools are MUTUALLY EXCLUSIVE with the six legacy
// `memory_*` tools at runtime: engine.ts registers exactly one set per `durable_memory_enabled`
// state (no partial swap). The barrel exports BOTH so the flag can swap them, but a single turn
// never carries both. The guard must measure the MAX real per-turn prefix, which is the LEGACY
// set (larger than the 3 DK.1 tools) — so exclude the DK.1 tools here, otherwise the sum
// double-counts a set that is never on the wire alongside the legacy one.
const DK1_SWAP_TOOL_NAMES = new Set(['remember', 'recall', 'memory_block_edit', 'memory_retire', 'memory_focus', 'archive_search']);

// Same reason, different shape: `calendar_read` is registered only when `calendar_enabled` is
// on (engine.ts), and that flag ships OFF. The barrel exports it so the flag can turn it on, but
// the prefix a default tenant pays does not carry it — measuring it here would budget for a cost
// nobody is charged, and would quietly hide the real growth of the tools that ARE always on.
// When the flag becomes the default, move this name out and re-baseline in the same commit.
const FLAG_GATED_TOOL_NAMES = new Set(['calendar_read']);

/** All builtin `ToolEntry` objects exported from the builtin tools barrel (minus the DK.1
 *  swap tools and the flag-gated ones — see above; neither is on a default turn's wire). */
const BUILTIN_TOOLS: readonly ToolEntry[] = Object.values(builtinTools).filter(
  (v): v is ToolEntry =>
    typeof v === 'object' &&
    v !== null &&
    'definition' in v &&
    typeof (v as { definition: unknown }).definition === 'object' &&
    !DK1_SWAP_TOOL_NAMES.has((v as ToolEntry).definition.name) &&
    !FLAG_GATED_TOOL_NAMES.has((v as ToolEntry).definition.name),
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
// STATIC_PREFIX_BUDGET is a RATCHET, not a ceiling with slack: it carries the
// exact current measurement, so ANY growth of the static prefix trips it and
// has to be bumped deliberately. That is the "intentional, one-line,
// reviewable change" below, and it is what the values in this file have
// actually done — on origin/main the budget was 23634 against a measured
// 23634, to the token.
//
// This paragraph used to open "measured baseline + ~15 % headroom … an
// ordinary small prompt tweak does NOT trip the guard", which contradicted
// both the next sentence and every value under it. Corrected 2026-08-23 to
// describe the guard that exists — no value moved for it. If the ratchet is
// ever the wrong design, that is a deliberate change to make, and the fix is
// to widen the values, not to keep prose that tells the next reader their
// prompt edit will sail through when it will not.
//
// The per-tool budget below is a different shape and does carry slack —
// it bounds the largest single tool definition, not a sum.
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
 * 2026-06-09: bump to 20720 — PRD v3 provenance lifecycle. The factored
 * GROUNDING_PROMPT_BLOCK now rides the cached prefix (it replaces the old inline
 * grounding block, so the SYSTEM_PROMPT delta is small) and `memory_store` /
 * `memory_update` gain a lean `sourceType` enum param so the agent can declare
 * provenance. Combined static prefix measures 20628; descriptions kept terse.
 * Static + cache-read priced, so the per-turn cost impact is minimal.
 *
 * 2026-06-11: bump to 20850 (measured 20814) — one grounding rule added to
 * SYSTEM_PROMPT after a prod-thread forensic: state a metric / tailored
 * recommendation only from data actually fetched (no estimate-as-real-data, no
 * generic playbook as case-specific advice). (The sibling "tool result is not a
 * new user turn" fix was done STRUCTURALLY in render-projection/agent instead
 * of the prefix, so it costs no static tokens.) Static + cache-read priced.
 *
 * 2026-06-23: bump to 20860 (measured 20854) — Workflow Run-Engine A1 adds a
 * `params` input field to the `run_workflow` tool so the agent can re-target a
 * stored workflow's {{params.<name>}} placeholders (§4.5 drift fix). A genuine
 * new capability, not accidental growth; description was trimmed to its minimal
 * form first (structural lever) — the residual +4 is irreducible.
 *
 * 2026-06-24: bump to 21150 (measured 21143) — Workflow Run-Engine C1 adds the
 * `update_workflow_steps` builtin tool (edit + save a saved workflow's steps via
 * chat, §4.6). A genuine new capability, not accidental growth; its definition
 * was trimmed to minimal form first (structural lever) — the residual ~283 is
 * one whole tool's serialized schema and is irreducible.
 *
 * 2026-06-24: bump to 21270 (measured 21260) — Workflow Run-Engine C2 adds the
 * `diagnose_workflow_run` builtin tool (read a failed run's step trace + error so
 * the agent can fix it in chat, §4.6). Lean definition (~110 tokens) — one tool's
 * irreducible schema; a genuine new capability, not accidental growth.
 *
 * 2026-06-25: bump to 21795 (measured 21785) — Contacts v1 adds the
 * `contacts_save` + `contacts_search` builtin tools (the named, scope-correct
 * surface over the CRM that the web UI already expected) and re-points the
 * conditional CRM_PROMPT_SUFFIX at them. Two whole tool schemas — descriptions
 * trimmed to minimal first (structural lever, −107 from the untrimmed 21892);
 * the residual ~515 is two genuine new capabilities, not accidental growth.
 *
 * 2026-07-04: bump to 21975 (measured 21965) — Context-Hierarchy Scoping A2 adds
 * the `set_thread_context` builtin tool (scope a thread to a project/client so
 * notes + recall stay within it). Description trimmed to minimal first (structural
 * lever, −61 from the untrimmed 22026); the residual ~170 is one whole tool schema,
 * a genuine new capability. NB it is registered ONLY when `subject_graph_enabled`
 * is on (OFF for the whole fleet today) — so its real every-turn cost is ZERO
 * until a tenant flips the flag; this guard counts the barrel worst-case, matching
 * the contacts/update_workflow_steps precedent (conditionally-registered tools count).
 *
 * 2026-07-04: bump to 22095 (measured 22083) — Record-on-Spine R1 adds a `subject`
 * column type to DataStore, so `data_store_create` grows by the `subject` enum value
 * + a `subjectKind` property (restricted post-review to the 4 name-deduped kinds) +
 * a one-line "link to a person/company/project" note. Description trimmed first
 * (dropped the R2-over-promising "everything about X" clause); the residual ~108 is
 * the always-present tool describing a genuine new primitive (rows can carry a real
 * subject_id). UNLIKE set_thread_context this rides an unconditionally-registered
 * tool, so the cost is real every turn — hence trimmed hard.
 *
 * 2026-07-04: bump to 22150 (measured 22138) — Record-on-Spine R2a adds the
 * `occurred_at` column role to `data_store_create` (mark which date column is the
 * event time vs insert time). Description trimmed hard first (−17 from the untrimmed
 * 22155); the residual ~43 is a genuine new capability on the same unconditionally-
 * registered tool, so real every turn. Exposed now (not deferred to R2b) on the
 * write-first rhythm — records accumulate the occurrence marker before R2b's
 * per-subject timeline read consumes it, mirroring how R1 exposed subject columns
 * before R1.5 could query them.
 */
// Bumped 22150 → 23000 for the `media_process` tool definition (the 40th tool),
// a deliberate, intended prefix growth. Keeps a modest headroom over the
// measured ~22533 so the guard still fires on the next real regression.
// 2026-07-08: bump 23000 → 23500 (measured 23037) for the ground-first +
// no-fabrication-on-empty legs appended to GROUNDING_PROMPT_BLOCK (~164 tokens):
// recommend only AFTER fetching+showing the real data, and say "I could not
// retrieve X" plainly rather than inventing a figure on an empty/error tool
// result. Rides the cached prefix (fires on the main agent AND every spawned /
// pipeline step), a deliberate correctness edit — not accidental growth. Keeps
// ~2% headroom over the measured value, matching the media_process precedent.
// 2026-07-17: bump 23500 → 23685 (measured 23671) — the `suggest_follow_ups`
// builtin tool (the 44th), the structured replacement for the leaky text
// `<follow_ups>` block: the agent now emits end-of-turn chips as a schema-
// validated, turn-ending tool call, so nothing leaks as raw JSON and the pills
// survive thread resume. Description trimmed to minimal first (structural lever,
// −79 from the untrimmed 23750); the WEB_UI_SYSTEM_PROMPT_SUFFIX follow-up block
// was rewritten in place (text-block → tool directive, net ~neutral). The
// residual is one genuine new tool schema — the whole point of the change — and
// is cache-read priced. Tight headroom by design: the next tool add re-trips it.
// 2026-07-18: RE-BASELINE DOWN 23685 → 23300 (measured 23273) — extended-tool-
// description-on-use v1. artifact_save / ask_secret / memory_recall move their fat
// NARRATIVE prose (recovery rules, anti-patterns, post-first-call flow) out of the
// always-cached `definition.description` into `ToolEntry.detailedGuidance`, which
// is injected once per thread ON FIRST USE as a post-breakpoint carrier (cache-safe,
// render-suppressed, provider-agnostic) — NOT part of the wire schema. Net −398
// tokens off every turn's prefix from 3 tools; the classifier-free interim reducer
// that stacks with a later tool-availability classifier. Budget lowered to LOCK the
// win (not raised) — accidental re-bloat now re-trips against the new floor.
// 2026-07-18b: RE-BASELINE DOWN 23300 → 23100 (measured 23046) — extended-tool-
// description v2 splits api_setup too (the action-ROUTING lines — bootstrap/create/
// refine/fetch_token — stay in the short cached description; the OpenAPI-vs-docs
// mechanics + the OAuth fetch_token flow + the post-fetch_token "don't set the auth
// header" rule move to on-use detailedGuidance). api_setup's serialized definition
// drops from the historical ~992 to 765 tokens (it is no longer the per-tool-budget
// offender). Cumulative −625 tokens off every turn's prefix from 4 split tools.
// 2026-07-18: +214 for the Session-Start task-proactivity rewrite (prompts.ts) —
// the guardrail against the agent autonomously sending mail / mutating tasks from
// a briefing nudge. Cached (paid once per session); the safety fix justifies it.
// 2026-08-06: +4 (measured 23354) for `auth.username_key` / `auth.password_key` on
// api_setup's input schema — the two fields that make `basic_format: 'user_pass_split'`
// an implemented auth path instead of a schema value that silently 401s. The PROSE
// explaining it deliberately went to `detailedGuidance` (paid on use) rather than the
// cached description, so what lands here is only the two property declarations.
// 2026-08-07: `calendar_read` costs this budget NOTHING, and the number moved DOWN
// because it is excluded above rather than counted. It ships behind `calendar_enabled`,
// default off, so a default tenant's prefix does not carry it — measured both ways:
// counted it was +148, gated it is 0.
//
// Two things this is not. It is not a free pass: turning the flag on costs those 148 tokens on
// every turn of that tenant, and flipping the default means moving the name out of
// FLAG_GATED_TOOL_NAMES and re-baselining here, in the same commit. And it is not a reason to
// gate tools for cost — a capability nobody can reach is worth nothing; this one is gated
// because a calendar feed is externally authored and only a real one proves the read is right.
// 2026-08-09 (F2/D2, cost-controls v2): +~120 tokens total for the `tools`
// declaration on BOTH generator surfaces — required on plan_task phases, and
// declarable (with `model`) on run_workflow ad-hoc steps, which previously had
// no way to opt into bash at all post-F2. Deliberate: the field is the
// mechanism that keeps bash (and its approval dialogs) out of every generated
// workflow step, which buys back far more than the prefix pays. Descriptions
// were tightened before bumping — neither names a tool list (the caller's own
// toolset is in context; an invalid name fails loudly at save).
// 2026-08-18: +125 tokens for the http_request session cap and the task_create
// `params` field — the two halves of one change, so the bump is one entry.
//
// What it buys, measured rather than argued: the 100-request cap appeared in no
// tool description and no prompt, so the model learned it by HITTING it. A live
// bulk on 2026-08-18 asked for 130 records, got exactly 100, and stopped at id
// 101 — correctly reported, but it had no way to have batched differently,
// because it could not know the ceiling existed. The escape it now names is
// real: a saved workflow fired per batch gets fresh counters (proved by two
// headless runs of 60 requests each, 120 total, none blocked), and `params` is
// what makes one workflow serve many batches.
//
// The alternative was leaving the model to discover a hard wall mid-job on a
// customer's 2000-record import. 125 tokens a turn is the cheaper failure.
// Both descriptions were tightened before this bump (176 → 125) — the first
// draft spelled out what the shorter one implies.
// 2026-08-20: +9 (measured 23634) for one clause on `subjects_merge`'s description —
// "It cannot be undone from chat." The tool used to promise the opposite ("This is
// reversible"), which was false three ways, and the honest correction cannot live in
// `detailedGuidance` alone: that carrier is injected AFTER the first call
// (`agent.ts:1774-1785`), so on the first merge in a thread the model composes its message
// to the user having read only the cached description. Paying 9 tokens a turn is the
// price of the model not telling a user something untrue at the one moment it matters.
// WHO pays it, stated precisely rather than as "the fleet": `subjects_merge` is registered
// only when `subject_graph_enabled` is true (`engine.ts:1786`), so a tenant with the flag
// off pays ZERO — this guard counts it worst-case, as it does `set_thread_context`. The
// four prod instances run with the flag on (measured, not assumed), so there it is real.
// Not claimed to be minimal: "No undo from chat." would be ~4 tokens cheaper and is
// equally true; the fuller sentence was kept because this text is parsed by a model
// deciding whether to call a destructive tool.
// The MECHANISM (ledger path, absent from backup and migration) stays on
// `detailedGuidance` where the on-use split puts it — the full-mechanism wording in the
// description measured 23649, i.e. +15 more for prose the model does not need to decide.
// +183 (23634 → 23817): the no-install policy in `## Tools`, plus the bash
// description losing "package management" and gaining the rule that replaces
// it. Measured, not estimated.
// WHAT IT BUYS, measured rather than argued — the chain is a `read this PDF`
// task followed by three distinct missing-tool failures (pdftotext, PyPDF2,
// pdf-parse), n=4 per arm:
//   Anthropic Haiku 4.5 — install attempts 2/4 → 0/4 (`apt-get update &&
//     apt-get install -y poppler-utils`), still calling tools 4/4 → 0/4.
//   Mistral large-2512  — 0/4 → 0/4 on both. It already stopped and reported,
//     so this text is a no-op there. The failure is model-dependent, and the
//     honest claim is "buys something on one of the two", not "on both".
// The reference case is a real thread: 41 bash calls spent on installs and five
// hand-written PDF extractors before giving up. One avoided thread of that shape
// costs far more than 184 cached-prefix tokens across the turns it would take to
// repay — which is the whole trade, since bash is registered for EVERY tenant
// (unlike `subjects_merge` above, which a flag can switch off).
// NOT claimed to be minimal, and one part is unmeasured: the first draft cost
// +291 and was cut to +184 with the effect re-verified on the exact shipped text.
// Whether the "offer what exists" half earns its share is pinned by tests but has
// no behaviour measurement of its own.
const STATIC_PREFIX_BUDGET = 23817;

/**
 * How far ABOVE the measurement the budget may sit before the ratchet is a
 * fiction. Without this, the guard has a silent escape hatch: bumping the
 * budget to a round number well past the measurement keeps every test green
 * while banking headroom nobody reviewed — the exact mutation this file's
 * comment claims cannot happen ("ANY growth trips it"). A claim in prose that
 * nothing enforces is not a rule, so it is enforced here.
 *
 * 50 tokens ≈ 0.2 % — room for a one-word edit landing between a measurement
 * and its commit, not room for a paragraph.
 */
const STATIC_PREFIX_SLACK = 50;

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
  it('keeps STATIC_PREFIX_BUDGET pinned to the measurement, not parked above it', () => {
    const measured = measureStaticPrefixTokens();
    expect(
      STATIC_PREFIX_BUDGET - measured,
      `STATIC_PREFIX_BUDGET is ${STATIC_PREFIX_BUDGET} against a measured ${measured} — ` +
        `${STATIC_PREFIX_BUDGET - measured} tokens of unreviewed headroom. ` +
        `Set the budget to the measurement (${measured}); the guard is a ratchet, ` +
        `not a ceiling with slack.`,
    ).toBeLessThanOrEqual(STATIC_PREFIX_SLACK);
  });

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

describe('extended-tool-description-on-use split invariants', () => {
  const byName = (n: string): ToolEntry => {
    const t = BUILTIN_TOOLS.find((x) => x.definition.name === n);
    if (!t) throw new Error(`tool ${n} not found in BUILTIN_TOOLS`);
    return t;
  };

  // For each split tool: a distinctive phrase that was MOVED from the cached
  // `description` into the on-use `detailedGuidance` — the split's fingerprint.
  const TARGETS = [
    { name: 'artifact_save', movedPhrase: 'Web Speech API' },
    { name: 'ask_secret', movedPhrase: 'dead end' },
    { name: 'memory_recall', movedPhrase: 'may be stale' },
    { name: 'api_setup', movedPhrase: 'auto-attached' },
    { name: 'subjects_merge', movedPhrase: 'Never tell the user a merge is reversible' },
  ] as const;

  for (const { name, movedPhrase } of TARGETS) {
    it(`${name}: detailedGuidance holds the moved prose and never reaches the wire schema`, () => {
      const tool = byName(name);
      expect(tool.detailedGuidance, `${name} must carry detailedGuidance`).toBeTypeOf('string');
      expect((tool.detailedGuidance ?? '').length).toBeGreaterThan(50);

      const wire = serializeToolDefinition(tool);
      // `detailedGuidance` is a ToolEntry field, NOT part of the wire `definition`
      // → it never enters the cached prompt prefix.
      expect(wire).not.toContain('detailedGuidance');
      // The fat prose moved OUT of the always-cached description ...
      expect(wire).not.toContain(movedPhrase);
      // ... and is preserved in the on-use guidance (no prose lost, just relocated).
      expect(tool.detailedGuidance).toContain(movedPhrase);
    });
  }
});
