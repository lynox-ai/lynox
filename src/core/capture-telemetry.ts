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
 * mechanism against. The `propose_*` events (once forward-reserved) are ACTIVATED by
 * Onboarding Wave 1 (PRD-ONBOARDING §7): the Layer-1 Faden chips plug into the SAME
 * sink, not a second one. Wave 1 also adds the `onboarding_*` FUNNEL events (flow
 * progress — a step index, never content) so the operator can see via debug-export
 * WHERE an onboarding stalls without reading any of the user's answers. Both ride this
 * sink; the emit-time gate is the CALLER's `enabled` argument (below), not automatic —
 * the Wave-1 emit sites pass the DK flag, which is the natural gate here (onboarding's
 * capture path is the DK chip/queue, so a DK-off instance has no chips to fire — gating
 * the funnel with the same flag is consistent, not a gap).
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
  // The turn-end recovery pass RAN and returned. Emitted whatever it found, including
  // nothing — which is the point. `capture_eligible` fires BEFORE the pass's own guards,
  // and `remember_invoked` only when something was written, so the most common outcome
  // (ran, found nothing) had no event at all: on a live staging run it was impossible to
  // tell a working classifier that judged a turn correctly from a pass that never
  // executed. Carries `facts` = how many it proposed, so FOUR states separate:
  //   no event          = the pass did not run (guarded off, or never reached)
  //   facts ABSENT      = it ran and its provider call failed (timeout/abort/error)
  //   facts 0           = it ran, completed, and judged the turn to hold nothing
  //   facts n           = it ran and proposed n
  // The third and fourth are the ones a rate needs; the second is the one that used to
  // masquerade as the first, because the failure path wrote only to stderr.
  | 'capture_ran'
  | 'remember_invoked'   // the model recorded a durable fact (numerator)
  // propose→confirm→apply — ACTIVATED by Onboarding Wave 1 (Layer-1 Faden chips):
  | 'propose_shown'
  | 'propose_confirmed'
  | 'propose_ignored'
  // onboarding funnel (Wave 1) — flow progress; carries the `step` index, never content:
  | 'onboarding_started'
  | 'onboarding_step_completed'
  | 'onboarding_abandoned';

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
  /** How many facts the recovery pass proposed — only set for `capture_ran`. Zero is a
   *  RESULT, not an absence, and is the reason this field exists as a number rather than
   *  the event being emitted only on a hit. */
  readonly facts?: number | undefined;
  /**
   * WHO recorded it: the model choosing to call `remember` ('model', the default
   * when absent) or the turn-end recovery pass ('capture').
   *
   * Without this the two are one number, and the question the report exists to
   * answer — does the mechanism lift the rate, or did the model start complying —
   * cannot be asked. The field is optional so every line written before it stays
   * readable as what it was: a model-chosen write.
   */
  readonly source?: 'model' | 'capture' | undefined;
  /**
   * The run this event belongs to — the JOIN KEY between the two ends of the fire-rate.
   *
   * Without it the ratio `remember_invoked / capture_eligible` cannot be shown to be a
   * ratio at all: the numerator is emitted from the TOOL HANDLER (any run that has the
   * tool), the denominator only from the turn-end hook, which returns early for a run
   * with no `Memory`, with `skipMemoryExtraction`, or an internal one. Measured on a real
   * sink: **910 numerator events against 0 denominator events** — two populations, one
   * quotient. `runId` is what lets the report say so instead of dividing anyway.
   *
   * An opaque handle, never text — the same class as `thread`/`entryId`, which this sink
   * already carries, and covered by the same S5 rule.
   *
   * Optional because the sink PREDATES it: every line written before this field shipped
   * carries none. Those events are counted in `populations.eventsWithoutRun` rather than
   * joined to nothing, so an old window reads as "cannot tell", not as "disjoint".
   */
  readonly runId?: string | undefined;

  // ── Onboarding Wave 1 additions (PRD-ONBOARDING §7, content rule S5) ──
  // The S5 rule is "entry-IDs + signals only, NEVER the fact text". No field here is
  // INTENDED for content: the payload is opaque entry-ids, enum/numeric classification
  // signals, and the funnel step. The schema does not invite text — but note the free
  // `string` signal fields (`entryId`/`captureSource`/`subjectKind`) are not a hard wall
  // against a caller that deliberately stuffs text into one; keep call sites to ids/enums.
  /** `propose_*`: the knowledge entry-id the chip refers to — an opaque handle, NOT text. */
  readonly entryId?: string | undefined;
  /** `propose_ignored`: true = an active discard, false/absent = a silent ignore. */
  readonly dismissed?: boolean | undefined;
  /** `propose_*`: where the proposal came from (a signal, not content) — e.g.
   *  'web_research' | 'ask_user' | 'scan'. */
  readonly captureSource?: string | undefined;
  /** `propose_*`: the subject kind (person|organization|…) — a classification signal. */
  readonly subjectKind?: string | undefined;
  /** `propose_*`: the DK.3 confidence signal (identity ≥0.9 stable vs attribute 0.45–0.60). */
  readonly confidence?: number | undefined;
  /** `propose_*`: primary (identity) vs secondary (attribute) — the DK.3 tier split. */
  readonly primary?: boolean | undefined;
  /** `onboarding_*`: the funnel step index (no content). */
  readonly step?: number | undefined;
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
