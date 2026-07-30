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
 * stays there; a matcher that reads the wrong bytes is not a problem this
 * pattern ALONE can fix, and spelling the read discipline out here would
 * publish operational detail the contract has no use for. "Alone" is load-
 * bearing: a future design that gives the marker an unguessable per-boot
 * component would change the emitted line, and would therefore land here.
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
 * Escape a literal for use inside a POSIX ERE that a JS RegExp must read the
 * same way.
 *
 * The set is the JS-RegExp special characters, minus `-` and `/`, which are not
 * special outside a bracket expression in either flavour. It is NOT the exact
 * intersection with POSIX-ERE specials — `]` and `}` are also harmless
 * unescaped in an ERE, and they are escaped here anyway. That asymmetry is
 * deliberate rather than tidy: GNU, BSD and busybox `grep -E` all accept `\]`
 * and `\}` as the literal character, so escaping them costs nothing, while
 * leaving them raw would depend on each implementation's handling of an
 * unmatched bracket. `\-` is the case where that bet does NOT hold, so `-` is
 * left alone.
 *
 * Pinned by the cross-engine test, which runs the real `grep` binary and the JS
 * RegExp over the same corpus and compares verdicts — if this reasoning is
 * wrong on some platform, that test says so instead of this comment being
 * believed.
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
 * SCOPE — this pattern decides what a SINGLE LINE can claim, and nothing more.
 * Which lines are worth reading at all is the reader's half of the problem, and
 * it lives with the reader. A downstream comment that presents this pattern as
 * the whole guarantee is wrong; the previous version of this seam was believed
 * to do more than it did, which is how it stayed unanchored for weeks under a
 * comment saying otherwise.
 *
 * The policy segment is `[a-z-]+`, which covers every value in `vocab.ts`'s
 * `NetworkPolicy` and any future lowercase-and-hyphen sibling. It deliberately
 * does not enumerate today's four: a new policy must not make a genuinely
 * capable image read as incapable, and that direction of drift is fail-closed
 * and silent, which is the expensive kind. A policy containing a digit or an
 * uppercase letter would NOT match — accepted, because the config layer
 * validates the value against the enum before it reaches the log line.
 *
 * Written as an ERE (not a JS RegExp literal) because the matching side is a
 * shell `grep -E`; `guardedCapableLineRegex()` builds the in-process equivalent
 * from this same source, so there is one pattern, not two spellings of one.
 */
export const GUARDED_CAPABLE_LINE_ERE =
  `^${escapeEre(EGRESS_POLICY_LOG_PREFIX)} [a-z-]+ \\(${escapeEre(GUARDED_CAPABLE_MARKER)}\\)$`;

/**
 * In-process equivalent of `GUARDED_CAPABLE_LINE_ERE`, for tests and parsers.
 *
 * The `m` flag is what makes "equivalent" true. `grep` is line-based: it applies
 * the pattern to each line of its input, so `^`/`$` mean line boundaries. A JS
 * RegExp without `m` reads them as buffer boundaries, so handed a multi-line log
 * buffer it returns false where `grep` returns a match — a silent divergence in
 * the fail-closed direction, and exactly the kind of thing an export advertised
 * as "the same pattern" must not have.
 */
export function guardedCapableLineRegex(): RegExp {
  return new RegExp(GUARDED_CAPABLE_LINE_ERE, 'm');
}
