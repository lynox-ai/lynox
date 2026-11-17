import { describe, it, expect } from 'vitest';
import { applyModifications, type StepModification } from './workflow-edit.js';
import type { InlinePipelineStep } from '../types/pipeline.js';

function steps(): InlinePipelineStep[] {
  return [
    { id: 'a', task: 'A' },
    { id: 'b', task: 'B', input_from: ['a'] },
    { id: 'c', task: 'C', input_from: ['a', 'b'] },
  ];
}

describe('applyModifications (shared workflow-step mutation)', () => {
  it('applies an ordered batch — add then remove the same id is valid', () => {
    const s = steps();
    const mods: StepModification[] = [
      { action: 'add_step', step_id: 'tmp', value: 'temp' },
      { action: 'remove', step_id: 'tmp' },
    ];
    expect(applyModifications(s, mods)).toBeNull();
    expect(s.map(x => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('removing a step strips it from EVERY dependent input_from', () => {
    const s = steps();
    expect(applyModifications(s, [{ action: 'remove', step_id: 'a' }])).toBeNull();
    expect(s.map(x => x.id)).toEqual(['b', 'c']);
    expect(s.find(x => x.id === 'b')!.input_from).toBeUndefined(); // ['a'] → []  → undefined
    expect(s.find(x => x.id === 'c')!.input_from).toEqual(['b']);  // ['a','b'] → ['b']
  });

  it('reports the first failing modification and stops', () => {
    const s = steps();
    const err = applyModifications(s, [
      { action: 'update_task', step_id: 'b', value: 'B2' },
      { action: 'remove', step_id: 'ghost' }, // fails here
      { action: 'remove', step_id: 'c' },     // never reached
    ]);
    expect(err).toContain('"ghost" not found');
    expect(s.find(x => x.id === 'b')!.task).toBe('B2'); // earlier mod already applied (caller discards the copy)
    expect(s.find(x => x.id === 'c')).toBeDefined();    // later mod NOT applied
  });

  it('update_task requires a value', () => {
    expect(applyModifications(steps(), [{ action: 'update_task', step_id: 'a' }])).toContain('"value" is required');
  });
});

describe('a run name of a step stored outside the shape, in a call\'s changes', () => {
  const OLD = 'Fetch the data';

  it('names the stored step it stands for', () => {
    const steps = [{ id: OLD, task: 'First' }, { id: 'write', task: 'Write' }];
    expect(applyModifications(steps, [{ action: 'update_task', step_id: 'step-1', value: 'Changed' }])).toBeNull();
    expect(steps.map(s => s.task)).toEqual(['Changed', 'Write']);
  });

  it('is refused when two steps are stored with the same id and so share it, and changes neither', () => {
    const steps = [{ id: OLD, task: 'First' }, { id: 'write', task: 'Write' }, { id: OLD, task: 'Second' }];
    const out = applyModifications(steps, [{ action: 'update_task', step_id: 'step-1', value: 'Changed' }]);
    expect(out).toBe('Error: Steps #1 and #3 were stored with the same id, which runs as "step-1", so this update cannot tell which one is meant. Name the step by its position instead, e.g. step_id "#3". To end the clash, give one of them its own id (rename_step with step_id "#3").');
    expect(steps.map(s => s.task)).toEqual(['First', 'Write', 'Second']);
  });

  it('lists three steps that share a run name, and the rename it suggests ends the clash', () => {
    const steps = [{ id: OLD, task: 'A' }, { id: OLD, task: 'B' }, { id: 'write', task: 'W' }, { id: OLD, task: 'C' }];
    const out = applyModifications(steps, [{ action: 'remove', step_id: 'step-1' }]);
    expect(out).toBe('Error: Steps #1, #2 and #4 were stored with the same id, which runs as "step-1", so this removal cannot tell which one is meant. Name the step by its position instead, e.g. step_id "#4". To end the clash, give one of them its own id (rename_step with step_id "#4").');
    expect(applyModifications(steps, [{ action: 'rename_step', step_id: '#4', value: 'fetch-last' }])).toBeNull();
    expect(steps.map(s => s.id)).toEqual([OLD, OLD, 'write', 'fetch-last']);
  });
});
