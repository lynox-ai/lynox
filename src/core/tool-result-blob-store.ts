import type {
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

/**
 * Phase 2 — Context Hygiene. Default blob threshold in characters.
 *
 * A tool result whose serialized payload exceeds this size is "evicted" into
 * the blob store at compaction time instead of being summarized away. 4 KB
 * mirrors the `max_tool_result_chars` knob pattern and is small enough that an
 * accumulation of mid-size results (API dumps, file reads, search results) all
 * become recallable rather than lost.
 */
export const DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS = 4_096;

/**
 * Max number of retained blobs across compaction windows. Beyond this the
 * least-recently-used blobs are evicted. Replaces the old clear-on-every-
 * compaction as one half of the memory bound.
 *
 * Raised 64 → 128 for L1 cost-aware compaction (PRD engine-context-cost): L1
 * makes compaction fire more often (at the ~150K cost budget, not ~800K of a
 * large window), which mints more blob windows against this cap → older tool
 * results would be pruned before `recall_tool_result` could fetch them. Doubling
 * the cap keeps the recall safety net intact under more-frequent compaction.
 */
export const DEFAULT_BLOB_STORE_MAX_ENTRIES = 128;

/**
 * Max total retained payload bytes across compaction windows. 16 MB (the dominant
 * half of the memory bound — a few huge dumps hit the byte cap before the entry
 * count). Raised 8 → 16 MB alongside the entry cap for L1 (see above): more
 * frequent compaction retains more tool-result payload that must stay recallable.
 */
export const DEFAULT_BLOB_STORE_MAX_BYTES = 16 * 1_024 * 1_024;

/** One retained tool result, keyed by a short stable id in the blob store. */
export interface ToolResultBlob {
  /** Tool name the result came from (e.g. `http_request`) — best-effort. */
  readonly tool: string;
  /** One-line human-readable handle shown in the post-compaction context. */
  readonly descriptor: string;
  /** The full verbatim tool-result payload. */
  readonly payload: string;
}

/**
 * Extract a string payload from a tool_result block's `content`, which the SDK
 * types as `string | Array<text|image block>`. Image blocks are not recallable
 * text, so they are skipped; only the concatenated text survives.
 */
function toolResultText(content: BetaToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('');
}

/** Build a compact one-line descriptor from the tool name + payload head. */
function buildDescriptor(tool: string, payload: string): string {
  const head = payload
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const sizeKb = (payload.length / 1024).toFixed(1);
  return `${tool} result · ${sizeKb} KB · ${head}${payload.length > 80 ? '…' : ''}`;
}

/**
 * ToolResultBlobStore — makes large tool results survivable across a
 * compaction reset.
 *
 * The problem: `Session.compact()` summarizes the conversation into prose and
 * then fully resets `messages`. Every verbatim tool result is permanently
 * gone — the agent can never re-read an API response or file dump it fetched
 * before the summary.
 *
 * The mechanism: just before `compact()` calls `reset()`, it scans the live
 * messages for tool-result blocks whose payload exceeds the configured
 * threshold and moves each into this store under a short stable id. The
 * post-compaction synthetic context lists those ids with a one-line
 * descriptor, and the `recall_tool_result` builtin re-fetches a payload by id.
 *
 * Lifetime: blobs are CARRIED FORWARD across compaction windows. A blob stays
 * recallable through multiple compactions (a long chat can recall a file dump
 * fetched many summaries ago), and `compact()` calls `pruneToCap()` after each
 * eviction so the store still cannot grow unbounded — the least-recently-used
 * blobs are dropped once the entry/byte cap is exceeded. `get()` re-inserts on
 * a hit, so a blob the agent keeps recalling outlives one it set aside and
 * forgot. (Previously the store was cleared at the start of every `compact()`,
 * hard-dropping every blob past a single window — too aggressive for long
 * chats; the LRU cap replaces that as the memory bound.)
 *
 * Owned by the Session and threaded into the main Agent so the
 * `recall_tool_result` tool handler (which only has `agent` access) can read
 * it — mirrors the `sessionCounters` ownership pattern.
 */
export class ToolResultBlobStore {
  private readonly blobs = new Map<string, ToolResultBlob>();
  private seq = 0;
  /** Running sum of retained payload bytes — the byte half of the LRU cap. */
  private totalBytes = 0;

  /** Number of retained blobs. */
  get size(): number {
    return this.blobs.size;
  }

  /** Total retained payload bytes (test/observability hook). */
  get bytes(): number {
    return this.totalBytes;
  }

  /**
   * Retrieve a retained blob by id, or undefined if dropped / never existed.
   * On a hit the entry is re-inserted (moved to the end of the map) so it
   * counts as most-recently-used: a blob the agent keeps recalling is the last
   * to be LRU-evicted when `pruneToCap()` runs.
   */
  get(id: string): ToolResultBlob | undefined {
    const blob = this.blobs.get(id);
    if (blob === undefined) return undefined;
    this.blobs.delete(id);
    this.blobs.set(id, blob);
    return blob;
  }

  /** All retained blobs in insertion order, paired with their ids. */
  entries(): Array<{ id: string; blob: ToolResultBlob }> {
    return [...this.blobs.entries()].map(([id, blob]) => ({ id, blob }));
  }

  /**
   * Empty the store. Called at the start of every `compact()` so blobs from
   * the previous compaction window are hard-dropped before the new window's
   * blobs are evicted in — this is the once-per-compaction memory bound.
   */
  clear(): void {
    this.blobs.clear();
    this.totalBytes = 0;
  }

  /**
   * Bound the store after eviction by dropping the least-recently-used blobs
   * until it fits within `maxEntries` AND `maxBytes`. This REPLACES the old
   * clear-on-every-compaction as the memory bound: blobs survive across
   * compaction windows (so a recall works two+ compactions later), but the
   * store can still never grow without limit. Map iteration is insertion order
   * and `get()` re-inserts on a hit, so the front of the map is the least-
   * recently used — exactly what we evict first.
   */
  pruneToCap(
    maxEntries: number = DEFAULT_BLOB_STORE_MAX_ENTRIES,
    maxBytes: number = DEFAULT_BLOB_STORE_MAX_BYTES,
  ): void {
    for (const [id, blob] of this.blobs) {
      if (this.blobs.size <= maxEntries && this.totalBytes <= maxBytes) break;
      this.blobs.delete(id);
      this.totalBytes -= blob.payload.length;
    }
  }

  /** Mint the next short stable id. Ids are unique within a store instance. */
  private nextId(): string {
    this.seq += 1;
    return `tr-${this.seq}`;
  }

  /**
   * Scan `messages` for tool-result blocks whose payload exceeds
   * `thresholdChars` and move each into the store. Returns the minted handles
   * so the caller can list them in the post-compaction synthetic context.
   *
   * Eviction is read-only with respect to `messages` — the caller resets the
   * history immediately afterwards, so there is no need to rewrite blocks in
   * place. The tool name is recovered by pairing each tool_result's
   * `tool_use_id` against tool_use blocks in preceding assistant messages.
   */
  evictFrom(
    messages: readonly BetaMessageParam[],
    thresholdChars: number,
  ): Array<{ id: string; descriptor: string }> {
    // Map tool_use_id → tool name from every assistant tool_use block.
    const toolNameById = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          const useBlock = block as BetaToolUseBlockParam;
          toolNameById.set(useBlock.id, useBlock.name);
        }
      }
    }

    const handles: Array<{ id: string; descriptor: string }> = [];
    for (const msg of messages) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue;
        const resultBlock = block as BetaToolResultBlockParam;
        const payload = toolResultText(resultBlock.content);
        if (payload.length <= thresholdChars) continue;
        const tool = toolNameById.get(resultBlock.tool_use_id) ?? 'tool';
        const id = this.nextId();
        const descriptor = buildDescriptor(tool, payload);
        this.blobs.set(id, { tool, descriptor, payload });
        this.totalBytes += payload.length;
        handles.push({ id, descriptor });
      }
    }
    return handles;
  }
}
