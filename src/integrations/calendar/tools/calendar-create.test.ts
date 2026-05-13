// Tests for `resolveCreateTarget` — the PRD §U2 default-account-resolution
// contract that calendar_create relies on. Pure function over an in-memory
// registry + resolver, no SQL/network.

import { describe, expect, it } from 'vitest';
import { resolveCreateTarget, type CalendarWritableResolver } from './calendar-create.js';
import { InMemoryCalendarRegistry } from './registry.js';
import { CalendarError } from '../provider.js';
import type { CalendarProvider } from '../../../types/calendar.js';

const VALID_UUID_A = '00000000-0000-4000-8000-000000000001';
const VALID_UUID_B = '00000000-0000-4000-8000-000000000002';
const VALID_UUID_C = '00000000-0000-4000-8000-000000000003';

function stubProvider(id: string): CalendarProvider {
  return {
    name: 'caldav',
    accountId: id,
    authType: 'basic',
    list: async () => [],
    close: async () => undefined,
  };
}

function makeResolver(writableIds: string[], defaultId: string | null): CalendarWritableResolver {
  return {
    listWritableIds: () => writableIds,
    getDefaultWritableId: () => defaultId,
  };
}

describe('resolveCreateTarget', () => {
  it('throws not_found when zero writable accounts exist', () => {
    const registry = new InMemoryCalendarRegistry();
    const resolver = makeResolver([], null);
    expect(() => resolveCreateTarget(registry, resolver, undefined))
      .toThrow(/No writable calendar account configured/);
  });

  it('uses the single writable account when only one exists', () => {
    const registry = new InMemoryCalendarRegistry();
    const p = stubProvider(VALID_UUID_A);
    registry.register(p);
    const resolver = makeResolver([VALID_UUID_A], null);
    expect(resolveCreateTarget(registry, resolver, undefined)).toBe(p);
  });

  it('prefers the default-writable account when multiple exist + default set', () => {
    const registry = new InMemoryCalendarRegistry();
    const a = stubProvider(VALID_UUID_A);
    const b = stubProvider(VALID_UUID_B);
    registry.register(a);
    registry.register(b);
    const resolver = makeResolver([VALID_UUID_A, VALID_UUID_B], VALID_UUID_B);
    expect(resolveCreateTarget(registry, resolver, undefined)).toBe(b);
  });

  it('throws malformed_event when multiple writable but no default set', () => {
    const registry = new InMemoryCalendarRegistry();
    registry.register(stubProvider(VALID_UUID_A));
    registry.register(stubProvider(VALID_UUID_B));
    const resolver = makeResolver([VALID_UUID_A, VALID_UUID_B], null);
    expect(() => resolveCreateTarget(registry, resolver, undefined))
      .toThrow(/Multiple writable accounts/);
  });

  it('honors explicit account_id when valid UUID + registered', () => {
    const registry = new InMemoryCalendarRegistry();
    const a = stubProvider(VALID_UUID_A);
    const b = stubProvider(VALID_UUID_B);
    registry.register(a);
    registry.register(b);
    const resolver = makeResolver([VALID_UUID_A, VALID_UUID_B], VALID_UUID_A);
    // Explicit id overrides the default.
    expect(resolveCreateTarget(registry, resolver, VALID_UUID_B)).toBe(b);
  });

  it('rejects non-UUID account_id (PRD §S8 — no email enumeration)', () => {
    const registry = new InMemoryCalendarRegistry();
    registry.register(stubProvider(VALID_UUID_A));
    const resolver = makeResolver([VALID_UUID_A], null);
    expect(() => resolveCreateTarget(registry, resolver, 'attacker@victim.com'))
      .toThrow(CalendarError);
    expect(() => resolveCreateTarget(registry, resolver, 'not-a-uuid'))
      .toThrow(/not a UUID/);
  });

  it('throws not_found when explicit account_id is not registered', () => {
    const registry = new InMemoryCalendarRegistry();
    const resolver = makeResolver([], null);
    expect(() => resolveCreateTarget(registry, resolver, VALID_UUID_C))
      .toThrow(/No calendar account with id/);
  });
});
