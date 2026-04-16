import { describe, expect, it } from 'vitest';
import { groupByThread } from './thread.js';
import type { MailEnvelope, MailFlag } from '../provider.js';

function env(opts: {
  uid: number;
  messageId: string;
  inReplyTo?: string | undefined;
  threadKey?: string | undefined;
  date: string;
  flags?: ReadonlyArray<MailFlag>;
  subject?: string;
}): MailEnvelope {
  return {
    uid: opts.uid,
    messageId: opts.messageId,
    folder: 'INBOX',
    threadKey: opts.threadKey ?? opts.messageId,
    inReplyTo: opts.inReplyTo,
    from: [{ address: 'a@x.com' }],
    to: [{ address: 'me@x.com' }],
    cc: [],
    replyTo: [],
    subject: opts.subject ?? 'Test',
    date: new Date(opts.date),
    flags: opts.flags ?? [],
    snippet: '',
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: 100,
    isAutoReply: false,
  };
}

describe('groupByThread', () => {
  it('returns an empty list for empty input', () => {
    expect(groupByThread([])).toEqual([]);
  });

  it('puts a single message in its own thread', () => {
    const threads = groupByThread([env({ uid: 1, messageId: '<a>', date: '2026-04-15T10:00:00Z' })]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.envelopes).toHaveLength(1);
    expect(threads[0]?.key).toBe('<a>');
  });

  it('groups a reply with its parent via In-Reply-To', () => {
    const threads = groupByThread([
      env({ uid: 1, messageId: '<a>', date: '2026-04-15T10:00:00Z' }),
      env({ uid: 2, messageId: '<b>', inReplyTo: '<a>', date: '2026-04-15T11:00:00Z' }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.envelopes).toHaveLength(2);
    expect(threads[0]?.first.uid).toBe(1);
    expect(threads[0]?.last.uid).toBe(2);
  });

  it('chains three messages via parent → child → grandchild', () => {
    const threads = groupByThread([
      env({ uid: 1, messageId: '<a>', date: '2026-04-15T10:00:00Z' }),
      env({ uid: 2, messageId: '<b>', inReplyTo: '<a>', date: '2026-04-15T11:00:00Z' }),
      env({ uid: 3, messageId: '<c>', inReplyTo: '<b>', date: '2026-04-15T12:00:00Z' }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.envelopes.map(e => e.uid)).toEqual([1, 2, 3]);
  });

  it('keeps unrelated messages in separate threads', () => {
    const threads = groupByThread([
      env({ uid: 1, messageId: '<a>', date: '2026-04-15T10:00:00Z' }),
      env({ uid: 2, messageId: '<b>', date: '2026-04-15T11:00:00Z' }),
      env({ uid: 3, messageId: '<c>', date: '2026-04-15T12:00:00Z' }),
    ]);
    expect(threads).toHaveLength(3);
  });

  it('joins messages that share a server-supplied threadKey (e.g. Gmail X-GM-THRID)', () => {
    const threads = groupByThread([
      env({ uid: 1, messageId: '<a>', threadKey: 'gmail-thread-42', date: '2026-04-15T10:00:00Z' }),
      env({ uid: 2, messageId: '<b>', threadKey: 'gmail-thread-42', date: '2026-04-15T11:00:00Z' }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.envelopes).toHaveLength(2);
  });

  it('flags hasUnread when any envelope is missing \\Seen', () => {
    const threads = groupByThread([
      env({ uid: 1, messageId: '<a>', date: '2026-04-15T10:00:00Z', flags: ['\\Seen'] }),
      env({ uid: 2, messageId: '<b>', inReplyTo: '<a>', date: '2026-04-15T11:00:00Z', flags: [] }),
    ]);
    expect(threads[0]?.hasUnread).toBe(true);
  });

  it('returns threads sorted by most-recent activity first', () => {
    const threads = groupByThread([
      env({ uid: 1, messageId: '<a>', date: '2026-04-10T10:00:00Z' }), // older
      env({ uid: 2, messageId: '<b>', date: '2026-04-15T10:00:00Z' }), // newer
    ]);
    expect(threads[0]?.first.uid).toBe(2);
    expect(threads[1]?.first.uid).toBe(1);
  });

  it('handles out-of-order envelopes (reply seen before parent)', () => {
    const threads = groupByThread([
      env({ uid: 2, messageId: '<b>', inReplyTo: '<a>', date: '2026-04-15T11:00:00Z' }),
      env({ uid: 1, messageId: '<a>', date: '2026-04-15T10:00:00Z' }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.envelopes.map(e => e.uid)).toEqual([1, 2]);
  });
});
