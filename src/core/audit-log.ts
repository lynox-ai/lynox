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
 * - `done` / `refused` — a request's outcome, read from its answer (2xx or not).
 * - `returned` / `failed` — a tool call's outcome: it returned a result, or it threw. A
 *   returned call is not called done: the result is the tool's own text, and a tool that
 *   asks before it sends returns one when the answer was no.
 */
export type AuditPhase = 'attempt' | 'done' | 'refused' | 'returned' | 'failed';

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

/** The fixed text a mandate's act gets when its trail cannot be written. */
export const AUDIT_UNAVAILABLE = 'Refused: this act cannot be recorded in the instance\'s log right now, and in this session nothing that writes outside the instance runs unrecorded. Nothing was sent.';
