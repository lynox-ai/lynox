/**
 * What every takeover by the owner shares: which workflow mark it covers and as whom the work then
 * runs, what that does to the other plans on the workflow, how a paused plan is released, and the
 * commit — one immediate engine.db transaction that reads the state again, refuses when the digest
 * the owner was shown moved, writes, and records the audit row, or rolls all of it back.
 *
 * The plan takeover (`plan-takeover.ts`) is built on it. A rule changed here changes every takeover
 * at once: there is one rule for covering a mark, not one per entry point.
 */
import type Database from 'better-sqlite3';
import type { AuditLog } from './audit-log.js';
import { nextOccurrence } from './cron-parser.js';
import { ACCESS_ENDED_PAUSED_RESULT, ACCESS_ENDED_RESULT, PLAN_ENDED_RESULT, pausedForOf } from './plan-pause.js';
import {
  OWNER_PRINCIPAL, planAuthorshipOf, planMandate, planMembers, principalHasEnded, principalTag,
  type PlanAuthorship, type PlanMandate, type RequestPrincipal,
} from './request-principal.js';
import type { TriggerStore } from './trigger-store.js';
import type { TriggerRecord } from '../types/index.js';

/** What happens to a released plan's next run. */
export type TakeoverSchedule = 'kept' | 'next_cron' | 'run_now_only_missed' | 'run_now_only_partial';

/** The prompts of a plan, in history.db: settled and detached before a takeover writes. */
export interface TakeoverPrompts {
  expirePendingForTrigger(triggerId: string, reason: 'plan_taken_over'): number;
  getAnsweredForTrigger(triggerId: string): { readonly id: string } | undefined;
  releaseTrigger(promptId: string): boolean;
}

/** What the shared steps read and write. */
export interface TakeoverCoreDeps {
  /** engine.db: triggers, workflows and the audit log are in this one file. */
  readonly db: Database.Database;
  readonly triggers: Pick<TriggerStore, 'getById' | 'endWait'>;
  /** `MandateEnds.isLive`. */
  readonly isLive: (mandateId: string) => boolean;
  readonly audit: AuditLog | null;
  readonly prompts: TakeoverPrompts | null;
  readonly now?: (() => Date) | undefined;
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

/** Sets every `covered_*` column of a row from its marks, and `covered_at` to the bound value. */
export const COVER_FROM_MARKS = `covered_created_by = created_by, covered_created_id = created_mandate_id, covered_created_at = created_at,
  covered_edited_by = mandate_editor, covered_edited_id = mandate_editor_id, covered_edited_at = mandate_edited_at, covered_at = ?`;

/**
 * Whether a member still holds a plan in the sense of the pause: its end is proven or it cannot
 * be told live (`principalHasEnded`), or it is one of the grants the plan was paused for and its
 * mark is older than the pause. The rule that decides the workflow's cover and the one that
 * decides a release are this one function.
 *
 * The mark's age matters only for a member that is live: a grant renewed after the pause. Its
 * mark from before the pause is what the pause was about; a mark it made after the pause is a
 * change the owner was not shown, so it is not covered, and the plan runs as that member (and
 * pauses again when it ends). Both times are the database's clock: the mark's `datetime('now')`
 * and the pause's `paused_db_at`. A mark in the same second as the pause counts as after it, the
 * side where the plan stays with the mandate. A member whose end is proven is covered whatever
 * its mark's age: left uncovered, the plan would run as an ended mandate and pause again, and the
 * owner could never take it over.
 */
export function holds(mark: PlanMandate, pausedFor: ReadonlySet<string>, pausedDbAt: number | null, isLive: (id: string) => boolean): boolean {
  const member = mark.principal;
  if (principalHasEnded(member, isLive)) return true;
  if (member.mandateId === undefined || !pausedFor.has(member.mandateId)) return false;
  return pausedDbAt !== null && Math.floor(mark.at / 1000) < pausedDbAt;
}

/** `paused_db_at`, the pause in the database's clock; null when the row has none. */
export function pausedDbAtOf(db: Database.Database, id: string): number | null {
  const r = db.prepare('SELECT paused_db_at FROM triggers WHERE id = ?').get(id) as { paused_db_at: number | null } | undefined;
  return r?.paused_db_at ?? null;
}

/** The grant ids a plan was paused for. */
export function pausedForIds(raw: string | undefined): Set<string> {
  return new Set(pausedForOf(raw).entries.map((e) => e.mandateId));
}

/** Whether a run of the plan still holds its lease at `now`. */
export function leaseRunning(db: Database.Database, id: string, now: Date): boolean {
  const lease = db.prepare('SELECT lease_until FROM triggers WHERE id = ?').get(id) as { lease_until: string | null } | undefined;
  return lease !== undefined && lease.lease_until !== null && lease.lease_until > now.toISOString();
}

/** The workflow's mark the takeover reads, whether it covers it, and as whom the work runs then. */
export interface WorkflowCover {
  readonly wfMark: PlanMandate | undefined;
  readonly coverWorkflow: boolean;
  readonly runsAs: RequestPrincipal;
}

/**
 * Decides the workflow's cover. The mark read is the one `planMandate` picks (the editor's before
 * the creator's); it is covered when {@link holds} says so, and then every mark of the workflow is
 * covered at once (`COVER_FROM_MARKS`), on purpose: covering only an ended editor would hand the
 * work to a live creator who was no member before. Without a mark, or covered, the work runs as
 * the owner; else as the mark's member, which stays.
 */
export function workflowCover(wf: PlanAuthorship | undefined, pausedFor: ReadonlySet<string>, pausedDbAt: number | null, isLive: (id: string) => boolean): WorkflowCover {
  const wfMark: PlanMandate | undefined = wf === undefined ? undefined : planMandate(wf);
  const coverWorkflow = wfMark !== undefined && holds(wfMark, pausedFor, pausedDbAt, isLive);
  const runsAs: RequestPrincipal = wfMark === undefined || coverWorkflow ? OWNER_PRINCIPAL : wfMark.principal;
  return { wfMark, coverWorkflow, runsAs };
}

function memberKey(p: RequestPrincipal): string {
  return p.kind === 'mandate' ? `${p.email}\u0000${p.mandateId ?? ''}` : p.kind;
}

/**
 * What covering the workflow `wfId` does to its other plans (every one but `exceptId` that is not
 * completed): each whose members change, and the paused ones it releases — those no member holds
 * any more, since after the cover a plan's only member is the mandate of its own schedule, if any.
 * `running` when such a plan's run still holds its lease: the release would end it as stopped.
 */
export function coverEffects(
  deps: Pick<TakeoverCoreDeps, 'db' | 'triggers' | 'isLive'>, wfId: string, exceptId: string | null, wfMark: PlanMandate | undefined, now: Date,
): { readonly memberChanges: TakeoverMemberChange[]; readonly released: TriggerRecord[] } | 'running' {
  const db = deps.db;
  const memberChanges: TakeoverMemberChange[] = [];
  const released: TriggerRecord[] = [];
  const others = db.prepare("SELECT id FROM triggers WHERE target_workflow_id = ? AND id != ? AND status != 'completed' ORDER BY id")
    .all(wfId, exceptId ?? '') as Array<{ id: string }>;
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
    if (paused && !(mark !== undefined && holds(mark, pausedForIds(other.paused_for), pausedDbAtOf(db, other.id), deps.isLive))) {
      // Released with the same steps as the plan taken over, its lease among them: a run of it
      // still under way would end as stopped over the release.
      if (leaseRunning(db, other.id, now)) return 'running';
      released.push(other);
    }
  }
  return { memberChanges, released };
}

/** What the takeover does to the next run (see the docblock of `takeOver` in `plan-takeover.ts`). */
export function scheduleOf(t: TriggerRecord, now: Date): TakeoverSchedule {
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

/** Settles a plan's open question and detaches an answered one, so no answer from the mandate's time reaches the owner's first run. */
export function clearPrompts(prompts: TakeoverPrompts, id: string): void {
  prompts.expirePendingForTrigger(id, 'plan_taken_over');
  // Bounded: every release detaches one row, and a row that does not detach ends the loop.
  for (let i = 0; i < 100; i++) {
    const answered = prompts.getAnsweredForTrigger(id);
    if (answered === undefined || !prompts.releaseTrigger(answered.id)) return;
  }
}

/** The writes that make a paused plan run again: lease, pause, status, schedule. Inside the caller's transaction. */
export function release(deps: Pick<TakeoverCoreDeps, 'db' | 'triggers'>, t: TriggerRecord, now: Date): void {
  const db = deps.db;
  // A lapsed lease of a run that died before the pause would make the next claim read
  // `interrupted`; it is cleared, and with it that run's interruption, which nobody will record.
  db.prepare('UPDATE triggers SET lease_holder = NULL, lease_until = NULL, lease_since = NULL WHERE id = ? AND (lease_until IS NULL OR lease_until <= ?)')
    .run(t.id, now.toISOString());
  db.prepare('UPDATE triggers SET paused_at = NULL, paused_db_at = NULL, paused_for = NULL WHERE id = ?').run(t.id);
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

/** The audit row or a read-back failed inside the transaction: everything is rolled back. */
export class TakeoverUnrecorded extends Error {}

/** A refusal of the commit itself, after the decision allowed the takeover. */
export type CommitRefusal = { readonly kind: 'refused'; readonly refusal: 'changed' | 'prompts' | 'unrecorded' };

/** A decision: the state to write from, or what to answer instead. */
export type Decided<P, E> = { readonly ok: P } | { readonly stop: E };

/**
 * The commit every takeover shares, against the digest the owner was shown (`expect`):
 *
 * 1. `decide` reads the state; a stop answers at once, a moved digest is `changed`. Without an
 *    audit log nothing can be recorded (`unrecorded`); without the prompts nothing can be settled
 *    (`prompts`).
 * 2. The prompts of every plan `promptsOf` names are settled and detached in history.db, before
 *    engine.db is written: a different file, so not in the same transaction. If the transaction
 *    then refuses, those plans stay paused with their questions ended.
 * 3. One immediate engine.db transaction decides again, refuses when the digest moved, and runs
 *    `write`, which records the audit row through `record`. A row that cannot be written — or a
 *    `TakeoverUnrecorded` thrown by `write` — rolls all of it back.
 */
export function commitTakeover<P extends { readonly expect: string }, E, R>(
  deps: TakeoverCoreDeps,
  expect: string,
  decide: () => Decided<P, E>,
  promptsOf: (state: P) => readonly string[],
  write: (state: P, now: Date, record: (entry: Parameters<AuditLog['record']>[0]) => void) => R,
): R | E | CommitRefusal {
  const first = decide();
  if ('stop' in first) return first.stop;
  if (first.ok.expect !== expect) return { kind: 'refused', refusal: 'changed' };
  if (deps.audit === null) return { kind: 'refused', refusal: 'unrecorded' };
  if (deps.prompts === null) return { kind: 'refused', refusal: 'prompts' };
  const prompts = deps.prompts;
  try {
    for (const id of promptsOf(first.ok)) clearPrompts(prompts, id);
  } catch {
    return { kind: 'refused', refusal: 'prompts' };
  }
  const audit = deps.audit;
  const record = (entry: Parameters<AuditLog['record']>[0]): void => {
    try {
      audit.record(entry);
    } catch (err: unknown) {
      throw new TakeoverUnrecorded(err instanceof Error ? err.message : String(err));
    }
  };
  try {
    return deps.db.transaction((): R | E | CommitRefusal => {
      const again = decide();
      if ('stop' in again) return again.stop;
      if (again.ok.expect !== expect) return { kind: 'refused', refusal: 'changed' };
      const now = deps.now?.() ?? new Date();
      return write(again.ok, now, record);
    }).immediate();
  } catch (err: unknown) {
    if (err instanceof TakeoverUnrecorded) return { kind: 'refused', refusal: 'unrecorded' };
    throw err;
  }
}
