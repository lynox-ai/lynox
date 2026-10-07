import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateCost, getPricing, _resetOverridePricingForTests, estimateFirstTurnUSD, hasKnownPricing } from './pricing.js';
import { MODEL_CAPABILITIES, getDefaultMaxTokens } from '../types/models.js';
import type { ModelPricing } from '../types/models.js';

describe('Pricing', () => {
  it('returns pricing for known models', () => {
    const opus = getPricing('claude-opus-4-6');
    expect(opus.input).toBe(5);
    expect(opus.output).toBe(25);

    const opus47 = getPricing('claude-opus-4-7');
    expect(opus47.input).toBe(5);
    expect(opus47.output).toBe(25);

    const sonnet = getPricing('claude-sonnet-4-6');
    expect(sonnet.input).toBe(3);

    const haiku = getPricing('claude-haiku-4-5-20251001');
    expect(haiku.input).toBe(1);
    expect(haiku.output).toBe(5);
  });

  it('falls back to opus pricing for unknown models', () => {
    const unknown = getPricing('unknown-model');
    // Full fallback shape — verifies the FALLBACK_PRICING constant survives a
    // future registry change that drops claude-opus-4-6 from the registry
    // (which would silently re-route the previous "claude-opus-4-6 fallback"
    // path through the same numbers via a different code path).
    expect(unknown).toEqual({ input: 5, output: 25, cacheWrite: 10, cacheRead: 0.50 });
  });

  describe('estimateFirstTurnUSD', () => {
    // ⛔ HERMETIC, for the reason its sibling block below states in its own comment: the
    // override map loads lazily, so a stray `~/.lynox/pricing.json` on the host (or a CI
    // cache) bleeds into every test that does not pin it. Demonstrated: a file overriding
    // `claude-sonnet-4-6` fails three of these. A false RED rather than a false green —
    // the better direction, and still noise nobody can diagnose from the failure text.
    //
    // ⚠ An earlier version of this comment said this block "runs FIRST" and therefore
    // triggers the lazy load. It does not: a bare `it` at the top of this file calls
    // `getPricing` before it, so the load has already happened. Among the blocks that OWN a
    // reset this one is first, which is what was meant — the hygiene holds either way, the
    // stated reason did not.
    beforeEach(() => { _resetOverridePricingForTests({}); });
    afterEach(() => { _resetOverridePricingForTests(null); });

    it('prices a COLD first turn — prefix written, not read', () => {
      // ⛔ FOUND BY THREE SURVIVING MUTANTS. The spawn-path witnesses only checked
      // whether a batch was refused, so swapping the cacheWrite rate for the input rate,
      // or shrinking the output term, left them green: the threshold moved but stayed on
      // the same side of the fixture. The number IS the subject of this function, so it
      // needs a witness on the number.
      //
      // Expected values computed from the registry by hand, not from the function:
      // prefix 20 000 tokens at cacheWrite + (that model's OWN maxOutput × 0.3) at the
      // output rate. The per-model maxOutput is the part an earlier version of this
      // comment got wrong — it used 16 000 for every model and so landed on $0.64 for
      // fable-5, then hedged instead of fixing the arithmetic:
      //   fable-5 : 20000/1e6×20 + 32000×0.3/1e6×50 = 0.40 + 0.48 = $0.88
      //   sonnet  : 20000/1e6× 6 + 16000×0.3/1e6×15 = 0.12 + 0.072 = $0.192
      //   haiku   : 20000/1e6× 2 +  8192×0.3/1e6× 5 = 0.04 + 0.0123 = $0.052
      const fable = estimateFirstTurnUSD('claude-fable-5');
      const sonnet = estimateFirstTurnUSD('claude-sonnet-4-6');
      const haiku = estimateFirstTurnUSD('claude-haiku-4-5-20251001');

      // The ORDERING is the load-bearing claim: an expensive tier must cost
      // substantially more than a cheap one, or a per-model floor buys nothing.
      expect(fable).toBeGreaterThan(sonnet);
      expect(sonnet).toBeGreaterThan(haiku);
      // And the SPREAD, because that is what made the flat $0.05 wrong: the expensive
      // tier is more than ten times the cheap one.
      expect(fable / haiku, 'the spread a flat floor cannot cover').toBeGreaterThan(10);
      // The cheap tier sits near the old flat figure — which is why that figure looked
      // right for years.
      //
      // ⚠ The lower bound is 0.05 and not 0.04 on purpose, measured: 0.04 is exactly the
      // prefix term alone, so a bound there says nothing about the OUTPUT term — a mutant
      // that shrank the output contribution to a hundredth passed it. This bound includes
      // the output term, which is what makes it a statement about the whole estimate.
      expect(haiku).toBeGreaterThan(0.05);
      expect(haiku).toBeLessThan(0.07);
      // ⛔ The cacheWrite rate is what a COLD turn pays.
      //
      // ⚠ REWRITTEN after a refuter showed the first version passed for the wrong reason:
      // it compared the estimate against the PREFIX TERM priced at `input` (0.192 > 0.06),
      // and the output term alone clears that bound — so it could not tell the two rates
      // apart, while the comment claimed it pinned exactly that. The honest comparison is
      // against the WHOLE estimate re-priced at `input`, which is what a reader would have
      // to beat to call the prefix "read, not written".
      const p = getPricing('claude-sonnet-4-6');
      expect(p.cacheWrite, 'the premise: cacheWrite exceeds input on this tier').toBeGreaterThan(p.input);
      const ifPricedAtInput = (20_000 / 1e6) * p.input + (16_000 * 0.3 / 1e6) * p.output;
      expect(sonnet, 'the estimate exceeds the same turn priced at the input rate')
        .toBeGreaterThan(ifPricedAtInput);
    });

    it('pins the formula constants, not just the ordering', () => {
      // ⛔ FOUND BY TWO SURVIVING MUTANTS, both reported by a refuter: raising
      // FIRST_TURN_PREFIX_TOKENS by 25 % and nearly doubling FIRST_TURN_OUTPUT_FILL were
      // killed only by a spawn test about floating-point round-off — a fixture whose
      // subject is the give-back, not the floor. The magnitude of this estimate had no
      // witness of its own; `toBeLessThan(0.07)` on the fast tier allowed +34 %.
      //
      // The expectation restates the formula with the two constants written HERE as
      // literals, and reads the rates and each model's OWN output ceiling from the
      // registry. That is deliberate: a price change flows through and does not break
      // this test, while a change to either constant does — which is the only thing it
      // claims to guard.
      for (const id of ['claude-fable-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
        const pr = getPricing(id);
        const expected = (20_000 / 1e6) * pr.cacheWrite + (getDefaultMaxTokens(id) * 0.3 / 1e6) * pr.output;
        expect(estimateFirstTurnUSD(id), `${id} prices its own output ceiling`).toBeCloseTo(expected, 10);
      }
      // And the per-model ceiling is the part an earlier comment got wrong: a constant
      // 16 000 for every model is exactly the mutation that produced the old $0.64 figure.
      expect(estimateFirstTurnUSD('claude-fable-5'), 'fable uses its own 32k ceiling').toBeCloseTo(0.88, 6);
      expect(estimateFirstTurnUSD('claude-sonnet-4-6')).toBeCloseTo(0.192, 6);
      expect(estimateFirstTurnUSD('claude-haiku-4-5-20251001')).toBeCloseTo(0.052288, 6);
    });

    it('stays finite for an id that resolves to a prototype member', () => {
      // ⛔ WHAT THIS WITNESSES CHANGED UNDER IT, and the honest version is worth more than
      // the tidy one. A bracket read of a model-keyed object literal answers for `toString`
      // with a FUNCTION, whose `.pricing` is undefined; the arithmetic then yields NaN, and
      // `share < NaN` is false, so any threshold built on it admits everything. This test
      // was written to pin a fail-closed branch inside `estimateFirstTurnUSD`.
      //
      // The own-entries hardening then closed the same hole UPSTREAM — `getPricing` and the
      // capability getters read own entries — which made that branch unreachable in the
      // product, and it is removed.
      //
      // ⚠ NOT "numbers by construction", which is what this comment said until a round
      // caught it surviving here after the doc comment had already retracted it: two
      // BOUNDARIES do the work — `isValidPricing` on every override entry at load, and
      // `ownEntry` on every model-keyed read — and a caller that seeds pricing by hand goes
      // around the first.
      //
      // Either way the branch is gone, so this test is no longer a
      // witness for a guard in this function; it is a witness for the COMPOSED behaviour at
      // the call site that cares (the spawn floor), and it would pass with or without a
      // local guard. Stated rather than deleted, because the property is still the one a
      // threshold depends on, and the next person to add a pricing source needs it held.
      for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
        const usd = estimateFirstTurnUSD(id);
        expect(Number.isFinite(usd), `${id} is finite`).toBe(true);
        expect(usd, `${id} prices at the fallback`).toBeCloseTo(0.32, 6);
        expect(hasKnownPricing(id), `${id} is not a priced model`).toBe(false);
      }
    });

    it('calls a present-but-invalid override entry unpriced, so no NaN reaches a threshold', () => {
      // ⛔ A SURVIVING MUTANT, found by the fourth round: replacing the predicate with
      // `entry !== undefined` passed the whole suite. The commit message described this
      // exact case as measured, and nothing held it — the measurement was written up
      // instead of witnessed.
      //
      // Why it is fail-open rather than cosmetic: `getPricing` hands a present entry back
      // without validating it, so an estimate built from an entry missing `output` is NaN —
      // and `share < NaN` is false, so a floor built on it admits EVERY child at any
      // positive share. The predicate turns that into "unpriced", i.e. a floor of 0, which
      // still refuses a zero share and cannot absorb a comparison.
      _resetOverridePricingForTests(
        { 'claude-sonnet-4-6': { input: 1 } } as unknown as Record<string, ModelPricing>,
      );
      expect(Number.isNaN(estimateFirstTurnUSD('claude-sonnet-4-6')), 'the estimate is NaN')
        .toBe(true);
      expect(hasKnownPricing('claude-sonnet-4-6'), 'so a threshold must not call it priced')
        .toBe(false);
    });

    it('finds an override keyed on the base id when the request carries an @-suffix', () => {
      // ⛔ A SURVIVING MUTANT, found by a delta round: deleting the normalised-id lookup
      // (`ownEntry(overridePricing, base)`) passed the whole suite, and it is one of the
      // exact three lookups this function's claim is about. Reachable and fail-open: an
      // operator prices `my-vertex-model` in `pricing.json`, a profile pins the dated Vertex
      // form, and nothing in the registry carries that id — then `getPricing` charges the
      // override while a one-lookup `hasKnownPricing` calls it unpriced, so the floor
      // disappears for a model whose price this instance KNOWS.
      _resetOverridePricingForTests({
        'my-vertex-model': { input: 1, output: 2, cacheWrite: 2, cacheRead: 0.1 },
      });
      expect(hasKnownPricing('my-vertex-model@20260101'), 'the dated form is priced').toBe(true);
      // The point is not just "true" — it is that this answer AGREES with what the billing
      // charges for the same id. Two readers of one question would be the defect.
      expect(getPricing('my-vertex-model@20260101').output, 'and the same entry prices it').toBe(2);
      expect(hasKnownPricing('some-other-vertex@20260101'), 'an id nobody priced').toBe(false);
    });

    it('separates a priced model from one that only got the fallback', () => {
      // The distinction a THRESHOLD needs and the estimate alone cannot give: the fallback
      // is the Opus rate, so an unpriced id prices DEARER than the balanced tier.
      expect(hasKnownPricing('claude-sonnet-4-6')).toBe(true);
      expect(hasKnownPricing('ministral-3b-2410')).toBe(true);
      expect(hasKnownPricing('my-local-llama-70b'), 'a self-hosted model nobody priced').toBe(false);
      expect(hasKnownPricing(''), 'the empty id').toBe(false);
      // The @-suffixed Vertex form of a priced id must NOT read as unpriced — `getPricing`
      // normalises it, so a second lookup that did not would make a floor disagree with
      // the billing.
      const vertex = Object.keys(MODEL_CAPABILITIES).find((k) => k.startsWith('claude-sonnet-4-6'));
      expect(vertex, 'the registry still carries the id this case is built on').toBeDefined();
      expect(hasKnownPricing(`${vertex!}@20260514`), 'a Vertex-suffixed priced id').toBe(true);
      // And an unpriced id still costs MORE than a priced cheap one — the asymmetry that
      // makes the fallback wrong for a floor.
      expect(estimateFirstTurnUSD('my-local-llama-70b'))
        .toBeGreaterThan(estimateFirstTurnUSD('claude-sonnet-4-6'));
    });

    it('keeps its output fill equal to the spawn path\'s', async () => {
      // ⛔ A RULE WITH NO MECHANISM until now: the doc comment declared the two fill ratios
      // equal on purpose and nothing enforced it — two constants in two files. Two
      // different fractions for "one turn" would make the admission floor and the spawn
      // cost estimate disagree about the same run, and the disagreement would be silent.
      // Read from the compiled source rather than exported, because neither constant is
      // part of either module's interface and making them so to satisfy a test would widen
      // the surface for a check.
      const { readFileSync } = await import('node:fs');
      //
      // ⚠ Compares the parsed NUMBERS, not the source text: `0.30` and `0.3` are the same
      // ratio, and a text comparison fails on a reformat with a message claiming the
      // constants differ. Fail-closed either way, but the diagnosis has to be true.
      const read = (path: string, name: string): number => {
        const m = new RegExp(`const ${name} = ([0-9.]+);`).exec(readFileSync(path, 'utf8'));
        expect(m, `${name} is still a literal constant in ${path}`).not.toBeNull();
        return Number(m![1]!);
      };
      expect(read('src/core/pricing.ts', 'FIRST_TURN_OUTPUT_FILL'))
        .toBe(read('src/tools/builtin/spawn.ts', 'SPAWN_OUTPUT_FILL_RATIO'));
    });

    it('falls back rather than returning 0 for an unknown model', () => {
      // A zero floor would admit everything, and an unpriced model is exactly the case
      // where the cost is least predictable.
      expect(estimateFirstTurnUSD('no-such-model-anywhere')).toBeGreaterThan(0.1);
    });
  });

  describe('override-file precedence', () => {
    // Pin to an explicit empty map so the file-system probe never runs;
    // otherwise a stray `~/.lynox/pricing.json` on the host (or CI cache)
    // would silently bleed into the first override test.
    beforeEach(() => {
      _resetOverridePricingForTests({});
    });
    afterEach(() => {
      _resetOverridePricingForTests({});
    });

    it('override entries win over the registry for the exact model id', () => {
      _resetOverridePricingForTests({
        'claude-opus-4-6': { input: 99, output: 99, cacheWrite: 0, cacheRead: 0 },
      });
      const opus = getPricing('claude-opus-4-6');
      expect(opus.input).toBe(99);
      expect(opus.output).toBe(99);
    });

    it('override entries win via normalizeModelId for @-suffixed ids', () => {
      _resetOverridePricingForTests({
        'claude-sonnet-4-6': { input: 88, output: 88, cacheWrite: 0, cacheRead: 0 },
      });
      // Vertex-style @YYYYMMDD suffix normalises to the base id; override on
      // the base should still apply to the suffixed lookup.
      expect(getPricing('claude-sonnet-4-6@20260101').input).toBe(88);
    });

    it('registry wins when no override entry for the model exists', () => {
      _resetOverridePricingForTests({
        'some-other-model': { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      });
      // Unaffected models still resolve through the registry.
      expect(getPricing('claude-sonnet-4-6').input).toBe(3);
    });
  });

  describe('malformed pricing.json validation (fail-closed)', () => {
    afterEach(() => {
      _resetOverridePricingForTests({});
    });

    it('drops a malformed override entry so calculateCost never yields NaN', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-pricing-'));
      writeFileSync(join(dir, 'pricing.json'), JSON.stringify({
        'good-model': { input: 1, output: 2, cacheWrite: 3, cacheRead: 0.5 },
        // Missing cacheWrite/cacheRead — `0 * undefined` is NaN in calculateCost,
        // and `NaN >= cap` is false, so this one entry used to disable every
        // budget layer. It must be dropped, not trusted.
        'bad-model': { input: 1, output: 2 },
      }));
      const prev = process.env['LYNOX_DATA_DIR'];
      process.env['LYNOX_DATA_DIR'] = dir;
      _resetOverridePricingForTests(null); // force a real reload from disk
      try {
        // Valid entry still loads and wins.
        expect(getPricing('good-model')).toEqual({ input: 1, output: 2, cacheWrite: 3, cacheRead: 0.5 });
        // Malformed entry dropped -> finite fallback, so calculateCost stays
        // finite even with cache tokens (the exact NaN trigger).
        const cost = calculateCost('bad-model', {
          input_tokens: 1000, output_tokens: 1000,
          cache_creation_input_tokens: 500, cache_read_input_tokens: 500,
        });
        expect(Number.isFinite(cost)).toBe(true);
      } finally {
        if (prev === undefined) delete process.env['LYNOX_DATA_DIR'];
        else process.env['LYNOX_DATA_DIR'] = prev;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('a model id that names a prototype member', () => {
    const PROTO_KEYS = ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf'];
    afterEach(() => { _resetOverridePricingForTests({}); });

    it.each(PROTO_KEYS)('%s is priced at the fallback, and its cost is finite', (id) => {
      _resetOverridePricingForTests({});
      expect(getPricing(id)).toEqual(getPricing('an-unknown-model-id'));
      const cost = calculateCost(id, { input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 10, cache_read_input_tokens: 10 });
      expect(Number.isFinite(cost)).toBe(true);
    });

    it('a pricing.json with a "__proto__" key keeps it as an entry and leaves the rest intact', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-pricing-'));
      // Written as text: JSON.stringify of an object literal would drop the key.
      writeFileSync(join(dir, 'pricing.json'),
        '{"__proto__": {"input": 7, "output": 7, "cacheWrite": 7, "cacheRead": 7},'
        + ' "good-model": {"input": 1, "output": 2, "cacheWrite": 3, "cacheRead": 0.5}}');
      const prev = process.env['LYNOX_DATA_DIR'];
      process.env['LYNOX_DATA_DIR'] = dir;
      _resetOverridePricingForTests(null);
      try {
        expect(getPricing('__proto__')).toEqual({ input: 7, output: 7, cacheWrite: 7, cacheRead: 7 });
        expect(getPricing('good-model')).toEqual({ input: 1, output: 2, cacheWrite: 3, cacheRead: 0.5 });
        // The entry did not become the map's prototype: an inherited name is not priced from it.
        expect(getPricing('constructor')).toEqual(getPricing('an-unknown-model-id'));
        expect(getPricing('input')).toEqual(getPricing('an-unknown-model-id'));
      } finally {
        if (prev === undefined) delete process.env['LYNOX_DATA_DIR'];
        else process.env['LYNOX_DATA_DIR'] = prev;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('calculates cost correctly for opus', () => {
    const cost = calculateCost('claude-opus-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(30); // $5 + $25
  });

  it('includes cache tokens in cost', () => {
    const cost = calculateCost('claude-opus-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(10.50); // $10 cacheWrite (1h TTL = 2×) + $0.50 cacheRead
  });

  it('calculates haiku cost', () => {
    const cost = calculateCost('claude-haiku-4-5-20251001', {
      input_tokens: 100_000,
      output_tokens: 50_000,
    });
    expect(cost).toBeCloseTo(0.1 + 0.25); // $0.10 input + $0.25 output
  });

  it('handles zero tokens', () => {
    const cost = calculateCost('claude-sonnet-4-6', {
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(cost).toBe(0);
  });

  describe('Mistral tier-set', () => {
    // Without these entries the cost-display falls through to the
    // `claude-opus-4-6` default ($5/$25), which both over-reports cost AND
    // silently misleads operators inspecting the run-history for an EU-
    // sovereign tenant — observed live on staging mistral-demo 2026-05-16
    // (12 870/17 tokens billed at $0.039 instead of the correct ~$0.026).
    it('returns pinned Mistral pricing', () => {
      expect(getPricing('mistral-small-2603').input).toBe(0.20);
      expect(getPricing('mistral-small-2603').output).toBe(0.60);
      // Mistral Large 3 (Dec 2025): 75% price cut vs Large 2.
      expect(getPricing('mistral-large-2512').input).toBe(0.50);
      expect(getPricing('mistral-large-2512').output).toBe(1.50);
      expect(getPricing('magistral-medium-2509').input).toBe(2);
      expect(getPricing('magistral-medium-2509').output).toBe(5);
      // Gen-3 ministrals (2026-05-24): replaced retired -2410 in tier-map.
      expect(getPricing('ministral-3b-2512').input).toBe(0.10);
      expect(getPricing('ministral-8b-2512').input).toBe(0.15);
    });

    it('calculates mistral-large cost without overcharging', () => {
      // Regression guard: same shape as the staging mistral-demo run that
      // exposed the missing entry. Mistral Large 3 rates ($0.50/$1.50) →
      // 12,870 × $0.50/M + 17 × $1.50/M = $0.0064605.
      const cost = calculateCost('mistral-large-2512', {
        input_tokens: 12_870,
        output_tokens: 17,
      });
      expect(cost).toBeCloseTo(0.0064605, 7);
    });

    it('charges cache reads at 10% of input rate (Mistral native prompt-cache)', () => {
      // Mistral docs (https://docs.mistral.ai/api/endpoint/chat — 2026-05-24):
      // `prompt_cache_key` enables transparent prompt caching;
      // cached input is billed at 10% of standard input rate.
      // Large 3 input = $0.50/M → cached = $0.05/M → 1M cached = $0.05.
      const cost = calculateCost('mistral-large-2512', {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(0.05);
    });
  });
});
