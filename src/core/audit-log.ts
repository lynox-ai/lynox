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
import type { RequestPrincipal } from './request-principal.js';
import { oneLineForLog } from './profile-value-shape.js';
import { maskSecretPatterns } from './secret-store.js';

/**
 * - `attempt` — about to run; written first, and the act does not run without it.
 * - `done` / `refused` / `failed` — a request's outcome, read from its answer: 2xx, another
 *   answer below 500, or a 5xx or none (it broke while being made; a part may have happened).
 * - `returned` / `failed` — a tool call's outcome: it returned a result, or it threw. A
 *   returned call is not called done: the result is the tool's own text, and a tool that
 *   asks before it sends returns one when the answer was no.
 * - `read` — a mandate read through a route (D15): one row, written before the answer, and
 *   the read is not answered without it. A read has no outcome row.
 */
export type AuditPhase = 'attempt' | 'done' | 'refused' | 'returned' | 'failed' | 'read';

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
}

/** Bounds on what a row holds, so a model-chosen value cannot grow the table without limit. */
const ACTION_MAX = 120;
const TARGET_MAX = 400;

export class AuditLog {
  private readonly insert: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(
      `INSERT INTO audit_log (ts, actor_kind, actor_email, actor_display, mandate_id, action, target, phase, correlation_id, run_id, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /** Append one row. Throws when it cannot be written; the caller refuses the act then. */
  record(entry: AuditEntry): void {
    const p = entry.principal;
    this.insert.run(
      new Date().toISOString(),
      p.kind,
      p.kind === 'mandate' ? p.email : null,
      p.kind === 'mandate' ? (p.display ?? null) : null,
      p.kind === 'mandate' ? (p.mandateId ?? null) : null,
      oneLineForLog(entry.action, ACTION_MAX),
      entry.target === undefined ? null : oneLineForLog(entry.target, TARGET_MAX),
      entry.phase,
      entry.correlationId,
      entry.runId ?? null,
      entry.requestId ?? null,
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
 * stays readable: the row records where a write went, and a path is mostly names. A URL
 * that does not parse is named as such rather than echoed.
 */
export function httpTarget(method: string, url: string): string {
  try {
    const u = new URL(url);
    // The host is never masked: where a write went is what the row is for, and a long domain
    // label must not read as a key and vanish from it.
    const path = u.pathname.split('/').map((seg) => (OPAQUE_SEGMENT.test(seg) ? '<key>' : seg)).join('/');
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

/**
 * What a read row names as its target: the request's own path on this instance, plus the query
 * parameters the route declares as naming what it was asked for (`path=`, `threadId=`), each as
 * sent (an empty one too), and no other query value. Ids stay readable, unlike in `httpTarget`:
 * which thread, file or contact was asked for is what the row is for, and these are the
 * instance's own names, not a third party's keys.
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
  const parts = pathname.split('/').map((segment) => segment.split(/%2F/i).map(decodePieces));
  const found = parts.map((sub) => sub.map((pieces) => pieces.map((p) => ('text' in p ? p.text : '\uFFFD')).join('')).join('/')).join('/');
  const masked = mask(found);
  const path = masked !== found
    ? masked.split('/').map(escapeForRow).join('/')
    : parts.map((sub) => sub.map((pieces) => pieces.map((p) => ('text' in p ? escapeForRow(p.text) : p.raw)).join('')).join('%2F')).join('/');
  const query = identifiers.map(([name, value]) => `${name}=${escapeForRow(mask(value))}`).join('&');
  return query === '' ? path : `${path}?${query}`;
}

/** The fixed text a mandate's act gets when its trail cannot be written. */
export const AUDIT_UNAVAILABLE = 'Refused: this act cannot be recorded in the instance\'s log right now, and in this session nothing that writes outside the instance runs unrecorded. Nothing was sent.';
