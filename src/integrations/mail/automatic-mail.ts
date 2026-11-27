/**
 * Whether a mail was sent by a machine rather than a person, read from its headers. One reading
 * for every provider: the envelope's `isAutoReply` blocks `mail_reply` (no reply loop with an
 * autoresponder) and keeps such a mail from reopening a replied inbox item.
 */

/**
 * The headers {@link automaticMail} reads. A provider that fetches only some headers asks for
 * these; without them every mail reads as written by a person.
 */
export const AUTOMATIC_MAIL_HEADERS = ['Auto-Submitted', 'X-Autoreply', 'X-Autorespond', 'Precedence', 'Content-Type'] as const;

/**
 * Detect Auto-Submitted header indicating an automated message. Values other
 * than 'no' (the default per RFC 3834) signal auto-generation, so we must
 * never respond to prevent reply loops.
 */
export function isAutoSubmittedHeader(rawHeader: string | undefined): boolean {
  if (!rawHeader) return false;
  const value = rawHeader.toLowerCase().trim();
  if (value.length === 0) return false;
  // RFC 3834: Auto-Submitted: no  →  this is NOT automated (a human sent it)
  if (value.startsWith('no')) return false;
  // Anything else (auto-generated, auto-replied, auto-notified, ...) is automated
  return true;
}

/** RFC 3834 `Auto-Submitted: auto-replied` — a reply sent automatically to a message, such as an
 *  out-of-office note. Narrower than {@link isAutoSubmittedHeader}. */
export function isAutoRepliedHeader(rawHeader: string | undefined): boolean {
  if (!rawHeader) return false;
  return /^auto-replied\b/.test(rawHeader.toLowerCase().trim());
}

/**
 * `X-Autoreply` / `X-Autorespond`: set by vacation and autoresponder software that does not write
 * Auto-Submitted. Usually `yes`; some put the responder's address there. Present and not `no` or
 * `false` means an automatic reply.
 */
function isVendorAutoReplyHeader(rawHeader: string | undefined): boolean {
  if (rawHeader === undefined) return false;
  const value = rawHeader.toLowerCase().trim();
  if (value.length === 0) return false;
  return !/^(no|false|0)\b/.test(value);
}

/**
 * A delivery status report (a bounce, RFC 3464): `multipart/report` with
 * `report-type=delivery-status`. Many mail servers send it without Auto-Submitted.
 */
function isDeliveryReport(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const value = contentType.toLowerCase();
  if (!/^\s*multipart\/report\s*(;|$)/.test(value)) return false;
  return /;\s*report-type\s*=\s*"?delivery-status"?\s*(;|$)/.test(value);
}

/**
 * Read the automatic-mail marks from a message's headers. `header` returns a header's value by
 * name (any case), or undefined when the message does not carry it.
 *
 * - `isAutoReply`: any machine-sent mail — Auto-Submitted other than `no`, X-Autoreply,
 *   X-Autorespond, `Precedence: auto_reply`, or a delivery status report.
 * - `isAutoReplied`: an automatic reply to a message (an out-of-office note) — Auto-Submitted
 *   `auto-replied`, X-Autoreply, X-Autorespond or `Precedence: auto_reply`. A bounce is not one.
 *
 * `X-Auto-Response-Suppress` is not read: it asks the recipient's software not to answer, and
 * Exchange and Outlook put it on mail people write as well.
 */
export function automaticMail(header: (name: string) => string | undefined): { isAutoReply: boolean; isAutoReplied: boolean } {
  const autoSubmitted = header('Auto-Submitted');
  const vendorReply = isVendorAutoReplyHeader(header('X-Autoreply')) || isVendorAutoReplyHeader(header('X-Autorespond'));
  const precedenceReply = /^auto_reply\b/.test((header('Precedence') ?? '').toLowerCase().trim());
  const isAutoReplied = isAutoRepliedHeader(autoSubmitted) || vendorReply || precedenceReply;
  const isAutoReply = isAutoSubmittedHeader(autoSubmitted) || isAutoReplied || isDeliveryReport(header('Content-Type'));
  return { isAutoReply, isAutoReplied };
}
