import type { IAgent, ToolCallContext, ToolEntry } from '../types/index.js';

/**
 * A tool whose handler runs `around` in place of its own. `around` reaches the tool's own handler
 * only through `run`, which passes on every argument the engine gave the call, the call's
 * context (`ToolCallContext`) included: a wrapper cannot drop it. Dropped, a write tool would
 * resolve its path again after the permission guard judged it, and a link set meanwhile (while a
 * gate waits for its answer) would send the write to a file nobody judged.
 */
export function wrapHandler<TInput>(
  entry: ToolEntry<TInput>,
  around: (input: TInput, agent: IAgent, run: () => Promise<string>) => Promise<string>,
): ToolEntry<TInput> {
  return {
    ...entry,
    handler: (input: TInput, agent: IAgent, call?: ToolCallContext): Promise<string> =>
      around(input, agent, () => (call === undefined ? entry.handler(input, agent) : entry.handler(input, agent, call))),
  };
}
