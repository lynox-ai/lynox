// Pure helper for the eager-persist hook fired by the agent loop. Without
// this checkpoint, a container restart or OOM kill mid-loop drops every
// turn since the last completed run-end (rafael prod 2026-05-18 incident).
// Extracted from `Session._persistMessages` so the contract is unit-testable.

import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type { ThreadStore } from './thread-store.js';
import { buildDisplayNoteContent, sanitizeNoteDetail } from './render-projection.js';
import { getErrorMessage } from './utils.js';

export interface EagerPersistInput {
  /** `null` mirrors `engine.getThreadStore()`'s return type — engine has no
   *  thread store wired (e.g. CLI-mode without persistence). */
  threadStore: ThreadStore | null;
  sessionId: string;
  allMessages: BetaMessageParam[];
}

export type EagerPersistOutcome =
  | { kind: 'noop'; reason: 'no-threadstore' | 'no-new-messages' }
  | { kind: 'shrink-skip'; bufferLength: number; floorLength: number }
  | { kind: 'appended'; deltaLength: number; newTotal: number }
  | { kind: 'error'; error: Error };

/**
 * Append any new messages from the in-memory buffer into the ThreadStore.
 * Idempotent: re-reads `getMessageCount` fresh on every call, so duplicate
 * fires (eager checkpoint + end-of-run persist) are no-ops.
 *
 * Returns an outcome enum instead of throwing — callers are fire-and-forget
 * by contract, but a typed outcome makes the helper testable. The Session
 * wrapper ignores the outcome; tests inspect it.
 */
export function persistAgentMessages(input: EagerPersistInput): EagerPersistOutcome {
  const { threadStore, sessionId, allMessages } = input;
  if (!threadStore) return { kind: 'noop', reason: 'no-threadstore' };

  try {
    // `agent.messages` only ever holds API messages — B-full display-only
    // rows (failed-turn notes) live in SQLite but never in the buffer. So the
    // slice floor + shrink guard compare against the API-row count, while the
    // new rows' seq starts at the TOTAL row count so seqs stay monotonic and
    // never collide with an interleaved display note. The two counts are
    // identical until a failed turn has persisted its first note.
    const apiCount = threadStore.getApiMessageCount(sessionId);
    const totalCount = threadStore.getMessageCount(sessionId);

    // In-memory buffer below SQLite floor means `_truncateHistory` ran and
    // dropped earlier messages from the agent's view. SQLite still owns the
    // full history — disk truth wins. Log once at warn-level so a divergent
    // thread doesn't go silently stale, then skip.
    if (allMessages.length < apiCount) {
      console.warn(
        `[session] in-memory buffer (${String(allMessages.length)}) shorter than persisted API floor (${String(apiCount)}) for thread ${sessionId} — skipping eager persist; disk remains source of truth`,
      );
      return { kind: 'shrink-skip', bufferLength: allMessages.length, floorLength: apiCount };
    }

    if (allMessages.length === apiCount) {
      return { kind: 'noop', reason: 'no-new-messages' };
    }

    const delta = allMessages.slice(apiCount);
    // Combined append + message_count rollup in one transaction — one fsync
    // under WAL per checkpoint instead of two. message_count tracks all rows
    // (API + display) so the thread list / "N messages" count stays accurate.
    threadStore.appendMessages(sessionId, delta, totalCount, {
      message_count: totalCount + delta.length,
    });
    return { kind: 'appended', deltaLength: delta.length, newTotal: totalCount + delta.length };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}

export interface FailedTurnDisplayInput {
  threadStore: ThreadStore | null;
  sessionId: string;
  /** ThreadStore message count captured BEFORE the run — the seq floor of the
   *  failed run's footprint. */
  startSeq: number;
  /** The failed turn's original user content (string or multimodal blocks). */
  task: unknown;
  /** The error that aborted the run. */
  error: unknown;
}

export type FailedTurnDisplayOutcome =
  | { kind: 'noop'; reason: 'no-threadstore' }
  | { kind: 'persisted'; appended: number; flipped: number }
  | { kind: 'error'; error: Error };

/**
 * B-full: persist a failed turn as DISPLAY-ONLY rows so it survives reload
 * without lingering in the model's API context. Mirrors the agent's in-memory
 * rollback on disk: (1) flip any rows this run eager-persisted to display-only,
 * (2) ensure the failed user message survives in display history (only if it
 * wasn't already persisted + flipped), (3) append a structured, localizable
 * failure note. Extracted from `Session.run`'s catch so both `hadUserMessage`
 * branches are unit-testable. Fire-and-forget by contract; returns an outcome
 * enum for tests only.
 */
/**
 * Persist a visible, display-only marker recording that the conversation was
 * compacted (history summarized to free context). Without it, compaction is
 * invisible on reload/export — the user sees the agent silently "lose" the
 * earlier conversation (lynox marktanalyse transcript, 2026-06-03). The marker
 * is display_only=1 so it renders as a banner but never re-enters API context.
 * Returns whether a marker was appended (tests inspect it; Session ignores it).
 */
export function persistCompactionMarker(
  threadStore: ThreadStore | null,
  sessionId: string,
): boolean {
  if (!threadStore) return false;
  try {
    const totalCount = threadStore.getMessageCount(sessionId);
    threadStore.appendDisplayNotes(
      sessionId,
      [{ role: 'assistant', content: buildDisplayNoteContent('context_compacted') }],
      totalCount,
    );
    threadStore.updateThread(sessionId, { message_count: totalCount + 1 });
    return true;
  } catch {
    return false;
  }
}

export function persistFailedTurnDisplay(input: FailedTurnDisplayInput): FailedTurnDisplayOutcome {
  const { threadStore, sessionId, startSeq, task, error } = input;
  if (!threadStore) return { kind: 'noop', reason: 'no-threadstore' };
  try {
    const footprint = threadStore.markDisplayOnlyFrom(sessionId, startSeq);
    const notes: { role: 'user' | 'assistant'; content: unknown }[] = [];
    if (!footprint.hadUserMessage) notes.push({ role: 'user', content: task });
    notes.push({
      role: 'assistant',
      content: buildDisplayNoteContent('provider_error', sanitizeNoteDetail(getErrorMessage(error))),
    });
    const totalCount = threadStore.getMessageCount(sessionId);
    threadStore.appendDisplayNotes(sessionId, notes, totalCount);
    threadStore.updateThread(sessionId, { message_count: totalCount + notes.length });
    return { kind: 'persisted', appended: notes.length, flipped: footprint.marked };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}
