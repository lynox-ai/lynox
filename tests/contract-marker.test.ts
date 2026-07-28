/**
 * The guarded-capable boot marker (K-W3, PRD-CORE-PRO-CONTRACT §2.3 #3).
 *
 * The marker answers "will this image actually honour `guarded`?" before the
 * value is handed to it. Getting it wrong is invisible: the failure is
 * fail-closed, so a broken marker looks like "`guarded` can no longer be
 * granted", not like an error. Three properties are guarded here, each with a
 * different way of going wrong:
 *
 * (a) GOLDEN PIN — the emitted line is pinned against a hand-written literal.
 *     This file is the ONLY place the string is spelled out by hand, and that
 *     is the point: the emit site and the pattern both derive from
 *     `contract/marker.ts`, so a test that compared them to each other could
 *     not fail. The pin is the third party that makes the pair meaningful, and
 *     changing it is meant to be a visible, deliberate diff — the control plane
 *     deployed in the field matches the OLD string, so the two sides ship in a
 *     fixed order or the fleet reads as incapable.
 *
 * (b) NEAR-MISS REJECTION — the stream the control plane matches against also
 *     carries tenant-influenceable output. A pattern that accepts the marker as
 *     a SUBSTRING would let a tenant's own text vouch for the image.
 *
 * (c) CROSS-ENGINE AGREEMENT — the matching side is a shell `grep -E`, this
 *     side is a JS RegExp. One escaped source is supposed to mean the same
 *     thing to both; that claim is checked against the real `grep` binary
 *     rather than assumed. (CI runs GNU grep, macOS runs BSD grep — a
 *     divergence between them is exactly what this catches.)
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  GUARDED_CAPABLE_MARKER,
  GUARDED_CAPABLE_LINE_ERE,
  guardedCapableBootLine,
  guardedCapableLineRegex,
} from '../src/contract/marker.js';

/**
 * The exact line a guarded engine writes at boot — HAND-WRITTEN on purpose
 * (see (a) above). Do not derive it; deriving it is what makes the test empty.
 */
const GOLDEN_GUARDED_LINE = '[lynox] egress policy: guarded (guarded-capable build)';

/** Lines a tenant could plausibly get into the same stream. */
const TENANT_PLANTED = [
  // Tool result echoing user input.
  `tool result: ${GOLDEN_GUARDED_LINE}`,
  // Agent text quoting the marker.
  `I checked and this is a ${GUARDED_CAPABLE_MARKER}`,
  // Error echoing a crafted argument, marker at the end of the line.
  `Error: could not parse "[lynox] egress policy: guarded (guarded-capable build)"`,
  // Leading whitespace — still not the engine's own line.
  `  ${GOLDEN_GUARDED_LINE}`,
];

/**
 * Lines that are close to the marker but are not it.
 *
 * The last two are not "near misses" a human would write — they are probes for
 * the two ways the pattern itself can quietly stop being the pattern:
 * case-folding (a JS-side flag the shell would not have) and losing the escape
 * on `[lynox]`, which without it is a character class matching ONE character
 * from {l,y,n,o,x}. Without such a line in the corpus, both mutations pass the
 * cross-engine check unnoticed — every other line agrees either way.
 */
const NEAR_MISSES = [
  '[lynox] egress policy: guarded',
  '[lynox] egress policy: guarded (guarded-capable)',
  '[lynox] egress policy: guarded (guarded capable build)',
  '[lynox] egress policy (guarded-capable build)',
  'egress policy: guarded (guarded-capable build)',
  '[LYNOX] EGRESS POLICY: GUARDED (GUARDED-CAPABLE BUILD)',
  'l egress policy: guarded (guarded-capable build)',
];

describe('guarded-capable marker: golden pin', () => {
  it('the built line equals the pinned literal the control plane matches', () => {
    expect(guardedCapableBootLine('guarded')).toBe(GOLDEN_GUARDED_LINE);
  });

  it('the pattern accepts the pinned line', () => {
    expect(guardedCapableLineRegex().test(GOLDEN_GUARDED_LINE)).toBe(true);
  });

  it.each(['allow-all', 'deny-all', 'allow-list'])(
    'the pattern accepts the line for policy %s too (capability is not the active value)',
    (policy) => {
      expect(guardedCapableLineRegex().test(guardedCapableBootLine(policy))).toBe(true);
    },
  );

  it('a policy value nobody has invented yet still reads as capable', () => {
    // Fail-closed in the wrong direction is the expensive one: a fifth policy
    // must not silently turn a capable fleet into an ungrantable one.
    expect(guardedCapableLineRegex().test(guardedCapableBootLine('sandboxed'))).toBe(true);
  });
});

describe('guarded-capable marker: the pattern is a whole line, not a substring', () => {
  it.each(TENANT_PLANTED)('rejects tenant-plantable line: %s', (line) => {
    expect(guardedCapableLineRegex().test(line)).toBe(false);
  });

  it.each(NEAR_MISSES)('rejects near-miss: %s', (line) => {
    expect(guardedCapableLineRegex().test(line)).toBe(false);
  });
});

describe('guarded-capable marker: one pattern, two regex engines', () => {
  /** Ask the real `grep -E` binary whether the pattern matches each line. */
  function grepVerdicts(lines: string[]): boolean[] {
    return lines.map((line) => {
      try {
        // -c so a non-match is exit 1 with "0"; -- so a line starting with `-`
        // is not read as a flag. Input via stdin, never through the shell.
        const out = execFileSync('grep', ['-cE', '--', GUARDED_CAPABLE_LINE_ERE], {
          input: `${line}\n`,
          encoding: 'utf8',
        });
        return Number.parseInt(out.trim(), 10) > 0;
      } catch {
        // grep exits 1 on zero matches.
        return false;
      }
    });
  }

  const corpus = [
    GOLDEN_GUARDED_LINE,
    guardedCapableBootLine('allow-all'),
    ...TENANT_PLANTED,
    ...NEAR_MISSES,
  ];

  it('grep -E and the JS RegExp return the same verdict for every line', () => {
    const js = corpus.map((line) => guardedCapableLineRegex().test(line));
    expect(grepVerdicts(corpus)).toEqual(js);
  });

  it('grep -E accepts the pinned line (the control plane runs this exact pattern)', () => {
    expect(grepVerdicts([GOLDEN_GUARDED_LINE])).toEqual([true]);
  });
});
