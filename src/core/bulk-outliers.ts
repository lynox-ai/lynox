// Which verdicts of a judged bulk run differ from the rest of the run: a reading order for the owner's
// approval, never a check. A verdict that sets an allowed field to an allowed but wrong value looks
// like any other in the preview; among thousands approved with one click, the ones that stand out
// are listed first, with the reason (PRD bulk-loop §4, prompt injection into the verdict).
//
// Deterministic and local: no model, no network. What the markup checks already refuse or mark is
// not repeated here — links and scripts as markup, links to a domain outside the store and the
// start domains, hidden characters (`verdictTextRefusalOf`, `checkMarkup`, `bulk-hidden-adds.ts`).
// What they cannot see is text: an address, a phone number or a link written as words.

/** Why a verdict is listed first. */
export type OutlierReason =
  | 'changed_fields'
  | 'length_jump'
  | 'new_link'
  | 'new_email'
  | 'new_phone'
  | 'new_script'
  | 'rare_value';

/** A marker kind a verdict's text can add. */
export type MarkerKind = 'link' | 'email' | 'phone' | 'script';

/** A field's type in the judge's schema, as far as it matters here. */
export type OutlierFieldKind = 'text' | 'enum' | 'number' | 'boolean';

/** One decided target of a judged run. `before`: the before-image's value (null where none was read);
 *  `after`: the verdict's after-state. */
export interface OutlierInput {
  seq: number;
  before: unknown;
  after: unknown;
}

/** A marker kind that many verdicts of the run add: named on a line of its own, so a source that
 *  plants the same address in every target does not hide behind its own share. */
export interface SpreadMarker {
  kind: MarkerKind;
  /** How many verdicts add this kind. */
  count: number;
  /** The hosts (links) or domains (addresses) they add, most frequent first; empty for phone and script. */
  hosts: string[];
}

export interface OutlierResult {
  /** How many decided verdicts the statistics ran over. */
  decided: number;
  /** Whether the run had enough verdicts for the statistics (see {@link OUTLIER_MIN_VERDICTS}). */
  measured: boolean;
  /** Per flagged target, in plan order, its reasons in a fixed order. */
  flagged: { seq: number; reasons: OutlierReason[] }[];
  /** Marker kinds at least {@link SPREAD_SHARE} of the verdicts add. */
  spread: SpreadMarker[];
}

/** Below this many decided verdicts nothing is flagged: there is no "rest of the run" to differ from,
 *  and the owner is told to read every one. */
export const OUTLIER_MIN_VERDICTS = 20;
/** From this share of the verdicts on, a marker kind is named for the run as well. */
export const SPREAD_SHARE = 0.05;

const REASON_ORDER: OutlierReason[] = ['new_link', 'new_email', 'new_phone', 'new_script', 'rare_value', 'changed_fields', 'length_jump'];
const MARKER_REASON: Record<MarkerKind, OutlierReason> = { link: 'new_link', email: 'new_email', phone: 'new_phone', script: 'new_script' };

/** Top-level domains a host written as plain text must end in to count as one: so "z.B.", "ca.5" or
 *  "Art.Nr" in a product text is not read as an address. A host with a scheme needs none. */
const TLDS = new Set('com net org info biz io co ai app dev shop store online site xyz top club link click icu ch li de at fr it es nl be lu uk eu us ru cn me tv cc ws ly gl to gg su tk ml ga cf pw in br pl cz se no dk fi pt gr tr jp kr au ca'.split(' '));
/** A dot written obfuscated — `[.]`, `(.)`, `[dot]`, `(dot)`, ` dot ` — read as a dot. Anchored at the
 *  start of the blank before it, so a long run of blanks is read once, not once per blank. */
const OBFUSCATED_DOT = /(?<!\s)\s*(?:\[\.\]|\(\.\)|\[dot\]|\(dot\))\s*|(?<!\s)\s+dot\s+(?=[\p{L}\p{N}])|[\u3002\uFF0E\uFF61]/giu;
/** Top-level domains that are also words ("Baumwolle.Es ist", "Holz.Co"): written capitalised after a
 *  full stop that lacks its space, they start a sentence, not a host. Every other TLD counts however it
 *  is written ("Evil.Com"). */
const WORD_TLDS = new Set(['es', 'it', 'in', 'at', 'to', 'no', 'de', 'be', 'me', 'co', 'so', 'am', 'an']);
/** One label of a host: letters and digits of any script, inner hyphens. */
const HOST_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;
/** A letter or digit of any script, tested once per character outside ASCII. */
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
const SCHEME_RE = /\b(?:h[tx]{2}ps?|ftp):\/\/([^\s/?#"'<>]+)/giu;
/** A phone number: `+` and a country code, or `00`, a country code and a separator (so a GTIN that
 *  starts with 00 is not one), with an optional `(0)`; or a Swiss national number, 0 and nine digits,
 *  separated between its groups or not (`044 123 45 67`, `044 1234567`, `0441234567`). A part number
 *  grouped otherwise (`0815 123456`) is not read; German numbers, grouped every way, are not either. */
const PHONE_RE = /(?<![\d+])(?:\+[1-9](?:[\s./-]?\(0\)|[\s./-]?\d){7,16}|00[1-9]\d{0,2}[\s./-](?:[\s./-]?\(0\)|[\s./-]?\d){6,13}|0[1-9]\d[\s./-]?\d{3}[\s./-]?\d{2}[\s./-]?\d{2})(?![\d])/gu;
const SCRIPT_RE = /\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*text\/html/giu;

/** A host as a browser reads it: ASCII, lower case, Punycode for other scripts, no `www.`, no port,
 *  no final dot. It ends at the first `/` or `\` (a browser reads both as the path), and what stands
 *  before an `@` within it is the user. Undefined where it is no host, or longer than a host may be
 *  (a label of 63, a name of 253). */
function asciiHost(host: string): string | undefined {
  const authority = host.split(/[/\\]/u)[0]!;
  try {
    const name = new URL(`http://${authority.slice(authority.lastIndexOf('@') + 1)}`).hostname.replace(/\.$/u, '');
    if (name.length > 253 || name.split('.').some((l) => l.length > 63)) return undefined;
    return name.replace(/^www\./u, '') || undefined;
  } catch {
    return undefined;
  }
}

/** The key a phone number is compared by: its country code and national digits, a national number
 *  read as Swiss (41), so `+41 44 …`, `0041 44 …` and `044 …` are one number and `+49 44 …` another. */
function phoneKey(written: string): string {
  const digits = written.replace(/\(0\)/gu, '').replace(/\D/gu, '');
  if (written.startsWith('+')) return digits;
  if (digits.startsWith('00')) return digits.slice(2);
  return `41${digits.slice(1)}`;
}

/** The markers a text holds, per kind, each as a key: a host for links (ASCII, Punycode), a domain for
 *  addresses, country code and national digits for phone numbers, the scheme for scripts. */
export function markersOf(text: string): Map<MarkerKind, Set<string>> {
  const out = new Map<MarkerKind, Set<string>>([['link', new Set()], ['email', new Set()], ['phone', new Set()], ['script', new Set()]]);
  if (text.includes('://')) {
    for (const m of text.matchAll(SCHEME_RE)) {
      const host = asciiHost(m[1]!.replace(/:\d+$/u, ''));
      if (host !== undefined) out.get('link')!.add(host);
    }
  }
  // The obfuscated dots need a bracket, a parenthesis, the word "dot" or a full stop of another script.
  const dotted = /[[(\u3002\uFF0E\uFF61]|dot/iu.test(text) ? text.replace(OBFUSCATED_DOT, '.') : text;
  // A percent escape ("%2F" in a link's query) separates, as the character it stands for mostly does.
  const plain = dotted.includes('%') ? dotted.replace(/%[0-9A-Fa-f]{2}/gu, ' ') : dotted;
  // Every reading of a word adds, none takes away: a sign that only one reading cuts at (an extra @,
  // an _ inside) must not hide what another reading finds. A text that names one host a thousand times
  // reads it once, as a word and as a piece of one.
  const seen = new Set<string>();
  const hosts = new Map<string, string | undefined>();
  for (const word of dottedWords(plain)) {
    if (seen.has(word)) continue;
    seen.add(word);
    const addressed = new Set<string>();
    const sides = word.split('@');
    // A local part may be a single sign (`_@x.ch`) or stand before a doubled @ (`a@@x.ch`); only
    // nothing at all before the @ is no address.
    let localPart = false;
    for (let k = 1; k < sides.length; k++) {
      localPart ||= sides[k - 1] !== '';
      if (!localPart) continue;
      const domain = trimEnds(sides[k]!.split(/[^\p{L}\p{N}.-]/u)[0]!);
      const host = domain.includes('.') ? asciiHost(domain) : undefined;
      if (host === undefined) continue;
      out.get('email')!.add(host);
      addressed.add(host);
    }
    // Every piece between _ % + @ is read as a host as well; one an address of this word names is
    // already marked as that address.
    for (const piece of word.split(/[_%+@]/u)) {
      const token = trimEnds(piece);
      if (!hosts.has(token)) hosts.set(token, hostOfWord(token));
      const host = hosts.get(token);
      if (host !== undefined && !addressed.has(host)) out.get('link')!.add(host);
    }
  }
  for (const [written] of text.matchAll(PHONE_RE)) {
    const digits = written.replace(/\(0\)/gu, '').replace(/\D/gu, '');
    if (digits.length >= 8 && digits.length <= 15) out.get('phone')!.add(phoneKey(written));
  }
  if (/script|data/iu.test(text)) {
    for (const m of text.toLowerCase().matchAll(SCRIPT_RE)) out.get('script')!.add(m[0].replace(/\s/gu, ''));
  }
  return out;
}

/** What one verdict's text holds: the markers of its before-image (over the fields the verdict sets),
 *  and those its changed fields add over them, the own shop's links and addresses left out. */
export interface TargetMarkers {
  held: Map<MarkerKind, Set<string>>;
  added: Map<MarkerKind, Set<string>>;
}

/** {@link TargetMarkers} of one verdict. The costly part of {@link judgeOutliers}: a caller with many
 *  long texts reads them in parts and passes them in, so the reading does not hold the process. */
export function targetMarkers(input: OutlierInput, own: readonly string[]): TargetMarkers {
  const before = fieldsOf(input.before);
  const after = fieldsOf(input.after);
  const beforeText = [...after.keys()].map((f) => before.get(f)).filter((v): v is string => typeof v === 'string').join('\n');
  const held = markersOf(beforeText);
  // A phone number the before-image writes without grouping still counts as held: a digit run of a
  // phone number's length (10–12) that ends in it. An EAN (13) or a run of all digits glued is not one.
  const heldPhoneRuns = (beforeText.match(/\d+/gu) ?? []).filter((r) => r.length >= 10 && r.length <= 12);
  const added = new Map<MarkerKind, Set<string>>([['link', new Set()], ['email', new Set()], ['phone', new Set()], ['script', new Set()]]);
  for (const [f, v] of after) {
    if (typeof v !== 'string' || same(v, before.get(f))) continue;
    for (const [kind, keys] of markersOf(v)) {
      for (const key of keys) {
        if (held.get(kind)!.has(key)) continue;
        if ((kind === 'link' || kind === 'email') && ownHost(key, own)) continue;
        if (kind === 'phone' && heldPhoneRuns.some((r) => r.endsWith(key.slice(-9)))) continue;
        added.get(kind)!.add(key);
      }
    }
  }
  return { held, added };
}

/** The host a word names, ASCII, or undefined: labels joined by dots, a top-level domain from the list
 *  or in Punycode, and no capitalised word-TLD after a full stop that lacks its space. */
function hostOfWord(token: string): string | undefined {
  // Most words with a dot end a sentence or shorten one ("inkl.", "z.B."): a last label of ASCII
  // letters (A–Z only: a long s or a dotless i is read as a letter of the domain below) that is no
  // top-level domain ends the reading before the host is built.
  const tld = token.slice(token.lastIndexOf('.') + 1);
  if (/^[A-Za-z]+$/.test(tld) && !TLDS.has(tld.toLowerCase())) return undefined;
  if (!token.includes('.') || !token.split('.').every((l) => HOST_LABEL.test(l))) return undefined;
  // "Baumwolle.Es ist": a sentence whose space after the full stop is missing, not a host. Only where
  // the TLD is also a word: "Evil.Com" is a host.
  if (WORD_TLDS.has(tld.toLowerCase()) && /^\p{Lu}\p{Ll}/u.test(tld) && !/^www\./iu.test(token)) return undefined;
  const host = asciiHost(token);
  if (host === undefined) return undefined;
  const asciiTld = host.slice(host.lastIndexOf('.') + 1);
  return TLDS.has(asciiTld) || asciiTld.startsWith('xn--') ? host : undefined;
}

/** The words of a text that hold a dot or an @: maximal runs of letters and digits of any script and
 *  of `. - _ % + @`. One pass over the characters, so a text of any shape is read in linear time; the
 *  host and address rules then look at a few short words, not at every position of the text. */
function dottedWords(text: string): string[] {
  const words: string[] = [];
  let start = -1;
  let marked = false;
  const end = (i: number): void => {
    if (start >= 0 && marked) words.push(text.slice(start, i));
    start = -1;
    marked = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let inWord: boolean;
    let width = 1;
    if (c < 128) {
      inWord = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 45 || c === 95 || c === 37 || c === 43 || c === 64;
    } else {
      const point = text.codePointAt(i)!;
      if (point > 0xffff) width = 2;
      inWord = LETTER_OR_DIGIT.test(String.fromCodePoint(point));
    }
    if (inWord) {
      if (start < 0) start = i;
      if (c === 46 || c === 64) marked = true;
    } else {
      end(i);
    }
    i += width - 1;
  }
  end(text.length);
  return words;
}

/** A word without the dots, hyphens and other signs at its ends that belong to the sentence around it. */
function trimEnds(word: string): string {
  return word.replace(/^[._%+-]+|[._%+-]+$/gu, '');
}

/** A host matches an own domain exactly or as a subdomain at a dot boundary. */
function ownHost(host: string, own: readonly string[]): boolean {
  return own.some((d) => {
    const domain = asciiHost(d) ?? '';
    return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`));
  });
}

function fieldsOf(value: unknown): Map<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return new Map(Object.entries(value as Record<string, unknown>));
  return new Map([['', value]]);
}

function same(a: unknown, b: unknown): boolean {
  // A long text is compared directly, not copied into JSON first.
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

function mad(values: number[], m: number): number {
  return median(values.map((v) => Math.abs(v - m)));
}

/**
 * The verdicts of one judged run that differ from the rest of it. `own`: the store host and the start
 * domains, whose links and addresses are what the run may add. `kinds`: the type of each field in the
 * judge's schema; a field it does not name counts as text.
 */
export function judgeOutliers(
  inputs: readonly OutlierInput[], own: readonly string[], kinds: Readonly<Record<string, OutlierFieldKind>> = {},
  /** {@link targetMarkers} of each input, in order, where the caller read them already. */
  markers?: readonly TargetMarkers[],
): OutlierResult {
  const decided = inputs.length;
  if (decided < OUTLIER_MIN_VERDICTS) return { decided, measured: false, flagged: [], spread: [] };
  const reasons = new Map<number, Set<OutlierReason>>();
  const flag = (seq: number, reason: OutlierReason): void => {
    const set = reasons.get(seq) ?? new Set<OutlierReason>();
    set.add(reason);
    reasons.set(seq, set);
  };
  const targets = inputs.map((t) => ({ seq: t.seq, before: fieldsOf(t.before), after: fieldsOf(t.after) }));

  // Changed fields: above the run's upper fence.
  const changed = targets.map((t) => [...t.after].filter(([f, v]) => !same(t.before.get(f), v)).length);
  const sortedChanged = [...changed].sort((a, b) => a - b);
  const q1 = quantile(sortedChanged, 0.25);
  const q3 = quantile(sortedChanged, 0.75);
  const fence = Math.max(q3 + 3 * (q3 - q1), quantile(sortedChanged, 0.5) + 2);
  targets.forEach((t, i) => { if (changed[i]! > fence) flag(t.seq, 'changed_fields'); });

  // Length per text field: against the run's other targets of that field, a target whose before is
  // empty only against the others whose before is empty (a run that fills empty fields would
  // otherwise mark every one).
  const textFields = new Set<string>();
  for (const t of targets) for (const [f, v] of t.after) if (typeof v === 'string' && (kinds[f] ?? 'text') === 'text') textFields.add(f);
  for (const f of textFields) {
    const filled: { seq: number; x: number }[] = [];
    const fromEmpty: { seq: number; x: number }[] = [];
    for (const t of targets) {
      const a = t.after.get(f);
      const b = t.before.get(f);
      if (typeof a !== 'string' || same(a, b)) continue;
      const was = typeof b === 'string' ? b.length : 0;
      if (was === 0) fromEmpty.push({ seq: t.seq, x: Math.log(a.length + 1) });
      else filled.push({ seq: t.seq, x: Math.log((a.length + 1) / (was + 1)) });
    }
    for (const group of [filled, fromEmpty]) {
      if (group.length < OUTLIER_MIN_VERDICTS) continue;
      const xs = group.map((g) => g.x);
      const m = median(xs);
      const limit = Math.max(4 * 1.4826 * mad(xs, m), Math.LN2);
      for (const g of group) if (Math.abs(g.x - m) > limit) flag(g.seq, 'length_jump');
    }
  }

  // Rare values in enum, number and boolean fields, where the verdict changed the field.
  for (const [f, kind] of Object.entries(kinds)) {
    if (kind === 'text') continue;
    const counts = new Map<string, number>();
    for (const t of targets) {
      const key = JSON.stringify(t.after.get(f) ?? null);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const deltas: { seq: number; d: number; base: number }[] = [];
    for (const t of targets) {
      const a = t.after.get(f);
      const b = t.before.get(f);
      if (same(a, b)) continue;
      const n = counts.get(JSON.stringify(a ?? null)) ?? 0;
      // A count says nothing for a number: prices are mostly each their own. A number counts by its change.
      if (kind !== 'number' && n <= 2 && n < decided * 0.01 + 1) flag(t.seq, 'rare_value');
      if (kind === 'number' && typeof a === 'number' && typeof b === 'number') deltas.push({ seq: t.seq, d: a - b, base: Math.abs(b) });
    }
    if (deltas.length >= OUTLIER_MIN_VERDICTS) {
      const ds = deltas.map((x) => x.d);
      const m = median(ds);
      const scale = Math.max(1.4826 * mad(ds, m), 0.01 * median(deltas.map((x) => x.base)), Number.EPSILON);
      for (const x of deltas) if (Math.abs(x.d - m) > 6 * scale) flag(x.seq, 'rare_value');
    }
  }

  // Markers a verdict's text adds over its own before-image.
  const added = new Map<MarkerKind, Map<number, Set<string>>>();
  const inBefores = new Map<MarkerKind, Set<string>>([['link', new Set()], ['email', new Set()], ['phone', new Set()], ['script', new Set()]]);
  inputs.forEach((input, i) => {
    const m = markers?.[i] ?? targetMarkers(input, own);
    for (const [kind, keys] of m.held) for (const k of keys) inBefores.get(kind)!.add(k);
    for (const [kind, keys] of m.added) {
      if (keys.size === 0) continue;
      const perTarget = added.get(kind) ?? new Map<number, Set<string>>();
      perTarget.set(input.seq, keys);
      added.set(kind, perTarget);
    }
  });
  const spread: SpreadMarker[] = [];
  for (const kind of ['link', 'email', 'phone', 'script'] as const) {
    const perTarget = added.get(kind);
    if (perTarget === undefined) continue;
    const widespread = perTarget.size >= decided * SPREAD_SHARE;
    for (const [seq, keys] of perTarget) {
      // Below the share every one is flagged; at or above it, the one whose marker no before-image of
      // the run holds anywhere: a source that plants it in every target is listed, not averaged away.
      if (!widespread || [...keys].some((k) => !inBefores.get(kind)!.has(k))) flag(seq, MARKER_REASON[kind]);
    }
    if (widespread) {
      const hostCounts = new Map<string, number>();
      if (kind === 'link' || kind === 'email') {
        for (const keys of perTarget.values()) for (const k of keys) hostCounts.set(k, (hostCounts.get(k) ?? 0) + 1);
      }
      const hosts = [...hostCounts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([h]) => h);
      spread.push({ kind, count: perTarget.size, hosts });
    }
  }

  const flagged = [...reasons]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, set]) => ({ seq, reasons: REASON_ORDER.filter((r) => set.has(r)) }));
  return { decided, measured: true, flagged, spread };
}
