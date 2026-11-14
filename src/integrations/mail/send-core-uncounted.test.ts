import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendMail } from './send-core.js';
import { configureMailRateLimits, MAIL_RATE_UNCOUNTED, resetMailRateLimits } from './tools/rate-limit.js';
import type { MailProvider } from './provider.js';

// The real send limits (send-core.test.ts stands them in): configured, with nothing to count
// against them, as after a boot without the history database.

function fakeProvider(): MailProvider {
  return {
    accountId: 'acct-1', authType: 'imap',
    list: vi.fn(), fetch: vi.fn(), search: vi.fn(),
    send: vi.fn(async () => ({ messageId: '<sent@x>', accepted: ['alice@example.com'], rejected: [] })),
    watch: vi.fn(), close: vi.fn(),
  } as unknown as MailProvider;
}

afterEach(() => { resetMailRateLimits(); });

describe('sendMail without a send-limit counter', () => {
  it('is refused with the reason before its consent step: not sent, and not filed for approval', async () => {
    configureMailRateLimits({ provider: null });
    const provider = fakeProvider();
    const registry = { get: () => provider, list: () => [provider.accountId], default: () => provider.accountId };
    const beforeSend = vi.fn(async () => ({ queued: 'filed' }));

    const result = await sendMail(registry, { to: [{ address: 'alice@example.com' }], subject: 's', body: 'b' }, { beforeSend });

    expect(result).toMatchObject({ ok: false, status: 'rate_limit', message: MAIL_RATE_UNCOUNTED });
    // `beforeSend` is where a send is confirmed or filed into the approval queue.
    expect(beforeSend).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });
});
