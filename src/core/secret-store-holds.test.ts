import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./observability.js', () => ({
  channels: {
    secretAccess: { publish: vi.fn() },
  },
}));

import { SecretStore } from './secret-store.js';
import { scopeSecretStore } from './secret-scope.js';
import { channels } from './observability.js';
import type { SecretScope } from '../types/index.js';
import type { SecretVault } from './secret-vault.js';

/**
 * `holds` answers "would `resolve` hand out a value?" without reading it out and without an audit
 * event. It shares one predicate with `resolve`, so every reason `resolve` gives nothing is a
 * reason `holds` says false.
 */

function mockVault(entries: Array<[string, { value: string; scope: SecretScope; ttlMs: number }]>): SecretVault {
  return { getAll: () => new Map(entries) } as unknown as SecretVault;
}

const stored = (ttlMs = 0): SecretStore => new SecretStore(undefined, mockVault([['BOOKS_ACCESS_TOKEN', { value: 'token-value-1234', scope: 'any', ttlMs }]]));
const published = (): unknown[] => vi.mocked(channels.secretAccess.publish).mock.calls.map((c) => c[0]);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('SecretStore.holds', () => {
  it('control: true where resolve hands a value out, and no event falls for the answer', () => {
    const store = stored();
    expect(store.resolve('BOOKS_ACCESS_TOKEN')).toBe('token-value-1234');
    vi.clearAllMocks();
    expect(store.holds('BOOKS_ACCESS_TOKEN')).toBe(true);
    expect(published()).toEqual([]);
  });

  it('false for a name that is not stored, as resolve gives nothing', () => {
    const store = stored();
    expect(store.resolve('NOT_THERE')).toBeNull();
    expect(store.holds('NOT_THERE')).toBe(false);
  });

  it('false once the value expired, as resolve gives nothing', () => {
    vi.useFakeTimers();
    const store = stored(1000);
    expect(store.holds('BOOKS_ACCESS_TOKEN')).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(store.resolve('BOOKS_ACCESS_TOKEN')).toBeNull();
    expect(store.holds('BOOKS_ACCESS_TOKEN')).toBe(false);
  });

  it('false without consent, as resolve gives nothing', () => {
    const store = stored();
    (store as unknown as { consented: Set<string> }).consented.delete('BOOKS_ACCESS_TOKEN');
    expect(store.resolve('BOOKS_ACCESS_TOKEN')).toBeNull();
    expect(store.holds('BOOKS_ACCESS_TOKEN')).toBe(false);
  });

  it('false when the resolve guard withholds it, or throws, as resolve gives nothing', () => {
    const store = stored();
    store.setResolveGuard(() => false);
    expect(store.resolve('BOOKS_ACCESS_TOKEN')).toBeNull();
    expect(store.holds('BOOKS_ACCESS_TOKEN')).toBe(false);
    store.setResolveGuard(() => { throw new Error('no profiles'); });
    expect(store.holds('BOOKS_ACCESS_TOKEN')).toBe(false);
  });
});

describe('a scoped store answers holds without telling what lies outside the scope', () => {
  it('false for a name outside the scope that the full vault holds, and nothing is recorded as denied', () => {
    const denied: string[] = [];
    const scoped = scopeSecretStore(stored(), ['OTHER_KEY'], (name) => denied.push(name));
    expect(scoped.holds?.('BOOKS_ACCESS_TOKEN')).toBe(false);
    expect(denied).toEqual([]);
    expect(published()).toEqual([]);
  });

  it('control: a name inside the scope is answered by the full vault', () => {
    const scoped = scopeSecretStore(stored(), ['BOOKS_ACCESS_TOKEN']);
    expect(scoped.holds?.('BOOKS_ACCESS_TOKEN')).toBe(true);
  });
});
