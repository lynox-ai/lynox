import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthGmailProvider } from './oauth-gmail.js';
import { MailError, type MailAccountConfig } from '../provider.js';
import type { GoogleAuth } from '../../google/google-auth.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeAccount(): MailAccountConfig {
  return {
    id: 'gmail-rafael',
    displayName: 'Rafael',
    address: 'rafael@lynox.ai',
    preset: 'gmail',
    imap: { host: '', port: 0, secure: true },
    smtp: { host: '', port: 0, secure: true },
    authType: 'oauth_google',
    oauthProviderKey: 'GOOGLE_OAUTH_TOKENS',
    type: 'personal',
  };
}

function makeAuth(overrides: Partial<GoogleAuth> = {}): GoogleAuth {
  return {
    isAuthenticated: vi.fn().mockReturnValue(true),
    getAccessToken: vi.fn().mockResolvedValue('test-token'),
    hasScope: vi.fn().mockReturnValue(true),
    ...overrides,
  } as unknown as GoogleAuth;
}

// Build a Gmail API response for one message (metadata format)
function metadataMessage(id: string, opts: {
  threadId?: string;
  subject?: string;
  from?: string;
  to?: string;
  messageId?: string;
  internalDate?: string;
  snippet?: string;
  labelIds?: string[];
  autoSubmitted?: string;
} = {}): Record<string, unknown> {
  const headers: Array<{ name: string; value: string }> = [];
  if (opts.from) headers.push({ name: 'From', value: opts.from });
  if (opts.to) headers.push({ name: 'To', value: opts.to });
  if (opts.subject) headers.push({ name: 'Subject', value: opts.subject });
  headers.push({ name: 'Date', value: '2026-04-26T19:46:35Z' });
  headers.push({ name: 'Message-ID', value: opts.messageId ?? `<${id}@gmail.com>` });
  if (opts.autoSubmitted) headers.push({ name: 'Auto-Submitted', value: opts.autoSubmitted });
  return {
    id,
    threadId: opts.threadId ?? `thread-${id}`,
    snippet: opts.snippet ?? 'snippet body',
    labelIds: opts.labelIds ?? ['INBOX'],
    internalDate: opts.internalDate ?? String(Date.parse('2026-04-26T19:46:35Z')),
    payload: { headers },
  };
}

// Build a Gmail API response for a full message body
function fullMessage(id: string, body: string, opts: { from?: string; subject?: string; html?: string; threadId?: string } = {}): Record<string, unknown> {
  const headers = [
    { name: 'From', value: opts.from ?? 'sender@example.com' },
    { name: 'To', value: 'rafael@lynox.ai' },
    { name: 'Subject', value: opts.subject ?? 'Subject' },
    { name: 'Message-ID', value: `<${id}@gmail.com>` },
  ];
  const parts: Array<Record<string, unknown>> = [
    { partId: '0', mimeType: 'text/plain', body: { size: body.length, data: Buffer.from(body, 'utf-8').toString('base64url') } },
  ];
  if (opts.html) {
    parts.push({ partId: '1', mimeType: 'text/html', body: { size: opts.html.length, data: Buffer.from(opts.html, 'utf-8').toString('base64url') } });
  }
  return {
    id,
    threadId: opts.threadId ?? `thread-${id}`,
    snippet: body.slice(0, 100),
    labelIds: ['INBOX'],
    internalDate: String(Date.parse('2026-04-26T19:46:35Z')),
    sizeEstimate: 4096,
    payload: { mimeType: 'multipart/alternative', headers, parts },
  };
}

// ── Mocked fetch — returns canned responses keyed by URL substring ────────

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

function respondJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function respondText(text: string, status: number): Response {
  return new Response(text, { status });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('OAuthGmailProvider — list', () => {
  it('returns envelopes built from messages.list + per-id metadata fetch', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('?labelIds=INBOX')) {
        return Promise.resolve(respondJson({ messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }] }));
      }
      if (url.includes('messages/m1')) {
        return Promise.resolve(respondJson(metadataMessage('m1', { threadId: 't1', subject: 'Hello', from: 'alice@example.com' })));
      }
      if (url.includes('messages/m2')) {
        return Promise.resolve(respondJson(metadataMessage('m2', { threadId: 't2', subject: 'World', from: 'bob@example.com' })));
      }
      return Promise.resolve(respondText('not stubbed', 404));
    });

    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const envs = await provider.list();
    expect(envs).toHaveLength(2);
    expect(envs[0]?.subject).toBe('Hello');
    expect(envs[0]?.from[0]?.address).toBe('alice@example.com');
    expect(envs[0]?.threadKey).toBe('gmail:t1');
    expect(envs[1]?.subject).toBe('World');
    expect(envs[1]?.uid).not.toBe(envs[0]?.uid);
  });

  it('passes since + unseenOnly into the q parameter', async () => {
    fetchMock.mockResolvedValue(respondJson({ messages: [] }));
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const since = new Date('2026-04-20T00:00:00Z');
    await provider.list({ unseenOnly: true, since, limit: 10 });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('labelIds=INBOX');
    expect(url).toContain('maxResults=10');
    expect(url).toContain('is%3Aunread');
    expect(url).toContain(`after%3A${String(Math.floor(since.getTime() / 1000))}`);
  });

  it('flags Auto-Submitted messages as isAutoReply', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('?labelIds')) return Promise.resolve(respondJson({ messages: [{ id: 'm1', threadId: 't1' }] }));
      if (url.includes('messages/m1')) return Promise.resolve(respondJson(metadataMessage('m1', { autoSubmitted: 'auto-replied' })));
      return Promise.resolve(respondText('not stubbed', 404));
    });

    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const envs = await provider.list();
    expect(envs[0]?.isAutoReply).toBe(true);
  });

  it('UNREAD label maps to absent \\Seen flag', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('?labelIds')) return Promise.resolve(respondJson({ messages: [{ id: 'unread1', threadId: 't' }] }));
      if (url.includes('messages/')) return Promise.resolve(respondJson(metadataMessage('unread1', { labelIds: ['INBOX', 'UNREAD'] })));
      return Promise.resolve(respondText('not stubbed', 404));
    });
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const envs = await provider.list();
    expect(envs[0]?.flags).not.toContain('\\Seen');
  });
});

describe('OAuthGmailProvider — fetch', () => {
  it('returns a full message with text body and uses the synthetic uid map', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('?labelIds')) return Promise.resolve(respondJson({ messages: [{ id: 'mfull', threadId: 'tfull' }] }));
      if (url.includes('messages/mfull?format=metadata')) return Promise.resolve(respondJson(metadataMessage('mfull', { subject: 'Doc' })));
      if (url.includes('messages/mfull?format=full')) return Promise.resolve(respondJson(fullMessage('mfull', 'Hello, this is the body.\nLine 2.', { subject: 'Doc' })));
      return Promise.resolve(respondText('not stubbed', 404));
    });

    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const envs = await provider.list();
    const uid = envs[0]!.uid;

    const msg = await provider.fetch({ uid });
    expect(msg.envelope.subject).toBe('Doc');
    expect(msg.text).toContain('Hello, this is the body.');
    expect(msg.html).toBeUndefined();
  });

  it('throws not_found when uid was never seen', async () => {
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const err = await provider.fetch({ uid: 999 }).catch(e => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect(err.code).toBe('not_found');
  });

  it('returns html body when includeHtml=true', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('?labelIds')) return Promise.resolve(respondJson({ messages: [{ id: 'mh', threadId: 'th' }] }));
      if (url.includes('messages/mh?format=metadata')) return Promise.resolve(respondJson(metadataMessage('mh')));
      if (url.includes('messages/mh?format=full')) return Promise.resolve(respondJson(fullMessage('mh', 'plain', { html: '<p>html</p>' })));
      return Promise.resolve(respondText('not stubbed', 404));
    });

    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const envs = await provider.list();
    const msg = await provider.fetch({ uid: envs[0]!.uid, includeHtml: true });
    expect(msg.html).toBe('<p>html</p>');
  });
});

describe('OAuthGmailProvider — search', () => {
  it('translates query into Gmail search syntax', async () => {
    fetchMock.mockResolvedValue(respondJson({ messages: [] }));
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    await provider.search({ from: 'alice@example.com', subject: 'invoice', unseen: true, hasAttachment: true });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('from%3Aalice%40example.com');
    expect(url).toContain('subject%3A%22invoice%22');
    expect(url).toContain('is%3Aunread');
    expect(url).toContain('has%3Aattachment');
  });
});

describe('OAuthGmailProvider — send', () => {
  it('refuses without gmail.send scope', async () => {
    const auth = makeAuth({ hasScope: vi.fn().mockReturnValue(false) } as Partial<GoogleAuth>);
    const provider = new OAuthGmailProvider(makeAccount(), auth);
    const err = await provider.send({
      to: [{ address: 'b@example.com' }],
      subject: 's',
      text: 't',
    }).catch(e => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect(err.code).toBe('unsupported');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a base64url-encoded RFC2822 message and returns the Gmail id', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith('/profile')) return Promise.resolve(respondJson({ emailAddress: 'rafael@lynox.ai' }));
      if (init?.method === 'POST' && url.includes('messages/send')) {
        return Promise.resolve(respondJson({ id: 'sent-123', threadId: 'thread-x' }));
      }
      return Promise.resolve(respondText('not stubbed', 404));
    });

    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const result = await provider.send({
      to: [{ address: 'bob@example.com' }],
      cc: [{ address: 'cc@example.com' }],
      subject: 'Hello',
      text: 'Body content',
    });

    expect(result.messageId).toBe('sent-123');
    expect(result.accepted).toEqual(['bob@example.com', 'cc@example.com']);

    const sendCall = fetchMock.mock.calls.find(c => String(c[0]).includes('messages/send'))!;
    const body = JSON.parse((sendCall[1] as { body: string }).body) as { raw: string };
    const decoded = Buffer.from(body.raw, 'base64').toString('utf-8');
    expect(decoded).toContain('From: rafael@lynox.ai');
    expect(decoded).toContain('To: bob@example.com');
    expect(decoded).toContain('Cc: cc@example.com');
    expect(decoded).toContain('Subject: Hello');
    expect(decoded).toContain('Body content');
  });
});

describe('OAuthGmailProvider — error mapping', () => {
  it('maps 401 to auth_failed', async () => {
    fetchMock.mockResolvedValue(respondText('unauthorized', 401));
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const err = await provider.list().catch(e => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect(err.code).toBe('auth_failed');
  });

  it('maps 429 to rate_limited', async () => {
    fetchMock.mockResolvedValue(respondText('quota exceeded', 429));
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const err = await provider.list().catch(e => e as MailError);
    expect(err.code).toBe('rate_limited');
  });

  it('maps 500 to connection_failed', async () => {
    fetchMock.mockResolvedValue(respondText('internal error', 500));
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const err = await provider.list().catch(e => e as MailError);
    expect(err.code).toBe('connection_failed');
  });
});

describe('OAuthGmailProvider — close', () => {
  it('clears watchers and uid map and refuses subsequent calls', async () => {
    fetchMock.mockResolvedValue(respondJson({ messages: [] }));
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    await provider.list();
    await provider.close();
    const err = await provider.list().catch(e => e as MailError);
    expect(err.code).toBe('connection_failed');
  });
});
