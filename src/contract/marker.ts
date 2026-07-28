/**
 * The guarded-capable boot marker — SINGLE SOURCE OF TRUTH.
 *
 * VENDORED DOWNSTREAM — edit ONLY here (`core/src/contract/`); the private
 * control plane compiles a byte-identical vendored copy. Changes here are
 * WIRE-CONTRACT changes: the engine WRITES this line at init and the control
 * plane MATCHES it, so the two must derive from the same string.
 *
 * Why the line exists at all: an engine that predates the `guarded` egress
 * policy silently drops the unknown value and runs wide open, so something has
 * to answer "will this image actually honour `guarded`?" BEFORE the value is
 * handed to it. A version number cannot answer it (a canary and a stale release
 * can carry the same version), and a self-reported capability flag can be
 * masked by a graceful-disable — the boot line is the engine doing the thing,
 * unconditionally, at a point in startup that no request can reach.
 *
 * Before this file the literal existed twice, hand-copied across the repo
 * boundary with nothing pinning the copies together: rewording core's boot log
 * would have turned every capability check negative, and because that failure
 * is fail-closed the only symptom would have been "`guarded` can no longer be
 * granted", with no line pointing at the cause.
 *
 * SCOPE — deliberately just the emitted line and the pattern that matches it.
 * HOW the downstream reader bounds its search is the reader's business and
 * stays there; a matcher that reads the wrong bytes is not a problem this file
 * can fix, and spelling the read discipline out here would publish operational
 * detail the contract has no use for.
 *
 * This file must stay DEPENDENCY-FREE (pure literals, types, and functions) —
 * consumers compile it standalone.
 */

/** The distinctive suffix that marks an image as able to honour `guarded`. */
export const GUARDED_CAPABLE_MARKER = 'guarded-capable build';

/** Prefix of the engine's egress-posture boot line. */
export const EGRESS_POLICY_LOG_PREFIX = '[lynox] egress policy:';

/**
 * The exact boot line the engine writes for `policy` (without the newline).
 * The engine's emit site calls this; downstream matches the result.
 */
export function guardedCapableBootLine(policy: string): string {
  return `${EGRESS_POLICY_LOG_PREFIX} ${policy} (${GUARDED_CAPABLE_MARKER})`;
}

/**
 * Escape a literal for use inside a POSIX ERE.
 *
 * The set is exactly the characters that are special in BOTH POSIX ERE and JS
 * RegExp, so one escaped source works in `grep -E` and in `new RegExp`. `-` and
 * `/` are deliberately absent: neither is special outside a bracket expression
 * in either flavour, while `\-` is undefined behaviour in POSIX ERE — escaping
 * them would be the one way to make the two engines disagree.
 */
function escapeEre(literal: string): string {
  return literal.replace(/[.[\]()*+?{}|^$\\]/g, '\\$&');
}

/**
 * Pattern matching one WHOLE boot line, as a POSIX ERE source string.
 *
 * Anchored at both ends on purpose. The stream this is matched against also
 * carries tenant-influenceable output (tool results, agent text, errors echoing
 * user input), so an unanchored pattern would accept the marker as a substring
 * of a line an attacker controls — "capable" is then a claim about the tenant's
 * text, not about the image. Anchoring makes the whole line the unit.
 *
 * The policy segment is a character class rather than an alternation over
 * today's four values: a future fifth policy must not make a genuinely capable
 * image read as incapable. That direction of drift is fail-closed and silent,
 * which is the expensive kind — the alternation would buy nothing, since the
 * marker suffix is what carries the capability claim.
 *
 * Written as an ERE (not a JS RegExp literal) because the matching side is a
 * shell `grep -E`; `guardedCapableLineRegex()` builds the in-process equivalent
 * from this same source, so there is one pattern, not two spellings of one.
 */
export const GUARDED_CAPABLE_LINE_ERE =
  `^${escapeEre(EGRESS_POLICY_LOG_PREFIX)} [a-z-]+ \\(${escapeEre(GUARDED_CAPABLE_MARKER)}\\)$`;

/** In-process equivalent of `GUARDED_CAPABLE_LINE_ERE`, for tests and parsers. */
export function guardedCapableLineRegex(): RegExp {
  return new RegExp(GUARDED_CAPABLE_LINE_ERE);
}
