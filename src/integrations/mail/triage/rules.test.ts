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
    listId: opts.listId,
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
    expect(prefilter(env('user@example.com')).category).toBe('unknown');
  });

  it('flags newsletter subdomains as noise', () => {
    expect(prefilter(env('hello@newsletter.acme.com')).category).toBe('noise');
  });

  it('flags marketing/bulk subdomains with 3+ subdomain levels as noise', () => {
    // 3+ subdomain levels is the new threshold — these are unambiguous
    // marketing infrastructure.
    expect(prefilter(env('news@mail.notifications.uber.com')).category).toBe('noise');
    expect(prefilter(env('promo@email.marketing.airbnb.com')).category).toBe('noise');
    expect(prefilter(env('news@news.list.economist.com')).category).toBe('noise');
  });

  it('keeps 2-level transactional bulk senders (audit K-LE-08: Stripe/DocuSign)', () => {
    // The previous 2-level heuristic silently dropped Stripe invoices,
    // DocuSign signing requests, Outlook protection rewrites. These have
    // to reach the inbox.
    expect(prefilter(env('invoice@mail.stripe.com')).category).toBe('unknown');
    expect(prefilter(env('signing@info.docusign.com')).category).toBe('unknown');
    expect(prefilter(env('postmaster-quarantine@mail.protection.outlook.com')).category).toBe('unknown');
    expect(prefilter(env('receipt@email.notion.com')).category).toBe('unknown');
  });

  it('preserves legitimate mail.* provider addresses', () => {
    expect(prefilter(env('someone@mail.icloud.com')).category).toBe('unknown');
    expect(prefilter(env('user@mail.proton.me')).category).toBe('unknown');
  });
});

describe('prefilter — no header decides', () => {
  // The prefilter judges the sender only: the mail_triage tool still counts a
  // noreply newsletter as noise, list-id or not.
  it('judges a list mail by its sender like any other', () => {
    expect(prefilter(env('alice@example.com', { listId: 'acme.list.example.com' })).category).toBe('unknown');
    expect(prefilter(env('noreply@example.com', { listId: 'acme.list.example.com' })).category).toBe('noise');
  });
});

describe('prefilter — which rule fired', () => {
  it('names the rule, and the domain for a domain rule', () => {
    expect(prefilter(env('notifications@github.com'))).toMatchObject({ rule: 'automated_sender' });
    expect(prefilter(env('notifications@github.com')).domain).toBeUndefined();
    expect(prefilter(env('hello@newsletter.acme.com'))).toMatchObject({ rule: 'newsletter_domain', domain: 'newsletter.acme.com' });
    expect(prefilter(env('news@mail.notifications.uber.com'))).toMatchObject({ rule: 'bulk_subdomain', domain: 'mail.notifications.uber.com' });
    expect(prefilter(env('alice@example.com')).rule).toBeUndefined();
  });
});
