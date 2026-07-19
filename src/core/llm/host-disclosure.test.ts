import { describe, it, expect } from 'vitest';
import {
  HOST_DISCLOSURES,
  FIREWORKS_CONTRACT_CONFIRMED,
  hostDisclosure,
  displayPosture,
  UNCONFIRMED_POSTURE,
} from './host-disclosure.js';

/**
 * P1b host-disclosure data + the R2 gate. The load-bearing property is that an
 * UNCONFIRMED posture (Fireworks, until its contract is pinned) is NEVER asserted
 * as fact — `displayPosture` must fall back to the neutral string.
 */
describe('host-disclosure (model-presets P1b)', () => {
  it('carries the three provider hosts', () => {
    for (const host of ['api.anthropic.com', 'api.mistral.ai', 'api.fireworks.ai']) {
      expect(hostDisclosure(host), host).toBeDefined();
    }
  });

  it('an EU host has no Chapter-V transfer basis; a US host does', () => {
    expect(HOST_DISCLOSURES['api.mistral.ai']!.residency).toBe('EU');
    expect(HOST_DISCLOSURES['api.mistral.ai']!.transferBasis).toBeNull();
    expect(HOST_DISCLOSURES['api.fireworks.ai']!.residency).toBe('US');
    expect(HOST_DISCLOSURES['api.fireworks.ai']!.transferBasis).toBe('SCC/DPF');
  });

  it('R2 gate: the Fireworks posture is NOT asserted until the contract is confirmed', () => {
    // The gate ships OFF — the contract is not pinned yet.
    expect(FIREWORKS_CONTRACT_CONFIRMED).toBe(false);
    expect(HOST_DISCLOSURES['api.fireworks.ai']!.postureConfirmed).toBe(false);
    // displayPosture must therefore NEVER surface 'zero-retention · SOC2' for Fireworks.
    const shown = displayPosture('api.fireworks.ai')!;
    expect(shown).toContain(UNCONFIRMED_POSTURE);
    expect(shown).not.toContain('zero-retention');
    expect(shown).not.toContain('SOC2');
  });

  it('a confirmed host shows its posture verbatim — including a sensitive one', () => {
    expect(displayPosture('api.mistral.ai')).toBe('EU-resident (France)');
    // Anthropic's posture IS contract-confirmed, so the sensitive claim passes
    // through verbatim — proving the gate lets a confirmed claim show, not just
    // that it blocks (Mistral's posture has no sensitive token to prove that).
    expect(displayPosture('api.anthropic.com')).toBe('US · zero-retention (API default) · SOC2');
  });

  it('R2 gate is STRUCTURAL: no exported surface leaks the unconfirmed Fireworks claim', () => {
    // The gate must live in the DATA, not only in displayPosture — a W3/W4 consumer
    // reading .posture off the object/map directly must still get the gated value.
    for (const posture of [
      hostDisclosure('api.fireworks.ai')!.posture,
      HOST_DISCLOSURES['api.fireworks.ai']!.posture,
    ]) {
      expect(posture).toContain(UNCONFIRMED_POSTURE);
      expect(posture).not.toContain('zero-retention');
      expect(posture).not.toContain('SOC2');
    }
  });

  it('returns undefined for an unknown host', () => {
    expect(hostDisclosure('evil.example.com')).toBeUndefined();
    expect(displayPosture('evil.example.com')).toBeUndefined();
  });
});
