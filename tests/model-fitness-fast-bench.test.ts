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
  RUBRIC_SIZE, LITERAL_RECALL_BAR, MIN_JUDGE_NOISE, INPUT_SANITY_FLOOR,
  aggregateBenchRows, aggregateClassify, buildRubricJudgePrompt, checkInputSanity,
  checkServedModel, decideClassifySlot, decideFastSlot, expandPad, expandTranscript,
  isRowValid, literalsMissingFromTranscript, modelFamily, normalizeForMatch,
  parseLabelsFile, parseRubricJudgeResponse, parseTranscript, pickJudgeModel,
  scoreClassification, scoreLiteralRecall, stddev,
  type BenchRow, type PadBlock, type Transcript,
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

  it('folds digit-group separators, so a re-grouped number still matches (2026-08-09 calibration)', () => {
    // The reference missed 18'114 / 1'891 / 50'000 purely on grouping style.
    expect(scoreLiteralRecall('activity count 18,114 verified; base now 1891 contacts', ["18'114", "1'891"]).recall).toBe(1);
    expect(scoreLiteralRecall('penalty capped at CHF 50 000 per year', ["50'000"]).recall).toBe(1);
    expect(scoreLiteralRecall('order total CHF 3’184.00', ['3184']).recall).toBe(1);
  });

  it('folds spacing around slashes and before percent signs', () => {
    expect(scoreLiteralRecall('sized at 4 vCPU/16 GB/100 GB SSD', ['4 vCPU / 16 GB / 100 GB SSD']).recall).toBe(1);
    expect(scoreLiteralRecall('permanent discount of 15 %', ['15%']).recall).toBe(1);
  });

  it('accepts ANY variant of an alternates literal and reports the canonical name', () => {
    const r = scoreLiteralRecall('the audit trail holds 48.2M rows', [["48'200'113", '48.2M'], 'booking_events']);
    expect(r.hits).toEqual(["48'200'113"]);
    expect(r.misses).toEqual(['booking_events']);
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

  it('strips an exposed reasoning channel so verdicts inside <think> are never read as verdicts', () => {
    const think = '<think>ELEMENT 1: PASS — no wait, actually FAIL. Let me reconsider all of them…</think>\n';
    const verdicts = Array.from({ length: 8 }, (_, i) => `ELEMENT ${i + 1}: FAIL — missing`).join('\n');
    const r = parseRubricJudgeResponse(think + verdicts);
    expect(r.invalid).toBe(false);
    expect(r.score).toBe(0);
    // Reasoning-only reply (the GLM max_tokens failure mode) stays fail-closed:
    expect(parseRubricJudgeResponse('<think>hmm rubric…</think>').invalid).toBe(true);
  });

  it('tolerates markdown decoration between the element label and the verdict', () => {
    const r = parseRubricJudgeResponse(Array.from({ length: 8 }, (_, i) => `**ELEMENT ${i + 1}:** PASS — ok`).join('\n'));
    expect(r.invalid).toBe(false);
    expect(r.score).toBe(8);
  });

  it('does not let prose "passes"/"failing" count as a verdict, and ELEMENT 1 never matches ELEMENT 12', () => {
    const prose = 'ELEMENT 1: the summary passes over this entirely\n' + Array.from({ length: 7 }, (_, i) => `ELEMENT ${i + 2}: PASS`).join('\n');
    expect(parseRubricJudgeResponse(prose).invalid).toBe(true);
    // Element 1's tolerant regex must not bind to an "ELEMENT 12" line.
    expect(parseRubricJudgeResponse('ELEMENT 12: PASS', 1).invalid).toBe(true);
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

describe('checkServedModel (three-state)', () => {
  it('verifies the requested model incl. fireworks prefix and version-suffix variants', () => {
    expect(checkServedModel('accounts/fireworks/models/gpt-oss-120b', 'gpt-oss-120b').status).toBe('verified');
    expect(checkServedModel('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001').status).toBe('verified');
    expect(checkServedModel('claude-haiku-4-5', 'claude-haiku-4-5-20251001').status).toBe('verified');
  });

  it('flags a substituted model as mismatch', () => {
    const r = checkServedModel('accounts/fireworks/models/deepseek-v4-flash', 'deepseek-v3');
    expect(r.status).toBe('mismatch');
    expect(r.note).toContain('deepseek-v3');
  });

  it('reports a missing model as unreported, NOT as mismatch', () => {
    // Revised 2026-08-09: OpenAIAdapter never propagates the wire model, so a
    // fail-closed boolean invalidated every non-Anthropic candidate — the
    // guard blocked the instrument. Unreported must be distinguishable from
    // substitution evidence, and only the latter invalidates (isRowValid).
    expect(checkServedModel('claude-haiku-4-5', undefined).status).toBe('unreported');
    expect(checkServedModel('claude-haiku-4-5', '  ').status).toBe('unreported');
  });
});

describe('checkInputSanity', () => {
  it('flags the degraded-provider row (tok in=1 for a 30k-token transcript)', () => {
    const r = checkInputSanity(1, 30_000);
    expect(r.ok).toBe(false);
    expect(r.note).toContain('not processed');
  });

  it('tolerates provider-tokenizer variance and absent usage reports', () => {
    expect(checkInputSanity(9_000, 30_000).ok).toBe(true);   // 0.3x of chars/4
    expect(checkInputSanity(101_845, 33_626).ok).toBe(true); // 3x (observed, Mistral)
    expect(checkInputSanity(0, 30_000).ok).toBe(true);       // no usage reported
    expect(INPUT_SANITY_FLOOR).toBe(0.05);
  });
});

describe('isRowValid + aggregateBenchRows', () => {
  const base: BenchRow = {
    label: 'x', transcriptId: 't', run: 1, literalRecall: 1, misses: [],
    judgeScore: 8, judgeInvalid: false, judgeModel: 'j',
    served: 'unreported', servedNote: '', sanityOk: true, sanityNote: '',
    latencyMs: 1, inTok: 10_000, outTok: 500, stopReason: 'end_turn',
    judgeStopReason: 'end_turn', summary: 's', judgeRaw: 'r',
  };

  it('unreported served does not invalidate a row; mismatch, judge-invalid, error and sanity do', () => {
    expect(isRowValid(base)).toBe(true);
    expect(isRowValid({ ...base, served: 'mismatch' })).toBe(false);
    expect(isRowValid({ ...base, judgeInvalid: true })).toBe(false);
    expect(isRowValid({ ...base, error: '412' })).toBe(false);
    expect(isRowValid({ ...base, sanityOk: false })).toBe(false);
  });

  it('averages over VALID rows only, so a transient outage cannot drag the mean', () => {
    const rows: BenchRow[] = [
      { ...base, literalRecall: 1, judgeScore: 8 },
      { ...base, literalRecall: 0.9, judgeScore: 7 },
      { ...base, literalRecall: 0, judgeScore: 0, judgeInvalid: true, error: '412 suspended' },
    ];
    const agg = aggregateBenchRows(rows);
    expect(agg.literalRecall).toBeCloseTo(0.95);
    expect(agg.judgeMean).toBeCloseTo(7.5);
    expect(agg.validRuns).toBe(2);
    expect(agg.invalid).toBe(false);
    expect(agg.invalidReasons.join(' ')).toContain('412');
  });

  it('goes invalid when fewer than half the rows are valid — an outage is not a measurement', () => {
    const bad = { ...base, error: '412' };
    expect(aggregateBenchRows([base, bad, bad]).invalid).toBe(true);
    expect(aggregateBenchRows([base, base, bad]).invalid).toBe(false);
    expect(aggregateBenchRows([]).invalid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fast-slot decision rule (P3)
// ---------------------------------------------------------------------------

describe('decideFastSlot', () => {
  const ref = { literalRecall: 0.98, judgeMean: 7.0, judgeStd: 0.3, invalid: false };

  it('declares the bar unresolvable when the REFERENCE itself misses it (2026-08-09: ref at 91.5%)', () => {
    const badRef = { ...ref, literalRecall: 0.915 };
    const v = decideFastSlot({ literalRecall: 1, judgeMean: 8, invalid: false }, badRef);
    expect(v.verdict).toBe('INVALID');
    expect(v.reasons.join(' ')).toContain('unresolvable');
    // A perfect candidate must NOT be held on a miscalibrated checklist either.
    expect(v.verdict).not.toBe('HOLD');
  });

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
    const wideRef = { literalRecall: 0.98, judgeMean: 7.0, judgeStd: 1.0, invalid: false };
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
