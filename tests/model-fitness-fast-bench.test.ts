/**
 * Unit coverage for the FAST-slot bench's pure decision helpers
 * (`scripts/model-fitness/fast-bench-lib.ts`) plus the corpus instrument checks.
 *
 * Same arrangement as `tests/model-fitness-replay.test.ts`: this arithmetic decides
 * which model gets the production fast slot, and `scripts/` is outside both the
 * tsconfig and the vitest include — so everything verdict-shaped lives in the lib
 * and is exercised here.
 *
 * The corpus tests are INSTRUMENT tests (eval-preflight): a planted literal that
 * never occurs in its transcript would cap every candidate's recall below 1.0
 * with no symptom — a plausible number measuring nothing.
 */
import { describe, it, expect } from 'vitest';
import { buildCompactionSummaryPrompt } from '../src/core/compaction-prompt.js';
import { MODEL_CAPABILITIES } from '../src/types/models.js';
import {
  RUBRIC_SIZE, LITERAL_RECALL_BAR, MIN_JUDGE_NOISE,
  aggregateClassify, buildRubricJudgePrompt, checkServedModel, decideClassifySlot,
  decideFastSlot, expandPad, expandTranscript, literalsMissingFromTranscript,
  modelFamily, normalizeForMatch, parseLabelsFile, parseRubricJudgeResponse,
  parseTranscript, pickJudgeModel, scoreClassification, scoreLiteralRecall, stddev,
  type PadBlock, type Transcript,
} from '../scripts/model-fitness/fast-bench-lib.js';
import { FAST_CANDIDATES, loadCorpus, preflightCorpus } from '../scripts/model-fitness/fast-bench.js';

// ---------------------------------------------------------------------------
// Corpus instrument checks
// ---------------------------------------------------------------------------

describe('fast-corpus instrument', () => {
  const corpus = loadCorpus();

  it('has exactly the 12 transcripts the P3 design specifies', () => {
    expect(corpus.map(t => t.id).length).toBe(12);
    expect(new Set(corpus.map(t => t.id)).size).toBe(12);
  });

  it('plants every checklist literal in hand-authored transcript text (never only in a pad)', () => {
    for (const t of corpus) {
      expect(literalsMissingFromTranscript(t), t.id).toEqual([]);
    }
  });

  it('gives every transcript exactly 8 rubric elements', () => {
    for (const t of corpus) expect(t.checklist.rubric.length, t.id).toBe(RUBRIC_SIZE);
  });

  it('expands every transcript into the 20k-80k token band (real thread length)', () => {
    for (const t of corpus) {
      const { approxTokens } = expandTranscript(t);
      expect(approxTokens, t.id).toBeGreaterThanOrEqual(20_000);
      expect(approxTokens, t.id).toBeLessThanOrEqual(80_000);
    }
  });

  it('preflightCorpus passes on the shipped corpus and fails on a poisoned checklist', () => {
    expect(preflightCorpus(corpus)).toEqual([]);
    const poisoned: Transcript = JSON.parse(JSON.stringify(corpus[0])) as Transcript;
    poisoned.checklist.literals.push('THIS-LITERAL-OCCURS-NOWHERE-XYZZY');
    expect(preflightCorpus([poisoned]).length).toBeGreaterThan(0);
  });

  it('parseTranscript refuses shape drift', () => {
    expect(() => parseTranscript({})).toThrow();
    expect(() => parseTranscript({ schema: 'fast-bench-transcript/v1', id: 'x', title: 'x', targetTokens: 1, messages: [{}], checklist: { literals: [], rubric: [] } })).toThrow(/literals/);
    const rubric7 = { schema: 'fast-bench-transcript/v1', id: 'x', title: 'x', targetTokens: 1, messages: [{}], checklist: { literals: ['a'], rubric: ['1', '2', '3', '4', '5', '6', '7'] } };
    expect(() => parseTranscript(rubric7)).toThrow(/rubric/);
  });

  it('pad expansion is deterministic per seed and differs across seeds', () => {
    const pad: PadBlock = { type: 'pad', generator: 'httplog', lines: 50, seed: 7 };
    expect(expandPad(pad)).toBe(expandPad(pad));
    expect(expandPad(pad)).not.toBe(expandPad({ ...pad, seed: 8 }));
    expect(expandPad(pad).split('\n')).toHaveLength(50);
  });

  it('expands tool_result pads into text blocks the wire can carry', () => {
    const t = corpus.find(x => x.id === 't01-shop-api-403')!;
    const { messages } = expandTranscript(t);
    const kinds = new Set(messages.flatMap(m => m.content.map(b => b.type)));
    expect(kinds).toContain('tool_use');
    expect(kinds).toContain('tool_result');
    expect(kinds).not.toContain('pad');
    for (const m of messages) {
      for (const b of m.content) {
        if (b.type === 'tool_result') for (const c of b.content) expect(c.type).toBe('text');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Literal recall
// ---------------------------------------------------------------------------

describe('scoreLiteralRecall', () => {
  it('scores contained literals as hits and absent ones as misses', () => {
    const r = scoreLiteralRecall('Rotated key falkenrath-wc-v2, ticket TCK-2214 stays open.', ['falkenrath-wc-v2', 'TCK-2214', '203.0.113.44']);
    expect(r.hits).toEqual(['falkenrath-wc-v2', 'TCK-2214']);
    expect(r.misses).toEqual(['203.0.113.44']);
    expect(r.recall).toBeCloseTo(2 / 3);
    expect(r.invalid).toBe(false);
  });

  it('matches across case, whitespace and typographic re-typesetting', () => {
    expect(scoreLiteralRecall('summary says  INV-2026-0417  was booked', ['inv-2026-0417']).recall).toBe(1);
    expect(scoreLiteralRecall('the “falkenrath–wc–v2” key', ['"falkenrath-wc-v2"']).recall).toBe(1);
    expect(normalizeForMatch('A  B’s — c')).toBe("a b's - c");
  });

  it('fails closed on an empty literal list instead of reporting a perfect score', () => {
    const r = scoreLiteralRecall('anything', []);
    expect(r.invalid).toBe(true);
    expect(r.recall).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rubric judge parsing
// ---------------------------------------------------------------------------

describe('parseRubricJudgeResponse', () => {
  const full = (verdicts: string[]): string =>
    verdicts.map((v, i) => `ELEMENT ${i + 1}: ${v} — reason`).join('\n') + `\nSCORE: ${verdicts.filter(v => v.toUpperCase() === 'PASS').length}`;

  it('counts PASS verdicts across all 8 elements', () => {
    const r = parseRubricJudgeResponse(full(['PASS', 'PASS', 'FAIL', 'PASS', 'PASS', 'FAIL', 'PASS', 'PASS']));
    expect(r.invalid).toBe(false);
    expect(r.score).toBe(6);
    expect(r.perElement).toEqual([true, true, false, true, true, false, true, true]);
  });

  it('fails closed when any element verdict is missing — a partial reply is not a measurement', () => {
    const seven = Array.from({ length: 7 }, (_, i) => `ELEMENT ${i + 1}: PASS`).join('\n');
    const r = parseRubricJudgeResponse(seven);
    expect(r.invalid).toBe(true);
    expect(r.score).toBe(0);
  });

  it('trusts the counted verdicts over a contradicting declared SCORE line', () => {
    const text = Array.from({ length: 8 }, (_, i) => `ELEMENT ${i + 1}: FAIL`).join('\n') + '\nSCORE: 8';
    const r = parseRubricJudgeResponse(text);
    expect(r.score).toBe(0);
    expect(r.reasoning).toContain('declared SCORE 8 != counted 0');
  });

  it('is case-insensitive on pass/fail', () => {
    const r = parseRubricJudgeResponse(Array.from({ length: 8 }, (_, i) => `Element ${i + 1}: pass`).join('\n'));
    expect(r.score).toBe(8);
  });

  it('buildRubricJudgePrompt enumerates every rubric element and demands the parseable format', () => {
    const p = buildRubricJudgePrompt(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'digest', 'summary');
    expect(p).toContain('ELEMENT 8');
    expect(p).toContain('PASS|FAIL');
  });
});

// ---------------------------------------------------------------------------
// Judge selection (DEF-replay-judge-self-family)
// ---------------------------------------------------------------------------

describe('pickJudgeModel', () => {
  it('never assigns a judge from the candidate model family — for every registered candidate', () => {
    for (const c of FAST_CANDIDATES) {
      const judge = pickJudgeModel(c.modelId);
      expect(modelFamily(judge.modelId), c.label).not.toBe(modelFamily(c.modelId));
    }
  });

  it('flips the anthropic reference (haiku) to the non-anthropic deep judge', () => {
    const judge = pickJudgeModel('claude-haiku-4-5-20251001');
    expect(modelFamily(judge.modelId)).not.toBe('anthropic');
    expect(judge.provider).toBe('openai');
  });

  it('gives non-anthropic candidates the anthropic deep judge', () => {
    const judge = pickJudgeModel('accounts/fireworks/models/deepseek-v4-flash');
    expect(modelFamily(judge.modelId)).toBe('anthropic');
  });
});

describe('FAST_CANDIDATES registry pin', () => {
  it('every candidate model id is registered in MODEL_CAPABILITIES (a typo would otherwise fail only live)', () => {
    for (const c of FAST_CANDIDATES) {
      expect(MODEL_CAPABILITIES[c.modelId], c.label).toBeDefined();
    }
  });

  it('has exactly one reference, and it is the current fast slot (haiku-4.5)', () => {
    const refs = FAST_CANDIDATES.filter(c => c.reference);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.modelId).toBe('claude-haiku-4-5-20251001');
  });
});

// ---------------------------------------------------------------------------
// Served-model guard
// ---------------------------------------------------------------------------

describe('checkServedModel', () => {
  it('accepts the requested model incl. fireworks prefix and version-suffix variants', () => {
    expect(checkServedModel('accounts/fireworks/models/gpt-oss-120b', 'gpt-oss-120b').ok).toBe(true);
    expect(checkServedModel('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001').ok).toBe(true);
    expect(checkServedModel('claude-haiku-4-5', 'claude-haiku-4-5-20251001').ok).toBe(true);
  });

  it('flags a substituted model', () => {
    const r = checkServedModel('accounts/fireworks/models/deepseek-v4-flash', 'deepseek-v3');
    expect(r.ok).toBe(false);
    expect(r.note).toContain('deepseek-v3');
  });

  it('fails closed when the provider does not report the served model', () => {
    expect(checkServedModel('claude-haiku-4-5', undefined).ok).toBe(false);
    expect(checkServedModel('claude-haiku-4-5', '  ').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fast-slot decision rule (P3)
// ---------------------------------------------------------------------------

describe('decideFastSlot', () => {
  const ref = { judgeMean: 7.0, judgeStd: 0.3, invalid: false };

  it('holds only at or above the 95% literal-recall bar', () => {
    expect(decideFastSlot({ literalRecall: 0.95, judgeMean: 7.0, invalid: false }, ref).verdict).toBe('HOLD');
    const fail = decideFastSlot({ literalRecall: 0.94, judgeMean: 8.0, invalid: false }, ref);
    expect(fail.verdict).toBe('FAIL');
    expect(fail.reasons.join(' ')).toContain('literal recall');
    expect(LITERAL_RECALL_BAR).toBe(0.95);
  });

  it('applies the within-noise band around the reference judge mean', () => {
    // std 0.3 < MIN_JUDGE_NOISE 0.5 → band is 0.5
    expect(decideFastSlot({ literalRecall: 1, judgeMean: 6.5, invalid: false }, ref).verdict).toBe('HOLD');
    const fail = decideFastSlot({ literalRecall: 1, judgeMean: 6.49, invalid: false }, ref);
    expect(fail.verdict).toBe('FAIL');
    expect(fail.reasons.join(' ')).toContain('below reference');
  });

  it('uses the measured reference std when it exceeds the noise floor', () => {
    const wideRef = { judgeMean: 7.0, judgeStd: 1.0, invalid: false };
    expect(decideFastSlot({ literalRecall: 1, judgeMean: 6.0, invalid: false }, wideRef).verdict).toBe('HOLD');
    expect(decideFastSlot({ literalRecall: 1, judgeMean: 5.9, invalid: false }, wideRef).verdict).toBe('FAIL');
    expect(MIN_JUDGE_NOISE).toBe(0.5);
  });

  it('returns INVALID (never HOLD) when either side is invalid', () => {
    expect(decideFastSlot({ literalRecall: 1, judgeMean: 8, invalid: true }, ref).verdict).toBe('INVALID');
    expect(decideFastSlot({ literalRecall: 1, judgeMean: 8, invalid: false }, { ...ref, invalid: true }).verdict).toBe('INVALID');
  });

  it('reports BOTH failure reasons when both bars miss', () => {
    const r = decideFastSlot({ literalRecall: 0.5, judgeMean: 2, invalid: false }, ref);
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons).toHaveLength(2);
  });
});

describe('stddev', () => {
  it('computes the sample std and is 0 for fewer than 2 values', () => {
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(stddev([5])).toBe(0);
    expect(stddev([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Classification replay scoring
// ---------------------------------------------------------------------------

describe('parseLabelsFile', () => {
  it('accepts the documented shape and rejects unknown buckets', () => {
    expect(parseLabelsFile({ entries: [{ file: 'raw-a.json', expected: 'requires_user' }] })).toEqual([{ file: 'raw-a.json', expected: 'requires_user' }]);
    expect(() => parseLabelsFile({ entries: [{ file: 'raw-a.json', expected: 'noise' }] })).toThrow(/expected/);
    expect(() => parseLabelsFile({ entries: [{ expected: 'draft_ready' }] })).toThrow(/file/);
    expect(() => parseLabelsFile([])).toThrow(/entries/);
  });
});

describe('scoreClassification', () => {
  it('marks missedRequiresUser ONLY when ground truth is requires_user and the model routed elsewhere', () => {
    expect(scoreClassification({ bucket: 'auto_handled', failReason: null }, 'requires_user').missedRequiresUser).toBe(true);
    expect(scoreClassification({ bucket: 'requires_user', failReason: null }, 'requires_user').missedRequiresUser).toBe(false);
    // The reverse error (over-routing TO requires_user) is wrong but NOT the asymmetric miss.
    const over = scoreClassification({ bucket: 'requires_user', failReason: null }, 'draft_ready');
    expect(over.correct).toBe(false);
    expect(over.missedRequiresUser).toBe(false);
  });

  it('carries the fail-closed signal through', () => {
    const r = scoreClassification({ bucket: 'requires_user', failReason: 'json_parse_error' }, 'requires_user');
    expect(r.failClosed).toBe(true);
    expect(r.correct).toBe(true);
  });
});

describe('aggregateClassify + decideClassifySlot', () => {
  const row = (correct: boolean, missed = false, failClosed = false) => ({ correct, missedRequiresUser: missed, failClosed });

  it('aggregates accuracy, misses and fail-closed rate; empty input is invalid, not perfect', () => {
    const agg = aggregateClassify([row(true), row(true), row(false, true), row(true, false, true)]);
    expect(agg.accuracy).toBe(0.75);
    expect(agg.missedRequiresUser).toBe(1);
    expect(agg.failClosedRate).toBe(0.25);
    expect(aggregateClassify([]).invalid).toBe(true);
  });

  it('a single missed requires_user disqualifies regardless of accuracy', () => {
    const cand = { total: 50, accuracy: 0.98, missedRequiresUser: 1, failClosedRate: 0, invalid: false };
    const ref = { total: 50, accuracy: 0.9, missedRequiresUser: 0, failClosedRate: 0, invalid: false };
    const v = decideClassifySlot(cand, ref);
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join(' ')).toContain('requires_user');
  });

  it('holds within the accuracy noise band and fails below it', () => {
    const ref = { total: 50, accuracy: 0.90, missedRequiresUser: 0, failClosedRate: 0, invalid: false };
    // noise = max(1/50, 0.02) = 0.02
    expect(decideClassifySlot({ total: 50, accuracy: 0.88, missedRequiresUser: 0, failClosedRate: 0, invalid: false }, ref).verdict).toBe('HOLD');
    expect(decideClassifySlot({ total: 50, accuracy: 0.87, missedRequiresUser: 0, failClosedRate: 0, invalid: false }, ref).verdict).toBe('FAIL');
  });

  it('returns INVALID when either aggregate is invalid', () => {
    const ok = { total: 10, accuracy: 1, missedRequiresUser: 0, failClosedRate: 0, invalid: false };
    expect(decideClassifySlot({ ...ok, invalid: true }, ok).verdict).toBe('INVALID');
    expect(decideClassifySlot(ok, { ...ok, invalid: true }).verdict).toBe('INVALID');
  });
});

// ---------------------------------------------------------------------------
// Production prompt (the bench must send what production sends)
// ---------------------------------------------------------------------------

describe('buildCompactionSummaryPrompt', () => {
  it('carries the structural survival list and the provenance/forgery clauses', () => {
    const p = buildCompactionSummaryPrompt();
    expect(p).toContain('Summarize the conversation so far');
    expect(p).toContain('decisions made (and why)');
    expect(p).toContain('open tasks (keep their ids)');
    expect(p).toContain('<fact kind=');
    expect(p).toContain('NOT engine markers');
  });

  it('appends the focus clause only when a focus is given', () => {
    expect(buildCompactionSummaryPrompt('billing')).toContain('Give extra weight to: billing.');
    expect(buildCompactionSummaryPrompt()).not.toContain('Give extra weight');
  });
});
