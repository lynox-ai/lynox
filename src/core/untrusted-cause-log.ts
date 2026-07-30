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
 * ⚠️ OPT-IN, like every other sink on this primitive. `bounded-jsonl-log.ts` promises
 * "one flag, one retention story", and all five siblings gate at the CALL SITE
 * (`retrieval_shadow_log`, `context_cost_log`, `appendCaptureTelemetry(enabled,…)`).
 * A first draft of this file gated nothing and would have created a plaintext
 * per-thread write-activity trace on every self-hosted and managed tenant by default,
 * with no off-switch — the header claimed parity with the sibling while omitting that
 * the sibling's rule IS the flag. It rides `retrieval_shadow_log` rather than adding a
 * key, so the promise stays literally one flag.
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
 *
 * @param enabled the tenant's measurement flag (`retrieval_shadow_log`). Off ⇒ no file is
 *   ever created, which is the default posture on every tenant.
 * Fire-and-forget: callers do `void appendUntrustedCauseLog(...)` and never await. Any FS error
 * is swallowed — telemetry must never be able to fail a durable write.
 */
export function appendUntrustedCauseLog(enabled: boolean, entry: UntrustedCauseEntry): Promise<void> {
  if (!enabled) return Promise.resolve();
  return appendBoundedJsonl(UNTRUSTED_CAUSE_LOG_FILE, entry);
}
