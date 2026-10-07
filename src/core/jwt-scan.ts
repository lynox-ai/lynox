/**
 * JWT shapes, matched in linear time.
 *
 * A JWT regex like `/eyJ[A-Za-z0-9_-]{10,}\.…/` retries from every `eyJ` inside a long run
 * of base64url characters and scans to the end of that run each time. When the dots it
 * needs never come, the work grows with the square of the run's length, and a regex cannot
 * be interrupted. The scans that use these shapes read text from outside: request bodies,
 * error messages, mail, tool results.
 *
 * `LinearJwtRegExp` keeps each shape's regex as its `source` — that is still what it
 * matches — but overrides `exec`. `test`, `String#replace`, `match` and `matchAll` all go
 * through `exec`, so callers keep using it as a RegExp. The equivalence with the regex is
 * pinned by a fuzz test over replace, matchAll and test.
 *
 * Clone one with {@link withFlags}, never `new RegExp(re.source, …)`: that builds the
 * plain regex again.
 *
 * NOTE: `packages/web-ui/src/lib/utils/jwt-scan.ts` is a copy (the web UI cannot import the
 * engine); `tests/secret-shapes-parity.test.ts` holds the two equal.
 */

/** One JWT regex, described by the parts the linear matcher needs. */
export interface JwtShapeSpec {
  /** The regex this spec stands for. Documentation and the fuzz test's reference. */
  readonly regex: RegExp;
  /** `\b` before `eyJ` (true) or any position (false). */
  readonly wordStart: boolean;
  /** Minimum characters after `eyJ` in the first segment. */
  readonly s1: number;
  /** Whether the second segment must start with `eyJ`, and its minimum length after that (or in total). */
  readonly s2Eyj: boolean;
  readonly s2: number;
  /** The third segment: `null` when the match ends at the second dot. */
  readonly s3: { readonly min: number; readonly wordEnd: boolean } | null;
}

const isB64 = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
const isWord = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const DOT = 46;

/**
 * The first match of `spec` at or after `from`, as `[start, end)`, or null — the match a
 * global regex finds when it continues at `lastIndex = from`.
 *
 * Linear: everything after the first segment depends only on where that segment's run
 * ends, so it is worked out once per run, and the walk never returns to a run it has left.
 */
export function jwtSpanFrom(text: string, spec: JwtShapeSpec, from: number): [number, number] | null {
  const n = text.length;
  const runEnd = (at: number): number => {
    let i = at;
    while (i < n && isB64(text.charCodeAt(i))) i++;
    return i;
  };
  const tailEnd = (r1: number): number => {
    if (r1 >= n || text.charCodeAt(r1) !== DOT) return -1;
    const r2 = runEnd(r1 + 1);
    const len2 = r2 - (r1 + 1);
    const ok2 = spec.s2Eyj ? text.startsWith('eyJ', r1 + 1) && len2 >= 3 + spec.s2 : len2 >= spec.s2;
    if (!ok2 || r2 >= n || text.charCodeAt(r2) !== DOT) return -1;
    if (spec.s3 === null) return r2 + 1;
    const r3 = runEnd(r2 + 1);
    const lo = r2 + 1 + spec.s3.min;
    if (r3 < lo) return -1;
    if (!spec.s3.wordEnd) return r3;
    // Greedy, then back off to the last position where `\b` holds.
    for (let e = r3; e >= lo && e > r2 + 1; e--) {
      if (isWord(text.charCodeAt(e - 1)) !== (e < n && isWord(text.charCodeAt(e)))) return e;
    }
    return -1;
  };

  // Walk run by run. Every `eyJ` in a run shares that run's end and the verdict on what
  // follows it, so both are worked out once; then the run's starts are checked in order, and
  // the walk moves on past the run. Each character is visited a bounded number of times.
  let i = from;
  while (i < n) {
    const first = text.indexOf('eyJ', i);
    if (first < 0) return null;
    const r1 = runEnd(first + 3);
    const tail = tailEnd(r1);
    if (tail >= 0) {
      const last = r1 - 3 - spec.s1; // a later start leaves too few characters before the dot
      for (let p = first; p <= last; p++) {
        if (!text.startsWith('eyJ', p)) continue;
        if (spec.wordStart && p > 0 && isWord(text.charCodeAt(p - 1))) continue;
        return [p, tail];
      }
    }
    i = r1;
  }
  return null;
}

/** A RegExp whose matching runs in linear time; its `source` is the regex it equals. */
export class LinearJwtRegExp extends RegExp {
  readonly spec: JwtShapeSpec;

  constructor(spec: JwtShapeSpec | LinearJwtRegExp, flags?: string) {
    const base = spec instanceof LinearJwtRegExp ? spec.spec : spec;
    // `flags` is undefined when RegExp's own machinery clones through the species
    // constructor with the flags it wants passed separately — keep the source's then.
    super(base.regex.source, flags ?? (spec instanceof LinearJwtRegExp ? spec.flags : base.regex.flags));
    // Only `g` is honoured by `exec` below. Any other flag would be carried in `.flags` and
    // silently ignored (`i` would not match case-insensitively), and `split` clones with `y`.
    if (/[^g]/.test(this.flags)) throw new Error(`LinearJwtRegExp supports only the g flag, got "${this.flags}"`);
    this.spec = base;
  }

  override exec(input: string): RegExpExecArray | null {
    const text = String(input);
    const from = this.global ? this.lastIndex : 0;
    const span = from <= text.length ? jwtSpanFrom(text, this.spec, from) : null;
    if (span === null) {
      if (this.global) this.lastIndex = 0;
      return null;
    }
    const match = [text.slice(span[0], span[1])] as unknown as RegExpExecArray;
    match.index = span[0];
    match.input = text;
    if (this.global) this.lastIndex = span[1];
    return match;
  }
}

/** A copy of `re` with `flags` — keeps a linear JWT RegExp linear. */
export function withFlags(re: RegExp, flags: string): RegExp {
  return re instanceof LinearJwtRegExp ? new LinearJwtRegExp(re, flags) : new RegExp(re.source, flags);
}

/** The shared list's JWT shape (`SECRET_SHAPES`, kind `jwt`). */
export const JWT_SHAPE: JwtShapeSpec = {
  regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b/,
  wordStart: true, s1: 10, s2Eyj: true, s2: 10, s3: { min: 1, wordEnd: true },
};
/** The outbound scan's wider JWT form (kind `egress-wide`): payload need not start with `eyJ`. */
export const JWT_EGRESS_WIDE: JwtShapeSpec = {
  regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  wordStart: false, s1: 10, s2Eyj: false, s2: 10, s3: null,
};
/** Debug output values (`debug-subscriber.ts`). */
export const JWT_DEBUG_VALUE: JwtShapeSpec = {
  regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/,
  wordStart: false, s1: 10, s2Eyj: false, s2: 10, s3: { min: 0, wordEnd: false },
};
/** Security-audit previews (`security-audit.ts`). */
export const JWT_AUDIT_PREVIEW: JwtShapeSpec = {
  regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  wordStart: false, s1: 10, s2Eyj: false, s2: 10, s3: { min: 10, wordEnd: false },
};
/** Process-capture redaction (`process-capture.ts`). */
export const JWT_PROCESS_CAPTURE: JwtShapeSpec = {
  regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  wordStart: true, s1: 8, s2Eyj: false, s2: 8, s3: { min: 8, wordEnd: false },
};
/** Inbox sensitive-content detection (`sensitive-content.ts`). */
export const JWT_INBOX: JwtShapeSpec = {
  regex: /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/,
  wordStart: true, s1: 15, s2Eyj: false, s2: 15, s3: { min: 15, wordEnd: true },
};

/** Every spec in this file, for the equivalence test. */
export const JWT_SPECS: Readonly<Record<string, JwtShapeSpec>> = {
  JWT_SHAPE, JWT_EGRESS_WIDE, JWT_DEBUG_VALUE, JWT_AUDIT_PREVIEW, JWT_PROCESS_CAPTURE, JWT_INBOX,
};
