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
 *  "Art.Nr" in a product text is not read as an address. */
const TLDS = 'com|net|org|info|biz|io|co|ai|app|dev|shop|store|online|site|xyz|top|club|link|click|ch|li|de|at|fr|it|es|nl|be|lu|uk|eu|us|ru|cn|me|tv|cc|ws|ly|gl|to|gg|su|tk|ml|ga|cf|pw|in|br|pl|cz|se|no|dk|fi|pt|gr|tr|jp|kr|au|ca';
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** A dot as written plainly or obfuscated: `.`, `[.]`, `(.)`, `(dot)`, `[dot]`, ` dot `. */
const DOT = String.raw`(?:\s*(?:\[\.\]|\(\.\)|\(dot\)|\[dot\])\s*|\s+dot\s+|\.)`;
const HOST_RE = new RegExp(String.raw`(?:^|[^a-z0-9@._-])((?:xn--)?${HOST_LABEL}(?:${DOT}(?:xn--)?${HOST_LABEL})*${DOT}(?:${TLDS}|xn--[a-z0-9-]+))(?![a-z0-9-])`, 'giu');
const SCHEME_RE = /\b(?:h[tx]{2}ps?|ftp):\/\/([^\s/?#"'<>]+)/giu;
const EMAIL_RE = /[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/giu;
/** `+` and 8–15 digits with separators, or a leading 0 with Swiss or German grouping. Article numbers,
 *  EANs, dimensions and prices have no `+` and no such grouping. */
const PHONE_RE = /(?:^|[^\d+])(\+\d(?:[\s./()-]?\d){7,14}|0\d{2}[\s/-]\d{3}[\s-]\d{2}[\s-]\d{2}|0\d{2,4}[\s/-]\d{5,8})(?!\d)/gu;
const SCRIPT_RE = /\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*text\/html/giu;

/** The markers a text holds, per kind, each as a key: a host for links, a domain for addresses, the
 *  digits for phone numbers, the scheme for scripts. Lower case. */
export function markersOf(text: string): Map<MarkerKind, Set<string>> {
  const out = new Map<MarkerKind, Set<string>>([['link', new Set()], ['email', new Set()], ['phone', new Set()], ['script', new Set()]]);
  const lower = text.toLowerCase();
  const emailHosts = new Set<string>();
  for (const m of lower.matchAll(EMAIL_RE)) {
    out.get('email')!.add(m[1]!);
    emailHosts.add(m[1]!);
  }
  const withoutEmails = lower.replace(EMAIL_RE, ' ');
  for (const m of withoutEmails.matchAll(SCHEME_RE)) out.get('link')!.add(normalHost(m[1]!));
  for (const m of withoutEmails.matchAll(HOST_RE)) out.get('link')!.add(normalHost(m[1]!));
  for (const m of text.matchAll(PHONE_RE)) out.get('phone')!.add(m[1]!.replace(/\D/g, ''));
  for (const m of lower.matchAll(SCRIPT_RE)) out.get('script')!.add(m[0].replace(/\s/g, ''));
  return out;
}

function normalHost(host: string): string {
  return host
    .replace(/^[^@]*@/u, '')
    .replace(/:\d+$/u, '')
    .replace(new RegExp(DOT, 'giu'), '.')
    .replace(/^www\./u, '')
    .replace(/\.$/u, '');
}

/** A host matches an own domain exactly or as a subdomain at a dot boundary. */
function ownHost(host: string, own: readonly string[]): boolean {
  return own.some((d) => {
    const domain = d.toLowerCase().replace(/^www\./u, '');
    return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`));
  });
}

function fieldsOf(value: unknown): Map<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return new Map(Object.entries(value as Record<string, unknown>));
  return new Map([['', value]]);
}

function same(a: unknown, b: unknown): boolean {
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
  const fence = Math.max(q3 + 1.5 * (q3 - q1), quantile(sortedChanged, 0.5) + 2);
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
      if (n <= 2 && n < decided * 0.01 + 1) flag(t.seq, 'rare_value');
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
  for (const t of targets) {
    const beforeText = [...t.before.values()].filter((v): v is string => typeof v === 'string').join('\n');
    const held = markersOf(beforeText);
    for (const [kind, keys] of held) for (const k of keys) inBefores.get(kind)!.add(k);
    const heldPhoneDigits = beforeText.replace(/\D/g, '');
    for (const [f, v] of t.after) {
      if (typeof v !== 'string' || same(v, t.before.get(f))) continue;
      for (const [kind, keys] of markersOf(v)) {
        for (const key of keys) {
          if (held.get(kind)!.has(key)) continue;
          if ((kind === 'link' || kind === 'email') && ownHost(key, own)) continue;
          if (kind === 'phone' && heldPhoneDigits.includes(key)) continue;
          const perTarget = added.get(kind) ?? new Map<number, Set<string>>();
          const set = perTarget.get(t.seq) ?? new Set<string>();
          set.add(key);
          perTarget.set(t.seq, set);
          added.set(kind, perTarget);
        }
      }
    }
  }
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
