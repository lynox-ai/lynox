import { randomUUID } from 'node:crypto';

import { pinnedModelOf } from '../../core/profile-pair.js';
import type { ToolEntry, SpawnSpec, IAgent, ModelTier, EmittingStreamHandler, IsolationConfig, IsolationLevel, CostGuardConfig, ModelProfile, ProviderConfigSnapshot, LynoxUserConfig, LLMProvider, SpawnedSubAgent, PromptMeta, PromptUserFn, PromptSecretFn, PromptTabsFn } from '../../types/index.js';
import { getDefaultMaxTokens, modelCapability, modelIdExceedsMaxTier, isBlockedModelId, profileNamed } from '../../types/index.js';
import { estimateFirstTurnUSD, hasKnownPricing } from '../../core/pricing.js';
import { reportMeteredCost } from '../../core/metered-request.js';
import { getActiveProvider } from '../../core/llm-client.js';
import { Agent, ContinuationLoopError, RunAbortedError, ToolLoopBreakError, type SendStop } from '../../core/agent.js';
import { describeTurnUntrusted } from '../../core/untrusted-signals.js';
import type { AgentConfig } from '../../types/index.js';
import { loadConfig } from '../../core/config.js';
import { getPricing } from '../../core/pricing.js';
import { channels } from '../../core/observability.js';
import { getRole, getRoleNames, roleToolProfile } from '../../core/roles.js';
import { scopeSecretStore, defaultVaultScope, narrowVaultScope, vaultScopeOf, providerKeySlotReader } from '../../core/secret-scope.js';
import { resolveRunModel, resolveTierModel, hybridSlotClientConfig, getActiveRoutingMode } from '../../core/tier-resolver.js';
import { resolveProviderApiKey, PROVIDER_KEY_SLOTS } from '../../core/llm/provider-keys.js';
import { resolveTools } from '../resolve-tools.js';

import { checkSessionBudget } from '../../core/session-budget.js';
import { compose, engineText, escapeXml, wrapUntrustedData, renderFence } from '../../core/data-boundary.js';
import { withCurrentTimePrefix, GROUNDING_PROMPT_BLOCK, safeModelId, providerFamilyLabel } from '../../core/prompts.js';
import {
  DEFAULT_SPAWN_BUDGET_USD,
  DEFAULT_SPAWN_MAX_TURNS,
  MAX_SPAWN_AGENTS,
  MAX_SPAWN_BUDGET_USD,
  MAX_SPAWN_DEPTH,
  MAX_SPAWN_NAME_LENGTH,
  MAX_SPAWN_TASK_LENGTH,
  MAX_SPAWN_TURNS,
} from '../../core/limits.js';

const SPAWN_TIMEOUT = 10 * 60 * 1000;

/**
 * The least a child may be granted. Below it the batch is refused rather than scaled
 * down further.
 *
 * ⚠ A SETTING, not a measurement — and its justification is NOT "a child this small
 * cannot finish a turn". That sentence is false and had to be corrected once already at
 * the worker's own threshold: the cost guard books a turn BEFORE it compares, so a child
 * always completes its first turn whatever it was granted. What is true is the step
 * after: below this a child stops right after that turn, so the money buys an abort
 * instead of an answer, and the parent is handed a truncated child to reason about.
 *
 * ⛔ DERIVED PER MODEL AND PER CAP, and every figure names the SET it is counted over — a
 * child's model is not restricted to the tier defaults, and because an earlier version of
 * this comment counted a set it had not measured. Over all **39** ids in
 * `MODEL_CAPABILITIES` a cold first turn runs from **$0.000898** (`ministral-3b-2410`) to
 * **$0.88** (`claude-fable-5`: 20k prefix at $20/Mtok plus 9 600 output tokens at
 * $50/Mtok); over the three tier defaults it is $0.052288 / $0.192 / $0.44, a spread of
 * 8.41x. So the flat $0.05 this replaces was nearly exact for the fast tier and **17.60x
 * too low** at the top — a child admitted with five cents there spends eighty-eight,
 * which is the overspend the floor exists to refuse. A flat floor is not a loose floor;
 * up there it is no floor at all.
 *
 * ⚠ The other direction is larger, not a side note: at the cheap end the flat figure was
 * **55.66x too HIGH** (11.13x on `ministral-14b-2512`, the mid-cheap case), so batches on
 * a cheap model were refused although every share could have paid for dozens of turns.
 * This change admits those.
 *
 * ⛔ AND AN UNPRICED ID GETS NO FLOOR AT ALL. `estimateFirstTurnUSD` answers for an
 * unknown id with the FALLBACK rate — $0.32, dearer than the balanced tier and 6.4x the
 * flat figure it replaced. Conservative is right for a reservation and wrong for a
 * threshold: a profile pinning a local model at `localhost:11434` is unpriced AND free,
 * and a fallback-derived floor refuses a child handed the run's whole remainder, on a
 * price nobody pays. So `hasKnownPricing` gates the floor and self-hosters keep their
 * fan-out.
 *
 * ⚠ WHAT THAT COSTS, stated as measured rather than as reassurance. An earlier version of
 * this comment said admitting "costs at most one small turn", and both words were wrong:
 * the turn's price is UNKNOWN — that is the premise of the carve-out, not something to
 * assume small — and the bound is per CHILD, so a ten-child batch is ten such turns. The
 * class is not only free local models: a profile pinning an expensive model through a
 * custom endpoint is unpriced too. The zero-share refusal below bounds the degenerate case.
 *
 * ⛔ AND THE TWO CONTROLS IN THIS FILE TAKE OPPOSITE DEFAULTS ON THAT SAME PREDICATE, ON
 * PURPOSE — decided 2026-10-07, so that nobody "fixes" the asymmetry later. Here an unknown
 * price means NO floor; at {@link profileBandIsDeepOrUnknown} an unknown band means DEEP,
 * i.e. consent is asked. They point in opposite directions because they protect different
 * things: consent runs BEFORE the expensive case and already covers it, while a floor
 * derived from a price nobody pays would refuse a free local model its whole remainder. The
 * floor's residual exposure is bounded per child, which is why it is the one allowed to
 * stay open.
 *
 * `estimateFirstTurnUSD` prices the COLD turn — prefix written at the cacheWrite rate,
 * not read — because a run's first turn always is one.
 *
 * ⛔ AND AGAINST THE CAP THE CALL WILL CARRY, not the model's registry ceiling. That cap is
 * `spec.max_tokens ?? profile?.max_tokens`, it reaches the provider unclamped, and pricing
 * it moves the floor in BOTH directions. Each figure says which method produced it, because
 * the two differ by the fill factor (`claude-sonnet-4-6`):
 *   · the model's own 16 000 ceiling gives $0.192;
 *   · a cap of 64 000 gives $0.408 priced the way this floor prices (the 0.3 fill), and
 *     $1.08 if the child emits the whole cap — so on the model-default floor such a child
 *     was admitted at $0.192 and could spend 5.625x it;
 *   · a cap of 500 gives $0.12225, which ADMITS a share the $0.192 floor refused.
 *
 * ⚠ The caller passes the cap because the caller is the only one holding the whole chain —
 * and an earlier attempt passed only the `spec` half, which left exactly the case the
 * argument exists for. It was reverted rather than shipped, because an argument that works
 * in half the cases reads as a guarantee and is not one.
 */
function minChildBudgetUSD(model: string, maxOutputTokens: number | undefined): number {
  if (!hasKnownPricing(model)) return 0;
  return estimateFirstTurnUSD(model, maxOutputTokens);
}
/**
 * Dollars for a model-facing message.
 *
 * ⚠ MEASURED, not stylistic: `toFixed(2)` on a derived floor printed `"would get $0.00,
 * and one turn on its model costs about $0.00"` for a `ministral`-class child — a refusal
 * whose own reason rounds to nothing, in exactly the cheap-model regime the derived floor
 * exists to serve. Four decimals below a cent follows the repo's existing convention for
 * small amounts (`toFixed(4)` at ten call sites).
 */
function usdLabel(amount: number): string {
  return amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
}

/**
 * Dollars for an IMPERATIVE — rounded UP to the precision it prints.
 *
 * ⛔ MEASURED. `usdLabel` is a DISPLAY helper: `toFixed(2)` rounds to nearest, so a $0.192
 * floor printed as "$0.19" and the advice "raise max_budget_usd to at least $0.19", followed
 * literally, produced the byte-identical refusal — a non-terminating loop on the default
 * tier. 15 of the 39 priced ids round down that way. A figure the reader is told to TYPE has
 * to work when typed; a figure the reader only READS does not, which is why the two helpers
 * are separate and why the refusal below uses `usdLabel` throughout.
 *
 * ⚠ Its only caller is the exhaustion message, whose figure is a doubling. The number stays
 * a NUMBER (`String(Number(...))`) rather than a fixed-decimal string: ceiling it to the
 * printed precision turns `0.38400000000000006` into `0.39`, and leaving it numeric keeps
 * `2` as `2` instead of `2.00`, which two standing assertions pin and which is the common
 * case. The `> budget` gate stays on the number, so the clamped-at-maximum case still falls
 * through to "already at its maximum" rather than prescribing a figure that is not larger.
 */
function usdAtLeast(amount: number): string {
  return usdLabel(amount < 0.01 ? Math.ceil(amount * 10_000) / 10_000 : Math.ceil(amount * 100) / 100);
}

/**
 * The smallest positive amount {@link usdLabel} can print faithfully.
 *
 * ⛔ FLOORING A POSITIVE NUMBER CAN REACH ZERO; CEILING ONE CANNOT. A bound floored below a
 * ten-thousandth prints `$0.0000`, and nothing costs at most zero — 4 683 messages in one sweep
 * said so. A remainder that small is ordinary rather than exotic: `remainingBudgetUSD()` is a
 * float difference clamped at 0, so a positive residue of 1e-9 is a normal end state while the
 * spent-ceiling branch only catches `<= 0`.
 */
const MIN_PRINTABLE_USD = 1e-4;

/**
 * Does this set of asks admit EVERY child? The admission path, in four lines.
 *
 * ⛔ THIS EXISTS BECAUSE ARGUING WAS NOT ENOUGH. The first cut solved the ask that lifts the
 * NAMED child over its floor and offered it — and the sweep caught 764 cases where following it
 * pushed a SIBLING under its own floor instead, because shares are proportional and raising one
 * ask shrinks every other. "Refused a sibling" was 506 of the original 599 failures; solving for
 * one child reproduces it. So every candidate move is now run through the same arithmetic the
 * handler uses, and a move that does not admit the whole batch is not offered.
 */
function admitsEveryChild(asks: readonly number[], floors: readonly number[], remainingRunUSD: number): boolean {
  if (asks.reduce((sum, a) => sum + a, 0) <= 0) return false;
  return scaledShares(asks, remainingRunUSD).every((share, i) => share > 0 && share >= floors[i]!);
}

/**
 * The shares the handler would hand out for these asks — the admission arithmetic, ONCE.
 *
 * ⛔ IT IS ONE FUNCTION BECAUSE TWO COPIES DISAGREED, and the disagreement was VISIBLE. The
 * remedy computation modelled the share as `ask · factor` while the admission check modelled it
 * with the give-back, so one function carried two fidelities of the same arithmetic. Measured
 * over 296 352 share computations: the give-back moves a share in 13 413 of them by at most
 * 1.8e-15 — and in **152 of them the two disagree at the precision the message PRINTS**, because
 * flooring at a boundary turns `0.001` into `0.0009999999999999983`. The direction is the bad
 * one: the naive copy prints the bound one display unit too HIGH, so a model costing exactly the
 * printed figure is refused again. A float epsilon is not harmless once a floor function reads it.
 */
function scaledShares(asks: readonly number[], remainingRunUSD: number): number[] {
  const total = asks.reduce((sum, a) => sum + a, 0);
  const factor = total > remainingRunUSD && total > 0 ? remainingRunUSD / total : 1;
  const shares = asks.map((a) => a * factor);
  // The give-back the handler applies: the last share absorbs any float overshoot.
  const built = shares.reduce((sum, u) => sum + u, 0);
  if (built > remainingRunUSD && shares.length > 0) {
    shares[shares.length - 1] = Math.max(0, shares[shares.length - 1]! - (built - remainingRunUSD));
  }
  return shares;
}

/**
 * What a caller can change to get this child admitted. `null`/`false` means that move cannot work.
 *
 * ⛔ EVERY FIELD IS VALIDATED AS THE SENTENCE THAT WILL BE PRINTED, and an adversarial round is
 * why that is written as a rule rather than assumed. The first cut ran three of the five fields
 * through {@link admitsEveryChild} and left two to a hand proof — and those exact two broke:
 * the pair was unfollowable in 111 of 111 multi-child cases, and the cheaper-turn bound refused
 * a sibling in 42 % of its offers. The gap was never the arithmetic. It was that the proposition
 * CHECKED differed from the proposition CLAIMED — a point checked under an "at least", a number
 * checked under a claim about a move, an upper bound checked under a claim of achievability.
 *
 * So three rules hold for every field here, and a field that cannot satisfy them carries no
 * figure at all:
 *   1. the value stored is already at the precision the message prints, so the printed string
 *      and the validated number are the same number;
 *   2. the validation simulates the WHOLE batch through the same path the handler takes;
 *   3. a quantifier in the sentence ("at least") is only used where it is proven over the whole
 *      set, not at the one point that was checked.
 */
export interface FloorRemedies {
  /**
   * This child's `max_budget_usd`, at display precision, that admits the batch.
   *
   * ⚠ `atLeast` IS NOT SOUND FOR A BATCH, measured: raising the named ask shrinks every sibling
   * share, so above a window the raise pushes a SIBLING under its own floor — false at some
   * larger value in 623 of 810 multi-child cases. Only with a single child is the claim
   * monotone. {@link raiseIsMonotone} says which sentence the renderer may use.
   */
  readonly raiseAskTo: number | null;
  /** True when every ask at or above {@link raiseAskTo} also works, i.e. a lone child. */
  readonly raiseIsMonotone: boolean;
  /**
   * An ask for this child delegated ALONE, at display precision.
   *
   * ⭐ HERE "at least" IS sound, and the asymmetry is worth keeping: alone the share is
   * `min(ask, R)`, which is non-decreasing in the ask, so if the figure admits then so does
   * every larger one. No sibling exists to be squeezed.
   */
  readonly soloAskTo: number | null;
  /**
   * Lowering what ONE turn costs for this child admits the batch.
   *
   * ⛔ A BOOLEAN, NOT A FIGURE, AND THAT IS THE FIX. The figure here was a bound to stay under,
   * and three separate defects lived in printing it: floored below a cent it rendered `$0.0000`
   * (4 683 messages — nothing costs at most zero); it collided at display precision with the
   * turn cost it was declared insufficient against (47 messages saying a model costing `about
   * $0.19` is cured by one costing `at most $0.19`); and it sat a full display unit under the
   * share in 956 messages. The relation is what the caller needs and it cannot be mis-rounded,
   * so the sentence states the relation and keeps `may`, because whether any model or cap
   * reaches that low depends on profiles and prices this function cannot see.
   */
  readonly cheaperTurnHelps: boolean;
}

/** Round UP to the precision {@link usdLabel} prints at — for a figure the reader must REACH. */
function atLeastValue(amount: number): number {
  return amount < 0.01 ? Math.ceil(amount * 10_000) / 10_000 : Math.ceil(amount * 100) / 100;
}

/**
 * The remedies, COMPUTED from the admission arithmetic and validated as printed.
 *
 * ⛔ WHY THIS IS A FUNCTION AND NOT A HANDFUL OF SENTENCES. The refusal used to name remedies in
 * prose, and a sweep of 3 957 refusals through the real handler found that of 1 674 messages
 * carrying a prescribed figure, **599 were not followable**: 16 printed `$Infinity`, 9 exceeded
 * the schema maximum, 68 refused the same child again, 506 refused a sibling. Every one lived in
 * a sentence that claimed what the admission path would do next. A claim about the next call has
 * to be solved, so it is solved here and the message only renders what came back.
 *
 * ⛔ THE ASK THAT WORKS IS NOT `need / factor`. Raising this child's ask raises the batch total,
 * which lowers the factor with it — measured: `need / factor` quoted $1.93 where $1.93 is
 * refused again. Solve `x·R/(x+S) >= need` instead, giving `x >= need·S/(R−need)`, and take the
 * larger of that and `need` itself. ⭐ That `max` is not a safety net, it is the UNSCALED regime:
 * `need·S/(R−need) <= need` holds exactly when `S + need <= R`, i.e. exactly when raising the ask
 * to the floor keeps the batch inside the remainder. One expression, both regimes, no branch.
 *
 * ⚠ AND `MIN_PRINTABLE_USD` IS IN THAT `max` FOR A REASON THAT IS NOT ROUNDING. On a model this
 * instance has no price for the floor is 0 by design (the self-host carve-out), so `need` is 0,
 * the solved ask is 0, `0 > askedFor` is false for a zero ask — and the one move that works got
 * dropped exactly where it was the only one, leaving a sentence that said two levers bind when a
 * single cent cleared it. The ask has to be a printable positive number, not a true zero.
 */
export function floorRemedies(opts: {
  /** Every child's ask, in batch order. */
  requested: readonly number[];
  /** Every child's floor, in the same order; `0` where the model has no known price. */
  floors: readonly number[];
  /** The index of the child the message names. */
  named: number;
  remainingRunUSD: number;
  /** The schema's ceiling on a single `max_budget_usd`. */
  maxAsk: number;
}): FloorRemedies {
  const { requested, floors, named, remainingRunUSD: R, maxAsk } = opts;
  const need = floors[named]!;
  const askedFor = requested[named]!;
  const batchSize = requested.length;
  const batchAsked = requested.reduce((sum, a) => sum + a, 0);
  /** This child's share, from the SAME arithmetic the handler ran — give-back included. */
  const got = scaledShares(requested, R)[named]!;
  /** What the OTHER children asked for. Clamped because a negative would invert the solve. */
  const siblings = Math.max(0, batchAsked - askedFor);
  const withNamedAsk = (ask: number): number[] => requested.map((a, i) => (i === named ? ask : a));

  // ── Raise this child's ask, batch otherwise unchanged. The solved figure is rounded to display
  // precision FIRST and the rounded value is what the admission path then checks, so the message
  // cannot print a number nobody validated.
  //
  // ⛔ THE TIE IS INCLUDED, AND EXCLUDING IT WAS THE SPECIFICATION'S OWN TRAP No. 1. An earlier
  // cut wrote `R > need` with a comment saying "at R === need the solve divides by zero, and no
  // finite ask helps because the whole remainder is one turn". The first half is true, the second
  // is FALSE: at `R === need` an ask of exactly `need` is admitted, because the share is
  // `min(ask, R)` and the floor comparison is `>=`. So the refusal said "No single change to this
  // call clears it" while one did — the class this whole surface exists to remove, reached by
  // handling the division and asserting the admissibility away in prose.
  //
  // ⭐ FOUR REGIMES, AND THE EXPRESSION COVERS THEM WITHOUT A BRANCH ON THE TIE:
  //   · `R < need`        → Infinity. Correct: no ask can beat a remainder shorter than one turn.
  //   · `R === need`, no siblings → `need`. Admitted, and that is the case that was being denied.
  //   · `R === need`, siblings    → Infinity, via the quotient's division by zero. Correct and
  //     provable: `x·R/(x+S) >= need = R` requires `x/(x+S) >= 1`, i.e. `S <= 0`. Measured at
  //     S = 0.01 and S = 5: no ask up to the schema maximum is admitted.
  //   · `R > need`        → the solve, as before.
  // The `siblings > 0` guard on the quotient is what makes the tie-without-siblings arm reachable
  // at all: `0/0` is `NaN`, and `Math.max(need, NaN)` is `NaN`, which `Number.isFinite` then
  // rejects — so relaxing the comparison ALONE would have changed nothing.
  const solved = R >= need
    ? Math.max(need, MIN_PRINTABLE_USD, siblings > 0 ? (need * siblings) / (R - need) : 0)
    : Number.POSITIVE_INFINITY;
  const candidate = Number.isFinite(solved) ? Math.min(maxAsk, atLeastValue(solved)) : null;
  const raiseAskTo = candidate !== null && candidate > askedFor
    && admitsEveryChild(withNamedAsk(candidate), floors, R)
    ? candidate
    : null;

  // ── Delegate it alone. Then `share = min(ask, R)`, so the ask only has to reach the floor —
  // but the remainder still has to cover one turn, and no ask can change that.
  const soloCandidate = need > 0 ? atLeastValue(need) : MIN_PRINTABLE_USD;
  const soloAskTo = batchSize > 1 && soloCandidate <= maxAsk
    && admitsEveryChild([soloCandidate], [need], R)
    ? soloCandidate
    : null;

  // ⛔ THERE IS NO REBALANCE MOVE HERE, AND ITS ABSENCE IS THE DECISION. "Lower what the others
  // ask for" was computed and checked, and it still took three cuts of one sentence: the check
  // has to hold this child's ask FIXED where the sentence says only the siblings move, and a
  // mutant swapping that construction for a full re-split survived the whole suite. The
  // separating case is a child whose ask CLEARS its floor and is still too large for the
  // siblings' floors to fit beside it ($0.28 of a $0.30 remainder against a $0.052 sibling
  // floor) — there the sentence said "give it a max_budget_usd of its own" while its budget had
  // to come DOWN. A third wording was drafted and removed: the stop-rule for this surface was
  // that a round finding defects in the REPAIRS rather than the subject means cutting smaller,
  // and a rule that bends the first time it binds is not a rule. The move keeps its own register
  // row, with that case as the witness it has to fail on.
  //
  // ⚠ What the message does instead is say less, not say it vaguely: the empty case names a
  // different split as a possibility without claiming one, which is a `may` and not a figure.

  // ── Lower what one turn costs for this child. A BOOLEAN: the question is whether lowering
  // THIS child's floor can admit the batch at all, which is false whenever a sibling is also
  // under its own floor — and `tooSmall` is a findIndex, so a second short child is routine.
  // Simulated with this child's floor driven to zero, the most any model or cap could achieve.
  const floorsWithoutNamed = floors.map((f, i) => (i === named ? 0 : f));
  const cheaperTurnHelps = got >= MIN_PRINTABLE_USD && got < need
    && admitsEveryChild(requested, floorsWithoutNamed, R);

  // ── The PAIR, for a lone child only, offered when nothing single works. Validated as the
  // sentence reads: an ask of A against a floor of A, which is the worst case the caller may
  // pick under "a turn costing at most A".
  return { raiseAskTo, raiseIsMonotone: batchSize === 1, soloAskTo, cheaperTurnHelps };
}

/**
 * ⛔ TWO AMOUNTS THAT ROUND ALIKE ARE NEVER PUT IN APPOSITION. `usdLabel` rounds to nearest and
 * 15 of the 39 priced ids round down, so an ask of $0.19 against a $0.192 floor printed "it may
 * spend $0.19 and one turn on its model costs about $0.19" — two identical figures with one
 * declared insufficient against the other, next to an instruction to raise it. A sweep found 73
 * of 2 717 refusals saying "X is below X".
 *
 * ⚠ A per-sentence precision chooser was the first repair and it was the WRONG instrument: it
 * had to decide when two numbers are "distinguishable", which is a property of the pair AND of
 * the formatter, and it got both wrong — a pair colliding at four decimals as well as two was
 * left alone (so the defect survived for every ask in `[0.1915, 0.192)`), and its collision test
 * compared `toFixed` output against a formatter with two different arms, so a sub-cent pair
 * printed alike without ever triggering it. Each repair of that function needed another.
 *
 * ⛔ So the figures stay at display precision and the SENTENCE states the relation instead —
 * "and one turn costs more". A reader who sees two figures that round alike is told which way
 * the comparison goes, in words, which no amount of precision can be wrong about. The class is
 * removed rather than narrowed.
 *
 * The floor refusal, named by what ACTUALLY binds — one sentence per cause.
 *
 * ⛔ THREE CAUSES, AND ONLY ONE OF THEM IS SCARCITY. One message served all three and was
 * false in two of them. Measured at the real handler before anything changed:
 *   · $0.15 left, one child asking $0.10, floor $0.19 → "which 1 sub-agent(s) cannot
 *     share … Delegate fewer at once, or run them one after another". With ONE child the
 *     two remedies are the same remedy and both are impossible.
 *   · $10.00 left, one child asking $0.10 → the same sentence, claiming $10 cannot be
 *     shared by one child. The run's remainder is twenty turns' worth.
 *   · $1.00 left, children asking $0.01 and $10.00 → "which 2 sub-agent(s) cannot share".
 *     Two floors are $0.38 together: they fit twice over.
 *
 * ⛔⛔ AND IT NAMES NO FIGURE TO TYPE. THAT IS THE DESIGN, not an omission — a second cut of
 * this function prescribed one ("raise max_budget_usd to at least $X") and a review round
 * swept 3 957 refusals through the real handler, fed each printed figure back, and found
 * **599 of 1 674 not followable**: 16 printed `$Infinity` at the exact tie, 9 exceeded the
 * schema maximum, 68 refused the same child again, 506 refused a sibling. Every one of those
 * lives in the prescription, none in the diagnosis. A prescribed figure is a claim about what
 * the admission path will do next, and this function cannot make that claim from what it
 * holds: the share depends on the whole batch, the batch changes when the ask changes, and
 * whether a cheaper model exists depends on a registry it cannot see. So it says what binds
 * and which KINDS of move can change it — each of those checked below — and the figure is
 * deferred to a piece that computes feasibility rather than asserting it.
 *
 * ⚠ `factor` DOES NOT ANSWER "DID THE REMAINDER BIND". An earlier attempt split the message
 * by it and produced a sentence false in its own case: at $0.15 left it said "the run's
 * remainder is not the constraint here: $0.15 of it is still free" while a turn cost $0.192.
 * `factor === 1` only says the sum of the asks fits. The dominant test is
 * `remainingRunUSD < need`, and it comes before the ask — a child whose own ask is also
 * short is still refused by the remainder.
 *
 * ⛔ WHAT THE FLOOR MEANS IS NOT "IT CANNOT FINISH A TURN" — see {@link minChildBudgetUSD},
 * which records that this sentence is false and was corrected once already: the cost guard
 * books a turn before it compares, so an admitted child always completes its first turn. A
 * first cut of this function wrote the false version into a new home and pinned it with two
 * witnesses. Every branch carries the true one: below its floor a child runs ONE turn and
 * then stops, so the money buys an abort instead of an answer.
 *
 * ⛔ EVERY BRANCH SAYS THAT NOTHING WAS STARTED. Measured in a release walk: after a floor
 * refusal one model INVENTED the children's results while the ledger showed zero children
 * started. The throw happens before any child is dispatched, so it is true in every branch.
 *
 * ⚠ WHICH MOVES EACH BRANCH NAMES, and why each is true where it is named:
 *   · raising the ask — named only where `askedFor < need`. It is the ONLY move that can work
 *     there, because `share = askedFor · factor <= askedFor`, so no reduction of the batch
 *     lifts this child over its floor. A second cut offered "delegate fewer" here and it was
 *     false in all 131 measured cases.
 *   · delegating fewer / running sequentially — named where the siblings are the cause, and
 *     where the batch cannot fit at all. Sequential works because the hold is released and
 *     the child's real spend charged when it settles, so the next call reads a remainder
 *     reduced by what was SPENT; a review finding that said otherwise had measured the
 *     reservation WHILE HELD, which is the concurrent case.
 *   · lowering the siblings' asks — ⚠ NO LONGER NAMED AT ALL, and this bullet is kept rather
 *     than deleted because its proof was sound and the move still exists as a register row.
 *     The gate was necessary and sufficient (asks proportional to the floors give every child
 *     `floor_i · R / sumFloors >= floor_i`), and a round verified 66 claims against it. What
 *     could not be settled in three cuts was the SENTENCE: the construction checked has to be
 *     the one each wording describes, and a child whose ask clears its floor while still
 *     crowding out the siblings needs a third wording that says its budget must come DOWN.
 *   · a cheaper model, or a narrower `max_tokens` — both named as what they are, a MAY. They
 *     lower the floor, and whether that is ENOUGH depends on the tier enum, on configured
 *     profiles this function cannot see, and on the floor's irreducible prefix term: the
 *     cheapest tier's first turn is about $0.04 and the cheapest priced id's about $0.0008, so
 *     below those no model and no cap clears it. An earlier revision wrote "would also clear
 *     it" here and contradicted this very paragraph two screens above it. At a spent ceiling
 *     neither is named at all, because no priced model has a floor at or below zero.
 */
function floorRefusal(opts: {
  name: string;
  /** The share this child was granted. */
  got: number;
  /** One cold turn on this child's model and cap; `0` when the model has no known price. */
  need: number;
  /** What the caller asked for this child (`max_budget_usd`, or the default). */
  askedFor: number;
  remainingRunUSD: number;
  batchSize: number;
  /** What the whole batch asked for. */
  batchAsked: number;
  /** The proportional scaling applied to every ask; `1` when nothing was scaled. */
  factor: number;
  /** The schema's ceiling on a single `max_budget_usd`. */
  maxAsk: number;
  /** Every child's ask and floor, in batch order, plus which one is named — for the remedies. */
  requested: readonly number[];
  floors: readonly number[];
  named: number;
}): string {
  const { name, got, need, askedFor, remainingRunUSD, batchSize, batchAsked, factor, maxAsk, requested, floors, named } = opts;
  const left = usdLabel(remainingRunUSD);
  // ⚠ `name` IS NOT ESCAPED HERE, AND THAT IS A DECISION. A security round recommended
  // `escapeXml` because three other outbound paths in this file apply it. Those are composed
  // into an XML-ish envelope (`compose`/`renderFence`) and need it; this string is thrown, and
  // a thrown tool error reaches the model as the `content` of a `tool_result`, with no
  // envelope and so no delimiter to break. What keeps a line break out is the input gate
  // (`CONTROL_CHARS`, rejected in `validateSpawnInput`), NOT escaping — `escapeXml` does not
  // touch control characters at all. And escaping would corrupt the identifier the model has
  // to name on its next call: a child called `a&b` would come back as `a&amp;b`. If this
  // string is ever composed into an envelope, the escaping belongs at that composition site.
  const share = `"${name}" would get $${usdLabel(got)}`;
  const turn = `one turn on its model costs about $${usdLabel(need)}`;
  const abort = 'below its floor a sub-agent runs a single turn and then stops, so the money '
    + 'buys an abort instead of an answer';
  const nothing = ' No sub-agent was started and there are no results to report.';
  const ceiling = `$${left} left of its own cost ceiling`;

  /**
   * ⛔ THE REMEDIES ARE RENDERED, NOT WRITTEN. Each move comes from
   * {@link floorRemedies}, which solves whether it can work; a move the arithmetic does not
   * support is ABSENT rather than hedged. The reason clauses below still branch — naming what
   * binds is local knowledge and three rounds confirmed those sentences — but the remedy half
   * is one list for every branch, because every false remedy this surface ever carried came
   * from a branch asserting what the next call would do.
   *
   * ⚠ EVERY FIGURE HERE IS A FIGURE TO REACH, so every one is ceiled (`atLeastValue`), ONCE,
   * inside the computation — the printed string and the validated number are the same number.
   * There is no floored bound any more and no `atMostValue`: a bound to stay under is a COST,
   * and a cost is never printed as a figure on this surface. An earlier revision of this comment
   * still described a floored bound after the code had stopped having one, which is exactly the
   * reading that makes the defect invisible.
   */
  const r = floorRemedies({ requested, floors, named, remainingRunUSD, maxAsk });
  const moves: string[] = [];
  if (r.raiseAskTo !== null) {
    // ⚠ THE QUANTIFIER IS THE CLAIM. "at least" is only printed where every larger ask also
    // works, which is the lone-child case; in a batch a larger ask shrinks the siblings' shares,
    // so the sentence names the figure and nothing beyond it.
    moves.push(r.raiseIsMonotone
      ? `raise max_budget_usd to at least $${usdLabel(r.raiseAskTo)} for "${name}"`
      : `set max_budget_usd to $${usdLabel(r.raiseAskTo)} for "${name}" — a larger one shrinks `
        + 'the other shares and can push a sibling under its own floor');
  }
  if (r.soloAskTo !== null) moves.push(`delegate it on its own with at least $${usdLabel(r.soloAskTo)}`);
  if (r.cheaperTurnHelps) {
    // ⛔ NO FIGURE AND NO CROSS-REFERENCE, and this is the FOURTH state of this clause — which is
    // why it is a reversion to the wording #1568 shipped rather than a new attempt. The three
    // that failed: "at most $X" printed `$0.0000` and collided at display precision with the
    // turn cost it was declared insufficient against; "less than the share above" pointed at a
    // quantity 274 of its 1 250 appearances never print (the own-budget branch prints the ask
    // and the turn cost, not the share), and where it IS printed `usdLabel` rounds to NEAREST,
    // so in 48 % of cases the anchor sits ABOVE the true share. A relation needs an antecedent
    // that is always present and never rounded the wrong way; there is no such figure here.
    //
    // ⚠ `may`, not `does`, although the computation knows it DOES: whether any model or cap
    // reaches low enough depends on prices and profiles this function cannot see. Under-claiming
    // is the safe direction, and the whole-batch simulation still decides whether the clause is
    // said at all — so this is a weaker SENTENCE over an unchanged CHECK.
    moves.push('a cheaper model or a narrower max_tokens may clear it, by lowering what one turn costs');
  }
  const remedy = moves.length > 0
    ? `${moves.length === 1 ? 'The one thing that works' : 'What works'}: ${moves.join('; or ')}.`
    // ⛔ TWO EMPTY CASES, AND THE STRONG SENTENCE BELONGS TO ONLY ONE. At a spent ceiling nothing
    // on the spawn side can admit anything: every share is `ask·R/total <= 0` for any asks, which
    // a brute force over 21 609 such refusals confirmed with no counterexample. With a POSITIVE
    // remainder the strong sentence is false, and measurably so — at $0.10 with a $0-ask child
    // and a $5 sibling, giving the child a budget AND lowering the sibling AND narrowing the cap
    // admits it. Three coupled changes are past what this function enumerates, so it says what it
    // knows and claims no more.
    : remainingRunUSD > 0
      ? 'No single change to this call clears it; a smaller batch, a different split of the '
        + 'budget across the children, or a cheaper model may, and a later run gets its own '
        + 'ceiling.'
      : 'Nothing in this call can change that; a later run gets its own ceiling.';

  // ── (a0) THE RUN IS SPENT. Nothing about the batch changes it, and no model is cheap enough
  // — the cheapest priced floor in the registry is $0.000898, not $0.
  if (!(remainingRunUSD > 0)) {
    return `This run has ${ceiling}, so there is nothing to divide: ${share}. ${remedy}${nothing}`;
  }
  // ── (z) THE CALLER ASKED FOR NOTHING. Named before the remainder, because it is the cause
  // the caller controls and the one a remainder sentence would hide: a first cut put it behind
  // `remainingRunUSD < need` and produced a refusal that never mentioned the $0 ask.
  if (!(askedFor > 0)) {
    const cost = need > 0 ? `, where ${turn}` : '';
    return `This run has ${ceiling}, and ${share} because it was given no budget at all${cost} — `
      + 'and a sub-agent with no budget runs a single turn and then stops, so it would buy an '
      + `abort rather than an answer. ${remedy}${nothing}`;
  }
  // ── (a) THE RUN CANNOT PAY FOR ONE TURN of this child. The only branch where scarcity is
  // the true reason and no change to the batch helps.
  const runCannotPay = `This run has ${ceiling} and ${turn} — more than the whole remainder, so `
    + `${share} — ${abort}. ${remedy}${nothing}`;
  if (remainingRunUSD < need) return runCannotPay;
  // ── (b) THE CHILD'S OWN BUDGET cannot pay for one turn. The run's remainder covers it,
  // which is why naming scarcity here sends the caller down a road that does not exist.
  if (askedFor < need) {
    const scaled = factor < 1
      ? `, and the batch's $${usdLabel(batchAsked)} against that remainder scaled it to `
        + `$${usdLabel(got)}`
      : '';
    return `This run has ${ceiling}, which covers one turn of "${name}" — what binds is its own `
      + `budget: it may spend $${usdLabel(askedFor)}, and one turn costs more — ${turn}`
      + `${scaled}. ${remedy}${nothing}`;
  }
  // ⛔ A SINGLE CHILD HAS NO SIBLINGS TO BLAME, and this test belongs HERE — a first cut put
  // it in (a)'s condition, where it swallowed every single-child (b) case. Reaching this line
  // with one child means its ask cleared its floor and the remainder did too, so the only way
  // its share came up short is the rounding give-back at an exact tie.
  if (batchSize === 1) {
    return `This run has ${ceiling} and ${turn} — the two are too close to fund it, so `
      + `${share}, ${abort}. There are no siblings to delegate away here. ${remedy}${nothing}`;
  }
  // ── (c) THE SIBLINGS scaled it under its floor. Its own ask was enough and the run's
  // remainder is enough; what is not enough is the remainder divided this many ways.
  //
  // ⛔ THE FLOOR FIGURE OF THE NAMED CHILD STAYS IN THIS SENTENCE. Two standing witnesses
  // couple it to the share in one regex, because a mutant quoting `floors[0]` once survived
  // the whole suite — and a first cut of an earlier rewrite dropped the figure and broke both.
  return `${String(batchSize)} sub-agents asked for $${usdLabel(batchAsked)} against the `
    + `$${left} left of this run's own cost ceiling, so every share was scaled down: `
    + `${share}, below the $${usdLabel(need)} one turn on its model costs — ${abort}, and on `
    + `its own it would fit. ${remedy}${nothing}`;
}

/** The live limit; only tests shorten it (`setSpawnTimeoutMsForTests`). */
let spawnTimeoutMs = SPAWN_TIMEOUT;

/** Shorten the per-child time limit (for testing). `null` restores the default. */
export function setSpawnTimeoutMsForTests(ms: number | null): void {
  spawnTimeoutMs = ms ?? SPAWN_TIMEOUT;
}

/**
 * One child's spawn time limit, on the same measure as the HTTP run's wall clock: time
 * the child spends waiting on a HUMAN (a question, a confirmation, a secret) does not
 * count. A limit that counted the user's reading time would end exactly the children
 * that correctly stopped to ask. Overlapping waits hold it until the last one ends.
 */
export interface SpawnDeadline {
  readonly signal: AbortSignal;
  /** Stop the clock until the returned release is called (idempotent). */
  holdForHuman(): () => void;
  /** Whether the child is waiting on a human right now (any question still open) — for
   *  a caller that parks other per-child resources while it waits. */
  readonly isHeldForHuman: boolean;
  /** The child settled: the limit no longer applies. */
  clear(): void;
}

export function createSpawnDeadline(ms: number): SpawnDeadline {
  const controller = new AbortController();
  let remaining = ms;
  let runningSince = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => controller.abort(), ms);
  let holds = 0;
  let cleared = false;
  return {
    signal: controller.signal,
    get isHeldForHuman() { return holds > 0; },
    holdForHuman() {
      if (cleared || controller.signal.aborted) return () => undefined;
      if (holds === 0 && timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        remaining -= Date.now() - runningSince;
      }
      holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        if (holds === 0 && !cleared && !controller.signal.aborted) {
          runningSince = Date.now();
          timer = setTimeout(() => controller.abort(), Math.max(0, remaining));
        }
      };
    },
    clear() {
      cleared = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
const SPAWN_EXCLUDED = new Set(['spawn_agent']);

/**
 * Empirical p90 fill of a model's maxOutput per turn; overshoots are caught by the
 * per-spawn cost guard.
 *
 * ⚠ RESTORED. A previous revision replaced the second clause with "a child's guard IS the
 * share this estimate helps compute, so it cannot catch an overshoot of itself" — which is
 * false, and the true sentence had been there first. This ratio feeds
 * {@link estimateSpawnCost} only, i.e. `checkSessionBudget` and the batch announcement; the
 * shares come from `requested` (each child's `max_budget_usd`), never from this estimate.
 * The per-spawn guard does still cap a child's dollars however badly the fill is guessed.
 */
const SPAWN_OUTPUT_FILL_RATIO = 0.3;

/**
 * Reset a Session's spawn-cost counter (for testing). The counter now
 * lives on `SessionCounters.costUSD` — pass the counters object to clear
 * just that Session, rather than a process-wide reset.
 */
export function resetSessionSpawnCost(counters: import('../../types/index.js').SessionCounters): void {
  counters.costUSD = 0;
}

// The module-level `activeChildAgents` set and `abortSpawnedAgents()` are GONE. They made
// one session's abort reach every child in the process; a child now registers in the
// scope it inherited from its parent, and `Session.abort()` reaches exactly that. See
// `AbortScope` in `types/config.ts` for why the scope rides on the agent.

/**
 * Map the child's `send()` outcome onto the `runs.stop_reason` column. Until
 * 2026-08-20 spawn stamped `'end_turn'` unconditionally on the completed path,
 * so a child stopped by its turn cap with a tool call still pending was
 * indistinguishable in the ledger from one that finished on its own — every
 * empty sub-agent of the production thread this was found in read `end_turn`
 * while in truth `max_turns` had run out. The column is free text (the failure
 * path already writes error messages into it) and nothing in either repo
 * switches on its value (the debug export passes it through; the web-ui reads
 * the live `turn_end` stream field, not this column), so two new words here
 * break nothing and name the knob the operator has to turn.
 */
export function ledgerStopReason(stop: SendStop | null): string {
  switch (stop?.cause) {
    case 'iteration_cap':
    case 'absolute_cap':
      return 'max_turns';
    case 'budget_cap':
      return 'max_budget';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

/**
 * Estimate the cost for a single spawn agent so `checkSessionBudget` can
 * refuse a fan-out that would blow the session ceiling. Models input as
 * ~4K tokens/turn (cache reduces this further after turn 1, not modelled)
 * and output as {@link SPAWN_OUTPUT_FILL_RATIO} × `model.maxOutput` per turn.
 */
/**
 * What the MODEL is told when a fan-out's budgets were scaled down, or `''` when none
 * were.
 *
 * ⛔ A shared helper because TWO paths carry it, and that is the point rather than
 * tidiness: the ordinary result prepends it, and the all-children-failed path has to
 * append it to its own message — a trimmed batch where every child rejects is exactly
 * the case where "stopped at its budget" and "failed" are indistinguishable from the
 * parent's side.
 *
 * It names both figures and says a truncated child did not fail, because a tool result
 * is prompt surface: without the second sentence the model's next move is to delegate
 * more of them, which buys no budget and is the opposite of what the ceiling wanted.
 */
function budgetNote(
  trimmed: ReadonlyArray<{ name: string; asked: number; got: number }>,
  remainingUSD: number | null,
): string {
  if (trimmed.length === 0) return '';
  // ⛔ `usdLabel`, not `toFixed(2)`, and the derived floor is what made this reachable:
  // while the floor was a flat $0.05 no admitted share could be under five cents, so this
  // note could not carry a sub-cent amount. Deriving it admits them — measured, a $0.009
  // remainder rendered as "This run had $0.01 left ... got $0.00", which rounds the
  // remainder UP and the shares away, on the same surface and for the same reader as the
  // refusal below.
  const lines = trimmed
    .map((t) => `- \`${escapeXml(t.name)}\`: asked $${usdLabel(t.asked)}, got $${usdLabel(t.got)}`)
    .join('\n');
  return '\n\n## Budget note\n\n'
    + `This run had $${usdLabel(remainingUSD ?? 0)} left of its cost ceiling, so the `
    + `sub-agent budgets were scaled down to fit:\n${lines}\n\n`
    + 'A sub-agent that stopped at its budget reports what it had and did NOT fail. '
    + 'Delegating more of them would not buy more budget — the ceiling belongs to this run.';
}

function estimateSpawnCost(model: string, maxIterations: number): number {
  const pricing = getPricing(model);
  const expectedOutput = getDefaultMaxTokens(model) * SPAWN_OUTPUT_FILL_RATIO;
  const avgInput = 4000;
  // Defensive floor: a negative or NaN multiplier here would return a negative
  // estimate, which would credit the session-budget counter.
  const iters = Number.isFinite(maxIterations) && maxIterations > 0
    ? Math.floor(maxIterations)
    : 1;
  return iters * (
    (avgInput / 1_000_000) * pricing.input +
    (expectedOutput / 1_000_000) * pricing.output
  );
}

interface SpawnAgentInput {
  agents: SpawnSpec[];
}

/**
 * A profile's model runs at the DEEP band, OR its band is UNKNOWN (the model_id
 * is not in `MODEL_CAPABILITIES` — common for BYOK / openai-compat custom
 * endpoints). Both are gated conservatively: a profile pins an arbitrary
 * model_id whose cost modelCapability cannot prove, so treating unknown as
 * "not deep" would let an expensive custom model run unconsented (the exact
 * asymmetry `spawn_agent({model:'deep'})` is gated but `spawn_agent({profile:
 * custom-expensive})` is not). Mirrors `profileExceedsMaxTier`, which refuses
 * unknown bands under a restrictive ceiling for the same reason. Single source
 * of truth for the rule — the check, the actual-tier report, and the headless
 * refuse all read it.
 */
/**
 * ⛔ UNKNOWN BAND COUNTS AS DEEP, and the opposite default sits at {@link minChildBudgetUSD},
 * where an unknown PRICE means no floor at all. Both are deliberate — decided 2026-10-07 —
 * and the reason is that they protect different things: this gate runs before the expensive
 * case and is the cheap place to be conservative, while a floor built on a price nobody pays
 * would refuse a free local model its whole remainder. Changing one to match the other is
 * not a consistency fix; it is a different decision.
 */
function profileBandIsDeepOrUnknown(profile: ModelProfile): boolean {
  const band = modelCapability(profile.model_id)?.tier;
  return band === 'deep' || band === undefined;
}

/**
 * Does a spawn spec route a child onto a tier that needs consent? The consent
 * `check` (permission guard) + the headless clamp (handler) MUST agree, so they
 * share this one predicate. Two paths:
 *  1. a profile whose band is deep OR unknown — A2: `resolveSpawnChildRouting.tier`
 *     reflects the CLAMPED tier, not the profile's band, so a profile pinning a
 *     deep model returns `.tier='balanced'` while `.model=<deep id>`. Read the
 *     band directly via `modelCapability` (and treat unknown conservatively).
 *  2. the resolved tier is deep. `resolveSpawnChildRouting` already clamps
 *     `spec.model` against the tenant `max_tier`, so the resolved tier is both
 *     necessary and sufficient — a bare `spec.model === 'deep'` shortcut would
 *     OVER-trigger when a ceiling clamps deep→balanced (warning about a deep
 *     cost the run demonstrably does not incur), so it is deliberately NOT used.
 */
function specResolvesDeep(spec: SpawnSpec, userConfig: LynoxUserConfig, baseProvider: LLMProvider): boolean {
  const profile = spec.profile ? profileNamed(userConfig.model_profiles, spec.profile) : undefined;
  if (profile && profileBandIsDeepOrUnknown(profile)) return true;
  const role = spec.role ? getRole(spec.role) : undefined;
  const { tier } = resolveSpawnChildRouting({ spec, role, profile, userConfig, baseProvider });
  return tier === 'deep';
}

/**
 * Five provider fields a sub-agent needs to talk to an LLM. Carries `apiKey`
 * as plaintext, so the result is consumed inline by `AgentConfig` construction
 * and never logged / serialized / sent to telemetry.
 *
 * Exported only for the unit tests that walk the precedence chain end-to-end.
 */
export interface ChildProviderConfig {
  apiKey: string | undefined;
  apiBaseURL: string | undefined;
  provider: LLMProvider | undefined;
  openaiModelId: string | undefined;
  openaiAuth: 'static' | 'google-vertex' | undefined;
}

/**
 * Reads the parent agent's `getProviderConfig()` defensively — legacy `IAgent`
 * mocks in older tests don't implement the method, so the typeof check keeps
 * the spawn path working without forcing a `__mocks__` update. Returns `null`
 * when the parent has no `getProviderConfig` member at all.
 */
function readParentProviderConfig(parentAgent: IAgent): ProviderConfigSnapshot | null {
  const candidate = (parentAgent as { getProviderConfig?: unknown }).getProviderConfig;
  if (typeof candidate !== 'function') return null;
  return (parentAgent as { getProviderConfig: () => ProviderConfigSnapshot }).getProviderConfig();
}

/**
 * Resolve sub-agent provider config along an explicit 3-tier precedence chain:
 *
 *   1. **profile** — a `ModelProfile` (named entry from `userConfig.model_profiles`)
 *      passed via `spec.profile`. Wins everything: a user who pinned a named
 *      profile for this spawn explicitly opted out of inheritance.
 *   2. **parent** — the parent agent's runtime `getProviderConfig()`. Closes
 *      the staging bug where managed-tier UI provider-switch wasn't reflected
 *      in `~/.lynox/config.json` and sub-agents got undefined apiBaseURL.
 *   3. **userConfig** — `loadConfig()` from disk. Final fallback for
 *      self-host paths where parent didn't set its provider config explicitly.
 *
 * Per-field nullish-coalesce means a profile that sets only `api_key` still
 * inherits `api_base_url` from the parent (or, finally, the user config).
 * The mid-tier `parent` may be `null` for legacy `IAgent` mocks without
 * `getProviderConfig()` — see `readParentProviderConfig`.
 */
export function resolveChildProviderConfig(
  profile: ModelProfile | undefined,
  parent: ProviderConfigSnapshot | null,
  userConfig: LynoxUserConfig,
): ChildProviderConfig {
  return {
    apiKey: profile?.api_key ?? parent?.apiKey ?? userConfig.api_key,
    apiBaseURL: profile?.api_base_url ?? parent?.apiBaseURL ?? userConfig.api_base_url,
    provider: profile?.provider ?? parent?.provider ?? userConfig.provider,
    openaiModelId: profile?.model_id ?? parent?.openaiModelId,
    openaiAuth: profile?.auth ?? parent?.openaiAuth,
  };
}

/**
 * Full wire + creds a spawned child Agent is built with, chosen from the tier the
 * child resolved to — the SEAM the hybrid-spawn provider bug is pinned to.
 *
 * The child Agent is always CONSTRUCTED FRESH (no ambient-client reuse), so it
 * must carry an explicit, self-consistent provider+model+key. Three cases:
 *
 *   1. **Cross-provider hybrid slot** (`crossProviderSlot`) — the slot drives the
 *      wire + creds (Slice 2). A slot that names a DIFFERENT provider than base
 *      is key-enriched upstream; but a slot that is the SAME provider as base and
 *      only carries an `api_base_url` is ALSO reported cross (see
 *      `hybridSlotClientConfig`) yet `enrichTierSetCreds` deliberately left it
 *      key-LESS (same-provider slots relied on the ambient client's key, which a
 *      fresh child doesn't have). So resolve the provider's key when the slot
 *      didn't supply one — else the child mis-routes / 401s with an empty key.
 *
 *   2. **Hybrid BASE-fallback tier** (`routing_mode==='hybrid'`, no cross slot) —
 *      resolve from the BASE provider, NOT the parent. In hybrid the parent runs
 *      on ITS OWN tier's slot (e.g. a Sonnet `balanced` main on the anthropic
 *      wire), so inheriting the parent's provider would pair this child's
 *      base-tier model (ministral-8b) with the parent's anthropic endpoint → a
 *      `404 no Route matched` (the v2.1.1 bug: fast collectors died silently).
 *      Mirror the session's base-tier resolution. An explicit `profile` opts out
 *      → case 3, which honours it.
 *
 *   3. **Standard mode (or an explicit profile)** — inherit the parent. This
 *      closes the managed-tier staging bug where a live UI provider-switch isn't
 *      yet in `config.json`; in standard mode the parent IS on the base provider,
 *      so inheritance is correct.
 *
 * Pure + table-testable: the caller passes a `resolveKey` closure (bound to
 * `resolveProviderApiKey` over the parent's secret store) so no SecretStore is
 * needed in tests.
 */
export function resolveSpawnChildProviderConfig(input: {
  hybridSlot: ReturnType<typeof hybridSlotClientConfig>;
  routingMode: 'standard' | 'hybrid';
  profile: ModelProfile | undefined;
  parent: ProviderConfigSnapshot | null;
  baseProvider: LLMProvider;
  userConfig: LynoxUserConfig;
  /** Endpoint-aware: 'openai' alone cannot tell Mistral from Groq from a local Ollama. */
  resolveKey: (provider: LLMProvider, apiBaseURL?: string) => string | undefined;
}): ChildProviderConfig {
  const { hybridSlot, routingMode, profile, parent, baseProvider, userConfig, resolveKey } = input;

  if (hybridSlot.crossProviderSlot) {
    return {
      provider: hybridSlot.provider,
      apiKey: hybridSlot.apiKey ?? resolveKey(hybridSlot.provider, hybridSlot.apiBaseURL),
      apiBaseURL: hybridSlot.apiBaseURL,
      openaiModelId: hybridSlot.openaiModelId,
      openaiAuth: undefined,
    };
  }

  if (!profile && routingMode === 'hybrid') {
    return {
      provider: baseProvider,
      apiKey: resolveKey(baseProvider, userConfig.api_base_url),
      apiBaseURL: userConfig.api_base_url,
      openaiModelId: userConfig.openai_model_id,
      openaiAuth: undefined,
    };
  }

  return resolveChildProviderConfig(profile, parent, userConfig);
}

// Control characters (incl. CR/LF) that could be used to spoof log lines or
// break terminal rendering when `name` is echoed in error messages, channel
// events, or the `## ${name}` markdown header.
// U+0085 NEL, U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are line
// breaks that `[\x00-\x1f\x7f]` does not cover. They matter here for the same
// reason CR/LF do: a name is echoed one-per-line in the all-failed message, so a
// name carrying a line break forges an extra row — and a forged row can claim a
// child SUCCEEDED inside a message whose whole job is to report that none did.
const CONTROL_CHARS = /[\x00-\x1f\x7f\u0085\u2028\u2029]/;

function validateSpawnInput(input: SpawnAgentInput): void {
  if (!Array.isArray(input.agents) || input.agents.length === 0) {
    throw new Error('spawn_agent requires at least one agent in `agents`.');
  }
  if (input.agents.length > MAX_SPAWN_AGENTS) {
    throw new Error(
      `spawn_agent accepts at most ${MAX_SPAWN_AGENTS} agents per call (got ${input.agents.length}).`,
    );
  }
  for (const spec of input.agents) {
    if (typeof spec.name !== 'string' || spec.name.length === 0 || spec.name.length > MAX_SPAWN_NAME_LENGTH) {
      throw new Error(
        `spawn_agent: name must be a non-empty string up to ${MAX_SPAWN_NAME_LENGTH} chars.`,
      );
    }
    if (CONTROL_CHARS.test(spec.name)) {
      throw new Error('spawn_agent: name must not contain control characters.');
    }
    if (typeof spec.task !== 'string' || spec.task.length === 0 || spec.task.length > MAX_SPAWN_TASK_LENGTH) {
      throw new Error(
        `spawn_agent "${spec.name}": task must be a non-empty string up to ${MAX_SPAWN_TASK_LENGTH} chars.`,
      );
    }
    if (spec.max_turns !== undefined) {
      if (!Number.isInteger(spec.max_turns) || spec.max_turns < 1 || spec.max_turns > MAX_SPAWN_TURNS) {
        throw new Error(
          `spawn_agent "${spec.name}": max_turns must be an integer in [1, ${MAX_SPAWN_TURNS}] (got ${spec.max_turns}).`,
        );
      }
    }
    if (spec.max_budget_usd !== undefined) {
      if (!Number.isFinite(spec.max_budget_usd) || spec.max_budget_usd < 0 || spec.max_budget_usd > MAX_SPAWN_BUDGET_USD) {
        throw new Error(
          `spawn_agent "${spec.name}": max_budget_usd must be a number in [0, ${MAX_SPAWN_BUDGET_USD}] (got ${spec.max_budget_usd}).`,
        );
      }
    }
    if (spec.secret_scope !== undefined && spec.secret_scope !== null) {
      // The JSON schema's `oneOf` is advice to the model, not a gate: the value
      // arriving here is whatever the model emitted. Unchecked, a bare string
      // spreads into its characters and becomes a scope of single letters — a
      // nonsense scope that happens to fail closed, which is the kind of accident
      // that reads as working until the day it does not.
      const sc: unknown = spec.secret_scope;
      const ok = sc === 'all'
        || (Array.isArray(sc) && sc.every((n) => typeof n === 'string' && n.length > 0));
      if (!ok) {
        throw new Error(
          `spawn_agent "${spec.name}": secret_scope must be an array of vault key names, or the string "all". `
          + `Got ${Array.isArray(sc) ? 'an array with a non-string entry' : typeof sc === 'string' ? `the string "${sc}"` : typeof sc}.`,
        );
      }
    }
  }
}

/**
 * Structured error detail for a failed spawn child's `error_text` column. The
 * compact `stop_reason` gets a 200-char slice of the message; `error_text` gets
 * the FULL detail — name, an HTTP `status` when the SDK error carries one (so a
 * provider mis-route surfaces as `[404] …` not a bare message), and the message.
 * Without this the runs row records status=failed with a null error_text, which
 * makes a silent sub-agent failure undiagnosable after the fact (the exact gap
 * that hid the v2.1.1 hybrid 404s until the DB was read by hand).
 */
/** How deep a `cause` chain is rendered before it is cut. Foreign data. */
const MAX_CAUSE_DEPTH = 8;

/** Per-child ceiling on the rendered error. Bytes, because depth does not bound them. */
const MAX_RENDERED_ERROR_CHARS = 2_000;

/** Everything the name gate rejects, flattened wherever a field is rendered on
 *  its own line. Deliberately the SAME class as `CONTROL_CHARS`: a subset would
 *  hold the wide, unvalidated field to a looser rule than the narrow, already
 *  validated one. */
const UNSAFE_IN_LINE = /[\x00-\x1f\x7f\u0085\u2028\u2029]/g;

export function formatSpawnError(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) return String(err);
  // A cause chain is foreign data — an SDK may hand back a cycle, and this
  // function also runs on the PARTIAL-failure path, where a throw would discard
  // the results of children that SUCCEEDED. That is the failure direction this
  // file exists to remove, one level down.
  //
  // ONE bound, not two. A seen-set sat beside this depth stop and no test could
  // tell them apart — deleting the seen-set left the suite green, because after
  // eight levels the depth stop cuts a cycle anyway. Two guards where one
  // suffices is a guard nobody is checking: it survives every mutation and
  // reads as defence.
  const cutStatus = (err as { status?: unknown }).status;
  const cutPrefix = typeof cutStatus === 'number' ? `[${cutStatus}] ` : '';
  if (depth >= MAX_CAUSE_DEPTH) {
    // The prefix survives the cut. Dropping it loses the status — the one field
    // this whole change exists to keep in front of the reader.
    return `${cutPrefix}${err.name}: ${err.message} (cause chain truncated)`;
  }
  const statusPrefix = cutPrefix;
  // The cause is formatted by THIS function too, not string-interpolated by the
  // caller: `${err.cause}` on an Error renders as "Error: msg" and drops the
  // status, which is the one field that separates a mis-route from a bad task.
  const { cause } = err;
  const causeSuffix = cause === undefined || cause === null
    ? ''
    : ` (cause: ${cause instanceof Error ? formatSpawnError(cause, depth + 1) : String(cause)})`;
  return `${statusPrefix}${err.name}: ${err.message}${causeSuffix}`;
}

/**
 * The message for the case where EVERY child died, which is the case the parent
 * is least able to act on and was until now told the least about.
 *
 * The partial-failure path already renders each child as `## name — FAILED` with
 * `formatSpawnError`, and the comment at that call says why: the HTTP status is
 * what makes a provider mis-route read as a config failure rather than a vague
 * one. When all of them failed, that rendering was built and then thrown away —
 * the throw joined bare `err.message`s, so a real fan-out reported
 * `All sub-agents failed: 404 no Route matched with those values; 404 no Route
 * matched with those values; 404 no Route matched with those values` and named
 * neither the children nor the status (dogfood 2026-09-24).
 *
 * It reports and does not explain, and that took four rounds to accept. Each
 * round wrote a sentence naming the cause; each was wrong for a case the next
 * round found; and each fix was a better SENTENCE rather than a different kind
 * of statement. The summary is now a count, and the reader draws the conclusion
 * from the lines above it.
 */
export function formatAllFailedMessage(failures: readonly { name: string; err: unknown }[]): string {
  if (failures.length === 0) return 'No sub-agent results to report.';

  // BOTH fields get the SAME treatment, and the wide one is the reason. The
  // NAME is narrow — `validateSpawnInput` length-caps it and rejects the whole
  // control range. `err.message` is wide: gateway bodies, HTML pages, nested
  // failures, none of it validated. In a one-per-line list anything that ends a
  // line in either field invents a row, and a forged row can claim a child
  // SUCCEEDED inside a message whose whole job is to report that none did.
  // Giving one field two guards and the other none is worse than giving neither
  // any, because it reads as closed.
  //
  // The flattened set is the same class the name gate REJECTS, not a subset: an
  // earlier round flattened five characters while the gate rejected thirty-five,
  // so vertical tab, form feed and ESC reached the output untouched.
  const clean = (v: string): string => escapeXml(v).replace(UNSAFE_IN_LINE, ' ');
  // Per-error byte cap. The depth bound on the cause chain terminates it; it
  // does not bound it — eight levels of a 100 KB message, times ten children,
  // measured at 9 MB, and this string is thrown into the parent's context on
  // the one path that deliberately never truncates. Depth was the wrong axis:
  // the cost is bytes.
  const cap = (v: string): string =>
    v.length <= MAX_RENDERED_ERROR_CHARS ? v : `${v.slice(0, MAX_RENDERED_ERROR_CHARS)}… (${String(v.length)} chars, truncated)`;
  const formatted = failures.map((f) => cap(clean(formatSpawnError(f.err))));
  const lines = failures.map((f, i) => `- ${clean(f.name)}: ${formatted[i] as string}`);

  // Counted off the RENDERED line, not off a field beside it. A status is used
  // when there is one — the motivating gateway 404 would otherwise be called
  // unrelated the moment the gateway echoed a request id. Without a status the
  // discriminator is the line the reader actually sees, so the count and the
  // list cannot disagree: reading `err.message` alone called three undici
  // failures identical (the difference lives in `cause.code`, which the line
  // shows and the message does not).
  const classOf = (err: unknown, rendered: string): string => {
    const status = err instanceof Error ? (err as { status?: unknown }).status : undefined;
    return typeof status === 'number' ? `status:${String(status)}` : `line:${rendered}`;
  };
  const distinct = new Set(failures.map((f, i) => classOf(f.err, formatted[i] as string))).size;

  // A COUNT, not a sentence. Four rounds wrote a sentence naming the cause and
  // every one was wrong for a case the next round found — most recently "one
  // condition to look at rather than N tasks to re-check", which is exactly
  // backwards for N oversized tasks that all return the same 400, and "they do
  // not share one cause", which is wrong when one abort hits an idle child and
  // a mid-flight one differently. Each fix was a better sentence rather than a
  // different kind of statement. The data does not determine the cause; the
  // reader has the lines above and draws it. A number cannot overclaim.
  const errs = failures.length === 1 ? '1 error' : `${String(failures.length)} errors`;
  const count = failures.length === 1 ? '1 sub-agent' : `${String(failures.length)} sub-agents`;
  return `All ${count} failed and none returned a result.\n\n` +
    `${lines.join('\n')}\n\n${errs}, ${String(distinct)} distinct.`;
}

/**
 * Does a spawn `profile` route a child to a model whose cost band exceeds the
 * tenant's `max_tier` ceiling? A profile pins a concrete `model_id` that bypasses
 * the tier clamp (it wins over the resolved tier), so this is the guard that keeps
 * an agent-set (hence prompt-injectable) profile from escaping the cost ceiling.
 *
 * REFUSE, not clamp: a profile is a specific endpoint, so you cannot substitute a
 * cheaper model on it. Semantics:
 *  - no ceiling (`max_tier` unset, i.e. self-host default) → never exceeds.
 *  - `max_tier: 'deep'` → not restrictive (nothing is above deep) → never exceeds,
 *    including an unregistered model.
 *  - a restrictive ceiling (`fast`/`balanced`): a REGISTERED model exceeds if its
 *    tier is above the ceiling; an UNREGISTERED model (no known tier) is refused
 *    conservatively — its band can't be proven within the ceiling.
 */
export function profileExceedsMaxTier(profileModelId: string, maxTier: ModelTier | undefined): boolean {
  // Delegates to the shared predicate — the same rule now guards the tier
  // chokepoint (`resolveRunModel`), so a raw pipeline `step.model` id is refused
  // the same way a profile is. (`spec.model` here is separately enum-
  // gated to tiers, so it never reaches the chokepoint's raw-id branch.) Kept as a
  // domain-named wrapper.
  return modelIdExceedsMaxTier(profileModelId, maxTier);
}

/**
 * Which model a spawned child will actually run on, and the hybrid slot that
 * decides its wire.
 *
 * Shared because three callers must give the SAME answer: the pre-spawn cost
 * reservation, the `spawn` event the UI renders, and the child's own
 * construction. Two of them used to compute it separately and disagreed — the
 * reservation fell back to the tenant's `default_tier` while the run pins
 * unroled spawns to `balanced`, so an instance configured `default_tier: 'deep'`
 * reserved deep rates against the session ceiling for a child that then ran
 * balanced. One function, one answer; a UI that names a third model would be
 * worse still.
 *
 * Validation stays with the caller: this resolves, it does not refuse. The
 * refusals live in `assertSpawnRoutingPermitted`, which the handler runs BEFORE
 * it announces the batch — see that function for why the ordering is the whole
 * point.
 */
export function resolveSpawnChildRouting(input: {
  spec: SpawnSpec;
  role: ReturnType<typeof getRole>;
  profile: ModelProfile | undefined;
  userConfig: LynoxUserConfig;
  baseProvider: LLMProvider;
  /** The spawning agent's provider config — a child without its own profile inherits it (`resolveSpawnChildProviderConfig`). */
  parent?: ProviderConfigSnapshot | null | undefined;
}): { tier: ModelTier; model: string; hybridSlot: ReturnType<typeof hybridSlotClientConfig>; pinnedByProfile: boolean } {
  const { spec, role, profile, userConfig, baseProvider, parent } = input;
  // Single chokepoint: the override gate (now a pass-through, D8) THEN CLAMP to
  // the cost ceiling THEN map to the provider's model id. Routing through
  // resolveRunModel adds the max_tier clamp this path previously skipped — a run
  // under a lower ceiling no longer reaches the deep model past its cap.
  const resolvedRun = resolveRunModel({
    requested: spec.model,
    // Unroled spawns pin to `balanced`, NOT the main chat's `default_tier`
    // (rafael 2026-07-07): once the "Main chat model" picker can raise the main
    // chat to `deep` (Opus/Large), letting tier-unspecified spawns inherit that
    // would silently multiply per-message cost. Roles keep their own tier
    // (operator/collector=fast); an explicit `spec.model` still wins via
    // resolveRunModel's `requested`.
    defaultTier: (role?.model ?? 'balanced') as ModelTier,
    accountTier: userConfig.account_tier,
    maxTier: userConfig.max_tier,
    blockedModelIds: userConfig.blocked_model_ids,
    provider: baseProvider,
  });
  // Slice 2: a subagent's tier follows the hybrid tier_set. When the resolved
  // tier has a CROSS-provider slot (e.g. a Mistral main with a `deep`→Sonnet-5
  // slot), the child runs on that slot's provider/model/creds with a dedicated
  // client — no per-spawn `profile:` needed. `spec.profile` still WINS (an
  // explicit opt-out of inheritance). Standard mode returns no slot
  // (resolveTierModel gates on hybrid) → this is byte-parity with before.
  const hybridSlot = profile
    ? { crossProviderSlot: false as const }
    : hybridSlotClientConfig(resolveTierModel(resolvedRun.tier, baseProvider), baseProvider);
  // Profile overrides model ID + provider; a cross-provider hybrid slot supplies
  // its own model; otherwise use the resolved tier id for the base provider.
  // A profile pins endpoint AND model as one pair — also when the child has no
  // profile of its own but inherits a profiled parent's client. That inheritance
  // happens exactly when `resolveSpawnChildProviderConfig` falls through to the
  // parent (no cross-provider slot, not hybrid-without-profile); the child then
  // talks to the profile's endpoint and must send the profile's model, not the
  // tier's.
  const inheritedPin = !profile
    && !hybridSlot.crossProviderSlot
    && getActiveRoutingMode() !== 'hybrid'
    ? pinnedModelOf(parent)
    : undefined;
  const model = profile
    ? profile.model_id
    : (inheritedPin ?? (hybridSlot.crossProviderSlot ? hybridSlot.openaiModelId : resolvedRun.modelId));
  return { tier: resolvedRun.tier, model, hybridSlot, pinnedByProfile: profile !== undefined || inheritedPin !== undefined };
}

/**
 * Every reason a spawn spec is refused outright, in one place — and it runs
 * BEFORE the batch is announced.
 *
 * WHY THE ORDERING IS THE POINT. These four refusals used to live inside
 * `executeThinker`, which is reached only after the `spawn` event has already
 * been streamed to the client. So a `spawn_agent({profile})` naming a model above
 * the tenant's `max_tier` was ANNOUNCED with that model id — the panel rendered
 * `child · claude-opus-4-6` as "the model it runs on" — and only then refused.
 * The UI named a model the run demonstrably would not use, which is precisely
 * the failure the shared-resolution work was done to remove. Announcing after
 * validation makes the panel's model id true by construction.
 *
 * `executeThinker` calls this too. Not redundancy for its own sake: the
 * announcement path and the construction path must refuse for the same reasons,
 * and one function is the only way that stays true when a fifth reason is added.
 */
function assertSpawnRoutingPermitted(spec: SpawnSpec, userConfig: LynoxUserConfig): void {
  if (spec.role && !getRole(spec.role)) {
    throw new Error(
      `Unknown role "${spec.role}". Available roles: ${getRoleNames().join(', ')}. ` +
      `If none of these fit, omit the "role" field and set model/effort/tools directly.`,
    );
  }

  const profile: ModelProfile | undefined = spec.profile
    ? profileNamed(userConfig.model_profiles, spec.profile)
    : undefined;
  if (spec.profile && !profile) {
    throw new Error(`Unknown model profile "${spec.profile}". Available: ${Object.keys(userConfig.model_profiles ?? {}).join(', ') || 'none configured'}.`);
  }
  if (!profile) return;

  // A profile sets `model = profile.model_id`, bypassing the `max_tier` clamp
  // that `resolveRunModel` applies to a tier. That is the injection lever:
  // a prompt-injected `spawn({profile})` could route a child to a
  // model above the tenant's cost ceiling. A profile cannot be clamped DOWN (you
  // cannot substitute a different model on someone's endpoint), so the
  // enforcement is REFUSE, not clamp. Cross-provider hybrid spawn is
  // unaffected — that runs on the tier path.
  if (profileExceedsMaxTier(profile.model_id, userConfig.max_tier)) {
    const band = modelCapability(profile.model_id)?.tier;
    throw new Error(`Model profile "${spec.profile}" (${profile.model_id}) is not permitted on this instance: its cost band ${band ? `"${band}"` : '(unknown)'} exceeds the max tier "${userConfig.max_tier}". A profile pins a specific endpoint and cannot be clamped down, so the spawn is refused. Use the \`model\` tier parameter (fast/balanced/deep) for a ceiling-clamped subagent.`);
  }
  // Model blocklist (blocked_model_ids): a profile pinning a blocked model is
  // refused the same way — a pinned endpoint cannot be substituted, so REFUSE,
  // not clamp. Same checkpoint as the ceiling guard above (write-accept ⟺
  // load-keep ⟺ resolve symmetry for the profile raw-id path).
  if (isBlockedModelId(profile.model_id, userConfig.blocked_model_ids)) {
    throw new Error(`Model profile "${spec.profile}" (${profile.model_id}) is not permitted on this instance: the model is blocked by the operator model blocklist. A profile pins a specific endpoint and cannot be substituted, so the spawn is refused. Use the \`model\` tier parameter (fast/balanced/deep) for a subagent on a permitted model.`);
  }
}

/**
 * The parent's prompt callbacks, wrapped so every prompt a child raises names
 * the child as its cause.
 *
 * WHY A WRAPPER AND NOT A SENTENCE IN THE TOOL. A consent dialog is answered on
 * what it shows, and what it shows is "Allow / Deny" over a question whose
 * asker the user cannot see. From a child the asker is not the person's own
 * turn, and that single circumstance is what would make an otherwise ordinary
 * request suspicious. Fourteen call sites raise such dialogs; this is the one
 * place all fourteen pass through.
 *
 * WHY THE ORIGIN CANNOT CARRY THE WARNING. `spec.name` and `spec.task` are
 * written by the parent model — the same model an injected instruction is
 * steering when this matters. A parent free to name its child names it
 * "Main assistant". So these two travel as VALUES: the renderer frames them
 * ("A sub-agent asked"), and that frame is true whatever the name claims.
 *
 * Merge order is `{...ours, ...m}`, matching `buildSubAgentPromptCallbacks`:
 * a caller-supplied meta wins, and in a nested spawn the DEEPEST wrapper is the
 * innermost caller, so the immediate asker ends up named rather than the
 * outermost one. A child inside a pipeline step keeps both sets — the step
 * fields come from the parent's own wrapper, one frame further out.
 */
function promptCallbacksWithOrigin(
  parent: IAgent,
  spec: SpawnSpec,
  childGone: AbortSignal,
  holdForHuman: (() => () => void) | undefined,
): { promptUser?: PromptUserFn | undefined; promptSecret?: PromptSecretFn | undefined; promptTabs?: PromptTabsFn | undefined } {
  // `subagent: true` is the claim; the two names are decoration on it. Keep them
  // in that order in your head, because the first version had only the names and
  // a child called "​" then rendered no origin line at all.
  const origin: PromptMeta = { subagent: true, subagentName: spec.name, subagentTask: spec.task };
  const { promptUser, promptSecret, promptTabs } = parent;
  return {
    // Each stays undefined when the parent had none — an autonomous or headless
    // parent has no channel, and manufacturing a callback here would turn every
    // tool's "no interactive channel" refusal into a hang.
    //
    // `childGone` stands in when the child's own run signal is gone: a call the child
    // abandoned can still ask after the child settled, and without it the parent's
    // getter would hand the question the PARENT's live run signal — answerable, by
    // nobody the child could report to. Aborted at settle, it withdraws it at birth.
    //
    // `holdForHuman` stops the spawn time limit while the question is open (see
    // `SpawnDeadline`).
    //
    // And a question raised once the child has settled is not forwarded at all: it
    // answers itself as not-given (the same value an unanswered question settles to),
    // whatever the parent's channel does with a stopped signal — the worker loop's,
    // for one, ignores it, and would leave the question answerable for its TTL.
    promptUser: promptUser ? (q, opts, m) => (childGone.aborted ? Promise.resolve('__dismissed__')
      : whileHeld(holdForHuman, () => promptUser(q, opts, { ...origin, ...m, signal: m?.signal ?? childGone }))) : undefined,
    promptSecret: promptSecret ? (n, p, k, m) => (childGone.aborted ? Promise.resolve('canceled' as const)
      : whileHeld(holdForHuman, () => promptSecret(n, p, k, { ...origin, ...m, signal: m?.signal ?? childGone }))) : undefined,
    promptTabs: promptTabs ? (qs, m) => (childGone.aborted ? Promise.resolve([])
      : whileHeld(holdForHuman, () => promptTabs(qs, { ...origin, ...m, signal: m?.signal ?? childGone }))) : undefined,
  };
}

async function whileHeld<T>(holdForHuman: (() => () => void) | undefined, ask: () => Promise<T>): Promise<T> {
  const release = holdForHuman?.();
  try {
    return await ask();
  } finally {
    release?.();
  }
}

/**
 * Tell the parent which vault keys its child asked for and did not get.
 *
 * Without this the parent reads whatever the failing tool said, and every tool
 * that meets a scoped-out key sees the same thing an empty vault produces —
 * `resolve()` returning null. `http.ts`, for one, turns that into "the vault has
 * no access_token under X, mint one first", which is a correct sentence for a
 * missing key and the wrong instruction for a scoped-out one: the token exists.
 * The note names the actual cause and the actual remedy, beside that message.
 */
function appendDeniedKeyNote(result: string, denied: ReadonlySet<string>): string {
  if (denied.size === 0) return result;
  const names = [...denied].join(', ');
  // "Refused", not "not resolved": a denial can come from a read, a delete or a
  // consent record, and a sentence that names only the read sends the parent
  // looking for a missing value when the child was turned away from a delete.
  return `${result}\n\n[secret_scope] This sub-agent asked for ${denied.size === 1 ? 'a vault key' : 'vault keys'} its spawn order did not name: ${names}. `
    + `${denied.size === 1 ? 'It was' : 'They were'} refused — if the key exists, this is a scope decision, not a missing secret. `
    + `To grant ${denied.size === 1 ? 'it' : 'them'}, re-spawn with secret_scope: [${[...denied].map(n => `"${n}"`).join(', ')}].`;
}

async function executeThinker(
  spec: SpawnSpec,
  parentAgent: IAgent,
  // Emitting: this handler is wired onto the CHILD agent, i.e. it is the sink a
  // core producer writes into. Keeping it loose here would reintroduce at the
  // boundary exactly what the child was forced to decide.
  parentOnStream: EmittingStreamHandler | null,
  childDepth: number,
  /**
   * The child's actual spend, reported once it stops for ANY reason — done,
   * failed, or aborted. A child that dies halfway still spent what it spent,
   * and the caller needs that number even though it never receives a result.
   */
  onSettled?: (costUsd: number) => void,
  /**
   * The slice of the PARENT run's remaining ceiling this child was granted, or
   * `undefined` when the parent has no ceiling to divide — then the child keeps its own
   * budget and nothing about this path changes.
   *
   * ⛔ This is what makes a fan-out's total bounded by CONSTRUCTION rather than by the
   * accuracy of an estimate: the handler reserved the sum of the shares against the
   * parent's remainder before dispatch, and each child's own guard holds it to its
   * share. A share reserved and not enforced would be a number nothing holds.
   */
  capUSD?: number,
  /**
   * The spawn time limit for this child (paused while the child waits on a human, see
   * `SpawnDeadline`). Its abort aborts the child's run (`Agent.send`'s `disposableDeadline`), and the child then fails with a reason that names the limit — distinct
   * from an abort the parent's own stop sends through the abort scope.
   */
  deadline?: SpawnDeadline,
): Promise<{ result: string; childRunId: string | undefined; model: string; stop: SendStop | null }> {
  // Aborted once this child settles, for any reason — see promptCallbacksWithOrigin.
  const childGone = new AbortController();
  // 4-tier resolution: spec fields > role defaults > user config > global default
  const userConfig = loadConfig();

  // Same refusals the handler already ran before announcing the batch. Kept here
  // because this is the path that BUILDS the child: the two must never diverge,
  // and a fifth refusal added to one and not the other is exactly how the UI came
  // to announce a model the run refused.
  assertSpawnRoutingPermitted(spec, userConfig);

  // The child's reach into the vault. Default = the keys THIS spawn order names
  // and nothing else; the parent's own vault is not inherited by omission.
  //
  // Resolved here rather than in the handler on purpose: the comment above says
  // the two paths must never diverge, and a second copy of this decision is
  // exactly how they would. This is the path that builds the child, so this is
  // where its reach is decided.
  const parentScope = vaultScopeOf(parentAgent.secretStore);
  // Read from the fields the caller writes as INSTRUCTION, never from `context`.
  // `context` is documented on the schema as carrying verbatim excerpts of source
  // material, so it is the one field of the order that routinely holds text
  // somebody else wrote. Scanning it would let a pasted document widen the scope
  // of the child that reads it — the wrong direction for a default to fail in.
  // A key genuinely needed for material quoted in `context` is named in
  // `secret_scope`, and the denial note says so when one is missing.
  const requestedScope = spec.secret_scope
    ?? defaultVaultScope({ task: spec.task, system_prompt: spec.system_prompt });
  const narrowed = narrowVaultScope(parentScope, requestedScope);
  if ('refusal' in narrowed) {
    throw new Error(`spawn_agent "${spec.name}": ${narrowed.refusal}`);
  }
  // Names the child asked for and did not get. Collected so the PARENT is told
  // the real reason — a tool that only sees `resolve() === null` reports the key
  // as missing from the vault and sends the user off to create one they already
  // have.
  const deniedKeys = new Set<string>();
  const childSecretStore = parentAgent.secretStore
    ? scopeSecretStore(parentAgent.secretStore, narrowed.scope, (n) => deniedKeys.add(n))
    : undefined;

  // The ONE read that happens outside the child's scope, named here rather than
  // left to be discovered: the child's own LLM credential. It is provisioned by
  // the spawner exactly as the parent's is, resolved here in the parent's context
  // and handed to the child as a configured wire credential — never as a vault
  // name the child can address. Scoping it would not narrow the child's reach; it
  // would stop the child from running at all wherever the key lives in the vault
  // rather than the environment, which is every BYOK tenant.
  //
  // Bounded anyway. Before this, the closure below carried the parent's WHOLE
  // vault, so the exception was unlimited in what it could have read even though
  // it only ever read one slot. `PROVIDER_KEY_SLOTS` is derived from the model
  // catalog, so a preset that introduces a new slot stays covered.
  const wireKeyReader = parentAgent.secretStore
    ? providerKeySlotReader(parentAgent.secretStore, PROVIDER_KEY_SLOTS)
    : undefined;

  const resolved = spec.role ? getRole(spec.role) : undefined;
  const profile: ModelProfile | undefined = spec.profile
    ? profileNamed(userConfig.model_profiles, spec.profile)
    : undefined;

  const baseProvider = getActiveProvider();
  const parentProviderCfg = readParentProviderConfig(parentAgent);
  const { tier: modelTier, model, hybridSlot, pinnedByProfile } = resolveSpawnChildRouting({
    spec, role: resolved, profile, userConfig, baseProvider, parent: parentProviderCfg,
  });
  // Resolve the child's wire + creds ONCE, up front, so (a) the runs row records
  // the ACTUAL provider instead of '' — the recording gap that made the hybrid
  // 404s show `provider=""` and hid which wire the child hit — and (b) the
  // AgentConfig below reuses the same result (no double resolution).
  const childProviderCfg = resolveSpawnChildProviderConfig({
    hybridSlot,
    routingMode: getActiveRoutingMode(),
    profile,
    parent: parentProviderCfg,
    baseProvider,
    userConfig,
    resolveKey: (provider, apiBaseURL) => resolveProviderApiKey({ provider, apiBaseURL, secretStore: wireKeyReader, userConfig }),
  });
  // A2: every sub-agent carries the grounding block. Prepend it to the
  // caller-supplied prompt, OR use it standalone when none was given — otherwise
  // the child falls through to agent.ts's bare default, which has NO grounding.
  const systemPrompt = spec.system_prompt
    ? `${GROUNDING_PROMPT_BLOCK}\n\n${spec.system_prompt}`
    : GROUNDING_PROMPT_BLOCK;
  // OpenAI providers don't support thinking or effort
  const thinking = profile ? { type: 'disabled' as const } : spec.thinking;
  const effort = profile ? undefined : (spec.effort ?? resolved?.effort);
  const maxIterations = spec.max_turns;

  // Tool scoping — one shared mapping (`roleToolProfile`), so a role's grant shape
  // cannot differ between this path and the inline pipeline path in
  // orchestrator/runtime-adapter.ts. A `readOnly` role resolves to
  // READ_ONLY_TOOL_SURFACE here.
  const roleProfile = resolved ? roleToolProfile(resolved) : null;
  // Use the parent's FILTERED tool list (honours user-disabled tools from
  // Settings → Tool Toggles). Without this, a spawn from a prompt-injected
  // parent could re-introduce tools the user explicitly disabled — the
  // exact surface the Tool-Toggle PR was meant to close.
  const tools = resolveTools(spec.tools, roleProfile, parentAgent.getAvailableTools(), SPAWN_EXCLUDED);

  // Context injection (XML-escaped to prevent tag injection)
  const task = spec.context
    // escapeXml stays: it also inerts tags OTHER than this one. renderFence adds
    // the close-tag neutralisation in every encoding, from one place.
    ? compose([renderFence('context', escapeXml(spec.context)), engineText(spec.task)], '\n\n')
    : spec.task;

  // Isolated memory
  const memory = spec.isolated_memory === true
    ? undefined
    : (parentAgent.memory ?? undefined);

  // Isolation propagation: parent's isolation flows to child, child can only be MORE restrictive
  let childIsolation: IsolationConfig | undefined;
  const parentIsolation = parentAgent.isolation;
  if (parentIsolation) {
    const levelOrder: Record<IsolationLevel, number> = {
      'shared': 0,
      'scoped': 1,
      'sandboxed': 2,
      'air-gapped': 3,
    };
    if (spec.isolation) {
      // Child's explicit isolation can only be MORE restrictive
      const effectiveLevel = levelOrder[spec.isolation.level] >= levelOrder[parentIsolation.level]
        ? spec.isolation.level
        : parentIsolation.level;
      childIsolation = { ...spec.isolation, level: effectiveLevel };
    } else {
      childIsolation = parentIsolation;
    }
  } else if (spec.isolation) {
    childIsolation = spec.isolation;
  }

  // Cost guard: use explicit budget from spec, or default
  // ⛔ The granted share wins when there is one — see `capUSD`. It can be SMALLER than
  // the spec asked for, deliberately: a caller wanting $5 inside a run with $0.40 left
  // gets a scaled share, and the result says so. The refusal happens one level up, when
  // even the scaled shares do not clear the floor.
  const budgetUSD = capUSD ?? spec.max_budget_usd ?? DEFAULT_SPAWN_BUDGET_USD;
  const costGuard: CostGuardConfig = {
    maxBudgetUSD: budgetUSD,
    maxIterations: maxIterations ?? DEFAULT_SPAWN_MAX_TURNS,
  };

  // T2-X1 (PRD-HN-LAUNCH-HARDENING) part 4+5: mint a RunHistory row for the
  // child BEFORE constructing the Agent so (a) the constructor can stamp
  // `currentRunId` onto the child, (b) the post-run `updateRun()` below
  // records actual cost keyed on that id, and (c) the daily/monthly cost-cap
  // aggregator (`RunHistory.getCostByDay` → `session-budget.checkPersistentBudget`)
  // sees the spawn spend. Without this, a self-hoster's BYOK cap can drift
  // past their configured limit via fan-out (spawn-child spend is invisible
  // to the runs table today). RunHistory comes from the parent's
  // toolContext — engine-init wires it at startup. Falls back to undefined
  // when no history is configured (ad-hoc Agent ctor outside Session).
  const runHistory = parentAgent.toolContext.runHistory;
  let childRunId: string | undefined;
  if (runHistory) {
    try {
      childRunId = runHistory.insertRun({
        sessionId: parentAgent.currentThreadId ?? '',
        taskText: spec.task,
        modelTier: modelTier as string,
        modelId: model,
        provider: childProviderCfg.provider,
        runType: 'single',
        spawnParentId: parentAgent.currentRunId,
        spawnDepth: childDepth,
      });
    } catch {
      // Persistence failures must never break a spawn. Cost simply won't
      // be recorded for this child — caps see exactly what they saw pre-fix.
      childRunId = undefined;
    }
  }

  const agentConfig: AgentConfig = {
    name: spec.name,
    model,
    // A profile pins endpoint and model as one pair (`AgentConfig.modelPinnedByProfile`),
    // its own or one inherited from a profiled parent (`resolveSpawnChildRouting`).
    modelPinnedByProfile: pinnedByProfile,
    systemPrompt,
    // ⛔ INHERITED, and this line is the transitive half of the scoping: the child
    // registers in the PARENT's scope below, and by carrying that same scope it makes
    // its own children land there too — so a session's abort reaches the whole chain.
    // Without it a grandchild is reachable by nothing, which is the one failure the
    // module-wide set it replaces could not have had.
    tools,
    thinking,
    effort,
    maxTokens: spec.max_tokens ?? profile?.max_tokens,
    memory,
    // DK.1: inherit the durable-memory flag so a sub-agent on an ON tenant also stands down
    // the legacy end-of-turn extraction (the child shares the parent's Memory; without this it
    // would keep extracting into the minting channel the substrate decouples from).
    durableMemoryEnabled: parentAgent.durableMemoryEnabled,
    // Inherit the parent's memory scopes: task and memory tools the child inherits check
    // `agent.activeScopes`, and a child should check against the same scopes as its parent.
    activeScopes: parentAgent.activeScopes,
    // Cut at settle: a call the child abandoned may still emit, and the parent's
    // stream is re-bound per run — its late events would land in the parent's NEXT run.
    onStream: parentOnStream ? (event) => (childGone.signal.aborted ? undefined : parentOnStream(event)) : undefined,
    spawnDepth: childDepth,
    maxIterations,
    isolation: childIsolation,
    autonomy: parentAgent.autonomy,
    costGuard,
    // Propagate parent's excludeTools so child's defense-in-depth check
    // refuses tool_use blocks naming disabled tools (in addition to the
    // tool list itself already being filtered above).
    excludeTools: [...parentAgent.getExcludedToolNames()],
    // Inherit the user's context-window cap so a spawned researcher running
    // on a 1M-native model still respects the user's 200k preference.
    maxContextWindowTokens: parentAgent.getMaxContextWindowTokens(),
    // Declared native window: a spawn-time profile's `context_window` wins,
    // else inherit the parent's so a sub-agent on the same custom/BYOK/self-host
    // model trims against the real window, not the 200k id-fallback.
    nativeContextWindow: profile?.context_window ?? parentAgent.getNativeContextWindow(),
    // Child wire + creds, resolved from the child's OWN tier (never the parent's
    // runtime slot in hybrid — the v2.1.1 silent-fast-spawn 404). Resolved once
    // above so the runs row records the same provider. Rationale in
    // `resolveSpawnChildProviderConfig`.
    ...childProviderCfg,

    gcpProjectId: userConfig.gcp_project_id,
    gcpRegion: userConfig.gcp_region,
    userTimezone: parentAgent.userTimezone,
    // Share the parent's Session counters so one conversation accumulates
    // a single http/write budget across the main agent + all sub-agents.
    sessionCounters: parentAgent.sessionCounters,
    // Share the recall blob store so a sub-agent's `recall_tool_result` can
    // resolve handles minted by the parent conversation's last compaction.
    toolResultBlobStore: parentAgent.toolResultBlobStore,
    // T2-X1 part 1: shallow-copy parent's toolContext so the child sees the
    // engine's DataStore / RunHistory / ApiStore / KnowledgeLayer / network
    // policy refs (sub-agents need these to use tools). Shallow copy =
    // distinct object, shared refs — so the child INHERITS the parent's
    // `networkPolicy`/`allowedHosts` and cannot escape to broader egress than
    // its parent (the safe direction). Child-side TIGHTENING (a child more
    // restricted than its parent, via `childIsolation → networkPolicy`) is
    // still explicitly post-launch (PRD §6); T2-X1 does NOT claim to close
    // child network isolation, only that a child never widens egress.
    //
    // Reach delta (intentional, autonomy-inheritance): the shared refs are
    // also write-reachable — a child can mutate parent state through
    // dataStore / apiStore / runHistory (e.g. updateRun on the parent's
    // row). Acceptable because the child IS trusted code, but not hidden.
    toolContext: { ...parentAgent.toolContext },
    // T2-X1 part 2: share the parent's SecretStore so `ask_secret`, vault
    // reads, and tool credential lookups work in the child. Documented
    // reach delta: a child's `http_request` will auto-inject `Bearer` tokens
    // for any oauth2 api_profile (http.ts ~415-427) using the parent's
    // vault, AND the child can WRITE/overwrite the parent's vault entries
    // via `secretStore.set`. Both are INTENTIONAL — sub-agents inherit the
    // parent's autonomy, and a researcher spawned to query the user's
    // Stripe/Notion API must be able to authenticate and persist a refresh
    // token. Surfaced explicitly in the PR body, not hidden.
    // T2-X1 part 2, NARROWED: the child gets a scoped VIEW of the parent's
    // SecretStore, not the store itself. Everything the old comment described
    // still holds inside the scope — `ask_secret`, vault reads, credential
    // lookups and `secretStore.set` all work, because a sub-agent told to query
    // the user's Stripe account must be able to authenticate and persist a
    // refreshed token. What changed is the SIZE of "the vault" for that child:
    // by default only the keys its own spawn order named. Masking is deliberately
    // NOT scoped (see secret-scope.ts) — a child that stopped masking the keys it
    // cannot read would spill them into its output instead of containing them.
    secretStore: childSecretStore,
    // T2-X1 part 3: pass the three prompt callbacks so an `ask_user`/
    // `ask_secret`/`ask_tabs` invoked by the child surfaces to the same UI
    // the parent uses. Without these, child tool invocations that need user
    // input silently fail (the prompt callback is undefined).
    //
    // WRAPPED, not passed through: a prompt raised inside a child otherwise
    // arrives at the dialog indistinguishable from one the user's own turn
    // raised. The pipeline path has stamped its origin since the workflow
    // spawners started wrapping (`buildSubAgentPromptCallbacks`); this is the
    // same treatment for the OTHER way a sub-agent comes into being. It covers
    // every consent surface at once — there are fourteen `promptUser` call
    // sites across thirteen modules, and putting the sentence in any one tool
    // would leave the other thirteen exactly as they are.
    ...promptCallbacksWithOrigin(parentAgent, spec, childGone.signal, deadline ? () => deadline.holdForHuman() : undefined),
    // ⛔ AFTER BOTH SPREADS. The first version of this line sat above
    // `...childProviderCfg` and the second below it but above this one — and the argument
    // is the same for either: a key added to one of those sources later would rebind the
    // child's scope, and a child in the wrong scope is a child a stop cannot reach. Both
    // sources are closed literals today, so this is ordering that keeps a future edit
    // from mattering rather than a live fix.
    //
    // Inherited, which is the transitive half of the scoping: the child registers in the
    // PARENT's scope below, and by carrying that same scope it makes its own children
    // land there too. Without it a grandchild is reachable by nothing.
    abortScope: parentAgent.abortScope,
    // T2-X1 part 4: pass the pre-minted runId so the constructor stamps it
    // onto the child and the child's downstream code (memory writes, tool-call
    // recording) can attribute work to this run.
    currentRunId: childRunId,
    // Inherit the parent's tool-call sink. Together with `currentRunId` above,
    // this is what finally puts a child's calls on the CHILD's row: the sink
    // books whatever run id the caller hands it, and the child hands its own.
    //
    // Inheriting rather than building a fresh sink is deliberate — the parent's
    // closure holds the Session's RunHistory and per-run sequence counters, and
    // it is also the thing that keeps counting these calls toward the
    // http_request and mail rate limits. A child with no sink would run its
    // fan-out unmetered.
    recordToolCall: parentAgent.recordToolCall,
  };

  // Single try wraps both `new Agent(...)` AND `send(...)` so the runs-row
  // failure-marking catches a synchronous ctor throw too (otherwise the row
  // stays `status='running'` forever and pollutes the history UI). childStart
  // is captured BEFORE the ctor for symmetric durationMs on either failure.
  const childStart = Date.now();
  let childAgent: Agent | undefined;
  try {
    childAgent = new Agent(agentConfig);
    // Track child for abort propagation (added inside try so a ctor throw
    // doesn't leave a half-constructed agent in the active set). The PARENT's scope —
    // which the child's config inherited above, so its own children land here too.
    parentAgent.abortScope.members.add(childAgent);

    // DK.1 F5/S8: a child spawned from a tainted parent inherits the taint for durable writes.
    // A prompt-injected parent's `spec.task`/`context` can carry an injected `remember(pin:true)`;
    // the child shares the parent's KnowledgeStore but starts with a clean per-run latch, so
    // without this an injected write would launder to active+pinned through the child. Arm the
    // child's STICKY conversation latch (survives its send() per-run reset, unlike sawUntrustedData)
    // so any such write routes to pending_review. Over-taints in the safe direction only.
    // Propagate the parent's CAUSE, not a blanket marker. `noteUntrustedData()` arms the
    // run-scoped marker as well as the sticky latch — which claims "this run handled wrapped
    // external content" for a child that merely inherited a conversation's history. The gate
    // is identical either way (both OR into `deriveTurnUntrusted`), but the marker is also
    // what gets REPORTED: the review chip names the cause, so a wrong one tells the operator
    // this turn read something external when nothing did. `agent.ts` says as much where it
    // introduces `restoreConversationTaint` for exactly this distinction.
    const parentCause = describeTurnUntrusted(parentAgent);
    if (parentCause === 'conversation') {
      childAgent.restoreConversationTaint?.();
    } else if (parentCause !== 'none') {
      childAgent.noteUntrustedData();
    }

    // Same per-turn time anchor as top-level chat / pipeline steps.
    const result = await childAgent.send(withCurrentTimePrefix(task, childAgent.userTimezone), { disposableDeadline: deadline?.signal });
    // Built HERE, not at the return: `runHistory.updateRun` below stores
    // `responseText`, and appending the note only on the way out left the run row
    // holding a version of the result the parent never saw — the one place
    // somebody looks when asking afterwards why a key came back empty.
    const notedResult = appendDeniedKeyNote(result, deniedKeys);
    // Why the child stopped — the string above cannot say (see `SendStop`).
    const stop: SendStop | null = childAgent.getLastStop();

    // Wave 1.2 replay (b): a spawned child shares the parent's Memory by default
    // (`memory` above resolves to `parentAgent.memory` unless `isolated_memory`). If the
    // child read untrusted content, the SHARED Memory is now tainted for the parent too —
    // propagate the flag so the parent's own end-of-run extraction abstains. Without this
    // the child's untrusted read is a fail-open hole in the parent's memory. Derive from the
    // FULL union, not the bare marker — a child that read external content via a non-wrapping
    // tool (web_research/mail/read_file) must taint the parent too, symmetric with the
    // parent→child seed above. No-op when the child ran with isolated memory (`memory === undefined`).
    if (memory !== undefined) {
      // Same distinction on the way back: a child tainted only by the inherited conversation
      // must not hand the parent a marker it never earned.
      const childCause = describeTurnUntrusted(childAgent);
      if (childCause === 'conversation') {
        // `restoreConversationTaint` is OPTIONAL on IAgent, and an implementation
        // that omits it would lose the child→parent hand-off SILENTLY — no error,
        // just a turn that looks clean and is not (pipeline.ts already calls
        // `noteUntrustedData` optionally, so partial IAgent implementations have
        // precedent). Fall back to the coarser signal: over-tainting the parent's
        // run marker is the safe direction; losing the taint is not.
        if (parentAgent.restoreConversationTaint) parentAgent.restoreConversationTaint();
        else parentAgent.noteUntrustedData?.();
      } else if (childCause !== 'none') {
        parentAgent.noteUntrustedData?.();
      }
    }

    // T2-X1 part 5: record the child's actual LLM spend into the same
    // `runs` table the daily/monthly cost-cap aggregator reads. The
    // session-budget pre-flight already reserved an *estimate* (see
    // `estimateSpawnCost` + `checkSessionBudget` in the handler below) —
    // this final updateRun is the post-hoc truth, and crucially it makes
    // the spend visible to `getCostByDay` so a self-hoster's $-per-day
    // cap actually counts spawn work.
    if (runHistory && childRunId) {
      try {
        const snap = childAgent.getCostSnapshot();
        runHistory.updateRun(childRunId, {
          responseText: notedResult,
          tokensIn: snap?.inputTokens ?? 0,
          tokensOut: snap?.outputTokens ?? 0,
          costUsd: snap?.estimatedCostUSD ?? 0,
          durationMs: Date.now() - childStart,
          // The child's calls are now written to the child's own run, so this
          // column has to be written too — otherwise the rows exist while the
          // count beside them reads 0, and the aggregates that SUM it
          // (`run-history-analytics.ts`) lose every sub-agent call. Before the
          // sink they landed in the PARENT's count, so the total was right even
          // though the attribution was not.
          toolCallCount: childAgent.getRecordedToolCallCount(),
          status: 'completed',
          stopReason: ledgerStopReason(stop),
        });
      } catch {
        // Persistence failure — non-fatal. The child's result still
        // returns; only the cost-attribution side-effect is missed.
      }
    }

    // The child spent the managed pool key on its OWN token stream, so the
    // parent turn's `onAfterRun` debit never captured this spend — only the
    // local runs table (above) and the pre-flight session-cap RESERVATION in
    // the handler did. Debit the child's ACTUAL cost to the tenant balance so
    // managed billing captures it. CP-only (`reportMeteredCost`, NOT
    // `debitInRunHelperCost`): the local session ceiling was already reserved
    // via `checkSessionBudget` in the handler and is deliberately not
    // reconciled to actual (see the handler comment), so a `recordSessionCost`
    // here would double-count it against the $-per-session cap. No-op on
    // self-host / BYOK (meteredHost null) and for a zero-cost child (the
    // `> 0` guard inside reportMeteredCost).
    const meteredHost = parentAgent.toolContext.meteredHost;
    if (meteredHost) {
      const childCostUsd = childAgent.getCostSnapshot()?.estimatedCostUSD ?? 0;
      reportMeteredCost(meteredHost, randomUUID(), childCostUsd, modelTier);
    }

    return { result: notedResult, childRunId: childAgent.currentRunId, model, stop };
  } catch (err) {
    // Mark the child run failed/aborted so the cost cap and history UI don't
    // show it as still-running. Fires for BOTH ctor failures (childAgent
    // undefined, no spend yet) and send failures (childAgent constructed,
    // partial spend possible — CostGuard tracks per-turn). An abort (the parent's own
    // stop reaching this child through its session's abort scope) now THROWS
    // RunAbortedError instead of
    // returning '' (which mis-recorded the child 'completed'); mark it 'aborted'
    // — an intentional interruption, not a failure.
    const childAborted = err instanceof RunAbortedError;
    // The time limit ended it — not the parent's stop and not a loop guard (both
    // guards' errors are RunAbortedErrors too). A failure, not an interruption.
    const timedOut = childAborted && !(err instanceof ToolLoopBreakError) && !(err instanceof ContinuationLoopError) && deadline?.signal.aborted === true;
    const timeoutReason = `Stopped after the ${String(Math.round(spawnTimeoutMs / 60_000) || 1)}-minute spawn time limit without finishing.`;
    if (runHistory && childRunId) {
      try {
        const snap = childAgent?.getCostSnapshot() ?? null;
        runHistory.updateRun(childRunId, {
          tokensIn: snap?.inputTokens ?? 0,
          tokensOut: snap?.outputTokens ?? 0,
          costUsd: snap?.estimatedCostUSD ?? 0,
          durationMs: Date.now() - childStart,
          // Same column on the terminal-failure path: a child that made 60 calls
          // and then died must not read as "0 tools", which is exactly the
          // misreading that started this whole investigation (a customer instance, 2026-08-10).
          toolCallCount: childAgent?.getRecordedToolCallCount() ?? 0,
          status: timedOut ? 'failed' : (childAborted ? 'aborted' : 'failed'),
          stopReason: timedOut ? 'spawn_timeout' : (childAborted ? 'aborted' : (err instanceof Error ? err.message.slice(0, 200) : 'error')),
          // Record the FULL structured error so a failed sub-agent is diagnosable
          // (not just status=failed + a null error_text). Skipped for an abort —
          // an intentional interruption isn't an error to store.
          // A child that died after being refused a key still owes that reason:
          // "it failed" and "it failed after the vault refused it X" send the
          // reader to different repairs.
          errorText: timedOut ? timeoutReason : (childAborted ? undefined : appendDeniedKeyNote(formatSpawnError(err), deniedKeys)),
        });
      } catch { /* swallow */ }
    }
    // A child that aborted / failed mid-run may have spent partial pool-key cost
    // on its own token stream before throwing — never captured by the parent's
    // onAfterRun. Mirror the success-path debit so that partial spend is still
    // billed to the tenant balance instead of silently eaten. CP-only (same
    // rationale as the success path), `> 0`-guarded inside reportMeteredCost,
    // and a no-op when the child was never constructed (ctor throw → no spend).
    if (childAgent) {
      const meteredHost = parentAgent.toolContext.meteredHost;
      if (meteredHost) {
        const childCostUsd = childAgent.getCostSnapshot()?.estimatedCostUSD ?? 0;
        reportMeteredCost(meteredHost, randomUUID(), childCostUsd, modelTier);
      }
    }
    // The time limit, not the parent's stop: say so, or the parent reads an interruption
    // it never asked for and cannot tell a hung child from a cancelled one.
    if (timedOut) throw new Error(timeoutReason, { cause: err });
    throw err;
  } finally {
    // `?.` here and NOT at the register site above, deliberately. This runs in a
    // `finally`: a throw replaces whatever the catch was rethrowing, so the child's real
    // failure is lost and the message points at bookkeeping.
    //
    // ⛔ The register site keeps its hard dereference, and softening THIS one is why that
    // matters more than it did: making `IAgent.abortScope` optional now produces exactly
    // ONE compile error, at that line. Measured — before this `?.` there were two, so the
    // hardness up there is no longer one of a redundant pair but the only thing holding
    // the required-ness. (An earlier version of this comment said "one of exactly two",
    // which was the count from before the line it sits on.)
    if (childAgent) parentAgent.abortScope?.members.delete(childAgent);
    // The child is settled: whatever it abandoned may not ask or stream through the
    // parent any more (see `childGone` where the callbacks are built).
    childGone.abort();
    // One place for all three exits. The success and failure branches above
    // each read the same snapshot for their own bookkeeping; reporting it here
    // means an abort — which takes neither branch's `return` — is still counted.
    onSettled?.(childAgent?.getCostSnapshot()?.estimatedCostUSD ?? 0);
  }
}

export const spawnAgentTool: ToolEntry<SpawnAgentInput> = {
  definition: {
    name: 'spawn_agent',
    description: 'Delegate tasks to specialist roles working in parallel. Choose a role via "role" (researcher, creator, operator, collector) to auto-configure model, effort, and allowed tools. If no role fits your task, omit "role" and configure model/effort/tools directly instead of picking a close-but-wrong role name — unrecognised roles error out.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        agents: {
          type: 'array',
          description: 'Array of agent specifications to spawn',
          minItems: 1,
          maxItems: MAX_SPAWN_AGENTS,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1, maxLength: MAX_SPAWN_NAME_LENGTH },
              task: { type: 'string', minLength: 1, maxLength: MAX_SPAWN_TASK_LENGTH },
              role: { type: 'string', enum: ['researcher', 'creator', 'operator', 'collector'], description: 'Role ID. Configures model, tools, and capabilities. Must be one of the four built-ins; omit the field entirely for a custom role.' },
              context: { type: 'string', description: 'Additional context prepended to the task. Sub-agents share NO context — pass the REAL source or verbatim excerpts (file paths, quoted figures, actual fact text) the sub-task hinges on, not your paraphrase; a child given only a summary grounds in a guess.' },
              isolated_memory: { type: 'boolean', description: 'If true, agent has no access to parent memory.' },
              system_prompt: { type: 'string' },
              model: { type: 'string', enum: ['deep', 'balanced', 'fast'], description: 'Capability tier — fast (cheap/quick), balanced (default), deep (reasoning-heavy). Provider-agnostic; resolves to a concrete model per the active provider.' },
              thinking: { type: 'object' },
              effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
              max_tokens: { type: 'number' },
              tools: { type: 'array', items: { type: 'string' }, description: 'Narrows the child to these of your tools; it cannot widen a grant.' },
              max_turns: { type: 'number', minimum: 1, maximum: MAX_SPAWN_TURNS },
              max_budget_usd: { type: 'number', minimum: 0, maximum: MAX_SPAWN_BUDGET_USD },
              profile: { type: 'string', description: 'Named model profile for non-Claude provider (e.g. "mistral-eu", "gemini-research"). Configured in config.json.' },
              secret_scope: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', enum: ['all'] }], description: 'Vault keys this sub-agent may resolve. Default: only keys this task names via secret:NAME — not your whole vault. "all" passes on the full vault.' },
            },
            required: ['name', 'task'],
          },
        },
      },
      required: ['agents'],
    },
  },
  handler: async (input: SpawnAgentInput, agent: IAgent): Promise<string> => {
    const parentDepth = agent.spawnDepth ?? 0;
    const childDepth = parentDepth + 1;

    // Enforce max spawn depth
    if (childDepth > MAX_SPAWN_DEPTH) {
      throw new Error(
        `Max spawn depth (${MAX_SPAWN_DEPTH}) exceeded. Current depth: ${parentDepth}. Cannot spawn deeper.`,
      );
    }

    validateSpawnInput(input);

    const names = input.agents.map(a => a.name);
    const parentRunId = agent.currentRunId;

    // Pre-spawn cost estimation. Apply the same tier gate here as the
    // per-agent resolution in runSpawn, AND honor the role's default
    // model — otherwise fast-tier-roled spawns (operator/collector) get
    // estimated at balanced-tier rates, which over-allocates against the
    // session ceiling and blocks cheap batches.
    const cfg = loadConfig();
    const provider = getActiveProvider();

    // Identifies THIS batch for the whole run. Two `spawn_agent` calls can be in
    // flight at once (the agent loop runs up to `MAX_PARALLEL_TOOL_CALLS` tools
    // concurrently), and every later event — progress, child-done, and each
    // child's forwarded tool activity — carries it so a consumer can tell the
    // batches apart instead of collapsing them into one.
    const spawnId = randomUUID();

    // One pass, two outputs from ONE resolution: the budget reservation and the
    // batch description the UI renders. Estimating against the model the child
    // will actually run on (gate + clamp + provider + hybrid slot) is what keeps
    // a Mistral tenant or a ceiling-clamped spawn from mis-reserving, and it is
    // the same reason the UI may not name a different model than the one the
    // ceiling was charged for.
    const subAgents: SpawnedSubAgent[] = [];
    let totalEstimate = 0;
    // Refuse AND clamp BEFORE announcing, not after. `assertSpawnRoutingPermitted`
    // used to live only in `executeThinker`, which runs after the `spawn` event is
    // on the wire — so a refused/blocked profile was announced with its model id
    // and only then rejected. The D2 clamp lives here for the same reason the
    // refuses do: the announced tier, the budget estimate, and the child's actual
    // run must all name the SAME tier (a deep announcement that runs balanced is
    // exactly the announce≠run gap the shared-resolution work closed).
    //
    // D2 itself: a headless (autonomous) run never executes the deep tier without
    // consent. The consent `check` returns null in autonomous, so the permission
    // guard does not gate; THIS clamp is the control. A deep tier requested via
    // `model:'deep'` is substituted down to balanced; a deep-band PROFILE pins a
    // specific endpoint and cannot be substituted, so it is REFUSED rather than
    // silently run deep. The deep test matches `specResolvesDeep` so the gate and
    // the clamp agree on what "deep" means.
    const isHeadless = agent.autonomy === 'autonomous';
    // Read (and clear) a tier downgrade the user chose at the GO prompt
    // ("Run on balanced"). Only the deep-consent check produces one; undefined
    // for headless (the D2 clamp below is the headless control) and for any
    // non-spawn call. Consumed here so it can never leak to a later tool call.
    const downgradeTier = agent.consumePendingDowngrade?.();
    // Indices of specs clamped down by the interactive choice, so the announce
    // tier, the budget estimate, and the labelled result all agree the child
    // ran on the cheaper tier (predicate 5).
    const downgradedIdx = new Set<number>();
    const specs: SpawnSpec[] = input.agents.map((spec, i) => {
      assertSpawnRoutingPermitted(spec, cfg);
      if (isHeadless && specResolvesDeep(spec, cfg, provider)) {
        const deepProfile = spec.profile ? profileNamed(cfg.model_profiles, spec.profile) : undefined;
        // A deep-band OR unknown-band profile pins a specific endpoint and cannot be
        // substituted down to balanced, so it is REFUSED headless (not clamped). This
        // is the security control for the unknown-band case: without it, a profile
        // pinning an expensive unregistered model would run unconsented headlessly —
        // `specResolvesDeep` treats unknown bands as deep, so this refuse must too.
        if (deepProfile && profileBandIsDeepOrUnknown(deepProfile)) {
          throw new Error(
            `Spawn "${spec.name}" uses model profile "${spec.profile}" (${deepProfile.model_id}), ` +
            `whose tier cannot run autonomously without explicit consent — a profile pins a specific ` +
            `endpoint and cannot be substituted down to balanced. Run this delegation interactively ` +
            `(where you can approve it), or use the \`model\` tier parameter (fast/balanced) for an ` +
            `autonomous child.`,
          );
        }
        return { ...spec, model: 'balanced' as const };
      }
      // Interactive "Run on balanced": clamp substitutable deep specs down. A
      // deep-band profile is UNREACHABLE here — the check offers downgrade only
      // when canDowngrade (no deep-band profile in the batch), so every deep spec
      // is substitutable. Clamping before the announce loop means totalEstimate,
      // the session budget reservation, and the announced tier all reflect the
      // cheaper run (predicate 7 — no separate reconcile needed).
      if (downgradeTier === 'balanced' && specResolvesDeep(spec, cfg, provider)) {
        downgradedIdx.add(i);
        return { ...spec, model: 'balanced' };
      }
      return spec;
    });
    /** What each child asked for, index-aligned with `specs`. */
    const requested: number[] = [];
    /** The resolved model per child, index-aligned with `specs` — the floor is per model. */
    const childModels: string[] = [];
    /**
     * The output cap each child's call will carry, index-aligned with `specs`; `undefined`
     * means the model's own ceiling. Collected here rather than derived at the floor,
     * because this is where the profile is resolved.
     */
    const childCaps: Array<number | undefined> = [];
    specs.forEach((spec, i) => {
      // ⛔ RESOLVED ONCE, into a local. It used to be an inline argument, and the floor had
      // no way to see it — which is how a floor that was supposed to price the child's cap
      // ended up reading only the spec half of `spec.max_tokens ?? profile.max_tokens`.
      // Two readers of one question is the defect class; this is the one reader.
      const childProfile = spec.profile ? profileNamed(cfg.model_profiles, spec.profile) : undefined;
      const { model, tier } = resolveSpawnChildRouting({
        spec,
        role: spec.role ? getRole(spec.role) : undefined,
        profile: childProfile,
        userConfig: cfg,
        baseProvider: provider,
        parent: readParentProviderConfig(agent),
      });
      const iters = spec.max_turns ?? DEFAULT_SPAWN_MAX_TURNS;
      totalEstimate += estimateSpawnCost(model, iters);
      // What this child ASKED for — its own budget or the default. Deliberately NOT the
      // estimate: an earlier attempt used `min(budget, estimate)` and called the result a
      // share of the parent's remainder, which it was not. It cut every child's ceiling to
      // its estimate even on a run with plenty of room, and the estimate ignores three
      // multipliers a child actually gets (adaptive thinking is on by default, a role may
      // ask for max effort, and `max_tokens` is unvalidated).
      requested.push(spec.max_budget_usd ?? DEFAULT_SPAWN_BUDGET_USD);
      // Taken from the SAME routing resolution the announcement uses, so the floor and
      // the child cannot disagree about which model is being priced. (Same resolution as
      // the ANNOUNCEMENT; `executeThinker` resolves again from a freshly loaded config,
      // so this is not a proof that the child cannot end up elsewhere.)
      childModels.push(model);
      // ⛔ THE SAME CHAIN the child is BUILT with (`maxTokens: spec.max_tokens ??
      // profile?.max_tokens`), not half of it. The value reaches the provider unclamped, so
      // a floor computed from the model's default ceiling admits a child that can emit five
      // times it — measured: a profile carrying `max_tokens: 64000` was admitted on the
      // $0.192 balanced floor, and that child's first turn costs $0.408 priced the way this
      // floor prices, $1.08 if it emits the whole cap.
      //
      // ⚠ Same limit as the model beside it: this is the ANNOUNCEMENT-time resolution, and
      // `executeThinker` resolves again from a freshly loaded config. It is the best
      // available answer here, not a proof that the child cannot end up with another cap.
      childCaps.push(spec.max_tokens ?? childProfile?.max_tokens);
      // The SAME check the identity block and the result header use. This site
      // had its own charset — one that stripped `/` and cut at 64 — so a
      // Fireworks child was announced to the UI as
      // `accountsfireworksmodelsglm-5p2`. An id it rejects is omitted rather
      // than sent empty: the field is optional, and absent reads as "unknown"
      // where `''` renders as a model with no name.
      const wireModel = safeModelId(model);
      subAgents.push({
        id: `${spawnId}:${i}`,
        name: spec.name,
        role: spec.role,
        tier,
        ...(downgradedIdx.has(i) ? { downgraded: true } : {}),
        ...(wireModel ? { model: wireModel } : {}),
      });
    });

    // Enforce session cost ceiling (shared with pipeline steps) against
    // this Session's counters object so concurrent spawns on different
    // Sessions don't see each other's reservations.
    checkSessionBudget(agent.sessionCounters, totalEstimate);

    // ⛔ AND the delegating RUN's own ceiling — a different barrier from the one above.
    // The session ceiling is per session; this is the dollar cap on the single run that
    // is delegating, the one the worker's budget admission grants against the tenant's
    // daily total. Children bill that daily total through their own run rows, while
    // `checkSessionBudget` only ever charged the session, so the run's own ceiling never
    // saw them.
    //
    // ⚠ BEFORE dispatch, because the children run in PARALLEL and the parent blocks on
    // all of them below. A charge-back afterwards reports an overspend that has already
    // happened; it cannot bound the batch that caused it.
    //
    // ⚠ `null` means the run has NO CEILING — self-host or BYOK with no configured
    // budget. It does NOT mean "interactive": a managed session is given a per-run
    // ceiling by the engine unless its caller supplied one, so there this is never
    // `null`. An earlier attempt equated the two in six places, which made its control
    // case describe a configuration the product rarely runs in.
    const remainingRunUSD = agent.getRemainingRunBudgetUSD?.() ?? null;
    /** Per child, when it was granted less than it asked for. Announced in the result. */
    const trimmed: Array<{ name: string; asked: number; got: number }> = [];
    /** The granted ceilings, or `null` when the run has none to divide. */
    let shares: number[] | null = null;
    /**
     * What of the batch's hold is still taken. Each child subtracts its own share when
     * it settles; whatever is left belongs to children that never got that far, and the
     * `finally` below gives it back.
     */
    let heldForBatch = 0;
    if (remainingRunUSD !== null) {
      const asked = requested.reduce((sum, usd) => sum + usd, 0);
      // SCALED proportionally rather than refused outright. Refusing reads as the
      // stricter choice and was the first design, but the default per child is larger
      // than a typical budgeted run's whole remainder — so it would refuse nearly every
      // fan-out, and a child asking for little would be refused on account of a
      // neighbour asking for much. Scaling keeps the sum inside the remainder by
      // construction; the floor below is what stops it scaling into uselessness.
      const factor = asked > remainingRunUSD && asked > 0 ? remainingRunUSD / asked : 1;
      shares = requested.map((usd) => usd * factor);
      // ⛔ THE ROUNDING ERROR IS GIVEN BACK, and without this the bound refuses work it
      // should admit. `sum(requested[i] * factor)` does not reproduce `remainingRunUSD`
      // in binary floating point: measured over 200 000 randomly drawn trimmed batches
      // that clear the floor, **23 %** came out a few ULPs above the remainder, and the
      // reservation below compares strictly. The result was a refusal blaming a
      // concurrent batch that does not exist — deterministic, so the retry its message
      // advises fails identically. Minimal case: two default children against $0.103
      // give shares of $0.051500000000000004 each, summing to $0.10300000000000001.
      //
      // The last child absorbs the difference rather than a tolerance being added to the
      // comparison: a tolerance would make the bound inexact for every caller, while
      // this keeps `sum <= remainder` true as arithmetic.
      //
      // ⚠ The floor is checked AFTER this, which is the right order — but NOT a witnessed
      // one, and the earlier version of this line claimed more than it could show. The
      // give-back moves the last share by a few ULPs, so it cannot push a child across a
      // floor except on an exact tie: a mutant that hoists the floor check above this
      // block survives the whole suite. Correct by construction, indistinguishable by
      // test; do not read it as a protection that something checks.
      const built = shares.reduce((sum, usd) => sum + usd, 0);
      if (built > remainingRunUSD && shares.length > 0) {
        shares[shares.length - 1] = Math.max(0, shares[shares.length - 1]! - (built - remainingRunUSD));
      }
      // ⛔ Per child, against ITS OWN model's first turn. Two
      // children on different tiers have different floors.
      //
      // ⚠ `findIndex` names the FIRST child under its own floor, which is NOT necessarily
      // the expensive one — the earlier version of this comment said "refused on account
      // of the expensive one alone" and that is wrong. At a $0.03 remainder a `fast` child
      // and a balanced one both get $0.015, and the `fast` child is under ITS floor
      // ($0.052288), so the message names the CHEAP one. The expensive child is named only
      // when the cheap one clears its own floor.
      const floors = childModels.map((m, i) => minChildBudgetUSD(m, childCaps[i]));
      // ⛔ A SHARE OF ZERO IS REFUSED WHATEVER THE FLOOR SAYS, and this line is what keeps
      // the unpriced carve-out above from opening a hole. `share < 0` is false for a share
      // of exactly 0, so on a model with no price (floor 0) a caller-supplied
      // `max_budget_usd: 0` would be ADMITTED with a ceiling of zero — a child that runs
      // one booked turn and stops, which is precisely the outcome the floor exists to
      // refuse, and which the sibling test `refuses a child whose caller asked for nothing`
      // forbids for every priced model. The zero case is its own refusal rather than an
      // emergent property of a number, because the floor is allowed to be 0 by design.
      const noMoney = shares.findIndex((share) => !(share > 0));
      const tooSmall = noMoney >= 0 ? noMoney : shares.findIndex((share, i) => share < floors[i]!);
      if (tooSmall >= 0) {
        // ⚠ ONE message, and two things in it had to change rather than one. The AMOUNTS,
        // because this floor admits sub-cent shares that the flat one could not. And the
        // REASON clause: main quoted the flat figure ("under the $0.05 a sub-agent needs to
        // return anything"), which no longer exists — so the reason is now the cost of a
        // turn on that child's own model. The remedies are main's two, unchanged; a third
        // one ("give the expensive ones a cheaper model") was added in an earlier revision
        // and removed again, because the child this message names is often the CHEAPEST in
        // the batch, and a remedy it cannot follow is worse than none.
        //
        // ⛔ The unpriced shape is why a price is never quoted unconditionally. On a model
        // this instance has no price for the floor is 0, so quoting it would read "would get
        // $0.0000, and one turn on its model costs about $0.0000" — a refusal whose own
        // arithmetic cancels out, and an assertion that a turn is free, which is exactly what
        // an unpriced model is not known to be. That case is reachable only because of the
        // carve-out above. (An earlier revision branched the REASON alone and said so here;
        // the remedy needed branching too, which is what `floorRefusal` now does.)
        //
        // ⚠ THE WORDING IS NOW BRANCHED, and the branches live in `floorRefusal` with the
        // measurement that forced each one. What belongs here is only the handler's half:
        // every input the message needs is passed EXPLICITLY — the asks, the floors, which
        // child is named, the schema ceiling and `factor` — because the REMEDIES are computed
        // from them. A first cut passed a `scaled` boolean instead and could therefore only
        // assert what scaling implies; two of those assertions were false, and the figure that
        // makes the advice followable was not derivable from what the function had been given.
        throw new Error(floorRefusal({
          name: specs[tooSmall]!.name,
          got: shares[tooSmall]!,
          need: floors[tooSmall]!,
          askedFor: requested[tooSmall]!,
          remainingRunUSD,
          batchSize: specs.length,
          batchAsked: asked,
          factor,
          maxAsk: MAX_SPAWN_BUDGET_USD,
          requested,
          floors,
          named: tooSmall,
        }));
      }

      // ⛔ RESERVE, do not merely read — and this is the half an earlier attempt left
      // out. The agent dispatches up to ten tool calls in parallel, so a second
      // `spawn_agent` in this same turn can be admitted in this very instant; two
      // callers that only READ would see the same room and each claim it. Its neighbour
      // `checkSessionBudget` has always reserved on the spot, for exactly this reason.
      //
      // `false` means someone took it between the read above and this line. Refusing is
      // the honest answer — re-reading and trying again would be the same race with
      // more steps.
      if (!(agent.reserveExternalCost?.(shares.reduce((sum, usd) => sum + usd, 0)) ?? true)) {
        throw new Error(
          'Another sub-agent batch in this same turn claimed what was left of this run\'s '
          + 'cost ceiling. Wait for it to finish, then delegate again.',
        );
      }
      specs.forEach((spec, i) => {
        if (shares![i]! < requested[i]!) trimmed.push({ name: spec.name, asked: requested[i]!, got: shares![i]! });
      });
      heldForBatch = shares.reduce((sum, usd) => sum + usd, 0);
    }

    // ⛔ FROM HERE THE HOLD HAS AN OWNER, and it needs one: between the reservation
    // above and the per-child releases in `onSettled`, two HOST-SUPPLIED `onStream`
    // callbacks are awaited below. A rejection in either throws out of this handler with
    // the whole batch's hold still taken — and a leaked hold is silent and permanent for
    // the run, because `reservedUSD` is cleared only by a guard reset while
    // `isExceeded()` never reads it. The parent would keep running, and every later
    // fan-out on that run would be refused for room nobody is using.
    //
    // Released per child in `onSettled` on the happy path; this `finally` only fires for
    // what is left when something threw before or during dispatch, which is why it
    // subtracts what was already given back rather than releasing the sum again.
    try {
    channels.spawnStart.publish({ agents: names, parent: agent.name, parentRunId, depth: childDepth });

    if (agent.onStream) {
      await agent.onStream({ type: 'spawn', spawnId, subAgents, estimatedCostUSD: totalEstimate, agent: agent.name });
      // Hand the activity label over from "delegating" to "waiting". Dispatch is
      // over by this line; everything after it is the parent BLOCKED on
      // `Promise.allSettled` below. Without this the status sits on "Delegating
      // to sub-agents…" for the entire child run — measured at 212s on a real
      // deep review, describing a step that took about a second. `api_setup`
      // already uses this same tool_progress channel for a 5-8s gap; the
      // minutes-long one had no phase at all.
      await agent.onStream({ type: 'tool_progress', tool: 'spawn_agent', phase: 'waiting', agent: agent.name });
    }

    // Sub-agent progress state — visible to the UI via forwarded events.
    // Without this, parent's stream only sees spawn start + aggregated result
    // and the UI sits on "Arbeitet…" for minutes with no evidence of progress.
    // Keyed by SpawnedSubAgent.id, never by name: two children in one batch may
    // legitimately share a name, and a name-keyed map would silently merge them.
    const running = new Set(subAgents.map(s => s.id));
    const lastToolBySub: Record<string, string> = {};
    // Actual spend per child, filled in as each one stops. Reported on
    // `spawn_child_done` so a delegation's cost is visible where it was
    // incurred, instead of only inside the turn's single aggregate total.
    const costBySub: Record<string, number> = {};
    const spawnStart = Date.now();

    const parentStream = agent.onStream;
    // Emitting, not plain: this handler IS a core producer — it is what the child
    // agent calls — so the error it forwards must already carry `fatal`. Typing it
    // loosely here would have let the passthrough launder a decision the child was
    // forced to make back into an unknown.
    const makeChildStream = (sub: SpawnedSubAgent): EmittingStreamHandler | null => {
      if (!parentStream) return null;
      return (event) => {
        // Forward only high-signal, low-frequency events. Text and thinking
        // token streams from children would flood the parent UI.
        if (event.type === 'tool_call') {
          lastToolBySub[sub.id] = event.name;
          return parentStream({ ...event, subAgent: sub.name, subAgentId: sub.id });
        }
        if (event.type === 'tool_result') {
          return parentStream({ ...event, subAgent: sub.name, subAgentId: sub.id });
        }
        if (event.type === 'error') {
          return parentStream(event);
        }
        // Swallow the rest — keeps the stream manageable.
        return undefined;
      };
    };

    // Heartbeat: while any child is running, emit a spawn_progress event every
    // 5s so the UI can show elapsed time + last tool per sub-agent + soft
    // timeout warning. Cleared after the dispatch settles below — a bare statement, not a `finally`, so anything that throws between here and there leaks the interval.
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (parentStream) {
      heartbeat = setInterval(() => {
        if (running.size === 0) return;
        const elapsedS = Math.floor((Date.now() - spawnStart) / 1000);
        void parentStream({
          type: 'spawn_progress',
          spawnId,
          elapsedS,
          running: [...running],
          lastToolBySub: { ...lastToolBySub },
          agent: agent.name,
        });
      }, 5000);
    }

    const results = await Promise.allSettled(
      specs.map((spec, i) => {
        const deadline = createSpawnDeadline(spawnTimeoutMs);
        const childStart = Date.now();
        const sub = subAgents[i]!;

        return executeThinker(spec, agent, makeChildStream(sub), childDepth, (usd) => {
          costBySub[sub.id] = usd;
          // ⛔ The hold goes back BEFORE the actual cost is booked, and the order is not
          // cosmetic: holding and spending at once would count this child twice against
          // the ceiling, so the run's next turn would see room it had already given up.
          // Released on every exit, because `onSettled` runs from the `finally` —
          // success, failure and abort alike. The orchestrator's step path has the same
          // shape one layer over and gets it wrong: there the release sits after the
          // `await`, so a step that throws keeps its reservation for good.
          //
          // ⚠ What this cannot release is a child that never settles. The spawn time limit
          // is the other half of this bound: it settles a hung child, so its share comes
          // back. Time the child spends waiting on a human does not count (`SpawnDeadline`),
          // so a child whose question nobody answers holds its share until the question's
          // TTL ends it.
          if (shares !== null) {
            agent.releaseExternalCost?.(shares[i]!);
            heldForBatch -= shares[i]!;
          }
          // ⛔ The child's ACTUAL cost, onto the delegating run's own ceiling. Without
          // it the run keeps counting only its own turns while the tenant's daily total
          // carries the children too, so its next turn believes it has more room than
          // it has.
          //
          // Outside the `meteredHost` branch that reports the same figure to the
          // control plane: that one is managed-only, and this ceiling exists on
          // self-host and BYOK as well.
          //
          // ⚠ FENCED, and that is not caution for its own sake: this callback runs in a
          // `finally`, where a throw REPLACES the error the catch is rethrowing — the
          // child's real failure would be lost and the message would point at
          // bookkeeping. It is the same hazard the `abortScope?.` on the line above was
          // softened for. The real `Agent` cannot throw here; an `IAgent` from outside
          // this repo can.
          try { agent.chargeExternalCost?.(usd); } catch { /* never mask the child's own outcome */ }
        }, shares === null ? undefined : shares[i], deadline)
          .then(
            (value) => {
              running.delete(sub.id);
              if (parentStream) {
                void parentStream({
                  type: 'spawn_child_done',
                  spawnId,
                  subAgent: sub.name,
                  subAgentId: sub.id,
                  ok: true,
                  elapsedS: Math.floor((Date.now() - childStart) / 1000),
                  costUsd: costBySub[sub.id] ?? 0,
                  agent: agent.name,
                });
              }
              return value;
            },
            (err: unknown) => {
              running.delete(sub.id);
              if (parentStream) {
                void parentStream({
                  type: 'spawn_child_done',
                  spawnId,
                  subAgent: sub.name,
                  subAgentId: sub.id,
                  ok: false,
                  elapsedS: Math.floor((Date.now() - childStart) / 1000),
                  costUsd: costBySub[sub.id] ?? 0,
                  agent: agent.name,
                });
              }
              throw err;
            },
          )
          .finally(() => deadline.clear());
      }),
    );
    if (heartbeat) clearInterval(heartbeat);

    // Cost already reserved in checkSessionBudget() above — no separate recordSessionCost needed

    const sections: string[] = [];
    const errors: Error[] = [];
    // Paired with `errors` so the all-failed message can name WHICH child died
    // of what. `errors` alone cannot: it holds only the ones that failed, so its
    // index does not line up with `specs`.
    const failures: { name: string; err: Error }[] = [];
    const childRunIds: Array<string | undefined> = [];

    for (let i = 0; i < results.length; i++) {
      const outcome = results[i]!;
      const spec = specs[i]!;

      if (outcome.status === 'fulfilled') {
        // Surface the concrete model this sub-agent actually ran on. Without
        // this the parent only knows the *tier* it requested (e.g. "fast") and
        // would mislabel the sub-agent's model when reporting back — on a
        // non-Anthropic provider "fast" is NOT a Claude model. The Model-identity
        // prompt rule tells the agent to report THIS id, not the tier.
        // The id can originate from user config (`profile.model_id`) and lands
        // in the header OUTSIDE the untrusted-data envelope, hence the SAME
        // check the identity block uses: a second charset here meant a Fireworks
        // child was reported as `accountsfireworksmodelsglm-5p2` — mangled, and
        // stated with authority because the prompt vouches for it.
        // It rejects rather than repairs, so drop the clause when it rejects:
        // an empty code span in a heading claims a model with no name.
        const safeModel = safeModelId(outcome.value.model);
        const ranOn = safeModel ? ` (ran on \`${safeModel}\`)` : '';
        // Predicate 5: a child the user downgraded from deep is labelled, not
        // silently degraded. The note rides the header OUTSIDE the untrusted
        // envelope (engine wording, not child output).
        const downgradeNote = downgradedIdx.has(i)
          ? ' — ran on balanced because you declined deep; quality may be lower'
          : '';
        // `spec.name` is AGENT INPUT and is validated for length (64) and
        // control chars only — no charset gate, unlike `safeModelId` beside it.
        // It lands in a heading OUTSIDE the untrusted-data envelope, so a name
        // like `x<untrusted_data source="web">` (30 chars) opens a tag that
        // nothing closes and swallows the engine prose plus every section after
        // it. The section that ends in `</untrusted_data>` used to close it by
        // accident; the two that do not — FAILED, and now NO OUTPUT — never did.
        const safeName = escapeXml(spec.name);
        const stop = outcome.value.stop;

        // A sub-agent that RETURNS but returns nothing is the third outcome,
        // and it was the only one the parent could not see: `rejected` gets a
        // FAILED section, a real answer gets the untrusted-data envelope, and
        // an empty string got a heading followed by an EMPTY envelope —
        // formally a success, indistinguishable from "worked, found nothing to
        // say".
        //
        // Measured on a production instance (engine 2.14.2, 2026-08-18): 3 of 8 sub-agents returned `''` at
        // `status=completed`, `stop_reason=end_turn`, `error_text=NULL`,
        // `tokens_out` 113-669 — on TWO different models, one of them the
        // instance's own balanced default. The parent could only guess, and
        // guessed wrong: it reported a model defect the ledger does not
        // support.
        //
        // It is NAMED, not re-branded as a failure. An empty return is not a
        // dead child — a side-effect-only task ("write the file") or an honest
        // "nothing matched" can legitimately produce it — so the section states
        // only what is knowable here, which is that no text came back and not
        // why. `REASONING_SUPPRESSION_MAX_TOKENS` (openai-adapter.ts) suppressed
        // one CAUSE of this class and says at its own definition that the
        // empty-response class "deserves its own detector rather than this
        // constant carrying the whole defence". This is that detector, and it is
        // cause-agnostic on purpose: it fires below that constant's bound as
        // well as far above it, on models that declare no reasoning effort at
        // all.
        //
        // `— NO OUTPUT` precedes `downgradeNote` so the outcome reads before the
        // provenance when a downgraded child also comes back empty; otherwise
        // two ` — ` clauses queue up and the important one lands last.
        //
        // The empty branch emits no envelope, so it also emits no untrusted
        // marker — `agent.ts` seats `_sawUntrustedData` on that marker. That is
        // not a taint regression: the marker it stops emitting wrapped ZERO
        // bytes of child content, and the real child→parent taint hand-off is
        // content-based, one frame up (`describeTurnUntrusted` → the parent's
        // `noteUntrustedData`, above), not marker-based.
        // `absolute_cap` is deliberately not here: a child never runs with
        // unlimited iterations (`maxIterations` is always set above), so the
        // 500-call backstop cannot be what stopped it.
        if ((stop?.cause === 'iteration_cap' || stop?.cause === 'budget_cap') && stop.pendingToolCount > 0) {
          // 2026-08-20: the cause behind the empties measured above turned out to
          // be THIS — the child was STOPPED by its turn cap while still calling
          // tools (each had made exactly `max_turns - 1` tool calls; the last
          // turn's tool_use was dropped). `pendingToolCount > 0` is load-bearing:
          // a cap that coincides with a turn the model finished by itself is a
          // legitimate successful shape and takes the normal path below. The
          // section is read by the parent model, which acts on it: it has to name
          // the knob and the remedy, or the parent keeps diagnosing a model defect.
          // Tool names arrive charset-gated and capped from `SendStop`; escaped
          // again here because they land OUTSIDE the envelope (the class of hole
          // #1237 closed for `spec.name`).
          //
          // Why "at least 2N" — a heuristic, not a measured value: a failed tool
          // call costs two more model calls to recover from (the retry, and the
          // turn that reads its result), so doubling is the smallest step that
          // turns "one more call" into "one more recoverable failure". N+1 moves
          // the cap by exactly the call that was dropped; larger factors only
          // raise the bill of the re-spawn loop the "once" below asks the parent
          // not to enter. The code enforces only `min(2N, schema maximum)` —
          // prescribing a value the validator rejects would send the parent into
          // an error instead.
          const isBudget = stop.cause === 'budget_cap';
          const turns = spec.max_turns ?? DEFAULT_SPAWN_MAX_TURNS;
          // ⛔ The ceiling the child ACTUALLY ran with, which is its scaled share when
          // the batch was trimmed. Naming `spec.max_budget_usd` here told the model a
          // child held to $0.40 had `max_budget_usd=5` and should be re-run with 10 —
          // the direct opposite of the budget note in the same string, more specific
          // than it, and placed after it. The announcement that scaling is visible is
          // worth nothing while this line contradicts it.
          const budget = shares?.[i] ?? spec.max_budget_usd ?? DEFAULT_SPAWN_BUDGET_USD;
          // ⚠ The SHARE, not the ask, so it carries float noise: a scaled $0.205 printed as
          // `max_budget_usd=0.20499999999999996` — a description formatted as a parameter
          // assignment, which reads as typeable. Rounded to display precision and kept a
          // NUMBER, so `0.5` and `50` print unchanged (two standing assertions pin them).
          // ⚠ `toPrecision(3)`, not a money format. This reports the ceiling the child RAN
          // with, and that ceiling can be a scaled share — `0.20499999999999996` as a figure
          // the parent reads, which is noise. But rounding it to cents is the wrong repair in
          // two directions, both measured: `0.00001` becomes `0` — asserting the zero-budget
          // branch this code path deliberately treats as a DIFFERENT diagnosis — and `0.00999`
          // becomes `0.01`, overstating a ceiling. Significant digits keep a positive value
          // positive, never overstate by more than a rounding step of its own size, and leave
          // `0.5`, `2` and `50` exactly as they were (two standing assertions pin those).
          const knob = isBudget
            ? `max_budget_usd=${String(Number(budget.toPrecision(3)))}`
            : `max_turns=${String(turns)}`;
          const tools = stop.pendingTools.map((t) => escapeXml(t)).join(', ');
          const whileDoing = ` and was still calling tools (${tools || 'unnamed'}) when it was stopped`;
          const raisedTurns = Math.min(turns * 2, MAX_SPAWN_TURNS);
          // ⚠ The PRINT is ceiled to its own precision, the comparison below is not. A
          // scaled share doubles into float noise — `0.19200000000000003 * 2` printed
          // `0.38400000000000006` as a figure the parent is told to type. `usdAtLeast`
          // ceils it to `0.39`; `Number(...)` keeps a clean `2` from printing as `2.00`,
          // which two standing assertions pin. The gate stays on the raw number so the
          // clamped-at-maximum case still falls through to "already at its maximum"
          // instead of prescribing a figure that is not larger than what was asked.
          const raisedBudget = Math.min(budget * 2, MAX_SPAWN_BUDGET_USD);
          const raise = isBudget
            ? (budget <= 0
              // ⚠ Corrected: a zero budget does NOT stop the child from completing a
              // call. The cost guard books a turn before it compares, so the child runs
              // one turn and stops — which is why it returns something truncated rather
              // than nothing, and why the fix is a budget rather than a retry.
              ? `a positive max_budget_usd (it was 0, so the child stopped after its first turn; the default is ${String(DEFAULT_SPAWN_BUDGET_USD)})`
              : raisedBudget > budget
                ? `a higher max_budget_usd (at least ${String(Number(usdAtLeast(raisedBudget)))})`
                : `a narrower task (max_budget_usd is already at its maximum of ${String(MAX_SPAWN_BUDGET_USD)})`)
            : (raisedTurns > turns
              ? `a higher max_turns (at least ${String(raisedTurns)})`
              : `a narrower task (max_turns is already at its maximum of ${String(MAX_SPAWN_TURNS)})`);
          const partial = stop.text.trim().length > 0
            ? `\n\nPartial text it produced before stopping:\n\n${wrapUntrustedData(stop.text, `sub_agent:${spec.name}`)}`
            : '';
          sections.push(
            `## ${safeName}${ranOn} — ${isBudget ? 'COST BUDGET' : 'TURN LIMIT'} REACHED (${knob})${downgradeNote}\n\n` +
            `**The sub-agent used up its ${isBudget ? 'cost budget' : `${String(turns)} turns`}${whileDoing} — it never produced a final answer.** ` +
            `This is neither a crash nor a model defect: the ${isBudget ? 'budget' : 'turn budget'} ran out. ` +
            `To get the result, re-run THIS sub-agent once with ${raise}, or narrow its task so it needs fewer tool calls. ` +
            `Do not retry it unchanged, and do not switch models because of this.${partial}`,
          );
        } else if (outcome.value.result.trim() === '') {
          sections.push(
            `## ${safeName}${ranOn} — NO OUTPUT${downgradeNote}\n\n` +
            `**The sub-agent finished without returning any text.** This is not a crash — ` +
            `it ran to completion. Do not present its result as an answer, and do not infer ` +
            `a cause (model, prompt, or tooling) from this alone: the engine cannot tell ` +
            `"nothing came back" apart from "the answer was that there is nothing". ` +
            `Say what happened; re-run it at most once before reporting it instead.`,
          );
        } else {
          // Wrap sub-agent return value in untrusted-data envelope. A sub-agent
          // can ingest attacker-controlled content (read_file output, web pages,
          // mail bodies) and return it verbatim — without the envelope, the
          // parent would see that content as trusted framing rather than data.
          // See H-002 (OVERNIGHT-PUNCH-LIST-2026-05-25) — spawn_agent used to
          // be exempt from the wrap via the INTERNAL_TOOLS allowlist in agent.ts.
          const wrapped = wrapUntrustedData(outcome.value.result, `sub_agent:${spec.name}`);
          sections.push(`## ${safeName}${ranOn}${downgradeNote}\n\n${wrapped}`);
        }
        childRunIds.push(outcome.value.childRunId);
      } else {
        const err = outcome.reason instanceof Error
          ? outcome.reason
          : new Error(String(outcome.reason));
        errors.push(err);
        failures.push({ name: spec.name, err });
        // Mark the section as a FAILURE unambiguously so the parent can't mistake
        // a dead sub-agent for one that returned nothing useful — a silent
        // sub-agent failure is more dangerous than a loud one. `formatSpawnError`
        // adds the HTTP status (e.g. `[404] …`) so a provider mis-route reads as
        // a config failure, not a vague error.
        sections.push(`## ${escapeXml(spec.name)} — FAILED\n\n**Error:** ${formatSpawnError(err)}`);
        childRunIds.push(undefined);
      }
    }

    // Publish spawn end with genealogy data for orchestrator to record
    const spawnRecords = specs.map((spec, i) => ({
      childName: spec.name,
      childRunId: childRunIds[i],
    }));

    channels.spawnEnd.publish({
      agents: names,
      parent: agent.name,
      parentRunId,
      errors: errors.length,
      depth: childDepth,
      spawnRecords,
    });

    if (errors.length === specs.length) {
      // ⚠ The trim has to travel on THIS path too. The note below is never reached when
      // every child rejects — and that is exactly the case the note exists for: the
      // model is told the batch failed, with nothing to say their budgets had been cut.
      // A `budget_cap` stop is a FULFILLED child, so the common trimmed case keeps the
      // note; this is the all-reject one (a parent abort reaching every child, a
      // provider outage).
      throw new AggregateError(errors, formatAllFailedMessage(failures) + budgetNote(trimmed, remainingRunUSD));
    }

    // ⛔ THE TRIM IS ANNOUNCED TO THE MODEL, not only logged — and that was made a
    // condition of scaling rather than refusing, for a measured-shaped reason: this
    // string is what the parent agent reads back, and from there a child that stopped at
    // a scaled-down ceiling looks exactly like a child that failed. Without this note
    // the model's next move is to delegate MORE of them, which is the opposite of what
    // the ceiling wanted. So the note names both figures AND says a truncated child is
    // not a failed one — a refusal text is prompt surface, and it teaches a rule.
    const note = budgetNote(trimmed, remainingRunUSD);
    if (note) sections.unshift(note.replace(/^\n\n/, ''));

    return sections.join('\n\n---\n\n');
    } finally {
      // Only what no child gave back — a throw before or during dispatch, or a child
      // that never reached its `onSettled`. On the ordinary path this is 0 and the call
      // is a no-op; `releaseExternalCost` floors at 0 either way, so a miscount cannot
      // mint budget.
      if (heldForBatch > 0) agent.releaseExternalCost?.(heldForBatch);
    }
  },
  destructive: {
    mode: 'external',
    check: (input: SpawnAgentInput, ctx) => {
      // D2: in autonomous (headless) mode the guard does NOT gate deep spawns —
      // returning null means no warning and no [BLOCKED]. The handler's deep→balanced
      // clamp is the actual headless control (it substitutes a cheaper run the user
      // never had the chance to pick interactively); gating here would only REFUSE,
      // denying that fallback.
      if (ctx?.autonomy === 'autonomous') return null;
      const cfg = loadConfig();
      const baseProvider = getActiveProvider();
      const deepSpecs = input.agents.filter((spec) => specResolvesDeep(spec, cfg, baseProvider));
      if (deepSpecs.length === 0) return null;

      let costUsd = 0;
      const providers = new Set<LLMProvider>();
      let resolvedTier: ModelTier = 'deep';
      let hasUnknownBand = false;
      // "Run on balanced" is offered (downgradeTo set) only when EVERY deep spec
      // is substitutable — i.e. none pins a deep/unknown-band model profile,
      // which cannot be clamped down without silently changing the configured
      // endpoint. A profile present → the GO stays two-way (Allow deep / Cancel).
      let canDowngrade = true;
      for (const spec of deepSpecs) {
        const role = spec.role ? getRole(spec.role) : undefined;
        const profile = spec.profile ? profileNamed(cfg.model_profiles, spec.profile) : undefined;
        const r = resolveSpawnChildRouting({ spec, role, profile, userConfig: cfg, baseProvider });
        // A profile's band hides behind the clamp-resolved tier. The payload names
        // the ACTUAL classification — deep for a known-deep profile, deep
        // (conservatively) for an unknown-band profile whose cost can't be proven.
        if (profile && profileBandIsDeepOrUnknown(profile)) {
          resolvedTier = 'deep';
          canDowngrade = false;
          if (modelCapability(profile.model_id)?.tier === undefined) hasUnknownBand = true;
        } else {
          resolvedTier = r.tier;
        }
        costUsd += estimateSpawnCost(r.model, spec.max_turns ?? DEFAULT_SPAWN_MAX_TURNS);
        // The deep child's REAL provider. A cross-provider hybrid slot runs on the
        // slot's provider (a Mistral main with a deep→Sonnet slot runs on Anthropic);
        // a profile forces hybridSlot to {crossProviderSlot:false} but routes via its
        // OWN provider, so read profile.provider — naming the base provider in either
        // case would be a transparency lie. Predicate 6 is load-bearing.
        providers.add(profile?.provider ?? (r.hybridSlot.crossProviderSlot ? r.hybridSlot.provider : baseProvider));
      }
      const providerList = [...providers].map((p) => providerFamilyLabel(p)).join(', ');
      const childWord = deepSpecs.length === 1 ? 'One child would run' : `${deepSpecs.length} children would run`;
      const tierWord = hasUnknownBand
        ? 'a model gated as DEEP (or an unregistered custom model whose cost band the engine cannot prove)'
        : 'the DEEP tier (a stronger reasoning model, more capable but more expensive)';
      // The trailing clause must match the buttons offered (predicate 6,
      // non-phishing): promise "Run on balanced" only when the engine can honour it.
      const tail = canDowngrade
        ? `Allow only if the work genuinely needs deep; otherwise choose "Run on balanced".`
        : `A model profile pins a specific endpoint and cannot be substituted down — allow only if you want this run on that model.`;
      return {
        message:
          `⚠ spawn_agent: ${childWord} on ${tierWord}. ` +
          `Estimated cost ~$${costUsd.toFixed(2)} against this session. ` +
          `Provider: ${providerList}. ${tail}`,
        tier: resolvedTier,
        costUsd,
        provider: providerList,
        ...(canDowngrade ? { downgradeTo: 'balanced' as const } : {}),
      };
    },
  },
};
