import { describe, expect, it, vi } from 'vitest';
import type { CRM, ContactRecord } from '../../core/crm.js';
import { InboxContactResolver } from './contact-resolver.js';

function makeCrm(overrides: Partial<{
  findContact: CRM['findContact'];
  getInteractions: CRM['getInteractions'];
}> = {}): CRM {
  return {
    findContact: overrides.findContact ?? vi.fn(() => null),
    getInteractions: overrides.getInteractions ?? vi.fn(() => []),
  } as unknown as CRM;
}

const ROLAND: ContactRecord = {
  name: 'Max Mustermann',
  email: 'mustermann@example.com',
  company: 'War Industries',
  type: 'customer',
};

describe('InboxContactResolver — lookup', () => {
  it('returns null when the CRM has no record', () => {
    const crm = makeCrm();
    const out = new InboxContactResolver(crm).resolve('unknown@example.com');
    expect(out).toBeNull();
  });

  it('returns null on empty / whitespace input without hitting the CRM', () => {
    const findContact = vi.fn(() => null);
    const crm = makeCrm({ findContact });
    expect(new InboxContactResolver(crm).resolve('')).toBeNull();
    expect(new InboxContactResolver(crm).resolve('   ')).toBeNull();
    expect(findContact).not.toHaveBeenCalled();
  });

  it('lowercases the email before querying', () => {
    const findContact = vi.fn(() => null);
    const crm = makeCrm({ findContact });
    new InboxContactResolver(crm).resolve('Max@EXAMPLE.com');
    expect(findContact).toHaveBeenCalledWith({ email: 'max@example.com' });
  });

  it('returns the normalized record when the CRM has a match', () => {
    const findContact = vi.fn(() => ROLAND);
    const crm = makeCrm({ findContact });
    const out = new InboxContactResolver(crm).resolve('mustermann@example.com');
    expect(out).toEqual({
      name: 'Max Mustermann',
      email: 'mustermann@example.com',
      company: 'War Industries',
      type: 'customer',
      lastInteractionAt: undefined,
      lastInteractionSummary: undefined,
    });
  });
});

describe('InboxContactResolver — last interaction enrichment', () => {
  it('attaches the most recent interaction when one exists', () => {
    const findContact = vi.fn(() => ROLAND);
    const getInteractions = vi.fn(() => [
      { date: '2026-05-01T10:00:00Z', summary: 'Pricing discussion' },
    ]);
    const crm = makeCrm({ findContact, getInteractions });
    const out = new InboxContactResolver(crm).resolve('mustermann@example.com');
    expect(getInteractions).toHaveBeenCalledWith('Max Mustermann', 1);
    expect(out?.lastInteractionAt?.toISOString()).toBe('2026-05-01T10:00:00.000Z');
    expect(out?.lastInteractionSummary).toBe('Pricing discussion');
  });

  it('handles interactions without dates gracefully', () => {
    const findContact = vi.fn(() => ROLAND);
    const getInteractions = vi.fn(() => [{ summary: 'note' }]);
    const crm = makeCrm({ findContact, getInteractions });
    const out = new InboxContactResolver(crm).resolve('mustermann@example.com');
    expect(out?.lastInteractionAt).toBeUndefined();
    expect(out?.lastInteractionSummary).toBe('note');
  });

  it('falls back to the input email when CRM record omits it', () => {
    const findContact = vi.fn(() => ({ name: 'Anon' } as ContactRecord));
    const crm = makeCrm({ findContact });
    const out = new InboxContactResolver(crm).resolve('Anon@Example.com');
    expect(out?.email).toBe('anon@example.com');
  });
});
