import { describe, expect, it } from 'vitest';
import {
  MailCredentialStore,
  vaultKeyForAccount,
  type MailCredentialBackend,
} from './app-password.js';
import { MailError } from '../provider.js';

class FakeBackend implements MailCredentialBackend {
  private readonly store = new Map<string, string>();
  set(name: string, value: string): void { this.store.set(name, value); }
  get(name: string): string | null { return this.store.get(name) ?? null; }
  delete(name: string): boolean { return this.store.delete(name); }
  has(name: string): boolean { return this.store.has(name); }
  /** Test-only — peek raw stored value */
  raw(name: string): string | undefined { return this.store.get(name); }
}

describe('vaultKeyForAccount', () => {
  it('uppercases and sanitizes ids into env-var-safe keys', () => {
    expect(vaultKeyForAccount('rafael-gmail')).toBe('MAIL_ACCOUNT_RAFAEL_GMAIL');
    expect(vaultKeyForAccount('My Personal iCloud')).toBe('MAIL_ACCOUNT_MY_PERSONAL_ICLOUD');
    expect(vaultKeyForAccount('user@domain.tld')).toBe('MAIL_ACCOUNT_USER_DOMAIN_TLD');
    expect(vaultKeyForAccount('---trim---')).toBe('MAIL_ACCOUNT_TRIM');
  });

  it('rejects empty or non-alphanumeric-only ids', () => {
    expect(() => vaultKeyForAccount('')).toThrow(MailError);
    expect(() => vaultKeyForAccount('---')).toThrow(MailError);
  });
});

describe('MailCredentialStore — save & resolve', () => {
  it('round-trips credentials through the backend', () => {
    const backend = new FakeBackend();
    const store = new MailCredentialStore(backend);

    store.save('rafael-gmail', { user: 'rafael@gmail.com', pass: 'abcd-efgh-ijkl-mnop' });
    expect(store.has('rafael-gmail')).toBe(true);

    const creds = store.resolve('rafael-gmail');
    expect(creds.user).toBe('rafael@gmail.com');
    expect(creds.pass).toBe('abcd-efgh-ijkl-mnop');
  });

  it('persists user, pass, and a storedAt timestamp', () => {
    const backend = new FakeBackend();
    const store = new MailCredentialStore(backend);
    store.save('x', { user: 'u', pass: 'p' });
    const raw = backend.raw('MAIL_ACCOUNT_X')!;
    const parsed = JSON.parse(raw) as { user: string; pass: string; storedAt: string };
    expect(parsed.user).toBe('u');
    expect(parsed.pass).toBe('p');
    expect(parsed.storedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects empty credentials', () => {
    const store = new MailCredentialStore(new FakeBackend());
    expect(() => store.save('x', { user: '', pass: 'p' })).toThrow(MailError);
    expect(() => store.save('x', { user: 'u', pass: '' })).toThrow(MailError);
  });

  it('throws auth_failed when no entry exists', () => {
    const store = new MailCredentialStore(new FakeBackend());
    const err = (() => { try { store.resolve('missing'); return null; } catch (e) { return e as MailError; } })();
    expect(err).toBeInstanceOf(MailError);
    expect(err?.code).toBe('auth_failed');
  });

  it('throws auth_failed on corrupt JSON', () => {
    const backend = new FakeBackend();
    backend.set('MAIL_ACCOUNT_X', 'not-json');
    const store = new MailCredentialStore(backend);
    const err = (() => { try { store.resolve('x'); return null; } catch (e) { return e as MailError; } })();
    expect(err?.code).toBe('auth_failed');
  });

  it('throws auth_failed on JSON without user/pass fields', () => {
    const backend = new FakeBackend();
    backend.set('MAIL_ACCOUNT_X', JSON.stringify({ unrelated: true }));
    const store = new MailCredentialStore(backend);
    const err = (() => { try { store.resolve('x'); return null; } catch (e) { return e as MailError; } })();
    expect(err?.code).toBe('auth_failed');
  });
});

describe('MailCredentialStore — delete & overwrite', () => {
  it('delete returns true on first call, false after', () => {
    const store = new MailCredentialStore(new FakeBackend());
    store.save('x', { user: 'u', pass: 'p' });
    expect(store.delete('x')).toBe(true);
    expect(store.delete('x')).toBe(false);
    expect(store.has('x')).toBe(false);
  });

  it('save overwrites an existing entry', () => {
    const store = new MailCredentialStore(new FakeBackend());
    store.save('x', { user: 'u1', pass: 'p1' });
    store.save('x', { user: 'u2', pass: 'p2' });
    expect(store.resolve('x').pass).toBe('p2');
  });
});

describe('MailCredentialStore — buildResolver', () => {
  it('returns a function that re-reads the vault each call (rotation-friendly)', async () => {
    const backend = new FakeBackend();
    const store = new MailCredentialStore(backend);

    store.save('x', { user: 'u', pass: 'old-pass' });
    const resolver = store.buildResolver('x');

    const first = await resolver();
    expect(first.pass).toBe('old-pass');

    store.save('x', { user: 'u', pass: 'new-pass' });
    const second = await resolver();
    expect(second.pass).toBe('new-pass');
  });

  it('the resolver throws auth_failed if the entry is later deleted', async () => {
    const backend = new FakeBackend();
    const store = new MailCredentialStore(backend);
    store.save('x', { user: 'u', pass: 'p' });
    const resolver = store.buildResolver('x');

    store.delete('x');
    const err = await Promise.resolve().then(() => resolver()).catch(e => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).code).toBe('auth_failed');
  });
});
