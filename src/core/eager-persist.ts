// Pure helper for the eager-persist hook fired by the agent loop. Without
// this checkpoint, a container restart or OOM kill mid-loop drops every
// turn since the last completed run-end (rafael prod 2026-05-18 incident).
// Extracted from `Session._persistMessages` so the contract is unit-testable.

import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type { ThreadStore } from './thread-store.js';

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
    const existingCount = threadStore.getMessageCount(sessionId);

    // In-memory buffer below SQLite floor means `_truncateHistory` ran and
    // dropped earlier messages from the agent's view. SQLite still owns the
    // full history — disk truth wins. Log once at warn-level so a divergent
    // thread doesn't go silently stale, then skip.
    if (allMessages.length < existingCount) {
      console.warn(
        `[session] in-memory buffer (${String(allMessages.length)}) shorter than persisted floor (${String(existingCount)}) for thread ${sessionId} — skipping eager persist; disk remains source of truth`,
      );
      return { kind: 'shrink-skip', bufferLength: allMessages.length, floorLength: existingCount };
    }

    if (allMessages.length === existingCount) {
      return { kind: 'noop', reason: 'no-new-messages' };
    }

    const delta = allMessages.slice(existingCount);
    // Combined append + message_count rollup in one transaction — one fsync
    // under WAL per checkpoint instead of two.
    threadStore.appendMessages(sessionId, delta, existingCount, {
      message_count: allMessages.length,
    });
    return { kind: 'appended', deltaLength: delta.length, newTotal: allMessages.length };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}
