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
 * This is a WIRE-side transform: the model context carries the reference, the
 * persisted thread history keeps the original bodies (D4). That split is not
 * free — eviction rewrites the buffer in place, and every persist path appends
 * the buffer tail, so a persist retry on a later turn would write the marker
 * to disk (measured on prod 2026-08-14: five marker rows in one thread). The
 * agent therefore captures each original via `onEvict` and the persist delta
 * restores it via `restoreEvictedBodies` before it is appended. It runs at the
 * two places conversation history enters a turn — `Agent.send` (turn start, so
 * the turn that PRODUCED the save keeps its body until the next one: the model
 * may still be composing follow-up edits against it) and `Agent.loadMessages`
 * (resume hydration, where everything loaded is by definition a past turn).
 *
 * Shape: the evicted call loses its `content` field entirely, and the note
 * saying where the body went is appended to the save's tool_result. Until
 * 2026-10-10 the reference sat IN `content`, and a model copies a field value
 * from its own earlier calls: on a real tenant (2026-10-09) Kimi K3 saved that
 * reference as the document five times. Measured on Kimi K3, a thread with two
 * evicted saves and then a new document (n=15 per arm): reference in `content`
 * 7 placeholder saves, field removed 0 (Fisher p=0.006).
 *
 * Byte-stability: evicting rewrites the call and its result — two adjacent
 * positions, ONE conversation-cache re-write at that point — and then the
 * history is byte-stable again, minus the body that would otherwise be
 * re-written into the cache on every turn. The transform is idempotent (an
 * evicted call has no `content` left to match), so it never oscillates.
 */

/** Bodies at or below this size stay: the one-time cache re-write the eviction
 *  costs outweighs re-sending a small body. */
export const EVICTION_MIN_CHARS = 2048;

/** The reference that stood in `content` until 2026-10-10. Threads persisted
 *  before then can hold it as a call's `content` (a model-made save of it, or
 *  the persist bug of 2026-08-14), so eviction still recognises it. */
const EVICTED_PREFIX = '[evicted after successful save';

const NOTE_PREFIX = '[The body of this document was removed from the conversation';

/** Appended to the tool_result of an evicted save, never put in `content`.
 *  Worded as measured, except "the File: path": an overwrite result also names
 *  the backup of the previous version, below the File: line. */
export const EVICTION_NOTE = `\n${NOTE_PREFIX} to save space. It is persisted; read_file the File: path above if you need it.]`;

const LEGACY_NOTE_PREFIX = '[The content of this call was the engine\'s placeholder';

/** Appended instead when the evicted `content` was the old in-field reference.
 *  Such a call is either a model-made save of the reference, whose file holds no
 *  document, or a row of the 2026-08-14 persist bug, whose file is fine — the
 *  note must not claim either. */
export const LEGACY_EVICTION_NOTE = `\n${LEGACY_NOTE_PREFIX}, not a document. ` +
  'Whether the file holds the document is not known: read_file the File: path above before relying on it.]';

const NOTES = [EVICTION_NOTE, LEGACY_EVICTION_NOTE] as const;

/** Whether `content` carries a reference this module writes in place of a
 *  saved body: the old in-field form or the note. A model can copy either: on
 *  a real tenant (2026-10-09) Kimi K3 saved the in-field form as the document
 *  five times, and two documents never reached disk — each file held ~176 bytes
 *  while the agent reported it finished. The save handler refuses such content.
 *  Anywhere in the body, not only at the start: a copied placeholder under a
 *  heading is the same loss. */
export function containsEvictionMarker(content: string): boolean {
  return content.includes(EVICTED_PREFIX) || content.includes(NOTE_PREFIX) || content.includes(LEGACY_NOTE_PREFIX);
}

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

/** The text the note is appended to / removed from, in either tool_result form. */
type ResultContent = string | unknown[] | undefined;

/** Called once per eviction: a second pass finds no `content` on the call and
 *  never gets here, so the note is not appended twice. */
function withNote(content: ResultContent, note: string): ResultContent {
  if (typeof content === 'string') return content + note;
  if (Array.isArray(content)) return [...content, { type: 'text', text: note.trimStart() }];
  return content;
}

function withoutNote(content: ResultContent): ResultContent {
  for (const note of NOTES) {
    if (typeof content === 'string' && content.endsWith(note)) return content.slice(0, -note.length);
    if (Array.isArray(content)) {
      const last = content[content.length - 1] as { type?: unknown; text?: unknown } | null | undefined;
      if (last?.type === 'text' && last.text === note.trimStart()) return content.slice(0, -1);
    }
  }
  return content;
}

/**
 * Rewrite the tool_results of the given calls with `edit` — the FIRST non-error
 * result per id, the one `collectResults` reads. Returns `messages` itself when
 * nothing changes.
 */
function rewriteResults(
  messages: BetaMessageParam[],
  ids: ReadonlySet<string>,
  edit: (content: ResultContent, id: string) => ResultContent,
): BetaMessageParam[] {
  if (ids.size === 0) return messages;
  const seen = new Set<string>();
  let out: BetaMessageParam[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    let newContent: unknown[] | null = null;
    for (let j = 0; j < msg.content.length; j++) {
      const b = msg.content[j] as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown } | null;
      if (typeof b !== 'object' || b === null) continue;
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string' || b.is_error === true) continue;
      if (!ids.has(b.tool_use_id) || seen.has(b.tool_use_id)) continue;
      seen.add(b.tool_use_id);
      const edited = edit(b.content as ResultContent, b.tool_use_id);
      if (edited === b.content) continue;
      newContent ??= [...msg.content];
      newContent[j] = { ...b, content: edited };
    }
    if (newContent) {
      out ??= [...messages];
      out[i] = { ...msg, content: newContent } as BetaMessageParam;
    }
  }
  return out ?? messages;
}

/**
 * Remove the `content` of every SUCCESSFULLY saved artifact_save input and
 * append `EVICTION_NOTE` to its tool_result. Returns the same array (identity)
 * when nothing changes; otherwise a new array sharing every unchanged message
 * object.
 *
 * Evicted: a body over `EVICTION_MIN_CHARS`, and — at any size — a body that is
 * the old in-field reference, so a thread persisted before the change does not
 * keep showing the model a copyable reference as a value of `content`.
 *
 * `onEvict` (optional) receives the tool_use id and the ORIGINAL body of every
 * eviction performed in this pass — the caller that persists the buffer needs
 * it to undo the rewrite on the persist path (`restoreEvictedBodies`), because
 * the durable transcript must keep the original bodies (D4). Without the
 * callback the original is simply dropped, as before.
 */
export function evictSavedArtifactBodies(
  messages: BetaMessageParam[],
  onEvict?: (toolUseId: string, originalContent: string) => void,
): BetaMessageParam[] {
  const results = collectResults(messages);
  const evicted = new Map<string, string>();
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
      // Also what makes the transform idempotent: an evicted call has no
      // `content` left, so a second pass never matches it again.
      if (typeof content !== 'string') continue;
      if (content.length <= EVICTION_MIN_CHARS && !content.startsWith(EVICTED_PREFIX)) continue;
      const result = results.get(block.id);
      if (result === undefined || !isSuccessfulSaveResult(result)) continue;

      onEvict?.(block.id, content);
      evicted.set(block.id, content.startsWith(EVICTED_PREFIX) ? LEGACY_EVICTION_NOTE : EVICTION_NOTE);
      const { content: _dropped, ...rest } = input as Record<string, unknown>;
      newContent ??= [...msg.content];
      newContent[j] = { ...block, input: rest };
    }

    if (newContent) {
      out ??= [...messages];
      out[i] = { ...msg, content: newContent } as BetaMessageParam;
    }
  }

  return rewriteResults(out ?? messages, new Set(evicted.keys()), (c, id) => withNote(c, evicted.get(id)!));
}

/**
 * The inverse of eviction, for the PERSIST path only: the durable transcript
 * keeps the original bodies (D4), so the persist delta puts back every evicted
 * body the caller still holds the original of (the map `onEvict` filled) and
 * removes the note from its tool_result. Entries whose id no longer appears —
 * body already durable on disk, buffer front-dropped it — are simply never
 * matched, which is the correct outcome: what is on disk stays untouched. A
 * call and its result are restored independently, since the persisted mark can
 * fall between them. Returns the input array identity when nothing is restored.
 */
export function restoreEvictedBodies(
  messages: BetaMessageParam[],
  originals: ReadonlyMap<string, string>,
): BetaMessageParam[] {
  if (originals.size === 0) return messages;
  let out: BetaMessageParam[] | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    let newContent: unknown[] | null = null;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j]!;
      if (!isToolUse(block)) continue;
      const original = originals.get(block.id);
      if (original === undefined) continue;
      const input = block.input;
      if (typeof input !== 'object' || input === null) continue;
      if ('content' in input) continue;

      newContent ??= [...msg.content];
      newContent[j] = { ...block, input: { ...(input as Record<string, unknown>), content: original } };
    }

    if (newContent) {
      out ??= [...messages];
      out[i] = { ...msg, content: newContent } as BetaMessageParam;
    }
  }

  return rewriteResults(out ?? messages, new Set(originals.keys()), withoutNote);
}
