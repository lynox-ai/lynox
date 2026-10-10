import type { IAgent } from '../../types/index.js';

/**
 * The answer a memory-writing tool gives in a private chat, or `null` when the chat is not
 * private.
 *
 * In private mode the end-of-turn capture already stood down; the tools did not, so a
 * `remember` the model chose on its own — or one the user asked for — went into memory from
 * a chat the user had marked private. The way to remember something from such a chat is to
 * turn private mode off, and the user is the one who decides that, so that is what the answer
 * tells the model.
 *
 * Read from the thread store, not from the agent's `skipMemoryExtraction`: that flag is also
 * set by the global `memory_extraction: false` setting, which switches off automatic capture
 * and was never a promise that an explicit `remember` is refused.
 *
 * `remember`, `memory_block_edit`, `memory_store` and `memory_update` call this. Removing or retiring an entry,
 * and promoting one that is already stored, carry nothing from this chat.
 *
 * A sub-agent has no `currentThreadId`; it is checked against the chat it was spawned from.
 */
export function privateThreadRefusal(agent: IAgent): string | null {
  const threadId = agent.currentThreadId ?? agent.originThreadId;
  if (!threadId) return null;
  const thread = agent.toolContext.threadStore?.getThread(threadId);
  if (thread?.skip_extraction !== 1) return null;
  return 'Not stored: this chat is in private mode. '
    + 'If the user wants this remembered, they can turn private mode off for this chat first.';
}
