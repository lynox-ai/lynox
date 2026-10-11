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

/**
 * The error a scheduled workflow run ends with when a question could not be put to its owner at
 * all — e.g. another question in the run's thread held its one open slot. Nobody waited, so it is
 * not the unanswered error; the run still stops, so no step acts without the answer it asked for.
 */
export const WORKFLOW_QUESTION_NOT_ASKED_ERROR = 'Question not asked: the workflow could not put its question to its owner, so it stopped before acting without an answer.';
