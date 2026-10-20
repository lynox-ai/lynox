import { describe, it, expect } from 'vitest';
import { CP_ADMIN_PRINCIPAL, CP_ADMIN_TAG, OWNER_PRINCIPAL, isMandateTag, isOwnerPrincipal, ownedBy, planMandate, planMembers, principalFromTag, principalHasEnded, principalTag, type RequestPrincipal } from './request-principal.js';

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

describe('planMandate — the mandate a plan runs for', () => {
  const EVA = 'mandate:eva@kanzlei.example';
  const JAN = 'mandate:jan@treuhand.example';
  it('names the last mandate that changed the plan, with that change\'s grant and time', () => {
    const m = planMandate({ created_by: EVA, created_mandate_id: 'g-eva', created_at: '2026-10-01T00:00:00.000Z', mandate_editor: JAN, mandate_editor_id: 'g-jan', mandate_edited_at: '2026-10-02 08:00:00' });
    expect(m?.principal).toEqual({ kind: 'mandate', email: 'jan@treuhand.example', mandateId: 'g-jan' });
    expect(m?.at).toBe(Date.parse('2026-10-02T08:00:00Z'));
  });
  it('without a mandate editor, names the mandate that created it, at its creation', () => {
    const m = planMandate({ created_by: EVA, created_mandate_id: 'g-eva', created_at: '2026-10-01T00:00:00.000Z' });
    expect(m?.principal).toEqual({ kind: 'mandate', email: 'eva@kanzlei.example', mandateId: 'g-eva' });
    expect(m?.at).toBe(Date.parse('2026-10-01T00:00:00.000Z'));
  });
  it('a plan the owner created and only the owner changed names nobody', () => {
    expect(planMandate({ created_by: 'owner', created_at: '2026-10-01T00:00:00.000Z' })).toBeUndefined();
    expect(planMandate({ created_by: null, created_at: '2026-10-01T00:00:00.000Z' })).toBeUndefined();
    expect(planMandate({})).toBeUndefined();
  });
  it('an owner\'s plan a mandate changed later names that mandate', () => {
    expect(planMandate({ created_by: 'owner', mandate_editor: JAN, mandate_editor_id: 'g-jan' })?.principal.email).toBe('jan@treuhand.example');
  });
  it('a mark without a grant id names the mandate without one, which counts as ended', () => {
    const m = planMandate({ created_by: EVA });
    expect(m?.principal).toEqual({ kind: 'mandate', email: 'eva@kanzlei.example' });
    expect(principalHasEnded(m!.principal, () => true)).toBe(true);
    expect(m?.at).toBe(-Infinity);
  });
});

describe('planMembers — whom a plan\'s run depends on, and whom it runs for', () => {
  const at = (email: string, mandateId: string, t: number) => ({ principal: { kind: 'mandate' as const, email, mandateId }, at: t });
  it('the owner\'s plan depends on nobody and runs for nobody', () => {
    expect(planMembers(undefined, undefined)).toEqual({ members: [] });
  });
  it('depends on both mandates and runs for the one that changed it last, either way round', () => {
    const a = at('a@x.example', 'g-a', 1);
    const b = at('b@x.example', 'g-b', 2);
    expect(planMembers(a, b)).toEqual({ of: b.principal, members: [a.principal, b.principal] });
    expect(planMembers(b, a)).toEqual({ of: b.principal, members: [b.principal, a.principal] });
  });
  it('one person under two grants is two members', () => {
    const r = planMembers(at('a@x.example', 'g-1', 1), at('a@x.example', 'g-2', 2));
    expect(r.members.map((m) => (m.kind === 'mandate' ? m.mandateId : undefined))).toEqual(['g-1', 'g-2']);
  });
  it('a tie, and two undated marks, go to the schedule', () => {
    const t = at('t@x.example', 'g-t', 5);
    const w = at('w@x.example', 'g-w', 5);
    expect(planMembers(t, w).of).toEqual(t.principal);
    expect(planMembers(at('t@x.example', 'g-t', -Infinity), at('w@x.example', 'g-w', -Infinity)).of?.email).toBe('t@x.example');
  });
  it('only the workflow\'s mandate', () => {
    const w = at('w@x.example', 'g-w', 1);
    expect(planMembers(undefined, w)).toEqual({ of: w.principal, members: [w.principal] });
  });
});
