/**
 * The owner's view of the actor trail (`audit_log`, see audit-log.ts): the rows a person with
 * delegated access left, read back as entries the owner can follow.
 *
 * Read-only and separate from `AuditLog`, which stays write-only: this module is reached by the
 * owner's route only, never by a tool, so the trail still never reaches a model's context.
 *
 * Three kinds of entry:
 * - a run: a plan's run (its `plan:run` rows and every row keyed to it by `plan_run`), or a bulk
 *   run (its windows, the `bulk:apply` / `bulk:undo` row pairs of one `run_id`);
 * - a step: an `attempt` row and its outcome row, joined by `correlation_id`;
 * - an event: a row that stands alone (a read, an act that has no outcome row by design).
 *
 * A status is read from a source, never from the time that passed: the row pair itself, the run's
 * record in run history, an open question, or the bulk ledger. Where no source says, there is no
 * status rather than a guess.
 *
 * Only rows with `trail_form` are read. A row from before the view existed could name a person for
 * a read a plan made after that person's access had ended.
 */
import type Database from 'better-sqlite3';
import { TRAIL_FORM } from './audit-log.js';

/** One row as the view reads it. */
export interface TrailRow {
  readonly id: number;
  readonly ts: string;
  readonly actor_kind: string;
  readonly actor_email: string | null;
  readonly actor_display: string | null;
  readonly mandate_id: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly phase: string;
  readonly correlation_id: string;
  readonly run_id: string | null;
  readonly plan_run: string | null;
}

/**
 * The seven states an entry can be in. `ended` is not `done`: a run the owner stopped, a run
 * whose access ended, and a tool call that returned a result all end without saying the act
 * happened (a tool that asks before it sends returns one when the answer was no).
 */
export type TrailStatus = 'running' | 'done' | 'halted' | 'ended' | 'refused' | 'failed' | 'interrupted';

/** Who the entry is about, as the row names them; the row, not the mandate, so an ended access still reads. */
export interface TrailPerson {
  readonly email: string | null;
  readonly display: string | null;
  readonly mandateId: string | null;
}

/**
 * What a status alone does not say, for the line under it:
 * - `awaits-answer` / `awaits-approval`: the step waits for a person, a question or an approval;
 * - `unanswered`: the question expired, so the act did not happen;
 * - `approval-expired` / `approval-rejected`: filed for approval and not sent, the entry
 *   expired or was rejected (by `decidedBy`, when the entry says who);
 * - `no-result`: no source says how the step ended.
 */
export type TrailNote = 'awaits-answer' | 'awaits-approval' | 'unanswered' | 'approval-expired' | 'approval-rejected' | 'no-result';

export interface TrailStep {
  readonly kind: 'step';
  readonly action: string;
  readonly target: string | null;
  readonly at: string;
  readonly person: TrailPerson;
  /** Null when no source says: the result was not recorded and nothing tells whether it ran on. */
  readonly status: TrailStatus | null;
  readonly note?: TrailNote | undefined;
  /** Who rejected a filed write, from the approval entry: a principal tag, or null when it does not say. */
  readonly decidedBy?: string | null | undefined;
}

export interface TrailEvent {
  readonly kind: 'event';
  readonly action: string;
  readonly target: string | null;
  readonly phase: string;
  readonly at: string;
  readonly person: TrailPerson;
}

/** Targets a run wrote and failed: summed over its windows, a lower bound when one did not say. */
export interface TrailTargets {
  readonly written: number;
  readonly failed: number;
  /** A window's count is unknown, so the true numbers are these or more. */
  readonly atLeast: boolean;
}

export interface TrailPlanRun {
  readonly kind: 'plan';
  /** The run's key; null for a run whose rows carry none, which then has no steps under it. */
  readonly key: string | null;
  readonly trigger: string | null;
  readonly startedBy: 'schedule' | 'hand' | null;
  readonly at: string;
  readonly person: TrailPerson;
  readonly status: TrailStatus | null;
  /** Null for a run without a key: its steps cannot be counted, and no number stands in. */
  readonly targets: TrailTargets | null;
  readonly entries: ReadonlyArray<TrailStep | TrailEvent>;
}

export interface TrailBulkRun {
  readonly kind: 'bulk';
  readonly runId: string;
  readonly action: string;
  readonly host: string | null;
  readonly at: string;
  readonly person: TrailPerson;
  readonly status: TrailStatus | null;
  /** The last window halted where its approval told it to, with no failed write: it waits for the owner. */
  readonly planned: boolean;
  readonly windows: number;
  readonly targets: TrailTargets;
}

export type TrailEntry = TrailPlanRun | TrailBulkRun | TrailStep | TrailEvent;

/** What the view asks other stores, each a source of a status. */
export interface TrailSources {
  /** `runs.status` of a run in run history; undefined when there is no such run. */
  runStatus(runId: string): string | undefined;
  /**
   * The newest question of the run's session asked at or after `since`: `pending`, `expired`, or
   * undefined when there is none (or it was answered).
   */
  questionOfRun(runId: string, since: string): 'pending' | 'expired' | undefined;
  /** Whether a scheduled task (a plan's trigger) is running in this process now. */
  triggerRunning(triggerId: string): boolean;
  /** Whether a bulk run is still open in the ledger, so a `pending` window will be followed by another. */
  bulkRunOpen(runId: string): boolean;
  /** An approval entry's state and who decided it; undefined when there is no such entry. */
  approvalOf(id: string): { readonly status: string; readonly decidedBy: string | null } | undefined;
}

/** The send rows an approval writes (approval-executor.ts): `approval <id>: …`. */
const APPROVAL_SEND = /^approval (\S+): /;
const APPROVAL_SEND_ACTIONS: ReadonlySet<string> = new Set(['mail_send:send', 'mail_reply:reply']);

const BULK_ACTIONS: ReadonlySet<string> = new Set(['bulk:apply', 'bulk:undo']);

/**
 * The pairs of a target written by `namedTarget`: `name=value` separated by spaces, each value
 * escaped where it could shape the row. An unparsable piece is skipped.
 */
export function targetPairs(target: string | null): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (target === null) return out;
  for (const piece of target.split(' ')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    try { out.set(piece.slice(0, eq), decodeURIComponent(piece.slice(eq + 1))); } catch { /* not a pair */ }
  }
  return out;
}

const personOf = (r: TrailRow): TrailPerson => ({ email: r.actor_email, display: r.actor_display, mandateId: r.mandate_id });

/** A plan run's end, from the `outcome=` of its end row (a run end status, or `unrecorded`). */
function planEndStatus(outcome: string | undefined): TrailStatus {
  switch (outcome) {
    case 'success': return 'done';
    case 'failed': case 'timeout': return 'failed';
    case 'stopped': return 'ended';
    case 'halted': return 'halted';
    // `interrupted`, `unrecorded` (the end is known to have come, not how) and anything else.
    default: return 'interrupted';
  }
}

/** A bulk window's end, from its `outcome=`. `pending` is decided by the caller. */
function bulkEndStatus(outcome: string | undefined): TrailStatus {
  switch (outcome) {
    case 'done': return 'done';
    case 'halted': return 'halted';
    case 'refused': return 'refused';
    case 'stopped': return 'ended';
    case 'aborted': case 'error': return 'failed';
    default: return 'interrupted';
  }
}

/** A step's status from its outcome row's phase. */
function stepOutcomeStatus(phase: string): TrailStatus {
  switch (phase) {
    case 'done': return 'done';
    case 'refused': return 'refused';
    case 'failed': return 'failed';
    // `returned`: the tool returned a result, which is not to say the act happened.
    default: return 'ended';
  }
}

type Judged = { readonly status: TrailStatus | null; readonly note?: TrailNote; readonly decidedBy?: string | null };

/** The status of a step that has only its attempt row, from the sources. */
function openStepStatus(attempt: TrailRow, src: TrailSources): Judged {
  if (attempt.run_id === null) return { status: null, note: 'no-result' };
  const question = src.questionOfRun(attempt.run_id, attempt.ts);
  if (question === 'pending') return { status: 'running', note: 'awaits-answer' };
  if (question === 'expired') return { status: 'ended', note: 'unanswered' };
  const run = src.runStatus(attempt.run_id);
  if (run === undefined) return { status: null, note: 'no-result' };
  return { status: run === 'running' ? 'running' : 'interrupted' };
}

/**
 * The status of a step filed for approval, paired with the entry by its id, never by the run: a run
 * that files four mails has four steps and four sends under one run id.
 */
function filedStepStatus(id: string, send: { attempt?: TrailRow; end?: TrailRow } | undefined, src: TrailSources): Judged {
  if (send?.end !== undefined) return { status: send.end.phase === 'done' ? 'done' : 'failed' };
  const entry = src.approvalOf(id);
  if (entry === undefined) return { status: null, note: 'no-result' };
  switch (entry.status) {
    case 'pending': return { status: 'running', note: 'awaits-approval' };
    case 'approved': case 'executing': return { status: 'running' };
    case 'expired': return { status: 'ended', note: 'approval-expired' };
    // The owner's no, or the helper's: the same no as a tool that asked returning, so `ended`.
    case 'rejected': return { status: 'ended', note: 'approval-rejected', decidedBy: entry.decidedBy };
    case 'done': return { status: 'done' };
    case 'failed': return { status: 'failed' };
    default: return { status: null, note: 'no-result' };
  }
}

/** The counts of a window without its end row: not known, which is not zero. */
const UNKNOWN_COUNTS: ReadonlyMap<string, string> = new Map([['written', 'unread'], ['failed', 'unread']]);

function sumTargets(windows: ReadonlyArray<ReadonlyMap<string, string>>): TrailTargets {
  let written = 0;
  let failed = 0;
  let atLeast = false;
  for (const w of windows) {
    for (const [name, add] of [['written', (n: number) => { written += n; }], ['failed', (n: number) => { failed += n; }]] as const) {
      const text = w.get(name);
      const n = text !== undefined && /^\d+$/.test(text) ? Number(text) : Number.NaN;
      if (Number.isInteger(n)) add(n); else atLeast = true;
    }
  }
  return { written, failed, atLeast };
}

/** Steps and events of a list of rows, pairing each attempt with its outcome by correlation id. */
function stepsOf(rows: readonly TrailRow[], src: TrailSources, sends: ReadonlyMap<string, { attempt?: TrailRow; end?: TrailRow }>, claimed: Set<number>): Array<TrailStep | TrailEvent> {
  const outcomes = new Map<string, TrailRow>();
  for (const r of rows) if (r.phase !== 'attempt' && r.phase !== 'read') outcomes.set(r.correlation_id, r);
  const out: Array<TrailStep | TrailEvent> = [];
  const used = new Set<number>();
  for (const r of rows) {
    if (used.has(r.id) || claimed.has(r.id)) continue;
    if (r.phase === 'attempt') {
      const end = outcomes.get(r.correlation_id);
      if (end !== undefined) used.add(end.id);
      const approval = end?.phase === 'returned' ? targetPairs(end.target).get('approval') : undefined;
      let judged: Judged;
      if (approval !== undefined) {
        const send = sends.get(approval);
        for (const row of [send?.attempt, send?.end]) if (row !== undefined) claimed.add(row.id);
        judged = filedStepStatus(approval, send, src);
      } else {
        judged = end !== undefined ? { status: stepOutcomeStatus(end.phase) } : openStepStatus(r, src);
      }
      out.push({
        kind: 'step', action: r.action, target: r.target, at: r.ts, person: personOf(r), status: judged.status,
        ...(judged.note !== undefined ? { note: judged.note } : {}),
        ...(judged.decidedBy !== undefined ? { decidedBy: judged.decidedBy } : {}),
      });
    } else {
      out.push({ kind: 'event', action: r.action, target: r.target, phase: r.phase, at: r.ts, person: personOf(r) });
    }
  }
  return out;
}

/** Targets of a plan run: its write steps that are done, and those that failed or did not say. */
function planTargets(steps: ReadonlyArray<TrailStep | TrailEvent>): TrailTargets {
  let written = 0;
  let failed = 0;
  let atLeast = false;
  for (const s of steps) {
    if (s.kind !== 'step') continue;
    if (s.status === 'done') written += 1;
    else if (s.status === 'failed') failed += 1;
    else if (s.status === null || s.status === 'running' || s.status === 'interrupted') atLeast = true;
  }
  return { written, failed, atLeast };
}

/**
 * The entries of a set of rows, newest first. Pure: everything outside the rows comes from `src`.
 * Rows are taken as given; the caller filters to the view's rows (`readTrailRows`).
 */
export function buildTrail(rows: readonly TrailRow[], src: TrailSources): TrailEntry[] {
  const byKey = new Map<string, TrailRow[]>();
  const keylessPlan = new Map<string, TrailRow[]>();
  const bulk = new Map<string, TrailRow[]>();
  const loose: TrailRow[] = [];
  for (const r of rows) {
    if (r.plan_run !== null) {
      (byKey.get(r.plan_run) ?? byKey.set(r.plan_run, []).get(r.plan_run)!).push(r);
    } else if (r.action === 'plan:run') {
      (keylessPlan.get(r.correlation_id) ?? keylessPlan.set(r.correlation_id, []).get(r.correlation_id)!).push(r);
    } else if (BULK_ACTIONS.has(r.action) && r.run_id !== null) {
      (bulk.get(r.run_id) ?? bulk.set(r.run_id, []).get(r.run_id)!).push(r);
    } else {
      loose.push(r);
    }
  }
  const entries: Array<{ entry: TrailEntry; order: number }> = [];
  // The send rows an approval wrote, by entry id, so the step that filed it takes them.
  const sends = new Map<string, { attempt?: TrailRow; end?: TrailRow }>();
  for (const r of rows) {
    const m = APPROVAL_SEND_ACTIONS.has(r.action) && r.target !== null ? APPROVAL_SEND.exec(r.target) : null;
    if (m === null) continue;
    const pair = sends.get(m[1]!) ?? {};
    if (r.phase === 'attempt') pair.attempt = r; else pair.end = r;
    sends.set(m[1]!, pair);
  }
  const claimed = new Set<number>();

  const planEntry = (key: string | null, own: readonly TrailRow[], inner: readonly TrailRow[]): void => {
    const start = own.find((r) => r.phase === 'attempt') ?? own[0]!;
    const end = own.find((r) => r.phase !== 'attempt');
    const head = targetPairs(start.target);
    const trigger = head.get('trigger') ?? null;
    const started = head.get('started');
    let status: TrailStatus | null;
    if (end !== undefined) status = planEndStatus(targetPairs(end.target).get('outcome'));
    else status = trigger !== null && src.triggerRunning(trigger) ? 'running' : 'interrupted';
    const steps = key === null ? [] : stepsOf(inner, src, sends, claimed);
    entries.push({
      order: start.id,
      entry: {
        kind: 'plan', key, trigger, startedBy: started === 'hand' || started === 'schedule' ? started : null,
        at: start.ts, person: personOf(start), status, targets: key === null ? null : planTargets(steps), entries: steps,
      },
    });
  };
  for (const [key, group] of byKey) {
    const own = group.filter((r) => r.action === 'plan:run');
    // Rows keyed to a run whose own rows are not in this page: shown as they are, not as a run.
    if (own.length === 0) { loose.push(...group); continue; }
    planEntry(key, own, group.filter((r) => r.action !== 'plan:run'));
  }
  for (const own of keylessPlan.values()) planEntry(null, own, []);

  for (const [runId, group] of bulk) {
    const starts = group.filter((r) => r.phase === 'attempt');
    const ends = new Map(group.filter((r) => r.phase !== 'attempt').map((r) => [r.correlation_id, r] as const));
    const windows = starts.map((s) => ({ start: s, end: ends.get(s.correlation_id) }));
    const last = windows[windows.length - 1];
    const first = group[0]!;
    let status: TrailStatus | null = null;
    let planned = false;
    if (last !== undefined) {
      const pairs = last.end === undefined ? undefined : targetPairs(last.end.target);
      const outcome = pairs?.get('outcome');
      planned = pairs?.get('planned') === 'yes';
      if (last.end === undefined || outcome === 'pending') status = src.bulkRunOpen(runId) ? 'running' : 'interrupted';
      else status = bulkEndStatus(outcome);
    }
    entries.push({
      order: (windows[0]?.start ?? first).id,
      entry: {
        kind: 'bulk', runId, action: first.action, host: targetPairs(first.target).get('host') ?? null,
        at: (windows[0]?.start ?? first).ts, person: personOf(first), status, planned,
        windows: windows.length,
        targets: sumTargets(windows.map((w) => (w.end === undefined ? UNKNOWN_COUNTS : targetPairs(w.end.target)))),
      },
    });
  }

  for (const s of stepsOf(loose, src, sends, claimed)) entries.push({ order: Number.NaN, entry: s });
  // Loose entries take the id of the row they start from, which `stepsOf` does not return:
  // order them by time instead, with the runs, newest first.
  return entries
    .map((e) => e.entry)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** The view's rows: written since the view existed (`trail_form`) and by a person with delegated access. */
export function readTrailRows(db: Database.Database, opts: { limit: number; beforeId?: number | undefined }): TrailRow[] {
  const rows = db.prepare(
    `SELECT id, ts, actor_kind, actor_email, actor_display, mandate_id, action, target, phase, correlation_id, run_id, plan_run
       FROM audit_log
      WHERE trail_form = ? AND actor_kind = 'mandate' AND (? IS NULL OR id < ?)
      ORDER BY id DESC LIMIT ?`,
  ).all(TRAIL_FORM, opts.beforeId ?? null, opts.beforeId ?? null, opts.limit) as TrailRow[];
  return rows.reverse();
}
