import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader } from './rules-loader.js';
import { createInboxClassifierHook, type HookQueue } from './watcher-hook.js';
import { handleBulkAction, handleGetItem, handleGetItemFull, handleListItems, handleSetAction, handleSetSnooze, handleUndoBulk } from './api.js';
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
  }).id;
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

describe('what does not count as dealing with the thread', () => {
  const otp = { subject: 'Ihr Code', snippet: 'Bestätigungscode 482917 ist gültig für 5 Minuten.' };

  it('an archive written before undos were logged, then undone in bulk, does not hide the mail before it when a flagged mail raises the item', async () => {
    const id = inbox.insertItem({
      accountId: ACCOUNT.id, channel: 'email', threadKey: THREAD, bucket: 'auto_handled', confidence: 0.9,
      reasonDe: 'Newsletter', classifiedAt: new Date('2026-11-03T08:00:00Z'), classifierVersion: 'v1',
      messageId: '<first@x>', subject: 'Lieferung', fromAddress: 'kunde@example.com',
    }).id;
    inbox.insertThreadMessage({ accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<first@x>', fromAddress: 'kunde@example.com', subject: 'Lieferung', direction: 'inbound', inboxItemId: id, mailDate: new Date('2026-11-03T08:00:00Z') });
    await hook()(ACCOUNT.id, envelope());
    inbox.appendAudit({ itemId: id, action: 'archived', actor: 'user', payloadJson: '{}', createdAt: new Date(Date.now() - 60_000) });
    await hook()(ACCOUNT.id, envelope({ ...otp, messageId: '<otp@x>', uid: 3, date: new Date() }));
    expect(inbox.getItem(id)?.bucket).toBe('requires_user');
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 2 });
  });

  it('a mail from the account address dated to come counts from when it was stored', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope({ date: new Date(Date.now() + 60_000) }));
    inbox.insertThreadMessage({
      accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<future@x>', fromAddress: ACCOUNT.address, subject: 'Re: Lieferung',
      direction: 'outbound', mailDate: new Date('2099-01-01T00:00:00Z'), fetchedAt: new Date(),
    });
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 1 });
  });

  it('clearing a snooze does not undo the reply before it', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    inbox.updateUserAction(id, 'replied', new Date());
    // Written at the time of the action, as the routes do; the hook's audits carry the clock too.
    inbox.appendAudit({ itemId: id, action: 'replied', actor: 'system', payloadJson: '{}' });
    inbox.appendAudit({ itemId: id, action: 'undo', actor: 'user', payloadJson: JSON.stringify({ intent: 'unsnooze' }) });
    await hook()(ACCOUNT.id, envelope({ messageId: '<follow2@x>', uid: 3, date: new Date(Date.now() + 3_000) }));
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 1 });
  });

  it('a follow-up without a mail date stored before the last reply is not counted', async () => {
    const id = seedReplied();
    inbox.insertThreadMessage({
      accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<nodate@x>', fromAddress: 'kunde@example.com', subject: 'Re: Lieferung',
      direction: 'inbound', autoReply: false, fetchedAt: new Date('2026-11-04T08:00:00Z'),
    });
    inbox.insertThreadMessage({ accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<sent@x>', fromAddress: ACCOUNT.address, subject: 'Re: Lieferung', direction: 'outbound', mailDate: new Date('2026-11-04T09:00:00Z'), fetchedAt: new Date('2026-11-04T09:00:01Z') });
    await hook()(ACCOUNT.id, envelope({ date: new Date('2026-11-04T10:00:00Z') }));
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 1, latestAt: '2026-11-04T10:00:00.000Z' });
  });
});

describe('the two remaining paths: stored text and a single undo', () => {
  it('a follow-up whose stored text reads sensitive is counted without its name, with no intake flag', () => {
    const id = seedReplied();
    inbox.updateUserAction(id, null, null);
    inbox.insertThreadMessage({
      accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<stored-otp@x>', fromAddress: 'kunde@example.com', fromName: 'Kundin Muster',
      subject: 'Ihr Code', snippet: 'Bestätigungscode 482917 ist gültig für 5 Minuten.', direction: 'inbound', autoReply: false,
      mailDate: new Date('2026-11-04T09:00:00Z'),
    });
    expect(inbox.listAuditForItem(id).some((a) => a.action === 'sensitive_follow_up_kept_open' || a.action === 'raised_on_sensitive_follow_up')).toBe(false);
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 1 });
    expect(f?.['latestFromName']).toBeUndefined();
  });

  it('a reply the owner undid does not mark the mail before it as answered', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    // Replied and undone, then marked replied again with no audit row, and a new mail reopens.
    inbox.updateUserAction(id, 'replied', new Date());
    inbox.appendAudit({ itemId: id, action: 'replied', actor: 'user', payloadJson: '{}' });
    inbox.appendAudit({ itemId: id, action: 'undo', actor: 'user', payloadJson: JSON.stringify({ reverted_at: new Date().toISOString() }) });
    await hook()(ACCOUNT.id, envelope({ messageId: '<follow2@x>', uid: 3, date: new Date(Date.now() + 1_000) }));
    expect(inbox.getItem(id)?.userAction).toBeUndefined();
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 2 });
  });
});

describe('an archive written before undos were logged stays undone when a later action precedes a raise', () => {
  it('archive, undo in bulk without a trace, snooze, then a flagged mail raises: the mail before the archive still counts', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    // Archived and undone in bulk: the bulk undo leaves the archive audit and writes none of its own.
    inbox.appendAudit({ itemId: id, action: 'archived', actor: 'user', payloadJson: '{}' });
    inbox.updateUserAction(id, 'snoozed', new Date());
    await hook()(ACCOUNT.id, envelope({
      messageId: '<otp@x>', uid: 3, date: new Date(Date.now() + 1_000), subject: 'Ihr Code', snippet: 'Bestätigungscode 482917 ist gültig für 5 Minuten.',
    }));
    expect(inbox.getItem(id)?.userAction).toBeUndefined();
    const [f] = followUpsOnEveryRoute(id) as Array<Record<string, unknown>>;
    expect(f).toMatchObject({ count: 2 });
  });
});

describe('a raise ends the reply or archive before it, whatever the item showed when the mail came', () => {
  const otp = (at: Date, id = '<otp@x>') => envelope({ messageId: id, uid: 9, date: at, subject: 'Ihr Code', snippet: 'Bestätigungscode 482917 ist gültig für 5 Minuten.' });
  const dealt = (id: string): Record<string, unknown> | undefined => (followUpsOnEveryRoute(id) as Array<Record<string, unknown> | undefined>)[0];
  /** An item the classifier filed as handled, with one follow-up: open, but out of "requires you", so a flagged mail raises it. */
  async function seedHandled(): Promise<string> {
    const id = inbox.insertItem({
      accountId: ACCOUNT.id, channel: 'email', threadKey: THREAD, bucket: 'auto_handled', confidence: 0.9,
      reasonDe: 'Newsletter', classifiedAt: new Date('2026-11-03T08:00:00Z'), classifierVersion: 'v1',
      messageId: '<first@x>', subject: 'Lieferung', fromAddress: 'kunde@example.com',
    }).id;
    inbox.insertThreadMessage({ accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<first@x>', fromAddress: 'kunde@example.com', subject: 'Lieferung', direction: 'inbound', inboxItemId: id, mailDate: new Date('2026-11-03T08:00:00Z') });
    await hook()(ACCOUNT.id, envelope());
    return id;
  }

  it('an archive taken while the inbox checks the mail for an automatic reply: named as the action the raise ended, the mail before it not counted', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    expect(inbox.getItem(id)?.userAction).toBeUndefined();
    const confirming = createInboxClassifierHook({
      state: inbox, rules: new InboxRulesLoader(inbox), queue,
      accounts: { resolve: () => ({ address: ACCOUNT.address, displayName: 'Me', authType: 'oauth_microsoft' }) },
      confirmAutoReply: async () => {
        // The owner archives the item while the provider is asked.
        expect(handleSetAction(deps(), id, { action: 'archived' }).status).toBe(200);
        return false;
      },
    });
    await confirming(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    const raise = inbox.listAuditForItem(id).find((a) => a.action === 'raised_on_sensitive_follow_up');
    expect(JSON.parse(raise!.payloadJson)).toMatchObject({ prior_user_action: 'archived' });
    expect(dealt(id)).toMatchObject({ count: 1 });
  });

  it('reply, snooze with wake on reply, then a flagged mail wakes and raises it: the answered mail is not counted', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    expect(handleSetAction(deps(), id, { action: 'replied' }).status).toBe(200);
    expect(handleSetSnooze(deps(), id, { until: new Date(Date.now() + 86_400_000).toISOString() }).status).toBe(200);
    await hook()(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    expect(inbox.getItem(id)?.userAction).toBeUndefined();
    expect(inbox.getItem(id)?.snoozeUntil).toBeUndefined();
    expect(inbox.listAuditForItem(id).map((a) => a.action)).toContain('unsnoozed_on_reply');
    expect(dealt(id)).toMatchObject({ count: 1 });
  });

  it('reply, then snoozed through the API action route, then a flagged mail raises: the answered mail is counted once, not again', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    expect(handleSetAction(deps(), id, { action: 'replied' }).status).toBe(200);
    expect(handleSetAction(deps(), id, { action: 'snoozed' }).status).toBe(200);
    await hook()(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    const raise = inbox.listAuditForItem(id).find((a) => a.action === 'raised_on_sensitive_follow_up');
    expect(JSON.parse(raise!.payloadJson)).toMatchObject({ prior_user_action: 'snoozed' });
    expect(dealt(id)).toMatchObject({ count: 1 });
  });

  it('archive, bulk undo, snooze, then a flagged mail raises: the mail before the archive still counts', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    expect(handleSetAction(deps(), id, { action: 'archived' }).status).toBe(200);
    expect(handleSetAction(deps(), id, { action: null }).status).toBe(200);
    const bulk = handleBulkAction(deps(), { ids: [id], action: 'archived' }).body as { bulkId: string };
    expect(handleUndoBulk(deps(), bulk.bulkId).body).toMatchObject({ reverted: 1 });
    expect(inbox.getItem(id)?.userAction).toBeUndefined();
    expect(handleSetAction(deps(), id, { action: 'snoozed' }).status).toBe(200);
    await hook()(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    expect(dealt(id)).toMatchObject({ count: 2 });
  });

  it('a bulk undo puts back the reply that was pending before the bulk: reply, bulk archive, bulk undo, flagged mail', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    expect(handleSetAction(deps(), id, { action: 'replied' }).status).toBe(200);
    const bulk = handleBulkAction(deps(), { ids: [id], action: 'archived' }).body as { bulkId: string };
    expect(handleUndoBulk(deps(), bulk.bulkId).body).toMatchObject({ reverted: 1 });
    expect(inbox.getItem(id)?.userAction).toBe('replied');
    await hook()(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    expect(dealt(id)).toMatchObject({ count: 1 });
  });

  it('reply, then marked unhandled in bulk, then a flagged mail raises: the mail before the reply still counts', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    expect(handleSetAction(deps(), id, { action: 'replied' }).status).toBe(200);
    expect((handleBulkAction(deps(), { ids: [id], action: 'unhandled' }).body as { applied: string[] }).applied).toEqual([id]);
    await hook()(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    expect(dealt(id)).toMatchObject({ count: 2 });
  });

  it('bulk unhandled, archived and snoozed, and the undo of each, leave an audit row, so the count does not depend on the pruned action log', () => {
    const id = seedReplied();
    const rows = (): Array<Record<string, unknown>> => inbox.listAuditForItem(id).map((r) => ({ action: r.action, ...JSON.parse(r.payloadJson) as Record<string, unknown> }));
    const a = handleBulkAction(deps(), { ids: [id], action: 'unhandled' }).body as { bulkId: string };
    handleUndoBulk(deps(), a.bulkId);
    const b = handleBulkAction(deps(), { ids: [id], action: 'archived' }).body as { bulkId: string };
    handleUndoBulk(deps(), b.bulkId);
    const c = handleBulkAction(deps(), { ids: [id], action: 'snoozed' }).body as { bulkId: string };
    handleUndoBulk(deps(), c.bulkId);
    expect(rows()).toEqual([
      expect.objectContaining({ action: 'undo', intent: 'unhandled', bulk_id: a.bulkId }),
      expect.objectContaining({ action: 'undo', intent: 'bulk_undo', bulk_id: a.bulkId, undid: 'unhandled', restored: 'replied' }),
      expect.objectContaining({ action: 'archived', bulk_id: b.bulkId, undo_logged: true }),
      expect.objectContaining({ action: 'undo', intent: 'bulk_undo', bulk_id: b.bulkId, undid: 'archived', restored: 'replied' }),
      expect.objectContaining({ action: 'snoozed', bulk_id: c.bulkId }),
      expect.objectContaining({ action: 'undo', intent: 'bulk_undo', bulk_id: c.bulkId, undid: 'snoozed', restored: 'replied' }),
    ]);
  });

  it('an undo that finds the item changed since the bulk puts nothing back and writes no row: bulk archive, flagged mail, undo', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    const bulk = handleBulkAction(deps(), { ids: [id], action: 'archived' }).body as { bulkId: string };
    await hook()(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    expect(handleUndoBulk(deps(), bulk.bulkId).body).toMatchObject({ reverted: 0, skipped: 1 });
    expect(inbox.listAuditForItem(id).some((a) => a.action === 'undo' && (JSON.parse(a.payloadJson) as Record<string, unknown>)['intent'] === 'bulk_undo')).toBe(false);
    expect(dealt(id)).toMatchObject({ count: 1 });
  });

  it('an undo of a bulk "unhandled" puts the reply back: reply, bulk unhandled, undo, flagged mail', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    expect(handleSetAction(deps(), id, { action: 'replied' }).status).toBe(200);
    const bulk = handleBulkAction(deps(), { ids: [id], action: 'unhandled' }).body as { bulkId: string };
    expect(handleUndoBulk(deps(), bulk.bulkId).body).toMatchObject({ reverted: 1 });
    expect(inbox.getItem(id)?.userAction).toBe('replied');
    await hook()(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    expect(dealt(id)).toMatchObject({ count: 1 });
  });

  it('two bulks on one item: an undo of the later puts back what the earlier left pending', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    handleBulkAction(deps(), { ids: [id], action: 'archived' });
    const later = handleBulkAction(deps(), { ids: [id], action: 'snoozed' }).body as { bulkId: string };
    expect(handleUndoBulk(deps(), later.bulkId).body).toMatchObject({ reverted: 1 });
    expect(inbox.getItem(id)?.userAction).toBe('archived');
    await hook()(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    expect(dealt(id)).toMatchObject({ count: 1 });
  });

  it('an undo row for a bulk the audit does not hold leaves the reply pending', async () => {
    const id = seedReplied();
    await hook()(ACCOUNT.id, envelope());
    expect(handleSetAction(deps(), id, { action: 'replied' }).status).toBe(200);
    inbox.appendAudit({ itemId: id, action: 'undo', actor: 'user', payloadJson: JSON.stringify({ intent: 'bulk_undo', bulk_id: 'bulk_old', undid: 'unhandled', restored: 'replied' }) });
    await hook()(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    expect(dealt(id)).toMatchObject({ count: 1 });
  });

  it('reply, bulk archive, bulk undo, then the reply cleared: the mail before the reply counts again when a flagged mail raises the item', async () => {
    const id = await seedHandled();
    expect(handleSetAction(deps(), id, { action: 'replied' }).status).toBe(200);
    const bulk = handleBulkAction(deps(), { ids: [id], action: 'archived' }).body as { bulkId: string };
    expect(handleUndoBulk(deps(), bulk.bulkId).body).toMatchObject({ reverted: 1 });
    expect(handleSetAction(deps(), id, { action: null }).status).toBe(200);
    const undo = inbox.listAuditForItem(id).filter((x) => x.action === 'undo').at(-1);
    expect(JSON.parse(undo!.payloadJson)).toMatchObject({ undid: 'replied' });
    await hook()(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    expect(inbox.listAuditForItem(id).some((x) => x.action === 'raised_on_sensitive_follow_up')).toBe(true);
    expect(dealt(id)).toMatchObject({ count: 2 });
  });

  it('a reply written before undos were logged is still ended by a raise that names it: the answered mail is not counted', async () => {
    const id = await seedHandled();
    inbox.updateUserAction(id, 'replied', new Date());
    inbox.appendAudit({ itemId: id, action: 'replied', actor: 'user', payloadJson: JSON.stringify({ at: new Date().toISOString() }) });
    await hook()(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    const raise = inbox.listAuditForItem(id).find((x) => x.action === 'raised_on_sensitive_follow_up');
    expect(JSON.parse(raise!.payloadJson)).toMatchObject({ prior_user_action: 'replied' });
    expect(dealt(id)).toMatchObject({ count: 1 });
  });

  it('a clear of a snooze through the action route leaves the reply before it: reply, snooze, clear, flagged mail, on an item out of "requires you"', async () => {
    const id = await seedHandled();
    expect(handleSetAction(deps(), id, { action: 'replied' }).status).toBe(200);
    expect(handleSetAction(deps(), id, { action: 'snoozed' }).status).toBe(200);
    expect(handleSetAction(deps(), id, { action: null }).status).toBe(200);
    await hook()(ACCOUNT.id, otp(new Date(Date.now() + 1_000)));
    expect(dealt(id)).toMatchObject({ count: 1 });
  });

});
