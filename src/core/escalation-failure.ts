// What the escalation thread of a failed scheduled workflow says about the failure (U-201).
//
// The thread hands its body to the owner's next turn as the assistant's own words. A step's error
// can carry a third party's text (a service's answer, a page it read), and a reported failure's
// reason (`fail_step`) is model text: neither goes in. The body names each failed step in lynox's
// own words and says once, after the steps, that the errors are in the run's record, where
// diagnose_workflow_run reads them. Only a run error lynox itself wrote is shown as it is.

import { GateExpiredError, GateRejectedError } from '../types/orchestration.js';
import { isWorkflowBoundError } from '../orchestrator/workflow-stop.js';
import { OWN_RUN_ERRORS } from '../tools/builtin/diagnose-workflow.js';
import { isStepIdShape } from '../orchestrator/step-id.js';
import type { WorkerNotices } from './worker-notices.js';

export interface FailedRun {
  readonly error?: string | undefined;
  /** The step whose reported reason is `error`. */
  readonly errorReportedBy?: string | undefined;
  readonly stepErrors?: ReadonlyArray<{ readonly stepId: string; readonly error?: string | undefined; readonly reported?: true | undefined }> | undefined;
}

export interface FailureAccount {
  /** The run's error line, without its label; absent when the run has no error. */
  readonly runError?: string | undefined;
  /** One line per affected step: failed, reported or declined. */
  readonly steps: readonly string[];
  /** Where the errors and reasons are, said once; absent when nothing was left out. */
  readonly where?: string | undefined;
}

/**
 * Whether the run's `error` is lynox's own: one of the fixed run errors, a bound the runner
 * enforced, or a gate's expiry or plain rejection of a step. A text a step recorded is that step's
 * (a reason can copy a fixed text word for word), except the gate texts, which the gated step
 * records itself.
 */
function ownRunError(error: string, recordedBy: readonly string[]): boolean {
  if (recordedBy.length === 0) return OWN_RUN_ERRORS.has(error) || isWorkflowBoundError(error);
  return recordedBy.length === 1
    && (error === new GateExpiredError(recordedBy[0]!).message || error === new GateRejectedError(recordedBy[0]!).message);
}

/**
 * How the body names a step. A step id stored before ids had a shape (`step-id.ts`) is not shown —
 * the body reads as the assistant's own words — but named by its position in the workflow
 * (`positionOf`, counted from 1), or without one (U-314). Every comparison below stays on the raw id;
 * only what is written changes.
 */
function stepNames(notices: WorkerNotices, positionOf: (id: string) => number | undefined) {
  const outside = (id: string): boolean => !isStepIdShape(id);
  return {
    item: (id: string): string => (outside(id) ? notices.unnamedStep(positionOf(id)) : id),
    reported: (id: string): string => (outside(id) ? notices.stepReportedUnnamed(positionOf(id)) : notices.stepReported(id)),
    failed: (id: string): string => (outside(id) ? notices.stepFailedUnnamed(positionOf(id)) : notices.stepFailed(id)),
    declined: (id: string): string => (outside(id) ? notices.stepDeclinedUnnamed(positionOf(id)) : notices.stepDeclined(id)),
    outside,
  };
}

export function failureAccount(run: FailedRun, notices: WorkerNotices, positionOf: (id: string) => number | undefined = () => undefined): FailureAccount {
  const name = stepNames(notices, positionOf);
  const failed = (run.stepErrors ?? []).filter((s) => s.error);
  const reported = new Set(failed.filter((s) => s.reported === true).map((s) => s.stepId));
  if (run.errorReportedBy !== undefined) reported.add(run.errorReportedBy);
  // A step its approver declined: its own line, and its reason (a person's text) is asked for as a
  // reason for declining, not as an error (U-201). A plain rejection has no reason to ask for.
  let declined: string | undefined;
  let declinedWithReason = false;
  let unrecorded = 0;

  let runError: string | undefined;
  if (run.errorReportedBy !== undefined) {
    runError = name.reported(run.errorReportedBy);
  } else if (run.error) {
    const recordedBy = failed.filter((s) => s.error === run.error).map((s) => s.stepId);
    if (ownRunError(run.error, recordedBy)) {
      const rejected = recordedBy.length === 1 && run.error === new GateRejectedError(recordedBy[0]!).message;
      if (rejected) declined = recordedBy[0];
      // A gate's own text quotes the step's id: one outside the shape is named instead.
      runError = recordedBy.length === 1 && name.outside(recordedBy[0]!)
        ? (rejected ? name.declined(recordedBy[0]!) : name.failed(recordedBy[0]!))
        : run.error;
    } else if (recordedBy.length > 0) {
      // The step that ended the run recorded it last.
      const by = recordedBy[recordedBy.length - 1]!;
      if (reported.has(by)) {
        runError = name.reported(by);
      } else if (run.error.startsWith(`${new GateRejectedError(by).message}: `)) {
        runError = name.declined(by);
        declined = by;
        declinedWithReason = true;
      } else {
        runError = name.failed(by);
      }
    } else {
      runError = notices.runFailed;
      unrecorded = 1;
    }
  }

  const errors = failed.filter((s) => s.reported !== true && s.stepId !== declined).length + unrecorded;
  const steps = failed.map((s) => (s.reported === true ? notices.stepReportedItem(name.item(s.stepId))
    : s.stepId === declined ? notices.stepDeclinedItem(name.item(s.stepId))
    : notices.stepFailedItem(name.item(s.stepId))));
  let where: string | undefined;
  if (reported.size > 0) {
    // A decline next to a reported step counts with the errors here.
    const others = errors + (declinedWithReason ? 1 : 0);
    where = reported.size > 1
      ? (others > 0 ? notices.errorsAndReasonsWhere : notices.reportedReasonsWhere)
      : (others > 0 ? notices.errorsAndReasonWhere : notices.reportedReasonWhere);
  } else if (declinedWithReason) {
    where = errors > 0 ? notices.errorsAndDeclinedWhere : notices.declinedWhere;
  } else {
    where = errors > 1 ? notices.errorsWhere : errors === 1 ? notices.errorWhere : undefined;
  }
  return { runError, steps, where };
}

/** The body of a failed scheduled run's escalation thread: what failed, where the errors are, the
 *  writes to read, and the ids the reply needs (`ref`). */
export function failedRunBody(
  notices: WorkerNotices,
  at: { title: string; status: string | undefined; run: FailedRun; grantLines: readonly string[]; ref: string; positionOf?: (id: string) => number | undefined },
): string {
  const failure = failureAccount(at.run, notices, at.positionOf);
  return `${notices.workflowIncomplete(at.title, at.status)}\n\n` +
    (failure.runError !== undefined ? `${notices.errorLabel} ${failure.runError}\n\n` : '') +
    // A list as Markdown reads it, and as plain text does (Telegram): a blank line after the label (U-201).
    (failure.steps.length > 0 ? `${notices.affectedStepsLabel}\n\n${failure.steps.join('\n')}\n\n` : '') +
    (failure.where !== undefined ? `${failure.where}\n\n` : '') +
    (at.grantLines.length > 0 ? `${notices.writesLabel}\n\n${at.grantLines.map((l) => `- ${l}`).join('\n')}\n\n` : '') +
    notices.workflowReply(at.ref);
}
