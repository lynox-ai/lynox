import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader, type RuleMatchInput } from './rules-loader.js';
import { MAX_DESCRIPTION_RULES } from './rule-text.js';
import type { MailAccountConfig } from '../mail/provider.js';

let mail: MailStateDb;
let inbox: InboxStateDb;
let loader: InboxRulesLoader;

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1',
  displayName: 'Me',
  address: 'me@acme.example',
  preset: 'custom',
  imap: { host: 'i', port: 993, secure: true },
  smtp: { host: 's', port: 465, secure: true },
  authType: 'imap',
  type: 'personal',
  isDefault: true,
};

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  mail.upsertAccount({ ...ACCOUNT, id: 'acct-2', address: 'other@example.com' });
  inbox = new InboxStateDb(mail.getConnection());
  loader = new InboxRulesLoader(inbox);
});

afterEach(() => {
  mail.close();
});

function input(overrides: Partial<RuleMatchInput> = {}): RuleMatchInput {
  return {
    accountId: 'acct-1',
    from: 'mustermann@example.com',
    subject: 'Strategie-Termin nächste Woche',
    listId: undefined,
    ...overrides,
  };
}

describe('InboxRulesLoader — match kinds', () => {
  it('returns null when no rules exist for the account', () => {
    expect(loader.match(input())).toBeNull();
  });

  it('matches from rule case-insensitively', () => {
    inbox.insertRule({
      accountId: 'acct-1',
      matcherKind: 'from',
      matcherValue: 'NoReply@Stripe.com',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    expect(loader.match(input({ from: 'noreply@stripe.com' }))?.matcherValue).toBe('NoReply@Stripe.com');
  });

  it('matches subject_contains case-insensitively as substring', () => {
    inbox.insertRule({
      accountId: 'acct-1',
      matcherKind: 'subject_contains',
      matcherValue: 'invoice',
      bucket: 'auto_handled',
      action: 'mark_read',
      source: 'on_demand',
    });
    expect(loader.match(input({ subject: 'Your INVOICE for May' }))?.matcherKind).toBe('subject_contains');
    expect(loader.match(input({ subject: 'Strategie-Termin' }))).toBeNull();
  });

  it('matches list_id only when input.listId is present', () => {
    inbox.insertRule({
      accountId: 'acct-1',
      matcherKind: 'list_id',
      matcherValue: 'announcements.example.com',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'proactive_threshold',
    });
    expect(loader.match(input({ listId: 'announcements.example.com' }))?.matcherKind).toBe('list_id');
    expect(loader.match(input({ listId: 'ANNOUNCEMENTS.EXAMPLE.COM' }))?.matcherKind).toBe('list_id');
    expect(loader.match(input({ listId: undefined }))).toBeNull();
    expect(loader.match(input({ listId: 'other.example.com' }))).toBeNull();
  });
});

describe('InboxRulesLoader — ordering and isolation', () => {
  it('returns the first rule that matches (creation order)', () => {
    inbox.insertRule({
      accountId: 'acct-1',
      matcherKind: 'from',
      matcherValue: 'a@x',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
      createdAt: new Date('2026-05-01'),
    });
    inbox.insertRule({
      accountId: 'acct-1',
      matcherKind: 'subject_contains',
      matcherValue: 'foo',
      bucket: 'requires_user',
      action: 'show',
      source: 'on_demand',
      createdAt: new Date('2026-05-02'),
    });
    // Both rules would match this input; first-created wins.
    const m = loader.match(input({ from: 'a@x', subject: 'something foo important' }));
    expect(m?.matcherKind).toBe('from');
  });

  it('does not consider rules from other accounts', () => {
    inbox.insertRule({
      accountId: 'acct-2',
      matcherKind: 'from',
      matcherValue: 'shared@x',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    expect(loader.match(input({ accountId: 'acct-1', from: 'shared@x' }))).toBeNull();
    expect(loader.match(input({ accountId: 'acct-2', from: 'shared@x' }))).not.toBeNull();
  });
});

describe('InboxRulesLoader — only confirmed rules apply, a proposal waits for the owner', () => {
  it('a rule the agent proposed matches nothing until the owner confirms it', () => {
    const p = inbox.proposeRule({ accountId: 'acct-1', matcherKind: 'from', matcherValue: 'waits@x', name: 'W' }, 10);
    const id = p.ok ? p.id : '';
    expect(loader.match(input({ accountId: 'acct-1', from: 'waits@x' }))).toBeNull();
    expect(inbox.confirmRule(id)).toBe(true);
    loader.invalidateAll();
    expect(loader.match(input({ accountId: 'acct-1', from: 'waits@x' }))?.id).toBe(id);
  });
});

describe('InboxRulesLoader — cache', () => {
  it('reads rules from the DB on first match and serves later matches from cache', () => {
    inbox.insertRule({
      accountId: 'acct-1',
      matcherKind: 'from',
      matcherValue: 'a@x',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    const spy = vi.spyOn(inbox, 'listConfirmedRulesForAccount');
    expect(loader.match(input({ from: 'a@x' }))).not.toBeNull();
    expect(loader.match(input({ from: 'a@x' }))).not.toBeNull();
    expect(loader.match(input({ from: 'a@x' }))).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('invalidate(accountId) drops only that entry from the cache', () => {
    inbox.insertRule({
      accountId: 'acct-1',
      matcherKind: 'from',
      matcherValue: 'a@x',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    inbox.insertRule({
      accountId: 'acct-2',
      matcherKind: 'from',
      matcherValue: 'b@x',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    loader.match(input({ accountId: 'acct-1', from: 'a@x' }));
    loader.match(input({ accountId: 'acct-2', from: 'b@x' }));
    const spy = vi.spyOn(inbox, 'listConfirmedRulesForAccount');
    loader.invalidate('acct-1');
    loader.match(input({ accountId: 'acct-1', from: 'a@x' }));
    loader.match(input({ accountId: 'acct-2', from: 'b@x' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('acct-1', undefined);
  });

  it('invalidateAll() drops every entry', () => {
    inbox.insertRule({
      accountId: 'acct-1',
      matcherKind: 'from',
      matcherValue: 'a@x',
      bucket: 'auto_handled',
      action: 'archive',
      source: 'on_demand',
    });
    loader.match(input({ from: 'a@x' }));
    const spy = vi.spyOn(inbox, 'listConfirmedRulesForAccount');
    loader.invalidateAll();
    loader.match(input({ from: 'a@x' }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('InboxRulesLoader — description rules (PRD inbox-user-rules E3)', () => {
  it('match() never applies a description rule, even when its text is in the sender or subject', () => {
    inbox.insertRule({ accountId: 'acct-1', matcherKind: 'matches_description', matcherValue: 'Strategie', bucket: 'auto_handled', action: 'archive', source: 'on_demand' });
    inbox.insertRule({ accountId: 'acct-1', matcherKind: 'matches_description', matcherValue: 'mustermann@example.com', bucket: 'auto_handled', action: 'archive', source: 'on_demand' });
    expect(loader.match(input())).toBeNull();
    expect(loader.descriptionRules('acct-1')).toHaveLength(2);
  });

  it('descriptionRules() returns only confirmed description rules of the account, in confirmation order', () => {
    const fixed = inbox.insertRule({ accountId: 'acct-1', matcherKind: 'from', matcherValue: 'a@x.example', bucket: 'requires_user', action: 'show', source: 'on_demand' });
    const a = inbox.proposeRule({ accountId: 'acct-1', matcherKind: 'matches_description', matcherValue: 'Rechnungen von Lieferanten', name: 'A' }, 10, new Date(1_000));
    const b = inbox.proposeRule({ accountId: 'acct-1', matcherKind: 'matches_description', matcherValue: 'Terminanfragen', name: 'B' }, 10, new Date(2_000));
    const waiting = inbox.proposeRule({ accountId: 'acct-1', matcherKind: 'matches_description', matcherValue: 'Newsletter', name: 'C' }, 10, new Date(3_000));
    inbox.insertRule({ accountId: 'acct-2', matcherKind: 'matches_description', matcherValue: 'fremdes Konto', bucket: 'requires_user', action: 'show', source: 'on_demand' });
    if (!a.ok || !b.ok || !waiting.ok) throw new Error('propose failed');
    expect(inbox.confirmRule(b.id, undefined, new Date(5_000))).toBe(true);
    expect(inbox.confirmRule(a.id, undefined, new Date(6_000))).toBe(true);
    loader.invalidateAll();
    const ids = loader.descriptionRules('acct-1').map((r) => r.id);
    expect(ids).toEqual([b.id, a.id]);
    expect(ids).not.toContain(fixed);
    expect(ids).not.toContain(waiting.id);
  });

  it('descriptionRules() reads at most MAX_DESCRIPTION_RULES, the first confirmed, even when the database holds more', () => {
    const ids = Array.from({ length: MAX_DESCRIPTION_RULES + 5 }, (_, i) =>
      inbox.insertRule({ accountId: 'acct-1', matcherKind: 'matches_description', matcherValue: `Beschreibung ${String(i)}`, bucket: 'requires_user', action: 'show', source: 'on_demand', createdAt: new Date(1_000 + i) }));
    expect(loader.descriptionRules('acct-1').map((r) => r.id)).toEqual(ids.slice(0, MAX_DESCRIPTION_RULES));
  });
});
