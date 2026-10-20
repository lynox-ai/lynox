/**
 * Tools that did not come with the engine: registered through `Engine.registerTool` /
 * `Engine.addTool` (and the Session's wrappers), loaded from a plugin, or added by a hook's
 * `onBeforeCreateAgent`. The engine knows nothing about what they read, so a call of one counts
 * as reading from outside (`unknown` in the conversation's grant set, PRD connection-attribution
 * A5). Kept by entry identity, so a built-in tool of the same name is not affected.
 */

const foreign = new WeakSet<object>();

/** Mark a tool entry as one the engine did not ship. */
export function markForeignTool(entry: object): void {
  foreign.add(entry);
}

/** Whether `entry` was marked with {@link markForeignTool}. */
export function isForeignTool(entry: object): boolean {
  return foreign.has(entry);
}
