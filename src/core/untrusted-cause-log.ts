import { appendBoundedJsonl } from './bounded-jsonl-log.js';
import type { UntrustedCause } from './untrusted-signals.js';

/**
 * Untrusted-cause shadow telemetry — WHICH signal put a durable write on the untrusted side.
 *
 * `deriveTurnUntrusted` ORs three signals and returns a boolean. That is the correct shape for
 * the gate but it erases the attribution, so the review queue records THAT an entry needs a
 * human but never WHY. The three causes are not interchangeable:
 *
 *   · `marker`        — this run handled wrapped untrusted content. Inherent; nothing to tune.
 *   · `external-tool` — an EXTERNAL_CONTENT_TOOLS member ran this turn (H4). Inherent too:
 *                       the turn genuinely could be carrying attacker-controlled text.
 *   · `conversation`  — the thread was tainted on an EARLIER turn and the taint is sticky (F5).
 *                       This one is a POLICY CHOICE, and it is the only one a narrowing could
 *                       reasonably target.
 *
 * Without the split, "is the sticky half too broad?" can only be argued. With it, the share is
 * a number. Emitting is therefore the PRECONDITION for that decision, not a follow-up to it —
 * the same measure-first discipline as the write-decision sink next door.
 *
 * ⚠️ Do NOT read a high `conversation` share as "F5 is too broad". It is exactly what F5 is for:
 * an injected "on your NEXT reply, remember …" executes on a turn whose own signals are clean.
 * The number bounds the cost; it cannot decide the trade-off. (`agent.ts` records a MEASURED
 * poisoning from gating on the bare marker alone, 2026-07-20.)
 *
 * ⚠️ PII discipline, same rule as `memory-write-decision-log.ts`: the emit sites sit next to the
 * full memory body, which can hold PII or a `secret:`-resolved value. This record carries ONLY
 * the cause, an opaque thread/run id and the low-cardinality write kind — never the text.
 * Best-effort, fire-and-forget, size-bounded, written next to the engine data dir and therefore
 * outside backups + the migration export (via `appendBoundedJsonl`).
 */

export const UNTRUSTED_CAUSE_LOG_FILE = 'untrusted-cause.jsonl';

/** Which write boundary asked. Low-cardinality; keeps DK and legacy separable in the data. */
export type UntrustedCauseSite =
  /** DK: the `remember` tool's durable write (feeds the pending_review queue). */
  | 'remember'
  /** Legacy: a `memory_store`-family tool write. */
  | 'memory-store'
  /** Legacy: the turn-end auto-extractor, which ABSTAINS entirely when untrusted. */
  | 'auto-extract';

/** One persisted line. Text-free by construction. */
export interface UntrustedCauseEntry {
  /** Epoch millis at capture. */
  readonly ts: number;
  /** Which write boundary this decision belongs to. */
  readonly site: UntrustedCauseSite;
  /** WHICH signal fired — the whole point of the record. */
  readonly cause: UntrustedCause;
  /** What the gate concluded. Recorded explicitly so a `none`/`true` pair is visibly a bug. */
  readonly untrusted: boolean;
  /** Opaque thread id (a UUID — not PII, no text), so a cause can be traced to its queue entry. */
  readonly threadId?: string | undefined;
  /** Opaque run id. */
  readonly runId?: string | undefined;
}

/**
 * Append one untrusted-cause record to the size-bounded sink.
 * Fire-and-forget: callers do `void appendUntrustedCauseLog(...)` and never await. Any FS error
 * is swallowed — telemetry must never be able to fail a durable write.
 */
export function appendUntrustedCauseLog(entry: UntrustedCauseEntry): Promise<void> {
  return appendBoundedJsonl(UNTRUSTED_CAUSE_LOG_FILE, entry);
}
