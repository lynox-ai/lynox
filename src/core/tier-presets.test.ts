import { describe, it, expect } from 'vitest';
import { TIER_PRESETS, expandTierPreset } from './tier-presets.js';
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
