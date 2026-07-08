import type {
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaImageBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { contentKey, toolResultText, toolNameById } from './tool-result-hygiene.js';

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

/**
 * Default number of recent user images carried across a compaction (re-attached
 * inline in the post-compaction seed). K=2 keeps the most-recent view(s) the
 * agent is likely still working with, without re-sending the whole image
 * history every turn. See `evictImagesFrom`.
 */
export const DEFAULT_CARRIED_IMAGE_COUNT = 2;

/**
 * Default byte cap (base64 chars) on the total carried-image payload. A carried
 * image is re-attached inline into the post-compaction seed, so it rides the
 * re-sent context every subsequent turn — bound it so a couple of huge uploads
 * can't balloon the post-summary prompt. ~10 MB comfortably holds one or two
 * typical screenshots; older images beyond the cap are dropped (drop-oldest).
 */
export const DEFAULT_CARRIED_IMAGE_MAX_BYTES = 10 * 1_024 * 1_024;

/** One retained tool result, keyed by a short stable id in the blob store. */
export interface ToolResultBlob {
  /** Tool name the result came from (e.g. `http_request`) — best-effort. */
  readonly tool: string;
  /** One-line human-readable handle shown in the post-compaction context. */
  readonly descriptor: string;
  /** The full verbatim tool-result payload. */
  readonly payload: string;
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
  /**
   * Content-dedup index. `idByContent` maps a payload's content-key → the id of
   * the blob already holding it, so an identical payload evicted AGAIN — the
   * same file dump re-parked at the next compaction, or content that was
   * recalled and is now resident twice — reuses the existing blob instead of
   * minting a duplicate. Without this, `evictFrom` mints a fresh id for the same
   * bytes on every compaction, so a heavy multi-compaction thread accumulates
   * duplicate handles + duplicate stored bytes (the observed cross-compaction
   * duplicate-resident amplification). `contentById` is the reverse map so
   * `pruneToCap`/`clear` keep the index consistent without re-hashing.
   */
  private readonly idByContent = new Map<string, string>();
  private readonly contentById = new Map<string, string>();

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
    this.idByContent.clear();
    this.contentById.clear();
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
      const key = this.contentById.get(id);
      if (key !== undefined) {
        this.contentById.delete(id);
        // Only clear the forward entry if it still points at THIS id (dedup
        // guarantees one id per content, but stay defensive).
        if (this.idByContent.get(key) === id) this.idByContent.delete(key);
      }
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
    // Map tool_use_id → tool name from every assistant tool_use block (shared
    // with the append-time dedup so both key the same content the same way).
    const toolNames = toolNameById(messages);

    const handles: Array<{ id: string; descriptor: string }> = [];
    for (const msg of messages) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue;
        const resultBlock = block as BetaToolResultBlockParam;
        const payload = toolResultText(resultBlock.content);
        if (payload.length <= thresholdChars) continue;
        const tool = toolNames.get(resultBlock.tool_use_id) ?? 'tool';
        // Dedup: an identical payload already resident reuses its handle instead
        // of minting a second blob. This is what breaks the cross-compaction
        // amplifier — the same file dump re-parked at each compaction now maps
        // to ONE id. `this.get()` promotes the reused blob to most-recently-used
        // (it is being referenced again). The `payload ===` guard makes a hash
        // clash cost only a missed dedup, never a wrong reuse.
        const key = contentKey(payload);
        const existingId = this.idByContent.get(key);
        if (existingId !== undefined) {
          const existing = this.get(existingId);
          if (existing !== undefined && existing.payload === payload) {
            handles.push({ id: existingId, descriptor: existing.descriptor });
            continue;
          }
        }
        const id = this.nextId();
        const descriptor = buildDescriptor(tool, payload);
        this.blobs.set(id, { tool, descriptor, payload });
        this.totalBytes += payload.length;
        this.idByContent.set(key, id);
        this.contentById.set(id, key);
        handles.push({ id, descriptor });
      }
    }
    return handles;
  }
}

/**
 * Collect the most-recent user `image` blocks so they can be re-attached inline
 * across a compaction (the storage sibling of `evictFrom`, but for images).
 *
 * Unlike tool results, a user image is irreplaceable and cannot be "recalled"
 * through the string-only tool_result channel — so instead of storing a handle,
 * `Session.compact()` re-attaches the returned blocks inline in the
 * post-compaction seed (`buildPostCompactionMessages`). Inline re-attachment
 * means the carried image persists through `content_json` and survives a reload
 * for free, with no durable image store.
 *
 * Read-only with respect to `messages`. Returns at most `maxImages` blocks in
 * chronological order (oldest → newest), bounded by `maxBytes` of total base64
 * payload — walking newest→oldest and stopping once either cap would be
 * exceeded, i.e. keep the most-recent, drop the oldest above the cap. Only
 * inline base64 images are eligible (a `url`/`file` source carries no bytes to
 * preserve). tool_result and text blocks are ignored; string-content user
 * messages (no blocks) are tolerated.
 */
export function evictImagesFrom(
  messages: readonly BetaMessageParam[],
  opts: { maxImages?: number; maxBytes?: number } = {},
): BetaImageBlockParam[] {
  const maxImages = opts.maxImages ?? DEFAULT_CARRIED_IMAGE_COUNT;
  const maxBytes = opts.maxBytes ?? DEFAULT_CARRIED_IMAGE_MAX_BYTES;

  // Every inline base64 user image, in chronological order.
  const all: BetaImageBlockParam[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'image' && block.source.type === 'base64') {
        all.push(block);
      }
    }
  }

  // Keep the most-recent up to `maxImages`, honouring the byte cap (drop-oldest).
  const kept: BetaImageBlockParam[] = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const block = all[i]!;
    if (kept.length >= maxImages) break;
    const size = block.source.type === 'base64' ? block.source.data.length : 0;
    if (bytes + size > maxBytes) break;
    kept.push(block);
    bytes += size;
  }
  kept.reverse(); // restore chronological order (oldest → newest)
  return kept;
}
