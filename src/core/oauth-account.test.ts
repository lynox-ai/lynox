import { describe, expect, it } from 'vitest';
import { ACCOUNT_LABEL_MAX, ACCOUNT_NOTE_QUOTED_MAX, accountFromIdToken, accountFromStoreOrigin, accountLabel, accountTrailNote } from './oauth-account.js';

const ISS = 'https://auth.bexio.com/realms/bexio';
const CLIENT = 'client-1';
const NOW = 1_800_000_000;

function token(claims: Record<string, unknown>): string {
  return ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'c2ln'].join('.');
}
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ iss: ISS, aud: CLIENT, exp: NOW + 60, sub: 's-1', email: 'person@example.invalid', email_verified: true, ...over });

describe('accountFromIdToken', () => {
  it('reads the email of a token from the preset issuer, for this client, not expired', () => {
    expect(accountFromIdToken(token(good()), ISS, CLIENT, NOW)).toEqual({ label: 'person@example.invalid', source: 'id-token' });
  });

  it('takes an audience list that holds the client', () => {
    expect(accountFromIdToken(token(good({ aud: ['other', CLIENT] })), ISS, CLIENT, NOW)?.label).toBe('person@example.invalid');
  });

  it('names the email, not a username the account holder chose', () => {
    expect(accountFromIdToken(token(good({ preferred_username: 'login-name' })), ISS, CLIENT, NOW)?.label).toBe('person@example.invalid');
  });

  it('gives no account for a username alone, which can be shaped like anyone\'s address', () => {
    expect(accountFromIdToken(token(good({ email: undefined, preferred_username: 'customer@example.invalid' })), ISS, CLIENT, NOW)).toBeUndefined();
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
    ['an email the provider has not verified', good({ email_verified: false })],
    ['an email without a verification claim', good({ email_verified: undefined })],
    ['a verification claim that is not a boolean', good({ email_verified: 'true' })],
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

describe('accountTrailNote', () => {
  it('quotes the label, so its spaces cannot read as another field', () => {
    expect(accountTrailNote({ label: 'x account:other', source: 'id-token' })).toBe('account:"x account:other"');
  });

  it('says unknown without an account', () => {
    expect(accountTrailNote(undefined)).toBe('account:unknown');
  });

  it.each([
    ['wide characters', '\u{1F600}'.repeat(100)],
    ['characters JSON escapes', '"\\'.repeat(100)],
    ['plain letters', 'a'.repeat(300)],
  ])('fits the log\'s action column for a long label of %s, cut at a whole character', (_label, label) => {
    const note = accountTrailNote({ label, source: 'id-token' });
    const action = `GET /api/oauth/callback ${note}`;
    expect(action.length).toBeLessThanOrEqual(120);
    const quoted = note.slice('account:'.length);
    expect(quoted.length).toBeLessThanOrEqual(ACCOUNT_NOTE_QUOTED_MAX);
    const kept = JSON.parse(quoted) as string;
    expect(label.startsWith(kept)).toBe(true);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('keeps a short label whole', () => {
    expect(accountTrailNote({ label: 'shop.myshopify.com', source: 'store-origin' })).toBe('account:"shop.myshopify.com"');
  });
});
