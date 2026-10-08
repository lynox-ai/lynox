/**
 * A run asked a person something and has no way to reach one.
 *
 * Thrown by `ask_user` when the agent has no question path (`agent.promptUser` is unset):
 * a background analysis, a headless CLI run, any context that wires none. It used to
 * return "Interactive input not available in this context." as the tool RESULT, and the
 * run carried on without the decision it had just said it needed — a fail-open.
 *
 * ⛔ The agent re-throws this one instead of turning it into an error tool result, so the
 * RUN ends, not just the call: an error result is something the model reads and works
 * around, which is the fail-open again with a different string. Ending the run is the only
 * outcome that does not decide for the person who was never asked.
 *
 * Its own module, like `tool-soft-failure.ts`, because both the agent and the tool need it
 * and neither should import the other for it.
 */
export class InputRequiredError extends Error {
  /** The question that could not be put to anyone, capped — it is what the reader of the
   *  failed run needs to see. */
  readonly question: string;
  constructor(question: string) {
    const shown = question.length > QUESTION_CAP ? `${question.slice(0, QUESTION_CAP)}…` : question;
    super(`Needs input: this run asked a question and has no way to reach a person. The question was: ${shown}`);
    this.name = 'InputRequiredError';
    this.question = shown;
  }
}

/** How much of the question the error carries. Enough to recognise it, not a document. */
const QUESTION_CAP = 300;

export function isInputRequired(err: unknown): err is InputRequiredError {
  return err instanceof InputRequiredError;
}
