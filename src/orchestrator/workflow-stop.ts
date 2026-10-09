/**
 * The error a workflow run stopped by its owner ends with. Its own module so the worker can
 * tell the stop from a failure of the run's own without importing the runner; only the
 * runner's stop check writes it.
 */
export const WORKFLOW_STOPPED_ERROR = 'Workflow stopped by its owner.';
