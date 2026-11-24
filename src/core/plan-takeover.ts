/**
 * The owner's takeover of a paused plan (`plan-pause.ts`): the way out of a pause.
 *
 * A plan is paused because a mandate it depends on provably ended. Taking it over covers the
 * mandate marks it carries (`covered_*`, compared whole by `planMandate`), so the plan has no
 * mandate member there any more and runs for the owner. The marks themselves stay: they are where
 * the plan came from. A later change by a mandate writes a new mark, which is not covered, and the
 * plan depends on that mandate again.
 *
 * Which marks are covered:
 * - the trigger's always;
 * - the workflow's (for `run_workflow`) when its member is one the pause is about: its end is
 *   proven, or it cannot be told live, or its grant is one this plan was paused for. The last
 *   case is a renewal: the mandate ended, the plan paused, the control plane extended the grant
 *   and the helper signed in again. Without it the plan would run as that mandate once more, on
 *   the workflow's unchanged mark. A live member that changed the workflow after the pause is not
 *   one the pause is about; the plan then runs as that member, and pauses again when it ends.
 *
 * Covering a workflow changes who every other plan on it depends on, so the takeover lists them
 * (`memberChanges`) and releases a paused one that no member holds any more (`alsoReleased`). All
 * of it is shown in the preview and bound by its digest: the takeover refuses anything that moved
 * since. Only paused plans are taken over; a plan that is not paused has nothing to take over.
 */
import { createHash } from 'node:crypto';
import { newCorrelationId } from './audit-log.js';
import {
  PAUSE_PLAN_COLS, pausedForOf, planPauseOn, rolesStillMarked, rowPlanMembers, type PausePlanRow, type PauseRole,
} from './plan-pause.js';
import type { StampEntry } from './plan-run-context.js';
import { stampExpect, stampFromRow } from './plan-stamp.js';
import {
  MANDATE_TAG_PREFIX, OWNER_PRINCIPAL, isMandateTag, planAuthorshipOf, planMandate, principalHasEnded, principalTag,
  type RequestPrincipal,
} from './request-principal.js';
import {
  COVER_FROM_MARKS, TakeoverUnrecorded, commitTakeover, coverAuditTarget, coverEffects, leaseRunning, marksOf, pausedDbAtOf, pausedForIds,
  release, releasedForDigest, scheduleOf, workflowConfirmedAt, workflowCover, workflowOfPreview, workflowRowOf,
  type TakeoverCoreDeps, type TakeoverMemberChange, type TakeoverSchedule, type TakeoverWorkflowView, type WorkflowRow,
} from './takeover-core.js';
import type { TriggerStore } from './trigger-store.js';
import type { TriggerRecord } from '../types/index.js';

export type { TakeoverMemberChange, TakeoverPrompts, TakeoverSchedule, TakeoverWorkflowView } from './takeover-core.js';

const isWorkflowRole = (r: PauseRole): boolean => r === 'workflow-created' || r === 'workflow-edited';

/** Whether the preview shows the plan's workflow: it has a mandate mark not yet covered (`workflowOfPreview`). */
const workflowShown = (wf: WorkflowRow | undefined): boolean => wf !== undefined && planMandate(planAuthorshipOf(wf)) !== undefined;

/** The digest's own domain, so a stamp digest (`stampExpect`) never passes for a takeover's. */
export const TAKEOVER_DIGEST_PREFIX = 'lynox:plan-takeover:v1';

/** Why a plan cannot be taken over, before anything is written. */
export type TakeoverRefusal = 'not_available' | 'bulk' | 'nothing_to_take_over' | 'unreadable' | 'running';

export interface TakeoverDeps extends TakeoverCoreDeps {
  readonly triggers: Pick<TriggerStore, 'getById' | 'endWait' | 'setConfirmedAt' | 'getStampConnections'>;
}

/** A member of the plan as the owner is shown it. */
export interface TakeoverMember {
  readonly name: string;
  readonly roles: readonly PauseRole[];
  readonly ended: boolean;
  readonly reason: 'expired' | 'revoked' | null;
}

export interface TakeoverPreview {
  readonly expect: string;
  readonly members: readonly TakeoverMember[];
  /** `owner`, or the tag of the workflow's member, which stays. */
  readonly runsAs: string;
  /** F2 names the member in `from`. */
  readonly workflow: TakeoverWorkflowView | null;
  readonly memberChanges: readonly TakeoverMemberChange[];
  readonly alsoReleased: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly connections: readonly StampEntry[];
  /** Whose connection each of {@link connections} is, by index: the address of the mandate with its grant, null when not known. */
  readonly connectionBy: ReadonlyArray<string | null>;
  readonly schedule: TakeoverSchedule;
  /** The run the plan was due for, when it runs only on "Run now" afterwards; null otherwise. */
  readonly dueAt: string | null;
}

export type TakeoverPreviewResult =
  | { readonly kind: 'preview'; readonly preview: TakeoverPreview }
  | { readonly kind: 'refused'; readonly refusal: TakeoverRefusal }
  | { readonly kind: 'not_found' };

export type TakeoverResult =
  | { readonly kind: 'taken_over'; readonly trigger: TriggerRecord; readonly runsAs: string }
  | { readonly kind: 'refused'; readonly refusal: TakeoverRefusal | 'changed' | 'prompts' | 'unrecorded' }
  | { readonly kind: 'not_found' };

/** Everything the takeover decides, from one synchronous read. */
interface TakeoverPlan {
  readonly trigger: TriggerRecord;
  readonly row: PausePlanRow;
  readonly wf: WorkflowRow | undefined;
  readonly coverWorkflow: boolean;
  readonly runsAs: RequestPrincipal;
  readonly members: readonly TakeoverMember[];
  readonly memberChanges: readonly TakeoverMemberChange[];
  readonly released: readonly TriggerRecord[];
  readonly connections: readonly StampEntry[];
  readonly connectionBy: ReadonlyArray<string | null>;
  readonly schedule: TakeoverSchedule;
  readonly dueAt: string | null;
  readonly coveredMandates: readonly string[];
  readonly expect: string;
}

/**
 * Reads the plan and decides. Synchronous, so a caller in a transaction reads one state. Returns
 * a refusal for a plan that cannot be taken over; throws nothing.
 */
function planOf(deps: TakeoverDeps, id: string): TakeoverPlan | TakeoverRefusal | 'not_found' {
  const db = deps.db;
  const trigger = deps.triggers.getById(id);
  if (trigger === undefined || trigger.id !== id) return 'not_found';
  // A bulk run has no mandate author, and a stamp written here would arm one the bulk switch holds.
  if (trigger.effect.startsWith('bulk_')) return 'bulk';
  if (trigger.paused_at === undefined || trigger.status === 'completed') return 'nothing_to_take_over';
  const row = db.prepare(`SELECT ${PAUSE_PLAN_COLS} FROM triggers WHERE id = ?`).get(id) as PausePlanRow | undefined;
  if (row === undefined) return 'not_found';
  let wf: WorkflowRow | undefined;
  let roles: ReturnType<typeof rowPlanMembers>['roles'];
  try {
    wf = trigger.effect === 'run_workflow' && row.target_workflow_id ? workflowRowOf(db, row.target_workflow_id) : undefined;
    const read = rowPlanMembers(row, () => wf).roles;
    // A workflow with no mandate mark left to take over (none, or every one covered) is not shown
    // (`workflowOfPreview` is null), so no member is said to have created or changed it.
    roles = workflowShown(wf) ? read : (m) => read(m).filter((r) => !isWorkflowRole(r));
  } catch {
    return 'unreadable';
  }
  const now = deps.now?.() ?? new Date();
  if (leaseRunning(db, id, now)) return 'running';

  const isLive = deps.isLive;
  const own = pausedForIds(trigger.paused_for);
  const { wfMark, coverWorkflow, runsAs } = workflowCover(wf === undefined ? undefined : planAuthorshipOf(wf), own, pausedDbAtOf(db, id), isLive);

  // Everyone the owner is shown: who the plan was paused for, as they are now (a renewed grant is
  // live again), every other mandate whose mark the takeover covers, and the member that stays.
  // One entry per access, not per address: the same person under an ended grant and under a live
  // one are two members with their own roles (a role is read per grant, `rolesOn`), so neither
  // takes the other's lines, and the one that stays is the live one.
  const grantKey = (email: string, mandateId: string | undefined): string => `${email}\u0000${mandateId ?? ''}`;
  const seen = new Set<string>();
  const members: TakeoverMember[] = pausedForOf(trigger.paused_for).entries.map((e) => {
    seen.add(grantKey(e.email, e.mandateId));
    const principal = { kind: 'mandate' as const, email: e.email, mandateId: e.mandateId };
    const ended = principalHasEnded(principal, isLive);
    // A login whose workflow read failed pauses for its mandate knowing only its roles on the plan
    // itself (`pauseEndedPlans`), and a pause that knew a workflow role knew it as of the pause.
    // The workflow roles are read here, where the workflow reads — on the same grant only — and
    // added to the pause's, which stay: so F2 says the workflow moves, and a member who changed it
    // after a pause that knew only its creation is said to have changed it.
    // A role the pause recorded on a mark the owner has taken over since is no longer that member's.
    const marked = rolesStillMarked(e.roles, row, wf);
    const kept = workflowShown(wf) ? marked : marked.filter((r) => !isWorkflowRole(r));
    const added = roles(principal).filter((r) => isWorkflowRole(r) && !kept.includes(r));
    return { name: e.email, roles: [...kept, ...added], ended, reason: ended ? e.reason : null };
  });
  const coveredMarks: Array<{ tag: string | undefined; id: string | undefined }> = [
    { tag: trigger.created_by, id: trigger.created_mandate_id }, { tag: trigger.mandate_editor, id: trigger.mandate_editor_id },
    ...(coverWorkflow && wf !== undefined
      ? [{ tag: wf.created_by ?? undefined, id: wf.created_mandate_id ?? undefined }, { tag: wf.mandate_editor ?? undefined, id: wf.mandate_editor_id ?? undefined }]
      : []),
  ];
  const named = (p: Extract<RequestPrincipal, { kind: 'mandate' }>): void => {
    const key = grantKey(p.email, p.mandateId);
    if (seen.has(key)) return;
    // A mark without a grant id (written before marks carried one) names the person, not an
    // access: it adds nobody the list already has under that address, and its roles (read for the
    // id-less mark only, `rolesOn`) go to that member instead of being lost.
    // To the live member under that address when there is one, as the web-ui's T-5 reads it.
    const live = members.findIndex((m) => m.name === p.email && !m.ended);
    const same = p.mandateId === undefined ? (live >= 0 ? live : members.findIndex((m) => m.name === p.email)) : -1;
    if (same >= 0) {
      const had = members[same]!;
      members[same] = { ...had, roles: [...had.roles, ...roles(p).filter((r) => !had.roles.includes(r))] };
      return;
    }
    seen.add(key);
    members.push({ name: p.email, roles: roles(p), ended: principalHasEnded(p, isLive), reason: null });
  };
  const candidates: Array<Extract<RequestPrincipal, { kind: 'mandate' }>> = [];
  for (const m of coveredMarks) {
    if (!isMandateTag(m.tag)) continue;
    candidates.push({ kind: 'mandate', email: m.tag!.slice(MANDATE_TAG_PREFIX.length), ...(m.id ? { mandateId: m.id } : {}) });
  }
  if (runsAs.kind === 'mandate') candidates.push(runsAs);
  // Marks with a grant id first, so the rule for one without holds in either order of the columns.
  for (const p of [...candidates.filter((c) => c.mandateId !== undefined), ...candidates.filter((c) => c.mandateId === undefined)]) named(p);

  // The grant ids the audit row names: every mark the takeover covers, no address.
  const coveredMandates = new Set<string>();
  for (const m of coveredMarks) if (isMandateTag(m.tag) && m.id) coveredMandates.add(m.id);

  let memberChanges: readonly TakeoverMemberChange[] = [];
  let released: readonly TriggerRecord[] = [];
  if (coverWorkflow && wf !== undefined) {
    const effects = coverEffects(deps, wf.id, id, wfMark, now);
    if (effects === 'running') return 'running';
    ({ memberChanges, released } = effects);
  }

  const stamp = deps.triggers.getStampConnections(id);
  const connections = stamp === undefined ? [] : (stampFromRow(stamp.stampConnections, stamp.confirmedAt, workflowConfirmedAt(wf)) ?? []);
  // A stamped connection is the grant's whose plan it was: its address from who the plan was
  // paused for, or from a mark the takeover covers.
  const grantEmail = new Map<string, string>();
  for (const e of pausedForOf(trigger.paused_for).entries) grantEmail.set(e.mandateId, e.email);
  for (const m of coveredMarks) if (isMandateTag(m.tag) && m.id) grantEmail.set(m.id, m.tag!.slice(MANDATE_TAG_PREFIX.length));
  const connectionBy = connections.map((c) => grantEmail.get(c.grant) ?? null);
  const schedule = scheduleOf(trigger, now);
  const dueAt = schedule === 'run_now_only_missed' || schedule === 'run_now_only_partial'
    ? trigger.paused_due_at ?? trigger.next_run_at ?? null : null;
  const expect = createHash('sha256').update(JSON.stringify([
    TAKEOVER_DIGEST_PREFIX,
    stampExpect(trigger, workflowConfirmedAt(wf), connections),
    trigger.status, trigger.next_run_at ?? null, trigger.paused_at ?? null, trigger.paused_for ?? null,
    marksOf(trigger),
    wf === undefined ? null : [wf.id, wf.name, createHash('sha256').update(wf.definition_json).digest('hex'), marksOf(wf)],
    coverWorkflow, principalTag(runsAs),
    memberChanges, releasedForDigest(released),
    schedule, dueAt,
  ])).digest('hex');

  return {
    trigger, row, wf, coverWorkflow, runsAs, members, memberChanges, released, connections, connectionBy, schedule, dueAt,
    coveredMandates: [...coveredMandates].sort(), expect,
  };
}

/**
 * The workflows a takeover would move to the owner, each with the number of its paused plans whose
 * takeover covers the workflow's mark (`coverWorkflow`); a workflow no such plan runs is absent. Read with the same `planOf` the takeover
 * runs, so a page that says "take the plan over and this workflow runs under you" promises no more
 * than the takeover does. Empty while plan pausing is off: there is nothing to take over then.
 */
export function workflowsCoveredByTakeover(deps: TakeoverDeps): Map<string, number> {
  const covered = new Map<string, number>();
  if (!planPauseOn()) return covered;
  const paused = deps.db.prepare(
    `SELECT id FROM triggers WHERE paused_at IS NOT NULL AND effect = 'run_workflow' AND target_workflow_id IS NOT NULL`,
  ).all() as Array<{ id: string }>;
  for (const { id } of paused) {
    const plan = planOf(deps, id);
    if (typeof plan === 'object' && plan.coverWorkflow && plan.wf !== undefined) covered.set(plan.wf.id, (covered.get(plan.wf.id) ?? 0) + 1);
  }
  return covered;
}

/** What the owner is shown before taking the plan over: one read, no await. */
export function takeoverPreview(deps: TakeoverDeps, id: string): TakeoverPreviewResult {
  if (!planPauseOn()) return { kind: 'refused', refusal: 'not_available' };
  const plan = planOf(deps, id);
  if (plan === 'not_found') return { kind: 'not_found' };
  if (typeof plan === 'string') return { kind: 'refused', refusal: plan };
  return {
    kind: 'preview',
    preview: {
      expect: plan.expect,
      members: plan.members,
      runsAs: principalTag(plan.runsAs),
      workflow: workflowOfPreview(plan.wf, plan.coverWorkflow),
      memberChanges: plan.memberChanges,
      alsoReleased: plan.released.map((r) => ({ id: r.id, title: r.title })),
      connections: plan.connections,
      connectionBy: plan.connectionBy,
      schedule: plan.schedule,
      dueAt: plan.dueAt,
    },
  };
}

/**
 * Takes a paused plan over, against the digest the owner was shown (`expect`).
 *
 * 1. The plan's prompts, and those of the plans it releases, are settled and detached in
 *    history.db, before engine.db is written: a different file, so not in the same transaction.
 *    If the transaction then refuses, those plans stay paused with their questions ended; their
 *    wait ended with the pause already, or the wait sweep ends it.
 * 2. One immediate engine.db transaction reads the plan again, refuses when the digest moved, and
 *    writes the cover, the release (lease, pause, status, next run), the owner's new stamp — the
 *    mandate's list of connections is not inherited — and the audit row. A row that cannot be
 *    written rolls all of it back.
 *
 * The next run of the plan and of every plan it releases: `scheduleOf` in `takeover-core.ts`.
 */
export function takeOver(deps: TakeoverDeps, id: string, expect: string): TakeoverResult {
  if (!planPauseOn()) return { kind: 'refused', refusal: 'not_available' };
  return commitTakeover(deps, expect, () => decided(planOf(deps, id)),
    (plan) => [plan.trigger.id, ...plan.released.map((r) => r.id)],
    (plan, now, record): TakeoverResult => {
      const nowS = Math.floor(now.getTime() / 1000);
      deps.db.prepare(`UPDATE triggers SET ${COVER_FROM_MARKS} WHERE id = ?`).run(nowS, id);
      if (plan.coverWorkflow && plan.wf !== undefined) deps.db.prepare(`UPDATE workflows SET ${COVER_FROM_MARKS} WHERE id = ?`).run(nowS, plan.wf.id);
      for (const t of [plan.trigger, ...plan.released]) release(deps, t, now);
      deps.triggers.setConfirmedAt(id, now.toISOString(), principalTag(OWNER_PRINCIPAL));
      record({
        principal: OWNER_PRINCIPAL, action: 'plan.takeover', phase: 'done', correlationId: newCorrelationId(),
        target: coverAuditTarget(`trigger=${id}`, plan.coveredMandates, plan.released),
      });
      const after = deps.triggers.getById(id);
      if (after === undefined) throw new TakeoverUnrecorded('the plan is gone');
      return { kind: 'taken_over', trigger: after, runsAs: principalTag(plan.runsAs) };
    });
}

/** `planOf` as the commit reads it: the plan to write from, or the answer instead. */
function decided(plan: TakeoverPlan | TakeoverRefusal | 'not_found'): { readonly ok: TakeoverPlan } | { readonly stop: TakeoverResult } {
  if (plan === 'not_found') return { stop: { kind: 'not_found' } };
  if (typeof plan === 'string') return { stop: { kind: 'refused', refusal: plan } };
  return { ok: plan };
}
