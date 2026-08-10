import type {
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaImageBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { contentKey, toolResultText, toolCallsById } from './tool-result-hygiene.js';
import { maskSecretPatterns } from './secret-store.js';
import { containsUntrustedMarker, wrapUntrustedData } from './data-boundary.js';

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
  /** The identifying call argument this descriptor was built from, so a REUSED
   *  blob can detect that a second call had a different one (see `evictFrom`). */
  readonly ident: string;
}

/**
 * Input keys that IDENTIFY which call a result came from, in preference order.
 *
 * An allowlist of key NAMES rather than a per-tool map. It excludes the
 * payload-carrying arguments (`content`, `body`, `text`) by construction, so no
 * tool can push its written file into the descriptor. `command` is included —
 * for a `bash` result "npm test" is exactly the label you want.
 *
 * The trade: a tool whose identifying argument uses an unlisted name (say
 * `endpoint`) degrades SILENTLY to the bare tool label. That is the safe
 * direction — no label beats a wrong one — but it does mean this list needs a
 * look when a tool introduces a new argument shape.
 */
const IDENTIFYING_INPUT_KEYS = [
  'url', 'path', 'file_path', 'query', 'q', 'command',
  'collection', 'namespace', 'name', 'id',
] as const;

/** Max chars of the identifying argument kept in a descriptor. */
const MAX_IDENT_CHARS = 120;

/**
 * Query-parameter name WORDS whose value is a credential. `maskSecretPatterns`
 * only knows vendor-shaped tokens (`sk-ant-…`, `ghp_…`, AWS/Google keys); an
 * opaque `?access_token=<40 random chars>` matches none of them, so the
 * descriptor needs this second, name-based pass.
 *
 * Matched per WORD, not as a substring — a substring test redacts `?design=`,
 * `?assignee=` and `?signal_strength=` because they all contain "sig", which
 * destroys exactly the useful labels this descriptor exists to provide.
 */
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  'token', 'secret', 'signature', 'sig', 'password', 'passwd', 'pwd',
  'auth', 'credential', 'credentials', 'jwt', 'bearer', 'apikey', 'accesskey',
]);

/** Compound forms that only read as credentials when joined (`api_key`, not `key`). */
const CREDENTIAL_COMPOUND_RE = /(api|access|secret|private|auth)[-_]?key/i;

/** Split a parameter name into lowercase words: `accessToken`, `X-Amz-Signature`, `api_key`. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

function isCredentialParam(key: string): boolean {
  if (CREDENTIAL_COMPOUND_RE.test(key)) return true;
  const words = keyWords(key);
  // Bare `key` is a credential only as the WHOLE name (`?key=` on Google APIs);
  // as a word it would swallow `?sort_key=`.
  if (words.length === 1 && words[0] === 'key') return true;
  return words.some(w => CREDENTIAL_WORDS.has(w));
}

/**
 * Redact the credential-bearing parts of an identifying argument.
 *
 * This matters more than the usual masking call because the descriptor OUTLIVES
 * its source: it is re-rendered into the post-compaction seed, where the
 * original `tool_use` block no longer exists. A token that rides along here is
 * RE-INTRODUCED into context by the very mechanism meant to shrink it — and it
 * then reappears at every later compaction.
 *
 * Three vectors, all verified unmasked by `maskSecretPatterns` alone:
 * URL userinfo (`https://admin:pw@host`), credential-named query params
 * (`?access_token=…`, `?sig=…`), and vendor tokens (which masking does catch).
 */
function redactIdent(raw: string): string {
  let value = raw;
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (isCredentialParam(key)) url.searchParams.set(key, '***');
    }
    value = url.toString();
  } catch {
    // Not a URL (a path, a shell command, a query string) — masking still applies.
  }
  return maskSecretPatterns(value);
}

/**
 * Pick the argument that says WHICH call this was. Returns '' when the input has
 * no recognised identifying key — the descriptor then degrades to the bare
 * tool label rather than guessing.
 */
function identifyingArg(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '';
  const rec = input as Record<string, unknown>;
  for (const key of IDENTIFYING_INPUT_KEYS) {
    const value = rec[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const flat = redactIdent(value).replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    return flat.length > MAX_IDENT_CHARS ? `${flat.slice(0, MAX_IDENT_CHARS)}…` : flat;
  }
  return '';
}

/**
 * Bound on the payload prefix flattened for the excerpt. The excerpt keeps 80
 * chars, so flattening the whole payload (up to the blob threshold — hundreds of
 * KB) allocates a full second copy to throw away all but the head.
 */
const HEAD_SCAN_CHARS = 4_096;

/**
 * Build a compact one-line descriptor: tool, the identifying argument, size, and
 * a head excerpt.
 *
 * This line is the ONLY thing the agent sees in place of an evicted payload, so
 * it has to answer "do I need this back?". A descriptor that cannot distinguish
 * two results makes forgetting SILENT — `recall_tool_result` exists, but the
 * agent has no basis to call it, and eviction becomes information loss however
 * conservative the eviction policy is. The ARGUMENT is what carries that signal.
 *
 * The excerpt is deliberately the raw payload head, framing included. An earlier
 * revision skipped the `<untrusted_data>` wrapper and HTTP header block to
 * surface the page's own title, and review found three reasons that was wrong:
 *  1. `Agent._contextHoldsUntrustedMarker()` re-derives the conversation's
 *     untrusted taint by scanning context for that literal marker. The wrapper
 *     text in this excerpt is the ONLY copy left after a compaction, so skipping
 *     it silently DISARMED the durable-write gate — later `remember` writes
 *     derived from fetched pages were recorded as trusted.
 *  2. The seed renders descriptors as unwrapped assistant text, so surfacing the
 *     page's first body chars puts attacker-controlled prose into agent voice.
 *  3. It did not even work on the path that matters: when injection IS detected,
 *     `wrapUntrustedData` prepends a `⚠ WARNING:` line, so hostile pages went
 *     back to byte-identical excerpts.
 * Keeping the raw head costs nothing — the argument already distinguishes the
 * calls, which was the whole point.
 */
function buildDescriptor(tool: string, payload: string, ident: string): string {
  const sizeKb = (payload.length / 1024).toFixed(1);
  const label = ident ? `${tool}(${ident})` : `${tool} result`;

  const head = payload.slice(0, HEAD_SCAN_CHARS).replace(/\s+/g, ' ').trim();
  const excerpt = head.slice(0, 80);
  // More to come if the flattened prefix already overflows, or if we only looked
  // at a prefix of a longer payload.
  const suffix = head.length > 80 || payload.length > HEAD_SCAN_CHARS ? '…' : '';

  return excerpt
    ? `${label} · ${sizeKb} KB · ${excerpt}${suffix}`
    : `${label} · ${sizeKb} KB`;
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
    // Map tool_use_id → {name, input} from every assistant tool_use block. The
    // name labels the result; the input says WHICH call it stands for.
    const toolCalls = toolCallsById(messages);

    const handles: Array<{ id: string; descriptor: string }> = [];
    for (const msg of messages) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue;
        const parked = this.park(block as BetaToolResultBlockParam, toolCalls, thresholdChars);
        if (parked) handles.push({ id: parked.id, descriptor: parked.descriptor });
      }
    }
    return handles;
  }

  /**
   * Park one oversized tool_result into the store and return its handle, or
   * undefined when the payload is under `thresholdChars`.
   *
   * Extracted so `evictFrom` (read-only, compaction) and `collapseIn`
   * (rewrites in place, mid-run) mint handles through ONE code path — the
   * dedup index and the byte accounting must not diverge between them.
   */
  private park(
    resultBlock: BetaToolResultBlockParam,
    toolCalls: ReturnType<typeof toolCallsById>,
    thresholdChars: number,
  ): { id: string; descriptor: string; payloadChars: number } | undefined {
    const payload = toolResultText(resultBlock.content);
    if (payload.length <= thresholdChars) return undefined;
    const call = toolCalls.get(resultBlock.tool_use_id);
    const tool = call?.name ?? 'tool';
    // Dedup: an identical payload already resident reuses its handle instead
    // of minting a second blob. This is what breaks the cross-compaction
    // amplifier — the same file dump re-parked at each compaction now maps
    // to ONE id. `this.get()` promotes the reused blob to most-recently-used
    // (it is being referenced again). The `payload ===` guard makes a hash
    // clash cost only a missed dedup, never a wrong reuse.
    const ident = identifyingArg(call?.input);
    const key = contentKey(payload);
    const existingId = this.idByContent.get(key);
    if (existingId !== undefined) {
      const existing = this.get(existingId);
      if (existing !== undefined && existing.payload === payload) {
        // ONE blob now stands for TWO different calls (a mirror page, two
        // URLs answering the same 404). Keeping the first call's argument
        // would label this handle with a URL it did not come from — a
        // confidently WRONG label is worse than none, so drop the argument
        // and fall back to the bare tool label when they disagree.
        const descriptor = ident === existing.ident
          ? existing.descriptor
          : buildDescriptor(existing.tool, existing.payload, '');
        return { id: existingId, descriptor, payloadChars: payload.length };
      }
    }
    const id = this.nextId();
    const descriptor = buildDescriptor(tool, payload, ident);
    this.blobs.set(id, { tool, descriptor, payload, ident });
    this.totalBytes += payload.length;
    this.idByContent.set(key, id);
    this.contentById.set(id, key);
    return { id, descriptor, payloadChars: payload.length };
  }

  /**
   * Park oversized tool results AND replace them in place with a one-line
   * recall stub. Unlike `evictFrom` this MUTATES `messages`, because the caller
   * keeps running on the same array instead of resetting it.
   *
   * Why this exists as a distinct entry point: compaction evicts and then wipes
   * the history, so it never needed to rewrite blocks. A run that is about to
   * overflow mid-turn has no such reset — without an in-place rewrite the only
   * remaining lever is `_truncateHistory`'s front-drop, which discards the data
   * outright AND invalidates the cached prefix just the same. Collapsing keeps
   * the payload recallable and frees far more context per prefix invalidation.
   *
   * `skipTailMessages` leaves the newest N messages untouched — the model is
   * mid-reasoning on those, and stubbing the result it just received would make
   * it re-fetch immediately.
   *
   * @returns handles minted plus how many characters were freed.
   */
  collapseIn(
    messages: BetaMessageParam[],
    thresholdChars: number,
    skipTailMessages = 0,
  ): { handles: Array<{ id: string; descriptor: string }>; freedChars: number } {
    const toolCalls = toolCallsById(messages);
    const handles: Array<{ id: string; descriptor: string }> = [];
    let freedChars = 0;

    const limit = Math.max(0, messages.length - skipTailMessages);
    for (let m = 0; m < limit; m++) {
      const msg = messages[m]!;
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      const content = msg.content;
      for (let i = 0; i < content.length; i++) {
        const block = content[i]!;
        if (block.type !== 'tool_result') continue;
        const resultBlock = block as BetaToolResultBlockParam;
        // `park` stores `toolResultText`, which keeps ONLY text blocks. At
        // compaction that is harmless — the history is reset and images are
        // carried separately by `evictImagesFrom`. Here the rewrite is in place,
        // so collapsing a block that holds anything else would delete it from
        // the context AND leave it out of the blob: unrecallable, gone. Skip
        // those instead; a text-only payload is the case that costs context.
        if (!isTextOnlyResult(resultBlock.content)) continue;
        const parked = this.park(resultBlock, toolCalls, thresholdChars);
        if (!parked) continue;
        const payloadWasUntrusted = containsUntrustedMarker(toolResultText(resultBlock.content));
        const stub = recallStub(parked.id, parked.descriptor, payloadWasUntrusted);
        // Preserve `tool_use_id` / `is_error` — dropping either breaks the
        // tool_use↔tool_result pairing the API validates on every request.
        content[i] = { ...resultBlock, content: stub };
        freedChars += Math.max(0, parked.payloadChars - stub.length);
        handles.push({ id: parked.id, descriptor: parked.descriptor });
      }
    }
    return { handles, freedChars };
  }
}

/**
 * The text left behind where a collapsed payload was. It must state the id in
 * the exact shape `recall_tool_result` expects, because this stub is the ONLY
 * place the model learns the handle exists — unlike the compaction path, there
 * is no synthetic seed listing every handle.
 */
export function recallStub(id: string, descriptor: string, wasUntrusted = false): string {
  const stub = `[Full result set aside to free context — ${descriptor}. `
    + `Call recall_tool_result with id "${id}" to read it again.]`;
  // Carry the trust boundary into the replacement. The descriptor happens to
  // start with the payload's first 80 chars, so a wrap that sits at offset 0
  // would survive by accident — but several producers put engine framing first
  // (`mail_read`'s Date/UID/Folder header, `web_research`'s title block), which
  // pushes the marker out of the excerpt. Re-deriving the taint from context
  // (`loadMessages`, reached mid-thread via `setModel`) would then read a
  // collapsed history as clean and disarm the durable-write gate.
  return wasUntrusted && !containsUntrustedMarker(stub)
    ? wrapUntrustedData(stub, 'parked-tool-result')
    : stub;
}

/**
 * Does this tool_result carry text and nothing else? Only then is the blob a
 * complete copy of it — see the call site in `collapseIn`.
 */
function isTextOnlyResult(content: BetaToolResultBlockParam['content']): boolean {
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return content.every(block => block.type === 'text');
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
