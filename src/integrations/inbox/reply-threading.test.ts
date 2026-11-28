import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { InboxRulesLoader } from './rules-loader.js';
import { createInboxClassifierHook, type AccountResolver, type HookQueue } from './watcher-hook.js';
import { MAX_PARENT_IDS, parentMessageIds, parseReferenceIds } from '../mail/thread-key.js';
import type { MailAccountConfig, MailEnvelope } from '../mail/provider.js';

/**
 * A reply on an IMAP server without thread ids: the provider keys each mail by its own Message-ID,
 * so the inbox finds the item a reply belongs to through In-Reply-To and References, in the same
 * account and tenant only.
 */

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1', displayName: 'Me', address: 'me@acme.example', preset: 'custom',
  imap: { host: 'i', port: 993, secure: true }, smtp: { host: 's', port: 465, secure: true },
  authType: 'imap', type: 'personal', isDefault: true,
};
const OTHER: MailAccountConfig = { ...ACCOUNT, id: 'acct-2', address: 'other@acme.example', isDefault: false };
// On IMAP without thread ids the thread key is the first mail's Message-ID.
const THREAD = '<first@x>';

let mail: MailStateDb;
let inbox: InboxStateDb;
let queued: number;
let queue: HookQueue;
let accounts: AccountResolver;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  mail.upsertAccount(OTHER);
  inbox = new InboxStateDb(mail.getConnection());
  queued = 0;
  queue = { enqueue: vi.fn(() => { queued++; return true; }) };
  accounts = {
    resolve: (id: string) => {
      const a = [ACCOUNT, OTHER].find((x) => x.id === id);
      return a ? { address: a.address, displayName: a.displayName } : null;
    },
  };
});
afterEach(() => mail.close());

/** A reply as the IMAP provider builds it on a server without thread ids. */
function reply(overrides: Partial<MailEnvelope> = {}): MailEnvelope {
  const messageId = overrides.messageId === undefined && 'messageId' in overrides ? undefined : (overrides.messageId ?? '<reply@x>');
  return {
    uid: 7, folder: 'INBOX', inReplyTo: '<first@x>', references: ['<first@x>'],
    from: [{ address: 'kunde@example.com', name: 'Kundin' }], to: [{ address: ACCOUNT.address }], cc: [], replyTo: [],
    subject: 'Re: Offerte', date: new Date('2026-11-24T09:00:00Z'), flags: [],
    snippet: 'Es sind jetzt 40 statt 30 Stück.', hasAttachments: false, attachmentCount: 0, sizeBytes: 0,
    isAutoReply: false, ...overrides, messageId, threadKey: 'threadKey' in overrides ? overrides.threadKey : messageId,
  };
}

/** An item filed from the first mail, answered by the owner. */
function seed(opts: { accountId?: string; tenantId?: string; threadKey?: string; messageId?: string } = {}): string {
  const accountId = opts.accountId ?? ACCOUNT.id;
  const threadKey = opts.threadKey ?? THREAD;
  const messageId = opts.messageId ?? '<first@x>';
  const id = inbox.insertItem({
    accountId, channel: 'email', threadKey, bucket: 'requires_user', confidence: 0.9,
    reasonDe: 'Kundin will eine Offerte', classifiedAt: new Date('2026-11-23T08:00:00Z'),
    classifierVersion: 'v1', messageId, subject: 'Offerte', fromAddress: 'kunde@example.com',
    ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
  }).id;
  inbox.insertThreadMessage({
    accountId, threadKey, messageId, fromAddress: 'kunde@example.com',
    subject: 'Offerte', direction: 'inbound', inboxItemId: id,
    ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
  });
  inbox.updateUserAction(id, 'replied', new Date('2026-11-23T09:00:00Z'), opts.tenantId);
  return id;
}

function hook(tenantId?: string) {
  return createInboxClassifierHook({
    state: inbox, rules: new InboxRulesLoader(inbox), queue, accounts, notifier: { notifyNewItem: vi.fn(async () => true) },
    ...(tenantId !== undefined ? { tenantId } : {}),
  });
}

function threadIds(accountId = ACCOUNT.id, threadKey = THREAD): string[] {
  return inbox.listThreadMessages(accountId, threadKey).map((m) => m.messageId).sort();
}

describe('a reply on an IMAP server without thread ids', () => {
  it('joins the item its In-Reply-To names and opens it again, without a new item', async () => {
    const id = seed();
    expect(await hook()(ACCOUNT.id, reply())).toBe('duplicate');
    expect(queued).toBe(0);
    expect(threadIds()).toEqual(['<first@x>', '<reply@x>']);
    expect(inbox.getItem(id)!.userAction).toBeUndefined();
    expect(inbox.listAuditForItem(id).map((a) => a.action)).toContain('reopened_on_reply');
    expect(inbox.findItemByThread(ACCOUNT.id, '<reply@x>')).toBeNull();
  });

  it('joins through References when In-Reply-To names a mail the inbox does not hold', async () => {
    const id = seed();
    const env = reply({ inReplyTo: '<unknown@x>', references: ['<first@x>', '<unknown@x>'] });
    expect(await hook()(ACCOUNT.id, env)).toBe('duplicate');
    expect(queued).toBe(0);
    expect(inbox.getItem(id)!.userAction).toBeUndefined();
    expect(threadIds()).toContain('<reply@x>');
  });

  it('joins through a later message the thread store holds for the item', async () => {
    const id = seed();
    inbox.insertThreadMessage({
      accountId: ACCOUNT.id, threadKey: THREAD, messageId: '<second@x>', fromAddress: 'kunde@example.com',
      subject: 'Re: Offerte', direction: 'inbound', inboxItemId: id,
    });
    const env = reply({ inReplyTo: '<second@x>', references: ['<second@x>'] });
    expect(await hook()(ACCOUNT.id, env)).toBe('duplicate');
    expect(queued).toBe(0);
    expect(threadIds()).toContain('<reply@x>');
  });

  it('joins through the item itself when the thread store does not hold its first mail', async () => {
    const id = inbox.insertItem({
      accountId: ACCOUNT.id, channel: 'email', threadKey: THREAD, bucket: 'requires_user', confidence: 0.9,
      reasonDe: 'Kundin will eine Offerte', classifiedAt: new Date('2026-11-23T08:00:00Z'),
      classifierVersion: 'v1', messageId: '<first@x>', subject: 'Offerte', fromAddress: 'kunde@example.com',
    }).id;
    inbox.updateUserAction(id, 'replied', new Date('2026-11-23T09:00:00Z'));
    expect(inbox.listThreadMessages(ACCOUNT.id, THREAD)).toEqual([]);
    expect(await hook()(ACCOUNT.id, reply())).toBe('duplicate');
    expect(queued).toBe(0);
    expect(inbox.getItem(id)!.userAction).toBeUndefined();
    expect(threadIds()).toEqual(['<reply@x>']);
  });

  it('a reply naming the key of an item filed without a Message-ID does not join it', async () => {
    const id = inbox.insertItem({
      accountId: ACCOUNT.id, channel: 'email', threadKey: '<keyed@x>', bucket: 'requires_user', confidence: 0.9,
      reasonDe: 'ohne Message-ID', classifiedAt: new Date('2026-11-23T08:00:00Z'),
      classifierVersion: 'v1', subject: 'Offerte', fromAddress: 'kunde@example.com',
    }).id;
    inbox.updateUserAction(id, 'replied', new Date('2026-11-23T09:00:00Z'));
    expect(await hook()(ACCOUNT.id, reply({ inReplyTo: '<keyed@x>', references: ['<keyed@x>'] }))).toBe('enqueued');
    expect(inbox.getItem(id)!.userAction).toBe('replied');
    const noId = inbox.insertItem({
      accountId: ACCOUNT.id, channel: 'email', threadKey: 'imap:INBOX:9', bucket: 'requires_user', confidence: 0.9,
      reasonDe: 'ohne Message-ID', classifiedAt: new Date('2026-11-23T08:00:00Z'),
      classifierVersion: 'v1', subject: 'Offerte', fromAddress: 'kunde@example.com',
    }).id;
    inbox.updateUserAction(noId, 'replied', new Date('2026-11-23T09:00:00Z'));
    expect(await hook()(ACCOUNT.id, reply({ messageId: '<reply-3@x>', inReplyTo: 'imap:INBOX:9', references: [] }))).toBe('enqueued');
    expect(inbox.getItem(noId)!.userAction).toBe('replied');
  });

  it('a reply naming a mail of another account becomes an item of its own and leaves that item alone', async () => {
    const id = seed({ accountId: OTHER.id });
    expect(await hook()(ACCOUNT.id, reply())).toBe('enqueued');
    expect(queued).toBe(1);
    expect(inbox.getItem(id)!.userAction).toBe('replied');
    expect(threadIds(OTHER.id)).toEqual(['<first@x>']);
  });

  it('a reply naming a later thread message of another account does not join it either', async () => {
    const id = seed({ accountId: OTHER.id, messageId: '<other-first@x>', threadKey: '<other-first@x>' });
    inbox.insertThreadMessage({
      accountId: OTHER.id, threadKey: '<other-first@x>', messageId: '<sent@acme>', fromAddress: OTHER.address,
      subject: 'Re: Offerte', direction: 'outbound', inboxItemId: id,
    });
    expect(await hook()(ACCOUNT.id, reply({ inReplyTo: '<sent@acme>', references: [] }))).toBe('enqueued');
    expect(inbox.getItem(id)!.userAction).toBe('replied');
  });

  it('a reply naming a mail of another tenant on the same account id becomes an item of its own', async () => {
    const id = seed({ tenantId: 'tenant-b' });
    expect(await hook('tenant-a')(ACCOUNT.id, reply())).toBe('enqueued');
    expect(queued).toBe(1);
    expect(inbox.getItem(id, 'tenant-b')!.userAction).toBe('replied');
  });

  it('a reply without a Message-ID becomes an item of its own, since it cannot be stored in the thread', async () => {
    const id = seed();
    const env = reply({ messageId: undefined });
    expect(env.messageId).toBeUndefined();
    expect(await hook()(ACCOUNT.id, env)).toBe('enqueued');
    expect(inbox.getItem(id)!.userAction).toBe('replied');
  });

  it('keeps a provider thread: a Gmail or Graph mail is not moved by its reply headers', async () => {
    const id = seed();
    for (const threadKey of ['gmail:t-9', 'graph:c-9']) {
      const env = reply({ messageId: `<${threadKey}@x>`, threadKey });
      expect(await hook()(ACCOUNT.id, env)).toBe('enqueued');
    }
    expect(queued).toBe(2);
    expect(inbox.getItem(id)!.userAction).toBe('replied');
    expect(threadIds()).toEqual(['<first@x>']);
  });

  it('tries only the newest References: a parent further back than the bound is not looked up', async () => {
    const id = seed();
    const filler = Array.from({ length: MAX_PARENT_IDS }, (_, i) => `<f${i}@x>`);
    const far = reply({ inReplyTo: undefined, references: ['<first@x>', ...filler] });
    expect(await hook()(ACCOUNT.id, far)).toBe('enqueued');
    expect(inbox.getItem(id)!.userAction).toBe('replied');

    const near = reply({ messageId: '<reply-2@x>', inReplyTo: undefined, references: ['<first@x>', ...filler.slice(1)] });
    expect(await hook()(ACCOUNT.id, near)).toBe('duplicate');
    expect(inbox.getItem(id)!.userAction).toBeUndefined();
  });
});

describe('reading the reply headers', () => {
  it('parses References oldest first and keeps only the newest ids', () => {
    expect(parseReferenceIds('<a@x> <b@x>\r\n <c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    const many = Array.from({ length: MAX_PARENT_IDS + 5 }, (_, i) => `<m${i}@x>`).join(' ');
    const ids = parseReferenceIds(many);
    expect(ids).toHaveLength(MAX_PARENT_IDS);
    expect(ids[0]).toBe('<m5@x>');
    expect(ids[MAX_PARENT_IDS - 1]).toBe(`<m${MAX_PARENT_IDS + 4}@x>`);
    expect(parseReferenceIds(undefined)).toEqual([]);
    expect(parseReferenceIds('no ids here')).toEqual([]);
  });

  it('cuts an oversized References header before scanning it', () => {
    const huge = `<lost@x> ${'x'.repeat(40_000)} <kept@x>`;
    expect(parseReferenceIds(huge)).toEqual(['<kept@x>']);
  });

  it('takes only ids in Message-ID form', () => {
    expect(parentMessageIds(reply({ inReplyTo: 'imap:INBOX:9', references: [] }))).toEqual([]);
    expect(parentMessageIds(reply({ inReplyTo: ' <p@x> ', references: [] }))).toEqual(['<p@x>']);
    expect(parentMessageIds(reply({ inReplyTo: '<p@x> <q@x>', references: [] }))).toEqual([]);
  });

  it('names In-Reply-To first, then References from the newest, without its own id or repeats', () => {
    const env = reply({ messageId: '<self@x>', inReplyTo: '<p@x>', references: ['<a@x>', '<self@x>', '<p@x>', '<b@x>'] });
    expect(parentMessageIds(env)).toEqual(['<p@x>', '<b@x>', '<a@x>']);
  });

  it('never names more than the bound, even when In-Reply-To adds one', () => {
    const refs = Array.from({ length: MAX_PARENT_IDS }, (_, i) => `<r${i}@x>`);
    const ids = parentMessageIds(reply({ inReplyTo: '<p@x>', references: refs }));
    expect(ids).toHaveLength(MAX_PARENT_IDS);
    expect(ids[0]).toBe('<p@x>');
  });
});
