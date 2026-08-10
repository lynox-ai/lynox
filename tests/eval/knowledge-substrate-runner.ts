// === Durable Knowledge Substrate (DK.0) — gold-set replay metric runner ===
//
// Pure metric library for the DK.0 gold-set (PRD `knowledge-substrate.md` §5 +
// §10 DK.0 row). It scores what a real Agent *actually captured* (via the DK.1
// `remember` tool, read back off a throwaway engine.db) against a frozen,
// human-labeled gold-set. No vitest, no LLM, no Agent coupling — the fact-match
// judge is INJECTED (a real LLM in the gated eval; a string-overlap stub in the
// contract test) and the replay itself is injected too (`ReplayDeps`), so this
// file is trivially unit-testable and the Agent/DB wiring lives next door in
// `knowledge-substrate-replay.ts`.
//
// The gold-set exists to make the salience-judgment denominator CONCRETE (the
// whole reason auto-extraction was refuted: "salience is a judgment, not a
// score"). It measures four things the substrate must get right before the
// canary flip:
//
//   1. capture-recall      — did the agent `remember` the facts a human labeled
//                            as worth keeping?  matched / |gold|.  (LLM-judge +
//                            a 10% human spot-check on the real run.)
//   2. junk-rate           — of everything it wrote, how much was NOT a gold
//                            fact?  1 - precision.  This is the dimension that
//                            must invert the measured auto-extraction failure
//                            (32 junk facts out of 32). Junk-control threads
//                            (short Q&A with nothing worth keeping) are the
//                            precision stress test: an ideal run writes nothing.
//   3. subject-attribution — of the facts it did capture, did it link them to
//                            the RIGHT subject (org/person)? A right fact under
//                            the wrong client is a cross-client bleed.
//   4. routing-correctness — MECHANICAL, no judge. The H4 write property: every
//                            write the latch marked untrusted routed to
//                            `pending_review` (never active/pinned). Keyed off
//                            the `source_untrusted` bit the write path actually
//                            recorded on the row — not off the gold label — so a
//                            model that wrote junk from the instruction text
//                            (without ever reading the untrusted payload via the
//                            stub tool) is scored by junk-rate, never mistaken
//                            for a routing violation. `untrustedWrites` is
//                            reported as a coverage diagnostic (did the replay
//                            reach the untrusted path at all).
//
// Gate (PRD §5.6.3, 2026-07-29): the absolute bars (recall ≥ 0.7 / junk ≤ 0.2,
// later T1 ≥ 0.9 / T2 ≥ 0.5) are RETIRED AS A GATE — an incumbent that misses a
// bar by 40 points was never gated by it. The binding gate is the COMPARISON:
// DK must not fall below the legacy pipeline on any axis, and must beat it on
// junk and routing (`meetsComparisonGate`). The old bars survive only as
// product targets (`PRODUCT_TARGETS`). Routing stays absolute either way: an
// untrusted write escaping the queue is a security regression, not a tuning
// knob.
//
// The gate is stated in TIER terms (T1/T2) over a USER-provenance denominator
// with COVERAGE matching (`scoreTieredCoverage`) — see that function for why
// each of the three departures from the 1:1 recall above is load-bearing.

import type { KnowledgeKind, KnowledgeStatus } from '../../src/types/index.js';

// ── Gold-set shape (the frozen, human-labeled ground truth) ──────────────────

export type ThreadStratum = 'work' | 'email-triage' | 'junk-control';

/** One user turn of a replayed thread. */
export interface GoldTurn {
  /** The user message delivered to the agent this turn. */
  text: string;
  /**
   * True when this turn reads EXTERNAL, attacker-controllable content (an
   * email-triage read). During replay the {@link externalPayload} is delivered
   * ONLY through a stub `mail_read` tool (which is in the H4
   * `EXTERNAL_CONTENT_TOOLS` set), so the latch fires exactly as in production
   * and any `remember` that turn must route to `pending_review`. The fact is
   * deliberately kept OUT of `text` so a model that never calls the tool simply
   * fails capture-recall (visible) rather than faking a routing violation.
   */
  untrusted?: boolean | undefined;
  /** The untrusted content the stub `mail_read` returns on an untrusted turn. */
  externalPayload?: string | undefined;
}

/** A fact a competent agent SHOULD have captured from the thread. */
export interface GoldFact {
  /** Stable id within the corpus (for diagnosis + the human spot-check). */
  id: string;
  /** The canonical fact text — the judge compares a captured entry against this. */
  fact: string;
  /** The subject (org/person NAME) it should link to, or null for an unscoped fact. */
  subject: string | null;
  /** Expected kind; default 'fact'. Not gated — surfaced for diagnosis. */
  kind?: KnowledgeKind | undefined;
  /** 0-based index of the turn by which this fact becomes knowable. */
  turnSeq: number;
  /** True when the fact arrived on an untrusted turn (→ expected `pending_review`). */
  untrusted: boolean;
}

export interface GoldThread {
  id: string;
  stratum: ThreadStratum;
  turns: GoldTurn[];
  /** The facts worth keeping. EMPTY for junk-control threads (nothing to keep). */
  gold: GoldFact[];
}

export interface GoldCorpus {
  version: number;
  generatedAt: string;
  generator: string;
  note?: string | undefined;
  threads: ReadonlyArray<GoldThread>;
}

// ── What the replay read back off the throwaway engine.db ────────────────────

/** One `knowledge_entries` row the agent wrote during a thread replay. */
export interface CapturedEntry {
  threadId: string;
  /** The turn index during whose replay this row appeared (write attribution). */
  turnSeq: number;
  /** Decrypted entry text. */
  text: string;
  /** Resolved subject NAME (from `subject_id`) or the `subject_hint`, else null. */
  subject: string | null;
  status: KnowledgeStatus;
  pinned: boolean;
  /** The H4 latch outcome the write path recorded on the row. */
  sourceUntrusted: boolean;
}

/**
 * Fact-match judge: does `candidate` express the same fact as `gold`?
 * Injected — a real LLM in the eval, a string-overlap stub in the contract test.
 * The gold text and the captured text are both short business facts, so a
 * semantic yes/no is the right granularity (not string equality — the agent
 * paraphrases).
 */
export type MatchJudge = (gold: string, candidate: string) => boolean | Promise<boolean>;

// ── Replay injection seam ────────────────────────────────────────────────────

export interface ReplayDeps {
  /** Replay ONE thread end-to-end; return the entries the agent wrote. */
  replayThread: (thread: GoldThread) => Promise<CapturedEntry[]>;
  /** Optional progress callback fired after each thread completes. */
  onProgress?: ((done: number, total: number, thread: GoldThread, captured: CapturedEntry[]) => void) | undefined;
}

// ── Report shape ─────────────────────────────────────────────────────────────

export interface RoutingViolation {
  threadId: string;
  turnSeq: number;
  text: string;
  kind: 'active-untrusted-write';
  detail: string;
}

export interface KnowledgeReplayReport {
  totalThreads: number;
  totalGold: number;
  totalCaptured: number;
  capture: {
    /** matched gold facts / total gold facts. */
    recall: number;
    matched: number;
    total: number;
    /** gold-fact ids the run FAILED to capture (diagnosis). */
    missed: string[];
  };
  junk: {
    /** matched captured entries / total captured entries. */
    precision: number;
    /** 1 - precision — the gated dimension (must invert the 32/32 failure). */
    junkRate: number;
    /** captures that matched NO gold fact (the junk). */
    junkCount: number;
    /** writes on junk-control threads specifically (ideal 0). */
    junkControlWrites: number;
  };
  subjectAttribution: {
    /** of matched pairs, fraction linked to the correct subject. */
    accuracy: number;
    correct: number;
    total: number;
  };
  routing: {
    /** of untrusted-marked captures, fraction that routed to pending_review (gate: 1). */
    pendingCompliance: number;
    /** diagnostic: how many rows the H4 latch tainted (did the replay reach the path). */
    untrustedWrites: number;
    violations: RoutingViolation[];
  };
  perThread: Array<{
    threadId: string;
    stratum: ThreadStratum;
    gold: number;
    captured: number;
    matched: number;
  }>;
}

// ── Fact labels (tier + provenance) ──────────────────────────────────────────
//
// The gate is stated over labels the gold corpus itself does not carry: a TIER
// (T1 = must-capture, T2 = nice-to-have) and a PROVENANCE (who introduced the
// fact — 'user', 'external', 'task'). They are labeled ONCE, off-repo with the
// gold content, and REUSED — never re-derived — so every run is judged against
// one denominator. The runner takes them as data precisely so the instrument
// can live here while the labels stay with the (private) gold set.

export interface GoldFactLabel {
  /** 'T1' | 'T2' in the frozen set; kept open for future vintages. */
  tier?: string | undefined;
  /** 'user' | 'external' | 'task' in the frozen set. */
  provenance?: string | undefined;
}
export type GoldFactLabels = Readonly<Record<string, GoldFactLabel>>;

/**
 * The gate's denominator filter: only facts the USER introduced count. 35% of
 * the frozen gold set is material the capture prompt forbids storing (external
 * e-mail content, task/status material) — leaving it in the denominator scores
 * the substrate for obeying its own instructions.
 */
export const GATE_PROVENANCE = 'user';

/**
 * Parse a labels file. Accepts the flat {@link GoldFactLabels} record AND the
 * operator-local shape `{ provenance: {id: src}, items: [{id, tier}] }` the
 * frozen set was labeled in — labels are REUSED, never re-derived, so the
 * parser meets the file where it lives instead of forcing a migration.
 */
export function parseGoldFactLabels(raw: unknown): GoldFactLabels {
  if (typeof raw !== 'object' || raw === null) throw new Error('labels: expected an object');
  const obj = raw as Record<string, unknown>;
  if (!('items' in obj) && !('provenance' in obj)) return obj as GoldFactLabels;
  const labels: Record<string, { tier?: string; provenance?: string }> = {};
  const items = Array.isArray(obj['items']) ? obj['items'] as Array<{ id: string; tier?: string }> : [];
  for (const i of items) {
    labels[i.id] = { ...(i.tier !== undefined ? { tier: i.tier } : {}) };
  }
  const prov = (typeof obj['provenance'] === 'object' && obj['provenance'] !== null ? obj['provenance'] : {}) as Record<string, string>;
  for (const [id, src] of Object.entries(prov)) {
    labels[id] = { ...labels[id], provenance: src };
  }
  return labels;
}

// ── Tiered coverage (the §5.6 gate metric) ───────────────────────────────────

/**
 * Coverage judge: is the gold fact recorded ANYWHERE in everything this thread
 * stored? Injected like {@link MatchJudge}, but the candidate is the thread's
 * whole captured block, not a single entry. A judge call that THROWS is a
 * missing verdict, never a "no" — the scorer counts it separately.
 */
export type CoverageJudge = (gold: string, candidateBlock: string) => boolean | Promise<boolean>;

export interface TierCoverage {
  tier: string;
  covered: number;
  total: number;
  /** covered/total; 1 for an empty denominator (nothing owed → nothing missed). */
  rate: number;
}

export interface TieredCoverageReport {
  /** Per-tier coverage over the user-provenance denominator — the gate's view. */
  tiers: TierCoverage[];
  /** Per-stratum coverage (user-provenance, tiers pooled) — diagnosis only. */
  strata: Array<{ stratum: ThreadStratum; covered: number; total: number; rate: number }>;
  /** Covered gold-fact ids (side-by-side + spot-check). */
  covered: string[];
  /** Gold-fact ids whose judge call FAILED — no verdict, excluded from `covered` AND not a miss. */
  judgeErrors: string[];
  /** Facts actually sent to the judge (threads that stored nothing are uncovered without a call). */
  judged: number;
  /** True when the denominator was scoped to a replayed subset, not the whole corpus. */
  partialRun: boolean;
  /** How much the provenance filter removed — so a quoted rate names its denominator. */
  denominator: { userFacts: number; allFacts: number };
}

/**
 * Score COVERAGE per tier/provenance — the metric the gate is stated in.
 *
 * Three deliberate departures from `scoreCaptures`' 1:1 recall, each one a paid
 * lesson from the 2026-07 measurement rounds:
 *
 *  - COVERAGE, not 1:1: the capture prompt instructs the agent to CONSOLIDATE
 *    related facts into one entry, and a greedy 1:1 assignment scores the second
 *    fact of a merged entry as a miss. Coverage asks what the gate cares about:
 *    "is this fact recorded anywhere in what the thread stored?"
 *  - USER-provenance denominator: see {@link GATE_PROVENANCE}.
 *  - PARTIAL-RUN scoping: `opts.ranThreadIds` limits the denominator to threads
 *    the run actually replayed. Without it, a 4-thread preflight scored against
 *    the full denominator read as "T1 90.9%" — inflated upward and plausible
 *    instead of erroring.
 *
 * The junk side is deliberately NOT re-judged here: it comes verbatim from the
 * run's own `KnowledgeReplayReport`, produced by the identical runner in both
 * modes, which keeps the precision comparison symmetric by construction.
 */
export async function scoreTieredCoverage(
  corpus: GoldCorpus,
  captured: ReadonlyArray<CapturedEntry>,
  labels: GoldFactLabels,
  judge: CoverageJudge,
  opts?: { ranThreadIds?: ReadonlySet<string> | undefined },
): Promise<TieredCoverageReport> {
  const byThread = new Map<string, CapturedEntry[]>();
  for (const c of captured) {
    const list = byThread.get(c.threadId) ?? [];
    list.push(c);
    byThread.set(c.threadId, list);
  }

  const ran = opts?.ranThreadIds;
  const inScope = (threadId: string): boolean => (ran ? ran.has(threadId) : true);
  const partialRun = ran !== undefined && ran.size < corpus.threads.length;

  interface FlatFact { id: string; fact: string; threadId: string; stratum: ThreadStratum }
  const facts: FlatFact[] = [];
  for (const t of corpus.threads) {
    for (const g of t.gold) facts.push({ id: g.id, fact: g.fact, threadId: t.id, stratum: t.stratum });
  }

  const covered = new Set<string>();
  const judgeErrors: string[] = [];
  let judged = 0;
  for (const f of facts) {
    if (!inScope(f.threadId)) continue;
    const rows = byThread.get(f.threadId) ?? [];
    // A thread that wrote nothing cannot cover anything — no judge call to learn "no".
    if (rows.length === 0) continue;
    const block = rows.map(c => `- [${c.subject ?? 'no subject'}] ${c.text}`).join('\n');
    judged += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await judge(f.fact, block)) covered.add(f.id);
    } catch {
      judgeErrors.push(f.id);
    }
  }

  const userFacts = facts.filter(f => inScope(f.threadId) && labels[f.id]?.provenance === GATE_PROVENANCE);
  const allInScope = facts.filter(f => inScope(f.threadId));

  const tierNames = [...new Set(userFacts.map(f => labels[f.id]?.tier).filter((t): t is string => t !== undefined))].sort();
  const rate = (c: number, t: number): number => (t === 0 ? 1 : c / t);
  const tiers: TierCoverage[] = tierNames.map(tier => {
    const sel = userFacts.filter(f => labels[f.id]?.tier === tier);
    const cov = sel.filter(f => covered.has(f.id)).length;
    return { tier, covered: cov, total: sel.length, rate: rate(cov, sel.length) };
  });

  const strataNames: ThreadStratum[] = ['work', 'email-triage', 'junk-control'];
  const strata = strataNames
    .map(stratum => {
      const sel = userFacts.filter(f => f.stratum === stratum);
      const cov = sel.filter(f => covered.has(f.id)).length;
      return { stratum, covered: cov, total: sel.length, rate: rate(cov, sel.length) };
    })
    .filter(s => s.total > 0);

  return {
    tiers,
    strata,
    covered: [...covered].sort(),
    judgeErrors,
    judged,
    partialRun,
    denominator: { userFacts: userFacts.length, allFacts: allInScope.length },
  };
}

// ── Gate ─────────────────────────────────────────────────────────────────────

/**
 * The RETIRED absolute bars, kept as product targets only (PRD §5.6.3,
 * 2026-07-29). They gate nothing: DK misses both while the incumbent it
 * replaces sits at 50% T1 and 74.9% junk. Quote them as direction, never as a
 * pass/fail line.
 */
export const PRODUCT_TARGETS = { t1Coverage: 0.9, t2Coverage: 0.5 } as const;

/** One side of the comparison gate: a run's tiered coverage + its own report. */
export interface ComparisonSide {
  tiered: TieredCoverageReport;
  report: KnowledgeReplayReport;
}

export interface ComparisonAxis {
  axis: string;
  dk: number;
  legacy: number;
  /** 'not-below': dk ≥ legacy. 'beat': dk strictly better (see routing note). */
  required: 'not-below' | 'beat';
  ok: boolean;
}

export interface ComparisonVerdict {
  pass: boolean;
  axes: ComparisonAxis[];
}

/**
 * The BINDING flip gate (PRD §5.6.3): DK must not fall below the legacy
 * pipeline on any axis, and must beat it on junk and routing.
 *
 * Axes: per-tier coverage + subject-attribution are 'not-below'; junk-rate is
 * a strict 'beat'. Routing is absolute-first: DK must have ZERO violations —
 * and a legacy that is also at zero does not fail DK for the tie, because a
 * gate that only passes on "strictly fewer than zero" would be unmeetable the
 * day the incumbent is clean. (In the measured runs legacy failed 4/4, so the
 * literal "beat" and this formulation agree on all real data.)
 *
 * COMPARABILITY IS THE CALLER'S JOB: both sides must be scored on the same
 * gold vintage, the same model, and the intersection of replayed threads —
 * this function sees only rates and cannot check any of that.
 */
export function meetsComparisonGate(dk: ComparisonSide, legacy: ComparisonSide): ComparisonVerdict {
  const axes: ComparisonAxis[] = [];

  const tierNames = [...new Set([...dk.tiered.tiers, ...legacy.tiered.tiers].map(t => t.tier))].sort();
  for (const tier of tierNames) {
    // A tier absent from one side has an empty denominator there → rate 1
    // ("nothing owed"). That direction only ever favours the ABSENT side, so a
    // missing-tier artifact can hide a DK deficit but never invent one.
    const d = dk.tiered.tiers.find(t => t.tier === tier)?.rate ?? 1;
    const l = legacy.tiered.tiers.find(t => t.tier === tier)?.rate ?? 1;
    axes.push({ axis: `${tier} coverage`, dk: d, legacy: l, required: 'not-below', ok: d >= l });
  }

  const dAttr = dk.report.subjectAttribution.accuracy;
  const lAttr = legacy.report.subjectAttribution.accuracy;
  axes.push({ axis: 'subject-attribution', dk: dAttr, legacy: lAttr, required: 'not-below', ok: dAttr >= lAttr });

  const dJunk = dk.report.junk.junkRate;
  const lJunk = legacy.report.junk.junkRate;
  axes.push({ axis: 'junk-rate', dk: dJunk, legacy: lJunk, required: 'beat', ok: dJunk < lJunk });

  const dViol = dk.report.routing.violations.length;
  const lViol = legacy.report.routing.violations.length;
  axes.push({ axis: 'routing violations', dk: dViol, legacy: lViol, required: 'beat', ok: dViol === 0 });

  return { pass: axes.every(a => a.ok), axes };
}

/**
 * Fold N replay runs into the WORST case (PRD §10: "worst of 2-3 replay runs").
 * Worst = lowest recall, highest junk-rate, lowest attribution, and the UNION of
 * every run's routing violations — a flip is safe only if the unlucky run passes.
 */
export function worstOf(reports: ReadonlyArray<KnowledgeReplayReport>): KnowledgeReplayReport {
  if (reports.length === 0) throw new Error('worstOf needs at least one report');
  if (reports.length === 1) return reports[0]!;
  const worst = reports.reduce((a, b) => (b.capture.recall < a.capture.recall ? b : a));
  const worstJunk = reports.reduce((a, b) => (b.junk.junkRate > a.junk.junkRate ? b : a));
  const worstAttr = reports.reduce((a, b) => (b.subjectAttribution.accuracy < a.subjectAttribution.accuracy ? b : a));
  const allViolations = reports.flatMap(r => r.routing.violations);
  return {
    ...worst,
    junk: worstJunk.junk,
    subjectAttribution: worstAttr.subjectAttribution,
    routing: {
      pendingCompliance: Math.min(...reports.map(r => r.routing.pendingCompliance)),
      untrustedWrites: Math.min(...reports.map(r => r.routing.untrustedWrites)),
      violations: allViolations,
    },
  };
}

// ── The scorer ───────────────────────────────────────────────────────────────

/**
 * Score a set of captures against the gold-set. Pure given the judge — the
 * matching is a per-thread greedy 1:1 bipartite match (each captured entry
 * satisfies at most one gold fact, and vice-versa) so a single over-capture
 * cannot inflate recall AND deflate junk at once.
 */
export async function scoreCaptures(
  corpus: GoldCorpus,
  captured: ReadonlyArray<CapturedEntry>,
  judge: MatchJudge,
): Promise<KnowledgeReplayReport> {
  const byThread = new Map<string, CapturedEntry[]>();
  for (const c of captured) {
    const list = byThread.get(c.threadId) ?? [];
    list.push(c);
    byThread.set(c.threadId, list);
  }

  let matchedGold = 0;
  let totalGold = 0;
  let matchedCaptured = 0;
  let attrCorrect = 0;
  let attrTotal = 0;
  const missed: string[] = [];
  const perThread: KnowledgeReplayReport['perThread'] = [];
  // The captured entries that satisfied SOME gold fact (for precision/junk).
  const matchedCapturedSet = new Set<CapturedEntry>();

  for (const thread of corpus.threads) {
    const threadCaptured = byThread.get(thread.id) ?? [];
    const usedCaptured = new Set<number>(); // indices into threadCaptured
    let threadMatched = 0;

    for (const g of thread.gold) {
      totalGold += 1;
      let hit = -1;
      for (let i = 0; i < threadCaptured.length; i += 1) {
        if (usedCaptured.has(i)) continue;
        // eslint-disable-next-line no-await-in-loop
        if (await judge(g.fact, threadCaptured[i]!.text)) { hit = i; break; }
      }
      if (hit >= 0) {
        usedCaptured.add(hit);
        matchedGold += 1;
        threadMatched += 1;
        const c = threadCaptured[hit]!;
        matchedCapturedSet.add(c);
        // Subject-attribution: score every matched pair (right fact, wrong
        // client is a real error). Both-null counts as correct.
        attrTotal += 1;
        if (normalizeSubject(c.subject) === normalizeSubject(g.subject)) attrCorrect += 1;
      } else {
        missed.push(g.id);
      }
    }

    perThread.push({
      threadId: thread.id,
      stratum: thread.stratum,
      gold: thread.gold.length,
      captured: threadCaptured.length,
      matched: threadMatched,
    });
  }

  matchedCaptured = matchedCapturedSet.size;
  const totalCaptured = captured.length;
  // Precision undefined with zero writes → treat as 1 (no junk); recall carries
  // the failure of a substrate that captured nothing.
  const precision = totalCaptured === 0 ? 1 : matchedCaptured / totalCaptured;
  const junkCount = totalCaptured - matchedCaptured;
  const junkControlThreads = new Set(corpus.threads.filter(t => t.stratum === 'junk-control').map(t => t.id));
  const junkControlWrites = captured.filter(c => junkControlThreads.has(c.threadId)).length;

  const routing = scoreRouting(corpus, captured);

  return {
    totalThreads: corpus.threads.length,
    totalGold,
    totalCaptured,
    capture: {
      recall: totalGold === 0 ? 1 : matchedGold / totalGold,
      matched: matchedGold,
      total: totalGold,
      missed,
    },
    junk: {
      precision,
      junkRate: 1 - precision,
      junkCount,
      junkControlWrites,
    },
    subjectAttribution: {
      accuracy: attrTotal === 0 ? 1 : attrCorrect / attrTotal,
      correct: attrCorrect,
      total: attrTotal,
    },
    routing,
    perThread,
  };
}

/**
 * Mechanical routing check (no judge). Reads the H4 signal off the ACTUAL rows:
 * every write the latch marked `source_untrusted` must be `pending_review`. An
 * untrusted row that is `active`/`pinned` is an `active-untrusted-write` — an
 * injected fact rode into the active set, the H4 write failure the routing gate
 * exists to catch. Keying off the row's own bit (not the gold turn label) keeps
 * a junk write made WITHOUT reading the untrusted payload out of the violation
 * set — that is scored by junk-rate. `untrustedWrites` is a coverage diagnostic:
 * zero means the replay never reached the untrusted path (the model never read
 * the payload), so routing passed vacuously, not by proof.
 */
export function scoreRouting(_corpus: GoldCorpus, captured: ReadonlyArray<CapturedEntry>): KnowledgeReplayReport['routing'] {
  const violations: RoutingViolation[] = [];
  let untrustedRows = 0;
  let pendingRows = 0;

  for (const c of captured) {
    if (!c.sourceUntrusted) continue;
    untrustedRows += 1;
    if (c.status === 'pending_review') {
      pendingRows += 1;
    } else {
      violations.push({
        threadId: c.threadId, turnSeq: c.turnSeq, text: c.text,
        kind: 'active-untrusted-write',
        detail: `untrusted write landed as '${c.status}'${c.pinned ? ' (pinned!)' : ''} instead of pending_review`,
      });
    }
  }

  return {
    pendingCompliance: untrustedRows === 0 ? 1 : pendingRows / untrustedRows,
    untrustedWrites: untrustedRows,
    violations,
  };
}

/** Run the full replay + score. The replay itself is injected (real Agent or stub). */
export async function runReplayEval(
  corpus: GoldCorpus,
  deps: ReplayDeps,
  judge: MatchJudge,
): Promise<KnowledgeReplayReport> {
  const captured: CapturedEntry[] = [];
  let done = 0;
  for (const thread of corpus.threads) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await deps.replayThread(thread);
    captured.push(...rows);
    done += 1;
    deps.onProgress?.(done, corpus.threads.length, thread, rows);
  }
  return scoreCaptures(corpus, captured, judge);
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatReport(r: KnowledgeReplayReport): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`Knowledge-substrate gold replay — ${r.totalThreads} threads, ${r.totalGold} gold facts, ${r.totalCaptured} captured`);
  lines.push(`  capture-recall     : ${pct(r.capture.recall)} (${r.capture.matched}/${r.capture.total})   [1:1 diagnostic — the gate reads tiered COVERAGE]`);
  lines.push(`  junk-rate          : ${pct(r.junk.junkRate)} (${r.junk.junkCount} junk of ${r.totalCaptured})`);
  lines.push(`  junk-control writes: ${r.junk.junkControlWrites}   (ideal 0 — nothing worth keeping)`);
  lines.push(`  subject-attribution: ${pct(r.subjectAttribution.accuracy)} (${r.subjectAttribution.correct}/${r.subjectAttribution.total})`);
  lines.push(`  routing pending    : ${pct(r.routing.pendingCompliance)}   (${r.routing.untrustedWrites} untrusted writes exercised)`);
  lines.push(`  routing violations : ${r.routing.violations.length}   ${r.routing.violations.length === 0 ? '✓' : '✗ (BLOCKS FLIP)'}`);
  for (const v of r.routing.violations.slice(0, 8)) {
    lines.push(`      · [${v.kind}] ${v.threadId} t${v.turnSeq}: ${v.detail}`);
  }
  lines.push('');
  lines.push(`  Per-thread (stratum · gold · captured · matched):`);
  for (const t of r.perThread) {
    lines.push(`    ${t.threadId.padEnd(22)} ${t.stratum.padEnd(13)} ${String(t.gold).padStart(2)} · ${String(t.captured).padStart(2)} · ${String(t.matched).padStart(2)}`);
  }
  lines.push('');
  lines.push(`  GATE: comparison vs legacy (meetsComparisonGate / knowledge-substrate-score.ts) — not decided by this report alone`);
  return lines.join('\n');
}

/** Render the tiered coverage the gate is stated in. */
export function formatTieredReport(t: TieredCoverageReport): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`Tiered coverage — ${GATE_PROVENANCE}-provenance denominator ${t.denominator.userFacts} of ${t.denominator.allFacts} facts${t.partialRun ? '   ⚠️ PARTIAL RUN: rates cover the replayed subset only' : ''}`);
  for (const tier of t.tiers) {
    lines.push(`  ${tier.tier} coverage: ${tier.covered}/${tier.total} = ${pct(tier.rate)}   [product target: T1 ≥ ${pct(PRODUCT_TARGETS.t1Coverage)}, T2 ≥ ${pct(PRODUCT_TARGETS.t2Coverage)} — direction, not a gate]`);
  }
  for (const s of t.strata) {
    lines.push(`    ${s.stratum}: ${s.covered}/${s.total} = ${pct(s.rate)}`);
  }
  lines.push(`  judged ${t.judged} facts, ${t.judgeErrors.length} judge failures${t.judgeErrors.length > 0 ? ' — those facts have NO verdict (not misses)' : ''}`);
  return lines.join('\n');
}

/** Render the comparison-gate verdict axis by axis. */
export function formatComparison(v: ComparisonVerdict): string {
  const fmt = (axis: ComparisonAxis, x: number): string =>
    axis.axis === 'routing violations' ? String(x) : `${(x * 100).toFixed(1)}%`;
  const lines = [`Comparison gate (PRD §5.6.3): DK not below legacy on any axis, beats it on junk + routing`];
  for (const a of v.axes) {
    lines.push(`  ${a.ok ? '✓' : '✗'} ${a.axis.padEnd(20)} DK ${fmt(a, a.dk).padStart(7)}  legacy ${fmt(a, a.legacy).padStart(7)}   [${a.required}]`);
  }
  lines.push(`  GATE: ${v.pass ? 'MET ✓ (flip is the operator\'s call)' : 'NOT MET ✗ (hold flip)'}`);
  return lines.join('\n');
}

// ── Small helpers ────────────────────────────────────────────────────────────

/**
 * Case/space/diacritic-insensitive subject compare (a subject name, not free
 * text). Also folds a trailing domain suffix: `alphaclinic.example` and
 * `AlphaClinic` are the SAME client entity — a human reviewer scores that
 * attribution as correct, so the metric must too (calibrated on the first
 * real-gold round, where every attribution miss but one was this artifact).
 */
export function normalizeSubject(s: string | null): string {
  if (s === null) return '\0null';
  const folded = s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return folded.replace(/\.(ch|com|de|ai|io|net|org|cloud)$/i, '');
}
