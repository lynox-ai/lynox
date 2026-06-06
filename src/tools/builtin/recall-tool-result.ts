/**
 * recall_tool_result — Phase 2 Context Hygiene.
 *
 * When the conversation is auto-compacted (>75% context), `Session.compact()`
 * summarizes everything into prose and resets the message history. Large tool
 * results (API responses, file dumps, search output) are NOT lost: just before
 * the reset they are evicted into the Session's blob store, and the
 * post-compaction synthetic context lists each one as a recall handle.
 *
 * This tool re-fetches a retained payload by its handle id. A blob stays
 * recallable only until the NEXT compaction, which clears the store — so a
 * handle from two compactions ago resolves to a clear "re-run the tool"
 * message instead of stalling or throwing.
 */

import type { ToolEntry, IAgent } from '../../types/index.js';

interface RecallToolResultInput {
  /** The recall handle id, e.g. `tr-3`, from the post-compaction context. */
  id: string;
}

export const recallToolResultTool: ToolEntry<RecallToolResultInput> = {
  definition: {
    name: 'recall_tool_result',
    description:
      'Re-fetch a large tool result that was set aside during a context compaction. ' +
      'After the conversation is summarized, big tool outputs (API responses, file ' +
      'reads, search results) are replaced by short recall handles like "tr-3". Call ' +
      'this with that id to get the full original payload back. Handles stay valid across ' +
      'later compactions. If the id is no longer available (the recall store filled up and ' +
      'dropped the least-recently-used, or it never existed) you get a clear notice — re-run ' +
      'the original tool call instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'The recall handle id (e.g. "tr-3") shown in the post-compaction context.',
        },
      },
      required: ['id'],
    },
  },
  handler: async (input: RecallToolResultInput, agent: IAgent): Promise<string> => {
    const id = (input.id ?? '').trim();
    if (!id) {
      return 'No recall id provided. Pass the handle id (e.g. "tr-3") shown in the post-compaction context.';
    }
    const blob = agent.toolResultBlobStore?.get(id);
    if (!blob) {
      // Never throw, never stall — a missing id is an expected outcome once a
      // blob has been hard-dropped past a compaction reset.
      return `Tool result ${id} is no longer available — re-run the original tool call to get this data again.`;
    }
    return blob.payload;
  },
};
