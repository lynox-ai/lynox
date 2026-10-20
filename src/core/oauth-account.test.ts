import { describe, expect, it } from 'vitest';
import { ACCOUNT_LABEL_MAX, accountFromIdToken, accountFromStoreOrigin, accountLabel } from './oauth-account.js';

const ISS = 'https://auth.bexio.com/realms/bexio';
const CLIENT = 'client-1';
const NOW = 1_800_000_000;

function token(claims: Record<string, unknown>): string {
  return ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'c2ln'].join('.');
}
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ iss: ISS, aud: CLIENT, exp: NOW + 60, sub: 's-1', email: 'person@example.invalid', ...over });

describe('accountFromIdToken', () => {
  it('reads the email of a token from the preset issuer, for this client, not expired', () => {
    expect(accountFromIdToken(token(good()), ISS, CLIENT, NOW)).toEqual({ label: 'person@example.invalid', source: 'id-token' });
  });

  it('takes an audience list that holds the client', () => {
    expect(accountFromIdToken(token(good({ aud: ['other', CLIENT] })), ISS, CLIENT, NOW)?.label).toBe('person@example.invalid');
  });

  it('prefers the email when both are there', () => {
    expect(accountFromIdToken(token(good({ preferred_username: 'login-name' })), ISS, CLIENT, NOW)?.label).toBe('person@example.invalid');
  });

  it('falls back to preferred_username without an email', () => {
    expect(accountFromIdToken(token(good({ email: undefined, preferred_username: 'login-name' })), ISS, CLIENT, NOW)?.label).toBe('login-name');
  });

  it.each([
    ['another issuer', good({ iss: 'https://auth.bexio.com/realms/other' })],
    ['an issuer with a trailing slash', good({ iss: `${ISS}/` })],
    ['another client', good({ aud: 'someone-else' })],
    ['an audience list without the client', good({ aud: ['a', 'b'] })],
    ['no audience', good({ aud: undefined })],
    ['an expired token', good({ exp: NOW })],
    ['no expiry', good({ exp: undefined })],
    ['an expiry that is not a number', good({ exp: String(NOW + 60) })],
    ['only a subject', good({ email: undefined })],
    ['an email that is blank', good({ email: '   ' })],
  ])('gives no account for %s', (_label, claims) => {
    expect(accountFromIdToken(token(claims), ISS, CLIENT, NOW)).toBeUndefined();
  });

  it.each([
    ['no token', undefined],
    ['a number', 42],
    ['two segments', 'a.b'],
    ['a payload that is not base64url', 'a.b+c.d'],
    ['a payload that is not JSON', `a.${Buffer.from('not json').toString('base64url')}.c`],
    ['a payload that is an array', `a.${Buffer.from('[1]').toString('base64url')}.c`],
  ])('gives no account for %s', (_label, raw) => {
    expect(accountFromIdToken(raw, ISS, CLIENT, NOW)).toBeUndefined();
  });
});

describe('accountFromStoreOrigin', () => {
  it('names the store by its host', () => {
    expect(accountFromStoreOrigin('https://acme.myshopify.com')).toEqual({ label: 'acme.myshopify.com', source: 'store-origin' });
  });

  it('gives no account for an origin it cannot parse', () => {
    expect(accountFromStoreOrigin('not a url')).toBeUndefined();
  });
});

describe('accountLabel', () => {
  it('keeps a plain name as it is', () => {
    expect(accountLabel('person@example.invalid')).toBe('person@example.invalid');
  });

  it('makes one line of a name with breaks and control characters', () => {
    expect(accountLabel('a\nb\r\nc\u0000d\u0085e')).toBe('a b c d e');
  });

  it('removes format characters, TAG characters included, and C1 controls', () => {
    const tagged = `shop${String.fromCodePoint(0xe0041)}​‮`;
    expect(accountLabel(tagged)).toBe('shop');
    expect(accountLabel('a\u009bb')).toBe('ab');
  });

  it(`cuts a long name to ${String(ACCOUNT_LABEL_MAX)} characters`, () => {
    expect(accountLabel('x'.repeat(ACCOUNT_LABEL_MAX + 50))).toHaveLength(ACCOUNT_LABEL_MAX);
  });

  it('gives nothing for a value that is not text or has nothing readable left', () => {
    expect(accountLabel(undefined)).toBeUndefined();
    expect(accountLabel(7)).toBeUndefined();
    expect(accountLabel('​ \n')).toBeUndefined();
  });
});
