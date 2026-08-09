import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { toolResultText } from './tool-result-hygiene.js';

/**
 * F5 (PRD-COST-CONTROLS-V2, D4/D5): after an artifact_save SUCCEEDED, the body
 * in the conversation buys nothing — the artifact is persisted, the save
 * result already tells the model the id and file path, and `read_file` can
 * recover the content on demand. Measured on a real tenant: 134 KB of artifact
 * bodies re-read as cache writes on every subsequent run, 19.1% of the
 * thread's total cost.
 *
 * This is a WIRE-side transform: the persisted thread history (debug-export,
 * reload, UI rendering) keeps the original bodies (D4). It runs at the two
 * places conversation history enters a turn — `Agent.send` (turn start, so the
 * turn that PRODUCED the save keeps its body until the next one: the model may
 * still be composing follow-up edits against it) and `Agent.loadMessages`
 * (resume hydration, where everything loaded is by definition a past turn).
 *
 * Byte-stability: evicting rewrites one position in the history, which costs
 * ONE conversation-cache re-write at that point — and then the history is
 * byte-stable again, minus the body that would otherwise be re-written into
 * the cache on every turn. The transform is idempotent (marker prefix), so it
 * never oscillates.
 */

/** Bodies at or below this size stay: the one-time cache re-write the eviction
 *  costs outweighs re-sending a small body. */
export const EVICTION_MIN_CHARS = 2048;

const EVICTED_PREFIX = '[evicted after successful save';

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

function isToolUse(block: unknown): block is ToolUseBlock {
  return typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'tool_use'
    && typeof (block as { id?: unknown }).id === 'string'
    && typeof (block as { name?: unknown }).name === 'string';
}

/** The save handler's success result starts with `Saved artifact "` or
 *  `Updated artifact "` — anything else (store unavailable, thrown error
 *  formatted by the tool runner) means the body was never persisted and MUST
 *  stay in the conversation, or the content is simply gone. The coupling to
 *  the handler's exact format is pinned by a contract test that runs the REAL
 *  `artifact_save` handler — rewording the result there fails that test, not
 *  silently this check. Exported for exactly that test. */
export function isSuccessfulSaveResult(result: string): boolean {
  return result.startsWith('Saved artifact "') || result.startsWith('Updated artifact "');
}

/** Collect tool_use_id → result-text for every tool_result in the history.
 *  First-wins, and error-marked results are skipped: a crafted external
 *  history (loadMessages takes migration imports) must not be able to pair a
 *  failed save with a spoofed duplicate "success" result and evict a body
 *  that was never persisted. */
function collectResults(messages: BetaMessageParam[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      if (b.is_error === true) continue;
      if (results.has(b.tool_use_id)) continue;
      results.set(b.tool_use_id, toolResultText(b.content as Parameters<typeof toolResultText>[0]));
    }
  }
  return results;
}

/**
 * Replace the `content` of every SUCCESSFULLY saved artifact_save input with a
 * short reference. Returns the same array (identity) when nothing changes;
 * otherwise a new array sharing every unchanged message object.
 */
export function evictSavedArtifactBodies(messages: BetaMessageParam[]): BetaMessageParam[] {
  const results = collectResults(messages);
  let out: BetaMessageParam[] | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    let newContent: unknown[] | null = null;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j]!;
      if (!isToolUse(block) || block.name !== 'artifact_save') continue;
      const input = block.input;
      if (typeof input !== 'object' || input === null) continue;
      const content = (input as { content?: unknown }).content;
      if (typeof content !== 'string') continue;
      // Also what makes the transform idempotent: the replacement string is
      // far below the threshold, so an already-evicted input never re-matches
      // (pinned by a unit test — never LOWER the threshold under ~300).
      if (content.length <= EVICTION_MIN_CHARS) continue;
      const result = results.get(block.id);
      if (result === undefined || !isSuccessfulSaveResult(result)) continue;

      const replacement = `${EVICTED_PREFIX} — ${String(content.length)} chars. ` +
        'The artifact is persisted; its id and file path are in the tool result below. ' +
        'read_file that path if you need the content again.]';
      newContent ??= [...msg.content];
      newContent[j] = { ...block, input: { ...(input as Record<string, unknown>), content: replacement } };
    }

    if (newContent) {
      out ??= [...messages];
      out[i] = { ...msg, content: newContent } as BetaMessageParam;
    }
  }

  return out ?? messages;
}
