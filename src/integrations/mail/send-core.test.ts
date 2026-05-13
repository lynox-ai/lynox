import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMail, parseAddressList, buildSendPreview, MASS_SEND_THRESHOLD, type SendCoreInput } from './send-core.js';
import type { MailAddress, MailProvider, MailSendResult } from './provider.js';

vi.mock('./tools/rate-limit.js', () => {
  return {
    checkMailRateLimit: vi.fn(() => null),
    checkRecipientDedup: vi.fn(() => null),
    recordMailSend: vi.fn(),
  };
});

vi.mock('../../tools/builtin/http.js', () => ({
  detectSecretInContent: (body: string) => body.includes('Bearer eyJ') ? 'Bearer token' : null,
}));

const RECIPIENT: MailAddress = { address: 'alice@example.com' };

function fakeProvider(opts: { sendResult?: MailSendResult; sendThrows?: Error } = {}): MailProvider {
  return {
    accountId: 'acct-1',
    authType: 'imap',
    list: vi.fn(),
    fetch: vi.fn(),
    search: vi.fn(),
    send: vi.fn(async () => {
      if (opts.sendThrows) throw opts.sendThrows;
      return opts.sendResult ?? { messageId: '<sent@x>', accepted: ['alice@example.com'], rejected: [] };
    }),
    watch: vi.fn(),
    close: vi.fn(),
  } as unknown as MailProvider;
}

function fakeRegistry(provider: MailProvider) {
  return {
    get: () => provider,
    list: () => [provider.accountId],
    default: () => provider.accountId,
  };
}

beforeEach(async () => {
  // `resetAllMocks` clears mock history AND drains any queued
  // `mockReturnValueOnce` values; `clearAllMocks` alone wouldn't.
  vi.resetAllMocks();
  const { checkMailRateLimit, checkRecipientDedup } = await import('./tools/rate-limit.js');
  (checkMailRateLimit as ReturnType<typeof vi.fn>).mockImplementation(() => null);
  (checkRecipientDedup as ReturnType<typeof vi.fn>).mockImplementation(() => null);
});

describe('parseAddressList', () => {
  it('parses comma-separated addresses with and without display name', () => {
    const result = parseAddressList('Alice <alice@x.com>, bob@y.com, "Charlie Doe" <charlie@z.com>');
    expect(result).toEqual([
      { name: 'Alice', address: 'alice@x.com' },
      { address: 'bob@y.com' },
      { name: 'Charlie Doe', address: 'charlie@z.com' },
    ]);
  });

  it('drops entries that contain no `@`', () => {
    expect(parseAddressList('valid@x.com, not-an-address, other')).toEqual([
      { address: 'valid@x.com' },
    ]);
  });

  it('returns empty array for undefined / empty input', () => {
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList('')).toEqual([]);
  });

  it('drops segments containing CR/LF (header-injection guard)', () => {
    // PRD-INBOX-PHASE-3 §"Send-time confirmation" requires header-injection
    // defense at parse time. CR/LF in either the local-part or angle-form
    // would let the SMTP wire stream pick up a synthesised Bcc header.
    const injected = 'safe@x.com, x@evil.com\r\nBcc: leak@attacker.com';
    const result = parseAddressList(injected);
    // First address (safe) survives; the malformed second is dropped.
    expect(result).toHaveLength(1);
    expect(result[0]?.address).toBe('safe@x.com');
  });

  it('drops C0 control chars in the display name', () => {
    expect(parseAddressList('"Max\x00" <max@x.com>')).toHaveLength(0);
    expect(parseAddressList('"Max\x1f" <max@x.com>')).toHaveLength(0);
  });

  it('accepts space in display name (must not over-reject)', () => {
    const result = parseAddressList('Max Mustermann <max@x.com>');
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Max Mustermann');
  });
});

describe('sendMail — happy path', () => {
  it('calls provider.send and returns the result + records dedup', async () => {
    const { recordMailSend } = await import('./tools/rate-limit.js');
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const input: SendCoreInput = { to: [RECIPIENT], subject: 's', body: 'b' };
    const result = await sendMail(registry, input, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.messageId).toBe('<sent@x>');
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(recordMailSend).toHaveBeenCalledTimes(1);
  });

  it('threads inReplyTo + references into the send call', async () => {
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const input: SendCoreInput = {
      to: [RECIPIENT],
      subject: 'Re: x',
      body: 'reply body',
      inReplyTo: '<orig@x>',
      references: '<orig@x>',
    };
    await sendMail(registry, input, {});
    const sendCall = (provider.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(sendCall.inReplyTo).toBe('<orig@x>');
    expect(sendCall.references).toBe('<orig@x>');
  });
});

describe('sendMail — gates', () => {
  it('returns rate_limit when checkMailRateLimit blocks', async () => {
    const { checkMailRateLimit } = await import('./tools/rate-limit.js');
    (checkMailRateLimit as ReturnType<typeof vi.fn>).mockReturnValueOnce('rate-limited (60/min)');
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const result = await sendMail(registry, { to: [RECIPIENT], subject: 's', body: 'b' }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('rate_limit');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('skipRateLimit bypasses the cross-session cap', async () => {
    const { checkMailRateLimit } = await import('./tools/rate-limit.js');
    (checkMailRateLimit as ReturnType<typeof vi.fn>).mockReturnValueOnce('rate-limited');
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const result = await sendMail(registry, { to: [RECIPIENT], subject: 's', body: 'b' }, { skipRateLimit: true });
    expect(result.ok).toBe(true);
    expect(provider.send).toHaveBeenCalled();
  });

  it('returns secret_in_body when the body contains a Bearer token', async () => {
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const result = await sendMail(
      registry,
      { to: [RECIPIENT], subject: 's', body: 'Here is Bearer eyJhbGciOi...' },
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('secret_in_body');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('returns invalid_recipients when to is empty', async () => {
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const result = await sendMail(registry, { to: [], subject: 's', body: 'b' }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('invalid_recipients');
  });

  it('returns dedup_window when checkRecipientDedup blocks', async () => {
    const { checkRecipientDedup } = await import('./tools/rate-limit.js');
    (checkRecipientDedup as ReturnType<typeof vi.fn>).mockReturnValueOnce('dedup');
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const result = await sendMail(registry, { to: [RECIPIENT], subject: 's', body: 'b' }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('dedup_window');
  });

  it('returns cancelled when beforeSend returns false', async () => {
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const result = await sendMail(
      registry,
      { to: [RECIPIENT], subject: 's', body: 'b' },
      { beforeSend: async () => false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('cancelled');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('flags mass-send in the beforeSend ctx when recipient count exceeds MASS_SEND_THRESHOLD', async () => {
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const recipients: MailAddress[] = Array.from({ length: MASS_SEND_THRESHOLD + 1 }, (_, i) => ({ address: `r${String(i)}@x.com` }));
    let capturedMassSend: boolean | null = null;
    await sendMail(
      registry,
      { to: recipients, subject: 's', body: 'b' },
      {
        beforeSend: async (ctx) => {
          capturedMassSend = ctx.isMassSend;
          return true;
        },
      },
    );
    expect(capturedMassSend).toBe(true);
  });

  it('returns receive_only when the account type is a read-only mailbox', async () => {
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    // Minimal ctx stub — only getAccountConfig is exercised by the gate.
    const ctx = {
      getAccountConfig: () => ({
        id: 'acct-1',
        displayName: 'Abuse',
        address: 'abuse@x.com',
        preset: 'custom',
        imap: { host: 'i', port: 993, secure: true },
        smtp: { host: 's', port: 465, secure: true },
        authType: 'imap',
        type: 'abuse',
        isDefault: false,
      }),
    } as unknown as import('./context.js').MailContext;
    const result = await sendMail(registry, { to: [RECIPIENT], subject: 's', body: 'b' }, {}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe('receive_only');
      expect(result.message).toContain('abuse');
    }
    expect(provider.send).not.toHaveBeenCalled();
  });
});

describe('sendMail — provider errors', () => {
  it('returns provider_error when provider.send throws', async () => {
    const provider = fakeProvider({ sendThrows: new Error('SMTP 550') });
    const registry = fakeRegistry(provider);
    const result = await sendMail(registry, { to: [RECIPIENT], subject: 's', body: 'b' }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe('provider_error');
      expect(result.message).toContain('SMTP 550');
    }
  });

  it('does NOT record dedup when send fails — retry must work', async () => {
    const { recordMailSend } = await import('./tools/rate-limit.js');
    const provider = fakeProvider({ sendThrows: new Error('boom') });
    const registry = fakeRegistry(provider);
    await sendMail(registry, { to: [RECIPIENT], subject: 's', body: 'b' }, {});
    expect(recordMailSend).not.toHaveBeenCalled();
  });
});

describe('buildSendPreview', () => {
  it('renders the single-send preview with from/to/subject', () => {
    const preview = buildSendPreview({
      provider: { accountId: 'acct-1' } as MailProvider,
      accountConfig: null,
      to: [RECIPIENT],
      cc: [],
      bcc: [],
      subject: 'Hello',
      body: 'Body text',
      isMassSend: false,
      uniqueRecipientCount: 1,
    });
    expect(preview).toContain('Send email?');
    expect(preview).toContain('alice@example.com');
    expect(preview).toContain('Hello');
    expect(preview).toContain('acct-1');
  });

  it('renders the mass-send warning above the threshold', () => {
    const preview = buildSendPreview({
      provider: { accountId: 'acct-1' } as MailProvider,
      accountConfig: null,
      to: Array.from({ length: 6 }, (_, i) => ({ address: `r${String(i)}@x.com` })),
      cc: [],
      bcc: [],
      subject: 'Mass',
      body: 'Body',
      isMassSend: true,
      uniqueRecipientCount: 6,
    });
    expect(preview).toContain('MASS SEND');
    expect(preview).toContain('6 recipients');
  });
});

describe('sendMail — recordSentMail integration', () => {
  it('writes one mail_sent_log row per successful send when ctx is wired', async () => {
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const recordSentMail = vi.fn();
    const ctx = {
      stateDb: { recordSentMail },
      getAccountConfig: () => null,
    } as unknown as import('./context.js').MailContext;
    const input: SendCoreInput = {
      to: [RECIPIENT],
      subject: 'logged',
      body: 'body',
      inReplyTo: '<orig@x>',
    };
    const result = await sendMail(registry, input, {}, ctx);
    expect(result.ok).toBe(true);
    expect(recordSentMail).toHaveBeenCalledTimes(1);
    const args = recordSentMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.accountId).toBe('acct-1');
    expect(args.messageId).toBe('<sent@x>');
    expect(args.subject).toBe('logged');
    expect(args.bodyChars).toBe(4);
    expect(args.inReplyTo).toBe('<orig@x>');
  });

  it('does not call recordSentMail when ctx is undefined (CLI/headless callers)', async () => {
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const result = await sendMail(registry, { to: [RECIPIENT], subject: 's', body: 'b' }, {});
    expect(result.ok).toBe(true);
  });

  it('swallows recordSentMail throws — observational write must not fail the user-visible send', async () => {
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const recordSentMail = vi.fn(() => { throw new Error('disk full'); });
    const ctx = {
      stateDb: { recordSentMail },
      getAccountConfig: () => null,
    } as unknown as import('./context.js').MailContext;
    const result = await sendMail(registry, { to: [RECIPIENT], subject: 's', body: 'b' }, {}, ctx);
    expect(result.ok).toBe(true);
    expect(recordSentMail).toHaveBeenCalledTimes(1);
  });
});
