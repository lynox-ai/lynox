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
import { TOOL_CHAIN_ZURICH_X2, ORCHESTRATION_EMAIL_TRIAGE, ZURICH_POPULATION_PINNED } from '../scripts/set-bench/scenarios.js';
import { dispatchMockTool } from '../scripts/set-bench/mock-tools.js';
import { isRateLimitError } from '../scripts/set-bench/run-cell.js';
import type { ToolCallTrace } from '../scripts/set-bench/types.js';

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
