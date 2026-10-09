import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  signProfileOAuthState,
  verifyProfileOAuthState,
  PROFILE_OAUTH_STATE_TTL_SEC,
} from './oauth-state-cookie.js';

const SECRET = 'a-test-http-secret-value';
const NOW = 1_700_000_000;
const VERIFIER = 'a'.repeat(43);
const STATE = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const good = { state: STATE, profileId: 'bexio', verifier: VERIFIER, by: { tag: 'owner' } } as const;
/** The `by` field `good` signs, as the payload carries it. */
const BY = Buffer.from(JSON.stringify({ tag: 'owner' })).toString('base64url');

describe('the round-trip', () => {
  it('returns exactly what was signed', () => {
    const cookie = signProfileOAuthState(good, SECRET, NOW);
    expect(cookie).not.toBeNull();
    expect(verifyProfileOAuthState(cookie ?? '', SECRET, NOW)).toEqual(good);
  });

  it('still verifies one second before the TTL expires', () => {
    const cookie = signProfileOAuthState(good, SECRET, NOW) ?? '';
    const atEdge = NOW + PROFILE_OAUTH_STATE_TTL_SEC;
    expect(verifyProfileOAuthState(cookie, SECRET, atEdge)).toEqual(good);
    expect(verifyProfileOAuthState(cookie, SECRET, atEdge + 1)).toBeNull();
  });
});

describe('the profile id is covered by the signature', () => {
  // This is the defence the whole design rests on: the callback path is
  // constant, so the id arrives only in this cookie. If the id were merely
  // BESIDE the signature, a user allowed to connect one profile could edit the
  // field and land the provider's grant in another profile's vault slots.
  it('refuses a cookie whose profile id was swapped for another', () => {
    const cookie = signProfileOAuthState(good, SECRET, NOW) ?? '';
    const swapped = cookie.replace('.bexio.', '.shopify.');
    expect(swapped).not.toBe(cookie); // the fixture actually changed something
    expect(verifyProfileOAuthState(swapped, SECRET, NOW)).toBeNull();
  });

  it('refuses a cookie whose state was swapped, keeping the id', () => {
    const cookie = signProfileOAuthState(good, SECRET, NOW) ?? '';
    const swapped = cookie.replace(STATE, '3f2504e0-4f89-11d3-9a0c-0305e82c3302');
    expect(swapped).not.toBe(cookie);
    expect(verifyProfileOAuthState(swapped, SECRET, NOW)).toBeNull();
  });

  it('refuses a cookie whose verifier was swapped', () => {
    const cookie = signProfileOAuthState(good, SECRET, NOW) ?? '';
    const swapped = cookie.replace(VERIFIER, 'b'.repeat(43));
    expect(swapped).not.toBe(cookie);
    expect(verifyProfileOAuthState(swapped, SECRET, NOW)).toBeNull();
  });
});

describe('the derivation purpose separates this flow from the Google one', () => {
  // Name and Path already separate the two cookies, but those are transport
  // properties that a later edit can collapse. This asserts the separation
  // that survives such an edit.
  it('refuses a payload signed with the Google flow purpose', () => {
    const payload = `${STATE}.bexio.${VERIFIER}.${BY}.${String(NOW)}`;
    const googleKey = createHmac('sha256', 'lynox-oauth-state').update(SECRET).digest();
    const googleSig = createHmac('sha256', googleKey).update(payload).digest('hex');
    expect(verifyProfileOAuthState(`${payload}.${googleSig}`, SECRET, NOW)).toBeNull();

    // Positive control on the same payload: with THIS module's own purpose the
    // identical bytes verify, so the refusal above is the purpose and not the
    // payload being malformed.
    const ourKey = createHmac('sha256', 'lynox-profile-oauth-state').update(SECRET).digest();
    const ourSig = createHmac('sha256', ourKey).update(payload).digest('hex');
    expect(verifyProfileOAuthState(`${payload}.${ourSig}`, SECRET, NOW)).toEqual(good);
  });

  it('refuses a cookie minted under a different secret', () => {
    const cookie = signProfileOAuthState(good, SECRET, NOW) ?? '';
    expect(verifyProfileOAuthState(cookie, `${SECRET}-other`, NOW)).toBeNull();
  });
});

describe('the timestamp', () => {
  it('refuses a cookie stamped in the future', () => {
    // Not a clock-skew tolerance question: a future stamp is a value this
    // engine did not mint now, and the TTL would accept it for as long as the
    // skew lasts.
    const cookie = signProfileOAuthState(good, SECRET, NOW + 30) ?? '';
    expect(verifyProfileOAuthState(cookie, SECRET, NOW)).toBeNull();
    expect(verifyProfileOAuthState(cookie, SECRET, NOW + 30)).toEqual(good);
  });

  it('refuses a timestamp with trailing garbage that parseInt would accept', () => {
    // `parseInt('1700000000abc', 10)` is 1700000000. The signature covers the
    // RAW field, so this cannot verify anyway — the pattern makes the refusal
    // independent of that, which matters if the payload is ever re-ordered.
    const payload = `${STATE}.bexio.${VERIFIER}.${BY}.${String(NOW)}abc`;
    const key = createHmac('sha256', 'lynox-profile-oauth-state').update(SECRET).digest();
    const sig = createHmac('sha256', key).update(payload).digest('hex');
    expect(verifyProfileOAuthState(`${payload}.${sig}`, SECRET, NOW)).toBeNull();
  });
});

describe('the shape is refused before anything is trusted', () => {
  it.each([
    ['too few fields', `${STATE}.bexio.${VERIFIER}.${BY}.${String(NOW)}`],
    ['too many fields', `${STATE}.bexio.${VERIFIER}.${BY}.${String(NOW)}.deadbeef.extra`],
    ['empty string', ''],
    ['an empty field', `.bexio.${VERIFIER}.${BY}.${String(NOW)}.deadbeef`],
  ])('refuses %s', (_label, raw) => {
    expect(verifyProfileOAuthState(raw, SECRET, NOW)).toBeNull();
  });

  it('refuses a non-hex signature without throwing', () => {
    // `Buffer.from(x, 'hex')` truncates at the first non-hex byte instead of
    // throwing, and `timingSafeEqual` throws on a length mismatch. Without the
    // length guard this input is an exception, not a refusal.
    const cookie = signProfileOAuthState(good, SECRET, NOW) ?? '';
    const parts = cookie.split('.');
    const tampered = [...parts.slice(0, 5), 'zzzz'].join('.');
    expect(() => verifyProfileOAuthState(tampered, SECRET, NOW)).not.toThrow();
    expect(verifyProfileOAuthState(tampered, SECRET, NOW)).toBeNull();
  });

  it('refuses a truncated signature without throwing', () => {
    const cookie = signProfileOAuthState(good, SECRET, NOW) ?? '';
    const parts = cookie.split('.');
    const tampered = [...parts.slice(0, 5), (parts[5] ?? '').slice(0, 10)].join('.');
    expect(() => verifyProfileOAuthState(tampered, SECRET, NOW)).not.toThrow();
    expect(verifyProfileOAuthState(tampered, SECRET, NOW)).toBeNull();
  });
});

describe('signing refuses what the format cannot carry', () => {
  // Signing a value that cannot round-trip is worse than refusing it: the
  // cookie verifies as a DIFFERENT value rather than failing.
  it('refuses a verifier containing a dot', () => {
    // RFC 7636's unreserved set admits `.`, so this is a legal verifier that
    // this dot-separated payload still cannot carry.
    const withDot = `${'a'.repeat(21)}.${'b'.repeat(21)}`;
    expect(withDot).toHaveLength(43);
    expect(signProfileOAuthState({ ...good, verifier: withDot }, SECRET, NOW)).toBeNull();
  });

  it.each([
    ['an uppercase id', 'Bexio'],
    ['an id with a dot', 'bex.io'],
    ['an id starting with a hyphen', '-bexio'],
    ['an empty id', ''],
    ['an over-long id', 'a'.repeat(65)],
  ])('refuses %s', (_label, profileId) => {
    expect(signProfileOAuthState({ ...good, profileId }, SECRET, NOW)).toBeNull();
  });

  it.each([
    ['a too-short verifier', 'a'.repeat(42)],
    ['a too-long verifier', 'a'.repeat(129)],
  ])('refuses %s', (_label, verifier) => {
    expect(signProfileOAuthState({ ...good, verifier }, SECRET, NOW)).toBeNull();
  });

  it('refuses an empty secret on both sides', () => {
    expect(signProfileOAuthState(good, '', NOW)).toBeNull();
    const cookie = signProfileOAuthState(good, SECRET, NOW) ?? '';
    expect(verifyProfileOAuthState(cookie, '', NOW)).toBeNull();
  });

  it('accepts the boundary lengths it documents', () => {
    // The complement of the refusals above: without this, tightening the
    // pattern to something stricter would leave every test green.
    expect(signProfileOAuthState({ ...good, verifier: 'a'.repeat(43) }, SECRET, NOW)).not.toBeNull();
    expect(signProfileOAuthState({ ...good, verifier: 'a'.repeat(128) }, SECRET, NOW)).not.toBeNull();
    expect(signProfileOAuthState({ ...good, profileId: 'a'.repeat(64) }, SECRET, NOW)).not.toBeNull();
    expect(signProfileOAuthState({ ...good, profileId: 'a' }, SECRET, NOW)).not.toBeNull();
  });
});

describe('who started the connection rides inside the signature (PRD §3.13)', () => {
  const MANDATE = { tag: 'mandate:helper.name@example.invalid', mandateId: 'b3c1a2d4-0000-4000-8000-000000000001' };
  const ourSig = (payload: string): string => {
    const key = createHmac('sha256', 'lynox-profile-oauth-state').update(SECRET).digest();
    return createHmac('sha256', key).update(payload).digest('hex');
  };

  it('carries a mandate with its id across, an address with dots included', () => {
    const cookie = signProfileOAuthState({ ...good, by: MANDATE }, SECRET, NOW) ?? '';
    expect(cookie.split('.')).toHaveLength(6);
    expect(verifyProfileOAuthState(cookie, SECRET, NOW)).toEqual({ ...good, by: MANDATE });
  });

  // Whatever id the login contract accepted has to be able to start a connection; a narrower
  // rule here would turn every such session's connect into an error page.
  it('carries any mandate id the login contract admits, dots and the full length included', () => {
    for (const mandateId of ['m.2026.10', 'x'.repeat(64)]) {
      const by = { tag: MANDATE.tag, mandateId };
      const cookie = signProfileOAuthState({ ...good, by }, SECRET, NOW) ?? '';
      expect(verifyProfileOAuthState(cookie, SECRET, NOW)).toEqual({ ...good, by });
    }
  });

  // The reader caps the encoded field. A principal valid on its face whose encoding is longer
  // must not be signed: the user would consent at the provider and then be turned away.
  it('does not sign a principal whose encoding the reader would refuse', () => {
    const by = { tag: `mandate:${'\u00fc'.repeat(290)}@example.invalid`, mandateId: 'x'.repeat(64) };
    expect(signProfileOAuthState({ ...good, by }, SECRET, NOW)).toBeNull();
  });

  it('refuses a cookie whose principal was swapped for the owner', () => {
    const cookie = signProfileOAuthState({ ...good, by: MANDATE }, SECRET, NOW) ?? '';
    const parts = cookie.split('.');
    const swapped = [...parts.slice(0, 3), BY, ...parts.slice(4)].join('.');
    expect(swapped).not.toBe(cookie);
    expect(verifyProfileOAuthState(swapped, SECRET, NOW)).toBeNull();
  });

  it('refuses a cookie from before the principal was carried, though its signature is good', () => {
    const payload = `${STATE}.bexio.${VERIFIER}.${String(NOW)}`;
    expect(verifyProfileOAuthState(`${payload}.${ourSig(payload)}`, SECRET, NOW)).toBeNull();
  });

  it.each([
    ['a mandate without its id', { tag: MANDATE.tag }],
    ['the owner with a mandate id', { tag: 'owner', mandateId: MANDATE.mandateId }],
    ['a tag that is neither', { tag: 'member:someone' }],
    ['a mandate tag with no address', { tag: 'mandate:', mandateId: MANDATE.mandateId }],
    ['a mandate id with a control character', { tag: MANDATE.tag, mandateId: 'a\u0007b' }],
    ['a mandate id longer than the login contract allows', { tag: MANDATE.tag, mandateId: 'x'.repeat(65) }],
    ['a mandate id with surrounding space', { tag: MANDATE.tag, mandateId: ' abc' }],
  ])('neither signs nor reads %s', (_label, by) => {
    expect(signProfileOAuthState({ ...good, by }, SECRET, NOW)).toBeNull();
    const field = Buffer.from(JSON.stringify(by.mandateId === undefined ? { tag: by.tag } : { tag: by.tag, mandate_id: by.mandateId })).toString('base64url');
    const payload = `${STATE}.bexio.${VERIFIER}.${field}.${String(NOW)}`;
    expect(verifyProfileOAuthState(`${payload}.${ourSig(payload)}`, SECRET, NOW)).toBeNull();
  });

  it('does not read a principal field that is not the JSON it signs', () => {
    for (const field of [Buffer.from('not json').toString('base64url'), Buffer.from('"owner"').toString('base64url')]) {
      const payload = `${STATE}.bexio.${VERIFIER}.${field}.${String(NOW)}`;
      expect(verifyProfileOAuthState(`${payload}.${ourSig(payload)}`, SECRET, NOW)).toBeNull();
    }
  });
});
