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
import { OWNER_PRINCIPAL, isOwnerPrincipal, planAuthorshipOfWorkflow, planMandate, mandateIdOf, planMembers, principalHasEnded, principalTag, type RequestPrincipal } from '../core/request-principal.js';
import type { WorkflowAuthorship } from '../core/workflow-store.js';

/** A saved workflow. `authors` is resolved by the caller, which already holds the workflow:
 *  the mandates it depends on (none for the owner's), or `'unreadable'` when its authorship could
 *  not be read. `ends` is the engine's store of mandate ends; without it no mandate can be told
 *  live. */
export interface SavedRunSource {
  readonly kind: 'saved';
  readonly workflowId: string;
  readonly authors: readonly RequestPrincipal[] | 'unreadable';
  readonly ends: Pick<MandateEnds, 'isLive'> | null;
}

export type RunSource =
  | SavedRunSource
  /** Steps the calling agent wrote for this run, which no saved workflow shaped. They run under the
   *  caller's own principal and lock. */
  | { readonly kind: 'adhoc' }
  /** A `runtime: 'pipeline'` step's sub-run. Its steps are part of the manifest that holds the
   *  step, whose own source was checked when that run started. Accepted only below the top level.
   *  `within` is the saved workflow whose run holds this one, at any depth (absent for an ad-hoc
   *  run): the sub-run reads its makers' access before each of its own steps, as the outer run
   *  does before each of its steps (1184). */
  | { readonly kind: 'nested'; readonly within?: SavedRunSource | undefined };

/** The saved workflow a run belongs to: its own source, or for a sub-run the one that holds it. */
export function heldSource(source: RunSource | undefined): SavedRunSource | undefined {
  if (source === undefined) return undefined;
  if (source.kind === 'saved') return source;
  if (source.kind === 'nested') return source.within;
  return undefined;
}

export const WORKFLOW_ENDED_REFUSAL = 'This workflow was set up or changed by someone whose access has ended, so it does not run.';
// Texts reviewed with ux (U-122; the stored error U-145).
/** Why a run stopped when a maker's access ended mid-run; both texts below begin with it. */
const ENDED_MID_RUN_CAUSE = 'The access of someone who set up or changed this workflow ended while it ran, so it stopped before its next step.';
/** The run's stored error for that end: what the library shows the owner, and what the worker keys
 *  on. It speaks to the person, not to the model (1184); the model's text is `WORKFLOW_ENDED_MID_RUN`. */
export const WORKFLOW_ENDED_MID_RUN_ERROR = `${ENDED_MID_RUN_CAUSE} `
  + 'Starting it again will not work. To finish the remaining steps, ask lynox in a chat to do them or to write a new workflow for them.';
/** What the model is told, as the result's `endedBecause`, when a run ended for that cause. */
export const WORKFLOW_ENDED_MID_RUN = `${ENDED_MID_RUN_CAUSE} `
  + 'The steps listed in this result ran; the others did not. Starting this workflow again is refused for the same reason, so do not start it again. '
  + 'If the remaining steps are still needed, tell the user they can describe them in chat and ask lynox to do them or to write a new workflow for them.';
/** Why a run stopped when the read of its makers' access threw before a step: it stops
 *  (fail-closed), but no end was found, so none is said (1184, U-145). */
const END_CHECK_FAILED_CAUSE = 'Could not check whether the access of everyone who set up or changed this workflow is still active, so it stopped before its next step. '
  + "No one's access is known to have ended.";
/** The run's stored error for that stop, to the person. A new start runs the finished steps again:
 *  only a chat's run can be retried from its results, and only while the engine keeps them. */
export const WORKFLOW_END_CHECK_FAILED_ERROR = `${END_CHECK_FAILED_CAUSE} `
  + 'You can start it again, but the steps that already ran will run again, so first check that this does no harm.';
/** What the model is told, as the result's `endedBecause`, for that stop. */
export const WORKFLOW_END_CHECK_FAILED = `${END_CHECK_FAILED_CAUSE} `
  + "The steps listed in this result ran; the others did not. Do not say that anyone's access ended or name another cause. "
  + 'Tell the user they can start it again, and that the steps that already ran would then run again. Do not start it yourself unless they ask.';
/**
 * A sub-run stopped because a maker's access ended, or because that read threw: thrown from the
 * `runtime: 'pipeline'` step so the run that holds it takes `runError` as its own cause, word for
 * word, instead of reading the access again (a second read can disagree with the first) or
 * recording the step's failure (1184).
 */
export class NestedRunEndedError extends Error {
  constructor(readonly runError: string, message: string) {
    super(message);
    this.name = 'NestedRunEndedError';
  }
}

/** Whether a run's error is one of the two that stop a run before a step for its makers' access. */
export function isAuthorStop(error: string | undefined): error is string {
  return error === WORKFLOW_ENDED_MID_RUN_ERROR || error === WORKFLOW_END_CHECK_FAILED_ERROR;
}

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

export const WORKFLOW_OF_ANOTHER_REFUSAL = 'Another person with delegated access set up or last changed this workflow, so only they or the owner may run it. '
  + 'To run this task yourself, describe in chat what it should do and ask lynox to write a new workflow for it; a newly written workflow is yours. '
  + 'Do not copy this one, because a copy stays theirs, and do not change it, because changing it takes it over and stops them from running it. '
  + 'Otherwise ask the owner to run this one.';
/** For a mandate only: the owner is refused the same workflow by the runner (`sourceRefusal`), so the way on is a new workflow. */
export const WORKFLOW_UNREADABLE_FOR_MANDATE_REFUSAL = 'lynox cannot tell whose workflow this is, because the record of who made or last changed it could not be read, so it did not run. '
  + 'Give the user only this reason: do not add a cause, and do not say whether anything else about the workflow is fine. '
  + 'To get the task done, offer to write a new workflow from what the user describes; a newly written workflow is theirs. Do not write or run one before the user agrees.';

/** Whom a run of a saved workflow started from a conversation is for: see {@link callerWorkflowRunAs}. */
export type CallerWorkflowRun =
  /** Runs as `principal`. `asPlan`: as a plan's run of that mandate with no stamp (`runAsPlanOf`). */
  | { readonly kind: 'run'; readonly principal: RequestPrincipal; readonly asPlan: boolean }
  | { readonly kind: 'refused'; readonly error: string };

/**
 * Whom a run of a saved workflow started from a conversation (a chat's or a worker session's
 * `run_workflow`) is for (1100). The workflow decides, as the library's Run does
 * (`workflowRunsAs`), and the caller only where it is narrower:
 * - the owner runs a mandate's workflow as that mandate, as a plan's run with no stamp, so the
 *   mandate's lock holds and its own connections stay out, and the owner's own as the owner;
 * - a mandate runs its own workflow and the owner's as itself, in its own session's lock;
 * - a mandate is refused another mandate's workflow, as a hand start of another mandate's plan is
 *   (`PLAN_OF_ANOTHER_RESULT`), and one whose authorship cannot be read.
 * For the owner an unreadable workflow gives the owner here; the runner refuses it
 * (`sourceRefusal`) before any step.
 */
export function callerWorkflowRunAs(caller: RequestPrincipal, read: () => WorkflowAuthorship | undefined): CallerWorkflowRun {
  let a: WorkflowAuthorship | undefined;
  try {
    a = read();
  } catch {
    a = undefined;
  }
  if (isOwnerPrincipal(caller)) {
    const runAs = workflowRunsAs(a);
    return { kind: 'run', principal: runAs, asPlan: !isOwnerPrincipal(runAs) };
  }
  if (a === undefined) return { kind: 'refused', error: WORKFLOW_UNREADABLE_FOR_MANDATE_REFUSAL };
  const mark = planMandate(planAuthorshipOfWorkflow(a));
  if (mark === undefined || principalTag(mark.principal) === principalTag(caller)) return { kind: 'run', principal: caller, asPlan: false };
  return { kind: 'refused', error: WORKFLOW_OF_ANOTHER_REFUSAL };
}

export const LIBRARY_RUN_UNCONFIRMED ='This workflow was changed after Run was pressed and waits for its steps to be reviewed again, so it did not run.';
export const LIBRARY_RUN_AUTHOR_CHANGED = 'Whom this workflow runs for changed after Run was pressed, or could not be read again, so it did not run. Press Run again.';

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
    const now = workflowRunsAs(a);
    // The grant too: the same person under a later access is not the one the route decided on.
    return principalTag(now) === principalTag(runAs) && mandateIdOf(now) === mandateIdOf(runAs) ? null : LIBRARY_RUN_AUTHOR_CHANGED;
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
