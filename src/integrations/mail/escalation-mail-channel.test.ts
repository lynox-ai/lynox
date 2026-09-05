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
    // Pins EXACT membership against the neighbourhood forms a loosened check
    // would admit: extra label on the right, extra label on the left, longer
    // local part. Which mutant each line kills is deliberately NOT written
    // here — that mapping was wrong twice, because it shifts with every fix to
    // the code it describes. The mutation run is where it belongs; a comment
    // is the one place a measurement never gets re-checked.
    ['eine Look-alike-Domain', 'chef@betrieb.example.angreifer.example'],
    ['eine Sub-Adresse des Eintrags', 'x.chef@betrieb.example'],
    ['einen laengeren local part', 'chef2@betrieb.example'],
  ])('refuses %s', async (_label, recipient) => {
    expect(await channel().send(msg({ recipient }))).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('accepts a display-name form and mails the bare address', async () => {
    expect(await channel().send(msg({ recipient: `Chef <${CHEF}>` }))).toBe(true);
    expect(wireInput()['to']).toEqual([{ address: CHEF }]);
  });

  it('accepts a display-name form in the ALLOWLIST too', async () => {
    const ch = new EscalationMailChannel({ registry, allowedRecipients: [`Chef <${CHEF}>`] });
    expect(await ch.send(msg({ recipient: CHEF }))).toBe(true);
    expect(wireInput()['to']).toEqual([{ address: CHEF }]);
  });

  it('refuses an allowlist entry holding two addresses instead of expanding it', async () => {
    // The same string is refused on the way in, so accepting it in the config
    // would make one direction of the same value stricter than the other.
    const ch = new EscalationMailChannel({ registry, allowedRecipients: [`${CHEF}, zweit@betrieb.example`] });
    expect(await ch.send(msg({ recipient: CHEF }))).toBe(false);
    expect(await ch.send(msg({ recipient: 'zweit@betrieb.example' }))).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('reports entries it had to drop, even when others are usable', async () => {
    // A partly unusable list is the likelier one: a single good entry makes the
    // channel look like it works, while the dropped lines silently permit
    // nobody.
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      new EscalationMailChannel({ registry, allowedRecipients: [CHEF, 'x@b.example, y@c.example', 'kaputt'] });
    } finally {
      spy.mockRestore();
    }
    expect(lines.filter((l) => l.includes('unusable and ignored'))).toHaveLength(1);
    expect(lines.join('')).toContain('2 of 3');
  });

  it('says so once when a configured list yields no usable entry', async () => {
    // A configured-but-unusable list otherwise refuses every message with
    // "not in the allowlist", which reads like a rejected recipient.
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      new EscalationMailChannel({ registry, allowedRecipients: ['chef', 'auch-keine-adresse'] });
    } finally {
      spy.mockRestore();
    }
    expect(lines.filter((l) => l.includes('unusable and ignored'))).toHaveLength(1);
    expect(lines.join('')).toContain('2 of 2');
  });

  it('stays quiet when the list is simply empty', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      new EscalationMailChannel({ registry, allowedRecipients: [] });
      new EscalationMailChannel({ registry });
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual([]);
  });

  it('mails the ALLOWLIST ENTRY, never the string the message supplied', async () => {
    // Checking one value and sending another is the gap. `banKer` case-folds
    // onto the entry, so it passes the check — and must not be what ships,
    // because for a domain a case-fold can be a different IDNA label.
    const ch = new EscalationMailChannel({ registry, allowedRecipients: ['chef@banker.example'] });
    expect(await ch.send(msg({ recipient: 'chef@banKer.example' }))).toBe(true);
    expect(wireInput()['to']).toEqual([{ address: 'chef@banker.example' }]);
  });
});

describe('EscalationMailChannel — outcomes', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({ ok: true, result: {}, followupId: null });
  });

  it('reports an unaddressed message as handled', async () => {
    // The ordinary case under `notify()` fan-out. That this actually keeps the
    // router quiet is a separate claim and is measured in the router block —
    // this one only pins the boolean.
    expect(await channel().send(msg())).toBe(true);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each([[''], ['   ']])('reports a blank recipient (%j) instead of calling it handled', async (recipient) => {
    // A blank string is a FAILED attempt to address, not an absent one — a
    // caller whose recipient plumbing ran dry must not be told "handled".
    expect(await channel().send(msg({ recipient }))).toBe(false);
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

  it('stays silent on an unrelated notification and delivers an addressed one', async () => {
    // Without the stderr assertion this block is strictly weaker than the
    // direct tests — it stayed green under two mutations that they kill. The
    // router's warning line is the observable the `true` return exists for, so
    // it is the thing worth asserting here.
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    });
    try {
      const router = new NotificationRouter();
      router.register(channel());

      // Filtered on the router's own prefix: asserting the whole stderr stream
      // would go red on any unrelated node warning inside the spy's window.
      const routerLines = (): string[] => warnings.filter((w) => w.includes('[notification-router]'));
      const channelLines = (): string[] => warnings.filter((w) => w.includes('[escalation-mail]'));

      await router.notify(msg());
      expect(sendMail).not.toHaveBeenCalled();
      expect(routerLines()).toEqual([]);
      expect(channelLines()).toEqual([]);

      await router.notify(msg({ recipient: CHEF }));
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(routerLines()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('makes the router complain when an addressed message is refused', async () => {
    // The counterpart: without it, "stays silent" would also pass for a channel
    // that is silent about everything, including a real refusal.
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    });
    try {
      const router = new NotificationRouter();
      router.register(channel());
      await router.notify(msg({ recipient: 'fremd@anderswo.example' }));
      expect(sendMail).not.toHaveBeenCalled();
      expect(warnings.some((w) => w.includes('[notification-router]'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
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
