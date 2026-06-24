import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { reconcileOutboundReply } from './outbound-reconcile.js';
import type { OutboundContext } from '../mail/context.js';
import type { MailAccountConfig } from '../mail/provider.js';

let mail: MailStateDb;
let inbox: InboxStateDb;

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1', displayName: 'Me', address: 'me@acme.example', preset: 'custom',
  imap: { host: 'imap.example.com', port: 993, secure: true },
  smtp: { host: 'smtp.example.com', port: 465, secure: true },
  authType: 'imap', type: 'personal', isDefault: true,
};

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
});
afterEach(() => mail.close());

function seedItem(messageId: string | undefined): string {
  return inbox.insertItem({
    accountId: ACCOUNT.id, channel: 'email', threadKey: 'imap:t1',
    bucket: 'requires_user', confidence: 0.9, reasonDe: 'needs you',
    classifiedAt: new Date('2026-06-24T10:00:00Z'), classifierVersion: 'v1',
    ...(messageId !== undefined ? { messageId } : {}),
  });
}

function outCtx(overrides: Partial<OutboundContext> = {}): OutboundContext {
  return {
    input: { to: [], subject: 'Re: hi', text: 'ok' },
    result: { messageId: '<sent@x>', accepted: [], rejected: [] },
    isReply: true,
    originalMessageId: '<orig@example.com>',
    ...overrides,
  };
}

function auditCount(itemId: string): number {
  const row = mail.getConnection()
    .prepare('SELECT COUNT(*) AS c FROM inbox_audit_log WHERE item_id = ? AND action = ?')
    .get(itemId, 'replied') as { c: number };
  return row.c;
}

describe('reconcileOutboundReply (inbox ↔ chat reply sync)', () => {
  it('marks the open item replied + writes a system audit row', () => {
    const id = seedItem('<orig@example.com>');
    reconcileOutboundReply(inbox, outCtx());
    expect(inbox.getItem(id)?.userAction).toBe('replied');
    expect(auditCount(id)).toBe(1);
  });

  it('no-ops for a fresh send (isReply=false) and a reply without originalMessageId', () => {
    const id = seedItem('<orig@example.com>');
    reconcileOutboundReply(inbox, outCtx({ isReply: false }));
    reconcileOutboundReply(inbox, outCtx({ originalMessageId: undefined }));
    expect(inbox.getItem(id)?.userAction).toBeUndefined();
    expect(auditCount(id)).toBe(0);
  });

  it('no-ops when no item matches the replied-to message-id', () => {
    const id = seedItem('<orig@example.com>');
    reconcileOutboundReply(inbox, outCtx({ originalMessageId: '<someone-else@example.com>' }));
    expect(inbox.getItem(id)?.userAction).toBeUndefined();
  });

  it('does NOT overwrite an explicit user action (only open items are reconciled)', () => {
    const id = seedItem('<orig@example.com>');
    inbox.updateUserAction(id, 'archived', new Date(), 'default');
    reconcileOutboundReply(inbox, outCtx());
    expect(inbox.getItem(id)?.userAction).toBe('archived'); // untouched
    expect(auditCount(id)).toBe(0);
  });

  it('reconciles by Message-ID alone — a reply sent from a DIFFERENT account still marks the item', () => {
    // mail_reply's smart reply-from can send from another mailbox than the one
    // the mail was received on; matching by the (globally-unique) Message-ID
    // means the item is still found regardless of the sending account.
    const id = seedItem('<orig@example.com>');
    reconcileOutboundReply(inbox, outCtx()); // OutboundContext carries no account
    expect(inbox.getItem(id)?.userAction).toBe('replied');
  });
});
