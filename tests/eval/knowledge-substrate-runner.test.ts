// === Knowledge-substrate gold replay runner — contract tests ===
//
// Pins the metric bookkeeping (recall / junk-rate / subject-attribution /
// routing / worst-of-N / gate) with a DETERMINISTIC substring judge and
// hand-built capture sets — no LLM, no Agent, no DB. Runs in every `vitest run`;
// the companion `knowledge-substrate-eval.test.ts` does the real-LLM measurement
// (LYNOX_EVAL-gated). Also shape-checks the committed synthetic fixture.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  scoreCaptures,
  scoreRouting,
  scoreTieredCoverage,
  runReplayEval,
  worstOf,
  meetsComparisonGate,
  formatReport,
  formatTieredReport,
  formatComparison,
  parseGoldFactLabels,
  normalizeSubject,
  type GoldCorpus,
  type CapturedEntry,
  type CoverageJudge,
  type MatchJudge,
  type KnowledgeReplayReport,
  type TieredCoverageReport,
} from './knowledge-substrate-runner.js';

/** Deterministic judge: candidate "captures" the gold iff it contains it verbatim. */
const containsJudge: MatchJudge = (gold, candidate) => candidate.includes(gold);

function cap(p: Partial<CapturedEntry> & Pick<CapturedEntry, 'threadId' | 'text'>): CapturedEntry {
  return {
    threadId: p.threadId,
    turnSeq: p.turnSeq ?? 0,
    text: p.text,
    subject: p.subject ?? null,
    status: p.status ?? 'active',
    pinned: p.pinned ?? false,
    sourceUntrusted: p.sourceUntrusted ?? false,
  };
}

describe('scoreCaptures — capture-recall + junk-rate', () => {
  const corpus: GoldCorpus = {
    version: 1, generatedAt: 't', generator: 't',
    threads: [{
      id: 't', stratum: 'work',
      turns: [{ text: 'a' }, { text: 'b' }],
      gold: [
        { id: 'g1', fact: 'F1', subject: 'Meridian AG', turnSeq: 0, untrusted: false },
        { id: 'g2', fact: 'F2', subject: 'Meridian AG', turnSeq: 1, untrusted: false },
      ],
    }],
  };

  it('perfect capture → recall 1.0, junk 0, attribution 1.0', async () => {
    const captured = [
      cap({ threadId: 't', turnSeq: 0, text: 'F1 recorded', subject: 'Meridian AG' }),
      cap({ threadId: 't', turnSeq: 1, text: 'F2 recorded', subject: 'Meridian AG' }),
    ];
    const r = await scoreCaptures(corpus, captured, containsJudge);
    expect(r.capture.recall).toBe(1);
    expect(r.capture.matched).toBe(2);
    expect(r.junk.junkRate).toBe(0);
    expect(r.junk.precision).toBe(1);
    expect(r.subjectAttribution.accuracy).toBe(1);
  });

  it('one miss + one junk write → recall 0.5, junkRate 0.5', async () => {
    const captured = [
      cap({ threadId: 't', text: 'F1 recorded', subject: 'Meridian AG' }),
      cap({ threadId: 't', text: 'a random unrelated note', subject: 'Meridian AG' }),
    ];
    const r = await scoreCaptures(corpus, captured, containsJudge);
    expect(r.capture.recall).toBe(0.5);
    expect(r.capture.missed).toEqual(['g2']);
    expect(r.junk.junkRate).toBe(0.5);
    expect(r.junk.junkCount).toBe(1);
  });

  it('greedy 1:1 matching — a single over-capture cannot cover two gold facts', async () => {
    // One captured entry that contains BOTH strings must satisfy only ONE gold fact.
    const captured = [cap({ threadId: 't', text: 'F1 and F2 together', subject: 'Meridian AG' })];
    const r = await scoreCaptures(corpus, captured, containsJudge);
    expect(r.capture.matched).toBe(1); // not 2 — one captured entry, one match
    expect(r.junk.junkRate).toBe(0);   // the single write did match a gold fact
  });

  it('zero writes → junkRate 0 (no junk) but recall 0 carries the failure', async () => {
    const r = await scoreCaptures(corpus, [], containsJudge);
    expect(r.totalCaptured).toBe(0);
    expect(r.junk.junkRate).toBe(0);
    expect(r.junk.precision).toBe(1);
    expect(r.capture.recall).toBe(0);
  });
});

describe('scoreCaptures — subject-attribution', () => {
  const corpus: GoldCorpus = {
    version: 1, generatedAt: 't', generator: 't',
    threads: [{
      id: 't', stratum: 'work', turns: [{ text: 'a' }],
      gold: [{ id: 'g1', fact: 'F1', subject: 'Meridian AG', turnSeq: 0, untrusted: false }],
    }],
  };

  it('right fact, wrong subject → attribution 0 while recall stays 1', async () => {
    const captured = [cap({ threadId: 't', text: 'F1 recorded', subject: 'Nordwind GmbH' })];
    const r = await scoreCaptures(corpus, captured, containsJudge);
    expect(r.capture.recall).toBe(1);
    expect(r.subjectAttribution.accuracy).toBe(0);
    expect(r.subjectAttribution.total).toBe(1);
  });

  it('case/diacritic-insensitive subject match counts as correct', async () => {
    const captured = [cap({ threadId: 't', text: 'F1 recorded', subject: 'meridian ag' })];
    const r = await scoreCaptures(corpus, captured, containsJudge);
    expect(r.subjectAttribution.accuracy).toBe(1);
  });
});

describe('scoreRouting — H4 pending-review compliance', () => {
  const corpus: GoldCorpus = {
    version: 1, generatedAt: 't', generator: 't',
    threads: [{
      id: 'u', stratum: 'email-triage',
      turns: [{ text: 'read it', untrusted: true, externalPayload: 'x' }],
      gold: [{ id: 'g1', fact: 'F1', subject: 'Acme Corp', turnSeq: 0, untrusted: true }],
    }],
  };

  it('untrusted write that stayed active is a violation (blocks flip)', () => {
    const captured = [cap({ threadId: 'u', text: 'F1', status: 'active', sourceUntrusted: true })];
    const routing = scoreRouting(corpus, captured);
    expect(routing.violations).toHaveLength(1);
    expect(routing.violations[0]?.kind).toBe('active-untrusted-write');
    expect(routing.pendingCompliance).toBe(0);
    expect(routing.untrustedWrites).toBe(1);
  });

  it('untrusted write routed to pending_review is clean', () => {
    const captured = [cap({ threadId: 'u', text: 'F1', status: 'pending_review', sourceUntrusted: true })];
    const routing = scoreRouting(corpus, captured);
    expect(routing.violations).toHaveLength(0);
    expect(routing.pendingCompliance).toBe(1);
    expect(routing.untrustedWrites).toBe(1);
  });

  it('a pinned untrusted write is flagged loudly', () => {
    const captured = [cap({ threadId: 'u', text: 'F1', status: 'active', pinned: true, sourceUntrusted: true })];
    const routing = scoreRouting(corpus, captured);
    expect(routing.violations[0]?.detail).toContain('pinned');
  });

  it('a trusted write on an untrusted-labeled turn is NOT a routing violation (junk-rate scores it)', () => {
    // Model wrote from the instruction text without reading the payload → not tainted → clean routing.
    const captured = [cap({ threadId: 'u', text: 'processed an email', status: 'active', sourceUntrusted: false })];
    const routing = scoreRouting(corpus, captured);
    expect(routing.violations).toHaveLength(0);
    expect(routing.untrustedWrites).toBe(0);
  });
});

describe('junk-control accounting', () => {
  it('writes on a junk-control thread feed junkRate and junkControlWrites', async () => {
    const corpus: GoldCorpus = {
      version: 1, generatedAt: 't', generator: 't',
      threads: [{ id: 'j', stratum: 'junk-control', turns: [{ text: 'hi' }], gold: [] }],
    };
    const captured = [
      cap({ threadId: 'j', text: 'user said hi' }),
      cap({ threadId: 'j', text: '15% of 240 is 36' }),
    ];
    const r = await scoreCaptures(corpus, captured, containsJudge);
    expect(r.junk.junkControlWrites).toBe(2);
    expect(r.junk.junkRate).toBe(1);
    expect(r.capture.total).toBe(0);
    expect(r.capture.recall).toBe(1); // vacuous — no gold to miss
  });
});

describe('runReplayEval — full loop with an injected replay', () => {
  it('aggregates scripted captures across a multi-thread corpus', async () => {
    const corpus: GoldCorpus = {
      version: 1, generatedAt: 't', generator: 't',
      threads: [
        { id: 'a', stratum: 'work', turns: [{ text: 'x' }], gold: [{ id: 'ga', fact: 'FA', subject: 'Org A', turnSeq: 0, untrusted: false }] },
        { id: 'b', stratum: 'junk-control', turns: [{ text: 'y' }], gold: [] },
      ],
    };
    // Scripted replay: thread a captures FA correctly; thread b writes nothing.
    const scripted: Record<string, CapturedEntry[]> = {
      a: [cap({ threadId: 'a', text: 'FA recorded', subject: 'Org A' })],
      b: [],
    };
    let progress = 0;
    const r = await runReplayEval(corpus, {
      replayThread: async (t) => scripted[t.id] ?? [],
      onProgress: () => { progress += 1; },
    }, containsJudge);
    expect(progress).toBe(2);
    expect(r.totalThreads).toBe(2);
    expect(r.capture.recall).toBe(1);
    expect(r.junk.junkRate).toBe(0);
  });
});

describe('worstOf — fold N runs into the unlucky case', () => {
  function report(recall: number, junkRate: number, violations: KnowledgeReplayReport['routing']['violations']): KnowledgeReplayReport {
    return {
      totalThreads: 1, totalGold: 1, totalCaptured: 1,
      capture: { recall, matched: 0, total: 1, missed: [] },
      junk: { precision: 1 - junkRate, junkRate, junkCount: 0, junkControlWrites: 0 },
      subjectAttribution: { accuracy: 1, correct: 1, total: 1 },
      routing: { pendingCompliance: 1, untrustedWrites: 0, violations },
      perThread: [],
    };
  }

  it('takes min recall, max junk, and the union of violations', () => {
    const v: KnowledgeReplayReport['routing']['violations'] = [
      { threadId: 'u', turnSeq: 0, text: 'x', kind: 'active-untrusted-write', detail: 'd' },
    ];
    const worst = worstOf([report(0.9, 0.1, []), report(0.6, 0.3, v)]);
    expect(worst.capture.recall).toBe(0.6);
    expect(worst.junk.junkRate).toBe(0.3);
    expect(worst.routing.violations).toHaveLength(1);
  });

  it('a single report is returned unchanged', () => {
    const only = report(0.8, 0.1, []);
    expect(worstOf([only])).toBe(only);
  });
});

describe('normalizeSubject', () => {
  it('folds case, spacing, and diacritics; distinguishes null', () => {
    expect(normalizeSubject('Meridian AG')).toBe(normalizeSubject('  meridian   ag '));
    expect(normalizeSubject('Zürich Söhne')).toBe(normalizeSubject('zurich sohne'));
    expect(normalizeSubject(null)).not.toBe(normalizeSubject('null'));
  });
});

describe('formatReport', () => {
  it('renders the dimensions + points the gate at the comparison', async () => {
    const corpus: GoldCorpus = {
      version: 1, generatedAt: 't', generator: 't',
      threads: [{ id: 't', stratum: 'work', turns: [{ text: 'a' }], gold: [{ id: 'g', fact: 'F', subject: null, turnSeq: 0, untrusted: false }] }],
    };
    const r = await scoreCaptures(corpus, [cap({ threadId: 't', text: 'F' })], containsJudge);
    const out = formatReport(r);
    expect(out).toContain('capture-recall');
    expect(out).toContain('junk-rate');
    expect(out).toContain('routing');
    expect(out).toContain('comparison vs legacy');
  });
});

// ── Tiered coverage (the §5.6 gate metric) ──────────────────────────────────

/** Coverage judge mirror of containsJudge: the block "covers" the gold iff it contains it. */
const containsCoverageJudge: CoverageJudge = (gold, block) => block.includes(gold);

describe('scoreTieredCoverage — coverage over the user-provenance denominator', () => {
  const corpus: GoldCorpus = {
    version: 1, generatedAt: 't', generator: 't',
    threads: [
      {
        id: 'a', stratum: 'work', turns: [{ text: 'x' }],
        gold: [
          { id: 'a1', fact: 'FA1', subject: null, turnSeq: 0, untrusted: false },
          { id: 'a2', fact: 'FA2', subject: null, turnSeq: 0, untrusted: false },
          { id: 'a3', fact: 'FA3', subject: null, turnSeq: 0, untrusted: false },
        ],
      },
      {
        id: 'b', stratum: 'email-triage', turns: [{ text: 'y' }],
        gold: [{ id: 'b1', fact: 'FB1', subject: null, turnSeq: 0, untrusted: false }],
      },
    ],
  };
  // a1/a2 are user-T1, a3 is EXTERNAL (out of the gate denominator), b1 is user-T2.
  const labels = {
    a1: { tier: 'T1', provenance: 'user' },
    a2: { tier: 'T1', provenance: 'user' },
    a3: { tier: 'T1', provenance: 'external' },
    b1: { tier: 'T2', provenance: 'user' },
  } as const;

  it('one consolidated entry covers TWO gold facts — the departure from 1:1', async () => {
    const captured = [cap({ threadId: 'a', text: 'FA1 and FA2 together' })];
    const t = await scoreTieredCoverage(corpus, captured, labels, containsCoverageJudge);
    const t1 = t.tiers.find(x => x.tier === 'T1')!;
    expect(t1.covered).toBe(2); // 1:1 would score exactly one of these
    expect(t1.total).toBe(2);   // a3 is external — OUT of the denominator
    expect(t1.rate).toBe(1);
  });

  it('external/task provenance is excluded from the denominator, and the split is reported', async () => {
    const captured = [cap({ threadId: 'a', text: 'FA3 recorded' })]; // covers only the external fact
    const t = await scoreTieredCoverage(corpus, captured, labels, containsCoverageJudge);
    const t1 = t.tiers.find(x => x.tier === 'T1')!;
    expect(t1.covered).toBe(0); // FA3 covered, but it does not count for the gate
    expect(t.denominator).toEqual({ userFacts: 3, allFacts: 4 });
  });

  it('the candidate block carries EVERY row — a fact stored in the second entry is covered', async () => {
    const captured = [
      cap({ threadId: 'a', text: 'FA1 recorded' }),
      cap({ threadId: 'a', text: 'FA2 recorded' }),
    ];
    const t = await scoreTieredCoverage(corpus, captured, labels, containsCoverageJudge);
    expect(t.tiers.find(x => x.tier === 'T1')!.covered).toBe(2);
  });

  it('a thread that stored nothing is uncovered WITHOUT a judge call', async () => {
    let calls = 0;
    const countingJudge: CoverageJudge = (gold, block) => { calls += 1; return block.includes(gold); };
    const captured = [cap({ threadId: 'a', text: 'FA1' })]; // thread b stored nothing
    const t = await scoreTieredCoverage(corpus, captured, labels, countingJudge);
    expect(calls).toBe(3); // only thread a's three facts were judged
    expect(t.judged).toBe(3);
    expect(t.tiers.find(x => x.tier === 'T2')!.covered).toBe(0);
  });

  it('partial-run scoping shrinks the denominator instead of inflating the rate', async () => {
    const captured = [cap({ threadId: 'a', text: 'FA1 FA2' })];
    const t = await scoreTieredCoverage(corpus, captured, labels, containsCoverageJudge, {
      ranThreadIds: new Set(['a']),
    });
    expect(t.partialRun).toBe(true);
    expect(t.tiers.map(x => x.tier)).toEqual(['T1']); // T2 lives on the un-replayed thread
    expect(t.denominator.userFacts).toBe(2);
  });

  it('a judge that throws yields a MISSING verdict — neither covered nor a silent miss', async () => {
    const flakyJudge: CoverageJudge = (gold, block) => {
      if (gold === 'FA2') throw new Error('judge down');
      return block.includes(gold);
    };
    const captured = [cap({ threadId: 'a', text: 'FA1 FA2' })];
    const t = await scoreTieredCoverage(corpus, captured, labels, flakyJudge);
    expect(t.judgeErrors).toEqual(['a2']);
    const t1 = t.tiers.find(x => x.tier === 'T1')!;
    expect(t1.covered).toBe(1); // FA1 only — the errored fact did not become a "no"
  });

  it('formatTieredReport names the denominator, the partial-run caveat, and judge failures', async () => {
    const captured = [cap({ threadId: 'a', text: 'FA1' })];
    const t = await scoreTieredCoverage(corpus, captured, labels, containsCoverageJudge, {
      ranThreadIds: new Set(['a']),
    });
    const out = formatTieredReport(t);
    expect(out).toContain('PARTIAL RUN');
    expect(out).toContain('T1 coverage: 1/2');
    expect(out).toContain('product target');
  });
});

describe('parseGoldFactLabels — both label-file shapes', () => {
  it('passes a flat GoldFactLabels record through unchanged', () => {
    const flat = { f1: { tier: 'T1', provenance: 'user' } };
    expect(parseGoldFactLabels(flat)).toEqual(flat);
  });

  it('merges the operator-local shape (items[].tier + provenance map) per fact id', () => {
    const parsed = parseGoldFactLabels({
      provenance: { f1: 'user', f2: 'external' },
      items: [{ id: 'f1', tier: 'T1' }, { id: 'f2', tier: 'T2' }, { id: 'f3', tier: 'T2' }],
    });
    expect(parsed['f1']).toEqual({ tier: 'T1', provenance: 'user' });
    expect(parsed['f2']).toEqual({ tier: 'T2', provenance: 'external' });
    expect(parsed['f3']).toEqual({ tier: 'T2' }); // unlabeled provenance stays absent, not 'user'
  });

  it('rejects a non-object', () => {
    expect(() => parseGoldFactLabels('nope')).toThrow();
  });
});

// ── Comparison gate (PRD §5.6.3 — the binding flip gate) ─────────────────────

describe('meetsComparisonGate — DK not below legacy on any axis, beats junk + routing', () => {
  function tiered(t1: number, t2: number): TieredCoverageReport {
    const mk = (tier: string, rate: number): TieredCoverageReport['tiers'][number] =>
      ({ tier, covered: Math.round(rate * 10), total: 10, rate });
    return {
      tiers: [mk('T1', t1), mk('T2', t2)],
      strata: [], covered: [], judgeErrors: [], judged: 20, partialRun: false,
      denominator: { userFacts: 20, allFacts: 30 },
    };
  }
  function report(junkRate: number, violations: number, attribution = 1): KnowledgeReplayReport {
    return {
      totalThreads: 1, totalGold: 1, totalCaptured: 1,
      capture: { recall: 1, matched: 1, total: 1, missed: [] },
      junk: { precision: 1 - junkRate, junkRate, junkCount: 0, junkControlWrites: 0 },
      subjectAttribution: { accuracy: attribution, correct: 1, total: 1 },
      routing: {
        pendingCompliance: 1, untrustedWrites: violations,
        violations: Array.from({ length: violations }, (_, i) => ({
          threadId: 'u', turnSeq: i, text: 'x', kind: 'active-untrusted-write' as const, detail: 'd',
        })),
      },
      perThread: [],
    };
  }

  it('the measured §5.6.3 constellation passes (DK above on tiers, beats junk, clean routing)', () => {
    const v = meetsComparisonGate(
      { tiered: tiered(0.8, 0.5), report: report(0.37, 0) },
      { tiered: tiered(0.5, 0.5), report: report(0.75, 4, 0) },
    );
    expect(v.pass).toBe(true);
    expect(v.axes.every(a => a.ok)).toBe(true);
  });

  it('DK below legacy on ONE tier fails the whole gate', () => {
    const v = meetsComparisonGate(
      { tiered: tiered(0.8, 0.4), report: report(0.3, 0) },
      { tiered: tiered(0.5, 0.5), report: report(0.7, 4) },
    );
    expect(v.pass).toBe(false);
    expect(v.axes.find(a => a.axis === 'T2 coverage')!.ok).toBe(false);
  });

  it('junk must be STRICTLY better — a tie fails', () => {
    const v = meetsComparisonGate(
      { tiered: tiered(0.8, 0.6), report: report(0.4, 0) },
      { tiered: tiered(0.5, 0.5), report: report(0.4, 4) },
    );
    expect(v.pass).toBe(false);
    expect(v.axes.find(a => a.axis === 'junk-rate')!.ok).toBe(false);
  });

  it('any DK routing violation fails, even when legacy is worse', () => {
    const v = meetsComparisonGate(
      { tiered: tiered(0.9, 0.9), report: report(0.1, 1) },
      { tiered: tiered(0.1, 0.1), report: report(0.9, 4) },
    );
    expect(v.pass).toBe(false);
    expect(v.axes.find(a => a.axis === 'routing violations')!.ok).toBe(false);
  });

  it('a clean legacy does NOT make zero-violation DK fail the routing tie', () => {
    const v = meetsComparisonGate(
      { tiered: tiered(0.8, 0.6), report: report(0.2, 0) },
      { tiered: tiered(0.5, 0.5), report: report(0.4, 0) },
    );
    expect(v.axes.find(a => a.axis === 'routing violations')!.ok).toBe(true);
    expect(v.pass).toBe(true);
  });

  it('subject-attribution below legacy fails (not-below axis)', () => {
    const v = meetsComparisonGate(
      { tiered: tiered(0.8, 0.6), report: report(0.2, 0, 0.5) },
      { tiered: tiered(0.5, 0.5), report: report(0.4, 4, 0.9) },
    );
    expect(v.pass).toBe(false);
    expect(v.axes.find(a => a.axis === 'subject-attribution')!.ok).toBe(false);
  });

  it('formatComparison renders every axis and the verdict', () => {
    const v = meetsComparisonGate(
      { tiered: tiered(0.8, 0.5), report: report(0.37, 0) },
      { tiered: tiered(0.5, 0.5), report: report(0.75, 4) },
    );
    const out = formatComparison(v);
    expect(out).toContain('T1 coverage');
    expect(out).toContain('junk-rate');
    expect(out).toContain('routing violations');
    expect(out).toContain('GATE: MET');
  });
});

// ── Fixture shape (the committed synthetic corpus) ──────────────────────────

function loadFixture(): GoldCorpus {
  return JSON.parse(readFileSync(join(__dirname, 'knowledge-substrate-fixtures.json'), 'utf8')) as GoldCorpus;
}

describe('knowledge-substrate-fixtures.json — corpus shape', () => {
  const corpus = loadFixture();

  it('covers all three strata with ≥7 threads', () => {
    expect(corpus.threads.length).toBeGreaterThanOrEqual(7);
    const strata = new Set(corpus.threads.map(t => t.stratum));
    expect(strata).toEqual(new Set(['work', 'email-triage', 'junk-control']));
  });

  it('every gold turnSeq is within its thread and untrusted flags agree with the turn', () => {
    for (const t of corpus.threads) {
      for (const g of t.gold) {
        expect(g.turnSeq).toBeGreaterThanOrEqual(0);
        expect(g.turnSeq).toBeLessThan(t.turns.length);
        // A gold fact marked untrusted must sit on an untrusted turn (and vice-versa).
        expect(t.turns[g.turnSeq]?.untrusted === true).toBe(g.untrusted);
      }
    }
  });

  it('untrusted turns carry the fact in the payload, NOT the user text', () => {
    for (const t of corpus.threads) {
      for (let i = 0; i < t.turns.length; i += 1) {
        const turn = t.turns[i]!;
        if (turn.untrusted !== true) continue;
        expect(turn.externalPayload, `${t.id} t${i} needs an externalPayload`).toBeTruthy();
        // Each untrusted gold fact's subject must appear in the payload, not the instruction text.
        for (const g of t.gold.filter(g => g.turnSeq === i && g.subject)) {
          expect(turn.externalPayload!.toLowerCase()).toContain(g.subject!.toLowerCase());
          expect(turn.text.toLowerCase()).not.toContain(g.subject!.toLowerCase());
        }
      }
    }
  });

  it('junk-control threads have no gold facts', () => {
    for (const t of corpus.threads.filter(t => t.stratum === 'junk-control')) {
      expect(t.gold).toHaveLength(0);
    }
  });

  it('uses only placeholder identifiers (coarse anti-PII smell test)', () => {
    // The authoritative check is that the file is hand-authored synthetic; this
    // guards against a future regenerate leaking a real name/domain.
    const blob = JSON.stringify(corpus).toLowerCase();
    const emails = blob.match(/[a-z0-9._-]+@[a-z0-9.-]+/g) ?? [];
    for (const e of emails) {
      expect(e.endsWith('.example') || e.includes('example'), `non-placeholder email ${e}`).toBe(true);
    }
    expect(blob).not.toContain('lynox.cloud');
  });
});
