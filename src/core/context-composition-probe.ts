import type {
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

/**
 * Context-cost Slice 0 — composition probe.
 *
 * The engine's per-turn cost is dominated by the cache-read floor on the WHOLE
 * carried context (~$0.30/Mtok on every turn, even at ~100% cache-hit). The bill
 * therefore scales with context-SIZE × turns, and compaction is gated on % of the
 * context window — never on cost — so a large thread carries a large live context
 * indefinitely. To decide where the size goes (and whether L1 cost-aware
 * compaction or L3 tool-result dedup is the bigger lever) we must first MEASURE
 * the composition of `messages[]`, which is invisible from a rendered thread
 * export (the export is display text, not the billed context).
 *
 * This module is a PURE function over the agent's `messages[]`. It is shared by
 * two consumers so they can never measure two different things:
 *   1. the synthetic baseline harness (`tests/performance/context-cost-baseline.ts`)
 *   2. the opt-in live capture hook in `Agent` (gated by `context_cost_log`)
 *
 * No I/O, no SDK calls — just byte accounting + duplicate detection.
 */

const DEFAULT_CHARS_PER_TOKEN = 3.5;

/** Per-tool tool_result accounting. */
export interface ToolResultBucket {
  readonly bytes: number;
  readonly count: number;
}

/** One composition measurement of a `messages[]` array at a point in time. */
export interface CompositionSnapshot {
  /** Number of messages in the array. */
  readonly messageCount: number;
  /**
   * Authoritative carried size: sum of `JSON.stringify(msg).length` over every
   * message — the exact basis the agent uses for its occupancy delta estimate.
   */
  readonly totalBytes: number;
  /** `totalBytes / charsPerToken` — a char-estimate of the message tokens. */
  readonly messageTokensEstimate: number;
  /**
   * Real occupancy in tokens when the caller passes the last API-reported input
   * size (which already folds in system + tools overhead). Undefined for the
   * synthetic harness, which has no real API usage.
   */
  readonly occupancyTokens: number | undefined;
  /**
   * `occupancyTokens − messageTokensEstimate`, i.e. the system-prompt + tool-
   * schema overhead that lives OUTSIDE `messages[]`. Undefined unless
   * `lastRealInputTokens` was supplied. Can be slightly negative (the char
   * estimate over-counts JSON structure) — clamped to >= 0.
   */
  readonly overheadTokens: number | undefined;
  /** Byte breakdown by content category. Sums to <= totalBytes (rest = structural). */
  readonly categories: {
    readonly userText: number;
    readonly assistantText: number;
    readonly toolUse: number;
    readonly toolResult: number;
    readonly image: number;
    /** Wrapper/structural bytes not attributable to a single block. */
    readonly structural: number;
  };
  /** tool_result bytes grouped by the originating tool name. */
  readonly toolResultByTool: Readonly<Record<string, ToolResultBucket>>;
  /**
   * Sum of tool_result payload bytes whose exact content was already present in
   * an EARLIER still-resident tool_result. This is L3's addressable ceiling: the
   * verbatim bytes a cross-turn dedup could drop. Counts every repeat occurrence
   * after the first (so the same 160 KB doc fetched 3× contributes 2×160 KB).
   */
  readonly duplicateResidentBytes: number;
  /** Number of tool_result blocks that were exact repeats of an earlier one. */
  readonly duplicateResidentCount: number;
}

/** Serialized byte length of any JSON-able value. */
function bytesOf(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/**
 * Does a tool_result block carry real content worth dedup-keying? Empty/undefined
 * payloads would otherwise all collapse to one key and count as mutual duplicates.
 */
function hasToolResultContent(content: string | unknown[] | undefined): boolean {
  if (typeof content === 'string') return content.length > 0;
  return Array.isArray(content) && content.length > 0;
}

/**
 * Measure the composition of a `messages[]` array.
 *
 * @param messages The agent's API message array (`Agent.messages`).
 * @param opts.lastRealInputTokens The last API-reported input token count, if
 *   known — turns `occupancyTokens`/`overheadTokens` from estimate into truth.
 * @param opts.charsPerToken Chars-per-token estimate (default 3.5, matching the
 *   agent's `CHARS_PER_TOKEN`).
 */
export function computeComposition(
  messages: readonly BetaMessageParam[],
  opts?: { lastRealInputTokens?: number | undefined; charsPerToken?: number | undefined },
): CompositionSnapshot {
  const charsPerToken = opts?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;

  let totalBytes = 0;
  let userText = 0;
  let assistantText = 0;
  let toolUse = 0;
  let toolResult = 0;
  let image = 0;
  let attributed = 0; // sum of per-block bytes, to derive the structural remainder

  // tool_use_id → tool name, so a tool_result (which carries only the id) can be
  // grouped by the tool that produced it.
  const toolNameById = new Map<string, string>();
  const toolResultByTool = new Map<string, { bytes: number; count: number }>();

  // Verbatim dedup: a serialized tool_result content already seen in an EARLIER
  // tool_result is a resident duplicate. The key set is bounded by context size.
  const seenContentKeys = new Set<string>();
  let duplicateResidentBytes = 0;
  let duplicateResidentCount = 0;

  // First pass: map every tool_use id → name (a tool_result can precede or follow
  // its tool_use in pathological arrays, so resolve names up front).
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') toolNameById.set(block.id, block.name);
    }
  }

  for (const msg of messages) {
    totalBytes += bytesOf(msg);
    const role = msg.role;

    if (typeof msg.content === 'string') {
      const n = bytesOf(msg.content);
      attributed += n;
      if (role === 'assistant') assistantText += n;
      else userText += n;
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      const n = bytesOf(block);
      attributed += n;
      switch (block.type) {
        case 'text':
          if (role === 'assistant') assistantText += n;
          else userText += n;
          break;
        case 'tool_use':
          toolUse += n;
          break;
        case 'tool_result': {
          toolResult += n;
          const tool = toolNameById.get(block.tool_use_id) ?? 'unknown';
          const bucket = toolResultByTool.get(tool) ?? { bytes: 0, count: 0 };
          bucket.bytes += n;
          bucket.count += 1;
          toolResultByTool.set(tool, bucket);
          // Verbatim-duplicate detection keys on the SERIALIZED content, so a doc
          // fetched twice is caught regardless of payload shape (string, or
          // array of text + image blocks) — text-only keying would miss image
          // dups and false-match text-identical/image-differing results. The full
          // block bytes `n` are the addressable ceiling (dedup would replace the
          // whole block with a small reference).
          if (hasToolResultContent(block.content)) {
            const key = JSON.stringify(block.content);
            if (seenContentKeys.has(key)) {
              duplicateResidentBytes += n;
              duplicateResidentCount += 1;
            } else {
              seenContentKeys.add(key);
            }
          }
          break;
        }
        case 'image':
          image += n;
          break;
        default:
          // thinking / redacted_thinking / other blocks → structural remainder
          break;
      }
    }
  }

  const messageTokensEstimate = totalBytes / charsPerToken;
  const occupancyTokens = opts?.lastRealInputTokens;
  const overheadTokens =
    occupancyTokens === undefined ? undefined : Math.max(0, occupancyTokens - messageTokensEstimate);

  const structural = Math.max(0, totalBytes - attributed);

  return {
    messageCount: messages.length,
    totalBytes,
    messageTokensEstimate,
    occupancyTokens,
    overheadTokens,
    categories: { userText, assistantText, toolUse, toolResult, image, structural },
    toolResultByTool: Object.fromEntries(toolResultByTool),
    duplicateResidentBytes,
    duplicateResidentCount,
  };
}
