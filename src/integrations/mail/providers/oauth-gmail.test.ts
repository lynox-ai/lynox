import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthGmailProvider } from './oauth-gmail.js';
import { MailError, type MailAccountConfig, type MailEnvelope } from '../provider.js';
import type { GoogleAuth } from '../../google/google-auth.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeAccount(): MailAccountConfig {
  return {
    id: 'gmail-rafael',
    displayName: 'Rafael',
    address: 'user@example.org',
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
    { name: 'To', value: 'user@example.org' },
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
      if (url.endsWith('/profile')) return Promise.resolve(respondJson({ emailAddress: 'user@example.org' }));
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
    expect(decoded).toContain('From: user@example.org');
    expect(decoded).toContain('To: bob@example.com');
    expect(decoded).toContain('Cc: cc@example.com');
    expect(decoded).toContain('Subject: Hello');
    expect(decoded).toContain('Body content');
    // Date header is present so receivers don't have to backfill on bounce
    expect(decoded).toMatch(/Date: \w{3}, \d{2} \w{3} \d{4}/);
  });

  it('strips CRLF from headers — defeats SMTP injection via subject', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith('/profile')) return Promise.resolve(respondJson({ emailAddress: 'user@example.org' }));
      if (init?.method === 'POST' && url.includes('messages/send')) {
        return Promise.resolve(respondJson({ id: 'sent-1', threadId: 't' }));
      }
      return Promise.resolve(respondText('not stubbed', 404));
    });
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    await provider.send({
      to: [{ address: 'bob@example.com' }],
      subject: 'Hello\r\nBcc: attacker@evil.com',
      text: 'body',
    });
    const sendCall = fetchMock.mock.calls.find(c => String(c[0]).includes('messages/send'))!;
    const decoded = Buffer.from(JSON.parse((sendCall[1] as { body: string }).body).raw, 'base64').toString('utf-8');
    // The CRLF must be collapsed so the smuggled Bcc never lands on its own line
    expect(decoded).not.toMatch(/^Bcc: attacker@evil\.com/m);
    expect(decoded).toContain('Subject: Hello Bcc: attacker@evil.com');
  });

  it('strips CRLF from display name and escapes embedded quotes', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith('/profile')) return Promise.resolve(respondJson({ emailAddress: 'user@example.org' }));
      if (init?.method === 'POST' && url.includes('messages/send')) {
        return Promise.resolve(respondJson({ id: 'sent-1', threadId: 't' }));
      }
      return Promise.resolve(respondText('not stubbed', 404));
    });
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    await provider.send({
      to: [{ name: 'Bob "the Hacker"\r\nX-Injected: yes', address: 'bob@example.com' }],
      subject: 'Hi',
      text: 'body',
    });
    const sendCall = fetchMock.mock.calls.find(c => String(c[0]).includes('messages/send'))!;
    const decoded = Buffer.from(JSON.parse((sendCall[1] as { body: string }).body).raw, 'base64').toString('utf-8');
    expect(decoded).not.toMatch(/^X-Injected:/m);
    expect(decoded).toContain('"Bob \\"the Hacker\\" X-Injected: yes" <bob@example.com>');
  });
});

describe('OAuthGmailProvider — UID map LRU', () => {
  it('reuses the same uid when a Gmail id reappears in a later list', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('?labelIds')) return Promise.resolve(respondJson({ messages: [{ id: 'stable-1', threadId: 't1' }] }));
      if (url.includes('messages/stable-1')) return Promise.resolve(respondJson(metadataMessage('stable-1', { threadId: 't1', subject: 'A' })));
      return Promise.resolve(respondText('not stubbed', 404));
    });
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const first = await provider.list();
    const second = await provider.list();
    expect(first[0]?.uid).toBe(second[0]?.uid);
  });

  it('evicts the oldest entry when the LRU cap is reached', async () => {
    let counter = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('?labelIds')) {
        const id = `m-${String(counter++)}`;
        return Promise.resolve(respondJson({ messages: [{ id, threadId: `t-${id}` }] }));
      }
      const idMatch = url.match(/messages\/([^?]+)/);
      const id = idMatch?.[1] ?? 'unknown';
      return Promise.resolve(respondJson(metadataMessage(id, { threadId: `t-${id}` })));
    });
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    let firstUid: number | undefined;
    for (let i = 0; i < 10_002; i++) {
      const envs = await provider.list();
      if (i === 0) firstUid = envs[0]?.uid;
    }
    // The first uid should now be evicted — fetch must report not_found
    const err = await provider.fetch({ uid: firstUid! }).catch(e => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect(err.code).toBe('not_found');
  }, 30_000);
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

  it('maps 403 insufficientPermissions to auth_failed', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { code: 403, errors: [{ reason: 'insufficientPermissions', message: 'Insufficient Permission' }] },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const err = await provider.list().catch(e => e as MailError);
    expect(err.code).toBe('auth_failed');
  });

  it('maps 403 quotaExceeded to rate_limited (separate from missing-scope)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { code: 403, errors: [{ reason: 'userRateLimitExceeded', message: 'Quota exceeded' }] },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const err = await provider.list().catch(e => e as MailError);
    expect(err.code).toBe('rate_limited');
  });
});

describe('OAuthGmailProvider — body decoding', () => {
  it('decodes quoted-printable bodies according to declared charset', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('?labelIds')) return Promise.resolve(respondJson({ messages: [{ id: 'qp', threadId: 'tqp' }] }));
      if (url.includes('messages/qp?format=metadata')) return Promise.resolve(respondJson(metadataMessage('qp', { threadId: 'tqp' })));
      if (url.includes('messages/qp?format=full')) {
        // body says "Grüße — €5" in quoted-printable + UTF-8
        const qpEncoded = 'Gr=C3=BC=C3=9Fe =E2=80=94 =E2=82=AC5';
        const partData = Buffer.from(qpEncoded).toString('base64url');
        return Promise.resolve(respondJson({
          id: 'qp', threadId: 'tqp', snippet: '', labelIds: ['INBOX'], internalDate: '0', sizeEstimate: 100,
          payload: {
            mimeType: 'multipart/alternative',
            headers: [],
            parts: [{
              partId: '0',
              mimeType: 'text/plain',
              headers: [
                { name: 'Content-Type', value: 'text/plain; charset="UTF-8"' },
                { name: 'Content-Transfer-Encoding', value: 'quoted-printable' },
              ],
              body: { size: qpEncoded.length, data: partData },
            }],
          },
        }));
      }
      return Promise.resolve(respondText('not stubbed', 404));
    });
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const envs = await provider.list();
    const msg = await provider.fetch({ uid: envs[0]!.uid });
    expect(msg.text).toBe('Grüße — €5');
  });

  it('decodes RFC 2047 MIME encoded-words in subject + from headers', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('?labelIds')) return Promise.resolve(respondJson({ messages: [{ id: 'mw', threadId: 'tmw' }] }));
      if (url.includes('messages/mw')) {
        const headers = [
          { name: 'From', value: '=?UTF-8?B?VHLDpGdlcg==?= <a@example.com>' },  // "Träger" base64
          { name: 'To', value: 'me@example.com' },
          { name: 'Subject', value: '=?UTF-8?Q?Gr=C3=BC=C3=9Fe?=' },  // "Grüße" Q-encoded
          { name: 'Date', value: '2026-04-26T19:46:35Z' },
          { name: 'Message-ID', value: '<mw@example.com>' },
        ];
        return Promise.resolve(respondJson({
          id: 'mw', threadId: 'tmw', snippet: '', labelIds: ['INBOX'], internalDate: '0',
          payload: { headers },
        }));
      }
      return Promise.resolve(respondText('not stubbed', 404));
    });
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const envs = await provider.list();
    expect(envs[0]?.subject).toBe('Grüße');
    expect(envs[0]?.from[0]?.name).toBe('Träger');
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

  it('aborts in-flight gmailGet so late resolutions cannot pollute the cleared uid map', async () => {
    let capturedSignal: AbortSignal | undefined;
    // The mock never resolves on its own — only an abort can settle it.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const listPromise = provider.list().catch((e: unknown) => e);

    // Yield so the fetch is in-flight before we call close().
    await new Promise((r) => setImmediate(r));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    await provider.close();

    expect(capturedSignal?.aborted).toBe(true);
    const result = await listPromise;
    expect(result).toBeInstanceOf(MailError);
  });
});

describe('OAuthGmailProvider — watch', () => {
  it('queries with a 60-second SINCE overlap to absorb clock skew + Gmail index lag', async () => {
    let capturedListUrl: string | undefined;
    fetchMock.mockImplementation((url: string) => {
      const s = String(url);
      if (s.includes('/messages?') && !s.match(/\/messages\/[^?]+/)) {
        capturedListUrl = s;
        return Promise.resolve(respondJson({ messages: [] }));
      }
      return Promise.resolve(respondJson({}));
    });

    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const beforeSeconds = Math.floor(Date.now() / 1000);
    const handle = await provider.watch({ intervalMs: 50, folder: 'INBOX' }, async () => {});

    // One tick interval + slack
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop();
    await provider.close();

    expect(capturedListUrl).toBeDefined();
    const q = new URL(capturedListUrl!).searchParams.get('q') ?? '';
    const m = q.match(/after:(\d+)/);
    expect(m).toBeTruthy();
    const afterSeconds = Number(m![1]);
    // `since` should sit ~60s before "now" because of the overlap.
    const lag = beforeSeconds - afterSeconds;
    expect(lag).toBeGreaterThanOrEqual(59);
    expect(lag).toBeLessThanOrEqual(63);
  });

  it('deduplicates the same Gmail message across two overlapping ticks', async () => {
    fetchMock.mockImplementation((url: string) => {
      const s = String(url);
      if (s.includes('/messages?') && !s.match(/\/messages\/[^?]+/)) {
        return Promise.resolve(respondJson({ messages: [{ id: 'msg-overlap', threadId: 't-1' }] }));
      }
      if (s.match(/\/messages\/msg-overlap\?/)) {
        return Promise.resolve(respondJson(metadataMessage('msg-overlap', { subject: 'overlap' })));
      }
      return Promise.resolve(respondJson({}));
    });

    const emitted: MailEnvelope[] = [];
    const provider = new OAuthGmailProvider(makeAccount(), makeAuth());
    const handle = await provider.watch({ intervalMs: 50 }, async (ev) => {
      if (ev.type === 'new') emitted.push(...ev.envelopes);
    });

    // Two intervals + slack
    await new Promise((r) => setTimeout(r, 140));
    await handle.stop();
    await provider.close();

    // Without dedup the same message would emit on every tick that hits the
    // overlap. With dedup it should land in `emitted` exactly once.
    expect(emitted.length).toBe(1);
    expect(emitted[0]?.subject).toBe('overlap');
  });
});
