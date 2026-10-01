import { TIER_PRESET_NAMES } from '../contract/vocab.js';
import { describe, it, expect } from 'vitest';
import { buildRoutingUpdate, isPresetStrategy, type TierSet } from './llm-routing-update.js';

// model-presets W4 — the client persistence mapping. The .svelte picker has no
// unit seam (web-ui vitest has no svelte plugin), so this is the ONLY thing that
// proves the client SENDS the right PUT body per strategy — in particular that
// Standard/Eigene send `tier_preset: null` (the clear) rather than omitting it.
describe('buildRoutingUpdate (model-presets W4)', () => {
  const CUSTOM: TierSet = { balanced: { provider: 'anthropic', model_id: 'claude-sonnet-5' } };
  const EXISTING: TierSet = { deep: { provider: 'anthropic', model_id: 'claude-opus-4-8' } };

  it('a preset persists by NAME and empties any explicit tier_set (no per-slot shadow)', () => {
    // Over the CONTRACT list, not a literal: this file's own header calls itself the
    // only proof that the client sends the right PUT body per strategy, and a
    // hand-written list left `eu-sovereign` unproven the day it was added.
    // The length assert is not ceremony — with an empty list every loop below is
    // VACUOUSLY green, which a delta review demonstrated (5/5 passing, 0 iterations).
    expect(TIER_PRESET_NAMES.length).toBeGreaterThan(0);
    for (const p of TIER_PRESET_NAMES) {
      const u = buildRoutingUpdate(p, { existingTierSet: EXISTING, customTierSet: CUSTOM });
      expect(u.tier_preset).toBe(p);
      expect(u.tier_set).toEqual({}); // empty override, so the loader keeps the preset's slots
      expect(u.routing_mode).toBeUndefined(); // the loader materializes hybrid from the preset
    }
  });

  it('Standard CLEARS tier_preset with null (not omitted) and empties a prior tier_set', () => {
    const u = buildRoutingUpdate('standard', { existingTierSet: EXISTING, customTierSet: CUSTOM });
    expect(u.tier_preset).toBeNull(); // null, so the server deletes the key — omission would preserve it
    expect('tier_preset' in u).toBe(true); // the key must be PRESENT (as null), not absent
    expect(u.routing_mode).toBe('standard');
    expect(u.tier_set).toEqual({});
  });

  it('Standard omits tier_set when there was no prior one (nothing to clear)', () => {
    const u = buildRoutingUpdate('standard', { existingTierSet: undefined, customTierSet: CUSTOM });
    expect(u.tier_preset).toBeNull();
    expect(u.routing_mode).toBe('standard');
    expect('tier_set' in u).toBe(false);
  });

  it('Custom persists the manual tier_set and clears tier_preset', () => {
    const u = buildRoutingUpdate('custom', { existingTierSet: EXISTING, customTierSet: CUSTOM });
    expect(u.tier_preset).toBeNull();
    expect(u.routing_mode).toBe('hybrid');
    expect(u.tier_set).toBe(CUSTOM);
  });

  it('isPresetStrategy is true for EVERY contract preset and false for the two modes', () => {
    for (const p of TIER_PRESET_NAMES) expect(isPresetStrategy(p), p).toBe(true);
    expect(isPresetStrategy('standard')).toBe(false);
    expect(isPresetStrategy('custom')).toBe(false);
  });
});
