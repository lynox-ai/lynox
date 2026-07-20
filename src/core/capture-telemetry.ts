import { appendBoundedJsonl } from './bounded-jsonl-log.js';

/**
 * Durable-knowledge CAPTURE telemetry — the measure-first substrate for the
 * capture-architecture rework (DEF-dk-capture-observability).
 *
 * The DK canary showed `knowledge_entries` = 0 despite the flag being on — and
 * there was NO metric to see it: no propose/fire/confirm rate, an ignored write
 * left no trace. This sink makes the capture gap a NUMBER. It logs the two ends
 * of the ratio that matters:
 *   - `capture_eligible` — a turn ended where capture COULD happen (the
 *     denominator). Emitted exactly where the legacy per-turn extraction is gated
 *     off under the DK flag, so it counts the same moments capture used to run.
 *   - `remember_invoked` — the model actually recorded a durable fact (the
 *     numerator), with the store outcome (active / pending_review / deduped).
 * Fire-rate = remember_invoked / capture_eligible answers "why is capture dead?"
 * on the deployed model, and becomes the baseline the tuning-walk measures a new
 * mechanism against. The forward events (`propose_*`) are reserved so the coming
 * propose→confirm→apply primitive plugs into the SAME sink, not a second one.
 *
 * Design (mirrors `context-cost-log.ts`):
 *  - Gated on the DK flag (`durable_memory_enabled`): logs only where we measure
 *    (the canary); byte-identical no-op everywhere else. One boolean at the site.
 *  - Best-effort: every error is swallowed — capture telemetry that crashes a
 *    chat is worse than no telemetry. Callers do `void appendCaptureTelemetry(...)`.
 *  - Bounded + deploy-safe: rides the shared size-rotation in `bounded-jsonl-log`,
 *    written next to `agent-memory.db` in the persistent data dir (writable in the
 *    managed read-only container).
 */

export const CAPTURE_TELEMETRY_LOG_FILE = 'capture-telemetry.jsonl';

export type CaptureEvent =
  | 'capture_eligible'   // a capture-eligible turn ended (denominator)
  | 'remember_invoked'   // the model recorded a durable fact (numerator)
  // reserved — the coming propose→confirm→apply primitive shares this sink:
  | 'propose_shown'
  | 'propose_confirmed'
  | 'propose_ignored';

/** The store outcome of a capture write, when the event is `remember_invoked`.
 *  Mirrors `KnowledgeStatus` (active/pending_review/rejected/superseded) + the
 *  `deduped` no-op the write path returns instead of a status. */
export type CaptureOutcome = 'active' | 'pending_review' | 'rejected' | 'superseded' | 'deduped';

/** One persisted capture-telemetry line. */
export interface CaptureTelemetryEntry {
  /** Epoch millis at the event. */
  readonly ts: number;
  readonly event: CaptureEvent;
  /** Thread the turn belongs to, if known. */
  readonly thread: string | undefined;
  /** The resolved main-chat model id for the turn — the whole point is per-model rate. */
  readonly model: string | undefined;
  /** Whether the turn ingested untrusted external content (routes a write to review). */
  readonly untrusted: boolean;
  /** Store outcome — only set for `remember_invoked`. */
  readonly outcome?: CaptureOutcome | undefined;
}

/**
 * Append one capture-telemetry line, gated on the DK flag. Fire-and-forget:
 * `void appendCaptureTelemetry(enabled, {...})` — never awaited, never throws.
 * When `enabled` is false this is a synchronous no-op (returns a resolved
 * promise) so the call site stays a single cheap boolean when DK is off.
 */
export function appendCaptureTelemetry(enabled: boolean, entry: CaptureTelemetryEntry): Promise<void> {
  if (!enabled) return Promise.resolve();
  return appendBoundedJsonl(CAPTURE_TELEMETRY_LOG_FILE, entry);
}
