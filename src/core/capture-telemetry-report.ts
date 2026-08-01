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

  readonly blindness: CaptureReportBlindness;
}

/**
 * Cap on the emitted per-model table. Well above any real fleet's model count; exists so
 * a sink full of distinct model ids cannot turn the response into a multi-MB payload.
 */
const MAX_MODELS_REPORTED = 50;
/** Cap on a model key's length — same reason, applied to the key rather than the count. */
const MAX_MODEL_KEY_CHARS = 128;

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
export async function buildCaptureReport(): Promise<CaptureReport> {
  const events = Object.fromEntries(ALL_EVENTS.map(e => [e, 0])) as Record<CaptureEvent, number>;
  const outcomes: Partial<Record<CaptureOutcome, number>> = {};
  const perModel = new Map<string, { eligible: number; remembered: number }>();
  let windowStart: number | null = null;
  let windowEnd: number | null = null;
  let totalEvents = 0;
  let eventsWithoutModel = 0;
  let eventsWithoutThread = 0;
  let untrustedEligible = 0;

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
