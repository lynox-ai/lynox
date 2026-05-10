import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader, type RuleMatchInput } from './rules-loader.js';
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
    const spy = vi.spyOn(inbox, 'listRulesForAccount');
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
    const spy = vi.spyOn(inbox, 'listRulesForAccount');
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
    const spy = vi.spyOn(inbox, 'listRulesForAccount');
    loader.invalidateAll();
    loader.match(input({ from: 'a@x' }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
