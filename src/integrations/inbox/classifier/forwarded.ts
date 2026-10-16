// === Inbox classifier — a forward from a person is not left in auto_handled by the model ===
//
// A mail a person forwarded is mostly sent so that the recipient looks at it, often with
// no more than "FYI" on top. The model reads that "FYI" as "no action" now and then and
// archives the mail, which is the one mistake the inbox cannot undo. This check is
// STRUCTURAL on purpose: it reads the shape of the mail (a forward prefix in the subject
// or a forward header in the body) and who sent it, never what the mail asks for, so it
// does not hand the model's question to a second classifier.
//
// Scope: it overrides the MODEL's verdict only. A user rule or the duplicate check decides
// before the model is asked, and this check does not reach them.
//
// What it claims, in both directions:
// - A forward in a form these patterns do not know (a reply prefix in front, another
//   language, a client's own header) or from an address on the automated list falls back
//   to the model's verdict: no better than before, and no worse.
// - A mail the patterns match that needed nothing lands in the list that needs the user,
//   with its notification, instead of being archived: a wrong match costs attention, not
//   a lost mail.

/** Subject prefixes some mail clients put on a forward: Fwd, Fw, WG, Wtr, TR. Not a complete list. */
const FORWARD_SUBJECT = /^\s*(?:fwd?|wg|wtr|tr)\s*:/i;

/**
 * Body markers mail clients write above a FORWARDED message. Outlook's "Original Message" /
 * "Ursprüngliche Nachricht" are left out on purpose: Outlook writes them above a quoted reply
 * as well, so they do not tell a forward from an answer.
 *
 * `--`, not `-{2,}`: only presence matters, and an unbounded run is tried again from every
 * dash, which is quadratic in a long run of dashes. The body reaching this is a provider
 * snippet today; a full body would make that a stall on the event loop.
 */
const FORWARD_HEADER = /--\s*(?:forwarded message|weitergeleitete nachricht)|begin forwarded message/i;

/**
 * Local parts of addresses no person writes from. A system that forwards (an alias, a
 * ticket tool) is not a person asking the recipient to look.
 */
const AUTOMATED_SENDER = /^(?:no-?reply|do-?not-?reply|notifications?|alerts?|mailer-daemon|newsletter|bounces?)(?:[+.-][^@]*)?@/i;

/** What the user reads as the reason, instead of the model's reason for archiving. */
export const FORWARDED_REASON_DE = 'Von einer Person weitergeleitet — bitte ansehen.';

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
