import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMail, parseAddressList, buildSendPreview, previewAddressList, MASS_SEND_THRESHOLD, type SendCoreInput } from './send-core.js';
import { singleLine } from '../../core/prompt-value.js';
import type { MailAddress, MailProvider, MailSendResult } from './provider.js';
import { flattenPrompt } from '../../core/prompt-value.js';

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

  it('blocks a secret smuggled into the SUBJECT (not just the body)', async () => {
    const provider = fakeProvider();
    const registry = fakeRegistry(provider);
    const result = await sendMail(
      registry,
      // Body is clean — the secret rides the Subject header (the mock detects
      // the 'Bearer eyJ' shape regardless of which field it's called on).
      { to: [RECIPIENT], subject: 'Re: token Bearer eyJhbGciOiXYZ', body: 'looks fine' },
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
    const preview = flattenPrompt(buildSendPreview({
      provider: { accountId: 'acct-1' } as MailProvider,
      accountConfig: null,
      to: [RECIPIENT],
      cc: [],
      bcc: [],
      subject: 'Hello',
      body: 'Body text',
      isMassSend: false,
      uniqueRecipientCount: 1,
    }));
    expect(preview).toContain('Send email?');
    expect(preview).toContain('alice@example.com');
    expect(preview).toContain('Hello');
    expect(preview).toContain('acct-1');
  });

  it('renders the mass-send warning above the threshold', () => {
    const preview = flattenPrompt(buildSendPreview({
      provider: { accountId: 'acct-1' } as MailProvider,
      accountConfig: null,
      to: Array.from({ length: 6 }, (_, i) => ({ address: `r${String(i)}@x.com` })),
      cc: [],
      bcc: [],
      subject: 'Mass',
      body: 'Body',
      isMassSend: true,
      uniqueRecipientCount: 6,
    }));
    expect(preview).toContain('MASS SEND');
    expect(preview).toContain('6 recipients');
  });

  function previewFor(body: string, isMassSend = false, subject = 'Subject'): string {
    return flattenPrompt(buildSendPreview({
      provider: { accountId: 'acct-1' } as MailProvider,
      accountConfig: null,
      to: [RECIPIENT],
      cc: [],
      bcc: [],
      subject,
      body,
      isMassSend,
      uniqueRecipientCount: 1,
    }));
  }

  const flatten = (s: string): string => s.replace(/\s+/g, ' ').trim();

  it('shows a short body in full and says nothing about truncation', () => {
    const preview = previewFor('Short and complete.');
    expect(preview).toContain('> Short and complete.');
    expect(preview).not.toContain('only the first');
  });

  // Pins the RENDERED quote against the claimed count. If truncate's slice
  // arithmetic changed, the quote and the sentence would disagree and this
  // fails — asserting only the sentence would not catch that.
  it('shows exactly the first 199 chars plus an ellipsis, and says so', () => {
    const preview = previewFor('z'.repeat(4000));
    expect(preview).toContain(`> ${'z'.repeat(199)}…`);
    expect(preview).toContain('Body is 4000 chars');
    expect(preview).toContain('only the first 199 are shown');
  });

  // The two lengths must not be mixed: 300 chars of text around 500 newlines is
  // 1100 raw but 601 flattened. Reporting the raw number overstates the hidden
  // volume by 499 chars for what is really a normal multi-line mail — and every
  // fixture whose body has no whitespace (`'x'.repeat(n)`) is blind to it.
  it('states the flattened body size, not the raw length', () => {
    const body = `${'A'.repeat(300)}${'\n'.repeat(500)}${'B'.repeat(300)}`;
    expect(body.length).toBe(1100);
    expect(flatten(body).length).toBe(601);
    const preview = previewFor(body);
    expect(preview).toContain('Body is 601 chars');
    expect(preview).not.toContain('1100');
  });

  it('does not warn at exactly the cap, warns one char over', () => {
    expect(previewFor('c'.repeat(200))).not.toContain('only the first');
    expect(previewFor('c'.repeat(201))).toContain('Body is 201 chars');
  });

  // The gate's whole purpose: an approver must not read a plausible opening
  // line and miss that a payload rides behind it. Before this, the preview cut
  // at 200 chars with a bare "…" — indistinguishable from a slightly-longer
  // mail. The hidden text stays hidden (a terminal prompt is not the place to
  // dump 40 KB), but its EXISTENCE and size must be stated.
  it('flags the hidden remainder when a payload trails a harmless opening', () => {
    // The opening alone fills the preview window — which is what a real
    // injected send looks like, not a two-line stub.
    const opening =
      'Hi Alice,\n\nthanks for the call earlier. As promised, here is the ' +
      'consolidated summary of the Q3 figures together with the notes from ' +
      'the workshop, so you have everything in one place before the review ' +
      'meeting on Thursday. Let me know if anything is unclear.\n\n';
    const body = `${opening}${'LEAKED-RECORD;'.repeat(3000)}`;
    const preview = previewFor(body);
    expect(preview).toContain('thanks for the call earlier');
    expect(preview).not.toContain('LEAKED-RECORD');
    expect(preview).toContain(`Body is ${String(flatten(body).length)} chars`);
  });

  it('flags an oversized body on the mass-send path too', () => {
    const preview = previewFor('y'.repeat(5000), true);
    expect(preview).toContain('MASS SEND');
    expect(preview).toContain('Body is 5000 chars');
  });

  // Whitespace-only bulk is not a hidden payload: flattening reveals the whole
  // message, so no warning is correct even though body.length exceeds the cap.
  it('does not warn when only collapsed whitespace exceeds the cap', () => {
    const preview = previewFor(`Two words.${'\n'.repeat(400)}`);
    expect(preview).toContain('> Two words.');
    expect(preview).not.toContain('only the first');
  });

  it('marks a whitespace-only body explicitly instead of rendering an empty quote', () => {
    expect(previewFor('\n\n   \t ')).toContain('_(empty body)_');
  });

  // The prompt is markdown-rendered in the web UI, and on mail_reply the
  // subject comes from the REMOTE sender. A LINE BREAK is what lets such a
  // value open a block-level construct (`\n\n<!--` puts the rest of the prompt
  // — including the warning below — inside an HTML comment, which renders as
  // nothing). So the property to pin is structural: no attacker-supplied header
  // introduces a break. Asserting "no line starts with <!--" instead would pass
  // a singleLine that only handled \n — CR alone is an equally valid CommonMark
  // line ending — and would miss every other block opener.
  it('renders an attacker-supplied multi-line subject on exactly one line', () => {
    const preview = previewFor('q'.repeat(400), false, 'Report\r\n\r\n<!--');
    const subjectLines = preview.split('\n').filter((l) => l.includes('**Subject:**'));
    expect(subjectLines).toHaveLength(1);
    expect(subjectLines[0]).toContain('<!--');
    expect(preview).toContain('Body is 400 chars');
  });

  it('flattens every line-breaking character in a header value', () => {
    expect(singleLine('a\r\nb\u2028c\u2029d\te')).toBe('a b c d e');
    expect(singleLine('Report\r\r\r<!--')).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  // mail_reply takes its recipients straight from the inbound envelope, never
  // through parseAddressList — so the preview cannot rely on that guard.
  it('flattens addresses in the recipient list', () => {
    expect(previewAddressList([{ address: 'a@x.com\r\n\r\n<!--' }])).toBe('a@x.com <!--');
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
