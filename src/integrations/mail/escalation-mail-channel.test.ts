import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationMessage } from '../../core/notification-router.js';
import { NotificationRouter } from '../../core/notification-router.js';
import type { MailRegistry } from './tools/registry.js';

const sendMail = vi.fn();
// Only `sendMail` is stubbed. `parseAddressList` stays REAL, because the
// address handling is part of what these tests are here to pin down.
vi.mock('./send-core.js', async (orig) => ({
  ...(await orig<typeof import('./send-core.js')>()),
  sendMail: (...args: unknown[]) => sendMail(...args),
}));

const { EscalationMailChannel, formatEscalationBody } = await import('./escalation-mail-channel.js');

const registry = { get: () => null, list: () => [], default: () => 'acct-1' } satisfies MailRegistry;
const CHEF = 'chef@betrieb.example';

function channel(over: Partial<{ allowedRecipients: readonly string[]; account: string }> = {}) {
  return new EscalationMailChannel({ registry, allowedRecipients: [CHEF], ...over });
}

function msg(over: Partial<NotificationMessage> = {}): NotificationMessage {
  return { title: 'Freigabe nötig', body: 'Rechnung 4711', priority: 'high', ...over };
}

/** The exact argument object `sendMail` was called with. */
function wireInput(): Record<string, unknown> {
  expect(sendMail).toHaveBeenCalledTimes(1);
  return sendMail.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe('EscalationMailChannel — what reaches the wire', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({ ok: true, result: {}, followupId: null });
  });

  it('hands sendMail exactly the recipient, subject and rendered case — and nothing else', async () => {
    expect(await channel().send(msg({
      recipient: CHEF,
      inquiry: { question: 'Rechnung über 4200 freigeben?', options: ['Ja', 'Nein'] },
    }))).toBe(true);
    // toEqual, not toMatchObject: a subset match cannot show that nothing was
    // ADDED. A stray `bcc` survives a subset assert, and this test exists to
    // catch exactly that.
    expect(wireInput()).toEqual({
      to: [{ address: CHEF }],
      subject: 'Freigabe nötig',
      body: 'Rechnung 4711\n\nRechnung über 4200 freigeben?\n\n- Ja\n- Nein',
    });
  });

  it('does NOT invent an answer path — asserted on the body that actually ships', async () => {
    // Asserted at the CHANNEL, not at the formatter. Appending a reply
    // instruction in `send()` after the formatter would pass a formatter-level
    // test, and this is the promise a security decision rests on.
    await channel().send(msg({ recipient: CHEF, inquiry: { question: 'Freigeben?', options: ['Ja'] } }));
    expect(wireInput()['body']).toBe('Rechnung 4711\n\nFreigeben?\n\n- Ja');
  });

  it('passes the configured account through, and omits it when unset', async () => {
    await channel({ account: 'acct-2' }).send(msg({ recipient: CHEF }));
    expect(wireInput()).toEqual({
      account: 'acct-2', to: [{ address: CHEF }], subject: 'Freigabe nötig', body: 'Rechnung 4711',
    });
    sendMail.mockReset();
    sendMail.mockResolvedValue({ ok: true, result: {}, followupId: null });
    await channel().send(msg({ recipient: CHEF }));
    expect(wireInput()).not.toHaveProperty('account');
  });
});

describe('EscalationMailChannel — the allowlist is the boundary', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({ ok: true, result: {}, followupId: null });
  });

  it('refuses an address outside the allowlist', async () => {
    expect(await channel().send(msg({ recipient: 'fremd@anderswo.example' }))).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('refuses everything when the allowlist is empty', async () => {
    const ch = new EscalationMailChannel({ registry });
    expect(await ch.send(msg({ recipient: CHEF }))).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('matches the allowlist case-insensitively and ignores surrounding space', async () => {
    const ch = new EscalationMailChannel({ registry, allowedRecipients: ['  CHEF@Betrieb.example '] });
    expect(await ch.send(msg({ recipient: CHEF }))).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['zwei Adressen', `${CHEF}, evil@angreifer.example`],
    ['Adresse ohne @', 'chef'],
  ])('refuses %s rather than letting nodemailer reinterpret it', async (_label, recipient) => {
    expect(await channel().send(msg({ recipient }))).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('accepts a display-name form and mails the bare address', async () => {
    expect(await channel().send(msg({ recipient: `Chef <${CHEF}>` }))).toBe(true);
    expect(wireInput()['to']).toEqual([{ address: CHEF }]);
  });
});

describe('EscalationMailChannel — outcomes', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({ ok: true, result: {}, followupId: null });
  });

  it('treats an unaddressed message as handled, so the router logs nothing', async () => {
    // The ordinary case under `notify()` fan-out. Reporting it as a failure
    // would emit a router stderr line on every unrelated notification.
    expect(await channel().send(msg())).toBe(true);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each([[''], ['   ']])('treats a blank recipient (%j) as unaddressed', async (recipient) => {
    expect(await channel().send(msg({ recipient }))).toBe(true);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('reports a failed send as false rather than claiming delivery', async () => {
    sendMail.mockResolvedValue({ ok: false, status: 'rate_limit', message: 'too many' });
    expect(await channel().send(msg({ recipient: CHEF }))).toBe(false);
  });

  it('survives a throwing sendMail — the state of an instance with no mail account', async () => {
    sendMail.mockRejectedValue(new Error('No mail account configured.'));
    await expect(channel().send(msg({ recipient: CHEF }))).resolves.toBe(false);
  });
});

describe('EscalationMailChannel — through the real router', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({ ok: true, result: {}, followupId: null });
  });

  it('delivers an addressed message and ignores an unaddressed one', async () => {
    const router = new NotificationRouter();
    router.register(channel());

    await router.notify(msg());
    expect(sendMail).not.toHaveBeenCalled();

    await router.notify(msg({ recipient: CHEF }));
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('formatEscalationBody', () => {
  it('renders question and options below the body', () => {
    expect(formatEscalationBody(msg({ inquiry: { question: 'Freigeben?', options: ['Ja', 'Nein'] } })))
      .toBe('Rechnung 4711\n\nFreigeben?\n\n- Ja\n- Nein');
  });

  it('renders a question without options', () => {
    expect(formatEscalationBody(msg({ inquiry: { question: 'Weitermachen?' } })))
      .toBe('Rechnung 4711\n\nWeitermachen?');
  });

  it('renders a question with an empty option list', () => {
    expect(formatEscalationBody(msg({ inquiry: { question: 'Weitermachen?', options: [] } })))
      .toBe('Rechnung 4711\n\nWeitermachen?');
  });

  it('is the plain body when there is no inquiry', () => {
    expect(formatEscalationBody(msg())).toBe('Rechnung 4711');
  });
});
