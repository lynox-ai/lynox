/** Glob matching for capability-contract host and path patterns. */

/**
 * Convert a glob pattern to a RegExp.
 * - `**` matches anything (including `/`)
 * - `*` matches anything except `/`
 * - `?` matches one character except `/`
 * - All other regex-special characters are escaped.
 *
 * INVARIANT: the emitted pattern never contains two ADJACENT unanchored
 * quantifiers (`.*`/`[^/]*`), a catastrophic-backtracking shape that, tested
 * against a non-matching input, can freeze the event loop. Adjacency
 * arises not only from consecutive stars but from repeated double-star groups
 * separated by slashes: each double-star also consumes its trailing slash, so the
 * separators vanish and the quantifiers land side by side — both cases coalesce.
 * Two adjacent unanchored quantifiers match the same as a single `.*`, so they merge.
 */
export function globToRegex(glob: string): RegExp {
  const parts: string[] = [];
  const any = '.*';
  const segment = '[^/]*';
  // Append an unanchored quantifier, merging with a preceding one so the output
  // can never hold two in a row (`any` ⊇ `segment`, so the union is always `any`).
  const coalesceQuantifier = (q: string): void => {
    const last = parts[parts.length - 1];
    if (last === any || last === segment) {
      parts[parts.length - 1] = any;
    } else {
      parts.push(q);
    }
  };
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      coalesceQuantifier(any);
      i += 2;
      if (glob[i] === '/') i++;
    } else if (ch === '*') {
      coalesceQuantifier(segment);
      i++;
    } else if (ch === '?') {
      parts.push('[^/]');
      i++;
    } else if ('.+(){}[]^$|\\'.includes(ch)) {
      parts.push('\\' + ch);
      i++;
    } else {
      parts.push(ch);
      i++;
    }
  }
  return new RegExp(`^${parts.join('')}$`);
}

/** Structurally-unrelated probe hosts across unrelated TLDs. A single host glob
 *  that matches ≥2 of these matches (nearly) any host (`*`, `**`, `*.*`, …) — an
 *  over-broad grant. A bounded label wildcard (`*.googleapis.com`) matches none. */
const OVERBROAD_HOST_PROBES = [
  'a.example.com',
  'b.attacker-domain.net',
  'c.some-host.org',
  'internal.local',
] as const;

/**
 * Is `pattern` an over-broad host glob — one that grants (nearly) any host rather
 * than pinning specific ones? Reuses {@link globToRegex} (the SAME matcher the
 * capability-contract enforcement uses, so this can't drift from it) and tests it
 * against structurally-unrelated probes: a match on ≥2 unrelated TLDs means the
 * pattern is a match-anything wildcard = fleet-wide egress intent. An unparseable
 * pattern is treated as over-broad (fail-closed). Used to reject an over-broad
 * grant at contract save-time and to flag one on the workflow-import consent surface.
 */
export function isOverbroadHostPattern(pattern: string): boolean {
  let re: RegExp;
  try {
    re = globToRegex(pattern);
  } catch {
    return true;
  }
  return OVERBROAD_HOST_PROBES.filter(h => re.test(h)).length >= 2;
}
