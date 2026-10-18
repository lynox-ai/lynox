/**
 * The header-injection and encoding cases of the shared MIME builder, run once per transport.
 *
 * `buildRfc2822` (`src/integrations/mail/mime-compose.ts`) is called by the Gmail provider and
 * by the Graph provider. These cases used to live in `oauth-gmail.test.ts` and therefore only
 * ever exercised the Gmail path; a Graph provider that bypassed the builder, encoded the result
 * differently, or post-processed it would have passed every one of them. Each provider's test
 * file now calls {@link describeMimeSend} with a driver that sends through THAT provider and
 * hands back the MIME text as it left on the wire.
 *
 * The driver contract: send `input` from `user@example.org` with the given From display name,
 * return the decoded MIME message (CRLF line ends). Everything else — the fetch stub, the
 * response shape, how the payload is encoded — is the provider's business.
 */
import { describe, expect, it } from 'vitest';
import type { MailSendInput } from '../../src/integrations/mail/provider.js';

export type MimeSendDriver = (input: MailSendInput, displayName: string) => Promise<string>;

export function describeMimeSend(transport: string, send: MimeSendDriver): void {
  describe(`${transport} — shared MIME builder on the wire`, () => {
    async function fromLineFor(displayName: string): Promise<string> {
      const decoded = await send({ to: [{ address: 'bob@example.com' }], subject: 'Hi', text: 'b' }, displayName);
      return decoded.split(/\r?\n/).find(l => l.startsWith('From:')) ?? '';
    }

    it('SEC: a non-ASCII display name cannot append a recipient of its own', async () => {
      // RFC 2047 §5(3): inside a PHRASE an encoded-word may carry only
      // alphanumerics and `!*+-/`. The encoder applied the looser `text` rule, so
      // `<`, `>`, `@` and `,` survived literally — and a phrase is exactly where
      // an address list is parsed. A display name is remote-authored (it can come
      // from a contact record or an inbound header), so this is reachable.
      const fromLine = await fromLineFor('Ärger <attacker@evil.example>,');
      // The hostile address must not appear in ANY parseable form.
      expect(fromLine).not.toContain('attacker@evil.example');
      // …and the header must still name exactly one address: the real one.
      expect(fromLine.match(/</g) ?? []).toHaveLength(1);
      expect(fromLine).toContain('<user@example.org>');
    });

    it('SEC: a display name ending in a backslash cannot escape its own quotes', async () => {
      // The quoted-string branch escaped `"` but not `\`, so `Bob\` produced
      // `"Bob\" <user@example.org>` — the `\"` is a quoted-pair, so the string
      // never closed there and swallowed the real address. Backslash must be
      // escaped FIRST, or escaping the quote re-introduces the problem.
      const fromLine = await fromLineFor('Bob\\');
      expect(fromLine).toBe('From: "Bob\\\\" <user@example.org>');
      expect(fromLine).toContain('<user@example.org>');
    });

    it('a plain ASCII display name is still rendered quoted and unencoded', async () => {
      // Counter-direction: the tightening must not start encoding ordinary names.
      const fromLine = await fromLineFor('Rafael Burlet');
      expect(fromLine).toBe('From: "Rafael Burlet" <user@example.org>');
    });

    it('falls back to bare address when displayName is empty', async () => {
      const decoded = await send({ to: [{ address: 'bob@example.com' }], subject: 'Hi', text: 'body' }, '');
      expect(decoded).toContain('From: user@example.org');
      expect(decoded).not.toContain('From: ""');
    });

    it('strips CRLF from headers — defeats SMTP injection via subject', async () => {
      const decoded = await send({
        to: [{ address: 'bob@example.com' }],
        subject: 'Hello\r\nBcc: attacker@evil.com',
        text: 'body',
      }, 'Rafael');
      // The CRLF must be collapsed so the smuggled Bcc never lands on its own line
      expect(decoded).not.toMatch(/^Bcc: attacker@evil\.com/m);
      expect(decoded).toContain('Subject: Hello Bcc: attacker@evil.com');
    });

    it('strips CRLF from display name and escapes embedded quotes', async () => {
      const decoded = await send({
        to: [{ name: 'Bob "the Hacker"\r\nX-Injected: yes', address: 'bob@example.com' }],
        subject: 'Hi',
        text: 'body',
      }, 'Rafael');
      expect(decoded).not.toMatch(/^X-Injected:/m);
      expect(decoded).toContain('"Bob \\"the Hacker\\" X-Injected: yes" <bob@example.com>');
    });

    it('RFC 2047-encodes a non-ASCII subject so the recipient does not see mojibake', async () => {
      const decoded = await send({
        to: [{ address: 'bob@example.com' }],
        subject: 'TEST: Offert-Anfrage BVG-Anschluss — lynox GmbH',
        text: 'body',
      }, 'Rafael');
      const subjectLine = decoded.split('\r\n').find((l) => l.startsWith('Subject:'));
      // Before the fix the em-dash rode the wire as raw UTF-8 and Gmail rendered
      // it Latin1 → "Ã¢Â€Â™". It must now be an RFC 2047 encoded-word.
      expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?Q\?/);
      expect(subjectLine).toContain('=E2=80=94'); // em-dash UTF-8 bytes, encoded
      expect(subjectLine).not.toContain('—'); // raw non-ASCII must be gone
    });

    // A strict reading, written apart from the encoder: every physical header line that holds an
    // encoded-word stays within 76 characters, every encoded-word within 75 and decodable on its own
    // (no character split across two words), and unfolding + decoding gives back the subject.
    it('folds a long non-ASCII subject into lines a strict client reads back intact', async () => {
      const subject = 'Grüße aus München — Protokoll der Besprechung über die Übergabe der Räume 🚀';
      const raw = await send({ to: [{ address: 'bob@example.com' }], subject, text: 'body' }, 'Rafael');
      const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
      const physical = head.split('\r\n');
      const start = physical.findIndex((l) => l.startsWith('Subject:'));
      let end = start + 1;
      while (end < physical.length && /^[ \t]/.test(physical[end]!)) end++;
      expect(end - start, 'the subject spans more than one line').toBeGreaterThan(1);
      expect(physical[end], 'the next header is intact').toMatch(/^Date: /);
      for (const line of physical.slice(start, end)) {
        expect(line.length, `line ≤ 76: ${line}`).toBeLessThanOrEqual(76);
      }
      const value = physical.slice(start, end).join('\r\n').replace(/\r\n[ \t]/g, ' ').slice('Subject: '.length);
      const strict = new TextDecoder('utf-8', { fatal: true });
      const decoded = value.split(' ').map((word) => {
        expect(word.length, `encoded-word ≤ 75: ${word}`).toBeLessThanOrEqual(75);
        const m = /^=\?UTF-8\?Q\?([^?\s]*)\?=$/.exec(word);
        expect(m, `a well-formed encoded-word: ${word}`).not.toBeNull();
        const bytes: number[] = [];
        const text = m![1]!;
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '_') bytes.push(0x20);
          else if (text[i] === '=') { bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
          else bytes.push(text.charCodeAt(i));
        }
        return strict.decode(new Uint8Array(bytes));
      }).join('');
      expect(decoded).toBe(subject);
    });

    it('RFC 2047-encodes a non-ASCII From display name (account sender)', async () => {
      const fromLine = await fromLineFor('Björn Müller');
      expect(fromLine).toMatch(/^From: =\?UTF-8\?Q\?/);
      expect(fromLine).toContain('=C3=B6'); // ö
      expect(fromLine).not.toContain('ö'); // raw umlaut gone
    });
  });
}
