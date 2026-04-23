import type {
  BetaMessageParam,
  BetaContentBlockParam,
  BetaToolUseBlockParam,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

/**
 * Every `tool_use` block in an assistant turn must be paired with a matching
 * `tool_result` block in the immediately-following user turn — and vice versa.
 * When the pairing drifts (partial persist, rolled-back run, rehydration from
 * a stale snapshot) Anthropic rejects the payload with
 *
 *   messages.N.content.M: unexpected `tool_use_id` found in `tool_result`
 *   blocks: toolu_…. Each `tool_result` block must have a corresponding
 *   `tool_use` block in the previous message.
 *
 * The sanitizer walks the history pairwise and drops orphan blocks on both
 * sides so the outbound payload is always well-formed. Non-tool content
 * (text, images, thinking) is left intact; messages that become empty after
 * dropping their only content are removed entirely.
 */

function isToolUse(b: BetaContentBlockParam): b is BetaToolUseBlockParam {
  return b.type === 'tool_use';
}

function isToolResult(b: BetaContentBlockParam): b is BetaToolResultBlockParam {
  return b.type === 'tool_result';
}

function collectToolUseIds(content: BetaMessageParam['content']): Set<string> {
  if (!Array.isArray(content)) return new Set();
  const ids = new Set<string>();
  for (const b of content) {
    if (isToolUse(b)) ids.add(b.id);
  }
  return ids;
}

function collectToolResultIds(content: BetaMessageParam['content']): Set<string> {
  if (!Array.isArray(content)) return new Set();
  const ids = new Set<string>();
  for (const b of content) {
    if (isToolResult(b)) ids.add(b.tool_use_id);
  }
  return ids;
}

function filterContent(
  content: BetaMessageParam['content'],
  keepPredicate: (block: BetaContentBlockParam) => boolean,
): BetaContentBlockParam[] | string {
  if (typeof content === 'string') return content;
  return content.filter(keepPredicate);
}

export function sanitizeToolPairs(messages: BetaMessageParam[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i]!;

    if (current.role !== 'assistant' || !Array.isArray(current.content)) {
      // Non-assistant message: check for orphan tool_results against previously
      // emitted assistant turn. This covers user(tool_result) messages that
      // somehow survived without an anchor (e.g. stripped assistant turn).
      if (current.role === 'user' && Array.isArray(current.content)) {
        const resultIds = collectToolResultIds(current.content);
        if (resultIds.size === 0) {
          out.push(current);
          continue;
        }
        const prev = out[out.length - 1];
        const prevUseIds = prev && prev.role === 'assistant' ? collectToolUseIds(prev.content) : new Set<string>();
        const filtered = filterContent(current.content, (b) => {
          if (isToolResult(b)) return prevUseIds.has(b.tool_use_id);
          return true;
        });
        if (Array.isArray(filtered) && filtered.length === 0) continue;
        out.push({ ...current, content: filtered });
        continue;
      }
      out.push(current);
      continue;
    }

    const useIds = collectToolUseIds(current.content);
    if (useIds.size === 0) {
      out.push(current);
      continue;
    }

    const next = messages[i + 1];
    const nextResultIds = next && next.role === 'user' ? collectToolResultIds(next.content) : new Set<string>();

    const matchedIds = new Set<string>();
    for (const id of useIds) {
      if (nextResultIds.has(id)) matchedIds.add(id);
    }

    const filteredAssistant = filterContent(current.content, (b) => {
      if (isToolUse(b)) return matchedIds.has(b.id);
      return true;
    });

    if (!Array.isArray(filteredAssistant) || filteredAssistant.length > 0) {
      out.push({ ...current, content: filteredAssistant });
    }

    if (next && next.role === 'user' && Array.isArray(next.content) && nextResultIds.size > 0) {
      const filteredNext = filterContent(next.content, (b) => {
        if (isToolResult(b)) return matchedIds.has(b.tool_use_id);
        return true;
      });
      if (Array.isArray(filteredNext) && filteredNext.length === 0) {
        i++;
        continue;
      }
      out.push({ ...next, content: filteredNext });
      i++;
    }
  }

  return out;
}
