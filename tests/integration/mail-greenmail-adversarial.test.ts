// === GreenMail adversarial-mailbox fixtures ===
//
// Real-protocol coverage for the mail surface against bytes that would
// otherwise bypass our defenses if mishandled. Each fixture maps to a
// finding from the 2026-Q2 hardening sprint:
//
// - R7 — quoted-display-name with embedded comma + RFC 5322 quoted-pair
//   (escaped quote). Asserts the address-list parser preserves both
//   recipients with the correct names.
// - S1 — non-UTF-8 body (ISO-8859-1) injected via raw RFC 822. Asserts
//   the Content-Type charset is honoured and the German umlauts roundtrip.
// - RFC 2047 MIME-encoded-word subject (UTF-8 base64). Asserts the
//   header decoder produces the cleartext subject.
// - Auto-Submitted: auto-generated. Asserts mail_reply hard-blocks via
//   the real protocol path (the unit test mocks the envelope shape, this
//   one drives bytes through SMTP→IMAP→provider→tool).
// - CRLF in subject — asserts nodemailer rejects at the send boundary
//   so header injection cannot leave our process via SMTP.
//
// Gated on a TCP probe so the suite skips when GreenMail isn't running.
//
// Start GreenMail before running:
//
//   docker run --rm -d --name lynox-greenmail \
//     -p 3025:3025 -p 3143:3143 -p 3465:3465 -p 3993:3993 -p 8080:8080 \
//     -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled' \
//     greenmail/standalone:2.1.8
//
// Override host/ports via env: GREENMAIL_HOST, GREENMAIL_IMAPS_PORT,
// GREENMAIL_SMTPS_PORT.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Socket } from 'node:net';
import nodemailer from 'nodemailer';
import { ImapSmtpProvider, type CredentialsResolver } from '../../src/integrations/mail/providers/imap-smtp.js';
import { buildCustomAccount } from '../../src/integrations/mail/providers/presets.js';
import type { MailAccountType, MailProvider } from '../../src/integrations/mail/provider.js';
import { InMemoryMailRegistry, createMailReplyTool } from '../../src/integrations/mail/tools/index.js';
import type { IAgent } from '../../src/types/index.js';

const HOST = process.env['GREENMAIL_HOST'] ?? '127.0.0.1';
const IMAPS_PORT = Number.parseInt(process.env['GREENMAIL_IMAPS_PORT'] ?? '3993', 10);
const SMTPS_PORT = Number.parseInt(process.env['GREENMAIL_SMTPS_PORT'] ?? '3465', 10);

const EVE = 'eve@localhost';
const FRANK = 'frank@localhost';

async function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

let greenmailUp = false;
greenmailUp = await probeTcp(HOST, IMAPS_PORT, 500);

function buildProvider(address: string, type: MailAccountType = 'personal'): MailProvider {
  const account = buildCustomAccount({
    id: `gm-adv-${address}`,
    displayName: address,
    address,
    type,
    imap: { host: HOST, port: IMAPS_PORT, secure: true },
    smtp: { host: HOST, port: SMTPS_PORT, secure: true },
  });
  const creds: CredentialsResolver = () => ({ user: address, pass: 'whatever' });
  return new ImapSmtpProvider(account, creds, { insecureTls: true });
}

/**
 * Inject a raw RFC 822 message into GreenMail bypassing nodemailer's
 * header sanitiser. Used only for fixtures that need to reproduce
 * adversarial bytes the production sender would refuse to emit.
 */
async function injectRaw(opts: {
  envelope: { from: string; to: string };
  raw: string;
}): Promise<void> {
  const transport = nodemailer.createTransport({
    host: HOST,
    port: SMTPS_PORT,
    secure: true,
    tls: { rejectUnauthorized: false, minVersion: 'TLSv1.2' },
    auth: { user: opts.envelope.from, pass: 'whatever' },
  });
  try {
    await transport.sendMail({
      envelope: opts.envelope,
      raw: opts.raw,
    });
  } finally {
    transport.close();
  }
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('waitFor timed out');
}

describe.skipIf(!greenmailUp)('GreenMail E2E — adversarial mailbox fixtures', () => {
  let eveProvider: MailProvider;
  let frankProvider: MailProvider;

  beforeAll(() => {
    eveProvider = buildProvider(EVE);
    frankProvider = buildProvider(FRANK);
  });

  afterAll(async () => {
    await eveProvider?.close();
    await frankProvider?.close();
  });

  // ── R7: quoted display name with comma ──────────────────────────────────

  it('R7 — parses a To header with commas inside quoted display names without splitting recipients', async () => {
    const tag = `r7-quote-${String(Date.now())}`;
    // The R7 hardening covers two patterns: commas inside quoted names
    // (tested here end-to-end against a real IMAP server) and RFC 5322
    // quoted-pair (`\"`) escapes (tested at the unit level in
    // oauth-gmail.test.ts because some IMAP servers — including
    // GreenMail — reject malformed-but-RFC-compliant escaped quotes
    // before delivery, blocking an end-to-end fixture for them).
    const messageId = `<${tag}@localhost>`;
    const raw = [
      `From: ${EVE}`,
      `To: "Doe, Jane" <${FRANK}>, "Smith, John" <second@localhost>`,
      `Subject: ${tag}`,
      `Message-ID: ${messageId}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="utf-8"`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      `r7 fixture`,
      ``,
    ].join('\r\n');

    await injectRaw({ envelope: { from: EVE, to: FRANK }, raw });

    const target = await waitFor(async () => {
      const list = await frankProvider.list({ limit: 50 });
      return list.find(e => e.subject === tag);
    });

    expect(target.to.length).toBe(2);
    const frank = target.to.find(a => a.address === FRANK);
    const second = target.to.find(a => a.address === 'second@localhost');
    expect(frank?.name).toBe('Doe, Jane');
    expect(second?.name).toBe('Smith, John');
  });

  // ── S1-shape: non-UTF-8 body via raw RFC 822 injection ──────────────────

  it('S1 — roundtrips an ISO-8859-1 body declared via Content-Type charset', async () => {
    const tag = `s1-charset-${String(Date.now())}`;
    // Build a raw RFC 822 with a Latin-1 body. The bytes "Gr\xfc\xdfe"
    // are Latin-1 for "Grüße"; UTF-8 best-effort would corrupt them.
    const messageId = `<${tag}@localhost>`;
    const rawHeaders = [
      `From: ${EVE}`,
      `To: ${FRANK}`,
      `Subject: ${tag}`,
      `Message-ID: ${messageId}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="iso-8859-1"`,
      `Content-Transfer-Encoding: 8bit`,
      ``,
      ``,
    ].join('\r\n');
    const bodyBytes = Buffer.from('Grüße — café', 'latin1');
    const raw = Buffer.concat([Buffer.from(rawHeaders, 'ascii'), bodyBytes]).toString('binary');

    await injectRaw({ envelope: { from: EVE, to: FRANK }, raw });

    const target = await waitFor(async () => {
      const list = await frankProvider.list({ limit: 50 });
      return list.find(e => e.subject === tag);
    });

    const full = await frankProvider.fetch({ uid: target.uid });
    expect(full.text).toContain('Grüße');
    expect(full.text).toContain('café');
  });

  // ── RFC 2047 — MIME-encoded subject (UTF-8 base64) ──────────────────────

  it('decodes a base64 MIME-encoded-word subject containing non-ASCII characters', async () => {
    const tag = `mw-${String(Date.now())}`;
    // The raw Subject header is the encoded form; the receiver must decode
    // it back to "Grüße <tag>" before we ever see the cleartext.
    const cleartext = `Grüße ${tag}`;
    const b64 = Buffer.from(cleartext, 'utf-8').toString('base64');
    const messageId = `<${tag}@localhost>`;
    const raw = [
      `From: ${EVE}`,
      `To: ${FRANK}`,
      `Subject: =?UTF-8?B?${b64}?=`,
      `Message-ID: ${messageId}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="utf-8"`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      `mime-word fixture`,
      ``,
    ].join('\r\n');

    await injectRaw({ envelope: { from: EVE, to: FRANK }, raw });

    const target = await waitFor(async () => {
      const list = await frankProvider.list({ limit: 50 });
      return list.find(e => e.subject === cleartext);
    });
    expect(target.subject).toBe(cleartext);
  });

  // ── Auto-Submitted: auto-generated → mail_reply hard-block ──────────────

  it('mail_reply rejects messages with Auto-Submitted: auto-generated against the real protocol', async () => {
    const tag = `auto-${String(Date.now())}`;
    const messageId = `<${tag}@localhost>`;
    const raw = [
      `From: bounce-daemon@localhost`,
      `To: ${FRANK}`,
      `Subject: ${tag}`,
      `Message-ID: ${messageId}`,
      `Auto-Submitted: auto-generated`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="utf-8"`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      `bounce body`,
      ``,
    ].join('\r\n');

    await injectRaw({ envelope: { from: EVE, to: FRANK }, raw });

    const target = await waitFor(async () => {
      const list = await frankProvider.list({ limit: 50 });
      return list.find(e => e.subject === tag);
    });

    // The list path doesn't fetch the auto-submitted header (intentional —
    // see reference_greenmail_test_container, including it conflicts with
    // snippet bodyPart extraction on GreenMail), so isAutoReply is only
    // populated on fetch(). mail_reply itself does the fetch, so the
    // hard-block is exercised whether or not list() saw the flag.
    const full = await frankProvider.fetch({ uid: target.uid });
    expect(full.envelope.isAutoReply).toBe(true);

    // Drive the message through mail_reply against the live IMAP path
    // and confirm the RFC 3834 hard-block fires.
    const registry = new InMemoryMailRegistry();
    registry.add(frankProvider);
    registry.setDefault(frankProvider.accountId);
    const replyTool = createMailReplyTool(registry);
    const yesAgent: IAgent = { promptUser: async () => 'Yes' } as unknown as IAgent;
    const out = await replyTool.handler({ uid: target.uid, body: 'should not send' }, yesAgent);
    expect(out).toContain('mail_reply blocked');
    expect(out).toContain('Auto-Submitted');
  });

  // ── Header injection: CRLF in subject is neutralised at the send boundary ──

  it('CRLF-injected subject does NOT smuggle a Bcc to a third-party mailbox', async () => {
    // The classic mail header injection — embed CRLF in a user-controlled
    // field so an attacker can splice extra headers (Bcc, Reply-To, body
    // boundary). nodemailer either rejects synchronously or sanitises the
    // value. The assertion is the same in both worlds: a message
    // referencing the would-be Bcc target must never appear in that
    // mailbox.
    const tag = `crlf-${String(Date.now())}`;
    const evilSubject = `Innocent ${tag}\r\nBcc: ${EVE}`;

    // Capture either the throw or a quietly-sanitised send. Either is
    // acceptable; what is NOT acceptable is the injected Bcc reaching Eve.
    try {
      await eveProvider.send({
        to: [{ address: FRANK }],
        subject: evilSubject,
        text: 'crlf injection probe',
      });
    } catch { /* either path is fine for this test */ }

    // Wait long enough for the SMTP delivery to settle, then confirm Eve
    // — the would-be Bcc target — has NOTHING tagged with this run. The
    // primary security property is: no real Bcc header was spliced, so
    // Eve never received a copy. Whether nodemailer rejected the send or
    // sanitised the subject in-place doesn't matter here.
    await new Promise(r => setTimeout(r, 500));
    const eveInbox = await eveProvider.list({ limit: 50 });
    expect(eveInbox.find(e => e.subject.includes(tag))).toBeUndefined();

    // If a message did land in Frank's inbox (sanitisation path), at
    // least confirm the literal CRLF didn't survive into the subject.
    const frankInbox = await frankProvider.list({ limit: 50 });
    const arrived = frankInbox.find(e => e.subject.includes(tag));
    if (arrived) {
      expect(arrived.subject).not.toContain('\r');
      expect(arrived.subject).not.toContain('\n');
    }
  });
});
