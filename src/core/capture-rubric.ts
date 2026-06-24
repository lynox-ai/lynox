import type { PlannedPipeline, ProcessParameterSource } from '../types/index.js';

/**
 * Exploratory-capture quality rubric (PRD §8.4, Slice C3). `save_workflow` turns
 * a free-form exploration's tool-call trace into a reusable, parameterised
 * workflow (a Haiku extraction + the deterministic `processToSteps` glue). This
 * scorer grades the resulting `PlannedPipeline` against a known expectation, so
 * a regression in the glue (or, run online, a drop in Haiku's extraction) is
 * caught by a number instead of a vibe.
 *
 * Two consumers:
 *  - the OFFLINE gate (`process-capture.eval.test.ts`) — golden fixtures with a
 *    mocked Haiku annotation → deterministic, regression-proofs the glue;
 *  - the ONLINE smoke (`tests/online/process-capture.test.ts`) — real Haiku, run
 *    during the staging walk, eyeballs actual extraction quality.
 */
export interface CaptureExpectation {
  /** The re-target parameters the capture SHOULD identify. */
  params: Array<{ name: string; type: 'string' | 'number' | 'date'; source: ProcessParameterSource }>;
  /** How many steps the workflow should have (no dropped / merged calls). */
  stepCount: number;
  /** Expected data dependencies: step id (`step-<order>`) → the input_from ids it should read. */
  deps?: Record<string, string[]> | undefined;
}

export interface RubricScore {
  /** Of the expected params, the fraction the capture identified (by name). */
  paramRecall: number;
  /** Of the identified params, the fraction that are real (not a mis-flagged constant). */
  paramPrecision: number;
  /** Of the params present in both, the fraction with the correct type. */
  paramTyping: number;
  /** 1.0 when the step count matches; otherwise min/max (penalises drop AND merge). */
  stepCompleteness: number;
  /** Of the steps with an expected dependency set, the fraction whose input_from matches exactly. */
  depAccuracy: number;
  /** True iff every `{{params.x}}` placeholder in any step resolves to a declared param. */
  reExecutable: boolean;
  /** Weighted mean of the metrics, HARD-gated by reExecutable (a workflow that can't
   *  re-run is worthless regardless of its other scores). In [0, 1]. */
  overall: number;
  notes: string[];
}

// Any `{{ … }}` placeholder; we then classify the inner content. At run time a
// saved workflow resolves a placeholder ONLY when it is exactly `{{params.X}}`
// and X is a declared (scalar) param — `resolveInputTemplate` → `getByPath`
// returns the param value. EVERYTHING else is left verbatim and never resolves:
//  - a DOTTED form `{{params.X.sub}}` — X is a scalar, so `.sub` is undefined
//    (this is why the rubric must NOT anchor the regex on `}}` after the word,
//    the trap the first cut fell into);
//  - a bare `{{Y}}` / `{{Y.sub}}` — no `params` prefix, nothing to resolve
//    against (a de-namespacing glue bug or a model hallucination).
const PLACEHOLDER = /\{\{(.*?)\}\}/g;
const EXACT_PARAM = /^\s*params\.([a-zA-Z0-9_]+)\s*$/;

/** Classify every placeholder in a step (its prose task AND its literal
 *  input_template) into the declared-param base names it correctly references
 *  vs. the inner contents that can NEVER resolve at run time. */
function placeholdersInStep(step: { task?: string | undefined; input_template?: Record<string, unknown> | undefined }): { params: Set<string>; unresolvable: Set<string> } {
  const params = new Set<string>();
  const unresolvable = new Set<string>();
  const scan = (s: string): void => {
    for (const m of s.matchAll(PLACEHOLDER)) {
      const inner = m[1]!;
      const exact = EXACT_PARAM.exec(inner);
      if (exact) params.add(exact[1]!);
      else unresolvable.add(inner.trim());
    }
  };
  if (step.task) scan(step.task);
  if (step.input_template) scan(JSON.stringify(step.input_template));
  return { params, unresolvable };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

export function scoreCapture(captured: PlannedPipeline, expected: CaptureExpectation): RubricScore {
  const notes: string[] = [];
  const capturedParams = captured.parameters ?? [];
  const capturedNames = new Set(capturedParams.map(p => p.name));
  const expectedNames = new Set(expected.params.map(p => p.name));

  // --- Parameter identification ---
  const recalled = [...expectedNames].filter(n => capturedNames.has(n));
  const paramRecall = ratio(recalled.length, expectedNames.size);
  const realCaptured = [...capturedNames].filter(n => expectedNames.has(n));
  const paramPrecision = ratio(realCaptured.length, capturedNames.size);
  if (paramRecall < 1) notes.push(`missing param(s): ${[...expectedNames].filter(n => !capturedNames.has(n)).join(', ') || '—'}`);
  if (paramPrecision < 1) notes.push(`spurious param(s): ${[...capturedNames].filter(n => !expectedNames.has(n)).join(', ') || '—'}`);

  // --- Typing (only over params present in both, deduped by name) ---
  // Dedupe captured params by name FIRST so a duplicate emission can't push
  // `typed` past the Set-deduplicated denominator (paramTyping must stay ≤ 1).
  const capturedByName = new Map(capturedParams.map(p => [p.name, p]));
  if (capturedByName.size < capturedParams.length) {
    notes.push('duplicate param name(s) emitted');
  }
  const expectedType = new Map(expected.params.map(p => [p.name, p.type]));
  let typed = 0;
  for (const [name, p] of capturedByName) {
    if (expectedType.get(name) === p.type) typed++;
  }
  const paramTyping = ratio(typed, realCaptured.length);

  // --- Step completeness ---
  const n = captured.steps.length;
  const stepCompleteness = expected.stepCount === 0 ? (n === 0 ? 1 : 0) : Math.min(n, expected.stepCount) / Math.max(n, expected.stepCount);
  if (n !== expected.stepCount) notes.push(`step count ${n} ≠ expected ${expected.stepCount}`);

  // --- Dependency accuracy ---
  // Check EVERY captured step (expected = the listed deps, or none) so a
  // spurious input_from on a step the expectation didn't list is penalised too —
  // not just missing deps on listed steps.
  let depAccuracy = 1;
  if (expected.deps) {
    const wantFor = expected.deps;
    let correct = 0;
    for (const step of captured.steps) {
      const want = wantFor[step.id] ?? [];
      const got = new Set(step.input_from ?? []);
      const same = got.size === want.length && want.every(w => got.has(w));
      if (same) correct++; else notes.push(`dep mismatch on ${step.id}`);
    }
    depAccuracy = ratio(correct, captured.steps.length);
  }

  // --- Re-executability: every placeholder resolves at run time ---
  // Two ways a run breaks: an exact `{{params.x}}` whose x isn't declared
  // (unbound), OR ANY non-exact placeholder (`placeholdersInStep` collects these
  // as `unresolvable` — bare `{{x}}`, dotted `{{params.x.sub}}`, etc.). Both fail.
  const unbound = new Set<string>();
  const unresolvable = new Set<string>();
  for (const step of captured.steps) {
    const { params, unresolvable: bad } = placeholdersInStep(step);
    for (const ref of params) if (!capturedNames.has(ref)) unbound.add(ref);
    for (const ref of bad) unresolvable.add(ref);
  }
  const reExecutable = unbound.size === 0 && unresolvable.size === 0;
  if (unbound.size) notes.push(`unbound {{params.x}}: ${[...unbound].join(', ')}`);
  if (unresolvable.size) notes.push(`unresolvable placeholder(s): ${[...unresolvable].map(u => `{{${u}}}`).join(', ')}`);

  const base = (paramRecall + paramPrecision + paramTyping + stepCompleteness + depAccuracy) / 5;
  // A non-re-executable capture is fundamentally broken — cap it hard so it can
  // never clear a quality gate, no matter how good the other metrics look.
  const overall = reExecutable ? base : Math.min(base, 0.4);

  return { paramRecall, paramPrecision, paramTyping, stepCompleteness, depAccuracy, reExecutable, overall, notes };
}
