import { describe, it, expect } from 'vitest';
import { TIER_PRESETS, expandTierPreset } from './tier-presets.js';
import { TIER_PRESET_NAMES, isTierPresetName } from '../contract/vocab.js';
import { MODEL_CAPABILITIES } from '../types/index.js';
import { isAllowlistedEndpoint } from './llm/endpoint-allowlist.js';
import { LLM_CATALOG } from './llm/catalog.js';

/**
 * The shared `tier_preset` SoT (model-presets W2). These invariants are what let
 * the loadConfig expander (W2) and the managed write-gate (W3) trust the table:
 * every slot resolves to a registered model (else the fail-closed guard fires),
 * every pinned endpoint is allowlisted (no off-vet host), and CN-provenance
 * weights ship ONLY via the Western Fireworks host (the affirmative sourcing rule).
 */
describe('tier-presets (model-presets W2 SoT)', () => {
  it('ships exactly the three hybrid presets', () => {
    // An EU set was drafted 2026-08-10 and PULLED before merging; the EU choice used to be a side effect of
    // picking "efficient", which meant a customer needing EU processing had to
    // know that. Reshaping efficient to open weights would have removed it silently.
    expect(Object.keys(TIER_PRESETS).sort()).toEqual(['balanced', 'efficient', 'max-quality']);
    for (const p of Object.values(TIER_PRESETS)) expect(p.routing_mode).toBe('hybrid');
  });

  it('every preset slot references a REGISTERED model (the fail-closed guard never false-fires)', () => {
    for (const [name, preset] of Object.entries(TIER_PRESETS)) {
      for (const [tier, slot] of Object.entries(preset.tier_set)) {
        expect(MODEL_CAPABILITIES[slot!.model_id], `${name}.${tier} → ${slot!.model_id}`).toBeDefined();
      }
    }
  });

  it('every pinned endpoint is ALLOWLISTED (a preset cannot point at an off-vet host)', () => {
    for (const [name, preset] of Object.entries(TIER_PRESETS)) {
      for (const [tier, slot] of Object.entries(preset.tier_set)) {
        if (slot!.api_base_url) {
          expect(isAllowlistedEndpoint(slot!.api_base_url), `${name}.${tier} → ${slot!.api_base_url}`).toBe(true);
        }
      }
    }
  });

  it('presets pin ONLY Fireworks models with NAMED evidence — candidates stay picker-only', () => {
    // The 2026-08-09 candidates are picker-selectable but UNMEASURED — this guard is
    // the mechanism behind the "no preset pins them before a measurement" invariant,
    // which was otherwise only a comment (pr-review #1162). Extend the set ONLY
    // together with the evidence, and NAME the evidence.
    //
    // The guard's job is to make the DIFFERENCE visible, not to let an unmeasured
    // model in quietly. Read the labels literally:
    //   BENCH    — a repeatable scored run exists in the repo.
    //   SWEEP    — /model-smoke chat probes, read and judged by hand.
    //   OPERATOR — rafael decided; no measurement backs this slot.
    // What is deliberately NOT accepted as evidence any more: the R1/R3 replay floor
    // as a POSITIVE signal. It scores delegation behaviour, not answer quality, and
    // per-model rates below n≈8 are noise (glm measured 0/2, 1/2 and 2/8 on the same
    // body on 2026-08-10). It remains a valid negative signal at adequate n.
    const MEASURED_FIREWORKS = new Set([
      // SWEEP + WS2 replay. The replay is what put it here originally; today it is
      // the sweep (correct task-state grounding, 1M window) plus rafael's decision
      // 2026-08-10 ("glm main auch") that carries the balanced main slot.
      'accounts/fireworks/models/glm-5p2',
      'accounts/fireworks/models/deepseek-v4-pro', // WS2 replay
      // BENCH — fast-slot compaction 2026-08-10: 89.1% literal recall vs a 90.4%
      // haiku-4.5 reference, best judge score of the field (7.83 vs 7.13) → HOLD.
      // Benched as a FAST slot only; it is not a measured main (rafael 2026-08-10).
      'accounts/fireworks/models/deepseek-v4-flash',
      // BENCH — fast-slot compaction 2026-08-10: HOLD at 87.9% recall / judge 6.96,
      // and the quickest model of the sweep in every probe that did not stall on an
      // ask_user question. No longer pinned by any preset (lost the efficient main
      // to minimax-m3 on quality); kept here because the bench result stands.
      'accounts/fireworks/models/qwen3p7-plus',
      // SWEEP — one of only two models that re-verified figures against the web
      // before answering, at $0.30/$1.20 (cheaper than qwen, which it beat on sweep
      // quality). Carries the efficient main slot. No main-slot bench exists.
      'accounts/fireworks/models/minimax-m3',
      // OPERATOR DECISION 2026-08-10, not a bench result: rafael pinned it as the
      // deep slot on the strength of the /model-smoke sweep (best grounding of nine
      // models; it re-verified figures against the web before answering) plus its 1M
      // window. There is no deep-tier bench in the repo to measure it against — if
      // one is ever built, this line is the first thing it should check.
      'accounts/fireworks/models/kimi-k3',
    ]);
    for (const [name, preset] of Object.entries(TIER_PRESETS)) {
      for (const [tier, slot] of Object.entries(preset.tier_set)) {
        if (slot!.api_base_url?.includes('fireworks.ai')) {
          expect(MEASURED_FIREWORKS.has(slot!.model_id),
            `${name}.${tier} pins ${slot!.model_id} — a Fireworks preset slot needs a NAMED basis in MEASURED_FIREWORKS (BENCH / SWEEP / OPERATOR), not merely a catalog entry`).toBe(true);
        }
      }
    }
  });

  it('CN-provenance models appear ONLY via the Fireworks host — never a direct-CN endpoint', () => {
    for (const [name, preset] of Object.entries(TIER_PRESETS)) {
      for (const [tier, slot] of Object.entries(preset.tier_set)) {
        const cap = MODEL_CAPABILITIES[slot!.model_id];
        if (cap?.provenance === 'CN') {
          expect(slot!.api_base_url, `${name}.${tier} is CN — must route via Fireworks`).toContain('fireworks.ai');
        }
      }
    }
  });

  it('EVERY preset prices its bands in ascending order — escalating must never get cheaper', () => {
    // The ladder claim that the pulled-EU-set comment spends 25 lines defending
    // ("the price rises with the band ... the reverse order was considered and
    // rejected") was backed by nothing until a delta review pointed it out. It is the
    // one invariant that holds across ALL four presets and the reason a preset is a
    // ladder rather than three unrelated picks: the band that runs every turn must be
    // the cheap one, and asking for more must cost more.
    for (const [name, preset] of Object.entries(TIER_PRESETS)) {
      const out = (tier: 'fast' | 'balanced' | 'deep'): number => {
        const id = preset.tier_set[tier]?.model_id;
        const p = id ? MODEL_CAPABILITIES[id]?.pricing?.output : undefined;
        expect(p, `${name}.${tier} → ${id} has no output price to rank`).toBeTypeOf('number');
        return p as number;
      };
      // STRICTLY ascending, not `<=`: a delta review mutated haiku's output price to
      // equal sonnet's, flattening max-quality's fast and main bands, and the `<=`
      // version stayed green. The comment this test backs says the price RISES with
      // the band — a flat pair means the cheaper band bought nothing, which is the
      // failure the ladder exists to prevent.
      expect(out('fast'), `${name}: fast output must be BELOW balanced`).toBeLessThan(out('balanced'));
      expect(out('balanced'), `${name}: balanced output must be BELOW deep`).toBeLessThan(out('deep'));
    }
  });

  it('the openai-wire slots omit api_key (self-host resolves it from the endpoint)', () => {
    for (const preset of Object.values(TIER_PRESETS)) {
      for (const slot of Object.values(preset.tier_set)) {
        expect(slot).not.toHaveProperty('api_key');
      }
    }
  });

  it('the Fireworks endpoint equals the catalog base_url_default (host-allowlist misses a path drift)', () => {
    const fw = LLM_CATALOG.find((e) => e.preset_id === 'fireworks');
    expect(fw?.base_url_default).toBeDefined();
    expect(TIER_PRESETS.efficient!.tier_set.deep?.api_base_url).toBe(fw!.base_url_default);
  });

  it('expandTierPreset: known → {routing_mode, tier_set}; unknown → undefined', () => {
    const expanded = expandTierPreset('balanced');
    expect(expanded?.routing_mode).toBe('hybrid');
    expect(expanded?.tier_set.balanced?.model_id).toBe('accounts/fireworks/models/glm-5p2');
    expect(expandTierPreset('does-not-exist')).toBeUndefined();
  });

  it('expandTierPreset: a prototype-chain name is rejected, not resolved to a garbage expansion', () => {
    // `TIER_PRESETS[name]` bracket access would return a truthy Object.prototype member
    // for these, slipping past a truthy-check guard and expanding to
    // {routing_mode: undefined, tier_set: undefined} — a silent routing wipe. Object.hasOwn
    // rejects them cleanly (undefined → the loader's "Unknown tier_preset" throw).
    for (const evil of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(expandTierPreset(evil)).toBeUndefined();
    }
  });
});

describe('TIER_PRESET_NAMES — the contract half cannot drift from the table', () => {
  it('names and table cover exactly the same set', () => {
    // The compiler already enforces this (TIER_PRESETS is a Record keyed on the
    // contract's union, so either half missing fails the build). This test states
    // it as an intent rather than leaving it implicit in a type — and it is the
    // assertion that fails legibly if someone widens the Record's key back to
    // `string`, which would silently restore the drift.
    expect([...TIER_PRESET_NAMES].sort()).toEqual(Object.keys(TIER_PRESETS).sort());
  });

  it('every contract name actually expands', () => {
    // A name in the contract that the CP may pin, but which resolves to nothing,
    // would be stored happily and then throw at engine load — the tenant's
    // container would not come back up after the sync-env that follows.
    for (const name of TIER_PRESET_NAMES) {
      expect(expandTierPreset(name), name).toBeDefined();
    }
  });

  it('refuses a prototype-chain name and an unknown one alike', () => {
    for (const bad of ['__proto__', 'constructor', 'toString', 'ultra-cheap', '', ' balanced']) {
      expect(expandTierPreset(bad), bad).toBeUndefined();
    }
  });

  it('isTierPresetName narrows only real names', () => {
    expect(isTierPresetName('efficient')).toBe(true);
    expect(isTierPresetName('Efficient')).toBe(false);
    expect(isTierPresetName('__proto__')).toBe(false);
    expect(isTierPresetName(undefined)).toBe(false);
    expect(isTierPresetName(null)).toBe(false);
  });
});
