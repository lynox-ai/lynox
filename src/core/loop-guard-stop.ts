import { ContinuationLoopError, ThinkingOnlyLoopError, ToolLoopBreakError } from './agent.js';

/** Which loop guard stopped a run, as the run history records it in `stop_reason`; null for
 *  anything else. The guards' errors are `RunAbortedError`s, so a run they stop is recorded
 *  `aborted` like a stop by the user; this is what tells the two apart. */
export function loopGuardStopReason(err: unknown): 'thinking_loop' | 'continuation_loop' | 'tool_loop_break' | null {
  // Before the continuation loop: the thinking-only guard's error is one.
  if (err instanceof ThinkingOnlyLoopError) return 'thinking_loop';
  if (err instanceof ContinuationLoopError) return 'continuation_loop';
  if (err instanceof ToolLoopBreakError) return 'tool_loop_break';
  return null;
}
