import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader } from './rules-loader.js';
import { createInboxClassifierHook, type AccountResolver, type HookQueue } from './watcher-hook.js';
import { reconcileOutboundReply } from './outbound-reconcile.js';
import type { MailAccountConfig, MailAuthType, MailEnvelope } from '../mail/provider.js';
import type { OutboundContext } from '../mail/context.js';
import type { InboxBucket } from '../../types/index.js';
import type { SensitiveMode } from './sensitive-content.js';

/**
 * Follow-up mails in a thread the inbox already holds (PRD inbox-user-rules E6, part 1b): stored
 * as thread messages, a `replied` item opens again, and a reply to the follow-up closes it again.
 */

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1', displayName: 'Me', address: 'me@acme.example', preset: 'custom',
  imap: { host: 'i', port: 993, secure: true }, smtp: { host: 's', port: 465, secure: true },
  authType: 'imap', type: 'personal', isDefault: true,
};
const THREAD = 'gmail:thread-1';

let mail: MailStateDb;
let inbox: InboxStateDb;
let queued: number;
let queue: HookQueue;
let accounts: AccountResolver;
let notifyNewItem: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
  queued = 0;
  queue = { enqueue: vi.fn(() => { queued++; return true; }) };
  accounts = { resolve: (id: string) => (id === ACCOUNT.id ? { address: ACCOUNT.address, displayName: ACCOUNT.displayName } : null) };
  notifyNewItem = vi.fn(async () => true);
});
afterEach(() => mail.close());

function envelope(overrides: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    uid: 2, messageId: '<follow@x>', folder: 'INBOX', threadKey: THREAD, inReplyTo: '<first@x>',
    from: [{ address: 'kunde@example.com', name: 'Kundin' }], to: [{ address: ACCOUNT.address }], cc: [], replyTo: [],
    subject: 'Re: Bestellung 1043', date: new Date('2026-11-04T09:00:00Z'), flags: [],
    snippet: 'Die Lieferung ist immer noch nicht da.', hasAttachments: false, attachmentCount: 0, sizeBytes: 0,
    isAutoReply: false, ...overrides,
  };
}

/** An item filed from the first mail of the thread, answered by the user. */
function seedReplied(bucket: InboxBucket = 'requires_user', action: 'replied' | 'archived' = 'replied'): string {
  const id = inbox.insertItem({
    accountId: ACCOUNT.id, channel: 'email', threadKey: THREAD, bucket, confidence: 0.9,
    reasonDe: 'Kundin fragt nach der Lieferung', classifiedAt: new Date('2026-11-03T08:00:00Z'),
    classifierVersion: 'v1', messageId: '<first@x>', subject: 'Bestellung 1043', fromAddress: 'kunde@example.com',
  });
  inbox.insertThreadMessage({
    accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<first@x>', fromAddress: 'kunde@example.com',
    subject: 'Bestellung 1043', direction: 'inbound', inboxItemId: id,
  });
  inbox.updateUserAction(id, action, new Date('2026-11-03T09:00:00Z'));
  return id;
}

function hook(sensitiveMode?: SensitiveMode) {
  return createInboxClassifierHook({
    state: inbox, rules: new InboxRulesLoader(inbox), queue, accounts, notifier: { notifyNewItem },
    ...(sensitiveMode !== undefined ? { sensitiveMode } : {}),
  });
}

function messageIds(): string[] {
  return inbox.listThreadMessages(ACCOUNT.id, THREAD).map((m) => m.messageId).sort();
}

describe('follow-up mails in a known thread (part 1b)', () => {
  it('stores a new customer message, opens the replied item again, and it counts again', async () => {
    const id = seedReplied();
    expect(inbox.countItemsByBucket().requires_user).toBe(0);

    expect(await hook()(ACCOUNT.id, envelope())).toBe('duplicate');

    expect(messageIds()).toEqual(['<first@x>', '<follow@x>']);
    const stored = inbox.listThreadMessages(ACCOUNT.id, THREAD).find((m) => m.messageId === '<follow@x>')!;
    expect(stored.snippet).toBe('Die Lieferung ist immer noch nicht da.');
    expect(stored.inboxItemId).toBe(id);
    const item = inbox.getItem(id)!;
    expect(item.userAction).toBeUndefined();
    expect(inbox.countItemsByBucket().requires_user).toBe(1);
    expect(inbox.listAuditForItem(id).map((a) => a.action)).toContain('reopened_on_reply');
  });

  it('a reopened item takes the date of the new message and moves to the top of its list', async () => {
    const id = seedReplied();
    const newer = inbox.insertItem({
      accountId: ACCOUNT.id, channel: 'email', threadKey: 'gmail:thread-2', bucket: 'requires_user', confidence: 0.9,
      reasonDe: 'andere Mail', classifiedAt: new Date('2026-11-03T12:00:00Z'), classifierVersion: 'v1',
      mailDate: new Date('2026-11-03T12:00:00Z'),
    });
    expect(inbox.listItems({ bucket: 'requires_user' }).map((i) => i.id)).toEqual([newer, id]);

    await hook()(ACCOUNT.id, envelope({ date: new Date('2026-11-04T09:00:00Z') }));

    expect(inbox.getItem(id)!.mailDate?.toISOString()).toBe('2026-11-04T09:00:00.000Z');
    expect(inbox.listItems({ bucket: 'requires_user' }).map((i) => i.id)).toEqual([id, newer]);
  });

  it('a follow-up without a date reopens the item with the time it arrived', async () => {
    const id = seedReplied();
    const before = Date.now();
    await hook()(ACCOUNT.id, envelope({ date: undefined as unknown as Date }));
    expect(inbox.getItem(id)!.mailDate!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('an archived item keeps its dates', async () => {
    const id = seedReplied('requires_user', 'archived');
    await hook()(ACCOUNT.id, envelope({ date: new Date('2026-11-04T09:00:00Z') }));
    expect(inbox.getItem(id)!.mailDate).toBeUndefined();
    expect(inbox.getItem(id)!.classifiedAt.toISOString()).toBe('2026-11-03T08:00:00.000Z');
  });

  it('keeps the bucket and runs neither a rule nor the classifier', async () => {
    const id = seedReplied('draft_ready');
    inbox.insertRule({ accountId: ACCOUNT.id, matcherKind: 'from', matcherValue: 'kunde@example.com', bucket: 'auto_handled', action: 'show', source: 'on_demand' });
    await hook()(ACCOUNT.id, envelope());
    expect(messageIds()).toEqual(['<first@x>', '<follow@x>']);
    expect(inbox.getItem(id)!.bucket).toBe('draft_ready');
    expect(inbox.getItem(id)!.userAction).toBeUndefined();
    expect(queued).toBe(0);
    expect(inbox.listAuditForItem(id).map((a) => a.action)).not.toContain('rule_applied');
  });

  it('stores an automatic reply but does not open the item', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope({ isAutoReply: true, messageId: '<ooo@x>', snippet: 'Ich bin bis Montag abwesend.' }));
    expect(messageIds()).toEqual(['<first@x>', '<ooo@x>']);
    expect(inbox.getItem(id)!.userAction).toBe('replied');
    expect(notifyNewItem).not.toHaveBeenCalled();
  });

  it('changes nothing for the same message twice or a message without a Message-ID', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope({ messageId: '<first@x>' }));
    expect(inbox.getItem(id)!.userAction).toBe('replied');
    await hook()(ACCOUNT.id, envelope({ messageId: undefined }));
    expect(inbox.getItem(id)!.userAction).toBe('replied');
    await hook()(ACCOUNT.id, envelope({ messageId: '' }));
    expect(inbox.getItem(id)!.userAction).toBe('replied');
    expect(messageIds()).toEqual(['<first@x>']);
    expect(inbox.listAuditForItem(id).map((a) => a.action)).not.toContain('reopened_on_reply');
  });

  it('a message the store holds already does not open the item a second time', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    inbox.updateUserAction(id, 'replied');
    await hook()(ACCOUNT.id, envelope());
    expect(inbox.getItem(id)!.userAction).toBe('replied');
    expect(inbox.listAuditForItem(id).filter((a) => a.action === 'reopened_on_reply')).toHaveLength(1);
  });

  it('an archived item stays archived, and the message is stored', async () => {
    const id = seedReplied('requires_user', 'archived');
    await hook()(ACCOUNT.id, envelope());
    expect(inbox.getItem(id)!.userAction).toBe('archived');
    expect(messageIds()).toEqual(['<first@x>', '<follow@x>']);
    expect(notifyNewItem).not.toHaveBeenCalled();
  });

  it('a sensitive follow-up is stored without its text on skip, and masked on mask', async () => {
    seedReplied();
    const otp = { subject: 'Ihr Code', snippet: 'Bestätigungscode 482917 ist gültig für 5 Minuten.' };
    await hook()(ACCOUNT.id, envelope({ ...otp, messageId: '<otp1@x>' }));
    const skipped = inbox.listThreadMessages(ACCOUNT.id, THREAD).find((m) => m.messageId === '<otp1@x>')!;
    expect(skipped.snippet ?? null).toBeNull();
    expect(skipped.bodyMd ?? null).toBeNull();

    await hook('mask')(ACCOUNT.id, envelope({ ...otp, messageId: '<otp2@x>' }));
    const masked = inbox.listThreadMessages(ACCOUNT.id, THREAD).find((m) => m.messageId === '<otp2@x>')!;
    expect(masked.snippet).toBeDefined();
    expect(masked.snippet).not.toContain('482917');

    await hook('allow')(ACCOUNT.id, envelope({ ...otp, messageId: '<otp3@x>' }));
    const raw = inbox.listThreadMessages(ACCOUNT.id, THREAD).find((m) => m.messageId === '<otp3@x>')!;
    expect(raw.snippet).toContain('482917');
  });

  it('notifies for a reopened requires_user item, not for another bucket', async () => {
    seedReplied();
    await hook()(ACCOUNT.id, envelope());
    expect(notifyNewItem).toHaveBeenCalledTimes(1);
    expect(notifyNewItem.mock.calls[0]?.[0]).toMatchObject({ bucket: 'requires_user' });

    mail.close();
    mail = new MailStateDb({ path: ':memory:' });
    mail.upsertAccount(ACCOUNT);
    inbox = new InboxStateDb(mail.getConnection());
    notifyNewItem.mockClear();
    seedReplied('draft_ready');
    await hook()(ACCOUNT.id, envelope());
    expect(notifyNewItem).not.toHaveBeenCalled();
  });

  it('our own mail coming back into the thread does not open the item', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope({ from: [{ address: 'ME@acme.example', name: 'Me' }], messageId: '<own@x>' }));
    expect(messageIds()).toEqual(['<first@x>', '<own@x>']);
    expect(inbox.getItem(id)!.userAction).toBe('replied');
  });

  it('a message dated before the reply does not open the item', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope({ date: new Date('2026-11-03T08:30:00Z') }));
    expect(messageIds()).toEqual(['<first@x>', '<follow@x>']);
    expect(inbox.getItem(id)!.userAction).toBe('replied');
  });

  it('a snoozed replied item keeps the snooze the user chose and sends no push while hidden', async () => {
    const id = seedReplied();
    const until = new Date(Date.now() + 86_400_000);
    inbox.setSnooze(id, until, null, /* unsnoozeOnReply */ false, /* notifyOnUnsnooze */ true);
    await hook()(ACCOUNT.id, envelope());
    const after = inbox.getItem(id)!;
    expect(after.userAction).toBeUndefined();
    expect(after.snoozeUntil?.getTime()).toBe(until.getTime());
    expect(after.notifyOnUnsnooze).toBe(true);
    expect(notifyNewItem).not.toHaveBeenCalled();
  });

  it('a snooze that wakes on a reply wakes, and then the push goes out', async () => {
    const id = seedReplied();
    inbox.setSnooze(id, new Date(Date.now() + 86_400_000), null, /* unsnoozeOnReply */ true);
    await hook()(ACCOUNT.id, envelope());
    expect(inbox.getItem(id)!.snoozeUntil).toBeUndefined();
    expect(inbox.getItem(id)!.userAction).toBeUndefined();
    expect(notifyNewItem).toHaveBeenCalledTimes(1);
  });

  it('own-address check ignores case on both sides', async () => {
    const id = seedReplied();
    const h = createInboxClassifierHook({
      state: inbox, rules: new InboxRulesLoader(inbox), queue, notifier: { notifyNewItem },
      accounts: { resolve: () => ({ address: 'Me@Acme.Example', displayName: 'Me' }) },
    });
    await h(ACCOUNT.id, envelope({ from: [{ address: 'me@acme.example' }], messageId: '<own2@x>' }));
    expect(inbox.getItem(id)!.userAction).toBe('replied');
  });

  it('a message dated exactly at the reply does not open the item', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope({ date: new Date('2026-11-03T09:00:00Z') }));
    expect(inbox.getItem(id)!.userAction).toBe('replied');
  });

  it('the reconcile prefers the item of the account the reply leaves from', async () => {
    const other: MailAccountConfig = { ...ACCOUNT, id: 'acct-2', address: 'info@acme.example', isDefault: false };
    mail.upsertAccount(other);
    const mine = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    const theirs = inbox.insertItem({
      accountId: other.id, channel: 'email', threadKey: THREAD, bucket: 'requires_user', confidence: 0.9,
      reasonDe: 'zweites Konto', classifiedAt: new Date('2026-11-05T08:00:00Z'), classifierVersion: 'v1',
    });
    inbox.insertThreadMessage({ accountId: other.id, threadKey: THREAD, messageId: '<follow@x>', fromAddress: 'kunde@example.com', subject: 'Re', direction: 'inbound', inboxItemId: theirs });
    reconcileOutboundReply(inbox, ACCOUNT.id, {
      input: { to: [], subject: 'Re', text: 'ok' }, result: { messageId: '<sent2@x>', accepted: [], rejected: [] },
      isReply: true, originalMessageId: '<follow@x>',
    });
    expect(inbox.getItem(mine)!.userAction).toBe('replied');
    expect(inbox.getItem(theirs)!.userAction).toBeUndefined();
  });

  describe('an account whose watch envelope cannot tell an automatic reply (Graph)', () => {
    function hookFor(authType: MailAuthType, confirm: (id: string, env: MailEnvelope) => Promise<boolean>) {
      return createInboxClassifierHook({
        state: inbox, rules: new InboxRulesLoader(inbox), queue, notifier: { notifyNewItem },
        accounts: { resolve: (id: string) => (id === ACCOUNT.id ? { address: ACCOUNT.address, displayName: ACCOUNT.displayName, authType } : null) },
        confirmAutoReply: confirm,
      });
    }

    it('does not reopen when the fetched message is an automatic reply', async () => {
      const id = seedReplied();
      const confirm = vi.fn(async () => true);
      await hookFor('oauth_microsoft', confirm)(ACCOUNT.id, envelope());
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0]?.[0]).toBe(ACCOUNT.id);
      expect(messageIds()).toEqual(['<first@x>', '<follow@x>']);
      expect(inbox.getItem(id)!.userAction).toBe('replied');
      expect(notifyNewItem).not.toHaveBeenCalled();
    });

    it('reopens when the fetched message is none', async () => {
      const id = seedReplied();
      const confirm = vi.fn(async () => false);
      await hookFor('oauth_microsoft', confirm)(ACCOUNT.id, envelope());
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(inbox.getItem(id)!.userAction).toBeUndefined();
    });

    it('reopens when the lookup fails', async () => {
      const id = seedReplied();
      const confirm = vi.fn(async () => { throw new Error('graph down'); });
      await hookFor('oauth_microsoft', confirm)(ACCOUNT.id, envelope());
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(inbox.getItem(id)!.userAction).toBeUndefined();
    });

    it('Gmail and IMAP never ask, their envelope tells', async () => {
      for (const authType of ['oauth_google', 'imap'] as const) {
        const id = seedReplied();
        const confirm = vi.fn(async () => true);
        await hookFor(authType, confirm)(ACCOUNT.id, envelope({ messageId: `<follow-${authType}@x>` }));
        expect(confirm).not.toHaveBeenCalled();
        expect(inbox.getItem(id)!.userAction).toBeUndefined();
        mail.close();
        mail = new MailStateDb({ path: ':memory:' });
        mail.upsertAccount(ACCOUNT);
        inbox = new InboxStateDb(mail.getConnection());
      }
    });

    it('is not asked when nothing would reopen', async () => {
      seedReplied('requires_user', 'archived');
      const confirm = vi.fn(async () => true);
      await hookFor('oauth_microsoft', confirm)(ACCOUNT.id, envelope());
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  it('the store reopens only a replied item', () => {
    const archived = seedReplied('requires_user', 'archived');
    expect(inbox.reopenReplied(archived, 'default', new Date())).toBe(false);
    expect(inbox.getItem(archived)!.userAction).toBe('archived');
  });

  it('a reply to the follow-up marks the item replied again, also from another account', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    expect(inbox.getItem(id)!.userAction).toBeUndefined();
    const ctx: OutboundContext = {
      input: { to: [], subject: 'Re: Bestellung 1043', text: 'ok' },
      result: { messageId: '<sent@x>', accepted: [], rejected: [] },
      isReply: true,
      originalMessageId: '<follow@x>',
    };
    reconcileOutboundReply(inbox, 'acct-other', ctx);
    expect(inbox.getItem(id)!.userAction).toBe('replied');
    const replied = inbox.listAuditForItem(id).filter((a) => a.action === 'replied');
    expect(JSON.parse(replied.at(-1)!.payloadJson)).toMatchObject({ matchedBy: 'thread_message_id' });
  });
});
