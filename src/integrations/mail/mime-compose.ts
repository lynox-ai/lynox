// === MIME composition shared by the OAuth mail providers ===
//
// Gmail (`messages/send`, base64url `raw`) and Microsoft Graph (`/me/sendMail`,
// base64 MIME body) both send a message this process builds itself, so both
// need the same header encoding — and the same injection boundary. One copy,
// on purpose: a second copy of `buildRfc2822` would be a second place where a
// CRLF in a subject or a `<` in a display name has to be stopped, and the tests
// against that would guard only one of them.

import type { MailAddress, MailSendInput } from './provider.js';

/**
 * Strip CR/LF (and tab) from a header value to defeat header injection.
 * Without this, a subject like `Foo\r\nBcc: attacker@x` would inject an
 * extra Bcc header. RFC 5322 forbids these chars in unfolded headers.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

/** Printable ASCII + space — values matching this need no RFC 2047 encoding. */
const ASCII_PRINTABLE = /^[\x20-\x7E]*$/;

/**
 * Characters an encoded-word may carry LITERALLY inside a PHRASE — RFC 2047
 * §5(3): alphanumerics plus `!*+-/`, and nothing else.
 *
 * The difference from the `text` rule below is not cosmetic, it is the whole
 * security property. A phrase is where an address list is parsed, so `<`, `>`,
 * `,`, `@`, `"`, `:` and `;` left literal there let a display name close its own
 * address and open another one. `Ärger <attacker@example.com>,` as a display
 * name would otherwise emit `=?UTF-8?Q?=C3=84rger_<attacker@example.com>,?=`
 * — a second, fully-formed recipient the consent preview never showed.
 */
const PHRASE_LITERAL = /[A-Za-z0-9!*+\-/]/;

/**
 * RFC 2047 Q-encode a header value when it contains non-ASCII bytes, so Gmail
 * decodes UTF-8 instead of mis-reading the raw bytes as Latin1 (reported
 * 2026-08-12: `Subject: … — lynox` arrived in Gmail as `Subject: Ã¢Â€Â™ ynox`).
 * nodemailer (IMAP/SMTP) encodes automatically; this is only needed because
 * the Gmail-API send builds the raw MIME itself (buildRfc2822). Pure-ASCII
 * values pass through unchanged.
 *
 * `context` picks WHICH RFC 2047 rule applies, and the caller must get it right:
 * `'text'` for an unstructured header (Subject), `'phrase'` for a display name
 * in an address header. See {@link PHRASE_LITERAL} for why the phrase set is so
 * much narrower — it is an injection boundary, not a formatting preference.
 *
 * `fold` joins the encoded-words with CRLF + space instead of a space, so the
 * value can stand on its own header line. `prefixLength` is what precedes the
 * value on the first line (`Subject: ` = 9). It must leave room for the largest
 * piece (12) plus the encoded-word overhead (12), i.e. be at most 52; beyond
 * that the first line exceeds 76 characters.
 */
export function encodeMimeHeader(
  value: string,
  context: 'text' | 'phrase' = 'text',
  fold?: { readonly prefixLength: number },
): string {
  if (value.length === 0) return '';
  const phrase = context === 'phrase';
  // The pure-ASCII shortcut is only safe when every character is one the target
  // context may carry literally. In a phrase that is the narrow set above, not
  // "printable ASCII" — otherwise an all-ASCII `Bob <x@y>,` would skip encoding
  // entirely and inject on the way past.
  if (ASCII_PRINTABLE.test(value) && (!phrase || [...value].every((c) => PHRASE_LITERAL.test(c)))) return value;
  // Pass 1: encode each char into an ATOMIC Q-piece. A multi-byte char (ü → =C3=B6,
  // — → =E2=80=94, 🚀 → =F0=9F=9A=80) becomes one piece, never split below.
  const pieces: string[] = [];
  for (const ch of value) {
    if (ch === ' ') { pieces.push('_'); continue; }
    const buf = Buffer.from(ch, 'utf-8');
    if (buf.length === 1) {
      const c = ch.charCodeAt(0);
      // Which single-byte chars survive un-encoded depends on the context: the
      // narrow phrase set, or printable ASCII minus the encoded-word specials.
      const literalOk = phrase
        ? PHRASE_LITERAL.test(ch)
        : (c >= 0x21 && c <= 0x7E && ch !== '?' && ch !== '_' && ch !== '=');
      if (literalOk) {
        pieces.push(ch);
        continue;
      }
    }
    let hex = '';
    for (const b of buf) hex += '=' + b.toString(16).toUpperCase().padStart(2, '0');
    pieces.push(hex);
  }
  // Pass 2: greedy-pack pieces into encoded-words whose encoded-text stays under
  // MAX_ATOM, so the whole encoded-word (=?UTF-8?Q?…?=, 12 chars overhead) is
  // within RFC 2047 §2's 75-char limit. Long German subjects otherwise end up as
  // one >75-char encoded-word that strict clients truncate or show verbatim.
  const MAX_ATOM = 60; // 75 − 12 overhead − 3 headroom
  // Folded, every line that holds an encoded-word stays within RFC 2047 §2's
  // 76 characters: a continuation line is one space + one word (≤ 73), and the
  // first line also carries the header name, so its word is shorter by that.
  const FOLD_LINE = 76;
  const firstMax = fold ? Math.max(12, Math.min(MAX_ATOM, FOLD_LINE - fold.prefixLength - 12)) : MAX_ATOM;
  const atoms: string[] = [];
  let atom = '';
  for (const p of pieces) {
    const max = atoms.length === 0 ? firstMax : MAX_ATOM;
    if (atom.length > 0 && atom.length + p.length > max) {
      atoms.push(atom);
      atom = p;
    } else {
      atom += p;
    }
  }
  if (atom.length > 0) atoms.push(atom);
  // Encoded-words separated by linear whitespace are concatenated on decode
  // (RFC 2047 §6.2), so the space between atoms is not part of the value — and
  // a fold (CRLF + space) is linear whitespace too, so folding changes nothing
  // the reader sees.
  return atoms.map((a) => `=?UTF-8?Q?${a}?=`).join(fold ? '\r\n ' : ' ');
}

/**
 * The message as RFC 5322 text, CRLF line ends, ready to be base64(url)-encoded by the caller.
 *
 * `messageId` is for a transport that returns no id of its own: Graph's `sendMail` answers
 * 202 with an empty body, so the only id the sender can know is the one it wrote. Gmail
 * passes none and keeps returning Gmail's id. The value is sanitised like every other
 * header value; the caller builds it, never the model.
 */
export function buildRfc2822(
  input: MailSendInput,
  fromAddress: string,
  fromDisplayName?: string,
  options: { readonly messageId?: string | undefined } = {},
): string {
  const lines: string[] = [];
  // Display names get quotes escaped + CRLF stripped so a malicious display
  // name can't terminate its own quoted string and inject a header.
  const formatAddr = (a: MailAddress): string => {
    const address = sanitizeHeaderValue(a.address);
    if (!a.name) return address;
    const safeName = sanitizeHeaderValue(a.name);
    // Non-ASCII display names mojibake inside quotes too — encode the whole
    // name as an RFC 2047 encoded-word (no quotes; a quoted string is not
    // decoded). PHRASE context is mandatory here: this is an address header, so
    // the encoded-word must not carry `< > , @` literally or the name can append
    // a recipient of its own.
    if (!ASCII_PRINTABLE.test(safeName)) {
      return `${encodeMimeHeader(safeName, 'phrase')} <${address}>`;
    }
    // Quoted-string escaping: the BACKSLASH has to go first. Escaping only `"`
    // left a name ending in `\` able to escape the closing quote itself
    // (`Bob\` → `"Bob\" <real@x>"`), so the quoted string swallowed the real
    // address and whatever followed became the header's own content.
    return `"${safeName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${address}>`;
  };
  const fromAddr: MailAddress = fromDisplayName
    ? { name: fromDisplayName, address: fromAddress }
    : { address: fromAddress };
  lines.push(`From: ${formatAddr(fromAddr)}`);
  lines.push(`To: ${input.to.map(formatAddr).join(', ')}`);
  if (input.cc?.length) lines.push(`Cc: ${input.cc.map(formatAddr).join(', ')}`);
  if (input.bcc?.length) lines.push(`Bcc: ${input.bcc.map(formatAddr).join(', ')}`);
  if (input.replyTo) lines.push(`Reply-To: ${formatAddr(input.replyTo)}`);
  lines.push(`Subject: ${encodeMimeHeader(sanitizeHeaderValue(input.subject), 'text', { prefixLength: 'Subject: '.length })}`);
  // Date is needed for proper threading on receiving servers — Gmail backfills
  // when omitted but that loses precision when the message is forwarded.
  lines.push(`Date: ${new Date().toUTCString()}`);
  if (options.messageId) lines.push(`Message-ID: ${sanitizeHeaderValue(options.messageId)}`);
  if (input.inReplyTo) lines.push(`In-Reply-To: ${sanitizeHeaderValue(input.inReplyTo)}`);
  if (input.references) lines.push(`References: ${sanitizeHeaderValue(input.references)}`);
  lines.push('MIME-Version: 1.0');
  if (input.html) {
    // Multipart alternative, very minimal
    const boundary = `lynox-${Math.random().toString(36).slice(2, 12)}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(input.text);
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(input.html);
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(input.text);
  }
  return lines.join('\r\n');
}
