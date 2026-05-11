import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshItemBody, refreshWhatsappItemBody } from './body-refresh.js';
import { InboxStateDb } from './state.js';
import { MailStateDb } from '../mail/state.js';
import type { MailEnvelope, MailProvider } from '../mail/provider.js';
import type { MailAccountConfig } from '../mail/provider.js';

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1',
  displayName: 'Me',
  address: 'me@x',
  preset: 'custom',
  imap: { host: 'i', port: 1, secure: true },
  smtp: { host: 's', port: 1, secure: true },
  authType: 'imap',
  type: 'personal',
  isDefault: true,
};

function envelope(uid: number, opts: { threadKey?: string; messageId?: string; folder?: string } = {}): MailEnvelope {
  return {
    uid,
    messageId: opts.messageId,
    folder: opts.folder ?? 'INBOX',
    threadKey: opts.threadKey,
    from: [{ address: 'sender@x' }],
    to: [{ address: 'me@x' }],
    cc: [],
    bcc: [],
    subject: 's',
    date: new Date('2026-05-12'),
    snippet: 'snippet',
    flags: [],
    seen: true,
  } as unknown as MailEnvelope;
}

function fakeProvider(opts: {
  envelopes?: ReadonlyArray<MailEnvelope>;
  listThrows?: Error;
  fetchThrows?: Error;
  fetchText?: string;
}): MailProvider {
  const list = vi.fn(async () => {
    if (opts.listThrows) throw opts.listThrows;
    return opts.envelopes ?? [];
  });
  const fetch = vi.fn(async () => {
    if (opts.fetchThrows) throw opts.fetchThrows;
    return {
      envelope: opts.envelopes?.[0] ?? envelope(1),
      text: opts.fetchText ?? 'full body text',
      html: undefined,
      attachments: [],
      inReplyTo: undefined,
      references: undefined,
    };
  });
  return {
    accountId: ACCOUNT.id,
    authType: 'imap',
    list,
    fetch,
    search: vi.fn(),
    send: vi.fn(),
    watch: vi.fn(),
    close: vi.fn(),
  } as unknown as MailProvider;
}

let mail: MailStateDb;
let state: InboxStateDb;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  state = new InboxStateDb(mail.getConnection());
});

function inboxItem(threadKey = 'imap:<m1@x>'): { id: string; accountId: string; threadKey: string; channel: 'email' } {
  const id = state.insertItem({
    accountId: ACCOUNT.id,
    channel: 'email',
    threadKey,
    bucket: 'requires_user',
    confidence: 0.9,
    reasonDe: 'r',
    classifiedAt: new Date(),
    classifierVersion: 'v',
  });
  return { id, accountId: ACCOUNT.id, threadKey, channel: 'email' };
}

describe('refreshItemBody', () => {
  it('matches an envelope by synthesised threadKey and writes the full body to the cache', async () => {
    const item = inboxItem('imap:<m1@x>');
    const provider = fakeProvider({
      envelopes: [envelope(7, { messageId: '<m1@x>' })],
      fetchText: 'This is the FULL body of the original mail.',
    });
    const result = await refreshItemBody({ provider, state, item });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyMd).toBe('This is the FULL body of the original mail.');
      expect(result.bytesWritten).toBe(Buffer.byteLength(result.bodyMd, 'utf8'));
      expect(result.truncated).toBe(false);
    }
    expect(state.getItemBody(item.id)?.bodyMd).toBe('This is the FULL body of the original mail.');
    // provider.fetch should be called with the matched UID
    expect((provider.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({ uid: 7 });
  });

  it('truncates bodies over MAX_ITEM_BODY_CHARS so the cache and bytesWritten stay consistent', async () => {
    const item = inboxItem('imap:<m1@x>');
    const huge = 'x'.repeat(10 * 1024);
    const provider = fakeProvider({
      envelopes: [envelope(7, { messageId: '<m1@x>' })],
      fetchText: huge,
    });
    const result = await refreshItemBody({ provider, state, item });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.bodyMd.length).toBe(8 * 1024);
      expect(result.bytesWritten).toBe(8 * 1024);
      // Cache row matches reported body — no silent over-truncation.
      expect(state.getItemBody(item.id)?.bodyMd.length).toBe(8 * 1024);
    }
  });

  it('prefers provider-set threadKey over synthesised messageId form', async () => {
    const item = inboxItem('gmail:thread-42');
    const provider = fakeProvider({
      envelopes: [
        envelope(1, { messageId: '<other@x>' }),
        envelope(9, { threadKey: 'gmail:thread-42' }),
      ],
      fetchText: 'gmail thread body',
    });
    await refreshItemBody({ provider, state, item });
    expect((provider.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({ uid: 9 });
  });

  it('returns not_found when no envelope in the lookup window matches', async () => {
    const item = inboxItem('imap:<gone@x>');
    const provider = fakeProvider({
      envelopes: [envelope(1, { messageId: '<other@x>' })],
    });
    const result = await refreshItemBody({ provider, state, item });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.kind).toBe('not_found');
    // fetch should not be called when list yields no match
    expect((provider.fetch as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('returns fetch_failed when provider.list throws', async () => {
    const item = inboxItem();
    const provider = fakeProvider({ listThrows: new Error('IMAP auth') });
    const result = await refreshItemBody({ provider, state, item });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.kind).toBe('fetch_failed');
  });

  it('returns fetch_failed when provider.fetch throws on the matched envelope', async () => {
    const item = inboxItem('imap:<m@x>');
    const provider = fakeProvider({
      envelopes: [envelope(7, { messageId: '<m@x>' })],
      fetchThrows: new Error('mail body deleted'),
    });
    const result = await refreshItemBody({ provider, state, item });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.kind).toBe('fetch_failed');
  });

  it('returns empty_body when the fetched message has no text content', async () => {
    const item = inboxItem('imap:<m@x>');
    const provider = fakeProvider({
      envelopes: [envelope(7, { messageId: '<m@x>' })],
      fetchText: '   \n\n   ',
    });
    const result = await refreshItemBody({ provider, state, item });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.kind).toBe('empty_body');
    // cache should NOT be overwritten with an empty body
    expect(state.getItemBody(item.id)).toBeNull();
  });

  it('respects the lookupDays override on the provider.list call', async () => {
    const item = inboxItem();
    const provider = fakeProvider({ envelopes: [] });
    await refreshItemBody({ provider, state, item, lookupDays: 7 });
    const listMock = provider.list as ReturnType<typeof vi.fn>;
    const sinceArg = (listMock.mock.calls[0]?.[0] as { since?: Date }).since;
    const expectedMin = new Date(Date.now() - 7 * 86_400_000 - 1000);
    const expectedMax = new Date(Date.now() - 7 * 86_400_000 + 1000);
    expect(sinceArg?.getTime()).toBeGreaterThan(expectedMin.getTime());
    expect(sinceArg?.getTime()).toBeLessThan(expectedMax.getTime());
  });
});

describe('refreshWhatsappItemBody', () => {
  function waMsg(opts: { id: string; threadId: string; direction: 'inbound' | 'outbound'; text?: string | null; transcript?: string | null; timestamp?: number }): import('../whatsapp/types.js').WhatsAppMessage {
    return {
      id: opts.id,
      threadId: opts.threadId,
      phoneE164: '41799990000',
      direction: opts.direction,
      kind: 'text',
      text: opts.text ?? null,
      mediaId: null,
      transcript: opts.transcript ?? null,
      mimeType: null,
      timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
      isEcho: false,
      rawJson: '{}',
    };
  }

  function waItem(threadKey = 'whatsapp-41799990000'): { id: string; threadKey: string; channel: 'whatsapp' } {
    const id = state.insertItem({
      accountId: 'whatsapp:default',
      channel: 'whatsapp',
      threadKey,
      bucket: 'requires_user',
      confidence: 0.9,
      reasonDe: 'wa item',
      classifiedAt: new Date(),
      classifierVersion: 'v',
    });
    return { id, threadKey, channel: 'whatsapp' };
  }

  it('concatenates inbound + outbound text into a chronological transcript and caches it', async () => {
    const item = waItem('whatsapp-41799990000');
    const messages = [
      waMsg({ id: '1', threadId: item.threadKey, direction: 'inbound', text: 'Hi, hast du Mittwoch Zeit?' }),
      waMsg({ id: '2', threadId: item.threadKey, direction: 'outbound', text: 'Klar, 14 Uhr?' }),
      waMsg({ id: '3', threadId: item.threadKey, direction: 'inbound', text: 'Perfekt, bis dann.' }),
    ];
    const waState = { getMessagesForThread: () => messages };
    const result = await refreshWhatsappItemBody({ waState, state, item });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyMd).toContain('Gegenüber: Hi, hast du Mittwoch Zeit?');
      expect(result.bodyMd).toContain('Ich: Klar, 14 Uhr?');
      expect(result.bodyMd).toContain('Gegenüber: Perfekt, bis dann.');
      expect(result.bytesWritten).toBe(Buffer.byteLength(result.bodyMd, 'utf8'));
    }
    expect(state.getItemBody(item.id)?.bodyMd).toBe((result as { ok: true; bodyMd: string }).bodyMd);
  });

  it('uses transcript when text is null (voice notes)', async () => {
    const item = waItem('whatsapp-41799990001');
    const messages = [
      waMsg({ id: '1', threadId: item.threadKey, direction: 'inbound', text: null, transcript: 'Hi, Sprachnachricht-Inhalt.' }),
    ];
    const waState = { getMessagesForThread: () => messages };
    const result = await refreshWhatsappItemBody({ waState, state, item });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bodyMd).toContain('Sprachnachricht-Inhalt');
  });

  it('returns not_found when the thread has zero messages', async () => {
    const item = waItem();
    const waState = { getMessagesForThread: () => [] };
    const result = await refreshWhatsappItemBody({ waState, state, item });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.kind).toBe('not_found');
  });

  it('returns empty_body when all messages lack text + transcript', async () => {
    const item = waItem();
    const messages = [
      waMsg({ id: '1', threadId: item.threadKey, direction: 'inbound', text: '', transcript: null }),
    ];
    const waState = { getMessagesForThread: () => messages };
    const result = await refreshWhatsappItemBody({ waState, state, item });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.kind).toBe('empty_body');
  });

  it('returns fetch_failed when the WA store throws', async () => {
    const item = waItem();
    const waState = {
      getMessagesForThread: () => { throw new Error('db locked'); },
    };
    const result = await refreshWhatsappItemBody({ waState, state, item });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.kind).toBe('fetch_failed');
  });

  it('truncates concatenated transcript to MAX_ITEM_BODY_CHARS', async () => {
    const item = waItem();
    const long = 'x'.repeat(5 * 1024);
    const messages = [
      waMsg({ id: '1', threadId: item.threadKey, direction: 'inbound', text: long }),
      waMsg({ id: '2', threadId: item.threadKey, direction: 'inbound', text: long }),
    ];
    const waState = { getMessagesForThread: () => messages };
    const result = await refreshWhatsappItemBody({ waState, state, item });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.bodyMd.length).toBe(8 * 1024);
    }
  });
});
