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
import { containsUntrustedMarker, wrapUntrustedData } from '../../core/data-boundary.js';
import { noteOwnWrapped } from '../../core/call-connection.js';

/** Starts with an opener and ends with a closer: the old shape rule. It also matches
 *  several blocks back to back; then only the last closer is exempted and the others
 *  stay in the scan. */
const ONE_BLOCK = /^<untrusted_data[ >][\s\S]*\n<\/untrusted_data>$/;

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
      'compactions. If the id is gone (the store filled and dropped the oldest, or it never ' +
      'existed) you get a clear notice — re-run the original tool call instead.',
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
    // Wave 1.2 replay (a): a recalled tool result is external content re-injected on a
    // LATER turn. Its trust boundary must ride with it — the untrusted-data marker set at
    // the original fetch must be present so the dispatcher re-flags this turn (else the
    // replay is a fail-open hole: memory extracted after a recall would look clean). Most
    // wrapping tools' markers survive eviction verbatim; re-wrap only when absent. Wrapping
    // a payload that already carries blocks would neutralize its tags, and the scan reads
    // a neutralized closer as an escape too.
    if (containsUntrustedMarker(blob.payload)) {
      // The result scan exempts only closers of blocks produced inside THIS call, and the
      // stored blocks came from an earlier one. A payload that is exactly one block and was
      // not flagged when it was first returned (a flagged one starts with the scan's
      // warning, not with the tag) is taken as this call's own, which keeps its replay as
      // quiet as the shape rule this replaced kept it. Only its terminal closer is exempted;
      // any other closer in it stays in the scan. A payload of several blocks is replayed
      // with the warning.
      if (ONE_BLOCK.test(blob.payload)) noteOwnWrapped(blob.payload);
      return blob.payload;
    }
    return wrapUntrustedData(blob.payload, `recalled:${blob.tool}`);
  },
};
