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
 * - `question-open`: the step's run is not running and its session has a question open, which
 *   cannot be told to be this step's; it may still be answered, and the act still happen;
 * - `approval-expired` / `approval-rejected`: filed for approval and not sent, the entry
 *   expired or was rejected (by `decidedBy`, when the entry says who);
 * - `send-unknown`: filed for approval and approved, and the send may or may not have gone out;
 * - `no-result`: no source says how the step ended.
 */
export type TrailNote = 'awaits-answer' | 'awaits-approval' | 'question-open' | 'approval-expired' | 'approval-rejected' | 'send-unknown' | 'no-result';

/**
 * Every entry has an id that stays the same on every page it appears on: a page reads a run, a
 * step or a filed write whole even where its rows cross the page's edge, so the next page can
 * repeat it, and the view keeps the first.
 */
export interface TrailStep {
  readonly kind: 'step';
  readonly id: string;
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
  readonly id: string;
  readonly action: string;
  readonly target: string | null;
  readonly phase: string;
  readonly at: string;
  readonly person: TrailPerson;
  /** A read on a route the web UI polls by itself (`INTERFACE_POLLS`); the view groups these. */
  readonly auto?: true | undefined;
}

/**
 * The routes the web UI polls by itself, without the person doing anything, by the action
 * `_recordedMandateRead` writes for them (`GET <route template>`). A helper's open tab leaves about
 * 23 reads a minute on them (row 1034), and the owner's view groups them so the person's own steps stay
 * findable. The trail itself keeps every row (D15).
 *
 * Decided here, from the route the engine dispatched, never from a mark the client sends. Listed
 * are only routes without a path parameter, whose answer is the instance's status or counts and no
 * session's content: a route that takes an id (`pending-prompt`) is not listed. Grouping is by
 * route, not by query (the row does not record these queries, and D15 stays as it is), so where the
 * person opens the same route on purpose, that read is grouped too (the Tasks view, the cost history, chat's own check for a running
 * run); opening the group shows it. A poll
 * missing here is shown ungrouped, as before. `audit-trail-interface-polls.test.ts` holds this list
 * against the pollers in the web UI.
 */
export const INTERFACE_POLLS: ReadonlySet<string> = new Set([
  // threads.svelte.ts every 4 s (the nav's live-run marks), StatusBar.svelte every 30 s.
  'GET /api/runs/active',
  // StatusBar.svelte every 30 s.
  'GET /api/providers/status',
  // StatusBar.svelte every 30 s (`days=1`). Also the history views (`days=30`, `days=14`):
  // „faltet auch das selbst geöffnete Fenster; aufklappbar sichtbar; kein Session-Inhalt“
  // (sec-infra, 2026-10-28).
  'GET /api/history/cost/daily',
  // StatusBar.svelte every 30 s (`status=in_progress`). Also the Tasks view:
  // „faltet auch das selbst geöffnete Fenster; aufklappbar sichtbar; kein Session-Inhalt“
  // (sec-infra, 2026-10-28).
  'GET /api/tasks',
]);

/** Whether a row is a read on a route the web UI polls by itself. Writes and steps never are. */
export function isInterfacePoll(row: Pick<TrailRow, 'phase' | 'action'>): boolean {
  return row.phase === 'read' && INTERFACE_POLLS.has(row.action);
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
  readonly id: string;
  /** The run's key; null for a run whose rows carry none, which then has no steps under it. */
  readonly key: string | null;
  readonly trigger: string | null;
  readonly startedBy: 'schedule' | 'hand' | null;
  readonly at: string;
  readonly person: TrailPerson;
  readonly status: TrailStatus | null;
  /**
   * How many write steps the run made: its attempt rows. Not how many wrote; a step's own status
   * says that. Null for a run without a key: its steps cannot be counted, and no number stands in.
   */
  readonly writeSteps: number | null;
  readonly entries: ReadonlyArray<TrailStep | TrailEvent>;
}

export interface TrailBulkRun {
  readonly kind: 'bulk';
  readonly id: string;
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
   * Whether the run has a question open, asked at or after `since`. A question carries its session,
   * not its run, and a run's spawned and batch runs share its session: so only a run that is none of
   * them and has none is given one, and only when no later run of the session began before it.
   */
  questionOfRun(runId: string, since: string): boolean;
  /** Whether the run's session has any question open asked at or after `since`, whoever asked it. */
  questionInSession(runId: string, since: string): boolean;
  /** Whether the plan run with this trail key is the run of its trigger in flight in this process now. */
  planRunRunning(triggerId: string, key: string): boolean;
  /** Whether a bulk run is still open in the ledger, so a `pending` window will be followed by another. */
  bulkRunOpen(runId: string): boolean;
  /** An approval entry's state and who decided it; undefined when there is no such entry. */
  approvalOf(id: string): { readonly status: string; readonly decidedBy: string | null } | undefined;
}

/** The send rows an approval writes (approval-executor.ts): `approval <id>: …`. */
const APPROVAL_SEND = /^approval (\S+): /;
const APPROVAL_SEND_ACTIONS: ReadonlySet<string> = new Set(['mail_send:send', 'mail_reply:reply']);

/** The approval entry a send row belongs to, or undefined for any other row. */
function approvalOfSend(r: TrailRow): string | undefined {
  return APPROVAL_SEND_ACTIONS.has(r.action) && r.target !== null ? APPROVAL_SEND.exec(r.target)?.[1] : undefined;
}

/** The approval entry a step filed for, from its end row (`returned … approval=<id>`), or undefined. */
function approvalOfFiling(r: TrailRow): string | undefined {
  return r.phase === 'returned' ? targetPairs(r.target).get('approval') : undefined;
}

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
  const run = src.runStatus(attempt.run_id);
  if (run === undefined) return { status: null, note: 'no-result' };
  // An open question of this run: it waits, also after a restart swept the run (a parked question
  // outlives the process). A question that expired says nothing about a step.
  if (src.questionOfRun(attempt.run_id, attempt.ts)) return { status: 'running', note: 'awaits-answer' };
  if (run === 'running') return { status: 'running' };
  // Not running, and a question open in its session that may be this step's: not "interrupted",
  // which reads as over, while an answer could still let the act happen.
  if (src.questionInSession(attempt.run_id, attempt.ts)) return { status: null, note: 'question-open' };
  return { status: 'interrupted' };
}

/**
 * The status of a step filed for approval, paired with the entry by its id, never by the run: a run
 * that files four mails has four steps and four sends under one run id.
 *
 * The entry speaks first. A send's end row says `done` or `failed`, and `failed` also stands for a
 * send that may have gone out and for one that is tried again; the entry tells those apart. Its
 * send rows are read only when the entry is gone, and then only a `done` of the latest attempt.
 */
function filedStepStatus(id: string, sendRows: readonly TrailRow[] | undefined, src: TrailSources): Judged {
  const entry = src.approvalOf(id);
  if (entry === undefined) {
    const attempts = (sendRows ?? []).filter((r) => r.phase === 'attempt');
    const latest = attempts[attempts.length - 1];
    const end = latest === undefined ? undefined : sendRows!.find((r) => r.phase !== 'attempt' && r.correlation_id === latest.correlation_id);
    return end?.phase === 'done' ? { status: 'done' } : { status: null, note: 'no-result' };
  }
  switch (entry.status) {
    case 'pending': return { status: 'running', note: 'awaits-approval' };
    case 'approved': case 'executing': return { status: 'running' };
    case 'expired': return { status: 'ended', note: 'approval-expired' };
    // The owner's no, or the helper's: the same no as a tool that asked returning, so `ended`.
    case 'rejected': return { status: 'ended', note: 'approval-rejected', decidedBy: entry.decidedBy };
    case 'done': return { status: 'done' };
    case 'failed': return { status: 'failed' };
    case 'unknown': return { status: null, note: 'send-unknown' };
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
function stepsOf(rows: readonly TrailRow[], src: TrailSources, sends: ReadonlyMap<string, readonly TrailRow[]>, claimed: Set<number>): Array<TrailStep | TrailEvent> {
  const outcomes = new Map<string, TrailRow>();
  for (const r of rows) if (r.phase !== 'attempt' && r.phase !== 'read') outcomes.set(r.correlation_id, r);
  const out: Array<TrailStep | TrailEvent> = [];
  const used = new Set<number>();
  for (const r of rows) {
    if (used.has(r.id) || claimed.has(r.id)) continue;
    if (r.phase === 'attempt') {
      const end = outcomes.get(r.correlation_id);
      if (end !== undefined) used.add(end.id);
      const approval = end === undefined ? undefined : approvalOfFiling(end);
      let judged: Judged;
      if (approval !== undefined) {
        const send = sends.get(approval);
        for (const row of send ?? []) claimed.add(row.id);
        judged = filedStepStatus(approval, send, src);
      } else {
        judged = end !== undefined ? { status: stepOutcomeStatus(end.phase) } : openStepStatus(r, src);
      }
      out.push({
        kind: 'step', id: `step:${r.correlation_id}`, action: r.action, target: r.target, at: r.ts, person: personOf(r), status: judged.status,
        ...(judged.note !== undefined ? { note: judged.note } : {}),
        ...(judged.decidedBy !== undefined ? { decidedBy: judged.decidedBy } : {}),
      });
    } else {
      out.push({
        kind: 'event', id: `event:${String(r.id)}`, action: r.action, target: r.target, phase: r.phase, at: r.ts, person: personOf(r),
        ...(isInterfacePoll(r) ? { auto: true as const } : {}),
      });
    }
  }
  return out;
}

/**
 * The entries of a set of rows, newest first. Pure: everything outside the rows comes from `src`.
 * On a page that is not complete (`readTrailPage`), a run's steps may be cut, so no run counts them.
 * Rows are taken as given; the caller filters to the view's rows (`readTrailPage`).
 */
export function buildTrail(rows: readonly TrailRow[], src: TrailSources, opts: { readonly complete?: boolean } = {}): TrailEntry[] {
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
  const sends = new Map<string, TrailRow[]>();
  for (const r of rows) {
    const id = approvalOfSend(r);
    if (id === undefined) continue;
    (sends.get(id) ?? sends.set(id, []).get(id)!).push(r);
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
    // No end row: running if this very run is its trigger's run in flight. A run without a key
    // cannot be asked for, so no source says.
    else if (key === null) status = null;
    else status = trigger !== null && src.planRunRunning(trigger, key) ? 'running' : 'interrupted';
    // A run without a key is given no rows of its own (`inner` is empty), so it has no steps.
    const steps = stepsOf(inner, src, sends, claimed);
    entries.push({
      order: start.id,
      entry: {
        kind: 'plan', id: key === null ? `plan:c:${start.correlation_id}` : `plan:${key}`, key, trigger, startedBy: started === 'hand' || started === 'schedule' ? started : null,
        at: start.ts, person: personOf(start), status, writeSteps: key === null || opts.complete === false ? null : steps.filter((e) => e.kind === 'step').length, entries: steps,
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
        kind: 'bulk', id: `bulk:${runId}`, runId, action: first.action, host: targetPairs(first.target).get('host') ?? null,
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

const TRAIL_COLUMNS = 'SELECT id, ts, actor_kind, actor_email, actor_display, mandate_id, action, target, phase, correlation_id, run_id, plan_run FROM audit_log';
/** The view's rows: written since the view existed (`trail_form`) and by a person with delegated access. */
const TRAIL_ROWS = "trail_form = ? AND actor_kind = 'mandate'";
/** How often a page reaches out for the rest of its groups; each round can only add rows. */
const COMPLETION_ROUNDS = 6;
/**
 * The most rows a page holds with the rest of its groups. A bulk run that is re-armed for days or a
 * long plan run can hold thousands; past this the page says it is not complete, and stops.
 */
export const TRAIL_PAGE_MAX_ROWS = 5000;

const uniq = (values: ReadonlyArray<string | null | undefined>): string[] =>
  [...new Set(values.filter((v): v is string => v !== null && v !== undefined))];

/**
 * One page of the view's rows, newest first by id, and the cursor to the next one (`before`, the
 * oldest id of a full page; null on the last page).
 *
 * A page is cut by count, and the rows of one entry need not sit together: a plan run's rows are
 * spread over its whole run, a filed write's send comes later. So the page then takes the rest of
 * every group it holds, on either side of its edge: the rows of each plan run (`plan_run`), each
 * bulk run (`run_id`), each step (`correlation_id`), and the send rows and the filing step of each
 * approval entry it names. An entry is then never shown in part. The next page can show it again,
 * whole; the view keeps it once by its id.
 *
 * `complete` is false when a group could not be taken whole: the page reached
 * {@link TRAIL_PAGE_MAX_ROWS}, or the rounds ran out while it still grew. Its entries can then be
 * in part, and the view says so.
 */
export function readTrailPage(db: Database.Database, opts: { limit: number; beforeId?: number | undefined }): { rows: TrailRow[]; before: number | null; complete: boolean } {
  const page = db.prepare(`${TRAIL_COLUMNS} WHERE ${TRAIL_ROWS} AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`)
    .all(TRAIL_FORM, opts.beforeId ?? null, opts.beforeId ?? null, opts.limit) as TrailRow[];
  const before = page.length === opts.limit ? Math.min(...page.map((r) => r.id)) : null;
  const rows = new Map(page.map((r) => [r.id, r] as const));
  const rest = db.prepare(
    `${TRAIL_COLUMNS} WHERE ${TRAIL_ROWS} AND (
        plan_run IN (SELECT value FROM json_each(?))
        OR (action IN ('bulk:apply', 'bulk:undo') AND run_id IN (SELECT value FROM json_each(?)))
        OR correlation_id IN (SELECT value FROM json_each(?))
        OR (action IN ('mail_send:send', 'mail_reply:reply')
            AND EXISTS (SELECT 1 FROM json_each(?) j WHERE substr(target, 1, length('approval ' || j.value || ': ')) = 'approval ' || j.value || ': '))
        OR (action IN ('mail_send:send', 'mail_reply:reply') AND phase = 'returned'
            AND EXISTS (SELECT 1 FROM json_each(?) j WHERE substr(target, -length(' approval=' || j.value)) = ' approval=' || j.value)))
      -- Past the bound, a run's start and end and a bulk run's windows are kept before inner steps,
      -- so what is cut is a step, not the row a status is read from.
      ORDER BY CASE WHEN action IN ('plan:run', 'bulk:apply', 'bulk:undo') THEN 0 ELSE 1 END, id
      LIMIT ?`,
  );
  // Only the mail tools file for approval (mail-send.ts, mail-reply.ts), under these actions, so
  // both approval links are looked up by the (action, run_id) index.
  let complete = false;
  for (let round = 0; round < COMPLETION_ROUNDS; round++) {
    const held = [...rows.values()];
    const filed = uniq(held.map(approvalOfFiling));
    const sent = uniq(held.map(approvalOfSend));
    const found = rest.all(
      TRAIL_FORM,
      JSON.stringify(uniq(held.map((r) => r.plan_run))),
      JSON.stringify(uniq(held.filter((r) => BULK_ACTIONS.has(r.action)).map((r) => r.run_id))),
      JSON.stringify(uniq(held.map((r) => r.correlation_id))),
      JSON.stringify(filed),
      // The filing step's end row carries the id escaped (agent.ts); a send row carries it as is.
      JSON.stringify(sent.map((id) => encodeURIComponent(id))),
      TRAIL_PAGE_MAX_ROWS + 1,
    ) as TrailRow[];
    const held0 = rows.size;
    for (const r of found) rows.set(r.id, r);
    if (rows.size > TRAIL_PAGE_MAX_ROWS || found.length > TRAIL_PAGE_MAX_ROWS) break;
    if (rows.size === held0) { complete = true; break; }
  }
  return { rows: [...rows.values()].sort((a, b) => a.id - b.id), before, complete };
}

/** What {@link trailSources} reads from: the run history's database and three lookups. */
export interface TrailSourceDeps {
  /** run-history.db, or null when the engine runs without one: then no run says anything. */
  readonly historyDb: Database.Database | null;
  /** The trail key of the plan run of a trigger in flight now (worker-loop.ts `runningPlanRun`). */
  readonly runningPlanRun: (triggerId: string) => string | undefined;
  /** A bulk run's phase and halt in the ledger; undefined when the ledger has no such run. */
  readonly bulkState: (runId: string) => { readonly phase: string; readonly haltReason: string | null } | undefined;
  readonly approval: (id: string) => { readonly status: string; readonly decidedBy: string | null } | undefined;
}

/** The engine stores {@link trailSourceDeps} reads, each possibly absent. */
export interface TrailStores {
  readonly historyDb: Database.Database | null;
  readonly worker: { runningPlanRun(taskId: string): string | undefined } | null;
  readonly ledger: { getStatus(runId: string): { readonly phase: string; readonly haltReason: string | null } | null } | null;
  readonly approvals: { get(id: string): { readonly status: string; readonly decidedBy: string | null } | undefined | null } | null;
}

/** The view's sources over the engine's stores, as the owner's route builds them. */
export function trailSourceDeps(stores: TrailStores): TrailSourceDeps {
  return {
    historyDb: stores.historyDb,
    runningPlanRun: (id) => stores.worker?.runningPlanRun(id),
    bulkState: (id) => {
      const status = stores.ledger?.getStatus(id);
      return status ? { phase: status.phase, haltReason: status.haltReason } : undefined;
    },
    approval: (id) => {
      const entry = stores.approvals?.get(id);
      return entry ? { status: entry.status, decidedBy: entry.decidedBy } : undefined;
    },
  };
}

/** A bulk run's phases after which no window follows; a `writing` run with a halt is stopped too (bulk-ledger.ts). */
const BULK_CLOSED: ReadonlySet<string> = new Set(['done', 'aborted', 'undone']);

/** The sources the owner's view reads statuses from, over the engine's stores. */
export function trailSources(deps: TrailSourceDeps): TrailSources {
  const run = deps.historyDb?.prepare('SELECT status FROM runs WHERE id = ?');
  // `created_at` is SQLite's `datetime('now')`, whole seconds; the row's time is an ISO string with
  // milliseconds. Cut to the second first, or a question asked in the same second reads as older.
  // `created_at` of both tables is `datetime('now')`. A run with a parent, or with children, shares
  // its session with them, so a question there cannot be told to be its own.
  const single = deps.historyDb?.prepare(
    `SELECT 1 FROM runs me WHERE me.id = ? AND me.spawn_parent_id IS NULL AND me.batch_parent_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM runs c WHERE c.spawn_parent_id = me.id OR c.batch_parent_id = me.id)`,
  );
  // Open: pending and not yet past its end. A question stays `pending` past `expires_at` until the
  // store's sweep marks it (prompt-store.ts `NOT_EXPIRED`); nobody can answer it then.
  const openSince = `p.status = 'pending' AND julianday(p.expires_at) > julianday('now') AND p.created_at >= strftime('%Y-%m-%d %H:%M:%S', ?)`;
  const ownQuestion = deps.historyDb?.prepare(
    `SELECT 1 FROM pending_prompts p JOIN runs me ON me.id = ? AND p.session_id = me.session_id
      WHERE ${openSince}
        AND NOT EXISTS (SELECT 1 FROM runs later WHERE later.session_id = me.session_id AND later.id <> me.id
                          AND later.spawn_parent_id IS NULL AND later.batch_parent_id IS NULL
                          AND later.rowid > me.rowid AND later.created_at <= p.created_at)
      LIMIT 1`,
  );
  const sessionQuestion = deps.historyDb?.prepare(
    `SELECT 1 FROM pending_prompts p JOIN runs me ON me.id = ? AND p.session_id = me.session_id WHERE ${openSince} LIMIT 1`,
  );
  return {
    runStatus: (runId) => (run?.get(runId) as { status: string } | undefined)?.status,
    questionOfRun: (runId, since) => single?.get(runId) !== undefined && ownQuestion?.get(runId, since) !== undefined,
    questionInSession: (runId, since) => sessionQuestion?.get(runId, since) !== undefined,
    planRunRunning: (triggerId, key) => deps.runningPlanRun(triggerId) === key,
    bulkRunOpen: (runId) => {
      const state = deps.bulkState(runId);
      return state !== undefined && !BULK_CLOSED.has(state.phase) && !(state.phase === 'writing' && state.haltReason !== null);
    },
    approvalOf: deps.approval,
  };
}
