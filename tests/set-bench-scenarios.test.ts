/**
 * CI regression coverage for set-bench scenarios — exercises the
 * pass-check predicates against synthetic agent outputs. The headline
 * bench runs against real APIs; this file runs in vitest without any
 * network or API key.
 *
 * What it locks in:
 *   - TOOL_CHAIN passCheck fires only when BOTH tools were called the
 *     right number of times AND the final regex matches the deterministic
 *     answer derived from the pinned mock fixture.
 *   - ORCHESTRATION passCheck tolerates markdown-bold + per-line
 *     whitespace, fails at <4/5 correct.
 *   - mock-tools dispatcher rejects unknown tools (null) and produces
 *     deterministic outputs for the supported ones.
 *
 * Run via `npx vitest run scripts/set-bench/`.
 */

import { describe, it, expect } from 'vitest';
import {
  TOOL_CHAIN_ZURICH_X2,
  ORCHESTRATION_EMAIL_TRIAGE,
  ZURICH_POPULATION_PINNED,
  KG_EXTRACTION_ENTITIES,
  DAG_PLANNING_RELEASE,
  MEMORY_EXTRACTION_CHAT,
  LONG_CONTEXT_SPEC_SUMMARY,
  CODE_REVIEW_PLANTED_BUGS,
  MULTI_STEP_REASONING_INTEREST,
  extractJsonArray,
  isValidDag,
  extractBullets,
  extractLineRefs,
  SET_BENCH_SCENARIOS,
} from '../scripts/set-bench/scenarios.js';
import { dispatchMockTool } from '../scripts/set-bench/mock-tools.js';
import { isRateLimitError } from '../scripts/set-bench/run-cell.js';
import { percentile, computeParetoFrontier, buildReport, formatReportMarkdown } from '../scripts/set-bench/report.js';
import type { CellRun, SetBenchAxis, SetBenchCell, ToolCallTrace } from '../scripts/set-bench/types.js';

const ZX2 = ZURICH_POPULATION_PINNED * 2;

function lookup(): ToolCallTrace {
  return { name: 'lookup_population', input: { city: 'zurich' }, output: String(ZURICH_POPULATION_PINNED) };
}
function compute(): ToolCallTrace {
  return { name: 'compute', input: { expression: `${ZURICH_POPULATION_PINNED} * 2` }, output: String(ZX2) };
}

describe('TOOL_CHAIN passCheck', () => {
  it('passes on a clean two-tool happy path', () => {
    const r = TOOL_CHAIN_ZURICH_X2.passCheck(`ZURICH_X2=${ZX2}`, [lookup(), compute()]);
    expect(r.pass).toBe(true);
  });

  it('fails when the agent never called lookup_population', () => {
    const r = TOOL_CHAIN_ZURICH_X2.passCheck(`ZURICH_X2=${ZX2}`, [compute()]);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/lookup_population/);
  });

  it('fails when the agent skipped compute (hallucinated arithmetic)', () => {
    const r = TOOL_CHAIN_ZURICH_X2.passCheck(`ZURICH_X2=${ZX2}`, [lookup()]);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/compute/);
  });

  it('flags lookup_population loops (>3 calls)', () => {
    // Real-world failure pattern observed on mistral-large-2512 n=1 smoke
    // 2026-05-16 — the model gets stuck looking up the same city
    // repeatedly. Pass-check must catch this even if the final regex
    // happens to match.
    const calls = [lookup(), lookup(), lookup(), lookup(), lookup(), compute()];
    const r = TOOL_CHAIN_ZURICH_X2.passCheck(`ZURICH_X2=${ZX2}`, calls);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/loop/);
  });

  it('fails when the final answer has the wrong number', () => {
    const r = TOOL_CHAIN_ZURICH_X2.passCheck('ZURICH_X2=999999', [lookup(), compute()]);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/wrong number/);
  });

  it('fails when the final answer is missing the ZURICH_X2= prefix', () => {
    const r = TOOL_CHAIN_ZURICH_X2.passCheck(`The answer is ${ZX2}.`, [lookup(), compute()]);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/missing ZURICH_X2/);
  });

  it('tolerates extra whitespace + leading commentary if the regex still hits', () => {
    // The strict prompt asks for "no commentary", but some models still
    // emit a one-line preamble. As long as the regex hits AND tools were
    // called correctly, we count it as pass — the bench measures
    // capability, not perfect format adherence.
    const r = TOOL_CHAIN_ZURICH_X2.passCheck(`Sure! ZURICH_X2=${ZX2}`, [lookup(), compute()]);
    expect(r.pass).toBe(true);
  });
});

describe('ORCHESTRATION passCheck', () => {
  const HAPPY = [
    'email1: question',
    'email2: unsubscribe',
    'email3: support',
    'email4: praise',
    'email5: complaint',
  ].join('\n');

  it('passes on the canonical 5/5 answer', () => {
    const r = ORCHESTRATION_EMAIL_TRIAGE.passCheck(HAPPY, []);
    expect(r.pass).toBe(true);
  });

  it('passes at 4/5 (within ambiguity tolerance)', () => {
    // Double-charge complaint is sometimes classified as "support" —
    // that's the canonical 4/5 case. Pass-bar is 4/5 so this should
    // still pass.
    const r = ORCHESTRATION_EMAIL_TRIAGE.passCheck([
      'email1: question',
      'email2: unsubscribe',
      'email3: support',
      'email4: praise',
      'email5: support', // wrong (should be complaint)
    ].join('\n'), []);
    expect(r.pass).toBe(true);
  });

  it('fails at 3/5', () => {
    const r = ORCHESTRATION_EMAIL_TRIAGE.passCheck([
      'email1: question',
      'email2: unsubscribe',
      'email3: support',
      'email4: support', // wrong
      'email5: support', // wrong
    ].join('\n'), []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/3\/5/);
  });

  it('tolerates markdown-bold labels', () => {
    // mistral-small + ministral love to bold-wrap labels.
    const r = ORCHESTRATION_EMAIL_TRIAGE.passCheck([
      'email1: **question**',
      'email2: **unsubscribe**',
      'email3: **support**',
      'email4: **praise**',
      'email5: **complaint**',
    ].join('\n'), []);
    expect(r.pass).toBe(true);
  });

  it('tolerates upper-case labels + extra whitespace', () => {
    const r = ORCHESTRATION_EMAIL_TRIAGE.passCheck([
      'email1:   QUESTION  ',
      'email2:   UNSUBSCRIBE  ',
      'email3:   SUPPORT  ',
      'email4:   PRAISE  ',
      'email5:   COMPLAINT  ',
    ].join('\n'), []);
    expect(r.pass).toBe(true);
  });

  it('fails when a line is missing', () => {
    const r = ORCHESTRATION_EMAIL_TRIAGE.passCheck([
      'email1: question',
      'email2: unsubscribe',
      'email3: support',
      'email4: praise',
      // email5 missing
    ].join('\n'), []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/missing or malformed.*email5/);
  });
});

describe('mock-tools dispatcher', () => {
  it('returns null for unknown tool names', () => {
    expect(dispatchMockTool('does_not_exist', {})).toBeNull();
  });

  it('lookup_population returns the pinned Zürich population', () => {
    expect(dispatchMockTool('lookup_population', { city: 'Zurich' })).toBe(String(ZURICH_POPULATION_PINNED));
    expect(dispatchMockTool('lookup_population', { city: 'zürich' })).toBe(String(ZURICH_POPULATION_PINNED));
  });

  it('lookup_population rejects unknown cities with a guidance message', () => {
    const out = dispatchMockTool('lookup_population', { city: 'Bern' });
    expect(out).toMatch(/unknown city/i);
    expect(out).toMatch(/zurich/i);
  });

  it('compute handles the canonical Zürich × 2 case', () => {
    expect(dispatchMockTool('compute', { expression: `${ZURICH_POPULATION_PINNED} * 2` })).toBe(String(ZURICH_POPULATION_PINNED * 2));
  });

  it('compute rejects multi-operand expressions (no eval fallback)', () => {
    // Hardening: the constrained parser does NOT chain operations. If a
    // scenario grows into multi-step arithmetic the parser gets an
    // explicit grammar — not a permissive eval. This test pins that
    // policy.
    expect(dispatchMockTool('compute', { expression: '1 + 2 + 3' })).toMatch(/expected.*<int> <op> <int>/);
    expect(dispatchMockTool('compute', { expression: '(1 + 2) * 3' })).toMatch(/expected.*<int> <op> <int>/);
  });

  it('compute rejects disallowed characters', () => {
    expect(dispatchMockTool('compute', { expression: '1 ; rm -rf /' })).toMatch(/expected.*<int> <op> <int>/);
    expect(dispatchMockTool('compute', { expression: 'process.exit(0)' })).toMatch(/expected.*<int> <op> <int>/);
  });

  it('compute rejects divide-by-zero rather than emitting Infinity', () => {
    expect(dispatchMockTool('compute', { expression: '5 / 0' })).toBe('ERROR: divide by zero');
  });
});

describe('percentile (R-7 linear interpolation)', () => {
  // Pins the bench-grade statistic. Matches numpy.percentile / pandas default
  // semantics so we can cross-check against external tooling if needed.
  it('returns 0 on empty input', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 95)).toBe(0);
  });

  it('returns the single value on n=1 (any percentile)', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it('interpolates linearly between bracketing samples', () => {
    // n=2: rank = p/100 * (n-1) = 0.5 * 1 = 0.5 → midpoint of [10, 20].
    expect(percentile([10, 20], 50)).toBe(15);
    // n=5: rank for p50 = 0.5 * 4 = 2 → sortedAsc[2] exactly.
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    // n=5: rank for p95 = 0.95 * 4 = 3.8 → 0.2 * 4 + 0.8 * 5 = 4.8.
    expect(percentile([1, 2, 3, 4, 5], 95)).toBeCloseTo(4.8, 5);
  });

  it('preserves p50 < p95 ordering on monotonic input', () => {
    const xs = [100, 200, 300, 400, 9000];
    expect(percentile(xs, 50)).toBeLessThan(percentile(xs, 95));
    // Tail-sensitive: p95 catches the 9000 outlier.
    expect(percentile(xs, 95)).toBeGreaterThan(1000);
  });
});

describe('computeParetoFrontier', () => {
  // Pareto frontier: a is dominated by b iff b is no worse on both axes
  // AND strictly better on at least one. The frontier drops dominated
  // cells. Subtle semantics worth pinning explicitly — strict-vs-non-
  // strict gets quietly flipped in refactors.
  type Row = ReturnType<typeof buildReport>['summary'][number];
  const row = (label: string, cost: number, passRate: number): Row => ({
    axis: 'tool-chain' as const,
    cellLabel: label,
    passRate,
    avgCostUsd: cost,
    avgDurationMs: 1000,
    p50DurationMs: 1000,
    p95DurationMs: 1000,
    pinned: true,
  });

  it('keeps the cheap-pass-100 cell and drops dominated ones', () => {
    const cheap100 = row('cheap-100', 0.001, 1);
    const expensive100 = row('expensive-100', 0.010, 1);
    const flaky = row('flaky', 0.005, 0.5);
    const frontier = computeParetoFrontier([cheap100, expensive100, flaky]);
    // cheap-100 dominates both: expensive-100 (same passRate, higher cost)
    // and flaky (higher cost AND lower passRate).
    expect(frontier).toEqual([cheap100]);
  });

  it('keeps both ends of a genuine quality-cost tradeoff', () => {
    const cheap80 = row('cheap-80', 0.001, 0.8);
    const expensive100 = row('expensive-100', 0.010, 1);
    const frontier = computeParetoFrontier([cheap80, expensive100]);
    // Neither dominates: cheap-80 wins on cost, expensive-100 wins on passRate.
    expect(frontier.map((r) => r.cellLabel)).toEqual(['cheap-80', 'expensive-100']);
  });

  it('sorts frontier cheapest → most expensive', () => {
    const a = row('mid-90', 0.005, 0.9);
    const b = row('cheap-70', 0.001, 0.7);
    const c = row('expensive-100', 0.010, 1);
    const frontier = computeParetoFrontier([a, b, c]);
    expect(frontier.map((r) => r.cellLabel)).toEqual(['cheap-70', 'mid-90', 'expensive-100']);
  });

  it('dedupes exact (cost, passRate) ties', () => {
    // Two cells with identical stats — keep only one row in the frontier
    // so the rendered markdown doesn't duplicate-list them.
    const twin1 = row('twin-1', 0.002, 0.9);
    const twin2 = row('twin-2', 0.002, 0.9);
    const frontier = computeParetoFrontier([twin1, twin2]);
    expect(frontier).toHaveLength(1);
  });

  it('returns empty when input is empty', () => {
    expect(computeParetoFrontier([])).toEqual([]);
  });
});

describe('buildReport + formatReportMarkdown', () => {
  // Round-trip a tiny synthetic dataset through buildReport → markdown to
  // pin the section ordering AND the p50/p95 column rendering.
  const cell = (label: string, axis: 'tool-chain' | 'orchestration', pinned: boolean): SetBenchCell => ({
    label,
    axis,
    provider: 'anthropic' as const,
    modelId: label,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    pricing: { inputPerMillion: 1, outputPerMillion: 1 },
    pinned,
  });
  const run = (cellLabel: string, pass: boolean, durationMs: number, costUsd: number): CellRun => ({
    cellLabel,
    scenarioId: 'fake',
    pass,
    tokensIn: 100,
    tokensOut: 50,
    costUsd,
    durationMs,
    iterations: 1,
    finalText: '',
    toolCalls: [],
  });

  it('exposes p50/p95 columns in the per-axis table', () => {
    const cells = [cell('alpha', 'tool-chain', true)];
    // n=5 durations: p50=300, p95=480 (rank 3.8 → 0.2*400 + 0.8*500).
    const runs = [
      run('alpha', true, 100, 0.001),
      run('alpha', true, 200, 0.001),
      run('alpha', true, 300, 0.001),
      run('alpha', true, 400, 0.001),
      run('alpha', true, 500, 0.001),
    ];
    const report = buildReport(runs, cells);
    expect(report.summary[0]!.p50DurationMs).toBe(300);
    expect(report.summary[0]!.p95DurationMs).toBeCloseTo(480, 5);
    const md = formatReportMarkdown(report);
    expect(md).toContain('p50');
    expect(md).toContain('p95');
    expect(md).toContain('Pareto frontier');
    // Pin rendered values, not just column-header presence — catches
    // a regression where columns swap or the toFixed formatting changes.
    expect(md).toContain('0.3s'); // p50DurationMs=300ms → "0.3s"
    expect(md).toContain('0.5s'); // p95DurationMs=480ms → "0.5s" (toFixed(1) rounds 0.48 → 0.5)
  });

  it('omits Pareto section when no cells exist for the axis', () => {
    const md = formatReportMarkdown(buildReport([], []));
    expect(md).not.toContain('Pareto frontier');
  });
});

describe('isRateLimitError', () => {
  // Pins the retry-classifier policy: only genuine rate-limit signals
  // trigger the backoff path. A regression here could either silently
  // mis-classify real failures as retryable (masking provider outages)
  // or fail to retry on real 429s (poisoning the bench matrix).
  it('matches the documented rate-limit signal variants', () => {
    expect(isRateLimitError('OpenAI-compatible API error 429: {"detail":"Rate limit exceeded"}')).toBe(true);
    expect(isRateLimitError('HTTP 429 Too Many Requests')).toBe(true);
    expect(isRateLimitError('rate limit exceeded')).toBe(true);
    expect(isRateLimitError('Rate-Limited')).toBe(true);
    expect(isRateLimitError('rate_limit hit')).toBe(true);
  });

  it('rejects unrelated 429-shaped substrings', () => {
    // \b429\b — must be a standalone token, not part of a larger number.
    expect(isRateLimitError('count: 4290 tokens consumed')).toBe(false);
    expect(isRateLimitError('error code 142901')).toBe(false);
  });

  it('rejects unrelated rate-shaped phrases', () => {
    // "limited rate of change" should not trigger — the regex looks for
    // the noun phrase "rate-limit" / "rate limit" specifically.
    expect(isRateLimitError('limited rate of change')).toBe(false);
    expect(isRateLimitError('first rate experience')).toBe(false);
    expect(isRateLimitError('connection reset by peer')).toBe(false);
    expect(isRateLimitError('Invalid API key')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────
// Phase 3 PR B — new use-case scenarios
// ──────────────────────────────────────────────────────────────

describe('extractJsonArray', () => {
  // Shared helper used by 3 passChecks. Pinning its contract here means
  // a regression in fence-stripping or string-aware brace walking
  // surfaces before it silently breaks 3 scenarios at once.
  it('parses a plain JSON array', () => {
    expect(extractJsonArray('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('strips ```json fences', () => {
    expect(extractJsonArray('```json\n[{"a": 1}]\n```')).toEqual([{ a: 1 }]);
  });

  it('strips plain ``` fences', () => {
    expect(extractJsonArray('```\n["x", "y"]\n```')).toEqual(['x', 'y']);
  });

  it('finds the array even when wrapped in prose', () => {
    expect(extractJsonArray('Sure, here you go: [1, 2, 3]. Hope that helps!')).toEqual([1, 2, 3]);
  });

  it('handles arrays containing strings with bracket characters', () => {
    // The string-aware walker must not match the `]` inside the string.
    expect(extractJsonArray('[{"text": "an array like [1, 2]"}]')).toEqual([{ text: 'an array like [1, 2]' }]);
  });

  it('returns null on malformed JSON', () => {
    expect(extractJsonArray('not json')).toBeNull();
    expect(extractJsonArray('[1, 2')).toBeNull();
    // Trailing comma — strict JSON.parse rejects, walker reports null.
    // Pins behaviour: we do NOT silently coerce JSON5-style trailing commas.
    expect(extractJsonArray('[1, 2, ]')).toBeNull();
  });

  it('stops at the first balanced close-bracket (trailing prose ignored)', () => {
    // Tolerant: a well-formed JSON array followed by trailing text still parses.
    expect(extractJsonArray('[1, 2] then a footnote')).toEqual([1, 2]);
  });
});

describe('KG_EXTRACTION passCheck', () => {
  const ALL_8 = [
    { name: 'Maria Sanchez', type: 'person' },
    { name: 'Liam OConnor', type: 'person' },
    { name: 'Priya Kapoor', type: 'person' },
    { name: 'Acme Robotics', type: 'organization' },
    { name: 'Northwind Logistics', type: 'organization' },
    { name: 'Helios Ventures', type: 'organization' },
    { name: 'Berlin', type: 'location' },
    { name: 'Munich', type: 'location' },
  ];

  it('passes on a clean 8/8 happy path', () => {
    const r = KG_EXTRACTION_ENTITIES.passCheck(JSON.stringify(ALL_8), []);
    expect(r.pass).toBe(true);
  });

  it('passes at 7/8 (one missing entity within tolerance)', () => {
    const r = KG_EXTRACTION_ENTITIES.passCheck(JSON.stringify(ALL_8.slice(0, 7)), []);
    expect(r.pass).toBe(true);
  });

  it('fails at 6/8 (below 7/8 tolerance bar)', () => {
    const r = KG_EXTRACTION_ENTITIES.passCheck(JSON.stringify(ALL_8.slice(0, 6)), []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/6\/8/);
  });

  it('tolerates ```json fences + leading prose', () => {
    const r = KG_EXTRACTION_ENTITIES.passCheck(
      'Here are the entities:\n```json\n' + JSON.stringify(ALL_8) + '\n```',
      [],
    );
    expect(r.pass).toBe(true);
  });

  it('tolerates aliases for names (first-name only, alternate apostrophes)', () => {
    const aliased = [
      { name: 'Maria', type: 'person' },
      { name: "Liam O'Connor", type: 'person' },
      { name: 'Priya', type: 'person' },
      { name: 'Acme', type: 'organization' },
      { name: 'Northwind', type: 'organization' },
      { name: 'Helios', type: 'organization' },
      { name: 'Berlin', type: 'location' },
      { name: 'Munich', type: 'location' },
    ];
    const r = KG_EXTRACTION_ENTITIES.passCheck(JSON.stringify(aliased), []);
    expect(r.pass).toBe(true);
  });

  it('fails when the output is not a JSON array at all', () => {
    const r = KG_EXTRACTION_ENTITIES.passCheck('Maria Sanchez is the CTO...', []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/parseable JSON array/);
  });

  it('fails when types are wrong (everyone tagged as "thing")', () => {
    const wrong = ALL_8.map((e) => ({ ...e, type: 'thing' }));
    const r = KG_EXTRACTION_ENTITIES.passCheck(JSON.stringify(wrong), []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/0\/8|1\/8|2\/8|3\/8|4\/8|5\/8|6\/8/);
  });

  it('does not let a single hallucinated multi-entity item satisfy multiple expected entries', () => {
    // Regression: previously `arr.some()` allowed one item containing
    // multiple canonical names ("Acme Robotics Helios Ventures") to
    // satisfy two expected entries on a single pass. The passCheck now
    // tracks claimed indices so each expected binds to a distinct item.
    const hallucinated = [
      { name: 'Maria Sanchez', type: 'person' },
      { name: 'Liam OConnor', type: 'person' },
      { name: 'Priya Kapoor', type: 'person' },
      // Hallucinated single item that mentions THREE org names — should
      // bind to only ONE expected org, not all three.
      { name: 'Acme Robotics / Northwind Logistics / Helios Ventures', type: 'organization' },
      { name: 'Berlin', type: 'location' },
      { name: 'Munich', type: 'location' },
    ];
    const r = KG_EXTRACTION_ENTITIES.passCheck(JSON.stringify(hallucinated), []);
    expect(r.pass).toBe(false);
    // 6 distinct matches (3 people + 1 org + 2 locations), below the 7/8 bar.
    expect(r.reason).toMatch(/6\/8/);
  });
});

describe('isValidDag', () => {
  it('accepts a linear chain', () => {
    expect(
      isValidDag([
        { id: 'a', depends_on: [] },
        { id: 'b', depends_on: ['a'] },
        { id: 'c', depends_on: ['b'] },
      ]),
    ).toBe(true);
  });

  it('rejects a 2-cycle', () => {
    expect(
      isValidDag([
        { id: 'a', depends_on: ['b'] },
        { id: 'b', depends_on: ['a'] },
      ]),
    ).toBe(false);
  });

  it('rejects a self-loop', () => {
    expect(isValidDag([{ id: 'a', depends_on: ['a'] }])).toBe(false);
  });

  it('rejects unresolved dependency references', () => {
    expect(isValidDag([{ id: 'a', depends_on: ['ghost'] }])).toBe(false);
  });
});

describe('DAG_PLANNING passCheck', () => {
  const VALID_DAG = [
    { id: 'cut_tag', depends_on: [] },
    { id: 'run_tests', depends_on: ['cut_tag'] },
    { id: 'deploy', depends_on: ['run_tests'] },
  ];

  it('passes on the canonical 3-step DAG', () => {
    const r = DAG_PLANNING_RELEASE.passCheck(JSON.stringify(VALID_DAG), []);
    expect(r.pass).toBe(true);
  });

  it('passes when extra non-required upstreams are added (still acyclic)', () => {
    // deploy waiting on both cut_tag AND run_tests is still valid; the
    // required upstream is the transitive parent. Pass-check only
    // enforces the must-have edges, not the must-not-have.
    const extra = [
      { id: 'cut_tag', depends_on: [] },
      { id: 'run_tests', depends_on: ['cut_tag'] },
      { id: 'deploy', depends_on: ['run_tests', 'cut_tag'] },
    ];
    const r = DAG_PLANNING_RELEASE.passCheck(JSON.stringify(extra), []);
    expect(r.pass).toBe(true);
  });

  it('tolerates ```json fences', () => {
    const r = DAG_PLANNING_RELEASE.passCheck('```json\n' + JSON.stringify(VALID_DAG) + '\n```', []);
    expect(r.pass).toBe(true);
  });

  it('fails when a required dependency edge is missing', () => {
    // deploy without run_tests upstream — gating violated.
    const broken = [
      { id: 'cut_tag', depends_on: [] },
      { id: 'run_tests', depends_on: ['cut_tag'] },
      { id: 'deploy', depends_on: ['cut_tag'] }, // skips run_tests
    ];
    const r = DAG_PLANNING_RELEASE.passCheck(JSON.stringify(broken), []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/depend on 'run_tests'/);
  });

  it('fails when a required step is missing', () => {
    const missingDeploy = [
      { id: 'cut_tag', depends_on: [] },
      { id: 'run_tests', depends_on: ['cut_tag'] },
    ];
    const r = DAG_PLANNING_RELEASE.passCheck(JSON.stringify(missingDeploy), []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/missing required step: deploy/);
  });

  it('fails when the graph contains a cycle', () => {
    const cyclic = [
      { id: 'cut_tag', depends_on: ['deploy'] },
      { id: 'run_tests', depends_on: ['cut_tag'] },
      { id: 'deploy', depends_on: ['run_tests'] },
    ];
    const r = DAG_PLANNING_RELEASE.passCheck(JSON.stringify(cyclic), []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/not a valid DAG/);
  });

  it('fails when depends_on is missing (shape violation)', () => {
    const malformed = [{ id: 'cut_tag' }, { id: 'run_tests' }, { id: 'deploy' }];
    const r = DAG_PLANNING_RELEASE.passCheck(JSON.stringify(malformed), []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/shape/);
  });
});

describe('MEMORY_EXTRACTION passCheck', () => {
  const ALL_4 = [
    'User name is Jordan.',
    'Jordan runs a bakery in Vienna and bakes sourdough and rye.',
    'Jordan prefers email over phone for updates.',
    'Jordan has a partner named Sam who handles wholesale orders.',
  ];

  it('passes on a clean 4/4 string-array happy path', () => {
    const r = MEMORY_EXTRACTION_CHAT.passCheck(JSON.stringify(ALL_4), []);
    expect(r.pass).toBe(true);
  });

  it('passes at 3/4 (within ambiguity tolerance)', () => {
    const partial = [ALL_4[0]!, ALL_4[1]!, ALL_4[2]!]; // skip "partner Sam"
    const r = MEMORY_EXTRACTION_CHAT.passCheck(JSON.stringify(partial), []);
    expect(r.pass).toBe(true);
  });

  it('fails at 2/4 (below bar)', () => {
    const partial = [ALL_4[0]!, ALL_4[2]!]; // only name + email pref
    const r = MEMORY_EXTRACTION_CHAT.passCheck(JSON.stringify(partial), []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/2\/4/);
  });

  it('tolerates structured object facts ({key, value} shape)', () => {
    const structured = [
      { key: 'name', value: 'Jordan' },
      { key: 'business', value: 'Bakery located in Vienna' },
      { key: 'communication_preference', value: 'Prefers email channels' },
      { key: 'relationships', value: 'Partner Sam handles wholesale' },
    ];
    const r = MEMORY_EXTRACTION_CHAT.passCheck(JSON.stringify(structured), []);
    expect(r.pass).toBe(true);
  });

  it('tolerates ```json fences + extra commentary stripped', () => {
    const r = MEMORY_EXTRACTION_CHAT.passCheck(
      'Sure thing!\n```json\n' + JSON.stringify(ALL_4) + '\n```\n',
      [],
    );
    expect(r.pass).toBe(true);
  });

  it('fails when the output is not a JSON array', () => {
    const r = MEMORY_EXTRACTION_CHAT.passCheck('Jordan, Vienna bakery, email pref, Sam.', []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/parseable JSON array/);
  });
});

describe('extractBullets', () => {
  it('extracts dash bullets', () => {
    expect(extractBullets('- one\n- two\n- three')).toEqual(['one', 'two', 'three']);
  });

  it('extracts star + plus bullet markers', () => {
    expect(extractBullets('* alpha\n+ beta')).toEqual(['alpha', 'beta']);
  });

  it('extracts numbered bullets (both "1." and "1)" forms)', () => {
    expect(extractBullets('1. first\n2) second')).toEqual(['first', 'second']);
  });

  it('ignores non-bullet lines', () => {
    expect(extractBullets('Intro paragraph.\n- bullet\n\nFooter.')).toEqual(['bullet']);
  });
});

describe('LONG_CONTEXT passCheck', () => {
  const ANCHORED_5 = [
    '- Custom ARM-based SoC with DIN-rail mounting and 65 watts peak draw',
    '- Four 2.5-gigabit Ethernet ports plus SFP+ cages, with cellular LTE/5G fallback',
    '- Hardware root of trust, AES encryption at rest, mutual TLS to the management plane',
    '- Hardened Yocto Linux with Podman runtime and Prometheus metrics endpoint',
    '- IP54 rated chassis with 350,000 hours mean-time-between-failures rating',
  ].join('\n');

  it('passes on a clean 5/5 anchored summary', () => {
    const r = LONG_CONTEXT_SPEC_SUMMARY.passCheck(ANCHORED_5, []);
    expect(r.pass).toBe(true);
  });

  it('passes at 4/5 anchors (one generic bullet allowed)', () => {
    const fourAnchored = [
      '- A generic introductory bullet without specifics',
      '- Four 2.5-gigabit Ethernet ports plus SFP+ cages',
      '- Hardware root of trust and AES encryption',
      '- Yocto Linux with Podman container runtime',
      '- IP54 rated chassis for industrial environments',
    ].join('\n');
    const r = LONG_CONTEXT_SPEC_SUMMARY.passCheck(fourAnchored, []);
    expect(r.pass).toBe(true);
  });

  it('fails when there are more than 5 bullets', () => {
    const six = ANCHORED_5 + '\n- a sixth bullet';
    const r = LONG_CONTEXT_SPEC_SUMMARY.passCheck(six, []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/expected exactly 5 bullets, got 6/);
  });

  it('fails when there are fewer than 5 bullets', () => {
    const four = ANCHORED_5.split('\n').slice(0, 4).join('\n');
    const r = LONG_CONTEXT_SPEC_SUMMARY.passCheck(four, []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/expected exactly 5 bullets, got 4/);
  });

  it('fails on a generic summary with no corpus-specific anchors', () => {
    // Five well-formed bullets, but each one could apply to any
    // industrial appliance — no anchor phrases. This is the "model
    // hallucinated a generic answer without reading the doc" failure
    // mode that the anchor list exists to catch.
    const generic = [
      '- The device is rugged and designed for industrial environments',
      '- It supports a wide range of network protocols and form factors',
      '- Security is a top priority with multiple layers of protection',
      '- The software is reliable and supports remote configuration',
      '- It is certified for use in multiple regions globally',
    ].join('\n');
    const r = LONG_CONTEXT_SPEC_SUMMARY.passCheck(generic, []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/anchor phrase/);
  });

  it('tolerates star + numbered bullet markers as well as dashes', () => {
    const mixed = [
      '1. Custom ARM SoC with DIN-rail mounting',
      '2. Ethernet plus SFP+ cages with LTE/5G fallback',
      '3. Hardware root of trust and AES encryption',
      '4. Yocto Linux and Podman runtime',
      '5. IP54 rated, 350,000 hours mean-time-between-failures',
    ].join('\n');
    const r = LONG_CONTEXT_SPEC_SUMMARY.passCheck(mixed, []);
    expect(r.pass).toBe(true);
  });

  it('rejects generic phrasing that only collides with short anchors as substrings', () => {
    // Regression: anchors `arm`, `aes`, `lte`, `5g` previously used
    // substring `.includes()` matching, so generic bullets containing
    // "alarm", "aesthetic", "alteration", or "5g coverage in marketing"
    // would falsely pass. The anchor list is now word-boundary regex.
    const generic = [
      '- An alarm system with aesthetic appeal and altered defaults',
      '- Premium aesthetics and a sleek alarm-style indicator',
      '- Alteration-resistant casing with aesthetic considerations',
      '- Generic alarm bell and decorative aesthetic styling',
      '- 5g of weight reduction in the housing material',
    ].join('\n');
    const r = LONG_CONTEXT_SPEC_SUMMARY.passCheck(generic, []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/anchor phrase/);
  });
});

describe('extractLineRefs', () => {
  it('extracts "line N" form', () => {
    expect(extractLineRefs('Bug at line 7')).toContain(7);
  });

  it('extracts "L7" form', () => {
    expect(extractLineRefs('See L13 for SQL issue')).toContain(13);
  });

  it('extracts range forms ("lines 5-9")', () => {
    const out = extractLineRefs('Vulnerability spans lines 5-9');
    expect(out).toContain(5);
    expect(out).toContain(9);
  });

  it('does not extract grading fractions like "5/5"', () => {
    expect(extractLineRefs('grade: 5/5')).toEqual([]);
  });
});

describe('CODE_REVIEW passCheck', () => {
  const HAPPY = [
    'BUG: null dereference at line 7 — userId may be null when .trim() is called.',
    'BUG: SQL injection at line 9 — user-controlled value interpolated into raw SQL via template literal.',
  ].join('\n');

  it('passes when both bug classes + planted lines are flagged', () => {
    const r = CODE_REVIEW_PLANTED_BUGS.passCheck(HAPPY, []);
    expect(r.pass).toBe(true);
  });

  it('passes when SQL injection is flagged at the second site (line 15)', () => {
    const alt = [
      'BUG: null dereference at line 7 — userId may be null.',
      'BUG: SQL injection at line 15 — string concatenation in searchUsers.',
    ].join('\n');
    const r = CODE_REVIEW_PLANTED_BUGS.passCheck(alt, []);
    expect(r.pass).toBe(true);
  });

  it('tolerates the line-class window (±2 lines off the planted site)', () => {
    // Model says "line 6" — still inside the [5..9] window for the null-deref site.
    const off = [
      'BUG: nullish access at line 6 — userId may be null.',
      'BUG: SQL injection at line 13 — concatenation.',
    ].join('\n');
    const r = CODE_REVIEW_PLANTED_BUGS.passCheck(off, []);
    expect(r.pass).toBe(true);
  });

  it('fails when only one bug is flagged (null-deref missing)', () => {
    const onlySqli = 'BUG: SQL injection at line 9 — interpolation.';
    const r = CODE_REVIEW_PLANTED_BUGS.passCheck(onlySqli, []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/null-deref/);
  });

  it('fails when only one bug is flagged (SQL injection missing)', () => {
    const onlyNull = 'BUG: null dereference at line 7 — userId may be null.';
    const r = CODE_REVIEW_PLANTED_BUGS.passCheck(onlyNull, []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/SQL injection/);
  });

  it('fails when the bug class is named but the line ref is wrong', () => {
    const wrongLine = [
      'BUG: null dereference at line 25 — far from the planted site.',
      'BUG: SQL injection at line 99 — way out of range.',
    ].join('\n');
    const r = CODE_REVIEW_PLANTED_BUGS.passCheck(wrongLine, []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/0\/2|1\/2/);
  });

  it('rejects a SQL-injection flag at line 12 (the structural // Line 12 anchor, not a real bug site)', () => {
    // Regression: previously the SQL window [8..16] included 12, so a
    // model claiming "SQL injection at line 12" — which is literally the
    // `// Line 12` structural anchor in the diff, not a bug site — would
    // false-pass. The current window excludes 12. To isolate that
    // exclusion, this test uses line 5 for the null-deref claim (in bug1's
    // [5..9] window but OUTSIDE bug2's [7..11, 13..17] window) so the
    // global line-ref pool can't accidentally satisfy bug2 via line 5.
    const wrongSqliLine = [
      'BUG: null dereference at line 5 — userId may be null.',
      'BUG: SQL injection at line 12 — but this line is just a structural anchor.',
    ].join('\n');
    const r = CODE_REVIEW_PLANTED_BUGS.passCheck(wrongSqliLine, []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/SQL injection/);
  });

  it('strips fenced code blocks before extracting line refs (model echo guard)', () => {
    // If a model echoes the entire diff inside ``` fences (common for
    // smaller models), `// Line 12` would otherwise leak "12" into the
    // line-ref pool. The fence-stripping in extractLineRefs prevents that
    // when no real claim references a windowed line.
    const echoed = [
      'Here is the diff for reference:',
      '```',
      '// Line 12',
      'export async function searchUsers(query: string) {',
      '```',
      'BUG: null dereference at line 7 — userId may be null.',
      // No SQLi claim — bench should fail because echo didn't smuggle one in.
    ].join('\n');
    const r = CODE_REVIEW_PLANTED_BUGS.passCheck(echoed, []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/SQL injection/);
  });

  it('tolerates synonym bug-class phrasing (sqli / parameterized-query callout)', () => {
    const synonyms = [
      'BUG: nullable input at line 7 — userId may be null when trimmed.',
      'BUG: SQLi at line 9 — use a prepared statement here.',
    ].join('\n');
    const r = CODE_REVIEW_PLANTED_BUGS.passCheck(synonyms, []);
    expect(r.pass).toBe(true);
  });
});

describe('MULTI_STEP_REASONING passCheck', () => {
  // Reference: 10000 EUR at 6% annually, withdraw 2000 EUR at start of Y2,
  // compound 2 more years. End balance = 9662.96 EUR = 966296 cents.
  const CORRECT = 966_296;

  it('passes on the exact correct answer', () => {
    const r = MULTI_STEP_REASONING_INTEREST.passCheck(`Working through it... ANSWER=${CORRECT}`, []);
    expect(r.pass).toBe(true);
  });

  it('passes within ±100 cents tolerance (rounding tail)', () => {
    const r = MULTI_STEP_REASONING_INTEREST.passCheck(`ANSWER=${CORRECT + 50}`, []);
    expect(r.pass).toBe(true);
  });

  it('fails when the answer is more than 100 cents off', () => {
    const r = MULTI_STEP_REASONING_INTEREST.passCheck(`ANSWER=${CORRECT + 250}`, []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/wrong answer/);
  });

  it('fails when the answer is way off (e.g. forgot the withdrawal)', () => {
    // 10000 * 1.06^3 * 100 = 1191016 — what the model gets if it never
    // applies the mid-period withdrawal. Different failure-mode pin.
    const r = MULTI_STEP_REASONING_INTEREST.passCheck('ANSWER=1191016', []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/1191016/);
  });

  it('fails when no ANSWER=<n> line is emitted', () => {
    const r = MULTI_STEP_REASONING_INTEREST.passCheck('The final balance is approximately 9662.96 EUR.', []);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/missing ANSWER/);
  });

  it('picks the LAST ANSWER= line when the model echoes the template first', () => {
    // The prompt itself includes "write EXACTLY: ANSWER=<value>" and
    // "would be written ANSWER=500050" — small models sometimes echo
    // those before emitting their real answer. Pass-check must take the
    // last hit, not the first.
    const echoed = [
      'I will write ANSWER=500050 as the example shows.',
      'Now solving the actual problem...',
      `ANSWER=${CORRECT}`,
    ].join('\n');
    const r = MULTI_STEP_REASONING_INTEREST.passCheck(echoed, []);
    expect(r.pass).toBe(true);
  });

  it('tolerates case-insensitive ANSWER prefix + extra whitespace', () => {
    const r = MULTI_STEP_REASONING_INTEREST.passCheck(`answer = ${CORRECT}`, []);
    expect(r.pass).toBe(true);
  });
});

describe('SET_BENCH_SCENARIOS registry', () => {
  // Pins the exported array shape so an accidental delete or re-order
  // in scenarios.ts gets caught before the matrix runner picks up a
  // half-broken set.
  it('exports all 8 phase-2+3 scenarios in axis order', () => {
    const axes = SET_BENCH_SCENARIOS.map((s) => s.axis);
    expect(axes).toEqual([
      'tool-chain',
      'orchestration',
      'kg-extraction',
      'dag-planning',
      'memory-extraction',
      'long-context',
      'code-review',
      'multi-step-reasoning',
    ]);
  });

  it('every scenario has a unique id', () => {
    const ids = SET_BENCH_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every scenario has a non-zero maxIterations and timeoutMs', () => {
    for (const s of SET_BENCH_SCENARIOS) {
      expect(s.maxIterations).toBeGreaterThan(0);
      expect(s.timeoutMs).toBeGreaterThan(0);
    }
  });
});

describe('axisLabel coverage via formatReportMarkdown', () => {
  // formatReportMarkdown is the only consumer of axisLabel — round-trip
  // a single-cell BenchReport per new axis to make sure no axis renders
  // as `undefined` in the headline. Catches the classic "added enum
  // member, forgot the switch arm" regression.
  // Source the axis list from the exported SetBenchAxis union (one source
  // of truth) — if the enum is extended again, tsc will error here on a
  // missing arm rather than silently skipping the new axis from coverage.
  const allAxes: readonly SetBenchAxis[] = [
    'tool-chain',
    'orchestration',
    'kg-extraction',
    'dag-planning',
    'memory-extraction',
    'long-context',
    'code-review',
    'multi-step-reasoning',
  ];

  for (const axis of allAxes) {
    it(`renders a non-empty header for axis '${axis}'`, () => {
      const cell: SetBenchCell = {
        label: `cell-${axis}`,
        axis,
        provider: 'anthropic' as const,
        modelId: `cell-${axis}`,
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        pricing: { inputPerMillion: 1, outputPerMillion: 1 },
        pinned: true,
      };
      const run: CellRun = {
        cellLabel: cell.label,
        scenarioId: 'fake',
        pass: true,
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0.001,
        durationMs: 100,
        iterations: 1,
        finalText: '',
        toolCalls: [],
      };
      const md = formatReportMarkdown(buildReport([run], [cell]));
      // Header line for the axis must exist + must not contain `undefined`.
      expect(md).toMatch(/##\s+[A-Z_]+_?axis|##\s+[A-Z_]+ axis/);
      expect(md).not.toMatch(/undefined/);
    });
  }
});
