/**
 * Where a run's manifest comes from, and so whose access it depends on.
 *
 * A saved workflow a mandate made or last changed depends on that mandate: it runs only while the
 * mandate's grant is live, whoever starts it — the owner from the library, the HTTP run route, a
 * schedule, a chat's `run_workflow`. The check sits at `runManifest`, the one function every run goes
 * through, and every caller has to say what it runs: `source` is a required field, so a new caller
 * does not compile until it decides.
 */
import type { MandateEnds } from '../core/mandate-ends.js';
import { OWNER_PRINCIPAL, planAuthorshipOfWorkflow, planMandate, planMembers, principalHasEnded, principalTag, type RequestPrincipal } from '../core/request-principal.js';
import type { WorkflowAuthorship } from '../core/workflow-store.js';

export type RunSource =
  /** A saved workflow. `authors` is resolved by the caller, which already holds the workflow:
   *  the mandates it depends on (none for the owner's), or `'unreadable'` when its authorship could
   *  not be read. `ends` is the engine's store of mandate ends; without it no mandate can be told
   *  live. */
  | {
      readonly kind: 'saved';
      readonly workflowId: string;
      readonly authors: readonly RequestPrincipal[] | 'unreadable';
      readonly ends: Pick<MandateEnds, 'isLive'> | null;
    }
  /** Steps the calling agent wrote for this run, which no saved workflow shaped. They run under the
   *  caller's own principal and lock. */
  | { readonly kind: 'adhoc' }
  /** A `runtime: 'pipeline'` step's sub-run. Its steps are part of the manifest that holds the
   *  step, whose own source was checked when that run started. Accepted only below the top level. */
  | { readonly kind: 'nested' };

export const WORKFLOW_ENDED_REFUSAL = 'This workflow was set up or changed by someone whose access has ended, so it does not run.';
export const WORKFLOW_UNREADABLE_REFUSAL = 'Could not read who set up this workflow, so it did not run.';
export const NESTED_AT_TOP_REFUSAL = 'A nested run was started on its own, outside the run it belongs to, so it did not run.';

/**
 * The source of a run of the saved workflow `workflowId`, as its authorship reads. A workflow
 * without a row of authorship (`read` returns undefined) or one whose read throws is unreadable,
 * so it does not run: every saved workflow has that row, and one that cannot be read cannot be
 * told apart from a mandate's.
 */
export function savedWorkflowSource(
  workflowId: string,
  read: ((id: string) => WorkflowAuthorship | undefined) | undefined,
  ends: Pick<MandateEnds, 'isLive'> | null | undefined,
): RunSource {
  let a: WorkflowAuthorship | undefined;
  try {
    a = read?.(workflowId);
  } catch {
    a = undefined;
  }
  if (a === undefined) return { kind: 'saved', workflowId, authors: 'unreadable', ends: ends ?? null };
  const mark = planMandate(planAuthorshipOfWorkflow(a));
  return { kind: 'saved', workflowId, authors: planMembers(undefined, mark).members, ends: ends ?? null };
}

/**
 * Whom a run of a saved workflow is for when no plan names one: the mandate that made or last
 * changed it, as a plan on that workflow runs (`planMembers`), else the owner. The library's Run
 * button asks this, so the owner pressing it runs a mandate's workflow under that mandate's lock
 * (1055, decision A). The route also runs it as a plan's run with no stamp (`runAsPlanOf`), so the
 * mandate's own connections stay out of it, as they do on a schedule the owner has not listed
 * them for. Unreadable authorship gives the owner here, and the run is refused by
 * `sourceRefusal` before any step.
 */
export function workflowRunsAs(a: WorkflowAuthorship | undefined): RequestPrincipal {
  if (a === undefined) return OWNER_PRINCIPAL;
  return planMembers(undefined, planMandate(planAuthorshipOfWorkflow(a))).of ?? OWNER_PRINCIPAL;
}

export const LIBRARY_RUN_UNCONFIRMED = 'This workflow was changed after Run was pressed and waits for its steps to be reviewed again, so it did not run.';
export const LIBRARY_RUN_AUTHOR_CHANGED = 'This workflow was changed by someone else after Run was pressed, so it did not run. Press Run again.';

/**
 * The check the library's Run hands the runner, asked on the workflow exactly as the runner read
 * it: the route decided the run's principal and saw the workflow confirmed, then awaited the
 * budget and the claim, and an edit in between must not run under the earlier decision. Refused
 * when the read workflow is no longer confirmed, or when whoever made or last changed it is no
 * longer `runAs` (another mandate's edit would run as the first one, an edit to the owner's as the
 * owner without any lock).
 */
export function libraryRunCheck(
  runAs: RequestPrincipal,
  read: (id: string) => WorkflowAuthorship | undefined,
): (planned: { readonly id: string; readonly confirmedAt?: string | undefined }) => string | null {
  return (planned) => {
    if (!planned.confirmedAt) return LIBRARY_RUN_UNCONFIRMED;
    let a: WorkflowAuthorship | undefined;
    try { a = read(planned.id); } catch { a = undefined; }
    return principalTag(workflowRunsAs(a)) === principalTag(runAs) ? null : LIBRARY_RUN_AUTHOR_CHANGED;
  };
}

/** Why a run of this source must not start, or undefined when it may. `depth` is the run's
 *  nesting depth: 0 for a run started on its own. */
export function sourceRefusal(source: RunSource, depth: number): string | undefined {
  switch (source.kind) {
    case 'adhoc': return undefined;
    case 'nested': return depth > 0 ? undefined : NESTED_AT_TOP_REFUSAL;
    case 'saved': {
      if (source.authors === 'unreadable') return WORKFLOW_UNREADABLE_REFUSAL;
      const isLive = (id: string): boolean => source.ends?.isLive(id) ?? false;
      return source.authors.some((p) => principalHasEnded(p, isLive)) ? WORKFLOW_ENDED_REFUSAL : undefined;
    }
    default: {
      const never: never = source;
      throw new Error(`Unhandled run source: ${String((never as { kind?: unknown }).kind)}`);
    }
  }
}
