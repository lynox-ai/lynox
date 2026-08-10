import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTierPresetSignal } from './tier-preset-signal.js';
import { TIER_PRESETS } from './tier-presets.js';

// model-presets W4 — the `available_tier_presets` signal that the settings cards
// + header picker render. The one behaviour with a seam worth pinning: a preset's
// `available` flag must mirror what the loader (applyManagedTierSetConstraints)
// would actually route — so the card's disabled-state can never disagree with the
// write-gate 403 or the loader drop (no false advertising). The per-tier
// enrichment (resolved model_id + catalog label + provenance + host disclosure)
// is server-authoritative so the web-ui needs no @lynox-ai/core import.
describe('buildTierPresetSignal (model-presets W4)', () => {
  const saved = {
    a: process.env['ANTHROPIC_API_KEY'],
    m: process.env['MISTRAL_API_KEY'],
    fk: process.env['FIREWORKS_API_KEY'],
    ff: process.env['LYNOX_MANAGED_FIREWORKS_ENABLED'],
  };
  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'cp-anthropic-key';
    process.env['MISTRAL_API_KEY'] = 'cp-mistral-key';
    delete process.env['FIREWORKS_API_KEY'];
    delete process.env['LYNOX_MANAGED_FIREWORKS_ENABLED'];
  });
  afterEach(() => {
    for (const [k, v] of [
      ['ANTHROPIC_API_KEY', saved.a], ['MISTRAL_API_KEY', saved.m],
      ['FIREWORKS_API_KEY', saved.fk], ['LYNOX_MANAGED_FIREWORKS_ENABLED', saved.ff],
    ] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('emits every registered preset as a key', () => {
    const sig = buildTierPresetSignal({ isManagedTier: false });
    expect(Object.keys(sig).sort()).toEqual(Object.keys(TIER_PRESETS).sort());
  });

  it('self-host: every preset is available (loader hardening never runs)', () => {
    // No CP keys, no Fireworks flag — still all available on self-host.
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['MISTRAL_API_KEY'];
    const sig = buildTierPresetSignal({ isManagedTier: false });
    for (const p of Object.values(sig)) expect(p.available).toBe(true);
  });

  it('managed without the Fireworks flag: only the Fireworks-free presets remain', () => {
    // Changed 2026-08-10 and worth stating plainly: `balanced` now pins a Fireworks
    // main (GLM), so a managed tenant WITHOUT `LYNOX_MANAGED_FIREWORKS_ENABLED` is
    // left with eu-sovereign and max-quality. That is the cost of the main swap —
    // enabling Fireworks fleet-wide is a DPA decision, not a code one, and until it
    // is taken this assertion is the honest picture of what such a tenant can pick.
    const sig = buildTierPresetSignal({ isManagedTier: true });
    expect(sig['efficient']!.available).toBe(false);   // all three slots Fireworks
    expect(sig['balanced']!.available).toBe(false);    // Fireworks main
    expect(sig['eu-sovereign']!.available).toBe(true); // all-Mistral
    expect(sig['max-quality']!.available).toBe(true);  // all-Anthropic
  });

  it('managed WITH the Fireworks flag + CP key: efficient becomes available', () => {
    process.env['LYNOX_MANAGED_FIREWORKS_ENABLED'] = 'true';
    process.env['FIREWORKS_API_KEY'] = 'cp-fireworks-key';
    const sig = buildTierPresetSignal({ isManagedTier: true });
    expect(sig['efficient']!.available).toBe(true);
  });

  it('managed WITH the flag but no CP Fireworks key: efficient stays unavailable (fail-closed)', () => {
    process.env['LYNOX_MANAGED_FIREWORKS_ENABLED'] = 'true';
    // FIREWORKS_API_KEY intentionally absent — the loader drops the slot, so the
    // card must NOT advertise it as available.
    const sig = buildTierPresetSignal({ isManagedTier: true });
    expect(sig['efficient']!.available).toBe(false);
  });

  it('managed with a model blocklist: a preset whose slot names a blocked model is unavailable', () => {
    // ⚖️ balanced carries a claude-sonnet-5 deep slot — under the blocklist the
    // loader drops it and the write-gate 403s, so the card must render disabled.
    const sig = buildTierPresetSignal({ isManagedTier: true, blockedModelIds: ['claude-sonnet-'] });
    expect(sig['balanced']!.available).toBe(false);
    // Self-host is untouched — the loader hardening (and thus the blocklist
    // availability gate) never runs there.
    const selfHost = buildTierPresetSignal({ isManagedTier: false, blockedModelIds: ['claude-sonnet-'] });
    expect(selfHost['balanced']!.available).toBe(true);
  });

  it('resolves each tier to a concrete model_id + a catalog label (never a bare tier)', () => {
    const sig = buildTierPresetSignal({ isManagedTier: false });
    for (const [name, preset] of Object.entries(sig)) {
      const expectedTiers = Object.keys(TIER_PRESETS[name]!.tier_set).length;
      expect(preset.tiers.length, `${name} tier count`).toBe(expectedTiers);
      for (const t of preset.tiers) {
        expect(t.model_id, `${name}.${t.tier} model_id`).toBeTruthy();
        expect(t.label, `${name}.${t.tier} label`).toBeTruthy();
      }
    }
  });

  it('carries provenance + host disclosure for a CN-via-Fireworks slot (⚡ efficient deep)', () => {
    const sig = buildTierPresetSignal({ isManagedTier: false });
    const deep = sig['efficient']!.tiers.find((t) => t.tier === 'deep')!;
    expect(deep.model_id).toBe('accounts/fireworks/models/kimi-k3');
    expect(deep.provenance).toBe('CN'); // the provenance chip
    expect(deep.residency).toBe('US'); // Fireworks host residency (weights CN, host US)
  });

  it('resolves an EU Mistral slot host disclosure (eu-sovereign main = mistral-large)', () => {
    const sig = buildTierPresetSignal({ isManagedTier: false });
    const bal = sig['eu-sovereign']!.tiers.find((t) => t.tier === 'balanced')!;
    expect(bal.model_id).toBe('mistral-large-2512');
    expect(bal.residency).toBe('EU');
  });

  it('carries per-tier input/output pricing (the cost feel) from the registry', () => {
    const sig = buildTierPresetSignal({ isManagedTier: false });
    const bal = sig['balanced']!.tiers.find((t) => t.tier === 'balanced')!;
    // GLM 5.2. It replaced mistral-medium ($1.50/$7.50) in this slot on 2026-08-10 —
    // cheaper per output token in the band that runs every turn (the R8 concern,
    // now the other way round) and stronger on open turns in the sweep.
    expect(bal.pricing).toEqual({ input: 1.40, output: 4.40 });
    const deep = sig['balanced']!.tiers.find((t) => t.tier === 'deep')!;
    expect(deep.pricing).toEqual({ input: 3, output: 15 }); // Sonnet 5 — visibly pricier
  });

  it('never emits an unconfirmed Fireworks posture as a confirmed claim (R2 gate)', () => {
    const sig = buildTierPresetSignal({ isManagedTier: false });
    const deep = sig['efficient']!.tiers.find((t) => t.tier === 'deep')!;
    // The gate leaves the posture as a residency-prefixed "unconfirmed" string,
    // never an asserted retention claim.
    expect(deep.posture).toBeDefined();
    expect(deep.posture!.toLowerCase()).not.toContain('zero-retention');
  });
});
