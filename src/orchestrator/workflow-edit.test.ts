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
