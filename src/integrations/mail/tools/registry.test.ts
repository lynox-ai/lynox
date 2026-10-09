import { describe, expect, it } from 'vitest';
import { InMemoryMailRegistry, resolveProvider, resolveProviders } from './registry.js';
import { MailError, type MailProvider } from '../provider.js';

function fakeProvider(id: string, address = `${id}@example.com`): MailProvider {
  return {
    accountId: id,
    address,
    list: async () => [],
    fetch: async () => { throw new Error('not used'); },
    search: async () => [],
    send: async () => { throw new Error('not used'); },
    watch: async () => ({ stop: async () => {} }),
    close: async () => {},
  };
}

describe('InMemoryMailRegistry', () => {
  it('starts empty', () => {
    const r = new InMemoryMailRegistry();
    expect(r.list()).toEqual([]);
    expect(r.default()).toBe(null);
    expect(r.get('nope')).toBe(null);
  });

  it('add() registers a provider but does NOT auto-assign default', () => {
    // PR3: default selection moved to MailContext._reconcileDefault() so it
    // can consult the persisted is_default flag. add() registering its first
    // provider as default was the bug behind "DEFAULT badge wandert".
    const r = new InMemoryMailRegistry();
    r.add(fakeProvider('a'));
    r.add(fakeProvider('b'));
    expect(r.list()).toEqual(['a', 'b']);
    expect(r.default()).toBe(null);
  });

  it('remove() clears default when the removed provider was default; does not auto-rotate', () => {
    const r = new InMemoryMailRegistry();
    r.add(fakeProvider('a'));
    r.add(fakeProvider('b'));
    r.setDefault('a');
    r.remove('a');
    expect(r.list()).toEqual(['b']);
    // Caller (MailContext) is responsible for picking a replacement —
    // registry no longer silently promotes a sibling.
    expect(r.default()).toBe(null);
  });

  it('setDefault() requires a registered provider', () => {
    const r = new InMemoryMailRegistry();
    r.add(fakeProvider('a'));
    expect(() => r.setDefault('missing')).toThrow(MailError);
    r.setDefault('a');
    expect(r.default()).toBe('a');
  });

  it('clear() empties everything', () => {
    const r = new InMemoryMailRegistry();
    r.add(fakeProvider('a'));
    r.clear();
    expect(r.list()).toEqual([]);
    expect(r.default()).toBe(null);
  });
});

describe('resolveProvider', () => {
  it('returns the requested provider when present', () => {
    const r = new InMemoryMailRegistry();
    r.add(fakeProvider('a'));
    r.add(fakeProvider('b'));
    expect(resolveProvider(r, 'b').accountId).toBe('b');
  });

  it('falls back to the default when no account is requested', () => {
    const r = new InMemoryMailRegistry();
    r.add(fakeProvider('a'));
    r.setDefault('a');
    expect(resolveProvider(r, undefined).accountId).toBe('a');
  });

  it('throws MailError(not_found) when nothing is registered', () => {
    const r = new InMemoryMailRegistry();
    const err = (() => { try { resolveProvider(r, undefined); return null; } catch (e) { return e as MailError; } })();
    expect(err?.code).toBe('not_found');
  });

  it('throws MailError(not_found) for unknown accounts', () => {
    const r = new InMemoryMailRegistry();
    r.add(fakeProvider('a'));
    const err = (() => { try { resolveProvider(r, 'wrong'); return null; } catch (e) { return e as MailError; } })();
    expect(err?.code).toBe('not_found');
    expect(err?.message).toContain('Available: a');
  });
});

describe('an account named by its address', () => {
  const errorOf = (fn: () => unknown): MailError | null => { try { fn(); return null; } catch (e) { return e as MailError; } };
  const twoAccounts = (): InMemoryMailRegistry => {
    const r = new InMemoryMailRegistry();
    r.add(fakeProvider('main', 'main@example.ch'));
    r.add(fakeProvider('office', 'office@example.ch'));
    r.setDefault('main');
    return r;
  };

  it('resolveProvider finds it by address, ignoring case and surrounding spaces', () => {
    expect(resolveProvider(twoAccounts(), 'office@example.ch').accountId).toBe('office');
    expect(resolveProvider(twoAccounts(), ' Office@Example.CH ').accountId).toBe('office');
  });

  it('resolveProvider still finds it by id', () => {
    expect(resolveProvider(twoAccounts(), 'office').accountId).toBe('office');
  });

  it('resolveProviders returns only the account the address names, not the fan-out', () => {
    expect(resolveProviders(twoAccounts(), 'office@example.ch').map(p => p.accountId)).toEqual(['office']);
    expect(resolveProviders(twoAccounts(), 'office').map(p => p.accountId)).toEqual(['office']);
  });

  it('an exact id wins over another account whose address is the same string', () => {
    const r = twoAccounts();
    r.add(fakeProvider('office@example.ch', 'other@example.ch'));
    expect(resolveProvider(r, 'office@example.ch').accountId).toBe('office@example.ch');
  });

  it('an address two accounts share is an error that lists both by id', () => {
    const r = twoAccounts();
    r.add(fakeProvider('office-imap', 'office@example.ch'));
    for (const resolve of [() => resolveProvider(r, 'office@example.ch'), () => resolveProviders(r, 'office@example.ch')]) {
      const err = errorOf(resolve);
      expect(err?.code).toBe('not_found');
      expect(err?.message).toContain('office (office@example.ch)');
      expect(err?.message).toContain('office-imap (office@example.ch)');
      expect(err?.message).toContain('by its id');
    }
  });

  it('an unknown name lists every account with its address', () => {
    const err = errorOf(() => resolveProvider(twoAccounts(), 'billing@example.ch'));
    expect(err?.code).toBe('not_found');
    expect(err?.message).toContain('Available: main (main@example.ch), office (office@example.ch)');
  });
});
