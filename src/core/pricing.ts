import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLynoxDir } from './config.js';
import { modelCapability, normalizeModelId, getDefaultMaxTokens, ownEntry } from '../types/models.js';
import type { ModelPricing } from '../types/models.js';

export type { ModelPricing };

/** Fallback when neither override nor registry has an entry — Opus base
 *  rate as the conservative default. cacheWrite mirrors the registry's 1h-TTL
 *  rate (2× input): an unknown model billed through the Anthropic path gets the
 *  same 1h cache_control, so the fallback must not under-price its writes. */
const FALLBACK_PRICING: ModelPricing = {
  input: 5, output: 25, cacheWrite: 10, cacheRead: 0.50,
};

let overridePricing: Record<string, ModelPricing> | null = null;

/** A usable override entry has four finite, non-negative per-Mtok rates. */
function isValidPricing(v: unknown): v is ModelPricing {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (['input', 'output', 'cacheWrite', 'cacheRead'] as const).every((k) => {
    const n = p[k];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0;
  });
}

function loadPricingOverride(): Record<string, ModelPricing> | null {
  try {
    const raw = readFileSync(join(getLynoxDir(), 'pricing.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Validate every entry before trusting it. A malformed entry (missing,
    // NaN, or negative field) would poison calculateCost with NaN — and since
    // `NaN >= cap` is false, EVERY budget layer (cost-guard, session budget,
    // managed debit) then fails OPEN, not closed. Drop bad entries (warn) so a
    // single typo in an operator's pricing.json can't disable billing.
    // No prototype: a `"__proto__"` key in the file would otherwise REPLACE this
    // object's prototype on assignment instead of becoming an entry. Lookups read
    // own entries only (`ownEntry`).
    const validated: Record<string, ModelPricing> = Object.create(null) as Record<string, ModelPricing>;
    for (const [model, pricing] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidPricing(pricing)) {
        validated[model] = pricing;
      } else {
        process.stderr.write(`[pricing] ignoring malformed pricing.json override for "${model}"\n`);
      }
    }
    return validated;
  } catch {
    return null;
  }
}

/** @internal — test-only hook to inject the override cache without touching
 *  the filesystem. Pass `null` to clear, an object to seed. */
export function _resetOverridePricingForTests(value: Record<string, ModelPricing> | null): void {
  overridePricing = value;
}

export function getPricing(model: string): ModelPricing {
  if (overridePricing === null) {
    overridePricing = loadPricingOverride() ?? {};
  }
  const base = normalizeModelId(model);
  // Override file wins (operator opt-in), then registry, then conservative fallback.
  return ownEntry(overridePricing, model) ?? ownEntry(overridePricing, base)
    ?? modelCapability(model)?.pricing
    ?? FALLBACK_PRICING;
}

/**
 * Assumed prefix of a run's FIRST model call, in tokens: system prompt plus tool
 * definitions. Named rather than folded into the formula because it is the one figure
 * in {@link estimateFirstTurnUSD} that is a guess, and the estimate is only as good as
 * it is. A real prefix on a tool-heavy agent runs larger; that direction is the safe
 * one for a floor, which is why this is not tuned down.
 */
const FIRST_TURN_PREFIX_TOKENS = 20_000;

/**
 * Fraction of a model's output ceiling a first turn is assumed to use.
 *
 * Equal to the spawn path's `SPAWN_OUTPUT_FILL_RATIO` on purpose — two different fill
 * ratios for "one turn" would make the two estimates disagree about the same run. ⚠ That
 * used to be stated here and enforced nowhere, i.e. a rule with no mechanism; a test now
 * asserts the two are equal, so the next person to tune one is told about the other.
 */
const FIRST_TURN_OUTPUT_FILL = 0.3;

/**
 * Does this instance have real pricing for `model`, as opposed to the conservative
 * fallback?
 *
 * ⛔ WHY A CALLER NEEDS TO KNOW, and it is the measured reason this function exists:
 * {@link estimateFirstTurnUSD} prices an unknown id at the FALLBACK rate, which is the
 * Opus rate — $0.32, higher than the balanced tier and 6.4x the flat $0.05 that the
 * spawn floor used to be. Conservative is right for "how much should I reserve"; it is
 * wrong for "is this budget too small to bother", because it refuses on a price nobody
 * is paying. A profile pinning a local model at `localhost:11434` is unpriced AND free,
 * and a floor derived from the fallback refuses a child handed the run's entire
 * remainder. So a caller using the estimate as a THRESHOLD asks this first.
 *
 * Own-entry lookups on purpose: a bracket read of an object literal answers for
 * `__proto__`, `toString` and every other prototype member with something that is not
 * pricing, which makes an estimate NaN — and `x < NaN` is false, so a threshold built on it
 * admits everything. That class is closed at the source: `ownEntry` guards the override map
 * and `modelCapability`, and the override map itself has no prototype. A sweep of `src/`
 * finds no remaining dynamic bracket read of a model-keyed map (`MODEL_MAP[tier]` is keyed
 * by a typed `ModelTier`, not by an id from outside). An earlier revision of this comment
 * claimed the shape "still lives in the registry lookups themselves"; the own-entries
 * hardening landed between that sentence and this one and made it false.
 */
export function hasKnownPricing(model: string): boolean {
  if (overridePricing === null) {
    overridePricing = loadPricingOverride() ?? {};
  }
  const base = normalizeModelId(model);
  // ⛔ ONE resolution, then one predicate — {@link getPricing}'s own chain with its
  // fallback left off. Written as three separate `isValidPricing` tests it was subtly
  // different: `getPricing` uses `??` and stops at the first PRESENT entry, while an
  // `||` over three predicates keeps going past a present-but-invalid one into the
  // registry, so lookup 3 could answer for a key lookup 1 already owned. Measured through
  // the test hook: an override entry `{input: 1}` on a registry id made this function say
  // "priced" off the REGISTRY while `getPricing` returned the invalid override — floor NaN,
  // and `share < NaN` is false, so every child was admitted. Resolving once cannot diverge.
  //
  // `modelCapability` normalises @-suffixed Vertex ids and is the same reader `getPricing`
  // uses, so a Vertex-dated id that the billing prices reads as priced here. A lookup of
  // its own would be a second answer to one question.
  const entry = ownEntry(overridePricing, model)
    ?? ownEntry(overridePricing, base)
    ?? modelCapability(model)?.pricing;
  // The predicate is this function's own and `getPricing` has none: it trusts that every
  // file entry was validated on load, which `loadPricingOverride` does. So in the product
  // the two agree. They part only for an entry seeded through the exported test hook
  // without validation, and there this answers "unpriced" — no floor rather than a floor
  // of NaN, which is the direction that cannot absorb a comparison.
  return isValidPricing(entry);
}

/**
 * What a run's FIRST model call costs, in dollars: on `model`, against `maxOutputTokens`
 * when the caller carries a USABLE cap (finite and positive), and against the model's own
 * ceiling otherwise.
 *
 * ⚠ That sentence is the one a reader hovers, and it said "against the model's own output
 * ceiling" for one revision too long — the pre-fix verdict, in different words from the
 * docblock that was corrected one file over. A sweep for THAT file's phrasing could not find
 * it. The sweep has to run over the CLAIM.
 *
 * ⛔ WHY THE COLD RATE, and this is the whole point of the function. A cost guard books
 * a turn BEFORE it compares, so any run — however small its budget — completes one full
 * turn. A floor that decides "is this budget worth admitting at all?" therefore has to
 * be measured against that first turn, and a first turn is always cold: its prefix is
 * written at the `cacheWrite` rate, not read at the `cacheRead` one.
 *
 * ⚠ `maxOutputTokens` IS THE CAP THE CALL WILL CARRY, and passing it is the caller's job
 * precisely because the caller is the only one who knows the whole chain. For a spawned
 * child that chain is `spec.max_tokens ?? profile.max_tokens`, and it reaches the provider
 * unclamped — measured, a child admitted on the $0.192 balanced floor (which assumes 4 800
 * output tokens) can emit 64 000 and cost about $1.08. An earlier attempt at this argument
 * read only the spec half, which left exactly the case the argument exists for; it was
 * removed again rather than left half wired, because an argument that works in half the
 * cases reads as a guarantee and is not one.
 *
 * ⚠ AND IT CUTS BOTH WAYS, each figure with its method. On `claude-sonnet-4-6`: the model's
 * own 16 000 ceiling gives $0.192; a cap of 64 000 gives $0.408 by this same 0.3 fill (and
 * $1.08 if the child emits the whole cap); a cap of 500 gives $0.12225, which ADMITS shares
 * the model-default floor refused. Narrowing a cap lowers the floor, and that direction owes
 * a witness as much as the other.
 *
 * ⚠ WHAT THIS REPLACES — every number names the SET it is counted over, because the two
 * sets give very different answers and an earlier version of this comment counted
 * neither. The admission floors were FLAT at $0.05. Over the three TIER DEFAULTS
 * (`MODEL_MAP`) a cold first turn costs $0.052288 / $0.192 / $0.44 — a spread of 8.41x,
 * and the flat figure is nearly exact for the cheapest. Over all 39 ids in
 * `MODEL_CAPABILITIES` the range is $0.000898 (`ministral-3b-2410`) to $0.88
 * (`claude-fable-5`): 17.60x too low at the top, and 55.66x too HIGH at the bottom.
 *
 * ⚠ SO IT WAS WRONG IN BOTH DIRECTIONS, and the first version of this comment told only
 * the tightening half. At the cheap end the flat figure refused batches whose shares
 * could each have paid for dozens of turns. Deriving the floor ADMITS those, and that
 * half owes a witness as much as the other does.
 *
 * For an unknown id this returns the FALLBACK price rather than 0 — right for a
 * reservation, wrong for a threshold. See {@link hasKnownPricing}.
 *
 * ⚠ NO non-finite guard here, and the reason is narrower than an earlier version of this
 * comment claimed. That version said both factors are "numbers by construction"; they are
 * not, in general — they are numbers because every entry reaching `overridePricing` is
 * validated by `loadPricingOverride`, and because the own-entries hardening stopped a
 * model-keyed bracket read from answering with a prototype member. Those are two
 * boundaries doing the work, not a construction. Through the exported test hook
 * `_resetOverridePricingForTests`, which skips the first of them, a NaN rate still reaches
 * this arithmetic — a refuter did exactly that.
 *
 * It stays out because in the PRODUCT the branch cannot fire, and a branch that cannot
 * fire is a reader's false confidence; the honest version is to name the two boundaries
 * rather than to call the result structural. A caller that seeds pricing by hand is
 * responsible for what it seeds.
 */
export function estimateFirstTurnUSD(model: string, maxOutputTokens?: number): number {
  const pricing = getPricing(model);
  // A cap that is absent, zero, negative or non-finite falls back to the model's own
  // ceiling rather than producing a floor of 0 (which admits everything) or NaN (which
  // absorbs the comparison that uses it). `max_tokens` is schema-typed `number` and
  // otherwise unvalidated, and `JSON.parse('{"max_tokens":1e999}')` is `Infinity`.
  //
  // ⚠ TWO predicates for four conditions, not four: `Number.isFinite` already rejects
  // `undefined`, so an explicit `!== undefined` term was dead code and is gone. A
  // non-integer cap is honoured as given — the provider rounds, and pricing 500.5 as 500.5
  // is the conservative direction.
  const ceiling = Number.isFinite(maxOutputTokens) && (maxOutputTokens as number) > 0
    ? (maxOutputTokens as number)
    : getDefaultMaxTokens(model);
  const output = ceiling * FIRST_TURN_OUTPUT_FILL;
  return (FIRST_TURN_PREFIX_TOKENS / 1_000_000) * pricing.cacheWrite
    + (output / 1_000_000) * pricing.output;
}

export function calculateCost(model: string, usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
}): number {
  const p = getPricing(model);
  return (usage.input_tokens / 1_000_000) * p.input
       + (usage.output_tokens / 1_000_000) * p.output
       + ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * p.cacheWrite
       + ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * p.cacheRead;
}
