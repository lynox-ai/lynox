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

  it('presets pin ONLY replay-measured Fireworks models — candidates stay picker-only', () => {
    // The 2026-08-09 candidates (kimi-k3, deepseek-v4-flash, qwen3p7-plus) are
    // picker-selectable but UNMEASURED — this guard is the mechanism behind the
    // "no preset pins them before a replay measurement" invariant, which was
    // otherwise only a comment (pr-review #1162). Extend the set ONLY together
    // with the measurement.
    const MEASURED_FIREWORKS = new Set([
      'accounts/fireworks/models/glm-5p2',
      'accounts/fireworks/models/deepseek-v4-pro',
    ]);
    for (const [name, preset] of Object.entries(TIER_PRESETS)) {
      for (const [tier, slot] of Object.entries(preset.tier_set)) {
        if (slot!.api_base_url?.includes('fireworks.ai')) {
          expect(MEASURED_FIREWORKS.has(slot!.model_id),
            `${name}.${tier} pins ${slot!.model_id} — Fireworks preset slots require a replay measurement first`).toBe(true);
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
    expect(expanded?.tier_set.balanced?.model_id).toBe('mistral-medium-2604');
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
