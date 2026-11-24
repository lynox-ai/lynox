import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader } from './rules-loader.js';
import { createInboxClassifierHook, type AccountResolver, type HookQueue } from './watcher-hook.js';
import { createInboxNotifier, FLAGGED_PUSH_TEXT, type InboxNotifier, type InboxNotifyOptions } from './notifier.js';
import type { MailAccountConfig, MailEnvelope } from '../mail/provider.js';
import type { InboxItem } from '../../types/index.js';
import type { NotificationMessage, NotificationRouter } from '../../core/notification-router.js';

/**
 * A follow-up that opens a replied item again pushes. The push names the follow-up's own sender
 * when that is someone other than the item's sender; a confidential follow-up keeps the fixed text.
 */

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1', displayName: 'Me', address: 'me@acme.example', preset: 'custom',
  imap: { host: 'i', port: 993, secure: true }, smtp: { host: 's', port: 465, secure: true },
  authType: 'imap', type: 'personal', isDefault: true,
};
const THREAD = 'gmail-thread-1';

let mail: MailStateDb;
let inbox: InboxStateDb;
let notified: Array<{ item: InboxItem; opts: InboxNotifyOptions | undefined }>;
let notifier: InboxNotifier;
const queue: HookQueue = { enqueue: () => true };
const accounts: AccountResolver = {
  resolve: (id: string) => (id === ACCOUNT.id ? { address: ACCOUNT.address, displayName: ACCOUNT.displayName } : null),
};

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
  notified = [];
  notifier = { notifyNewItem: vi.fn(async (item: InboxItem, opts?: InboxNotifyOptions) => { notified.push({ item, opts }); return true; }) };
  const id = inbox.insertItem({
    accountId: ACCOUNT.id, channel: 'email', threadKey: THREAD, bucket: 'requires_user', confidence: 0.9,
    reasonDe: 'Offertanfrage', classifiedAt: new Date('2026-11-23T08:00:00Z'), classifierVersion: 'v1',
    messageId: '<first@x>', subject: 'Offerte', fromAddress: 'kunde@example.com', fromName: 'Kundin',
  });
  inbox.insertThreadMessage({
    accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<first@x>', fromAddress: 'kunde@example.com',
    subject: 'Offerte', direction: 'inbound', inboxItemId: id,
  });
  inbox.updateUserAction(id, 'replied', new Date('2026-11-23T09:00:00Z'));
});
afterEach(() => mail.close());

function followUp(from: { address: string; name?: string }, overrides: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    uid: 2, folder: 'INBOX', messageId: '<follow@x>', threadKey: THREAD, inReplyTo: '<first@x>',
    from: [from], to: [{ address: ACCOUNT.address }], cc: [], replyTo: [],
    subject: 'Re: Offerte', date: new Date('2026-11-24T09:05:00Z'), flags: [], snippet: 'Kurze Ergänzung.',
    hasAttachments: false, attachmentCount: 0, sizeBytes: 0, isAutoReply: false, ...overrides,
  };
}

async function reopenWith(env: MailEnvelope): Promise<InboxNotifyOptions | undefined> {
  const hook = createInboxClassifierHook({ state: inbox, rules: new InboxRulesLoader(inbox), queue, accounts, notifier });
  expect(await hook(ACCOUNT.id, env)).toBe('duplicate');
  expect(notified).toHaveLength(1);
  return notified[0]!.opts;
}

describe('the push for an item a follow-up opened again', () => {
  it('names nobody else when the follow-up comes from the item\'s sender, in any case', async () => {
    const opts = await reopenWith(followUp({ address: 'KUNDE@example.com', name: 'Kundin' }));
    expect(opts?.sender).toBeUndefined();
  });

  it('names the follow-up\'s sender when it is someone else', async () => {
    const opts = await reopenWith(followUp({ address: 'kollege@example.com', name: 'Kollege' }));
    expect(opts?.sender).toEqual({ address: 'kollege@example.com', name: 'Kollege' });
  });

  it('keeps the confidential flag for a flagged follow-up from someone else', async () => {
    const opts = await reopenWith(followUp(
      { address: 'kollege@example.com', name: 'Kollege' },
      { subject: 'Dein Sicherheitscode', snippet: 'Bestätigungscode: 482917 — gültig für 5 Minuten.' },
    ));
    expect(opts?.flagged).toBe(true);
  });
});

describe('the push text', () => {
  it('is built from the given sender, and stays the fixed text for a confidential message', async () => {
    const sent: NotificationMessage[] = [];
    const router = { sendTo: vi.fn(async (_c: string, m: NotificationMessage) => { sent.push(m); return true; }) } as unknown as NotificationRouter;
    const push = createInboxNotifier({ router, perMinute: () => 10, perHour: () => 100, language: () => 'de' });
    const item = { id: 'i1', accountId: ACCOUNT.id, bucket: 'requires_user', fromAddress: 'kunde@example.com', fromName: 'Kundin', subject: 'Offerte', reasonDe: '' } as unknown as InboxItem;
    await push.notifyNewItem(item, {});
    await push.notifyNewItem(item, { sender: { address: 'kollege@example.com', name: 'Kollege' } });
    await push.notifyNewItem(item, { sender: { address: 'kollege@example.com' } });
    await push.notifyNewItem(item, { sender: { address: 'kol<b>lege@example.com', name: 'Kol\u202Elege' } });
    await push.notifyNewItem(item, { flagged: true, sender: { address: 'kollege@example.com', name: 'Kollege' } });
    expect(sent.map((m) => m.body)).toEqual([
      'Kundin: Offerte',
      'Kollege: Offerte',
      'kollege@example.com: Offerte',
      'Kollege: Offerte',
      FLAGGED_PUSH_TEXT.de,
    ]);
  });
});
