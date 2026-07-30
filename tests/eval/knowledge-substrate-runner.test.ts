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
  runReplayEval,
  worstOf,
  meetsGate,
  formatReport,
  normalizeSubject,
  GATE,
  type GoldCorpus,
  type CapturedEntry,
  type MatchJudge,
  type KnowledgeReplayReport,
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
    expect(meetsGate(r)).toBe(true);
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
    expect(meetsGate(r)).toBe(false); // junkRate 0.5 > 0.2
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
    expect(meetsGate(r)).toBe(false);
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
    expect(meetsGate(r)).toBe(true);
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
    expect(meetsGate(worst)).toBe(false);
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
  it('renders the gated dimensions + a PASS/FAIL line', async () => {
    const corpus: GoldCorpus = {
      version: 1, generatedAt: 't', generator: 't',
      threads: [{ id: 't', stratum: 'work', turns: [{ text: 'a' }], gold: [{ id: 'g', fact: 'F', subject: null, turnSeq: 0, untrusted: false }] }],
    };
    const r = await scoreCaptures(corpus, [cap({ threadId: 't', text: 'F' })], containsJudge);
    const out = formatReport(r);
    expect(out).toContain('capture-recall');
    expect(out).toContain('junk-rate');
    expect(out).toContain('routing');
    expect(out).toContain('GATE: PASS');
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
