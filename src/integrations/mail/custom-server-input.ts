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
 * When `secure` is omitted it follows the port rather than defaulting to true —
 * an implicit-TLS handshake against a STARTTLS submission port hangs until the
 * timeout. That is nodemailer's own convention.
 */
export function parseCustomServers(raw: unknown): { imap: MailServerConfig; smtp: MailServerConfig } {
  const block = (typeof raw === 'object' && raw !== null ? raw : {}) as CustomServerBlock;

  const imapPort = typeof block.imap?.port === 'number' ? block.imap.port : DEFAULT_IMAP_PORT;
  const smtpPort = typeof block.smtp?.port === 'number' ? block.smtp.port : DEFAULT_SMTP_PORT;

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
      secure: typeof block.smtp?.secure === 'boolean' ? block.smtp.secure : smtpPort === IMPLICIT_TLS_SMTP_PORT,
    },
  };
}
