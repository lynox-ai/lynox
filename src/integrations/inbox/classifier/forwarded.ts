// === Inbox classifier — a person's forward is never archived unseen ===
//
// A mail a person forwarded is mostly sent so that the recipient looks at it, often with
// no more than "FYI" on top. The model reads that "FYI" as "no action" now and then and
// archives the mail, which is the one mistake the inbox cannot undo. This check is
// STRUCTURAL on purpose: it reads the shape of the mail (a forward prefix in the subject
// or a forwarded-message header in the body) and who sent it, never what the mail asks
// for, so it does not hand the model's question to a second classifier.
//
// Both directions are safe, and that is all it claims:
// - A forward in a form these patterns do not know falls back to the model's verdict,
//   exactly as before this check existed.
// - A forward the patterns match that needed nothing costs the user one click.

/** Subject prefixes mail clients put on a forward (EN, DE, FR). */
const FORWARD_SUBJECT = /^\s*(?:fwd?|wg|wtr|tr)\s*:/i;

/** Body markers mail clients write above the forwarded message. */
const FORWARD_HEADER = /-{2,}\s*(?:original message|forwarded message|weitergeleitete nachricht|ursprüngliche nachricht)|begin forwarded message/i;

/**
 * Local parts of addresses no person writes from. A system that forwards (an alias, a
 * ticket tool) is not a person asking the recipient to look.
 */
const AUTOMATED_SENDER = /^(?:no-?reply|do-?not-?reply|notifications?|alerts?|mailer-daemon|newsletter|bounces?)(?:[+.-][^@]*)?@/i;

export interface ForwardShape {
  readonly subject: string | undefined;
  readonly fromAddress: string;
  readonly body: string | undefined;
}

/** True when a person forwarded this mail, read from its shape and sender only. */
export function isForwardedByPerson(mail: ForwardShape): boolean {
  const forwarded = FORWARD_SUBJECT.test(mail.subject ?? '') || FORWARD_HEADER.test(mail.body ?? '');
  return forwarded && !AUTOMATED_SENDER.test(mail.fromAddress.trim());
}
