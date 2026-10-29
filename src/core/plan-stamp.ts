import { createHash } from 'node:crypto';
import type { ApiProfile, ApiStore } from './api-store.js';
import { isMandateConnection } from './api-store.js';
import type { MandateEnds } from './mandate-ends.js';
import type { StampEntry } from './plan-run-context.js';
import { bindingOf, connectionShown, connectionWaits, memberConnectionReader } from './profile-secret-view.js';
import { planAuthorshipOf, planAuthorshipOfWorkflow, planMandate, planMembers, type RequestPrincipal } from './request-principal.js';
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
 * The schedule a stamp is held to, field by field: which trigger, what it does and for whom, and
 * the workflow confirmation the list goes with. The preview hands the owner exactly this, and
 * {@link stampExpect} digests exactly this, so nothing is stamped that the owner was not shown.
 */
export interface StampSubject {
  readonly id: string;
  readonly effect: string | null;
  /** Which executor a `run_agent` takes: `watch` runs on a page, not on the text. */
  readonly source: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly schedule_cron: string | null;
  readonly watch: string | null;
  readonly pipeline_id: string | null;
  readonly pipeline_params: string | null;
  readonly model_tier: string | null;
  readonly created_mandate_id: string | null;
  readonly mandate_editor_id: string | null;
  readonly wf: string | null;
}

/** The fields of {@link StampSubject} in the order the digest reads them. */
const SUBJECT_ORDER = [
  'id', 'effect', 'source', 'title', 'description', 'schedule_cron', 'watch', 'pipeline_id', 'pipeline_params',
  'model_tier', 'created_mandate_id', 'mandate_editor_id', 'wf',
] as const satisfies readonly (keyof StampSubject)[];

export function stampSubject(trigger: TriggerRecord, wf: string | null): StampSubject {
  return {
    id: trigger.id, effect: trigger.effect ?? null, source: trigger.source ?? null, title: trigger.title, description: trigger.description ?? null,
    schedule_cron: trigger.schedule_cron ?? null, watch: watchWithoutBaseline(trigger.watch_config),
    pipeline_id: trigger.pipeline_id ?? null, pipeline_params: trigger.pipeline_params ?? null,
    model_tier: trigger.model_tier ?? null, created_mandate_id: trigger.created_mandate_id ?? null,
    mandate_editor_id: trigger.mandate_editor_id ?? null, wf,
  };
}

/**
 * What the owner's confirm sends back to say "this, as I was shown it": a digest of the list
 * together with the schedule it is stamped onto ({@link stampSubject}). A change to any of them
 * between the preview and the confirm makes the confirm refuse, so a list is never stamped onto
 * an instruction the owner did not see next to it. By content, not by a change time: those are
 * kept to the second.
 */
export function stampExpect(trigger: TriggerRecord, wf: string | null, entries: readonly StampEntry[]): string {
  const subject = stampSubject(trigger, wf);
  return createHash('sha256').update(JSON.stringify([SUBJECT_ORDER.map((k) => subject[k]), entries])).digest('hex');
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
  if (confirmedAt === null) return null;
  const stored = storedOf(raw);
  if (stored === null || stored.at !== confirmedAt || stored.wf !== workflowConfirmedAt) return null;
  return stored.entries.length > 0 ? stored.entries : null;
}

/** The column read as it was written, whichever stamp it went with; null when it is not well formed. */
function storedOf(raw: string | null): StoredStamp | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const s = parsed as Partial<Record<keyof StoredStamp, unknown>>;
  if (typeof s.at !== 'string' || (s.wf !== null && typeof s.wf !== 'string') || !Array.isArray(s.entries)) return null;
  const entries: StampEntry[] = [];
  for (const e of s.entries as unknown[]) {
    if (e === null || typeof e !== 'object') return null;
    const { profile, grant, binding } = e as Record<string, unknown>;
    if (typeof profile !== 'string' || typeof grant !== 'string' || typeof binding !== 'string') return null;
    entries.push({ profile, grant, binding });
  }
  return { at: s.at, wf: s.wf, entries };
}

/**
 * How one connection of a confirmed plan stands (641 4b (ii-a), B3): `listed` — the stamp lists it
 * and a run may use it; `changed` — the stamp lists it under another grant or destination, or the
 * connection is gone; `waits` — the mandate whose connection it is has no live access; `new` — the
 * mandate connected it since, and the stamp does not list it.
 */
export type StampEntryState = 'listed' | 'changed' | 'waits' | 'new';

/** What the owner's list of a confirmed plan shows: no grant, no binding, no mandate id. */
export interface StampListShown {
  /** The whole list no longer holds: the trigger or its workflow was stamped again since. */
  readonly lapsed: boolean;
  /** The access of the mandate the plan acts for has ended: nothing of it runs, whatever is listed. */
  readonly ended: boolean;
  readonly entries: readonly { readonly provider: string | null; readonly account: string | null; readonly state: StampEntryState }[];
}

/**
 * {@link StampListShown} for a confirmed plan acting for `planOf`: the stored list (`raw`) against
 * what a stamp would list now ({@link stampEntriesFor}, the function a stamp writes with), so a
 * listed entry is exactly one a run may use. Null when there is nothing to show: no entry stored
 * and none new.
 */
export function stampListState(
  raw: string | null,
  confirmedAt: string | null,
  workflowConfirmedAt: string | null,
  planOf: RequestPrincipal,
  apiStore: Pick<ApiStore, 'knownProfiles'>,
  ends: Pick<MandateEnds, 'isLive'> | null,
): StampListShown | null {
  const stored = storedOf(raw);
  const storedEntries = stored?.entries ?? [];
  const lapsed = storedEntries.length > 0 && stampFromRow(raw, confirmedAt, workflowConfirmedAt) === null;
  const mandateId = planOf.kind === 'mandate' ? planOf.mandateId : undefined;
  const ended = mandateId === undefined || ends === null || !ends.isLive(mandateId);
  const now = stampEntriesFor(planOf, apiStore, ends);
  const byId = new Map(apiStore.knownProfiles().map((p) => [p.id, p] as const));
  const shown = (id: string, state: StampEntryState): StampListShown['entries'][number] => {
    const p = byId.get(id);
    return { provider: p ? connectionShown(p).provider : null, account: p?.oauth_grant?.account?.label ?? null, state };
  };
  const entries = storedEntries.map((e) => {
    const p = byId.get(e.profile);
    // An ended mandate makes every connection it made wait (`connectionWaits`); one removed since
    // is said as removed, which the note above the list (`ended`) does not hide.
    if (p !== undefined && connectionWaits(p, ends)) return shown(e.profile, 'waits');
    const listed = now.some((n) => n.profile === e.profile && n.grant === e.grant && n.binding === e.binding);
    return shown(e.profile, listed ? 'listed' : 'changed');
  });
  for (const n of now) {
    if (!storedEntries.some((e) => e.profile === n.profile)) entries.push(shown(n.profile, 'new'));
  }
  return entries.length === 0 ? null : { lapsed, ended, entries };
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
): Promise<ReturnType<typeof planMembers> & { unreadable: boolean; workflowConfirmedAt: string | null; workflowName: string | null }> {
  const fromTrigger = planMandate(planAuthorshipOf(task));
  const only = (unreadable: boolean): ReturnType<typeof planMembers> & { unreadable: boolean; workflowConfirmedAt: null; workflowName: null } => ({ ...planMembers(fromTrigger, undefined), unreadable, workflowConfirmedAt: null, workflowName: null });
  if (task.effect !== 'run_workflow' || !task.pipeline_id) return only(false);
  try {
    const { getPipeline } = await import('../tools/builtin/pipeline.js');
    const planned = runHistory ? getPipeline(task.pipeline_id, runHistory) : undefined;
    // No workflow: the run itself reports it missing, and nothing of it runs.
    if (planned === undefined) return only(false);
    const a = runHistory?.getWorkflowAuthorship(planned.id);
    if (a === undefined) return only(true);
    const fromWorkflow = planMandate(planAuthorshipOfWorkflow(a));
    return { ...planMembers(fromTrigger, fromWorkflow), unreadable: false, workflowConfirmedAt: planned.confirmedAt ?? null, workflowName: planned.name };
  } catch {
    return only(true);
  }
}
