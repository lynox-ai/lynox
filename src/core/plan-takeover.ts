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
import type Database from 'better-sqlite3';
import type { AuditLog } from './audit-log.js';
import { newCorrelationId } from './audit-log.js';
import { nextOccurrence } from './cron-parser.js';
import {
  ACCESS_ENDED_PAUSED_RESULT, ACCESS_ENDED_RESULT, PAUSE_PLAN_COLS, PLAN_ENDED_RESULT, pausedForOf, planPauseOn,
  rowPlanMembers, workflowAuthorOf, type PausePlanRow, type PauseRole, type WorkflowAuthorRow,
} from './plan-pause.js';
import type { StampEntry } from './plan-run-context.js';
import { stampExpect, stampFromRow } from './plan-stamp.js';
import {
  OWNER_PRINCIPAL, planAuthorshipOf, planMandate, planMembers, principalHasEnded, principalTag,
  type PlanMandate, type RequestPrincipal,
} from './request-principal.js';
import type { TriggerStore } from './trigger-store.js';
import type { TriggerRecord } from '../types/index.js';

/** The digest's own domain, so a stamp digest (`stampExpect`) never passes for a takeover's. */
export const TAKEOVER_DIGEST_PREFIX = 'lynox:plan-takeover:v1';

/** Why a plan cannot be taken over, before anything is written. */
export type TakeoverRefusal = 'not_available' | 'bulk' | 'nothing_to_take_over' | 'unreadable' | 'running';

/** What happens to the plan's next run once it is taken over. */
export type TakeoverSchedule = 'kept' | 'next_cron' | 'run_now_only_missed' | 'run_now_only_partial';

/** The prompts of a plan, in history.db: settled and detached before the takeover writes. */
export interface TakeoverPrompts {
  expirePendingForTrigger(triggerId: string): number;
  getAnsweredForTrigger(triggerId: string): { readonly id: string } | undefined;
  releaseTrigger(promptId: string): boolean;
}

export interface TakeoverDeps {
  /** engine.db: triggers, workflows and the audit log are in this one file. */
  readonly db: Database.Database;
  readonly triggers: Pick<TriggerStore, 'getById' | 'endWait' | 'setConfirmedAt' | 'getStampConnections'>;
  /** `MandateEnds.isLive`. */
  readonly isLive: (mandateId: string) => boolean;
  readonly audit: AuditLog | null;
  readonly prompts: TakeoverPrompts | null;
  readonly now?: (() => Date) | undefined;
}

/** A member of the plan as the owner is shown it. */
export interface TakeoverMember {
  readonly name: string;
  readonly roles: readonly PauseRole[];
  readonly ended: boolean;
  readonly reason: 'expired' | 'revoked' | null;
}

/** Another plan on the workflow whose members the takeover changes. */
export interface TakeoverMemberChange {
  readonly id: string;
  readonly title: string;
  /** The tag of the member the plan acts for, before and after; null for the owner. */
  readonly before: string | null;
  readonly after: string | null;
  /** A plan that is not paused and will not run again by itself (a stopped or failed one-shot). */
  readonly runsNoMore: boolean;
}

export interface TakeoverPreview {
  readonly expect: string;
  readonly members: readonly TakeoverMember[];
  /** `owner`, or the tag of the workflow's member, which stays. */
  readonly runsAs: string;
  readonly workflow: { readonly id: string; readonly name: string; readonly takenOver: boolean } | null;
  readonly memberChanges: readonly TakeoverMemberChange[];
  readonly alsoReleased: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly connections: readonly StampEntry[];
  readonly schedule: TakeoverSchedule;
}

export type TakeoverPreviewResult =
  | { readonly kind: 'preview'; readonly preview: TakeoverPreview }
  | { readonly kind: 'refused'; readonly refusal: TakeoverRefusal }
  | { readonly kind: 'not_found' };

export type TakeoverResult =
  | { readonly kind: 'taken_over'; readonly trigger: TriggerRecord; readonly runsAs: string }
  | { readonly kind: 'refused'; readonly refusal: TakeoverRefusal | 'changed' | 'prompts' | 'unrecorded' }
  | { readonly kind: 'not_found' };

/** A workflow row by its exact id, with what the owner is shown of it. */
interface WorkflowRow extends WorkflowAuthorRow {
  readonly id: string;
  readonly name: string;
  readonly definition_json: string;
}

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
  readonly schedule: TakeoverSchedule;
  readonly coveredMandates: readonly string[];
  readonly expect: string;
}

/** The audit row or the read-back failed inside the transaction: everything is rolled back. */
class Unrecorded extends Error {}

function workflowRowOf(db: Database.Database, id: string): WorkflowRow | undefined {
  const a = workflowAuthorOf(db, id);
  if (a === undefined) return undefined;
  const d = db.prepare('SELECT id, name, definition_json FROM workflows WHERE id = ?').get(id) as
    { id: string; name: string; definition_json: string } | undefined;
  return d === undefined ? undefined : { ...a, ...d };
}

/** `definition_json.$.confirmedAt`, the workflow's own stamp; null when it has none or cannot be read. */
function workflowConfirmedAt(wf: WorkflowRow | undefined): string | null {
  if (wf === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(wf.definition_json);
    const at = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['confirmedAt'] : undefined;
    return typeof at === 'string' ? at : null;
  } catch {
    return null;
  }
}

function memberKey(p: RequestPrincipal): string {
  return p.kind === 'mandate' ? `${p.email}\u0000${p.mandateId ?? ''}` : p.kind;
}

/**
 * Whether a member still holds a plan in the sense of the pause: its end is proven or it cannot
 * be told live (`principalHasEnded`), or it is one of the grants the plan was paused for. The rule
 * that decides the workflow's cover and the one that decides a release are this one function.
 */
function holds(member: RequestPrincipal, pausedFor: ReadonlySet<string>, isLive: (id: string) => boolean): boolean {
  if (principalHasEnded(member, isLive)) return true;
  return member.kind === 'mandate' && member.mandateId !== undefined && pausedFor.has(member.mandateId);
}

function pausedForIds(raw: string | undefined): Set<string> {
  return new Set(pausedForOf(raw).entries.map((e) => e.mandateId));
}

/** What the takeover does to the next run (see the docblock of {@link takeOver}). */
function scheduleOf(t: TriggerRecord, now: Date): TakeoverSchedule {
  if (t.schedule_cron) return 'next_cron';
  if (t.source === 'watch' || t.source === 'webhook' || t.source === 'inbox_event') return 'kept';
  if (t.next_run_at !== undefined && Date.parse(t.next_run_at) > now.getTime()) return 'kept';
  const partial = t.last_run_status === 'stopped'
    && (t.last_run_result === ACCESS_ENDED_PAUSED_RESULT || t.last_run_result === ACCESS_ENDED_RESULT);
  return partial ? 'run_now_only_partial' : 'run_now_only_missed';
}

function stopResults(result: string | undefined): boolean {
  return result === ACCESS_ENDED_PAUSED_RESULT || result === ACCESS_ENDED_RESULT || result === PLAN_ENDED_RESULT;
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
    roles = rowPlanMembers(row, () => wf).roles;
  } catch {
    return 'unreadable';
  }
  const lease = db.prepare('SELECT lease_until FROM triggers WHERE id = ?').get(id) as { lease_until: string | null } | undefined;
  const now = deps.now?.() ?? new Date();
  if (lease?.lease_until != null && lease.lease_until > now.toISOString()) return 'running';

  const isLive = deps.isLive;
  const own = pausedForIds(trigger.paused_for);
  const wfMark: PlanMandate | undefined = wf === undefined ? undefined : planMandate(planAuthorshipOf(wf));
  const coverWorkflow = wfMark !== undefined && holds(wfMark.principal, own, isLive);
  const runsAs: RequestPrincipal = wfMark === undefined || coverWorkflow ? OWNER_PRINCIPAL : wfMark.principal;

  const members: TakeoverMember[] = pausedForOf(trigger.paused_for).entries.map((e) => ({
    name: e.email, roles: e.roles, ended: true, reason: e.reason,
  }));
  if (runsAs.kind === 'mandate' && !members.some((m) => m.name === runsAs.email)) {
    members.push({ name: runsAs.email, roles: roles(runsAs), ended: false, reason: null });
  }

  // The grant ids the audit row names: every mark the takeover covers, no address.
  const coveredMandates = new Set<string>();
  for (const m of [trigger.created_mandate_id, trigger.mandate_editor_id]) if (m) coveredMandates.add(m);
  if (coverWorkflow && wf !== undefined) {
    for (const m of [wf.created_mandate_id, wf.mandate_editor_id]) if (m) coveredMandates.add(m);
  }

  const memberChanges: TakeoverMemberChange[] = [];
  const released: TriggerRecord[] = [];
  if (coverWorkflow && wf !== undefined) {
    const others = db.prepare("SELECT id FROM triggers WHERE target_workflow_id = ? AND id != ? AND status != 'completed' ORDER BY id")
      .all(wf.id, id) as Array<{ id: string }>;
    for (const { id: otherId } of others) {
      const other = deps.triggers.getById(otherId);
      if (other === undefined || other.id !== otherId) continue;
      const mark = planMandate(planAuthorshipOf(other));
      const before = planMembers(mark, wfMark);
      const after = planMembers(mark, undefined);
      const keysBefore = new Set(before.members.map(memberKey));
      const keysAfter = new Set(after.members.map(memberKey));
      const same = keysBefore.size === keysAfter.size && [...keysBefore].every((k) => keysAfter.has(k));
      if (same) continue;
      const paused = other.paused_at !== undefined;
      memberChanges.push({
        id: other.id,
        title: other.title,
        before: before.of === undefined ? null : principalTag(before.of),
        after: after.of === undefined ? null : principalTag(after.of),
        runsNoMore: !paused && other.next_run_at === undefined && (other.status === 'stopped' || other.status === 'failed'),
      });
      const otherPausedFor = pausedForIds(other.paused_for);
      if (paused && !after.members.some((m) => holds(m, otherPausedFor, isLive))) released.push(other);
    }
  }

  const stamp = deps.triggers.getStampConnections(id);
  const connections = stamp === undefined ? [] : (stampFromRow(stamp.stampConnections, stamp.confirmedAt, workflowConfirmedAt(wf)) ?? []);
  const schedule = scheduleOf(trigger, now);
  const marks = (a: { created_by?: string | null | undefined; created_mandate_id?: string | null | undefined; created_at?: string | null | undefined; mandate_editor?: string | null | undefined; mandate_editor_id?: string | null | undefined; mandate_edited_at?: string | null | undefined }): unknown[] =>
    [a.created_by ?? null, a.created_mandate_id ?? null, a.created_at ?? null, a.mandate_editor ?? null, a.mandate_editor_id ?? null, a.mandate_edited_at ?? null];
  const expect = createHash('sha256').update(JSON.stringify([
    TAKEOVER_DIGEST_PREFIX,
    stampExpect(trigger, workflowConfirmedAt(wf), connections),
    trigger.status, trigger.next_run_at ?? null, trigger.paused_at ?? null, trigger.paused_for ?? null,
    marks(trigger),
    wf === undefined ? null : [wf.id, wf.name, createHash('sha256').update(wf.definition_json).digest('hex'), marks(wf)],
    coverWorkflow, principalTag(runsAs),
    memberChanges, released.map((r) => [r.id, r.title, r.status, r.next_run_at ?? null, r.paused_for ?? null]),
    schedule,
  ])).digest('hex');

  return {
    trigger, row, wf, coverWorkflow, runsAs, members, memberChanges, released, connections, schedule,
    coveredMandates: [...coveredMandates].sort(), expect,
  };
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
      workflow: plan.wf === undefined || planMandate(planAuthorshipOf(plan.wf)) === undefined
        ? null : { id: plan.wf.id, name: plan.wf.name, takenOver: plan.coverWorkflow },
      memberChanges: plan.memberChanges,
      alsoReleased: plan.released.map((r) => ({ id: r.id, title: r.title })),
      connections: plan.connections,
      schedule: plan.schedule,
    },
  };
}

/** Settles a plan's open question and detaches an answered one, so no answer from the mandate's time reaches the owner's first run. */
function clearPrompts(prompts: TakeoverPrompts, id: string): void {
  prompts.expirePendingForTrigger(id);
  // Bounded: every release detaches one row, and a row that does not detach ends the loop.
  for (let i = 0; i < 100; i++) {
    const answered = prompts.getAnsweredForTrigger(id);
    if (answered === undefined || !prompts.releaseTrigger(answered.id)) return;
  }
}

/** The writes that make a paused plan run again: lease, pause, status, schedule. Inside the caller's transaction. */
function release(deps: TakeoverDeps, t: TriggerRecord, now: Date): void {
  const db = deps.db;
  // A lapsed lease of a run that died before the pause would make the next claim read
  // `interrupted`; it is cleared, and with it that run's interruption, which nobody will record.
  db.prepare('UPDATE triggers SET lease_holder = NULL, lease_until = NULL, lease_since = NULL WHERE id = ? AND (lease_until IS NULL OR lease_until <= ?)')
    .run(t.id, now.toISOString());
  db.prepare('UPDATE triggers SET paused_at = NULL, paused_for = NULL WHERE id = ?').run(t.id);
  if (t.status === 'waiting') deps.triggers.endWait(t.id, 'open');
  else if (t.status === 'stopped' && stopResults(t.last_run_result)) {
    db.prepare("UPDATE triggers SET status = 'open', updated_at = datetime('now') WHERE id = ? AND status = 'stopped'").run(t.id);
  }
  switch (scheduleOf(t, now)) {
    case 'next_cron':
      db.prepare('UPDATE triggers SET next_run_at = ? WHERE id = ?').run(nextOccurrence(t.schedule_cron!, now).toISOString(), t.id);
      break;
    case 'run_now_only_missed':
    case 'run_now_only_partial':
      db.prepare('UPDATE triggers SET next_run_at = NULL WHERE id = ?').run(t.id);
      break;
    case 'kept':
      break;
  }
}

const COVER_FROM_MARKS = `covered_created_by = created_by, covered_created_id = created_mandate_id, covered_created_at = created_at,
  covered_edited_by = mandate_editor, covered_edited_id = mandate_editor_id, covered_edited_at = mandate_edited_at, covered_at = ?`;

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
 * The next run: a cron plan's next occurrence from now, no missed run is made up; a watch, a
 * webhook or an inbox plan keeps its own; a one-shot due later keeps its time, and one whose time
 * passed (or that stopped part-way) runs only on "Run now", never by itself.
 */
export function takeOver(deps: TakeoverDeps, id: string, expect: string): TakeoverResult {
  if (!planPauseOn()) return { kind: 'refused', refusal: 'not_available' };
  const first = planOf(deps, id);
  if (first === 'not_found') return { kind: 'not_found' };
  if (typeof first === 'string') return { kind: 'refused', refusal: first };
  if (first.expect !== expect) return { kind: 'refused', refusal: 'changed' };
  if (deps.audit === null) return { kind: 'refused', refusal: 'unrecorded' };
  if (deps.prompts === null) return { kind: 'refused', refusal: 'prompts' };
  try {
    for (const t of [first.trigger, ...first.released]) clearPrompts(deps.prompts, t.id);
  } catch {
    return { kind: 'refused', refusal: 'prompts' };
  }
  const audit = deps.audit;
  try {
    return deps.db.transaction((): TakeoverResult => {
      const plan = planOf(deps, id);
      if (plan === 'not_found') return { kind: 'not_found' };
      if (typeof plan === 'string') return { kind: 'refused', refusal: plan };
      if (plan.expect !== expect) return { kind: 'refused', refusal: 'changed' };
      const now = deps.now?.() ?? new Date();
      const nowS = Math.floor(now.getTime() / 1000);
      deps.db.prepare(`UPDATE triggers SET ${COVER_FROM_MARKS} WHERE id = ?`).run(nowS, id);
      if (plan.coverWorkflow && plan.wf !== undefined) deps.db.prepare(`UPDATE workflows SET ${COVER_FROM_MARKS} WHERE id = ?`).run(nowS, plan.wf.id);
      for (const t of [plan.trigger, ...plan.released]) release(deps, t, now);
      deps.triggers.setConfirmedAt(id, now.toISOString(), principalTag(OWNER_PRINCIPAL));
      try {
        audit.record({
          principal: OWNER_PRINCIPAL, action: 'plan.takeover', phase: 'done', correlationId: newCorrelationId(),
          target: `trigger=${id}${plan.coveredMandates.length > 0 ? ` mandates=${plan.coveredMandates.join(',')}` : ''}${plan.released.length > 0 ? ` released=${plan.released.map((r) => r.id).join(',')}` : ''}`,
        });
      } catch (err: unknown) {
        throw new Unrecorded(err instanceof Error ? err.message : String(err));
      }
      const after = deps.triggers.getById(id);
      if (after === undefined) throw new Unrecorded('the plan is gone');
      return { kind: 'taken_over', trigger: after, runsAs: principalTag(plan.runsAs) };
    }).immediate();
  } catch (err: unknown) {
    if (err instanceof Unrecorded) return { kind: 'refused', refusal: 'unrecorded' };
    throw err;
  }
}
