import { appendBoundedJsonl } from './bounded-jsonl-log.js';
import type { UntrustedCause } from './untrusted-signals.js';

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
  // The turn-end hook was reached and returned WITHOUT reaching either path, naming which
  // of its three preconditions returned first (`reason`). It is the level above
  // `capture_ran`: that event separates four outcomes of a pass that RAN, this one separates
  // "the pass did not run" into its causes instead of leaving it as an absence.
  //
  // Why it had to exist: `capture_eligible` fires AFTER these guards, while the `remember`
  // TOOL HANDLER (`knowledge.ts`) fires behind none of them — so a turn cut here left no
  // trace at either end of the fire-rate. The sink could show the two populations disjoint
  // (measured: 910 numerator events against 0 denominator events) and could not say why.
  // `capture-telemetry-report.ts` named these same three as unmeasured; they are now counted.
  //
  // ⚠ The asymmetry belongs to that WRITER, not to the event. Since the recovery pass
  // shipped, `remember_invoked` has TWO writers — the tool handler, behind no guard, and
  // `_captureFallback`, behind all three. An earlier version of this comment said the EVENT
  // fires behind none of them, which is false and would have had a reader treat one number
  // as one population. Two writers of a column are two signals sharing a name; `source`
  // exists precisely so the report can tell them apart.
  //
  // ⚠ This event is NOT a second denominator. It deliberately does not widen
  // `capture_eligible`, whose population has to stay comparable across a before/after
  // window — that is the whole shape of the measurement it serves.
  | 'capture_suppressed'
  | 'remember_invoked'   // the model recorded a durable fact (numerator)
  // propose→confirm→apply — ACTIVATED by Onboarding Wave 1 (Layer-1 Faden chips):
  | 'propose_shown'
  | 'propose_confirmed'
  | 'propose_ignored'
  // onboarding funnel (Wave 1) — flow progress; carries the `step` index, never content:
  | 'onboarding_started'
  | 'onboarding_step_completed'
  | 'onboarding_abandoned';

/**
 * WHY a recovered fact was queued or written, on `remember_invoked` lines with
 * `source: 'capture'`.
 *
 * The turn-level `untrusted` boolean stopped being able to answer this once the recovery
 * pass began routing PER FACT: on an untrusted turn two facts of the same turn can now
 * take different exits, so a reader holding only `untrusted` sees one flag and two
 * outcomes and cannot tell which rule produced which. `outcome` says WHAT happened
 * (`pending_review` / `active`); this says which of the three rules decided it.
 *
 * - `turn_trusted`     — the turn ingested nothing external; no gate applied.
 * - `excerpt_external` — the excerpt itself embeds wrapped third-party text, so the
 *                        extractor's own attribution was NOT consulted (it is written by
 *                        a model reading attacker-reachable content).
 * - `injection_suspected` — the attribution was overridden for the OTHER structural reason:
 *                        the injection detector fired on the excerpt. Its own value rather
 *                        than a second meaning for `excerpt_external`, because a label
 *                        covering two populations cannot say which one moved — the defect
 *                        `cause` exists to prevent, reproduced one level down.
 * - `fact_external`    — attribution consulted, and it said the fact came from quoted
 *                        material. Also the value for a malformed or absent attribution:
 *                        `parseExtractedFacts` resolves anything but a literal
 *                        `'user_stated'` to external, and this label follows it.
 * - `fact_user_stated` — attribution consulted and clean; the fact was written without a
 *                        human check. THE value to watch: it is the only one this change
 *                        newly lets past the queue, so its share IS the narrowing, and a
 *                        precision drop would show up here first.
 */
export type CaptureRouting =
  | 'turn_trusted'
  | 'excerpt_external'
  | 'injection_suspected'
  | 'fact_external'
  | 'fact_user_stated';

/**
 * Which precondition of the turn-end hook returned first, when the event is
 * `capture_suppressed`.
 *
 * The values are the guards in their ORIGINAL short-circuit order, and the reader resolves
 * them in that same order — a turn can satisfy two at once, so a reordering would silently
 * re-label the population rather than change it.
 *
 * `fallback_off` is the one that does NOT belong to the prologue: the turn passed every
 * precondition and emitted `capture_eligible`, then the recovery pass found itself unarmed.
 * It exists because `captureFallback` is opted into at exactly ONE surface (the Web-UI chat
 * endpoint), while `worker-loop.ts` runs scheduled tasks through a non-internal Session that
 * has a `Memory` and therefore DOES count toward the denominator. Those turns had no
 * mechanism and, until this reason existed, said nothing about it — the same silent-exit
 * defect this event was created to end, one level further down.
 *
 * Deliberately NOT emitted for the `_sawRememberCall` exit beside it: that is the healthy
 * case (the model already recorded the fact), and it is already visible as
 * `remember_invoked` with `source: 'model'`. Counting it as a suppression would file a
 * success under a failure heading.
 *
 * `no_memory` is the one worth reading twice: it is a null-check on the LEGACY store object
 * that also gates the DK path, which never touches it. A sub-agent spawned with
 * `isolated_memory: true` gets no `Memory` while still inheriting the DK flag, so it can
 * emit the fire-rate's numerator and never its denominator. That is a mechanism, not yet a
 * diagnosis of any particular sink.
 */
export type CaptureSuppressedReason = 'no_memory' | 'extraction_off' | 'internal_run' | 'fallback_off';

/**
 * The three reasons that fire INSTEAD of `capture_eligible` — the turn never entered the
 * denominator. `fallback_off` is the odd one out and fires AFTER it, so a `fallback_off`
 * turn IS in the denominator. The partition matters when reading the numbers, which is why
 * it is a named constant rather than a sentence someone has to remember.
 */
export const PRE_ELIGIBLE_SUPPRESSED_REASONS: ReadonlySet<CaptureSuppressedReason> =
  new Set<CaptureSuppressedReason>(['no_memory', 'extraction_off', 'internal_run']);

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
  /** How many facts the recovery pass WROTE THROUGH the per-turn ceiling — only set for
   *  `capture_ran`. Zero is a RESULT, not an absence, and is the reason this field exists
   *  as a number rather than the event being emitted only on a hit.
   *  ⚠ ABSENCE is load-bearing since the failure path emits too: no `facts` means the pass
   *  did not COMPLETE. A third emit site must keep that: writing `0` on a failure disguises
   *  an outage as an empty result. */
  readonly facts?: number | undefined;
  /** Well-formed facts the model OFFERED, before the per-turn ceiling — only set for
   *  `capture_ran`. `proposed - facts` is what the ceiling costs, and it is the only way to
   *  see that from production: `facts` alone is capped, so a turn offering nine and a turn
   *  offering four read identically. */
  readonly proposed?: number | undefined;
  /**
   * WHO recorded it: the model choosing to call `remember` ('model') or the turn-end
   * recovery pass ('capture').
   *
   * Without this the two are one number, and the question the report exists to answer —
   * does the mechanism lift the rate, or did the model start complying — cannot be asked.
   *
   * ⚠ ABSENT is NOT 'model'. An earlier version of this docblock called `'model'` "the
   * default when absent", and the writer that should have set it never did — so every
   * model-chosen write ever made carried no source at all, and reading absence as
   * compliance would have counted the entire pre-deploy history as the model complying.
   * The report therefore buckets absence as `unknown` and says so; see `rememberBySource`.
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
  /**
   * WHICH member of the untrusted union fired on this turn — `none` | `marker` |
   * `external-tool` | `conversation`, straight from `describeTurnUntrusted`.
   *
   * Not redundant beside the boolean, and the difference is the whole point. `untrusted` says
   * a turn WAS tainted; `DEF-data-scoped-taint` changes WHICH RULE taints, so a before/after
   * stratified on the boolean compares two populations defined by two different functions
   * sharing one field name. The cause survives that boundary: it names the member, and the
   * member is what the redesign removes.
   *
   * The PRIORITY ORDER of `describeTurnUntrusted` (marker → external-tool → conversation) makes
   * `cause === 'conversation'` imply the other two are false, so that count is exactly the set
   * of turns held tainted by the conversation-sticky latch ALONE.
   *
   * ⚠ What that number is NOT, corrected after an adversarial round refuted the first version.
   * It is **not** an upper bound on what `DEF-data-scoped-taint` would flip. That PRD scopes
   * Part A to engine-written, model-untouched values and says so in as many words — *"Explicitly
   * NOT `remember` (regime B)"* (§5 A1) — while §6 B5 decides *"Do not weaken the latch for
   * regime B."* Every event this field rides is regime B: the model produced the value, or the
   * recovery pass extracted it from the model's output. Under the PRD as written the flip count
   * for this population is ZERO BY SCOPE, so calling the share an upper bound bounds a known
   * zero: true, and empty.
   *
   * What it IS, and this is the useful reading: **the price the regime-B latch charges.**
   * `DEF-data-scoped-taint` carries a `gating` claim that the latch is why capture looks dead
   * fleet-wide. That claim and B5 cannot both stand — if the latch is that expensive, the
   * decision not to weaken it for regime B is the expensive one, and it is B5 that needs
   * re-opening rather than Part A. This share is the number that settles which.
   *
   * ⚠ And it settles ROUTING only. `knowledge-store.ts` maps taint to status with a ternary,
   * so where a write lands is computable from the taint — but the ternary runs per WRITE while
   * this share is per TURN (the pass writes up to four), so the two are not the same quantity.
   * Worse for the "no after-window" claim: the taint is MODEL-VISIBLE. `knowledge.ts` returns a
   * cause-naming string to the model and sends a review chip to the user, so changing the rule
   * changes what both do next. The routing half is predictable; the behavioural half is not,
   * and only a real after-window can carry it.
   *
   * WHO WRITES IT, spelled out because this event family keeps growing a second writer nobody
   * notices. Every writer derives it from `describeTurnUntrusted` over the same agent at the
   * same moment as `untrusted`:
   *   `capture_eligible` — the turn-end hook, once per eligible turn (the denominator).
   *   `capture_ran`      — the recovery pass, at BOTH emit sites (completed and failed).
   *   `remember_invoked` — TWO writers: the `remember` tool handler (`source: 'model'`) and
   *                        the recovery pass (`source: 'capture'`). Both set it.
   *
   * The invariant to pin: `cause === 'none'` ⟺ `untrusted === false`, on every line **that
   * carries a cause**. The scope matters and the first version got it wrong: `http-api.ts`
   * emits `onboarding_step_completed` with an `untrusted` boolean and no cause at all, so a
   * claim over *every* writer is false — and the test cannot see it, because it filters to
   * cause-carrying lines. Within that scope both fields come from one evaluation, derived
   * together and passed down rather than re-read (see `_captureFallback`).
   *
   * ⚠ Deliberately NOT set on `capture_suppressed`, as a decision rather than an oversight.
   * The pre-eligible reasons never enter the denominator, so their cause cannot enter the
   * ratio; and a `fallback_off` turn already emitted `capture_eligible` on the same run, which
   * carries it. Setting it there would add a field with no consumer — the inert-symbol defect
   * this sink has already produced three times.
   *
   * Same data class as `untrusted`: four literals describing the SYSTEM, never the person.
   */
  readonly cause?: UntrustedCause | undefined;
  /**
   * `capture_suppressed`: which precondition returned first. An enum, never text.
   *
   * ⚠ A `capture_suppressed` line deliberately carries NO `thread`. `extraction_off` is the
   * ghost/privacy toggle — the mode for handing the instance to someone else — and a
   * per-turn line naming the conversation would put metadata about a third party's session
   * where that user had chosen to leave none. Nothing reads `thread` here, so the field
   * costs a privacy question and buys nothing. `runId` IS kept: joining a suppressed run to
   * a `remember_invoked` run is the evidence that decides whether these turns explain the
   * fire-rate gap, and it is an opaque handle rather than a conversation pointer.
   */
  readonly reason?: CaptureSuppressedReason | undefined;
  /**
   * Which routing rule decided this fact's status. Present only on `remember_invoked`
   * lines written by the recovery pass (`source: 'capture'`) — the `remember` TOOL still
   * routes turn-wide, and giving its lines a per-fact label would claim a distinction its
   * writer does not make. Absent is therefore meaningful, not missing.
   */
  readonly routing?: CaptureRouting | undefined;
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
