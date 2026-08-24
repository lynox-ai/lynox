import { scanBoundedJsonl } from './bounded-jsonl-log.js';
import { CAPTURE_TELEMETRY_LOG_FILE, type CaptureEvent, type CaptureOutcome } from './capture-telemetry.js';

/**
 * The READ half of the durable-knowledge capture telemetry (DEF-dk-capture-observability).
 *
 * The counters have shipped since v2.9.0, but the sink was write-only: nothing outside
 * `bounded-jsonl-log` ever read the file, so "capture is dead" stayed an anecdote. The
 * whole point of the row is that it becomes a NUMBER, and a number needs an aggregator.
 *
 * Why it lives in code rather than an ad-hoc query: deriving this rate by hand against a
 * live instance needed three attempts, and the two wrong ones failed the same way — the
 * denominator counted persisted `role:'user'` rows as turns, when most of those rows are
 * the mid-turn tool-result carrier (`agent.ts`), not turns. A denominator that wrong has
 * no symptom; it just looks plausible.
 *
 * Hence `blindness` below. An aggregate that cannot say how much of its input lacked the
 * field it grouped by, or which part of the window it failed to open, is a number with a
 * story attached rather than a measurement.
 *
 * Content rule (capture-telemetry S5): the sink carries ids, enums and counts — never fact
 * text. This report aggregates and therefore narrows that further: it emits counts and rates
 * plus model ids, and never echoes an `entryId` or a thread id back out.
 */

/** Per-model capture rates — the split `capture-telemetry.ts` calls "the whole point". */
export interface CaptureModelRate {
  readonly model: string;
  /** Capture-eligible turn ends attributed to this model. */
  readonly eligible: number;
  /** Durable writes the model actually made. */
  readonly remembered: number;
  /** `remembered / eligible`, or null when this model has no eligible turns to divide by. */
  readonly fireRate: number | null;
}

/**
 * The two ends of `fireRate`, counted as the SEPARATE populations they are.
 *
 * `fireRate` divides `remember_invoked` by `capture_eligible` as if both described the
 * same runs. They need not: the numerator is emitted from the `remember` tool handler,
 * which any run carrying the tool reaches, while the denominator is emitted from the
 * turn-end hook, which returns early for a run with no `Memory`, one with
 * `skipMemoryExtraction`, or an internal one. Measured on a real sink:
 * **910 numerator events, 0 denominator events** — a quotient over an empty population.
 *
 * ⚠️ **What this split does NOT tell you: WHY.** It reports that the populations differ
 * and by how much. The mechanism that produces a given gap is not measured here and, on
 * the sink that motivated this, is still unknown — two candidate explanations (internal
 * runs; ordinary spawned children) were REFUTED at the source, since internal runs carry
 * no tools at all and an ordinary child inherits the parent's `Memory` and so passes the
 * hook. What remains unmeasured: `isolated_memory` children, the `skipMemoryExtraction`
 * path, and an instance with no `Memory` at all. A non-zero `rememberOutsideEligible` is
 * a fact about the numbers, never a diagnosis.
 */
export interface CapturePopulationSplit {
  /** Distinct runs that produced at least one `capture_eligible` — the denominator's population. */
  readonly eligibleRuns: number;
  /** Distinct runs that produced at least one `remember_invoked` — the numerator's population. */
  readonly rememberRuns: number;
  /** Distinct runs in BOTH — the only runs the quotient is actually about. */
  readonly overlapRuns: number;
  /**
   * `remember_invoked` EVENTS (not runs) whose run never produced a `capture_eligible`.
   * This is the numerator's share that the denominator can never account for. Counted in
   * events rather than runs because that is the quantity `fireRate` inflates by.
   *
   * ⚠️ Some of this can be an artefact of the window's LIVE EDGE rather than a gap: a run
   * writes its `remember_invoked` from the tool handler and its `capture_eligible` only
   * when the turn ends, so a turn still in flight at the moment of the scan contributes
   * the numerator without its denominator. The artefact is bounded by (runs in flight) ×
   * (their `remember` calls) — not by one: an instance can have several runs open at once
   * (spawned children, a batch), and a single run can record several facts in one turn.
   * The shape this split exists to expose is different in kind: a numerator population
   * with no overlapping denominator at all.
   */
  readonly rememberOutsideEligible: number;
  /**
   * Events of either kind carrying no usable `runId`, so they join nothing.
   *
   * Two causes, and the second is NOT transitional. (1) The window predates the field.
   * (2) The run genuinely has no id: `currentRunId` is optional, an ad-hoc `Agent` built
   * outside a Session never gets one, and `Session` sets it to `null` when `insertRun`
   * throws — so an instance with a broken run history is PERMANENTLY unjoinable, not
   * temporarily. Either way the other numbers here describe only the part of the window
   * that CAN be joined, which is why this is reported beside them rather than folded in.
   */
  readonly eventsWithoutRun: number;
  /**
   * Events whose run could not be tracked because the distinct-run cap was reached.
   * Counted in EVENTS and named so: counting distinct dropped runs would need exactly the
   * unbounded set the cap exists to prevent. Non-zero means the numbers above cover a
   * PREFIX of the window's runs, so a gap may be under- or over-stated — `blindNote`
   * fires with it.
   */
  readonly eventsOverRunCap: number;
  /**
   * A fixed sentence, present ONLY when the numbers above actually show a gap. It ships
   * in the RESPONSE rather than only in this file's comments because the reader of the
   * number is an operator reading JSON at a diagnostic endpoint — a caveat that lives in
   * the source reaches the maintainer and misses exactly the person about to quote the
   * figure.
   *
   * Null when there is no gap. It is never a diagnosis and never varies with the data: a
   * note that appeared to explain the gap would be worse than none, because the two
   * explanations that seemed obvious were both refuted at the source.
   */
  readonly gapNote: string | null;
  /**
   * The OTHER thing a null `gapNote` can mean, and the reason this field exists: **"no
   * gap" and "could not look" are different states that produced identical output.**
   *
   * A window whose events carry no `runId` yields all-zero counts and `gapNote: null` —
   * which reads as "the populations agree". That is exactly the sink this whole split was
   * built for: the measured 910-to-0 instance PREDATES the field, so it reports zeros and
   * would have been the one window to say nothing at all. This note is non-null whenever
   * the split is partial or impossible (`eventsWithoutRun` or `eventsOverRunCap` above zero),
   * so silence from `gapNote` can be read as an answer only when this one is also null.
   */
  readonly blindNote: string | null;
}

/** The one wording {@link CapturePopulationSplit.gapNote} ever carries. */
const GAP_NOTE =
  'numerator and denominator do not cover the same runs; this report measures THAT, not why';

/** The one wording {@link CapturePopulationSplit.blindNote} ever carries. */
const BLIND_NOTE =
  'some events could not be joined to a run; the split above covers only part of the window';

/**
 * Cap on TRACKED ENTRIES held during a scan — not on distinct runs, and the difference is
 * real: a run that both ends a turn and fires `remember` occupies one slot in each
 * collection, so the distinct-run floor this guarantees is `maxRuns / 2`. The sum is the
 * quantity that bounds memory, which is what the cap is for; the naming follows the bound
 * rather than the concept. The axis also matters: the neighbouring
 * `MAX_MODELS_REPORTED` caps the RESPONSE, not the scan — `perModel` is already an
 * unbounded scan-time Map, so the run collections introduce no new class of growth. What
 * they introduce is roughly four orders more cardinality: a fleet runs dozens of models,
 * while runs approach one per line.
 *
 * The number is chosen against the sink's own bound rather than picked round. At the
 * default 32 MiB × 2 generations and a measured ~210 B per line, a full window holds
 * ~320k lines, so this cap never engages in normal operation. It engages only under the
 * documented `LYNOX_TELEMETRY_LOG_MAX_BYTES` override, where a 2 GiB setting would put
 * ~20M lines through these collections — measured at ~1.9 GiB of Set/Map overhead, which
 * OOMs the container from a read-only diagnostic request.
 */
const MAX_TRACKED_RUNS = 400_000;

/** What the report could NOT see. Stated so a rate is never read as more complete than it is. */
export interface CaptureReportBlindness {
  /** Lines present in the sink that did not parse — excluded from every count below. */
  readonly unparsableLines: number;
  /**
   * Records that parsed as JSON but did not carry a usable event shape — also excluded.
   * Non-zero on a healthy instance means something other than the engine is writing to
   * the sink, which is worth knowing before quoting any rate from it.
   */
  readonly malformedRecords: number;
  /**
   * Retained generations that existed but could not be read. Non-zero means the window
   * below is missing a span of unknown size, so every rate is over an unknown subset —
   * the one condition under which these numbers must not be quoted.
   */
  readonly unreadableGenerations: number;
  /** Per-model rows dropped by the reporting cap. Non-zero means `byModel` is a top-N slice. */
  readonly modelsOmitted: number;
  /** Events carrying no `model`, so they cannot enter any per-model rate. */
  readonly eventsWithoutModel: number;
  /** Events carrying no `thread`, so they cannot be attributed to a conversation. */
  readonly eventsWithoutThread: number;
  /**
   * True when the sink has rotated at least once, meaning the window below starts at the
   * oldest RETAINED event, not at the first event ever recorded. Rates stay valid; totals
   * are a floor.
   */
  readonly windowTruncated: boolean;
}

export interface CaptureReport {
  /** Every event type with its raw count — the substrate under the derived rates. */
  readonly events: Readonly<Record<CaptureEvent, number>>;
  /** Oldest / newest event timestamp (epoch ms), or null when the sink is empty. */
  readonly windowStart: number | null;
  readonly windowEnd: number | null;
  /** Total parsed events across the retained window. */
  readonly totalEvents: number;

  /**
   * `remember_invoked / capture_eligible` — the headline. Null when no eligible turn was
   * recorded, which is a DIFFERENT statement from a rate of 0: nothing was measurable, as
   * opposed to measured and dead.
   */
  readonly fireRate: number | null;
  /** `propose_confirmed / propose_shown` — the human half of the funnel. Null when nothing was shown. */
  readonly confirmRate: number | null;
  /** `propose_ignored / propose_shown`. Null when nothing was shown. */
  readonly ignoreRate: number | null;

  /** Store outcomes of the durable writes that did happen. */
  readonly outcomes: Readonly<Partial<Record<CaptureOutcome, number>>>;
  /**
   * Per-model rates, busiest first, capped at `MAX_MODELS_REPORTED`. Only models with at
   * least one attributed event appear; `blindness.modelsOmitted` says how many were cut.
   */
  readonly byModel: readonly CaptureModelRate[];
  /** COUNT (not share) of capture-eligible turns that had ingested untrusted content. */
  readonly untrustedEligible: number;

  /**
   * The two ends of `fireRate` as separate populations. Read this BEFORE quoting
   * `fireRate`: when `overlapRuns` is 0 while `rememberRuns` is not, the headline is a
   * quotient over two disjoint sets and means nothing.
   */
  readonly populations: CapturePopulationSplit;

  readonly blindness: CaptureReportBlindness;
}

/**
 * Cap on the emitted per-model table. Well above any real fleet's model count; exists so
 * a sink full of distinct model ids cannot turn the response into a multi-MB payload.
 */
const MAX_MODELS_REPORTED = 50;
/** Cap on a model key's length — same reason, applied to the key rather than the count. */
const MAX_MODEL_KEY_CHARS = 128;
/** Cap on a run key's length. Same reason and same number as the model key above. */
const MAX_RUN_KEY_CHARS = 128;

/** Outcome values this build knows. Guards `outcomes` against an out-of-enum sink value. */
const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<CaptureOutcome>(['active', 'pending_review', 'rejected', 'superseded', 'deduped']);

/** Every event key, so the report always carries a full record rather than a sparse one. */
const ALL_EVENTS: readonly CaptureEvent[] = [
  'capture_eligible',
  'remember_invoked',
  'propose_shown',
  'propose_confirmed',
  'propose_ignored',
  'onboarding_started',
  'onboarding_step_completed',
  'onboarding_abandoned',
];

/** Prototype-free zero map — doubles as the membership test for a known event name. */
const EVENT_ZEROES: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, Object.fromEntries(ALL_EVENTS.map(e => [e, 0]))),
);

/** A rate that refuses to divide by zero — null means "not measurable", not "zero". */
function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** A sink record narrowed to the fields this report reads, with every type CHECKED. */
interface ValidatedEntry {
  readonly event: CaptureEvent;
  /** Finite epoch ms, or null when absent/unusable. */
  readonly ts: number | null;
  /** A non-empty string, already length-clamped, or null. */
  readonly model: string | null;
  readonly hasThread: boolean;
  readonly untrusted: boolean;
  readonly outcome: CaptureOutcome | null;
  /** A non-empty run id, or null when the line predates the field or omits it. */
  readonly runId: string | null;
}

/**
 * Narrow one parsed sink line to what the aggregation may use, or reject it.
 *
 * `JSON.parse` returns `any`-shaped data and the sink's element type is an unchecked
 * assertion, so every field here is attacker-shaped in the literal sense: the file lives
 * under the data dir and is NOT on the permission-guard's protected-path list, so an
 * agent tool reaches it. Treating a parsed value as its declared type is what turns that
 * into three distinct defects, all measured on this code before this function existed:
 *  - `model` as an object with a `length` property → `.slice` is not a function → the
 *    endpoint answers 500, and (because a throw clears the response cache) it answers 500
 *    for every subsequent request, uncached.
 *  - `model` as an ARRAY → `.length` is the element count, so the 128-char clamp never
 *    fires and the value is emitted verbatim; a 10 MB response was produced this way.
 *  - `ts` as `1e999` → `Infinity` → serializes to `null`, which this module's own
 *    interface documents as "the sink is empty" while the counts say otherwise.
 * Validating at the boundary fixes the class, not the three instances.
 *
 * Two of the guards below are belt-and-braces and say so: removing the `typeof raw` check
 * or replacing the `typeof event` check with a `String()` coercion changes NO observable
 * behaviour for anything `JSON.parse` can produce (a non-object's `['event']` is already
 * `undefined`, and a parsed value never carries a custom `toString`). They stay because
 * they make the narrowing total and cost nothing — but no test pins them, and inventing
 * one that appears to would be worse than saying this.
 */
function validateEntry(raw: unknown): ValidatedEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const event = r['event'];
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `event:"toString"`
  // would pass and `events["toString"]++` would write NaN — which serializes as null.
  if (typeof event !== 'string' || !Object.hasOwn(EVENT_ZEROES, event)) return null;
  const ts = r['ts'];
  const model = r['model'];
  const outcome = r['outcome'];
  return {
    event: event as CaptureEvent,
    ts: typeof ts === 'number' && Number.isFinite(ts) ? ts : null,
    model: typeof model === 'string' && model !== ''
      ? (model.length > MAX_MODEL_KEY_CHARS ? model.slice(0, MAX_MODEL_KEY_CHARS) : model)
      : null,
    hasThread: typeof r['thread'] === 'string' && r['thread'] !== '',
    untrusted: r['untrusted'] === true,
    outcome: typeof outcome === 'string' && KNOWN_OUTCOMES.has(outcome) ? outcome as CaptureOutcome : null,
    // Same narrowing AND the same clamp as `model`, for the same reason: a non-string or
    // empty run id is NOT a run (keying a set on one would join every such line to a
    // single synthetic run and invent an overlap), and an unbounded key is retained for
    // the whole scan. The sink is not on the permission-guard's protected-path list, so a
    // tool can write a line whose run id is megabytes long; the byte cap in
    // `bounded-jsonl-log` applies at append time, never on read.
    runId: typeof r['runId'] === 'string' && r['runId'] !== ''
      ? (r['runId'].length > MAX_RUN_KEY_CHARS ? r['runId'].slice(0, MAX_RUN_KEY_CHARS) : r['runId'])
      : null,
  };
}

/**
 * Aggregate the retained capture-telemetry window into rates.
 *
 * Reads both retained generations. An absent or unreadable sink yields an empty report
 * (all counts 0, every rate null) with `blindness.unreadableGenerations` set, rather than
 * a rejection: a diagnostic endpoint that 500s when there is nothing to diagnose is worse
 * than one that says "nothing recorded, and here is what I could not open".
 */
export async function buildCaptureReport(opts?: { readonly maxTrackedRuns?: number }): Promise<CaptureReport> {
  // Injectable so the cap's behaviour is testable without seeding a cap-sized sink; the
  // endpoint calls this with no argument and gets the real bound.
  const maxRuns = opts?.maxTrackedRuns ?? MAX_TRACKED_RUNS;
  const events = Object.fromEntries(ALL_EVENTS.map(e => [e, 0])) as Record<CaptureEvent, number>;
  const outcomes: Partial<Record<CaptureOutcome, number>> = {};
  const perModel = new Map<string, { eligible: number; remembered: number }>();
  let windowStart: number | null = null;
  let windowEnd: number | null = null;
  let totalEvents = 0;
  let eventsWithoutModel = 0;
  let eventsWithoutThread = 0;
  let untrustedEligible = 0;
  // The population split. Sets, not counters: a run that ends two eligible turns is ONE
  // run in the denominator's population, and counting events here would make the overlap
  // look larger than the number of runs that actually exist.
  const eligibleRuns = new Set<string>();
  // Remember EVENTS per run, resolved after the scan: the turn-end event for a run is
  // written AFTER the tool call in that same run, so a single forward pass cannot know
  // yet whether a run will turn out eligible.
  const rememberEventsByRun = new Map<string, number>();
  let eventsWithoutRun = 0;
  let eventsOverRunCap = 0;

  let malformedRecords = 0;

  const scan = await scanBoundedJsonl<unknown>(CAPTURE_TELEMETRY_LOG_FILE, (raw) => {
    // Validate at the boundary. A record that does not narrow contributes to nothing —
    // counting it would inflate `totalEvents` and dilute every rate derived from it — but
    // it IS counted as malformed, so a poisoned sink shows up as blindness rather than as
    // a quietly different number.
    const entry = validateEntry(raw);
    if (entry === null) { malformedRecords++; return; }
    const { event } = entry;
    events[event]++;
    totalEvents++;

    if (entry.ts !== null) {
      if (windowStart === null || entry.ts < windowStart) windowStart = entry.ts;
      if (windowEnd === null || entry.ts > windowEnd) windowEnd = entry.ts;
    }
    if (entry.model === null) eventsWithoutModel++;
    if (!entry.hasThread) eventsWithoutThread++;

    // Population assignment. Only the two fire-rate events participate: a `propose_*` or
    // `onboarding_*` line belongs to neither end of the quotient, and folding it into
    // either would answer a question nobody asked with a number that looks like an answer.
    if (event === 'capture_eligible' || event === 'remember_invoked') {
      if (entry.runId === null) eventsWithoutRun++;
      else if (event === 'capture_eligible') {
        if (!eligibleRuns.has(entry.runId)) {
          if (eligibleRuns.size + rememberEventsByRun.size < maxRuns) eligibleRuns.add(entry.runId);
          else eventsOverRunCap++;
        }
      }
      else if (rememberEventsByRun.has(entry.runId)) {
        rememberEventsByRun.set(entry.runId, rememberEventsByRun.get(entry.runId)! + 1);
      } else if (eligibleRuns.size + rememberEventsByRun.size < maxRuns) {
        rememberEventsByRun.set(entry.runId, 1);
      } else eventsOverRunCap++;
    }

    if (event === 'capture_eligible' && entry.untrusted) untrustedEligible++;
    if (event === 'remember_invoked' && entry.outcome !== null) {
      outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
    }
    if (entry.model !== null && (event === 'capture_eligible' || event === 'remember_invoked')) {
      const bucket = perModel.get(entry.model) ?? { eligible: 0, remembered: 0 };
      if (event === 'capture_eligible') bucket.eligible++;
      else bucket.remembered++;
      perModel.set(entry.model, bucket);
    }
  });

  // Resolve the split now that every line has been seen (see the forward-pass note above).
  let overlapRuns = 0;
  let rememberOutsideEligible = 0;
  for (const [runId, count] of rememberEventsByRun) {
    if (eligibleRuns.has(runId)) overlapRuns++;
    else rememberOutsideEligible += count;
  }
  // `rememberOutsideEligible > 0` is the whole gap test: if no remember run overlaps,
  // every remember run is outside and each contributes at least one event, so the
  // "numerator over an empty denominator" shape needs no separate clause.
  const populations: CapturePopulationSplit = {
    eligibleRuns: eligibleRuns.size,
    rememberRuns: rememberEventsByRun.size,
    overlapRuns,
    rememberOutsideEligible,
    eventsWithoutRun,
    eventsOverRunCap,
    gapNote: rememberOutsideEligible > 0 ? GAP_NOTE : null,
    // Independent of `gapNote`, and both can be non-null at once: a partial window can
    // still show a gap in the part that WAS joinable.
    blindNote: eventsWithoutRun > 0 || eventsOverRunCap > 0 ? BLIND_NOTE : null,
  };

  const ranked: CaptureModelRate[] = [...perModel.entries()]
    .map(([model, b]) => ({ model, eligible: b.eligible, remembered: b.remembered, fireRate: rate(b.remembered, b.eligible) }))
    .sort((a, b) => (b.eligible + b.remembered) - (a.eligible + a.remembered));
  // Cap the emitted table. A fleet runs a handful of models, so the cap is invisible in
  // practice — but the sink can hold ~450k records and nothing stops each carrying a
  // distinct model id, which would put a multi-MB array in an HTTP response. Neighbouring
  // read routes clamp their `limit` the same way. `modelsOmitted` keeps the truncation
  // visible: a silently short table would read as "these are all the models".
  const byModel = ranked.slice(0, MAX_MODELS_REPORTED);
  const modelsOmitted = ranked.length - byModel.length;

  return {
    events,
    windowStart,
    windowEnd,
    totalEvents,
    fireRate: rate(events.remember_invoked, events.capture_eligible),
    confirmRate: rate(events.propose_confirmed, events.propose_shown),
    ignoreRate: rate(events.propose_ignored, events.propose_shown),
    outcomes,
    byModel,
    untrustedEligible,
    populations,
    blindness: {
      unparsableLines: scan.unparsableLines,
      malformedRecords,
      unreadableGenerations: scan.unreadableGenerations,
      modelsOmitted,
      eventsWithoutModel,
      eventsWithoutThread,
      windowTruncated: scan.generationsRead > 1,
    },
  };
}
