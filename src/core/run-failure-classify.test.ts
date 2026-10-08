import { describe, it, expect } from 'vitest';
import { classifyRunFailure } from './session.js';
import { RunAbortedError, ToolLoopBreakError, ContinuationLoopError } from './agent.js';
import { InputRequiredError } from './input-required.js';

/**
 * How a failed run is shown, and whether it is reported. A question nobody could be asked is
 * an intended end: its own note and no error report, which would file every distinct
 * question as its own exception. The other four keep what they had — asserted together so a
 * reordering that lets one class shadow another fails here.
 */
describe('classifyRunFailure', () => {
  it('a question nobody could be asked: its own note, not reported', () => {
    expect(classifyRunFailure(new InputRequiredError('Approve?'))).toEqual({ noteCode: 'input_required', report: false });
  });

  it('the guards and the abort keep their calm notes, and are reported as before', () => {
    expect(classifyRunFailure(new ContinuationLoopError('prefix'))).toEqual({ noteCode: 'continuation_loop', report: true });
    expect(classifyRunFailure(new ToolLoopBreakError('k'))).toEqual({ noteCode: 'tool_loop_break', report: true });
    expect(classifyRunFailure(new RunAbortedError())).toEqual({ noteCode: 'run_interrupted', report: true });
  });

  it('anything else is a provider error, reported', () => {
    expect(classifyRunFailure(new Error('upstream 529'))).toEqual({ noteCode: 'provider_error', report: true });
  });
});
