import { describe, it, expect } from 'vitest';
import { OWNER_PRINCIPAL, ownedBy, principalFromTag, principalTag, type RequestPrincipal } from './request-principal.js';

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
