import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationMessage } from '../../core/notification-router.js';
import type { MailRegistry } from './tools/registry.js';

const sendMail = vi.fn();
vi.mock('./send-core.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...args) }));

const { EscalationMailChannel, formatEscalationBody } = await import('./escalation-mail-channel.js');

const registry = {
  get: () => null,
  list: () => [],
  default: () => 'acct-1',
} satisfies MailRegistry;

function msg(over: Partial<NotificationMessage> = {}): NotificationMessage {
  return { title: 'Freigabe nötig', body: 'Rechnung 4711', priority: 'high', ...over };
}

describe('EscalationMailChannel', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({ ok: true, result: {}, followupId: null });
  });

  it('sends to the address in `recipient`', async () => {
    const ch = new EscalationMailChannel({ registry });
    expect(await ch.send(msg({ recipient: 'chef@betrieb.example' }))).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    // The address must come from `recipient`, not from anywhere else: assert the
    // exact `to` list rather than "was called", so a channel that mailed a
    // hardcoded or registry-derived address still fails here.
    expect(sendMail.mock.calls[0]?.[1]).toMatchObject({
      to: [{ address: 'chef@betrieb.example' }],
      subject: 'Freigabe nötig',
    });
  });

  it('refuses a message with no recipient instead of sending it somewhere', async () => {
    const ch = new EscalationMailChannel({ registry });
    // `notify()` fans out to every channel, so this is the ordinary case: an
    // unrelated notification reaching a channel that delivers to a person.
    expect(await ch.send(msg())).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('refuses a blank recipient (%j)', async (recipient) => {
    const ch = new EscalationMailChannel({ registry });
    expect(await ch.send(msg({ recipient }))).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('reports a failed send as false rather than claiming delivery', async () => {
    sendMail.mockResolvedValue({ ok: false, status: 'rate_limit', message: 'too many' });
    const ch = new EscalationMailChannel({ registry });
    expect(await ch.send(msg({ recipient: 'chef@betrieb.example' }))).toBe(false);
  });

  it('passes the configured account through, and omits it when unset', async () => {
    await new EscalationMailChannel({ registry, account: 'acct-2' })
      .send(msg({ recipient: 'chef@betrieb.example' }));
    expect(sendMail.mock.calls[0]?.[1]).toMatchObject({ account: 'acct-2' });

    sendMail.mockReset();
    sendMail.mockResolvedValue({ ok: true, result: {}, followupId: null });
    await new EscalationMailChannel({ registry })
      .send(msg({ recipient: 'chef@betrieb.example' }));
    expect(sendMail.mock.calls[0]?.[1]).not.toHaveProperty('account');
  });
});

describe('formatEscalationBody', () => {
  it('carries the pending question and its options, not just the body', () => {
    // `inquiry` has had one writer and no reader; this channel is its first.
    // The assertion is on the rendered text because that is the product — a
    // recipient without an account sees only this string.
    const out = formatEscalationBody(msg({
      recipient: 'chef@betrieb.example',
      inquiry: { question: 'Rechnung über 4200 freigeben?', options: ['Ja', 'Nein', 'Rückfrage'] },
    }));
    expect(out).toContain('Rechnung 4711');
    expect(out).toContain('Rechnung über 4200 freigeben?');
    expect(out).toContain('- Ja');
    expect(out).toContain('- Nein');
    expect(out).toContain('- Rückfrage');
  });

  it('renders a question without options', () => {
    const out = formatEscalationBody(msg({ inquiry: { question: 'Weitermachen?' } }));
    expect(out).toContain('Weitermachen?');
    expect(out).not.toContain('- ');
  });

  it('is the plain body when there is no inquiry', () => {
    expect(formatEscalationBody(msg())).toBe('Rechnung 4711');
  });

  it('does NOT invent an answer path', () => {
    // Whether the recipient may answer by mail is an open decision with a
    // security side. A channel that wrote "reply to this mail" would settle it
    // by shipping it, so the absence is the assertion.
    const out = formatEscalationBody(msg({
      inquiry: { question: 'Freigeben?', options: ['Ja'] },
    })).toLowerCase();
    for (const phrase of ['antworten sie', 'reply to this', 'klicken sie', 'jetzt freigeben']) {
      expect(out).not.toContain(phrase);
    }
  });
});
