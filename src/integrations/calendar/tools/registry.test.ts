// Tests for the CalendarRegistry + resolveProviders helper. Covers the
// PRD §S8 UUID-guard (no email enumeration) and §S11 binding-check
// (provider.accountId === input.account_id) on top of the basic
// registry CRUD.

import { describe, expect, it } from 'vitest';
import { InMemoryCalendarRegistry, resolveProviders } from './registry.js';
import { CalendarError } from '../provider.js';
import type { CalendarProvider } from '../../../types/calendar.js';

const VALID_A = '00000000-0000-4000-8000-000000000001';
const VALID_B = '00000000-0000-4000-8000-000000000002';

function stub(id: string, overrideId?: string): CalendarProvider {
  return {
    name: 'caldav',
    accountId: overrideId ?? id,
    authType: 'basic',
    list: async () => [],
    close: async () => undefined,
  };
}

describe('InMemoryCalendarRegistry', () => {
  it('register + has + get round-trips', () => {
    const r = new InMemoryCalendarRegistry();
    const p = stub(VALID_A);
    r.register(p);
    expect(r.has(VALID_A)).toBe(true);
    expect(r.get(VALID_A)).toBe(p);
  });

  it('remove drops the entry', () => {
    const r = new InMemoryCalendarRegistry();
    r.register(stub(VALID_A));
    r.remove(VALID_A);
    expect(r.has(VALID_A)).toBe(false);
    expect(r.get(VALID_A)).toBeUndefined();
  });

  it('listIds returns all registered IDs in insertion order', () => {
    const r = new InMemoryCalendarRegistry();
    r.register(stub(VALID_A));
    r.register(stub(VALID_B));
    expect(r.listIds()).toEqual([VALID_A, VALID_B]);
  });
});

describe('resolveProviders', () => {
  it('returns all providers when accountIds is omitted', () => {
    const r = new InMemoryCalendarRegistry();
    const a = stub(VALID_A);
    const b = stub(VALID_B);
    r.register(a);
    r.register(b);
    const out = resolveProviders(r, undefined);
    expect(out).toEqual([a, b]);
  });

  it('returns all providers when accountIds is empty array', () => {
    const r = new InMemoryCalendarRegistry();
    r.register(stub(VALID_A));
    expect(resolveProviders(r, [])).toHaveLength(1);
  });

  it('returns only the requested providers when accountIds is explicit', () => {
    const r = new InMemoryCalendarRegistry();
    const a = stub(VALID_A);
    const b = stub(VALID_B);
    r.register(a);
    r.register(b);
    expect(resolveProviders(r, [VALID_B])).toEqual([b]);
  });

  it('rejects non-UUID account_ids (PRD §S8 — blocks email enumeration)', () => {
    const r = new InMemoryCalendarRegistry();
    expect(() => resolveProviders(r, ['attacker@victim.com']))
      .toThrow(CalendarError);
    expect(() => resolveProviders(r, ['not-a-uuid']))
      .toThrow(/not a UUID/);
  });

  it('throws not_found when ID is a valid UUID but unknown', () => {
    const r = new InMemoryCalendarRegistry();
    expect(() => resolveProviders(r, [VALID_A]))
      .toThrow(/No calendar account with id/);
  });

  it('throws not_found when provider.accountId mismatches the looked-up id (PRD §S11)', () => {
    const r = new InMemoryCalendarRegistry();
    // Inject a provider with a wrong accountId — simulates a future bug
    // where the registry's key drifts from the provider's own field.
    const drifted = stub(VALID_A, VALID_B);
    (r as { providers: Map<string, CalendarProvider> }).providers = new Map([[VALID_A, drifted]]);
    expect(() => resolveProviders(r, [VALID_A]))
      .toThrow(/binding mismatch/);
  });
});
