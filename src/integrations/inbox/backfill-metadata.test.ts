import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb } from './state.js';
import { backfillMetadata } from './backfill-metadata.js';
import type { MailAccountConfig, MailEnvelope, MailProvider } from '../mail/provider.js';

let mail: MailStateDb;
let inbox: InboxStateDb;

const ACCOUNT: MailAccountConfig = {
  id: 'acct-bf',
  displayName: 'Backfill Test',
  address: 'me@example.test',
  preset: 'custom',
  imap: { host: 'imap.test', port: 993, secure: true },
  smtp: { host: 'smtp.test', port: 465, secure: true },
  authType: 'imap',
  type: 'personal',
  isDefault: true,
};

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
});

afterEach(() => {
  mail.close();
});

function envelope(overrides: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    uid: 1,
    messageId: '<bf-1@x>',
    folder: 'INBOX',
    threadKey: 'imap:bf-thread-1',
    inReplyTo: undefined,
    from: [{ address: 'sender@example.com', name: 'Sender' }],
    to: [{ address: ACCOUNT.address }],
    cc: [],
    replyTo: [],
    subject: 'Hello',
    date: new Date('2026-05-09T10:30:00Z'),
    flags: [],
    snippet: 'snippet text',
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: 0,
    isAutoReply: false,
    ...overrides,
  };
}

function fakeProvider(envelopes: ReadonlyArray<MailEnvelope>): MailProvider {
  return {
    accountId: ACCOUNT.id,
    authType: 'imap',
    list: vi.fn(async () => envelopes),
    fetch: vi.fn(),
    search: vi.fn(),
    send: vi.fn(),
    watch: vi.fn(),
    close: vi.fn(),
  } as unknown as MailProvider;
}

function seedPreV11(threadKey: string): string {
  return inbox.insertItem({
    accountId: ACCOUNT.id,
    channel: 'email',
    threadKey,
    bucket: 'requires_user',
    confidence: 0.5,
    reasonDe: 'pre-v11 row',
    classifiedAt: new Date('2026-05-01T00:00:00Z'),
    classifierVersion: 'haiku-old',
  });
}

describe('backfillMetadata', () => {
  it('updates envelope columns on matching threads and reports counts', async () => {
    const id = seedPreV11('imap:bf-thread-1');
    const report = await backfillMetadata({
      provider: fakeProvider([envelope()]),
      state: inbox,
    });
    expect(report).toMatchObject({
      accountId: ACCOUNT.id,
      scanned: 1,
      updated: 1,
      unmatched: 0,
      windowReached: false,
    });
    const item = inbox.getItem(id);
    expect(item).toMatchObject({
      fromAddress: 'sender@example.com',
      fromName: 'Sender',
      subject: 'Hello',
      mailDate: new Date('2026-05-09T10:30:00Z'),
      messageId: '<bf-1@x>',
    });
    // v12 sibling-row write: backfill populates inbox_thread_messages too.
    const messages = inbox.listThreadMessages(ACCOUNT.id, 'imap:bf-thread-1');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('<bf-1@x>');
    expect(messages[0]?.inboxItemId).toBe(id);
  });

  it('counts envelopes whose thread_key has no matching row as unmatched', async () => {
    const report = await backfillMetadata({
      provider: fakeProvider([envelope({ threadKey: 'imap:unknown' })]),
      state: inbox,
    });
    expect(report).toMatchObject({ scanned: 1, updated: 0, unmatched: 1 });
  });

  it('handles multiple envelopes, partial-match', async () => {
    seedPreV11('imap:bf-thread-a');
    const report = await backfillMetadata({
      provider: fakeProvider([
        envelope({ threadKey: 'imap:bf-thread-a', subject: 'A' }),
        envelope({ threadKey: 'imap:bf-thread-b', subject: 'B', uid: 2 }),
      ]),
      state: inbox,
    });
    expect(report).toMatchObject({ scanned: 2, updated: 1, unmatched: 1 });
  });
});
