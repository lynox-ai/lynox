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
  /** The genuinely-NEW tail of the agent buffer — `agent.getUnpersistedTail()`.
   *  This is the delta computed by IDENTITY (a persisted high-water-mark that
   *  the agent shifts in lock-step with truncation), NOT by slicing against a
   *  disk-row count. The count-floor slice silently dropped post-compaction /
   *  post-resume assistant turns because after those events the buffer is no
   *  longer a prefix-superset of disk (data-loss in long, compacted chats —
   *  prod export 2026-06-06). */
  delta: BetaMessageParam[];
  /** Called with the number of rows actually appended once the write commits,
   *  so the agent can advance its persisted mark. Not called on noop/error. */
  onPersisted?: ((count: number) => void) | undefined;
}

export type EagerPersistOutcome =
  | { kind: 'noop'; reason: 'no-threadstore' | 'no-new-messages' }
  | { kind: 'appended'; deltaLength: number; newTotal: number }
  | { kind: 'error'; error: Error };

/**
 * Append the agent buffer's unpersisted tail into the ThreadStore. The delta is
 * computed by the agent BY IDENTITY (its persisted high-water-mark), so this
 * helper no longer guesses "what is new" from a row-count floor — the floor
 * assumption ("buffer is a prefix-superset of disk") is false after compaction
 * or a long-thread resume, which is exactly when assistant turns were dropped.
 *
 * Idempotent across the eager-checkpoint + end-of-run double-fire: once the
 * first call advances the agent's mark, the second sees an empty delta and
 * no-ops. Returns an outcome enum instead of throwing — callers are
 * fire-and-forget by contract, but a typed outcome makes the helper testable.
 */
export function persistAgentMessages(input: EagerPersistInput): EagerPersistOutcome {
  const { threadStore, sessionId, delta, onPersisted } = input;
  if (!threadStore) return { kind: 'noop', reason: 'no-threadstore' };

  try {
    if (delta.length === 0) {
      return { kind: 'noop', reason: 'no-new-messages' };
    }

    // message_count tracks ALL rows (API + B-full display-only); new seqs start
    // at MAX(seq)+1 (crash-safe, deletion-safe) so they sort after any
    // interleaved display note AND after the full pre-compaction history that
    // stays on disk. Combined append + message_count rollup in one transaction
    // — one fsync under WAL per checkpoint.
    const totalCount = threadStore.getMessageCount(sessionId);
    const seqFloor = threadStore.getNextSeq(sessionId);
    threadStore.appendMessages(sessionId, delta, seqFloor, {
      message_count: totalCount + delta.length,
    });
    onPersisted?.(delta.length);
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
    threadStore.appendDisplayNotes(sessionId, notes, threadStore.getNextSeq(sessionId));
    threadStore.updateThread(sessionId, { message_count: totalCount + notes.length });
    return { kind: 'persisted', appended: notes.length, flipped: footprint.marked };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}

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
      threadStore.getNextSeq(sessionId),
    );
    threadStore.updateThread(sessionId, { message_count: totalCount + 1 });
    return true;
  } catch {
    return false;
  }
}
