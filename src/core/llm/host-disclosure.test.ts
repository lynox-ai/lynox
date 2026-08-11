import { describe, it, expect } from 'vitest';
import {
  HOST_DISCLOSURES,
  FIREWORKS_CONTRACT_CONFIRMED,
  hostDisclosure,
  displayPosture,
  gatePosture,
  buildDisclosures,
  UNCONFIRMED_POSTURE,
} from './host-disclosure.js';

/**
 * P1b host-disclosure data + the R2 gate. The load-bearing property is that an
 * UNCONFIRMED posture is NEVER asserted as fact — the gate must fall back to the
 * neutral string.
 *
 * Every host in the table is confirmed since 2026-08-11 (Fireworks was the last
 * one). That is exactly when a gate test rots: the mechanism is proven below
 * against `gatePosture` directly, because asserting it through the table would now
 * pass by never meeting an unconfirmed host.
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
    expect(HOST_DISCLOSURES['api.fireworks.ai']!.transferBasis).toBe('SCC');
  });

  it('R2 gate: the Fireworks posture IS asserted now that its DPA is pinned', () => {
    expect(FIREWORKS_CONTRACT_CONFIRMED).toBe(true);
    expect(HOST_DISCLOSURES['api.fireworks.ai']!.postureConfirmed).toBe(true);
    // The screen must agree with SUBPROCESSORS.md and the website DPA page, which
    // assert contractual zero-retention (§4.5) and SOC 2. It said the OPPOSITE for
    // as long as the flag was off, on the very screen where the preset is chosen.
    expect(displayPosture('api.fireworks.ai')).toBe('US · zero-retention · SOC2');
  });

  it('the RETENTION gate does not settle the TRANSFER basis — Fireworks is SCC, not DPF', () => {
    // Two independent fields. Confirming the posture must not smuggle in a DPF claim:
    // the Fireworks DPA's Schedule 3 is SCCs + UK/Swiss addenda and never invokes the
    // Data Privacy Framework. Its siblings earn 'DPF' from their own contracts.
    expect(HOST_DISCLOSURES['api.fireworks.ai']!.transferBasis).toBe('SCC');
    expect(HOST_DISCLOSURES['api.fireworks.ai']!.transferBasis).not.toContain('DPF');
  });

  it('the gate MECHANISM still refuses an unconfirmed posture', () => {
    // Tested on the function, not on the table. Every host in the table is confirmed
    // today, so a loop over "the unconfirmed ones" would pass by iterating zero times
    // and the next host added unconfirmed would ship its raw claim green.
    const unconfirmed = {
      host: 'api.example.com',
      residency: 'US',
      transferBasis: 'SCC',
      confirmedPosture: 'US · zero-retention · SOC2',
      postureConfirmed: false,
    } as const;
    const shown = gatePosture(unconfirmed);
    expect(shown).toContain(UNCONFIRMED_POSTURE);
    expect(shown).not.toContain('zero-retention');
    expect(shown).not.toContain('SOC2');
    // …and lets the same posture through once it IS confirmed, so the assertion above
    // is about the flag and not about the string being unreachable.
    expect(gatePosture({ ...unconfirmed, postureConfirmed: true })).toBe('US · zero-retention · SOC2');
  });

  it('a confirmed host shows its posture verbatim — including a sensitive one', () => {
    expect(displayPosture('api.mistral.ai')).toBe('EU-resident (France)');
    // Anthropic's posture IS contract-confirmed, so the sensitive claim passes
    // through verbatim — proving the gate lets a confirmed claim show, not just
    // that it blocks (Mistral's posture has no sensitive token to prove that).
    expect(displayPosture('api.anthropic.com')).toBe('US · zero-retention (API default) · SOC2');
  });

  it('R2 gate is STRUCTURAL: the TABLE is built through the gate, not around it', () => {
    // The one that matters, and the one the previous version of this file missed.
    // Asserting over the real table cannot catch a build that skips the gate while
    // every row is confirmed — gated and ungated then produce the same string, so
    // `posture: gatePosture(d)` → `posture: d.confirmedPosture` shipped green. A
    // build over a SYNTHETIC unconfirmed row is the only thing that separates them.
    const built = buildDisclosures({
      'api.confirmed.example': {
        host: 'api.confirmed.example',
        residency: 'US',
        transferBasis: 'SCC',
        confirmedPosture: 'US · zero-retention · SOC2',
        postureConfirmed: true,
      },
      'api.unconfirmed.example': {
        host: 'api.unconfirmed.example',
        residency: 'US',
        transferBasis: 'SCC',
        confirmedPosture: 'US · zero-retention · SOC2',
        postureConfirmed: false,
      },
    });
    expect(built['api.confirmed.example']!.posture).toBe('US · zero-retention · SOC2');
    expect(built['api.unconfirmed.example']!.posture).toContain(UNCONFIRMED_POSTURE);
    expect(built['api.unconfirmed.example']!.posture).not.toContain('zero-retention');
    expect(built['api.unconfirmed.example']!.posture).not.toContain('SOC2');
    // The other fields must pass through untouched — the gate covers the posture only.
    expect(built['api.unconfirmed.example']!.transferBasis).toBe('SCC');
    expect(built['api.unconfirmed.example']!.postureConfirmed).toBe(false);
  });

  it('every exported surface returns the same posture for a host', () => {
    // The gate must live in the DATA, not only in displayPosture — a W3/W4 consumer
    // reading .posture off the object/map directly must still get the gated value.
    // Driven off the PUBLIC table, so it keeps holding when a future host ships
    // unconfirmed. RAW stays private on purpose — exporting it for a test would
    // open the very path the module exists to close.
    expect(Object.keys(HOST_DISCLOSURES).length).toBeGreaterThan(0);
    for (const [host, d] of Object.entries(HOST_DISCLOSURES)) {
      expect(hostDisclosure(host)!.posture, host).toBe(d.posture);
      expect(displayPosture(host), host).toBe(d.posture);
      // `postureConfirmed` must PREDICT the posture — the flag and the string cannot
      // drift apart, which is what would let an unconfirmed claim render as fact.
      if (d.postureConfirmed) {
        expect(d.posture, host).not.toContain(UNCONFIRMED_POSTURE);
      } else {
        expect(d.posture, host).toContain(UNCONFIRMED_POSTURE);
      }
    }
  });

  it('returns undefined for an unknown host', () => {
    expect(hostDisclosure('evil.example.com')).toBeUndefined();
    expect(displayPosture('evil.example.com')).toBeUndefined();
  });
});
