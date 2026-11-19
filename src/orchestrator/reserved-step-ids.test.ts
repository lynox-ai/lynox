import { describe, it, expect } from 'vitest';
import { runManifest } from './runner.js';
import { applyModifications } from './workflow-edit.js';
import { stepIdIssue, isReservedStepId } from './step-id.js';
import { runStepsIssue } from './template-refs.js';
import { buildStepContext, resolveTaskTemplate } from './context.js';
import { getByPath } from './conditions.js';
import type { Manifest, ManifestStep, AgentOutput } from '../types/orchestration.js';
import type { LynoxUserConfig } from '../types/index.js';
import type { InlinePipelineStep } from '../types/pipeline.js';

const CONFIG: LynoxUserConfig = { api_key: 'test-key' };
const ADHOC = { source: { kind: 'adhoc' as const } };

function manifest(agents: ManifestStep[], context: Record<string, unknown> = {}): Manifest {
  return { manifest_version: '1.0', name: 'reserved', triggered_by: 'test', context, agents, gate_points: [], on_failure: 'stop' } as Manifest;
}

const RESERVED = 'cannot be step ids, because a run already uses these names';

// A step under a name the run's context already uses takes that name's place in each step that reads
// it, so a reference meant for the workflow's parameters reads the step's output instead.
describe('reserved step ids', () => {
  it('names exactly params, __proto__ and constructor', () => {
    expect(['params', '__proto__', 'constructor'].map(isReservedStepId)).toEqual([true, true, true]);
    expect(['param', 'params_', 'proto', 'constructors', 'toString'].map(isReservedStepId)).toEqual([false, false, false, false, false]);
  });

  it('are refused by add_step and rename_step, which name the reason', () => {
    const steps: InlinePipelineStep[] = [{ id: 'a', task: 'A' }];
    for (const id of ['params', '__proto__', 'constructor']) {
      expect(applyModifications(steps, [{ action: 'add_step', step_id: id, value: 'B' }])).toBe(
        `Error: add_step: the new id: "params", "__proto__" and "constructor" ${RESERVED} ("params" holds the workflow's parameters). Choose another id in the allowed form, for example fetch_orders.`);
      expect(applyModifications(steps, [{ action: 'rename_step', step_id: 'a', value: id }])).toBe(
        `Error: rename_step: the new id: "params", "__proto__" and "constructor" ${RESERVED} ("params" holds the workflow's parameters). Choose another id in the allowed form, for example fetch_orders.`);
    }
  });

  it('are refused where a whole step list is checked (a save, an import, an inline run), by position', () => {
    expect(stepIdIssue([{ id: 'a' }, { id: 'params' }])).toBe(
      `step #2 (steps[1].id): "params", "__proto__" and "constructor" ${RESERVED} ("params" holds the workflow's parameters). Choose another id in the allowed form, for example fetch_orders. If other steps refer to this step, use the new id there too.`);
    expect(stepIdIssue([{ id: '__proto__' }])).toContain(`step #1 (steps[0].id): "params"`);
    expect(stepIdIssue([{ id: 'a' }, { id: 'b', input_from: ['a'] }])).toBeNull();
  });
});

describe('the runner checks the steps of every manifest it runs', () => {
  it('refuses a reserved step id before any step, and names rename_step as the way out', async () => {
    const m = manifest([
      { id: 'params', agent: 'a', runtime: 'mock' },
      { id: 'b', agent: 'b', runtime: 'mock', input_from: ['params'], task: 'B {{params.result}}' },
    ], { params: { month: 'May' } });
    await expect(runManifest(m, CONFIG, { ...ADHOC, mockResponses: new Map([['a', 'STEP-OUTPUT'], ['b', 'ran']]) }))
      .rejects.toThrow(`Invalid manifest: step #1 (agents[0].id): "params", "__proto__" and "constructor" ${RESERVED} ("params" holds the workflow's parameters). Choose another id in the allowed form, for example fetch_orders. In a saved workflow, rename the step with rename_step; the steps that read it follow.`);
  });

  it('refuses a step whose id is a key of the run\'s context, without quoting the id', async () => {
    const m = manifest([{ id: 'customer', agent: 'a', runtime: 'mock' }], { customer: 'Acme' });
    await expect(runManifest(m, CONFIG, { ...ADHOC, mockResponses: new Map([['a', 'x']]) }))
      .rejects.toThrow('Invalid manifest: step #1 (agents[0].id): the run\'s context already holds a value under this step\'s id, and the step\'s output would take its place. Give the step another id, or the value another name.');
  });

  it('refuses a direct caller\'s reference no run resolves', async () => {
    const m = manifest([
      { id: 'a', agent: 'a', runtime: 'mock' },
      { id: 'b', agent: 'b', runtime: 'mock', task: 'B {{a.result}}' },
    ]);
    await expect(runManifest(m, CONFIG, { ...ADHOC, mockResponses: new Map([['a', 'x'], ['b', 'y']]) }))
      .rejects.toThrow(/^Invalid manifest: step #2 \(agents\[1\]\.task\)/);
  });

  it('runs the same manifest once the reference is in input_from', async () => {
    const m = manifest([
      { id: 'a', agent: 'a', runtime: 'mock' },
      { id: 'b', agent: 'b', runtime: 'mock', input_from: ['a'], task: 'B {{a.result}}' },
    ], { customer: 'Acme' });
    const state = await runManifest(m, CONFIG, { ...ADHOC, mockResponses: new Map([['a', 'x'], ['b', 'y']]) });
    expect(state.status).toBe('completed');
  });

  // The steps of a `runtime: 'pipeline'` step run as their own manifest (`spawnPipeline`), which no
  // save and no `validateManifest` checks: the runner refuses them before the first inner step.
  it('refuses a nested pipeline\'s inner reference outside its input_from, and a reserved inner id', async () => {
    const unresolved: ManifestStep = { id: 'outer', agent: 'outer', runtime: 'pipeline', pipeline: [{ id: 'a', task: 'A' }, { id: 'b', task: 'B {{a.result}}' }] };
    const refused = await runManifest(manifest([unresolved]), CONFIG, ADHOC);
    expect(refused.status).toBe('failed');
    expect(refused.error).toMatch(/Invalid manifest: step #2 \(agents\[1\]\.task\)/);

    const reserved: ManifestStep = { id: 'outer', agent: 'outer', runtime: 'pipeline', pipeline: [{ id: 'constructor', task: 'A' }] };
    const state = await runManifest(manifest([reserved]), CONFIG, ADHOC);
    expect(state.status).toBe('failed');
    expect(state.error).toContain(`Invalid manifest: step #1 (agents[0].id): "params", "__proto__" and "constructor" ${RESERVED}`);
  });

  it('runStepsIssue reads the reserved ids before the context keys and the references', () => {
    expect(runStepsIssue([{ id: 'params' }], { params: {} })).toContain(RESERVED);
    expect(runStepsIssue([{ id: 'ok', task: 'fine' }], { params: {} })).toBeNull();
  });
});

describe('a run\'s context reads only its own keys', () => {
  const out = (result: string): AgentOutput => ({ stepId: 'x', result, costUsd: 0, durationMs: 0, tokensIn: 0, tokensOut: 0, skipped: false } as AgentOutput);

  it('a step named __proto__ holds its output as a key, not as the context\'s prototype', () => {
    const ctx = buildStepContext({ params: { month: 'May' } }, { id: 'b', agent: 'b', input_from: ['__proto__'] } as ManifestStep, new Map([['__proto__', out('STEP')]]));
    expect(Object.getPrototypeOf(ctx)).toBeNull();
    expect(Object.hasOwn(ctx, '__proto__')).toBe(true);
    expect(getByPath(ctx, '__proto__.result')).toBe('STEP');
    expect(getByPath(ctx, 'params.month')).toBe('May');
  });

  it('a path never reads through to a prototype', () => {
    expect(getByPath({ params: { month: 'May' } }, 'constructor.name')).toBeUndefined();
    expect(getByPath({ params: { month: 'May' } }, 'params.toString')).toBeUndefined();
    expect(resolveTaskTemplate('{{constructor.name}} {{params.constructor}}', { params: { month: 'May' } })).toBe('{{constructor.name}} {{params.constructor}}');
    expect(getByPath({ list: ['a', 'b'] }, 'list.1')).toBe('b');
    expect(getByPath({ list: ['a', 'b'] }, 'list.length')).toBe(2);
  });
});
