import type {
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

/**
 * Context hygiene — shared helpers for keeping duplicate tool-result payloads out
 * of the resident context and the blob store.
 *
 * Two consumers share this module so they use the SAME content key (a divergent
 * second hash would silently miss cross-consumer dedup):
 *  - `ToolResultBlobStore.evictFrom` — reuses one blob per identical payload at
 *    compaction time (store-level dedup).
 *  - `Agent._dispatchTools` — replaces a freshly-produced tool_result that is
 *    byte-identical to one already resident with a compact reference, so the
 *    duplicate bytes don't ride every subsequent turn's cached prefix
 *    (append-time in-context dedup).
 */

/**
 * A duplicate tool_result smaller than this isn't worth eliding — the reference
 * text is itself ~200 chars, so eliding sub-2KB payloads saves little and just
 * adds noise. Mirrors the blob-store's own size-gated eviction philosophy.
 */
export const DEFAULT_DEDUP_MIN_CHARS = 2_048;

/**
 * Extract a string payload from a tool_result block's `content`, which the SDK
 * types as `string | Array<text|image block>`. Image blocks are not recallable
 * text, so they are skipped; only the concatenated text survives. Shared so the
 * blob store and the append-time dedup key identical content identically.
 */
export function toolResultText(content: BetaToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('');
}

/**
 * Content key for dedup: the payload length + a fast FNV-1a 32-bit hash. A hash
 * clash is guarded by a payload-equality check at every reuse site, so a
 * collision only ever costs a missed dedup (a duplicate survives), never a wrong
 * reuse (serving/naming the wrong payload). Length-prefixing makes clashes rarer.
 */
export function contentKey(payload: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${payload.length}:${(h >>> 0).toString(36)}`;
}

/** Map every tool_use_id → its tool name across the assistant messages. */
export function toolNameById(messages: readonly BetaMessageParam[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        const useBlock = block as BetaToolUseBlockParam;
        names.set(useBlock.id, useBlock.name);
      }
    }
  }
  return names;
}

/**
 * The deterministic reference that replaces an elided duplicate payload. Terse +
 * timestamp-free on purpose: it becomes part of the stable cached prefix, so its
 * text must never depend on volatile inputs. Names the tool and tells the model
 * how to recover if the earlier copy is later dropped — so the reference is
 * always truthful, never a dangling pointer.
 */
export function buildDedupReference(tool: string): string {
  return `[Duplicate output elided — identical to an earlier ${tool} result already in this context. `
    + `The full payload was returned once above; re-run ${tool} if that copy is no longer visible.]`;
}

/** One resident large tool_result payload, keyed by its content hash. */
export interface ResidentPayload {
  /** Tool that produced it — used to name the reference for a later duplicate. */
  readonly tool: string;
  /** The full payload, kept for the hash-collision equality guard. */
  readonly payload: string;
}

/**
 * Build the residency index from the currently-resident messages: for every
 * non-error tool_result whose text payload exceeds `minChars`, map its content
 * key → the payload (+ producing tool). The FIRST (earliest-resident) occurrence
 * of a given payload wins, so a later duplicate points at the copy that appeared
 * first. Cheap: one FNV pass over the large tool-result payloads only.
 */
export function buildResidencyIndex(
  messages: readonly BetaMessageParam[],
  minChars: number = DEFAULT_DEDUP_MIN_CHARS,
): Map<string, ResidentPayload> {
  const names = toolNameById(messages);
  const index = new Map<string, ResidentPayload>();
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      const rb = block as BetaToolResultBlockParam;
      if (rb.is_error) continue;
      const payload = toolResultText(rb.content);
      if (payload.length <= minChars) continue;
      const key = contentKey(payload);
      if (index.has(key)) continue; // earliest-resident copy wins
      index.set(key, { tool: names.get(rb.tool_use_id) ?? 'tool', payload });
    }
  }
  return index;
}

/**
 * Elide byte-identical duplicate payloads in a freshly-produced tool_result
 * batch, in place. A block whose text payload (> `minChars`) is byte-identical to
 * one already in `index` — resident from an earlier turn OR an earlier block in
 * this same batch — has its content replaced by a compact reference; the first
 * occurrence stays verbatim and is registered so later identical payloads
 * collapse. `is_error` and sub-`minChars` blocks are left untouched.
 *
 * Always-correct by construction: only a byte-identical payload is replaced,
 * only while an identical copy is (or was) resident, and the reference tells the
 * model to re-run the tool if that copy is gone — so it never lies and never
 * loses data. A block with array (image-bearing) content is matched but NOT
 * physically replaced, so an image is never dropped. Returns the number elided.
 *
 * `toolNameFor` resolves a block's producing tool name (via its tool_use_id) for
 * registration, so a future duplicate names the right tool.
 */
export function dedupToolResultBatch(
  results: BetaToolResultBlockParam[],
  toolNameFor: (block: BetaToolResultBlockParam) => string,
  index: Map<string, ResidentPayload>,
  minChars: number = DEFAULT_DEDUP_MIN_CHARS,
): number {
  let elided = 0;
  for (const block of results) {
    if (block.is_error) continue;
    const payload = toolResultText(block.content);
    if (payload.length <= minChars) continue;
    const key = contentKey(payload);
    const existing = index.get(key);
    if (existing !== undefined && existing.payload === payload) {
      // Duplicate. Replace only string content (no image at risk); either way
      // never (re)register — the first occurrence already owns this key.
      if (typeof block.content === 'string') {
        block.content = buildDedupReference(existing.tool);
        elided++;
      }
      continue;
    }
    index.set(key, { tool: toolNameFor(block), payload });
  }
  return elided;
}
