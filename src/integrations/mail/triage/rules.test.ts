import { describe, expect, it } from 'vitest';
import { domainOf, mailingListOf, prefilter } from './rules.js';
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
  // The prefilter judges the sender only. The watcher keeps list mail out of
  // its silent drop, and the mail_triage tool still counts a noreply
  // newsletter as noise, list-id or not.
  it('judges a list mail by its sender like any other', () => {
    expect(prefilter(env('alice@example.com', { listId: 'acme.list.example.com' })).category).toBe('unknown');
    expect(prefilter(env('noreply@example.com', { listId: 'acme.list.example.com' })).category).toBe('noise');
  });
});

describe('mailingListOf — the one place that decides', () => {
  const list = (listId: string | undefined, own: string[]) => mailingListOf(env('alice@example.com', { listId }), own);

  it('a list-id under no connected domain is a mailing list', () => {
    expect(list('news.example.org', ['acme.example'])).toBe('news.example.org');
  });

  it('a list-id under a connected domain is the business\'s own group', () => {
    expect(list('info.acme.example', ['acme.example'])).toBeUndefined();
    expect(list('Info.ACME.example', ['acme.example']), 'case does not matter').toBeUndefined();
    expect(list('acme.example', ['acme.example'])).toBeUndefined();
    expect(list('info.acme.ch', ['acme.example', 'acme.ch']), 'any connected domain').toBeUndefined();
    expect(list('info.acme.example.', ['acme.example']), 'a trailing dot').toBeUndefined();
  });

  it('only at a dot boundary', () => {
    expect(list('info.notacme.example', ['acme.example'])).toBe('info.notacme.example');
    expect(list('info.acme.example.evil', ['acme.example'])).toBe('info.acme.example.evil');
    expect(list('news.example.org', [''])).toBe('news.example.org');
  });

  it('no list-id, no list', () => {
    expect(list(undefined, ['acme.example'])).toBeUndefined();
  });

  it('domainOf', () => {
    expect(domainOf('Me@ACME.example')).toBe('acme.example');
    expect(domainOf('no-at')).toBe('');
  });
});
