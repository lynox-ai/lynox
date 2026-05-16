/**
 * Set-Bench scenarios — narrow set, deterministic mock-tools, regex-pinned
 * pass-checks. Each scenario maps to one of the two axes (tool-chain /
 * orchestration) so the report can group results without re-tagging.
 *
 * Mock-tool design rationale: the bench has to be reproducible across
 * runs and CI. Real `web_search` + real sub-agents would introduce
 * network-dependent flake AND charge real money on every CI tick. Each
 * scenario ships a real-tool variant (for the headline report) plus a
 * mocked-tool variant (for nightly regression). The mock-vs-real toggle
 * lives in the runner, not the scenario file.
 */

import type { SetBenchScenario, PassResult, ToolCallTrace } from './types.js';

// ── TOOL_CHAIN: lookup + compute, deterministic answer ─────────
// Mirrors the live mistral-demo smoke (Zurich population doubled). The
// mock `lookup_population` returns a frozen value, so we get a single
// correct final answer regardless of when the bench runs.

const ZURICH_POPULATION = 436_551;
const ZURICH_X2 = ZURICH_POPULATION * 2;

export const TOOL_CHAIN_ZURICH_X2: SetBenchScenario = {
  id: 'tool-chain.zurich-x2',
  axis: 'tool-chain',
  description: 'Two-tool agent loop: lookup_population("Zurich") then compute the result times 2. Regex-checked final answer.',
  prompt: [
    'Use the lookup_population tool to find the population of Zurich.',
    'Then use the compute tool to multiply that number by 2.',
    'Reply with exactly: ZURICH_X2=<number>',
    'Do not add anything else. Do not call lookup_population more than once.',
  ].join('\n'),
  passCheck: (finalText: string, toolCalls: readonly ToolCallTrace[]): PassResult => {
    // Both tools must be called. A model that hallucinates the
    // multiplication without calling compute passes the textual regex but
    // silently fails the routing claim, so it should fail here too.
    const lookups = toolCalls.filter((t) => t.name === 'lookup_population');
    const computes = toolCalls.filter((t) => t.name === 'compute');
    if (lookups.length === 0) return { pass: false, reason: 'never called lookup_population' };
    if (computes.length === 0) return { pass: false, reason: 'never called compute' };
    if (lookups.length > 3) return { pass: false, reason: `called lookup_population ${lookups.length}x (loop)` };
    const match = finalText.match(/ZURICH_X2=(\d+)/);
    if (!match) return { pass: false, reason: 'final answer missing ZURICH_X2=<n>' };
    const got = parseInt(match[1]!, 10);
    if (got !== ZURICH_X2) return { pass: false, reason: `wrong number: got ${got}, want ${ZURICH_X2}` };
    return { pass: true };
  },
  maxIterations: 10,
  timeoutMs: 120_000,
};

// ── ORCHESTRATION: email classification batch ──────
// Tests the haiku-replacement claim. The classifier runs on the same model
// (sub-agent inherits the parent's model in lynox unless overridden), so
// we are measuring orchestration plus classification jointly.

const EMAILS = [
  'Hi! When is the next product update? - Anna',
  'I want to unsubscribe from all your emails. Please.',
  'Can you confirm my payment was received? Order #4521.',
  'I love your product! 5 stars on Trustpilot - Marc',
  'You charged me twice this month. Refund please. URGENT.',
];

const EXPECTED_LABELS = ['question', 'unsubscribe', 'support', 'praise', 'complaint'];

export const ORCHESTRATION_EMAIL_TRIAGE: SetBenchScenario = {
  id: 'orchestration.email-triage',
  axis: 'orchestration',
  description: 'Classify 5 short emails into {question, unsubscribe, support, praise, complaint}. Tests batch orchestration on small models.',
  prompt: [
    'Below are 5 short customer emails. For each one, output exactly one label from',
    'this set: {question, unsubscribe, support, praise, complaint}.',
    '',
    'Reply with exactly 5 lines, formatted as:',
    '  email1: <label>',
    '  email2: <label>',
    '  email3: <label>',
    '  email4: <label>',
    '  email5: <label>',
    '',
    'Do not add commentary, do not call any tools, do not invent extra emails.',
    '',
    ...EMAILS.map((e, i) => `email${i + 1}: ${e}`),
  ].join('\n'),
  passCheck: (finalText: string, _toolCalls: readonly ToolCallTrace[]): PassResult => {
    // Parse one label per line. Tolerant of leading/trailing whitespace and
    // markdown bold formatting (small models love **unsubscribe**).
    const labels: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const line = new RegExp(`email${i}:\\s*\\**\\s*([a-z]+)\\s*\\**`, 'i').exec(finalText);
      if (!line) return { pass: false, reason: `missing or malformed line for email${i}` };
      labels.push(line[1]!.toLowerCase());
    }
    let correct = 0;
    for (let i = 0; i < 5; i++) {
      if (labels[i] === EXPECTED_LABELS[i]) correct++;
    }
    // Pass-bar: 4/5 correct. Email classification has ambiguity (e.g.
    // "complaint" vs "support" for the double-charge case), and strict
    // 5/5 would fail Anthropic Haiku ~20% of the time too, masking the
    // replacement-candidate signal we care about.
    if (correct < 4) return { pass: false, reason: `${correct}/5 correct: ${labels.join(', ')}` };
    return { pass: true };
  },
  maxIterations: 3,
  timeoutMs: 60_000,
};

export const SET_BENCH_SCENARIOS: readonly SetBenchScenario[] = [
  TOOL_CHAIN_ZURICH_X2,
  ORCHESTRATION_EMAIL_TRIAGE,
];

/** Frozen list of expected labels — exposed for the mocked-tool variant. */
export const EXPECTED_EMAIL_LABELS = EXPECTED_LABELS;
/** Frozen Zurich population — exposed for the mocked-tool variant. */
export const ZURICH_POPULATION_PINNED = ZURICH_POPULATION;
