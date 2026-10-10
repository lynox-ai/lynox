/**
 * The error a workflow run stopped by its owner ends with. Its own module so the worker can
 * tell the stop from a failure of the run's own without importing the runner; only the
 * runner's stop check writes it.
 */
export const WORKFLOW_STOPPED_ERROR = 'Workflow stopped by its owner.';

/**
 * The error a scheduled workflow run ends with when a question it asked went unanswered until
 * its TTL ran out (PRD 3b-2 §4.5). Only the runner's check writes it; the worker records the run
 * as failed with it, and no later step runs.
 */
export const WORKFLOW_QUESTION_UNANSWERED_ERROR = 'Question not answered: the workflow waited for an answer until the question expired.';
