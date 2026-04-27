import { describe, expect, it } from 'vitest';
import { InMemoryMailRegistry, resolveProvider } from './registry.js';
import { MailError, type MailProvider } from '../provider.js';

function fakeProvider(id: string): MailProvider {
  return {
    accountId: id,
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
