/**
 * A plan's pause after a mandate it depends on has provably ended.
 *
 * The access gate in `worker-loop.ts` stops a plan of an ended mandate only while that mandate
 * stays ended: once the control plane extends the grant and the helper logs in again, the plan
 * runs as the mandate once more, and nobody asked the owner. A plan paused here stays paused
 * across such an extension, until the owner takes it over.
 *
 * The state is `triggers.paused_at`, never the status value: `paused` is only a word for a filter
 * and for display. A mandate is a member of a plan as the gate reads it (`planMandate`,
 * `planMembers`): one member per side, the trigger's and its workflow's. Only a member whose end
 * is proven pauses: it carries a grant id, `mandate_ends` holds its row, and that row is not live.
 * A member without either is unproven; the gate refuses it as on main and nothing sticks.
 *
 * The whole effect is behind {@link planPauseOn}: off, nothing writes `paused_at`, nothing reads
 * it, and the engine behaves as main does.
 */
import type Database from 'better-sqlite3';
import type { NotificationMessage } from './notification-router.js';
import type { RequestPrincipal } from './request-principal.js';
import { MANDATE_TAG_PREFIX, planMandate, planMembers } from './request-principal.js';
import { processErrorText } from './error-egress.js';

/**
 * On since the owner can take a plan over from the view (641c-2): a pause without a way out would
 * leave plans standing with no explanation, worse than main. Not an environment switch: the
 * release decides it, not the tenant. Two tests hold the switch to its way out: the takeover route
 * is registered (`src/server/plan-pause-http.test.ts`), and the view shows the button at a paused
 * plan (`packages/web-ui/src/lib/components/triggersview-takeover.svelte.test.ts`).
 */
export const PLAN_PAUSE_DEFAULT = true;
let planPause = PLAN_PAUSE_DEFAULT;

export function planPauseOn(): boolean {
  return planPause;
}

/** Test seam: sets the switch and returns the restore. */
export function setPlanPauseForTests(on: boolean): () => void {
  const before = planPause;
  planPause = on;
  return () => { planPause = before; };
}

/** The SQL function `TriggerStore` registers, so the term in `ACCEPTS_SQL` reads the switch. */
export const PLAN_PAUSE_SQL_FN = 'lynox_plan_pause';

/** What a run that did not start because a mandate its plan depends on has ended reads as. */
export const PLAN_ENDED_RESULT = 'This schedule, or the workflow it runs, was set up or changed by someone whose access has ended, so it does not run.';
/** What a run reads as that was stopped part-way because its plan's access ended. */
export const ACCESS_ENDED_RESULT = 'Stopped part-way because the access of someone who set up or changed this plan ended.';
/** The same, for a plan the stop paused. */
export const ACCESS_ENDED_PAUSED_RESULT = `${ACCESS_ENDED_RESULT} The plan is paused until the owner takes it over.`;

/** What a mandate did to a plan; one member can have done more than one. */
export type PauseRole = 'created' | 'edited' | 'workflow-created' | 'workflow-edited';

/** One ended member of a paused plan, as `paused_for` stores it. */
export interface PausedFor {
  readonly mandateId: string;
  readonly email: string;
  readonly reason: 'expired' | 'revoked';
  /** `mandate_ends.ends_at` of the row that proved the end, unix seconds. */
  readonly endsAt: number;
  readonly roles: readonly PauseRole[];
  /** Whether the plan's latest question was closed because a mandate ended. */
  readonly closedPrompt: boolean;
  /** Set by the advance warning before an end. */
  readonly warned?: boolean | undefined;
}

/** A `mandate_ends` row. */
export interface EndRow {
  readonly ends_at: number;
  readonly revoked_at: number | null;
}

export type EndOf = (mandateId: string) => EndRow | undefined;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Whether this member's end is proven at `nowS`: it names a grant, the grant has a row, and the
 * row is not live — the negation of `MandateEnds.isLive` for a member that has a row.
 */
export function provenEnd(member: RequestPrincipal, endOf: EndOf, nowS: number): EndRow | undefined {
  if (member.kind !== 'mandate' || member.mandateId === undefined) return undefined;
  const row = endOf(member.mandateId);
  if (row === undefined) return undefined;
  return row.revoked_at !== null || nowS >= row.ends_at ? row : undefined;
}

/**
 * The members of a plan whose end is proven. One function for every place that decides a pause —
 * the gate, a run stopped part-way, both sweeps and the login listener — so they cannot disagree.
 */
export function planEndedMembers(members: readonly RequestPrincipal[], endOf: EndOf, nowS: number): Array<{ member: Extract<RequestPrincipal, { kind: 'mandate' }>; row: EndRow }> {
  const out: Array<{ member: Extract<RequestPrincipal, { kind: 'mandate' }>; row: EndRow }> = [];
  for (const m of members) {
    if (m.kind !== 'mandate') continue;
    const row = provenEnd(m, endOf, nowS);
    if (row !== undefined && !out.some((o) => o.member.mandateId === m.mandateId)) out.push({ member: m, row });
  }
  return out;
}

/** The columns of a trigger the pause reads. */
export interface PausePlanRow {
  readonly id: string;
  readonly effect: string;
  readonly status: string;
  readonly confirmed_at: string | null;
  readonly created_by: string | null;
  readonly edited_by: string | null;
  readonly created_mandate_id: string | null;
  readonly created_at: string | null;
  readonly mandate_editor: string | null;
  readonly mandate_editor_id: string | null;
  readonly mandate_edited_at: string | null;
  readonly target_workflow_id: string | null;
  readonly paused_at: number | null;
  readonly covered_created_by: string | null;
  readonly covered_created_id: string | null;
  readonly covered_created_at: string | null;
  readonly covered_edited_by: string | null;
  readonly covered_edited_id: string | null;
  readonly covered_edited_at: string | null;
}

/** The covered marks of a side (`plan-takeover.ts`), read with its authorship. */
export const COVER_COLS = 'covered_created_by, covered_created_id, covered_created_at, covered_edited_by, covered_edited_id, covered_edited_at';

export const PAUSE_PLAN_COLS = `id, effect, status, confirmed_at, created_by, edited_by, created_mandate_id, created_at,
  mandate_editor, mandate_editor_id, mandate_edited_at, target_workflow_id, paused_at, ${COVER_COLS}`;

/** A workflow's authorship columns, read by its exact id. */
export interface WorkflowAuthorRow {
  created_by: string | null;
  created_mandate_id: string | null;
  created_at: string | null;
  mandate_editor: string | null;
  mandate_editor_id: string | null;
  mandate_edited_at: string | null;
  covered_created_by: string | null;
  covered_created_id: string | null;
  covered_created_at: string | null;
  covered_edited_by: string | null;
  covered_edited_id: string | null;
  covered_edited_at: string | null;
}

/** A workflow's authorship by its exact id: never the prefix match of `getPipeline`. Throws when it cannot be read. */
export function workflowAuthorOf(db: Database.Database, id: string): WorkflowAuthorRow | undefined {
  return db.prepare(
    `SELECT created_by, created_mandate_id, created_at, mandate_editor, mandate_editor_id, mandate_edited_at, ${COVER_COLS} FROM workflows WHERE id = ?`,
  ).get(id) as WorkflowAuthorRow | undefined;
}

/**
 * Whether consent lets the plan through: the same two terms as `ACCEPTS_SQL`, so an unstamped
 * `run_workflow` the owner set up on a workflow a mandate wrote falls under the pause, and an
 * unstamped proposal of a mandate does not (it does not run anyway).
 */
export function consentLetsThrough(row: Pick<PausePlanRow, 'effect' | 'confirmed_at' | 'created_by' | 'edited_by'>): boolean {
  const unstamped = (row.confirmed_at ?? '') === '';
  if (row.effect === 'run_agent' && unstamped) return false;
  return !(unstamped && (row.edited_by ?? row.created_by ?? '').startsWith(MANDATE_TAG_PREFIX));
}

/** The roles a member has on one side of the plan, from that side's columns. */
function rolesOn(a: WorkflowAuthorRow, member: Extract<RequestPrincipal, { kind: 'mandate' }>, side: 'trigger' | 'workflow'): PauseRole[] {
  const tag = `${MANDATE_TAG_PREFIX}${member.email}`;
  const roles: PauseRole[] = [];
  if (a.created_by === tag && a.created_mandate_id === (member.mandateId ?? null)) roles.push(side === 'trigger' ? 'created' : 'workflow-created');
  if (a.mandate_editor === tag && a.mandate_editor_id === (member.mandateId ?? null)) roles.push(side === 'trigger' ? 'edited' : 'workflow-edited');
  return roles;
}

/** A plan's members, read synchronously from its row and its workflow's row by exact id. */
export interface PlanMembership {
  readonly members: readonly RequestPrincipal[];
  readonly roles: (member: Extract<RequestPrincipal, { kind: 'mandate' }>) => PauseRole[];
}

/**
 * Who the plan's members are, as the gate reads them (`planOfTrigger`): the trigger's mandate,
 * and for `run_workflow` the workflow's, read by its exact id — `target_workflow_id` is normalised
 * to the exact id on write, so this is the row `getPipeline` finds. Throws when the workflow's row
 * cannot be read; a missing row (the link was cleared) has no member.
 */
export function rowPlanMembers(row: PausePlanRow, workflowOf: (id: string) => WorkflowAuthorRow | undefined): PlanMembership {
  const trigger = planMandate(row);
  const wf = row.effect === 'run_workflow' && row.target_workflow_id ? workflowOf(row.target_workflow_id) : undefined;
  const workflow = wf === undefined ? undefined : planMandate(wf);
  const { members } = planMembers(trigger, workflow);
  return {
    members,
    roles: (m) => [...rolesOn(row, m, 'trigger'), ...(wf === undefined ? [] : rolesOn(wf, m, 'workflow'))],
  };
}

/** `paused_for` as stored; a value that is not a list of entries reads as none, with `broken`. */
export function pausedForOf(raw: string | null | undefined): { entries: PausedFor[]; broken: boolean } {
  if (raw === null || raw === undefined || raw === '') return { entries: [], broken: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { entries: [], broken: true };
    const entries: PausedFor[] = [];
    for (const e of parsed as unknown[]) {
      if (e === null || typeof e !== 'object') return { entries: [], broken: true };
      const r = e as Record<string, unknown>;
      if (typeof r['mandateId'] !== 'string' || typeof r['email'] !== 'string' || typeof r['endsAt'] !== 'number'
        || (r['reason'] !== 'expired' && r['reason'] !== 'revoked') || !Array.isArray(r['roles'])) {
        return { entries: [], broken: true };
      }
      entries.push(r as unknown as PausedFor);
    }
    return { entries, broken: false };
  } catch {
    return { entries: [], broken: true };
  }
}

/** The entries for the proven ended members of a plan. */
export function pausedForEntries(
  membership: PlanMembership,
  ended: ReturnType<typeof planEndedMembers>,
  closedPrompt: boolean,
): PausedFor[] {
  return ended.map(({ member, row }) => ({
    mandateId: member.mandateId!,
    email: member.email,
    reason: row.revoked_at !== null ? 'revoked' as const : 'expired' as const,
    endsAt: row.ends_at,
    roles: membership.roles(member),
    closedPrompt,
  }));
}

/**
 * Pauses the plan and records who ended, in one inner transaction: `paused_at` only if it is not
 * set yet (the first pause keeps its time and its due run), with `paused_db_at` beside it in the
 * database's clock, the one the mandate marks are written in (`plan-takeover.ts` compares the two), `pause_noticed_at` cleared with it so
 * a second pause of the same plan is told again, and `paused_for` merged by mandate id, so a second
 * ended member is added rather than skipped. A `paused_for` that cannot be read is replaced and
 * said on stderr: the pause holds either way. Writes nothing that pushes; the worker tick tells the
 * owner. Throws on a failed write, having written nothing; the caller decides per plan.
 *
 * Returns whether the plan was not paused before this call.
 */
export function writePause(db: Database.Database, id: string, entries: readonly PausedFor[], nowS: number = nowSeconds()): boolean {
  return db.transaction((): boolean => {
    const fresh = db.prepare(
      "UPDATE triggers SET paused_at = ?, paused_db_at = unixepoch('now'), paused_due_at = next_run_at, pause_noticed_at = NULL WHERE id = ? AND paused_at IS NULL",
    ).run(nowS, id).changes > 0;
    const stored = db.prepare('SELECT paused_for FROM triggers WHERE id = ?').get(id) as { paused_for: string | null } | undefined;
    if (stored === undefined) return false;
    const { entries: before, broken } = pausedForOf(stored.paused_for);
    if (broken) process.stderr.write(`[lynox] plan ${id}: the record of who ended could not be read and is written again\n`);
    const merged = [...before];
    for (const e of entries) if (!merged.some((m) => m.mandateId === e.mandateId)) merged.push(e);
    if (broken || merged.length !== before.length) {
      db.prepare('UPDATE triggers SET paused_for = ? WHERE id = ?').run(JSON.stringify(merged), id);
    }
    return fresh;
  })();
}

/**
 * What the model reads for a paused plan (`task_list`, `triggerDetailLine`). Not "recreate": a new
 * plan on the same workflow pauses again for as long as the ended mandate is that workflow's member.
 * The takeover is the owner's, at the plan in the view (`plan-takeover.ts`); no tool reaches it.
 */
export const PAUSED_MODEL_TEXT = "paused until the owner takes it over (the helper's access ended or was not renewed in time)";

/** Whether a plan is paused now: the switch is on and the row says so. */
export function isPaused(t: { readonly paused_at?: number | null | undefined }): boolean {
  return planPauseOn() && t.paused_at !== undefined && t.paused_at !== null;
}

/** `paused_at` read fresh from engine.db, not from a record read earlier. */
export function pausedAtNow(db: Database.Database, id: string): number | null {
  const r = db.prepare('SELECT paused_at FROM triggers WHERE id = ?').get(id) as { paused_at: number | null } | undefined;
  return r?.paused_at ?? null;
}

/** What a pause sweep did, for the caller's log and the tests. */
export interface PauseSweepResult {
  readonly paused: string[];
  readonly skipped: string[];
}

export interface PauseSweepDeps {
  readonly db: Database.Database;
  readonly endOf: EndOf;
  /** Whether the plan's latest question was closed because a mandate ended (`closedPrompt`). */
  readonly closedPromptOf?: ((triggerId: string) => boolean) | undefined;
  readonly nowS?: number | undefined;
  /** Only plans with this mandate as a member (the login listener). */
  readonly onlyMandate?: string | undefined;
  /**
   * Ends the open question of a paused plan (`PromptStore.expirePendingForTrigger`), called for
   * every paused plan after the pauses are written — the pause holds when it fails, and the next
   * sweep tries again for as long as the plan is paused. Not inside the login's transaction.
   */
  readonly closeQuestion?: ((triggerId: string) => void) | undefined;
}

/**
 * Pauses every plan with a proven ended member — all of them, not only the due ones: the boot
 * sweep, the five-minute sweep, a revoke, and (with {@link PauseSweepDeps.onlyMandate}) the login
 * that extends an ended grant. Each plan is its own inner transaction under its own `try`: in a
 * sweep, a plan that cannot be read or written is said on stderr with its id and tried again on the
 * next sweep, and the others go on. A workflow whose authorship cannot be read counts as not ended
 * there; the gate refuses its run as a failure, as on main (a one-shot without a retry left ends
 * `failed`).
 *
 * In the login (`onlyMandate`) there is no next sweep: once the extension commits the end is no
 * longer proven, and the plan would run as the helper again. So there a plan that cannot be
 * written throws, and the login fails with it, as when its transaction fails; the next login tries
 * again. A plan whose workflow cannot be read is decided there on the schedule's own marks.
 */
export function pauseEndedPlans(deps: PauseSweepDeps): PauseSweepResult {
  const paused: string[] = [];
  const skipped: string[] = [];
  if (!planPauseOn()) return { paused, skipped };
  const nowS = deps.nowS ?? nowSeconds();
  const db = deps.db;
  // A superset, only a prefilter: a mark without a grant id is unproven and drops out below.
  const candidates = db.prepare(
    `SELECT ${PAUSE_PLAN_COLS} FROM triggers
     WHERE status != 'completed'
       AND (created_mandate_id IS NOT NULL OR mandate_editor_id IS NOT NULL
            OR target_workflow_id IN (SELECT id FROM workflows WHERE created_mandate_id IS NOT NULL OR mandate_editor_id IS NOT NULL))`,
  ).all() as PausePlanRow[];
  for (const row of candidates) {
    if (!consentLetsThrough(row)) continue;
    let membership: PlanMembership;
    try {
      membership = rowPlanMembers(row, (id) => workflowAuthorOf(db, id));
    } catch (err: unknown) {
      if (deps.onlyMandate === undefined) {
        // A sweep tries again on its next run.
        skipped.push(row.id);
        process.stderr.write(`[lynox] plan ${row.id}: who set up its workflow could not be read, not paused: ${processErrorText(err)}\n`);
        continue;
      }
      // The login has no next sweep, and refusing it for one row would lock every helper out. The
      // schedule's own marks are read without the workflow, so a plan this mandate set up or
      // changed still pauses before the extension commits; only a member it has through the
      // workflow alone is not seen. Such a plan does not run while its workflow cannot be read
      // (the gate refuses it before dispatch), and the owner sees it unreadable at the takeover.
      membership = rowPlanMembers(row, () => undefined);
      process.stderr.write(`[lynox] plan ${row.id}: who set up its workflow could not be read, paused on the schedule's own marks only: ${processErrorText(err)}\n`);
    }
    const members = deps.onlyMandate === undefined
      ? membership.members
      : membership.members.filter((m) => m.kind === 'mandate' && m.mandateId === deps.onlyMandate);
    const ended = planEndedMembers(members, deps.endOf, nowS);
    if (ended.length === 0) continue;
    try {
      writePause(db, row.id, pausedForEntries(membership, ended, deps.closedPromptOf?.(row.id) ?? false), nowS);
      paused.push(row.id);
    } catch (err: unknown) {
      if (deps.onlyMandate !== undefined) throw new Error(`plan ${row.id}: pausing it failed, the login is refused: ${processErrorText(err)}`);
      skipped.push(row.id);
      process.stderr.write(`[lynox] plan ${row.id}: pausing it failed, tried again on the next sweep: ${processErrorText(err)}\n`);
    }
  }
  if (deps.closeQuestion !== undefined) {
    for (const { id } of db.prepare('SELECT id FROM triggers WHERE paused_at IS NOT NULL').all() as Array<{ id: string }>) {
      try {
        deps.closeQuestion(id);
      } catch (err: unknown) {
        process.stderr.write(`[lynox] plan ${id}: closing its question failed, tried again on the next sweep: ${processErrorText(err)}\n`);
      }
    }
  }
  return { paused, skipped };
}

/**
 * Pauses one plan if a member's end is proven, as {@link pauseEndedPlans} would: for the gate and
 * for a run stopped part-way. `undefined` when no end is proven — the caller then goes on as main
 * does — or when the row is gone or completed; `true` once the pause is written. Throws when the
 * workflow's authorship or the write fails.
 */
export function pausePlanNow(db: Database.Database, id: string, endOf: EndOf, closedPrompt: boolean, nowS: number = nowSeconds()): boolean | undefined {
  const row = db.prepare(`SELECT ${PAUSE_PLAN_COLS} FROM triggers WHERE id = ?`).get(id) as PausePlanRow | undefined;
  if (row === undefined || row.status === 'completed' || !consentLetsThrough(row)) return undefined;
  const membership = rowPlanMembers(row, (wid) => workflowAuthorOf(db, wid));
  const ended = planEndedMembers(membership.members, endOf, nowS);
  if (ended.length === 0) return undefined;
  writePause(db, id, pausedForEntries(membership, ended, closedPrompt), nowS);
  return true;
}

/** A paused plan the owner has not been told about yet. */
interface PendingNotice {
  id: string;
  title: string;
  paused_for: string | null;
}

/**
 * The owner's notices of paused plans, claimed before they are sent — the order of the consent
 * reminder (`worker-loop.ts`, `markConsentReminded`): read the pending rows, claim each with
 * `pause_noticed_at IS NULL`, and only the claimed ones are grouped and sent. Two processes on one
 * file send one notice; a process that dies between the claim and the send loses it. Called only
 * while a channel is registered, so with none a notice waits instead of being used up.
 *
 * One notice per plan, not per member: a member that ends after the plan was told about is added
 * to `paused_for` and not told again. If that plan was the member's only one, there is no notice
 * about it.
 */
export function claimPauseNotices(db: Database.Database, nowS: number = nowSeconds()): NotificationMessage[] {
  if (!planPauseOn()) return [];
  const pending = db.prepare(
    "SELECT id, title, paused_for FROM triggers WHERE paused_at IS NOT NULL AND pause_noticed_at IS NULL AND status != 'completed'",
  ).all() as PendingNotice[];
  const claim = db.prepare('UPDATE triggers SET pause_noticed_at = ? WHERE id = ? AND pause_noticed_at IS NULL');
  const byMandate = new Map<string, { entry: PausedFor; plans: number }>();
  for (const p of pending) {
    if (claim.run(nowS, p.id).changes === 0) continue;
    for (const entry of pausedForOf(p.paused_for).entries) {
      const seen = byMandate.get(entry.mandateId);
      if (seen === undefined) byMandate.set(entry.mandateId, { entry, plans: 1 });
      else seen.plans += 1;
    }
  }
  return [...byMandate.values()].map(({ entry, plans }) => pauseNotice(entry, plans));
}

/** `YYYY-MM-DD` of a unix-seconds instant, in UTC. */
function dateOf(s: number): string {
  return new Date(s * 1000).toISOString().slice(0, 10);
}

/**
 * The owner's notice for one ended mandate (the approved wording, verbatim). Notices are
 * sent in English, like every other notice of the worker. "Had access until", not "ended": a grant
 * extended before its old end, by someone who has not signed in since, pauses too. "In which they
 * created or changed something" counts a plan through its workflow as well.
 */
export function pauseNotice(entry: PausedFor, count: number): NotificationMessage {
  // Until the advance notice exists, an expiry says that there was none: without it the notice
  // would read as if one had come. A revocation never has one, so it is not said there.
  const noAdvance = ADVANCE_NOTICE_ON ? '' : ' There was no advance notice.';
  const body = (name: string): string => entry.reason === 'revoked'
    ? (count === 1
      ? `${name}'s access was revoked. A plan in which they created or changed something is paused. It runs again only once you take it over.`
      : `${name}'s access was revoked. ${String(count)} plans in which they created or changed something are paused. The plans run again only once you take them over.`)
    : (count === 1
      ? `${name} had access until ${dateOf(entry.endsAt)}. A plan in which they created or changed something is paused. It runs again only once you take it over, even if the access has since been extended.${noAdvance}`
      : `${name} had access until ${dateOf(entry.endsAt)}. ${String(count)} plans in which they created or changed something are paused. The plans run again only once you take them over, even if the access has since been extended.${noAdvance}`);
  return {
    title: count === 1 ? '⏸ A plan is paused' : `⏸ ${String(count)} plans are paused`,
    body: fitName(entry.email, body),
    priority: 'high',
    // The owner's devices only: the notice names a helper and how their access ended, which no
    // other helper is told (the list keeps `paused_who` to the owner too).
    audience: 'owner',
    // A tap opens the paused plans (`sw.js`), where the notice stands in full, name and all.
    data: Object.freeze({ pausedPlans: '1' }),
  };
}

/**
 * Whether the owner is warned before a grant's known end (641c-2b). Off until that warning is
 * built; while it is off, the expiry notice says there was no advance notice.
 */
export const ADVANCE_NOTICE_ON = false;

/**
 * The longest body a push carries: `web-push-channel.ts` cuts there, as `REMINDER_BODY_MAX` says.
 * A cut would take the sentence that says an extension does not end the pause, so the name gives
 * way instead, with "…", and no sentence is cut.
 */
export const PAUSE_NOTICE_BODY_MAX = 240;

function fitName(name: string, body: (name: string) => string): string {
  const full = body(name);
  if (full.length <= PAUSE_NOTICE_BODY_MAX) return full;
  const keep = Math.max(1, name.length - (full.length - PAUSE_NOTICE_BODY_MAX) - 1);
  return body(`${name.slice(0, keep)}…`);
}
