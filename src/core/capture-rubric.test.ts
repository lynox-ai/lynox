import { describe, it, expect } from 'vitest';
import { scoreCapture, type CaptureExpectation } from './capture-rubric.js';
import type { PlannedPipeline, InlinePipelineStep, ProcessParameter } from '../types/index.js';

function plan(steps: InlinePipelineStep[], parameters: ProcessParameter[]): PlannedPipeline {
  return {
    id: 'wf', name: 'n', goal: '', steps, reasoning: '', estimatedCost: 0,
    createdAt: '2026-06-24T00:00:00.000Z', executed: false, executionMode: 'orchestrated',
    template: true, mode: 'autonomous', parameters,
  };
}

const PARAMS: ProcessParameter[] = [
  { name: 'api_url', description: '', type: 'string', source: 'user_input' },
  { name: 'time_range', description: '', type: 'date', source: 'relative_date' },
];
const STEPS: InlinePipelineStep[] = [
  { id: 'step-0', tool: 'http_request', task: 'fetch', input_template: { url: '{{params.api_url}}', range: '{{params.time_range}}' } },
  { id: 'step-1', tool: 'write_file', task: 'write', input_template: { path: 'r.md' }, input_from: ['step-0'] },
];
const EXPECTED: CaptureExpectation = {
  params: [
    { name: 'api_url', type: 'string', source: 'user_input' },
    { name: 'time_range', type: 'date', source: 'relative_date' },
  ],
  stepCount: 2,
  deps: { 'step-1': ['step-0'] },
};

describe('scoreCapture (exploratory-capture rubric)', () => {
  it('scores a perfect capture 1.0 on every metric', () => {
    const s = scoreCapture(plan(STEPS, PARAMS), EXPECTED);
    expect(s.paramRecall).toBe(1);
    expect(s.paramPrecision).toBe(1);
    expect(s.paramTyping).toBe(1);
    expect(s.stepCompleteness).toBe(1);
    expect(s.depAccuracy).toBe(1);
    expect(s.reExecutable).toBe(true);
    expect(s.overall).toBe(1);
  });

  it('drops recall when a param is missed', () => {
    const s = scoreCapture(plan(STEPS, [PARAMS[0]!]), EXPECTED);
    expect(s.paramRecall).toBe(0.5);
    // time_range is still referenced in step-0 but no longer declared → unbound.
    expect(s.reExecutable).toBe(false);
    expect(s.overall).toBeLessThanOrEqual(0.4);
  });

  it('drops precision when a constant is mis-flagged as a param', () => {
    const spurious: ProcessParameter[] = [...PARAMS, { name: 'bogus', description: '', type: 'string', source: 'user_input' }];
    const s = scoreCapture(plan(STEPS, spurious), EXPECTED);
    expect(s.paramPrecision).toBeCloseTo(2 / 3, 5);
    expect(s.reExecutable).toBe(true); // bogus is declared, just unused — still runnable
  });

  it('drops typing when a param type is wrong', () => {
    const mistyped: ProcessParameter[] = [PARAMS[0]!, { name: 'time_range', description: '', type: 'string', source: 'relative_date' }];
    const s = scoreCapture(plan(STEPS, mistyped), EXPECTED);
    expect(s.paramTyping).toBe(0.5);
  });

  it('flags a HARD non-re-executable when a placeholder is unbound', () => {
    const orphanStep: InlinePipelineStep[] = [
      { id: 'step-0', tool: 'http_request', task: 'fetch', input_template: { url: '{{params.ghost}}' } },
    ];
    const s = scoreCapture(plan(orphanStep, []), { params: [], stepCount: 1 });
    expect(s.reExecutable).toBe(false);
    expect(s.notes.join(' ')).toContain('ghost');
    expect(s.overall).toBeLessThanOrEqual(0.4);
  });

  it('catches a de-namespacing glue regression (bare {{param}} that should be {{params.param}})', () => {
    // The param IS declared, but a step left it BARE — at run time only
    // {{params.x}} resolves, so this workflow is broken even though recall is 1.
    const bareStep: InlinePipelineStep[] = [
      { id: 'step-0', tool: 'http_request', task: 'fetch', input_template: { url: '{{api_url}}' } },
    ];
    const s = scoreCapture(plan(bareStep, [PARAMS[0]!]), { params: [{ name: 'api_url', type: 'string', source: 'user_input' }], stepCount: 1 });
    expect(s.paramRecall).toBe(1);          // the param was identified...
    expect(s.reExecutable).toBe(false);     // ...but the placeholder wasn't namespaced
    expect(s.notes.join(' ')).toContain('unresolvable');
    expect(s.overall).toBeLessThanOrEqual(0.4);
  });

  it('catches a DOTTED namespaced placeholder {{params.x.sub}} (never resolves for a scalar param)', () => {
    // The first cut anchored the regex on `}}` after the word and missed this —
    // at run time getByPath(params, "api_url.value") is undefined for a scalar.
    const dotted: InlinePipelineStep[] = [
      { id: 'step-0', tool: 'http_request', task: 'fetch', input_template: { url: '{{params.api_url.value}}' } },
    ];
    const s = scoreCapture(plan(dotted, [PARAMS[0]!]), { params: [{ name: 'api_url', type: 'string', source: 'user_input' }], stepCount: 1 });
    expect(s.reExecutable).toBe(false);
    expect(s.notes.join(' ')).toContain('unresolvable');
    expect(s.overall).toBeLessThanOrEqual(0.4);
  });

  it('flags an UNDECLARED bare placeholder as non-re-executable (not just param-name ones)', () => {
    // {{output}} is NOT a declared param — at run time it resolves to nothing, so
    // the workflow is broken even though no param is "unbound" and it isn't a
    // de-namespaced param either. The rubric must still catch it.
    const orphan: InlinePipelineStep[] = [
      { id: 'step-0', tool: 'http_request', task: 'fetch', input_template: { url: '{{output}}' } },
    ];
    const s = scoreCapture(plan(orphan, []), { params: [], stepCount: 1 });
    expect(s.reExecutable).toBe(false);
    expect(s.notes.join(' ')).toContain('unresolvable');
    expect(s.overall).toBeLessThanOrEqual(0.4);
  });

  it('never lets paramTyping exceed 1.0 on duplicate param names', () => {
    const dup: ProcessParameter[] = [
      { name: 'api_url', description: '', type: 'string', source: 'user_input' },
      { name: 'api_url', description: '', type: 'string', source: 'user_input' },
      { name: 'time_range', description: '', type: 'date', source: 'relative_date' },
    ];
    const s = scoreCapture(plan(STEPS, dup), EXPECTED);
    expect(s.paramTyping).toBeLessThanOrEqual(1);
    expect(s.paramPrecision).toBeLessThanOrEqual(1);
    expect(s.notes.join(' ')).toContain('duplicate param');
  });

  it('penalises a dropped step (completeness) and a wrong dependency', () => {
    const dropped = scoreCapture(plan([STEPS[0]!], PARAMS), EXPECTED);
    expect(dropped.stepCompleteness).toBe(0.5);

    // step-0 is correctly dep-free, step-1 lost its expected ['step-0'] → 1 of 2
    // steps has the right dep set (the metric scores ALL steps, so a spurious dep
    // on an un-listed step is penalised too).
    const wrongDep: InlinePipelineStep[] = [STEPS[0]!, { ...STEPS[1]!, input_from: undefined }];
    const s = scoreCapture(plan(wrongDep, PARAMS), EXPECTED);
    expect(s.depAccuracy).toBe(0.5);
  });

  it('penalises a SPURIOUS dependency on a step the expectation lists no dep for', () => {
    const spuriousDep: InlinePipelineStep[] = [{ ...STEPS[0]!, input_from: ['step-1'] }, STEPS[1]!];
    const s = scoreCapture(plan(spuriousDep, PARAMS), EXPECTED);
    expect(s.depAccuracy).toBe(0.5); // step-0 now has a wrong (spurious) dep
  });
});
