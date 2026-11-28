/**
 * The error a workflow run stopped by its owner ends with. Its own module so the worker can
 * tell the stop from a failure of the run's own without importing the runner; only the
 * runner's stop check writes it.
 */
export const WORKFLOW_STOPPED_ERROR = 'Workflow stopped by its owner.';

/**
 * The error a workflow run started from a chat ends with when that chat's run ended while it was
 * running — the owner stopped the chat, a time limit ended it, or a step that ran it timed out.
 * No step starts after it; a step already running may still finish. The cause is the caller's,
 * so the text does not name the owner; only the runner's check writes it.
 */
export const WORKFLOW_CALLER_ENDED_ERROR = 'Workflow ended: the chat or workflow step that started it stopped, so no further step started.';

/**
 * The error a scheduled workflow run ends with when a question it asked went unanswered until
 * its TTL ran out (PRD 3b-2 §4.5). Only the runner's check writes it; the worker records the run
 * as failed with it, and no later step runs.
 */
export const WORKFLOW_QUESTION_UNANSWERED_ERROR = 'Question not answered: the workflow waited for an answer until the question expired.';

/**
 * The error a scheduled workflow run ends with when a question could not be put to its owner at
 * all — e.g. another question in the run's thread held its one open slot. Nobody waited, so it is
 * not the unanswered error; the run still stops, so no step acts without the answer it asked for.
 */
export const WORKFLOW_QUESTION_NOT_ASKED_ERROR = 'Question not asked: the workflow could not put its question to its owner, so it stopped before acting without an answer.';

/**
 * The error a scheduled workflow run ends with when its owner deleted the conversation a question
 * was asked in. That conversation was the only place to answer it, so the question is withdrawn
 * and the run stops before acting without the answer. The owner deleted a chat, not the run: the
 * worker records this without a retry or an escalation, and without saying they stopped it.
 */
export const WORKFLOW_QUESTION_THREAD_DELETED_ERROR = 'Question withdrawn: the conversation it was asked in was deleted, so the workflow stopped before acting without an answer.';

/** A run that hit one of its bounds (`workflowBoundExceeded`): the run's error, written by the runner. */
export function workflowBoundError(kind: 'step' | 'wall-clock' | 'spend', value: string): string {
  return `Workflow exceeded its ${kind} limit (${value}) — aborting to prevent a runaway.`;
}

/** Whether `text` is word for word one of the errors {@link workflowBoundError} writes for the runner. */
export function isWorkflowBoundError(text: string): boolean {
  return /^Workflow exceeded its (?:step limit \(\d+\)|wall-clock limit \(\d+s\)|spend limit \(\$\d+\.\d{2}\)) — aborting to prevent a runaway\.$/.test(text);
}
