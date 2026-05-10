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
  name: 'Roland Beispiel',
  email: 'roland@war.example',
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
    new InboxContactResolver(crm).resolve('Roland@WAR.example');
    expect(findContact).toHaveBeenCalledWith({ email: 'roland@war.example' });
  });

  it('returns the normalized record when the CRM has a match', () => {
    const findContact = vi.fn(() => ROLAND);
    const crm = makeCrm({ findContact });
    const out = new InboxContactResolver(crm).resolve('roland@war.example');
    expect(out).toEqual({
      name: 'Roland Beispiel',
      email: 'roland@war.example',
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
    const out = new InboxContactResolver(crm).resolve('roland@war.example');
    expect(getInteractions).toHaveBeenCalledWith('Roland Beispiel', 1);
    expect(out?.lastInteractionAt?.toISOString()).toBe('2026-05-01T10:00:00.000Z');
    expect(out?.lastInteractionSummary).toBe('Pricing discussion');
  });

  it('handles interactions without dates gracefully', () => {
    const findContact = vi.fn(() => ROLAND);
    const getInteractions = vi.fn(() => [{ summary: 'note' }]);
    const crm = makeCrm({ findContact, getInteractions });
    const out = new InboxContactResolver(crm).resolve('roland@war.example');
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
