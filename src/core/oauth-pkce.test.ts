import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createPkcePair, deriveChallenge } from './oauth-pkce.js';
import { signProfileOAuthState } from './oauth-state-cookie.js';

describe('the generated pair', () => {
  it('produces a verifier the RFC admits', () => {
    const { verifier } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // RFC 7636 §4.1 unreserved set.
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('produces a verifier the state cookie can actually carry', () => {
    // The cookie payload is dot-separated and the RFC's unreserved set admits
    // `.`, so a generator that emitted one would mint a cookie that verifies as
    // a different value. This is the pairing between the two modules, asserted
    // rather than assumed — `base64url` has no dot, but that is a property of
    // the encoding choice, and the choice is what this pins.
    for (let i = 0; i < 200; i++) {
      const { verifier } = createPkcePair();
      expect(verifier).not.toContain('.');
      const signed = signProfileOAuthState(
        { state: 'a'.repeat(36), profileId: 'bexio', verifier },
        'secret',
        1_700_000_000,
      );
      expect(signed, `verifier ${verifier} could not be signed`).not.toBeNull();
    }
  });

  it('never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(createPkcePair().verifier);
    expect(seen.size).toBe(500);
  });

  it('names S256 and offers no way to ask for plain', () => {
    const pair = createPkcePair();
    expect(pair.method).toBe('S256');
    // `createPkcePair` takes no arguments — there is no parameter to pass
    // `plain` through. The assertion is on the function's arity because that is
    // what makes the absence structural rather than a default.
    expect(createPkcePair).toHaveLength(0);
  });
});

describe('the challenge', () => {
  it('is the base64url SHA-256 of the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('matches RFC 7636 appendix B', () => {
    // The RFC's own worked example. A hand-rolled base64 → base64url rewrite
    // that forgets one of `+`, `/` or `=` still passes a round-trip test
    // against itself; it fails this one.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(deriveChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is derived, not stored — the same verifier always gives the same challenge', () => {
    const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(deriveChallenge(v)).toBe(deriveChallenge(v));
  });

  it('changes completely when one character of the verifier changes', () => {
    const a = deriveChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    const b = deriveChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXj');
    expect(a).not.toBe(b);
  });

  it('carries no base64 padding or non-url characters', () => {
    // Positive control that the encoding is the url-safe one: plain base64 of
    // 32 bytes always ends in `=`, and this never does.
    for (let i = 0; i < 100; i++) {
      const { challenge } = createPkcePair();
      expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
      expect(challenge).not.toContain('=');
      expect(challenge).toHaveLength(43);
    }
  });
});
