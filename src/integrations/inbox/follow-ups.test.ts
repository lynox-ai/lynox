import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader } from './rules-loader.js';
import { createInboxClassifierHook, type HookQueue } from './watcher-hook.js';
import { handleGetItem, handleGetItemFull, handleListItems } from './api.js';
import type { MailAccountConfig, MailEnvelope } from '../mail/provider.js';
import type { SensitiveMode } from './sensitive-content.js';

/**
 * Mail that comes into an open item's thread after its own mail: the inbox API says how many
 * and from whom, so the list and the reading pane do not let the first mail's reason stand for it.
 */

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1', displayName: 'Me', address: 'me@acme.example', preset: 'custom',
  imap: { host: 'i', port: 993, secure: true }, smtp: { host: 's', port: 465, secure: true },
  authType: 'imap', type: 'personal', isDefault: true,
};
const THREAD = 'gmail:thread-1';

let mail: MailStateDb;
let inbox: InboxStateDb;
let queue: HookQueue;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
  queue = { enqueue: vi.fn(() => true) };
});
afterEach(() => mail.close());

function envelope(overrides: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    uid: 2, messageId: '<follow@x>', folder: 'INBOX', threadKey: THREAD, inReplyTo: '<first@x>',
    from: [{ address: 'kunde@example.com', name: 'Kundin Muster' }], to: [{ address: ACCOUNT.address }], cc: [], replyTo: [],
    subject: 'Re: Lieferung', date: new Date('2026-11-04T09:00:00Z'), flags: [],
    snippet: 'Die Lieferung ist immer noch nicht da.', hasAttachments: false, attachmentCount: 0, sizeBytes: 0,
    isAutoReply: false, ...overrides,
  };
}

/** An item filed from the first mail of the thread (dated 2026-11-03 08:00), answered by the user. */
function seedReplied(): string {
  const id = inbox.insertItem({
    accountId: ACCOUNT.id, channel: 'email', threadKey: THREAD, bucket: 'requires_user', confidence: 0.9,
    reasonDe: 'Kundin fragt nach der Lieferung', classifiedAt: new Date('2026-11-03T08:00:00Z'),
    classifierVersion: 'v1', messageId: '<first@x>', subject: 'Lieferung', fromAddress: 'kunde@example.com',
  });
  inbox.insertThreadMessage({
    accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<first@x>', fromAddress: 'kunde@example.com',
    subject: 'Lieferung', direction: 'inbound', inboxItemId: id, mailDate: new Date('2026-11-03T08:00:00Z'),
  });
  inbox.updateUserAction(id, 'replied', new Date('2026-11-03T09:00:00Z'));
  return id;
}

function hook(sensitiveMode?: SensitiveMode) {
  return createInboxClassifierHook({
    state: inbox, rules: new InboxRulesLoader(inbox), queue, accounts: { resolve: () => ({ address: ACCOUNT.address, displayName: 'Me' }) },
    ...(sensitiveMode !== undefined ? { sensitiveMode } : {}),
  });
}

const wire = (body: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
const deps = () => ({ state: inbox });

function followUpsOnEveryRoute(id: string): unknown[] {
  const list = (wire(handleListItems(deps(), {}).body)['items'] as Array<Record<string, unknown>>).find((i) => i['id'] === id);
  const one = wire(handleGetItem(deps(), id).body)['item'] as Record<string, unknown>;
  const full = wire(handleGetItemFull(deps(), id).body)['item'] as Record<string, unknown>;
  return [list?.['followUps'], one['followUps'], full['followUps']];
}

describe('an open item whose thread got new mail after its own says so on every item route', () => {
  it('one follow-up: count, date, sender name and the thread row to jump to', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    const row = inbox.listThreadMessages(ACCOUNT.id, THREAD).find((m) => m.messageId === '<follow@x>')!;
    for (const f of followUpsOnEveryRoute(id)) {
      expect(f).toEqual({ count: 1, latestAt: '2026-11-04T09:00:00.000Z', latestFromName: 'Kundin Muster', latestMessageId: row.id });
    }
  });

  it('two follow-ups: counts both and names the newest', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    await hook()(ACCOUNT.id, envelope({
      messageId: '<follow2@x>', uid: 3, date: new Date('2026-11-05T10:00:00Z'), from: [{ address: 'chef@example.com', name: 'Chef Muster' }],
    }));
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 2, latestAt: '2026-11-05T10:00:00.000Z', latestFromName: 'Chef Muster' });
  });

  it('an item without follow-ups carries none', () => {
    const id = seedReplied();
    inbox.updateUserAction(id, null, null);
    expect(followUpsOnEveryRoute(id)).toEqual([undefined, undefined, undefined]);
  });
});

describe('what is not counted, and when the name is left out', () => {
  it('an item the owner acted on again carries no line', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    inbox.updateUserAction(id, 'archived', new Date('2026-11-04T10:00:00Z'));
    expect(followUpsOnEveryRoute(id)).toEqual([undefined, undefined, undefined]);
  });

  it('an automatic reply, our own copy and a mail older than the item own one are not follow-ups', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    inbox.insertThreadMessage({ accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<ooo@x>', fromAddress: 'kunde@example.com', fromName: 'Kundin Muster', subject: 'Abwesend', direction: 'inbound', autoReply: true, mailDate: new Date('2026-11-06T08:00:00Z') });
    inbox.insertThreadMessage({ accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<own@x>', fromAddress: ACCOUNT.address, subject: 'Re: Lieferung', direction: 'outbound', autoReply: false, mailDate: new Date('2026-11-04T08:30:00Z') });
    inbox.insertThreadMessage({ accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<old@x>', fromAddress: 'kunde@example.com', subject: 'Frühere', direction: 'inbound', autoReply: false, mailDate: new Date('2026-11-02T08:00:00Z') });
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 1, latestAt: '2026-11-04T09:00:00.000Z' });
  });

  it('a sensitive newest follow-up is counted without its sender name, whatever the inbox stored of it', async () => {
    const otp = { subject: 'Ihr Code', snippet: 'Bestätigungscode 482917 ist gültig für 5 Minuten.' };
    for (const mode of ['allow', 'skip', 'mask'] as const) {
      mail.close();
      mail = new MailStateDb({ path: ':memory:' });
      mail.upsertAccount(ACCOUNT);
      inbox = new InboxStateDb(mail.getConnection());
      const id = seedReplied();
      await hook(mode)(ACCOUNT.id, envelope({ ...otp, messageId: `<otp-${mode}@x>` }));
      const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
      expect(f, mode).toMatchObject({ count: 1 });
      expect(f?.['latestFromName'], mode).toBeUndefined();
    }
  });
});

describe('a sensitive follow-up on an item already open in "requires you"', () => {
  it('is counted without its sender name in every mode, and the flag is noted in the audit', async () => {
    const otp = { subject: 'Ihr Code', snippet: 'Bestätigungscode 482917 ist gültig für 5 Minuten.' };
    for (const mode of ['allow', 'skip', 'mask'] as const) {
      mail.close();
      mail = new MailStateDb({ path: ':memory:' });
      mail.upsertAccount(ACCOUNT);
      inbox = new InboxStateDb(mail.getConnection());
      const id = seedReplied();
      inbox.updateUserAction(id, null, null);
      await hook(mode)(ACCOUNT.id, envelope({ ...otp, messageId: `<otp-${mode}@x>` }));
      expect(inbox.getItem(id)?.classifierVersion, mode).toBe('v1');
      const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
      expect(f, mode).toMatchObject({ count: 1 });
      expect(f?.['latestFromName'], mode).toBeUndefined();
      const noted = inbox.listAuditForItem(id).filter((a) => a.action === 'sensitive_follow_up_kept_open');
      expect(noted.map((a) => (JSON.parse(a.payloadJson) as { message_id: string }).message_id), mode).toEqual([`<otp-${mode}@x>`]);
    }
  });

  it('a clean follow-up on an open item notes nothing and keeps the name', async () => {
    const id = seedReplied();
    inbox.updateUserAction(id, null, null);
    await hook('skip')(ACCOUNT.id, envelope());
    expect(inbox.listAuditForItem(id).some((a) => a.action === 'sensitive_follow_up_kept_open')).toBe(false);
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 1, latestFromName: 'Kundin Muster' });
  });
});

describe('only mail since the owner last dealt with the thread is counted', () => {
  it('a follow-up the owner answered is not counted once the next one opens the item again', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    inbox.updateUserAction(id, 'replied', new Date('2026-11-04T12:00:00Z'));
    inbox.appendAudit({ itemId: id, action: 'replied', actor: 'system', payloadJson: '{}', createdAt: new Date('2026-11-04T12:00:00Z') });
    await hook()(ACCOUNT.id, envelope({ messageId: '<follow2@x>', uid: 3, date: new Date('2026-11-05T10:00:00Z') }));
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 1, latestAt: '2026-11-05T10:00:00.000Z' });
  });

  it('a follow-up from before an archive is not counted when a flagged mail raises the item', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    inbox.updateUserAction(id, 'archived', new Date('2026-11-04T12:00:00Z'));
    inbox.appendAudit({ itemId: id, action: 'archived', actor: 'user', payloadJson: '{}', createdAt: new Date('2026-11-04T12:00:00Z') });
    await hook()(ACCOUNT.id, envelope({
      messageId: '<otp@x>', uid: 3, date: new Date('2026-11-05T10:00:00Z'), subject: 'Ihr Code', snippet: 'Bestätigungscode 482917 ist gültig für 5 Minuten.',
    }));
    expect(inbox.getItem(id)?.userAction).toBeUndefined();
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 1, latestAt: '2026-11-05T10:00:00.000Z' });
  });

  it('an archive the owner undid does not hide the mail before it', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    // Archived after the reopen (the audit is written at the time of the action), then undone.
    inbox.appendAudit({ itemId: id, action: 'archived', actor: 'user', payloadJson: '{}', createdAt: new Date(Date.now() + 60_000) });
    inbox.updateUserAction(id, null, null);
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 1, latestAt: '2026-11-04T09:00:00.000Z' });
  });

  it('a mail sent into the thread after a follow-up answers it', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    inbox.insertThreadMessage({ accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<sent@x>', fromAddress: ACCOUNT.address, subject: 'Re: Lieferung', direction: 'outbound', mailDate: new Date('2026-11-04T11:00:00Z') });
    expect(followUpsOnEveryRoute(id)).toEqual([undefined, undefined, undefined]);
  });

  it('a follow-up without a mail date says when the inbox stored it', async () => {
    const id = seedReplied();
    inbox.updateUserAction(id, null, null);
    inbox.insertThreadMessage({
      accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<nodate@x>', fromAddress: 'kunde@example.com', fromName: 'Kundin Muster',
      subject: 'Re: Lieferung', direction: 'inbound', autoReply: false, fetchedAt: new Date('2026-11-06T07:00:00Z'),
    });
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 1, latestAt: '2026-11-06T07:00:00.000Z' });
  });
});
