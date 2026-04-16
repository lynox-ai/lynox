import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchMessageObject, SearchObject } from 'imapflow';
import { sanitizeFilename, htmlToTextSnippet, isAutoSubmittedHeader } from './imap-smtp.js';

// ── Mocks ──────────────────────────────────────────────────────────────────
//
// Both imapflow and nodemailer are mocked at module level. Each test gets a
// fresh `probe` (fake imapflow client) wired in via beforeEach so there is no
// cross-test state leakage from mockImplementationOnce chains.

interface FakeClient {
  usable: boolean;
  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getMailboxLock: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  fetchOne: ReturnType<typeof vi.fn>;
  downloadMany: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  const release = vi.fn();
  return {
    usable: true,
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    on: vi.fn(),
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    search: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockImplementation(() => asyncIterFrom([])),
    fetchOne: vi.fn().mockResolvedValue(false),
    downloadMany: vi.fn().mockResolvedValue({}),
  };
}

let probe: FakeClient;
let lastClientOptions: unknown = null;
let lastTransportOptions: unknown = null;
const sendMailMock = vi.fn();
const transportCloseMock = vi.fn();

vi.mock('imapflow', () => {
  function ImapFlow(this: unknown, opts: unknown): unknown {
    lastClientOptions = opts;
    return probe;
  }
  return {
    ImapFlow,
    AuthenticationFailure: class extends Error {
      constructor(msg: string) { super(msg); this.name = 'AuthenticationFailure'; }
    },
  };
});

vi.mock('nodemailer', () => {
  return {
    default: {
      createTransport: vi.fn().mockImplementation((opts: unknown) => {
        lastTransportOptions = opts;
        return { sendMail: sendMailMock, close: transportCloseMock };
      }),
    },
  };
});

// Imports must come AFTER vi.mock calls.
import { ImapSmtpProvider, type CredentialsResolver } from './imap-smtp.js';
import type { MailAccountConfig } from '../provider.js';
import { MailError } from '../provider.js';

const ACCOUNT: MailAccountConfig = {
  id: 'test-account',
  displayName: 'Test User',
  address: 'user@example.com',
  preset: 'custom',
  imap: { host: 'imap.example.com', port: 993, secure: true },
  smtp: { host: 'smtp.example.com', port: 465, secure: true },
  auth: 'app-password',
  type: 'personal',
};

const credResolver: CredentialsResolver = () => ({ user: 'user@example.com', pass: 'app-password-1234' });

beforeEach(() => {
  probe = makeFakeClient();
  lastClientOptions = null;
  lastTransportOptions = null;
  sendMailMock.mockReset();
  transportCloseMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Helpers to build fake IMAP responses ───────────────────────────────────

function makeFetchMessage(overrides: Partial<FetchMessageObject>): FetchMessageObject {
  return {
    seq: overrides.seq ?? 1,
    uid: overrides.uid ?? 100,
    envelope: overrides.envelope ?? {
      date: new Date('2026-04-15T10:00:00Z'),
      subject: 'Test Subject',
      messageId: '<msg-100@example.com>',
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      to: [{ name: 'Bob', address: 'bob@example.com' }],
      cc: [],
      replyTo: [{ address: 'alice@example.com' }],
    },
    flags: overrides.flags ?? new Set(['\\Seen']),
    internalDate: overrides.internalDate ?? new Date('2026-04-15T10:00:00Z'),
    size: overrides.size ?? 4096,
    bodyStructure: overrides.bodyStructure ?? {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain', part: '1', size: 200 },
        { type: 'application/pdf', part: '2', size: 102_400, disposition: 'attachment', dispositionParameters: { filename: 'report.pdf' } },
      ],
    },
    bodyParts: overrides.bodyParts ?? new Map([['1', Buffer.from('Hello, this is the plain text body.\nMultiple lines here.')]]),
  };
}

async function* asyncIterFrom<T>(items: T[]): AsyncIterableIterator<T> {
  for (const item of items) yield item;
}

describe('ImapSmtpProvider — connection', () => {
  it('connects with TLS options derived from account config', async () => {
    probe.search.mockResolvedValue([]);

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    await provider.list();

    const opts = lastClientOptions as { host: string; port: number; secure: boolean; tls: { rejectUnauthorized: boolean; minVersion: string } };
    expect(opts.host).toBe('imap.example.com');
    expect(opts.port).toBe(993);
    expect(opts.secure).toBe(true);
    expect(opts.tls.rejectUnauthorized).toBe(true);
    expect(opts.tls.minVersion).toBe('TLSv1.2');
    expect(probe.connect).toHaveBeenCalledTimes(1);
  });

  it('throws auth_failed without retrying on AuthenticationFailure', async () => {
    const fakeFetch = (await import('imapflow')) as unknown as { AuthenticationFailure: new (m: string) => Error };
    probe.connect.mockRejectedValue(new fakeFetch.AuthenticationFailure('LOGIN failed'));

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    const err = await provider.list().catch(e => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect(err.code).toBe('auth_failed');
    expect(probe.connect).toHaveBeenCalledTimes(1); // no retry on auth failures
  });
});

describe('ImapSmtpProvider — list', () => {
  it('returns envelopes most-recent-first with snippet, attachments, flags', async () => {
    probe.search.mockResolvedValue([1, 2]);
    probe.fetch.mockImplementation(() => asyncIterFrom([
      makeFetchMessage({
        uid: 1,
        envelope: {
          date: new Date('2026-04-10T08:00:00Z'),
          subject: 'Old',
          messageId: '<msg-1@example.com>',
          from: [{ name: 'A', address: 'a@example.com' }],
          to: [{ address: 'me@example.com' }],
          cc: [],
        },
      }),
      makeFetchMessage({
        uid: 2,
        envelope: {
          date: new Date('2026-04-15T08:00:00Z'),
          subject: 'New',
          messageId: '<msg-2@example.com>',
          from: [{ name: 'B', address: 'b@example.com' }],
          to: [{ address: 'me@example.com' }],
          cc: [],
        },
      }),
    ]));

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    const envelopes = await provider.list({ folder: 'INBOX', limit: 10 });

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]?.subject).toBe('New'); // sorted by date desc
    expect(envelopes[1]?.subject).toBe('Old');
    expect(envelopes[0]?.snippet).toBe('Hello, this is the plain text body.\nMultiple lines here.');
    expect(envelopes[0]?.hasAttachments).toBe(true);
    expect(envelopes[0]?.attachmentCount).toBe(1);
    expect(envelopes[0]?.flags).toEqual(['\\Seen']);
    expect(envelopes[0]?.from[0]?.address).toBe('b@example.com');
    expect(envelopes[0]?.folder).toBe('INBOX');

    expect(probe.getMailboxLock).toHaveBeenCalledWith('INBOX');
    expect(probe.search).toHaveBeenCalledWith({ all: true }, { uid: true });
  });

  it('translates since + unseenOnly into IMAP SEARCH', async () => {
    probe.search.mockResolvedValue([]);

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    const since = new Date('2026-04-14T00:00:00Z');
    await provider.list({ since, unseenOnly: true });

    const arg = probe.search.mock.calls[0]?.[0] as SearchObject;
    expect(arg.since).toBe(since);
    expect(arg.seen).toBe(false);
    expect(arg.all).toBeUndefined();
  });

  it('caps the limit at the default ceiling', async () => {
    probe.search.mockResolvedValue(Array.from({ length: 100 }, (_, i) => i + 1));
    probe.fetch.mockImplementation(() => asyncIterFrom([]));

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    await provider.list({ limit: 999 });

    const range = probe.fetch.mock.calls[0]?.[0] as number[];
    expect(range.length).toBe(50); // default cap
    expect(range).toEqual(Array.from({ length: 50 }, (_, i) => i + 51)); // last 50 of 1..100
  });
});

describe('ImapSmtpProvider — fetch', () => {
  it('returns full message with text body decoded from text/plain part', async () => {
    probe.fetchOne.mockResolvedValue(makeFetchMessage({ uid: 42 }));
    // Multipart message in default makeFetchMessage uses part '1'
    probe.fetch.mockImplementation(() => asyncIterFrom([
      { ...makeFetchMessage({ uid: 42 }), bodyParts: new Map([['1', Buffer.from('Full body text here.')]]) } as FetchMessageObject,
    ]));

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    const msg = await provider.fetch({ uid: 42 });

    expect(msg.text).toBe('Full body text here.');
    expect(msg.html).toBeUndefined();
    expect(msg.envelope.uid).toBe(42);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]?.filename).toBe('report.pdf');
    expect(msg.attachments[0]?.partId).toBe('2');
  });

  it('falls back to text/html stripped to plain when no text/plain part exists', async () => {
    probe.fetchOne.mockResolvedValue(makeFetchMessage({
      uid: 7,
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [{ type: 'text/html', part: '1', size: 500 }],
      },
    }));
    probe.fetch.mockImplementation(() => asyncIterFrom([
      { ...makeFetchMessage({ uid: 7 }), bodyParts: new Map([['1', Buffer.from('<p>Hello <strong>world</strong></p>')]]) } as FetchMessageObject,
    ]));

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    const msg = await provider.fetch({ uid: 7 });

    expect(msg.text).toContain('Hello');
    expect(msg.text).toContain('world');
    expect(msg.text).not.toContain('<');
  });

  it('throws not_found when fetchOne returns false', async () => {
    probe.fetchOne.mockResolvedValue(false);

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    const err = await provider.fetch({ uid: 999 }).catch(e => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect(err.code).toBe('not_found');
  });
});

describe('ImapSmtpProvider — search', () => {
  it('translates query fields into imapflow SearchObject', async () => {
    probe.search.mockResolvedValue([]);

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    await provider.search({ from: 'alice', subject: 'invoice', unseen: true, flagged: true });

    const arg = probe.search.mock.calls[0]?.[0] as SearchObject;
    expect(arg.from).toBe('alice');
    expect(arg.subject).toBe('invoice');
    expect(arg.seen).toBe(false);
    expect(arg.flagged).toBe(true);
  });

  it('filters hasAttachment client-side using BODYSTRUCTURE', async () => {
    probe.search.mockResolvedValue([1, 2]);
    probe.fetch.mockImplementation(() => asyncIterFrom([
      makeFetchMessage({
        uid: 1,
        bodyStructure: { type: 'text/plain', part: '1', size: 200 },
      }),
      makeFetchMessage({ uid: 2 }), // has attachment from default
    ]));

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    const out = await provider.search({ hasAttachment: true });
    expect(out).toHaveLength(1);
    expect(out[0]?.uid).toBe(2);
  });
});

describe('ImapSmtpProvider — send', () => {
  it('builds RFC-compliant payload via nodemailer with TLS strict', async () => {
    sendMailMock.mockResolvedValue({
      messageId: '<sent-1@example.com>',
      accepted: ['bob@example.com'],
      rejected: [],
    });

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    const result = await provider.send({
      to: [{ name: 'Bob', address: 'bob@example.com' }],
      subject: 'Hi',
      text: 'Just saying hello.',
      inReplyTo: '<old@example.com>',
      references: '<old@example.com>',
    });

    expect(result.messageId).toBe('<sent-1@example.com>');
    expect(result.accepted).toEqual(['bob@example.com']);
    expect(result.rejected).toEqual([]);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const args = sendMailMock.mock.calls[0]?.[0] as { from: { address: string }; to: string[]; inReplyTo: string };
    expect(args.from.address).toBe('user@example.com');
    expect(args.to[0]).toBe('"Bob" <bob@example.com>');
    expect(args.inReplyTo).toBe('<old@example.com>');

    const transport = lastTransportOptions as { host: string; port: number; secure: boolean; requireTLS: boolean; tls: { rejectUnauthorized: boolean } };
    expect(transport.host).toBe('smtp.example.com');
    expect(transport.port).toBe(465);
    expect(transport.secure).toBe(true);
    expect(transport.requireTLS).toBe(false); // implicit TLS — STARTTLS is moot
    expect(transport.tls.rejectUnauthorized).toBe(true);
  });

  it('maps SMTP auth failure to MailError(auth_failed)', async () => {
    const authErr = new Error('Invalid credentials');
    authErr.name = 'AuthenticationFailure';
    sendMailMock.mockRejectedValue(authErr);

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    const err = await provider.send({ to: [{ address: 'b@example.com' }], subject: 's', text: 't' }).catch(e => e as MailError);
    expect(err.code).toBe('auth_failed');
  });
});

describe('ImapSmtpProvider — close', () => {
  it('logs out IMAP and closes SMTP transport, idempotent', async () => {
    probe.search.mockResolvedValue([]);
    sendMailMock.mockResolvedValue({ messageId: 'x', accepted: [], rejected: [] });

    const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
    await provider.list();
    await provider.send({ to: [{ address: 'a@example.com' }], subject: 's', text: 't' });

    await provider.close();
    await provider.close(); // second call should not throw

    expect(probe.logout).toHaveBeenCalledTimes(1);
    expect(transportCloseMock).toHaveBeenCalledTimes(1);

    // After close, list() must reject
    const err = await provider.list().catch(e => e as MailError);
    expect(err.code).toBe('connection_failed');
  });
});

describe('ImapSmtpProvider — watch', () => {
  it('polls list() on the requested interval and emits new envelopes', async () => {
    vi.useFakeTimers();
    try {
      probe.search.mockResolvedValue([1]);
      probe.fetch.mockImplementation(() => asyncIterFrom([makeFetchMessage({ uid: 1 })]));

      const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
      const events: Array<{ type: string; count?: number }> = [];
      const handle = await provider.watch({ intervalMs: 60_000 }, async (event) => {
        if (event.type === 'new') events.push({ type: 'new', count: event.envelopes.length });
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]?.count).toBe(1);

      await handle.stop();
      const before = probe.search.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probe.search.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes errors to the handler without throwing', async () => {
    vi.useFakeTimers();
    try {
      probe.search.mockRejectedValue(new Error('network glitch'));

      const provider = new ImapSmtpProvider(ACCOUNT, credResolver);
      const errs: Error[] = [];
      const handle = await provider.watch({ intervalMs: 60_000 }, async (event) => {
        if (event.type === 'error') errs.push(event.error);
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(errs.length).toBeGreaterThanOrEqual(1);
      expect(errs[0]).toBeInstanceOf(Error);
      await handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Security helpers (Phase 0.2 polish) ─────────────────────────────────────

describe('sanitizeFilename', () => {
  it('returns undefined for missing input', () => {
    expect(sanitizeFilename(undefined)).toBeUndefined();
    expect(sanitizeFilename('')).toBeUndefined();
  });

  it('passes through benign filenames', () => {
    expect(sanitizeFilename('invoice-2026.pdf')).toBe('invoice-2026.pdf');
    expect(sanitizeFilename('Q1 report.xlsx')).toBe('Q1 report.xlsx');
  });

  it('strips control characters including CRLF injection', () => {
    const malicious = 'file.pdf\r\nBcc: victim@x.com';
    expect(sanitizeFilename(malicious)).toBe('file.pdfBcc: victim@x.com');
  });

  it('strips null bytes', () => {
    expect(sanitizeFilename('safe\x00.pdf')).toBe('safe.pdf');
  });

  it('neutralises path traversal attempts', () => {
    // Slashes are replaced with underscores BEFORE leading-dot stripping, so
    // `../../../etc/passwd` becomes `.._.._.._etc_passwd` then `_.._.._etc_passwd`.
    // The key safety property is that no actual path separator survives.
    const traversal = sanitizeFilename('../../../etc/passwd');
    expect(traversal).not.toMatch(/[/\\]/);
    expect(traversal).not.toMatch(/^\./);
    const winTraversal = sanitizeFilename('..\\..\\windows\\system32');
    expect(winTraversal).not.toMatch(/[/\\]/);
    expect(winTraversal).not.toMatch(/^\./);
  });

  it('strips leading dots so hidden-file names do not survive', () => {
    expect(sanitizeFilename('.env')).toBe('env');
    expect(sanitizeFilename('..config')).toBe('config');
  });

  it('caps length at 200 chars', () => {
    const long = 'a'.repeat(500) + '.pdf';
    const result = sanitizeFilename(long);
    expect(result?.length).toBe(200);
  });
});

describe('htmlToTextSnippet — hidden-content stripping', () => {
  it('strips display:none elements', () => {
    const html = '<p>visible</p><div style="display:none">invisible-payload</div>';
    const out = htmlToTextSnippet(html);
    expect(out).toContain('visible');
    expect(out).not.toContain('invisible-payload');
  });

  it('strips visibility:hidden elements', () => {
    const html = '<p>ok</p><div style="visibility:hidden">hidden-payload</div>';
    expect(htmlToTextSnippet(html)).not.toContain('hidden-payload');
  });

  it('strips font-size:0 text', () => {
    const html = '<p>ok</p><span style="font-size:0">tiny-payload</span>';
    expect(htmlToTextSnippet(html)).not.toContain('tiny-payload');
  });

  it('strips opacity:0 elements', () => {
    const html = '<p>ok</p><div style="opacity:0">invisible</div>';
    expect(htmlToTextSnippet(html)).not.toContain('invisible');
  });

  it('strips HTML comments and CDATA', () => {
    const html = '<p>ok</p><!-- hidden comment payload --><![CDATA[cdata payload]]>';
    const out = htmlToTextSnippet(html);
    expect(out).not.toContain('hidden comment');
    expect(out).not.toContain('cdata payload');
  });

  it('strips script, style, noscript, template, head, title', () => {
    const html = `
      <head><title>title</title></head>
      <script>alert('xss')</script>
      <style>.a{color:red}</style>
      <noscript>noscript-payload</noscript>
      <template>template-payload</template>
      <body><p>real</p></body>
    `;
    const out = htmlToTextSnippet(html);
    expect(out).toContain('real');
    expect(out).not.toContain('xss');
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('noscript-payload');
    expect(out).not.toContain('template-payload');
    expect(out).not.toContain('title');
  });
});

describe('isAutoSubmittedHeader', () => {
  it('returns false for missing / empty headers', () => {
    expect(isAutoSubmittedHeader(undefined)).toBe(false);
    expect(isAutoSubmittedHeader('')).toBe(false);
  });

  it('returns false for "no" (explicit human marker per RFC 3834)', () => {
    expect(isAutoSubmittedHeader('no')).toBe(false);
    expect(isAutoSubmittedHeader('No')).toBe(false);
    expect(isAutoSubmittedHeader('NO ')).toBe(false);
  });

  it('returns true for common automated values', () => {
    expect(isAutoSubmittedHeader('auto-generated')).toBe(true);
    expect(isAutoSubmittedHeader('auto-replied')).toBe(true);
    expect(isAutoSubmittedHeader('auto-notified')).toBe(true);
  });
});
