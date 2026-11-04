import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader } from './rules-loader.js';
import { createInboxClassifierHook, type AccountResolver, type HookQueue } from './watcher-hook.js';
import { reconcileOutboundReply } from './outbound-reconcile.js';
import type { MailAccountConfig, MailEnvelope } from '../mail/provider.js';
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

  it('keeps the bucket and runs neither a rule nor the classifier', async () => {
    const id = seedReplied('draft_ready');
    inbox.insertRule({ accountId: ACCOUNT.id, matcherKind: 'from', matcherValue: 'kunde@example.com', bucket: 'auto_handled', action: 'show', source: 'on_demand' });
    await hook()(ACCOUNT.id, envelope());
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

  it('the store reopens only a replied item', () => {
    const archived = seedReplied('requires_user', 'archived');
    expect(inbox.reopenReplied(archived, 'default')).toBe(false);
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
