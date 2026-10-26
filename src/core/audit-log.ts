/**
 * The actor trail: who did what through a mandate (PRD customer-granted-operator-access §3.6).
 *
 * One row per step, never changed afterwards (engine.db v22 refuses an UPDATE). A write leaves
 * two rows joined by `correlation_id`: `attempt` before it runs and its outcome after. A row
 * names the actor, the act and its target — never content: no body, no query string, no
 * message text.
 *
 * Write-only by construction. There is no read method here: the trail never reaches the
 * model's context (D7), and the owner's view of it is a separate piece. Tests read the table
 * directly.
 *
 * Fail-closed is the CALLER's rule: `record` throws when the row cannot be written, and every
 * writer for a mandate turns that into a refusal before the act runs.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isOwnerPrincipal, type RequestPrincipal } from './request-principal.js';
import { effectiveWriteMethod } from './outbound-write.js';
import { oneLineForLog } from './profile-value-shape.js';
import { maskSecretPatterns } from './secret-store.js';
import { currentPlanRun } from './plan-run-context.js';

/**
 * - `attempt` — about to run; written first, and the act does not run without it.
 * - `done` / `refused` / `failed` — a request's outcome, read from its answer: 2xx, another
 *   answer below 500, or a 5xx or none (it did not end cleanly; the answer does not tell
 *   whether a part of it happened).
 * - `returned` / `failed` — a tool call's outcome: it returned a result, or it threw. A
 *   returned call is not called done: the result is the tool's own text, and a tool that
 *   asks before it sends returns one when the answer was no.
 * - `read` — a mandate read through a route (D15): one row, written before the answer, and
 *   the read is not answered without it. A read has no outcome row.
 */
export type AuditPhase = 'attempt' | 'done' | 'refused' | 'returned' | 'failed' | 'read';

/**
 * A request's outcome from the status it answered with, `0` for none: `done` for 2xx, `refused`
 * for any other answer below 500, `failed` for a 5xx or no answer. One rule for every writer of
 * request rows, so the same answer reads the same in a mandate's trail and the control plane's.
 */
export function requestOutcomePhase(status: number): 'done' | 'refused' | 'failed' {
  return status >= 200 && status < 300 ? 'done' : status === 0 || status >= 500 ? 'failed' : 'refused';
}

/** Actors that are not a request principal: the control plane on a provisioned instance. */
export type AuditActorKind = 'cp-migration';

export interface AuditEntry {
  readonly principal: RequestPrincipal;
  /** What was done, e.g. `trigger.run`, `trigger.delete`, `http_request:POST`. */
  readonly action: string;
  /** What it was done to: an id, or method host path. Never content. */
  readonly target?: string | undefined;
  readonly phase: AuditPhase;
  readonly correlationId: string;
  readonly runId?: string | undefined;
  readonly requestId?: string | undefined;
  /** Who acted, when the principal does not say it (the migration token acts as the owner). */
  readonly actorKind?: AuditActorKind | undefined;
  /** When the act happened, for a row written later than that (cp-trail.ts). Absent: now. */
  readonly at?: string | undefined;
  /**
   * The plan run the row belongs to, for a row written outside the run's async context (its own
   * end row). Absent: the run this code runs in (`currentPlanRun`), if any.
   */
  readonly planRun?: string | undefined;
}

/**
 * The form of the rows this code writes, in `trail_form`. A row without it was written before the
 * owner's view of the trail existed, and the view does not show it: rows from that time could name
 * a person for reads a plan made after that person's access had ended.
 */
export const TRAIL_FORM = 1;

/** Bounds on what a row holds, so a model-chosen value cannot grow the table without limit. */
const ACTION_MAX = 120;
/** Exported for writers that fit a list into a row (cp-trail.ts). */
export const TARGET_MAX = 400;

export class AuditLog {
  private readonly insert: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(
      `INSERT INTO audit_log (ts, actor_kind, actor_email, actor_display, mandate_id, action, target, phase, correlation_id, run_id, request_id, recorded_at, plan_run, trail_form)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /** Append one row. Throws when it cannot be written; the caller refuses the act then. */
  record(entry: AuditEntry): void {
    const p = entry.principal;
    // `recorded_at` is when the row is written, `ts` when the act happened: the same instant for
    // every row but one written late (cp-trail.ts), which `recorded_at ≠ ts` gives away unless
    // both fall in the same millisecond.
    const recordedAt = new Date().toISOString();
    this.insert.run(
      entry.at ?? recordedAt,
      entry.actorKind ?? p.kind,
      p.kind === 'mandate' ? p.email : null,
      p.kind === 'mandate' ? (p.display ?? null) : null,
      p.kind === 'mandate' ? (p.mandateId ?? null) : null,
      oneLineForLog(entry.action, ACTION_MAX),
      entry.target === undefined ? null : oneLineForLog(entry.target, TARGET_MAX),
      entry.phase,
      entry.correlationId,
      entry.runId ?? null,
      entry.requestId ?? null,
      recordedAt,
      entry.planRun ?? currentPlanRun() ?? null,
      TRAIL_FORM,
    );
  }
}

export function newCorrelationId(): string {
  return randomUUID();
}

/** A path segment that reads as a key rather than a name: long, letters and digits mixed. */
const OPAQUE_SEGMENT = /^(?=[^/]*[0-9])(?=[^/]*[A-Za-z])[^/]{16,}$/;

/**
 * Where an HTTP write goes, as a row may name it: method, host and path. No userinfo, no
 * query, no fragment — those carry tokens and content. The path can carry one too (a
 * webhook URL, `/bot<token>/`), so a segment that reads as a key is replaced, and known
 * secret shapes are masked over the path. A key that is short, or letters only,
 * stays readable: the row records where a write went, and a path is mostly names. A segment
 * that holds an address is replaced whole (`holdsAddress`), and so is the one after a literal
 * `search` segment: a search text is content, a name is not. A search text written any other
 * way into a path is not recognised. A URL that does not parse is named as such rather than
 * echoed.
 */
export function httpTarget(method: string, url: string): string {
  try {
    const u = new URL(url);
    // The host is never masked: where a write went is what the row is for, and a long domain
    // label must not read as a key and vanish from it.
    const segments = u.pathname.split('/');
    const path = segments
      .map((seg, i) => (holdsAddress(textOf(decodePieces(seg))) ? ADDRESS_PLACEHOLDER
        : i > 0 && isSearchSegment(segments[i - 1]!) ? SEARCH_PLACEHOLDER
        : OPAQUE_SEGMENT.test(seg) ? '<key>' : seg))
      .join('/');
    return `${method} ${u.host}${maskSecretPatterns(path, { includeGeneric: true })}`;
  } catch {
    return `${method} <unparsed url>`;
  }
}

/**
 * Characters that would let a target pose as something it is not, escaped wherever the actor's
 * text is written into a row: the escape sign itself, the query and fragment marks, `&` and `=`,
 * and every control, format and line or paragraph separator (bidi overrides among them). A `/`
 * is never escaped: the row's own slashes are written between parts, and in a value it is a
 * slash.
 */
const ROW_SHAPING = /[%?#&=\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const escapeForRow = (s: string): string => s.replace(ROW_SHAPING, (c) => encodeURIComponent(c));

/** A run of the actor's text, undone from its escapes, or an escaped byte that is not UTF-8. */
type Piece = { readonly text: string } | { readonly raw: string };

/** What stands in a row where a path segment or a value held an address. */
export const ADDRESS_PLACEHOLDER = '<address>';

/**
 * Whether a segment's text, escapes undone once, holds an address: an `@`, or a `%40` that a
 * server undoing escapes twice would read as one. The whole segment is replaced then, never only
 * the part before or after the sign, so neither the person nor the domain is left in the row.
 */
function holdsAddress(text: string): boolean {
  return text.includes('@') || /%40/i.test(text);
}

/** What stands in a row where a path segment was a search text. */
export const SEARCH_PLACEHOLDER = '<search>';

/** A literal `search` segment, in any case: the segment after it is taken as a search text. */
const isSearchSegment = (seg: string): boolean => textOf(decodePieces(seg)).toLowerCase() === 'search';

/** A segment's text with its escapes undone; a byte that is not UTF-8 adds nothing. */
const textOf = (pieces: readonly Piece[]): string => pieces.map((p) => ('text' in p ? p.text : '')).join('');

/** Undo every escape. A byte that does not start valid UTF-8 stays a `raw` piece, as sent. */
function decodePieces(s: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const m of s.matchAll(/(?:%[0-9A-Fa-f]{2})+/g)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    const bytes = m[0].match(/%[0-9A-Fa-f]{2}/g)!;
    for (let b = 0; b < bytes.length;) {
      let n = 4;
      for (; n > 0; n--) {
        if (b + n > bytes.length) continue;
        try { out.push({ text: decodeURIComponent(bytes.slice(b, b + n).join('')) }); break; } catch { /* shorter */ }
      }
      if (n === 0) { out.push({ raw: bytes[b]! }); b += 1; } else b += n;
    }
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** A value with each `/`-separated part that holds an address replaced whole. */
const withoutAddresses = (value: string): string =>
  value.split('/').map((part) => (holdsAddress(part) ? ADDRESS_PLACEHOLDER : part)).join('/');

/**
 * What a read row names as its target: the request's own path on this instance, plus the query
 * parameters the route declares as naming what it was asked for (`path=`, `threadId=`), each as
 * sent (an empty one too), and no other query value. Ids stay readable, unlike in `httpTarget`:
 * which thread, file or contact was asked for is what the row is for, and these are the
 * instance's own names, not a third party's keys. An address is the exception: a path segment,
 * or a part of a value between slashes, that holds one is replaced whole (`holdsAddress`).
 *
 * The row is written by the actor it records, so the text is read twice:
 * - to FIND a secret: every escape undone, an encoded slash as a slash, a byte that is not UTF-8
 *   as U+FFFD (a boundary, so a key behind it is still a key). When a known secret shape is
 *   there, the row is that text, masked, then escaped; it no longer tells an encoded slash from
 *   a plain one, which matters less than the key;
 * - to WRITE the row otherwise: every escape undone, then re-escaped where it could shape the
 *   row, so a path cannot pose as a query, a value cannot add a pair, `%2F` and `%252F` stay
 *   apart, and an escaped byte that is not UTF-8 is written as sent.
 * A double-encoded key (`%2573…`) is undone once only, as the handler undoes it.
 */
export function requestPathTarget(pathname: string, identifiers: ReadonlyArray<readonly [string, string]> = []): string {
  const mask = (s: string): string => maskSecretPatterns(s, { includeGeneric: true });
  const parts = pathname.split('/').map((segment) => {
    const sub = segment.split(/%2F/i).map(decodePieces);
    return sub.some((pieces) => holdsAddress(textOf(pieces))) ? [[{ text: ADDRESS_PLACEHOLDER }]] : sub;
  });
  const found = parts.map((sub) => sub.map((pieces) => pieces.map((p) => ('text' in p ? p.text : '\uFFFD')).join('')).join('/')).join('/');
  const masked = mask(found);
  const path = masked !== found
    ? masked.split('/').map(escapeForRow).join('/')
    : parts.map((sub) => sub.map((pieces) => pieces.map((p) => ('text' in p ? escapeForRow(p.text) : p.raw)).join('')).join('%2F')).join('/');
  const query = identifiers.map(([name, value]) => `${name}=${escapeForRow(mask(withoutAddresses(value)))}`).join('&');
  return query === '' ? path : `${path}?${query}`;
}

/**
 * What a read row names as its target when the target is not a URL: an account, a folder, a
 * document id, written as `name=value` pairs in the order given, an absent value left out.
 * Each value is the actor's text, so it is masked for secret shapes and escaped where it could
 * shape the row — a value cannot add a pair or pose as a query. Only identifiers belong here,
 * never content and never a search text.
 */
export function namedTarget(pairs: ReadonlyArray<readonly [string, string | number | undefined]>): string {
  return pairs
    .filter((p): p is readonly [string, string | number] => p[1] !== undefined && p[1] !== '')
    .map(([name, value]) => `${name}=${escapeForRow(maskSecretPatterns(String(value), { includeGeneric: true }))}`)
    .join(' ');
}

/** The fixed text a mandate's act gets when its trail cannot be written. */
export const AUDIT_UNAVAILABLE = 'Refused: this act cannot be recorded in the instance\'s log right now, and in this session nothing that writes outside the instance runs unrecorded. Nothing was sent.';

/** The fixed text a mandate's read gets when its row cannot be written. */
export const AUDIT_UNAVAILABLE_READ = 'Refused: this read cannot be recorded in the instance\'s log right now, and in this session nothing outside the instance is read unrecorded. Nothing was read.';

/** Thrown by an outward-read recorder whose row could not be written: the read must not happen. */
export class OutwardReadUnrecorded extends Error {
  constructor() { super(AUDIT_UNAVAILABLE_READ); this.name = 'OutwardReadUnrecorded'; }
}

/**
 * Records a read outside the instance in the actor trail as a `read` row, for a principal
 * that is not the owner (PRD customer-granted-operator-access §3.9). `null` for the owner,
 * whose reads leave no row. The recorder takes the target — host and path, an action,
 * never content, never a query — and throws `OutwardReadUnrecorded` when the row cannot be
 * written, so the read it stands before does not happen.
 */
export function outwardReadRecorder(
  by: { readonly principal: RequestPrincipal; readonly currentRunId?: string | undefined; readonly toolContext?: { readonly auditLog: AuditLog | null } | undefined },
  action: string,
): ((target: string) => void) | null {
  if (isOwnerPrincipal(by.principal)) return null;
  // Who reads and in which run are fixed now: a session resets `principal` per run.
  const principal = by.principal;
  const runId = by.currentRunId;
  const log = by.toolContext?.auditLog ?? null;
  return (target) => {
    if (log === null) throw new OutwardReadUnrecorded();
    try {
      log.record({ principal, correlationId: newCorrelationId(), action, target, phase: 'read', runId });
    } catch {
      throw new OutwardReadUnrecorded();
    }
  };
}

/**
 * A hop `delegatedRedirects` refused. Its own class so a caller hands the text on as it is:
 * it names the host, and a rewrite keyed on words in the text (`http_request`'s
 * `friendlyBlockMessage`) would read a host such as `session.example` as another reason.
 */
export class DelegatedHopRefused extends Error {
  constructor(message: string) { super(message); this.name = 'DelegatedHopRefused'; }
}

/**
 * The `onRedirect` of a delegated session's call: each hop it follows is a read of its own,
 * recorded as one before it is requested (PRD customer-granted-operator-access §3.9). A hop
 * that a server would act on as a write is not followed under such access — the verb it is
 * sent with, or an override its address or headers carry (`effectiveWriteMethod`, the reading
 * every write gate uses): the session writes only where its write's row points. `undefined`
 * for the owner, whose hops are not recorded.
 */
export function delegatedRedirects(record: ((target: string) => void) | null): ((nextUrl: string, method: string, headers?: Record<string, string>) => void) | undefined {
  if (record === null) return undefined;
  return (nextUrl, method, headers = {}) => {
    const acted = effectiveWriteMethod(method, headers, nextUrl);
    if (acted !== 'GET' && acted !== 'HEAD') {
      throw new DelegatedHopRefused(`Blocked: a redirect a server would act on as a write (${acted ?? 'an override that is not a method'}) is not followed under delegated access. Nothing was sent to ${new URL(nextUrl).hostname}.`);
    }
    record(httpTarget(acted, nextUrl));
  };
}
