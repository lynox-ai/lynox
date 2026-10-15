// legal-sign-off.mjs — reads the `approved:` line a record carries for the `legal` gate.
//
// Dependency-free on purpose: this directory is vendored byte-identically into the private repo
// (see README.md), whose gate record reads the same line. The cases both repos are held to are in
// `legal-sign-off.cases.json` next to this file.

/**
 * Who may sign off on the wording of a binding customer text. A legal sign-off is a person's,
 * never a session's: a new name comes in through a change to this list, not through a line in
 * a PR body.
 */
export const LEGAL_APPROVERS = ['rafael'];

/**
 * What an `approved:` value says, read from its START: an approver and an ISO date, in that
 * order, is a sign-off. The date is a real calendar date, and no letter, digit or mark follows it.
 * Everything after the date is free text (a time, `2026-09-29/30`, where
 * it was given). Anything else is not a sign-off, however it is worded: a positive form, because
 * the ways to write "not yet" (`TBD`, `**PENDING**`, `ausstehend`, a lookalike letter) cannot be
 * listed, and each one with a date used to pass.
 *
 * @returns {'missing' | 'pending' | 'undated' | 'not-an-approver' | 'ok'}
 */
export function approvedVerdict(raw) {
  const approved = String(raw ?? '').trim();
  if (!approved) return 'missing';
  // `/^pending/i` has no `\b` on purpose: with one, `pendingapproval rafael 2026-10-02` finds no
  // boundary and gets the wrong message.
  if (/^pending/i.test(approved)) return 'pending';
  const name = approved.split(/\s/, 1)[0].toLowerCase();
  if (!LEGAL_APPROVERS.includes(name)) return 'not-an-approver';
  // The date follows the name directly; a date later in the line ties nothing to the name.
  const m = /^\S+\s+(\d{4})-(\d{2})-(\d{2})(?![\p{L}\p{N}\p{M}])/u.exec(approved);
  if (!m) return 'undated';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  // `Date.UTC` rolls 2026-02-30 over into March; a date that does not come back unchanged is none.
  const real = day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
  return real ? 'ok' : 'undated';
}
