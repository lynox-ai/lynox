import { describe, it, expect } from 'vitest';
import { CP_ADMIN_PRINCIPAL, CP_ADMIN_TAG, OWNER_PRINCIPAL, isMandateTag, isOwnerPrincipal, ownedBy, principalFromTag, principalHasEnded, principalTag, type RequestPrincipal } from './request-principal.js';

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org' };
const OTHER: RequestPrincipal = { kind: 'mandate', email: 'other@example.org' };

describe('ownedBy — a mandate reaches only what it set up (§3.13 E1, E2, E7, E9, B6)', () => {
  it('lets the owner reach every row, and a row that does not exist', () => {
    for (const row of [{ created_by: 'mandate:setup@example.org' }, { created_by: 'owner' }, { created_by: null }, {}, undefined]) {
      expect(ownedBy(row, OWNER_PRINCIPAL)).toBe(true);
    }
  });

  it('lets a mandate reach a row that records that very mandate', () => {
    expect(ownedBy({ created_by: principalTag(MANDATE) }, MANDATE)).toBe(true);
  });

  it('refuses a mandate another mandate\'s row, the owner\'s row and an unstamped row', () => {
    expect(ownedBy({ created_by: principalTag(OTHER) }, MANDATE)).toBe(false);
    expect(ownedBy({ created_by: 'owner' }, MANDATE)).toBe(false);
    expect(ownedBy({ created_by: null }, MANDATE)).toBe(false);
    expect(ownedBy({}, MANDATE)).toBe(false);
  });

  it('refuses a mandate a row that does not exist — a missing row is never "its own"', () => {
    expect(ownedBy(undefined, MANDATE)).toBe(false);
  });

  it('compares on the address, not the grant: a renewed mandate keeps its rows', () => {
    expect(ownedBy({ created_by: 'mandate:setup@example.org' }, { kind: 'mandate', email: 'setup@example.org', mandateId: 'm-2' })).toBe(true);
  });
});

describe('principalFromTag — only ever narrows', () => {
  it('gives the mandate for a mandate tag, and the owner for anything else', () => {
    expect(principalFromTag('mandate:setup@example.org')).toEqual({ kind: 'mandate', email: 'setup@example.org' });
    for (const tag of ['owner', null, undefined, '', 'somebody']) expect(principalFromTag(tag)).toBe(OWNER_PRINCIPAL);
  });
});

describe('principalHasEnded — whose grant has ended (§3.13 B8)', () => {
  const live = (id: string): boolean => id === 'grant-1';
  it('never for the owner, whatever the grants', () => {
    expect(principalHasEnded(OWNER_PRINCIPAL, () => false)).toBe(false);
  });
  it('for a mandate, by its own grant only', () => {
    expect(principalHasEnded({ ...MANDATE, mandateId: 'grant-1' }, live)).toBe(false);
    expect(principalHasEnded({ ...MANDATE, mandateId: 'grant-2' }, live)).toBe(true);
  });
  it('for a mandate that names no grant: ended', () => {
    expect(principalHasEnded(MANDATE, () => true)).toBe(true);
  });
});

// PRD cp-admin-line §3.1 (A11): the control plane's admin bearer is a principal of its own. The
// rules in request-principal.ts name what it gets.
describe('the control plane\'s admin bearer (cp-admin)', () => {
  it('has its own tag: neither the owner\'s nor a mandate\'s', () => {
    expect(principalTag(CP_ADMIN_PRINCIPAL)).toBe(CP_ADMIN_TAG);
    expect(isMandateTag(principalTag(CP_ADMIN_PRINCIPAL))).toBe(false);
    expect(principalTag(CP_ADMIN_PRINCIPAL)).not.toBe(principalTag(OWNER_PRINCIPAL));
  });
  it('reads back from its tag as itself, never as the owner', () => {
    expect(principalFromTag(CP_ADMIN_TAG)).toBe(CP_ADMIN_PRINCIPAL);
    expect(isOwnerPrincipal(principalFromTag(CP_ADMIN_TAG))).toBe(false);
  });
  it('owns no row, not even one it is named on', () => {
    expect(ownedBy({ created_by: CP_ADMIN_TAG }, CP_ADMIN_PRINCIPAL)).toBe(false);
    expect(ownedBy({ created_by: 'owner' }, CP_ADMIN_PRINCIPAL)).toBe(false);
    expect(ownedBy(undefined, CP_ADMIN_PRINCIPAL)).toBe(false);
  });
  it('acts under no grant, so it counts as ended, whatever the grants', () => {
    expect(principalHasEnded(CP_ADMIN_PRINCIPAL, () => true)).toBe(true);
  });
});
