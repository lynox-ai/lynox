// === Custom IMAP/SMTP request parsing ===
//
// The `custom` block of a mail-account request, turned into server configs with
// defaults filled in. Extracted because two routes parse it — POST
// /api/mail/accounts and POST /api/mail/accounts/test — and they must agree:
// a test that passes against different defaults than the save uses is worth
// nothing. Validation (non-empty hosts, port range, public-host guard) stays
// with the routes, which own the error responses.

import type { MailServerConfig } from './provider.js';

/** Raw shape as it arrives on the wire — every field unverified. */
export interface CustomServerBlock {
  imap?: { host?: unknown; port?: unknown; secure?: unknown } | undefined;
  smtp?: { host?: unknown; port?: unknown; secure?: unknown } | undefined;
}

/** IMAP over implicit TLS. Universally reachable; no network blocks 993. */
const DEFAULT_IMAP_PORT = 993;
/** IETF mail submission (RFC 6409) — see the TLS note in providers/presets.ts. */
const DEFAULT_SMTP_PORT = 587;
/** The one port where `secure` (implicit TLS) is the right default. */
const IMPLICIT_TLS_SMTP_PORT = 465;

/**
 * Fill in the defaults for a custom server block.
 *
 * Hosts default to '' so the caller can reject them; ports and TLS flags get
 * real defaults. The SMTP default is submission on 587, NOT implicit TLS on
 * 465: outbound 465 is blocked by many hosting providers, ours included, and
 * the failure is a silent send timeout long after setup.
 *
 * **Port and `secure` are defaulted from each other, never independently.**
 * They are two halves of one decision, and filling both in on their own
 * produces the one combination that is broken on every server in the world:
 * an implicit-TLS handshake against a STARTTLS submission port, which hangs
 * until the timeout. So whichever half the client supplied wins, and the other
 * follows it:
 *
 * | given | result |
 * |---|---|
 * | nothing | 587 + STARTTLS |
 * | `secure: true` | **465** + implicit TLS — the port follows the TLS mode |
 * | `port: 465` | 465 + implicit TLS |
 * | `port: 587` | 587 + STARTTLS |
 * | both | both, verbatim — 465 stays available |
 *
 * A port that is not a finite number counts as not supplied — missing, a
 * string, the `null` an emptied number input binds to, or NaN, which is a
 * `number` and would otherwise be carried through to be rejected downstream as
 * an out-of-range port the client never sent.
 */
export function parseCustomServers(raw: unknown): { imap: MailServerConfig; smtp: MailServerConfig } {
  const block = (typeof raw === 'object' && raw !== null ? raw : {}) as CustomServerBlock;

  // `Number.isFinite`, not `typeof === 'number'`: NaN is a number and would be
  // carried straight through to a port field, where the route then rejects it
  // with a range error about a port the client never sent.
  const imapPort = Number.isFinite(block.imap?.port) ? block.imap!.port as number : DEFAULT_IMAP_PORT;

  const givenSmtpPort = Number.isFinite(block.smtp?.port) ? block.smtp!.port as number : undefined;
  const givenSmtpSecure = typeof block.smtp?.secure === 'boolean' ? block.smtp.secure : undefined;
  const smtpPort = givenSmtpPort ?? (givenSmtpSecure === true ? IMPLICIT_TLS_SMTP_PORT : DEFAULT_SMTP_PORT);
  // An unsupplied `secure` on an unusual port resolves to STARTTLS, which the
  // transport then *requires* — implicit TLS on a non-465 port has to be asked
  // for. The UI always sends both fields, so this only reaches API clients.
  const smtpSecure = givenSmtpSecure ?? smtpPort === IMPLICIT_TLS_SMTP_PORT;

  return {
    imap: {
      host: typeof block.imap?.host === 'string' ? block.imap.host : '',
      port: imapPort,
      // IMAP keeps its historical default: implicit TLS unless explicitly off.
      secure: block.imap?.secure !== false,
    },
    smtp: {
      host: typeof block.smtp?.host === 'string' ? block.smtp.host : '',
      port: smtpPort,
      secure: smtpSecure,
    },
  };
}
