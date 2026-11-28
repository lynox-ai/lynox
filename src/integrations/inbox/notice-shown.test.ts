import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader } from './rules-loader.js';
import { createInboxClassifierHook, type AccountResolver, type HookQueue } from './watcher-hook.js';
import { followUpsOf } from './follow-ups.js';
import { handleGetItem, handleGetItemContext, handleGetItemFull, handleListItems, type InboxApiDeps } from './api.js';
import { resolveChatContext } from '../../core/chat-context.js';
import type { MailAccountConfig, MailEnvelope } from '../mail/provider.js';
import type { InboxItem, InboxItemShown } from '../../types/index.js';
import type { SensitiveMode } from './sensitive-content.js';

/**
 * An item created by a delivery failure notice keeps the notice as its own mail. When a real mail
 * comes into the thread after it, the API adds `shown`, taken from that one mail, for the list row;
 * no field of the item changes, so its follow-ups, "Reply in chat" and later joins stay anchored.
 */

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1', displayName: 'Me', address: 'me@acme.example', preset: 'custom',
  imap: { host: 'i', port: 993, secure: true }, smtp: { host: 's', port: 465, secure: true },
  authType: 'imap', type: 'personal', isDefault: true,
};
const THREAD = 'gmail:thread-notice';
const T_NOTICE = new Date('2026-11-20T09:00:00Z');
const T_REAL = new Date('2026-11-20T10:00:00Z');
const T_LATER = new Date('2026-11-21T08:00:00Z');

let mail: MailStateDb;
let inbox: InboxStateDb;
let deps: InboxApiDeps;
let queue: HookQueue;
let accounts: AccountResolver;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
  deps = { state: inbox };
  queue = { enqueue: vi.fn(() => true) };
  accounts = { resolve: (id: string) => (id === ACCOUNT.id ? { address: ACCOUNT.address, displayName: ACCOUNT.displayName } : null) };
});
afterEach(() => mail.close());

function hook(sensitiveMode?: SensitiveMode) {
  const h = createInboxClassifierHook({
    state: inbox, rules: new InboxRulesLoader(inbox), queue, accounts, notifier: { notifyNewItem: vi.fn(async () => true) },
    ...(sensitiveMode !== undefined ? { sensitiveMode } : {}),
  });
  return (env: MailEnvelope) => h(ACCOUNT.id, env);
}

function envelope(o: Partial<MailEnvelope> & { messageId: string; from: MailEnvelope['from']; date: Date }): MailEnvelope {
  return {
    uid: 1, folder: 'INBOX', threadKey: THREAD, inReplyTo: undefined,
    to: [{ address: ACCOUNT.address }], cc: [], replyTo: [], subject: 'Frage zur Offerte', flags: [],
    snippet: 'Können Sie mir die Offerte noch einmal senden?', hasAttachments: false, attachmentCount: 0, sizeBytes: 0,
    isAutoReply: false, ...o,
  };
}

const notice = (): MailEnvelope => envelope({
  uid: 5, messageId: '<notice@x>', from: [{ address: 'mailer-daemon@post.example', name: 'Mail Delivery System' }],
  date: T_NOTICE, subject: 'Undelivered Mail Returned to Sender', snippet: 'Delivery to the following recipient failed.',
});
const real = (over: Partial<MailEnvelope> = {}): MailEnvelope => envelope({
  uid: 6, messageId: '<real@x>', from: [{ address: 'anna@kunde.example', name: 'Anna Kunde' }], date: T_REAL, ...over,
});
const OTP = { subject: 'Ihr Code', snippet: 'Bestätigungscode 482917 ist gültig für 5 Minuten.' };

function listed(): InboxItem {
  const res = handleListItems(deps, {});
  const items = (res.body as { items: InboxItem[] }).items;
  expect(items).toHaveLength(1);
  return items[0]!;
}

/** The item as the API sends it: JSON, as the list, the item and the full item serialize it. */
function wire(): { list: Record<string, unknown>; item: Record<string, unknown>; full: Record<string, unknown> } {
  const id = inbox.listItems()[0]!.id;
  const j = (v: unknown) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
  return {
    list: j((handleListItems(deps, {}).body as { items: unknown[] }).items[0]),
    item: j((handleGetItem(deps, id).body as { item: unknown }).item),
    full: j((handleGetItemFull(deps, id).body as { item: unknown }).item),
  };
}

async function noticeItem(): Promise<string> {
  expect(await hook()(notice())).toBe('prefilter_filed');
  const item = inbox.listItems()[0]!;
  expect(item.prefilterRule).toBe('bounce');
  return item.id;
}

describe('the mail the row of a delivery failure notice shows', () => {
  it('name, subject, address and Message-ID all come from the newest follow-up, the item fields stay the notice', async () => {
    const id = await noticeItem();
    expect(await hook()(real())).toBe('duplicate');

    const item = listed();
    const newest = followUpsOf(inbox, inbox.getItem(id)!)[0]!;
    expect(item.shown).toEqual({
      fromAddress: newest.fromAddress, fromName: newest.fromName, subject: newest.subject, messageId: newest.messageId,
      mailDate: newest.mailDate!.toISOString(), sensitive: false,
    } satisfies InboxItemShown);
    expect(item.shown).toEqual({
      fromAddress: 'anna@kunde.example', fromName: 'Anna Kunde', subject: 'Frage zur Offerte', messageId: '<real@x>',
      mailDate: T_REAL.toISOString(), sensitive: false,
    });
    // Nothing of the item is changed: its own mail is still the notice.
    expect({ fromAddress: item.fromAddress, fromName: item.fromName, subject: item.subject, messageId: item.messageId })
      .toEqual({ fromAddress: 'mailer-daemon@post.example', fromName: 'Mail Delivery System', subject: 'Undelivered Mail Returned to Sender', messageId: '<notice@x>' });
    const stored = inbox.getItem(id)!;
    expect(stored.messageId).toBe('<notice@x>');
    expect(stored.fromAddress).toBe('mailer-daemon@post.example');
  });

  it('the newest of several follow-ups is shown, and the list, the item and the full item send the same', async () => {
    await noticeItem();
    await hook()(real());
    await hook()(real({ uid: 7, messageId: '<second@x>', from: [{ address: 'ben@kunde.example', name: 'Ben Kunde' }], date: T_LATER, subject: 'Noch eine Frage' }));
    const { list, item, full } = wire();
    expect(list['shown']).toEqual({ fromAddress: 'ben@kunde.example', fromName: 'Ben Kunde', subject: 'Noch eine Frage', messageId: '<second@x>', mailDate: T_LATER.toISOString(), sensitive: false });
    expect(item['shown']).toEqual(list['shown']);
    expect(full['shown']).toEqual(list['shown']);
    expect(list['subject']).toBe('Undelivered Mail Returned to Sender');
  });

  it('after the owner archives it, and after a later follow-up raises it, the row still shows a real mail', async () => {
    const id = await noticeItem();
    await hook()(real());
    inbox.updateUserAction(id, 'archived', new Date('2026-11-20T11:00:00Z'));
    inbox.appendAudit({ itemId: id, action: 'archived', actor: 'user', payloadJson: JSON.stringify({ undo_logged: true }) });

    const archived = listed();
    expect(archived.userAction).toBe('archived');
    expect(archived.followUps, 'the follow-up count ends with the owner action').toBeUndefined();
    expect(archived.shown?.messageId, 'the row does not fall back to the notice').toBe('<real@x>');

    // A flagged mail raises the item: a raise rewrites the classifier version, not the prefilter rule.
    await hook()(real({ uid: 8, messageId: '<raise@x>', date: T_LATER, ...OTP }));
    const raised = inbox.getItem(id)!;
    expect(raised.classifierVersion).toBe('sensitive-follow-up');
    expect(raised.prefilterRule, 'still tells a notice item after a raise').toBe('bounce');
    expect(inbox.listItems().filter((i) => i.prefilterRule === 'bounce'), 'counts as one notice item').toHaveLength(1);
    expect(listed().shown?.messageId).toBe('<raise@x>');
    expect(listed().messageId).toBe('<notice@x>');
  });

  it('a sensitive shown mail under skip: address, Message-ID and date, no name and no subject anywhere on the wire', async () => {
    await noticeItem();
    await hook('skip')(real({ ...OTP, from: [{ address: 'bank@bank.example', name: 'Hausbank Support' }] }));
    const { list, item, full } = wire();
    for (const sent of [list, item, full]) {
      expect(sent['shown']).toEqual({ fromAddress: 'bank@bank.example', messageId: '<real@x>', mailDate: T_REAL.toISOString(), sensitive: true });
      const text = JSON.stringify(sent);
      expect(text).not.toContain('Hausbank Support');
      expect(text).not.toContain('Ihr Code');
    }
  });
});

describe('rows without a shown mail', () => {
  it('an item whose own mail is no delivery failure notice', async () => {
    const id = inbox.insertItem({
      accountId: ACCOUNT.id, channel: 'email', threadKey: THREAD, bucket: 'requires_user', confidence: 0.9,
      reasonDe: 'Kundin fragt', classifiedAt: T_NOTICE, classifierVersion: 'prefilter', messageId: '<first@x>',
      subject: 'Bestellung', fromAddress: 'kunde@example.com', mailDate: T_NOTICE,
    }).id;
    inbox.insertThreadMessage({ accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<first@x>', fromAddress: 'kunde@example.com', subject: 'Bestellung', direction: 'inbound', inboxItemId: id, mailDate: T_NOTICE });
    await hook()(real());
    const item = listed();
    expect(item.followUps?.count).toBe(1);
    expect(item.prefilterRule).toBeUndefined();
    expect(item.shown).toBeUndefined();
    expect('shown' in wire().list).toBe(false);
  });

  it('a notice item without any real mail after it', async () => {
    await noticeItem();
    expect(listed().shown).toBeUndefined();
  });

  it('a notice item whose only later mail is an automatic reply', async () => {
    await noticeItem();
    await hook()(real({ isAutoReply: true, subject: 'Abwesend bis Montag' }));
    expect(inbox.listThreadMessages(ACCOUNT.id, THREAD)).toHaveLength(2);
    expect(listed().shown).toBeUndefined();
  });
});

describe('the sender context of a notice item', () => {
  it('names the sender of the shown mail, not the notice', async () => {
    const id = await noticeItem();
    await hook()(real());
    const body = handleGetItemContext(deps, id).body as { sender: { address: string; name: string | null } };
    expect(body.sender).toEqual({ address: 'anna@kunde.example', name: 'Anna Kunde' });
  });

  it('a sensitive shown mail: its address, no name', async () => {
    const id = await noticeItem();
    await hook('skip')(real({ ...OTP, from: [{ address: 'bank@bank.example', name: 'Hausbank Support' }] }));
    const body = handleGetItemContext(deps, id).body as { sender: { address: string; name: string | null } };
    expect(body.sender).toEqual({ address: 'bank@bank.example', name: null });
  });

  it('without a shown mail it names the item sender, as before', async () => {
    const id = await noticeItem();
    const body = handleGetItemContext(deps, id).body as { sender: { address: string; name: string | null } };
    expect(body.sender).toEqual({ address: 'mailer-daemon@post.example', name: 'Mail Delivery System' });
  });
});

describe('"Reply in chat" on a notice item', () => {
  it('the chat context answers the mail the row shows', async () => {
    const id = await noticeItem();
    await hook()(real());
    const shown = listed().shown!;
    const out = resolveChatContext(null, { kind: 'mail', id }, inbox)!;
    expect(out).toContain(shown.messageId);
    expect(out).toContain(shown.fromAddress);
    expect(out).not.toContain('mailer-daemon@post.example');
  });
});
