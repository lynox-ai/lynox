import { describe, expect, it } from 'vitest';
import { prefilter } from './rules.js';
import type { MailEnvelope } from '../provider.js';

function env(from: string, opts: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    uid: opts.uid ?? 1,
    messageId: opts.messageId ?? '<m@x>',
    folder: 'INBOX',
    threadKey: undefined,
    inReplyTo: undefined,
    from: [{ address: from }],
    to: [{ address: 'me@example.com' }],
    cc: [],
    replyTo: [],
    subject: opts.subject ?? 'Hi',
    date: new Date(),
    flags: [],
    snippet: '',
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: 0,
    isAutoReply: false,
  };
}

describe('prefilter — sender patterns', () => {
  it('flags noreply addresses as noise', () => {
    expect(prefilter(env('noreply@example.com')).category).toBe('noise');
    expect(prefilter(env('no-reply@example.com')).category).toBe('noise');
    expect(prefilter(env('donotreply@example.com')).category).toBe('noise');
    expect(prefilter(env('do-not-reply@example.com')).category).toBe('noise');
    expect(prefilter(env('notifications@github.com')).category).toBe('noise');
    expect(prefilter(env('alerts@datadog.com')).category).toBe('noise');
    expect(prefilter(env('mailer-daemon@bounces.aws')).category).toBe('noise');
    expect(prefilter(env('postmaster@example.com')).category).toBe('noise');
  });

  it('keeps real human addresses', () => {
    expect(prefilter(env('alice@example.com')).category).toBe('unknown');
    expect(prefilter(env('rafael@brandfusion.ch')).category).toBe('unknown');
  });

  it('flags newsletter subdomains as noise', () => {
    expect(prefilter(env('hello@newsletter.acme.com')).category).toBe('noise');
  });

  it('flags marketing/bulk subdomains as noise', () => {
    expect(prefilter(env('updates@mail.uber.com')).category).toBe('noise');
    expect(prefilter(env('hello@email.airbnb.com')).category).toBe('noise');
    expect(prefilter(env('news@news.economist.com')).category).toBe('noise');
    expect(prefilter(env('marketing@marketing.salesforce.com')).category).toBe('noise');
  });

  it('preserves legitimate mail.* provider addresses', () => {
    expect(prefilter(env('rafael@mail.icloud.com')).category).toBe('unknown');
    expect(prefilter(env('user@mail.proton.me')).category).toBe('unknown');
  });
});

describe('prefilter — header rules', () => {
  it('flags messages with List-Unsubscribe header', () => {
    const headers = new Map<string, string>([['list-unsubscribe', '<mailto:unsub@x.com>']]);
    const result = prefilter(env('alice@example.com'), headers);
    expect(result.category).toBe('noise');
    expect(result.reason).toContain('list-unsubscribe');
  });

  it('flags messages with List-Id header', () => {
    const headers = new Map<string, string>([['list-id', '<acme.list>']]);
    expect(prefilter(env('alice@example.com'), headers).category).toBe('noise');
  });

  it('keeps messages without bulk headers when sender is human', () => {
    const headers = new Map<string, string>([['date', 'Wed, 15 Apr 2026 10:00:00 +0000']]);
    expect(prefilter(env('alice@example.com'), headers).category).toBe('unknown');
  });
});
