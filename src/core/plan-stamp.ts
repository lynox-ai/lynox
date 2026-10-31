import { createHash } from 'node:crypto';
import type { ApiProfile, ApiStore } from './api-store.js';
import { isMandateConnection } from './api-store.js';
import type { MandateEnds } from './mandate-ends.js';
import type { StampEntry } from './plan-run-context.js';
import { bindingOf, memberConnectionReader } from './profile-secret-view.js';
import { isOwnerPrincipal, planAuthorshipOf, planAuthorshipOfWorkflow, planMandate, planMembers, principalTag, type RequestPrincipal } from './request-principal.js';
import type { RunHistory } from './run-history.js';
import type { TriggerRecord } from '../types/index.js';

/**
 * The connections the owner's stamp of a plan lets that plan's runs use: the ones the mandate the
 * plan acts for made with its own login, as they are when the owner stamps. Stored with the stamp
 * (`triggers.stamp_connections`), and held to it when a run reads it back ({@link stampFromRow}):
 * the list counts only while the trigger carries the very stamp it was written with and, for a
 * workflow schedule, while the workflow carries the confirmation it had then. Whichever write
 * moves either of those — one that exists today or one added later — leaves the list behind.
 */

/** What the stamp column holds. `wf`: the workflow's `confirmedAt` at the stamp, null for a
 *  schedule that runs no workflow. */
interface StoredStamp {
  readonly at: string;
  readonly wf: string | null;
  readonly entries: readonly StampEntry[];
}

/**
 * The mandate's own connections a stamp for `planOf` lists: every profile whose connection that
 * mandate made under the access it has now, while that access lasts, with the grant it was
 * connected under. One without a grant id cannot be told from its successor, so it is not listed.
 */
export function stampEntriesFor(
  planOf: RequestPrincipal,
  apiStore: Pick<ApiStore, 'knownProfiles'>,
  ends: Pick<MandateEnds, 'isLive'> | null,
): StampEntry[] {
  // A mandate whose access has ended lists nothing: its plans do not run, and a preview that
  // named its connections would show the owner a list that cannot be used.
  const mandateId = planOf.kind === 'mandate' ? planOf.mandateId : undefined;
  if (mandateId === undefined || ends === null || !ends.isLive(mandateId)) return [];
  const entries: StampEntry[] = [];
  for (const p of apiStore.knownProfiles()) {
    const grant = p.oauth_grant?.grant_id;
    if (!isMandateConnection(p) || grant === undefined || !memberConnectionReader(p, planOf, 'read', ends)) continue;
    entries.push({ profile: p.id, grant, binding: bindingOf(p) });
  }
  return entries.sort((a, b) => (a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0));
}

/** The profiles behind `entries`, in their order, for what the owner is shown. */
export function stampProfiles(entries: readonly StampEntry[], apiStore: Pick<ApiStore, 'knownProfiles'>): ApiProfile[] {
  const byId = new Map(apiStore.knownProfiles().map((p) => [p.id, p] as const));
  return entries.map((e) => byId.get(e.profile)).filter((p): p is ApiProfile => p !== undefined);
}

/**
 * What the owner's confirm sends back to say "this, as I was shown it": a digest of the list
 * together with the schedule it is stamped onto — which trigger, what it does and for whom, and
 * the workflow confirmation the list goes with. A change to any of them between the preview and
 * the confirm makes the confirm refuse, so a list is never stamped onto an instruction the owner
 * did not see next to it. By content, not by a change time: those are kept to the second.
 */
export function stampExpect(trigger: TriggerRecord, wf: string | null, entries: readonly StampEntry[]): string {
  const subject = [
    trigger.id, trigger.effect, trigger.title, trigger.description, trigger.schedule_cron ?? null,
    watchWithoutBaseline(trigger.watch_config), trigger.pipeline_id ?? null, trigger.pipeline_params ?? null,
    trigger.model_tier ?? null, trigger.created_mandate_id ?? null, trigger.mandate_editor_id ?? null, wf,
  ];
  return createHash('sha256').update(JSON.stringify([subject, entries])).digest('hex');
}

/** A watch's config without `last_hash`, the baseline every run of the watch moves: what the
 *  watch looks at, not what it last saw. Unreadable config is taken as it stands. */
function watchWithoutBaseline(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;
    const { last_hash: _baseline, ...rest } = parsed as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return raw;
  }
}

/** The column value for a stamp written at `at`. */
export function encodeStamp(at: string, wf: string | null, entries: readonly StampEntry[]): string {
  return JSON.stringify({ at, wf, entries } satisfies StoredStamp);
}

/**
 * The list a run may use, read back from the column: null unless the stored value is well formed,
 * was written with the stamp the trigger carries now (`confirmedAt`), and, for a workflow
 * schedule, with the confirmation the workflow carries now (`workflowConfirmedAt`).
 */
export function stampFromRow(raw: string | null, confirmedAt: string | null, workflowConfirmedAt: string | null): readonly StampEntry[] | null {
  if (raw === null || confirmedAt === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const s = parsed as Partial<Record<keyof StoredStamp, unknown>>;
  if (s.at !== confirmedAt || s.wf !== workflowConfirmedAt || !Array.isArray(s.entries)) return null;
  const entries: StampEntry[] = [];
  for (const e of s.entries as unknown[]) {
    if (e === null || typeof e !== 'object') return null;
    const { profile, grant, binding } = e as Record<string, unknown>;
    if (typeof profile !== 'string' || typeof grant !== 'string' || typeof binding !== 'string') return null;
    entries.push({ profile, grant, binding });
  }
  return entries.length > 0 ? entries : null;
}

/**
 * The mandates a trigger's plan depends on (`planMembers`): the schedule's, and for
 * `run_workflow` the workflow's, found the way the run will find it (`getPipeline`) and read
 * by its exact id, with that workflow's confirmation. Never throws: a workflow whose authorship
 * cannot be read gives `unreadable`, and the run does not start.
 */
export async function planOfTrigger(
  task: TriggerRecord,
  runHistory: RunHistory | null,
): Promise<ReturnType<typeof planMembers> & { unreadable: boolean; workflowConfirmedAt: string | null }> {
  const fromTrigger = planMandate(planAuthorshipOf(task));
  const only = (unreadable: boolean): ReturnType<typeof planMembers> & { unreadable: boolean; workflowConfirmedAt: null } => ({ ...planMembers(fromTrigger, undefined), unreadable, workflowConfirmedAt: null });
  if (task.effect !== 'run_workflow' || !task.pipeline_id) return only(false);
  try {
    const { getPipeline } = await import('../tools/builtin/pipeline.js');
    const planned = runHistory ? getPipeline(task.pipeline_id, runHistory) : undefined;
    // No workflow: the run itself reports it missing, and nothing of it runs.
    if (planned === undefined) return only(false);
    const a = runHistory?.getWorkflowAuthorship(planned.id);
    if (a === undefined) return only(true);
    const fromWorkflow = planMandate(planAuthorshipOfWorkflow(a));
    return { ...planMembers(fromTrigger, fromWorkflow), unreadable: false, workflowConfirmedAt: planned.confirmedAt ?? null };
  } catch {
    return only(true);
  }
}

export const FOREIGN_WORKFLOW_SCHEDULE_REFUSAL =
  'Not scheduled: this workflow holds steps another person with delegated access set up or last changed, so it cannot be scheduled for you as it is. '
  + 'To schedule this task yourself, describe in chat what it should do and ask lynox to write a new workflow for it instead of copying or changing this one; '
  + 'a newly written workflow is yours. Otherwise ask the owner to schedule this one.';
export const UNREADABLE_WORKFLOW_SCHEDULE_REFUSAL =
  'Not scheduled: lynox could not read who set up this workflow, so only the owner may schedule it. '
  + 'Ask the owner to schedule it, or describe in chat what it should do and ask lynox to write a new workflow for it; a newly written workflow is yours.';
export const MISSING_WORKFLOW_SCHEDULE_REFUSAL =
  'Not scheduled: lynox found no saved workflow with this id. Check the id against the saved workflows, '
  + 'or describe in chat what the task should do and ask lynox to write a new workflow for it.';

/**
 * Why `principal` may not put a schedule on the workflow `workflowId` (its exact id), or null when
 * it may. A schedule on a workflow ties the mandates of both into one plan, which acts for whichever
 * of the two changed last (`planMembers`): a later change to the workflow by the other mandate moves
 * the schedule's runs to that mandate. Refused here is the tie itself. The owner may schedule any
 * workflow; a mandate its own, the owner's, and one it changed last (its change made it its own). A
 * copy saved through `WorkflowStore.upsertCopy` carries its source's mark and is refused like the
 * source; a workflow saved anew (an import, a capture) carries only its saver's. A workflow whose
 * authorship cannot be read is refused to anyone but the owner.
 */
export function foreignWorkflowScheduleRefusal(principal: RequestPrincipal, workflowId: string, runHistory: RunHistory | null | undefined): string | null {
  if (isOwnerPrincipal(principal)) return null;
  let a: ReturnType<RunHistory['getWorkflowAuthorship']>;
  try {
    a = runHistory?.getWorkflowAuthorship(workflowId);
  } catch {
    a = undefined;
  }
  if (a === undefined) return UNREADABLE_WORKFLOW_SCHEDULE_REFUSAL;
  const mark = planMandate(planAuthorshipOfWorkflow(a));
  if (mark === undefined || principalTag(mark.principal) === principalTag(principal)) return null;
  return FOREIGN_WORKFLOW_SCHEDULE_REFUSAL;
}
