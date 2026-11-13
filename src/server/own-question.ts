/**
 * Whether a live chat run waits for the user's answer to its OWN question.
 *
 * A thread holds at most one pending question, and it need not be the chat run's: a scheduled
 * run (a task's, a workflow's) can have asked in the same thread before the chat run started.
 * Read by thread alone, that question made a working chat run read as `awaiting_input`, and the
 * client then told the user a question was waiting instead of that a turn was still running.
 *
 * Both timestamps come from the same clock: SQLite's `datetime('now')` in the same database
 * (`active_runs.started_at`, `pending_prompts.created_at`), so they compare as strings. A
 * question asked before the run started is not the run's. When either stamp is missing, or both
 * fall in the same second, the run reads as waiting, as it did before: the cost of that is a
 * sentence about a question rather than about a running turn, never a lost answer.
 */
export function awaitsOwnQuestion(
  run: { status: string; started_at?: string | null | undefined },
  pending: { created_at?: string | null | undefined } | undefined,
): boolean {
  if (run.status !== 'running' || !pending) return false;
  const started = run.started_at;
  const asked = pending.created_at;
  if (typeof started !== 'string' || started === '' || typeof asked !== 'string' || asked === '') return true;
  return asked >= started;
}
