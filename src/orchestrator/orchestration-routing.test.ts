import { describe, it, expect } from 'vitest';
import type { InlinePipelineStep } from '../types/index.js';
import {
  shouldRunOrchestrated,
  CHEAP_MODEL_TIERS,
  MIN_INDEPENDENT_STEPS_FOR_ORCHESTRATION,
} from './orchestration-routing.js';

function step(id: string, extra?: Partial<InlinePipelineStep>): InlinePipelineStep {
  return { id, task: `task for ${id}`, ...extra };
}

describe('shouldRunOrchestrated — O7 classifier', () => {
  // --- Independent-step count rule ---

  it('returns true for ≥3 independent steps', () => {
    const steps = [step('a'), step('b'), step('c')];
    expect(shouldRunOrchestrated(steps)).toBe(true);
  });

  it('returns true for more than 3 independent steps', () => {
    const steps = [step('a'), step('b'), step('c'), step('d'), step('e')];
    expect(shouldRunOrchestrated(steps)).toBe(true);
  });

  it('returns false for exactly 2 independent steps', () => {
    const steps = [step('a'), step('b')];
    expect(shouldRunOrchestrated(steps)).toBe(false);
  });

  it('returns false for a single step', () => {
    expect(shouldRunOrchestrated([step('a')])).toBe(false);
  });

  it('returns false for an empty plan', () => {
    expect(shouldRunOrchestrated([])).toBe(false);
  });

  it('returns false for a 3-step fully-sequential chain', () => {
    // a → b → c : only one independent step (a)
    const steps = [
      step('a'),
      step('b', { input_from: ['a'] }),
      step('c', { input_from: ['b'] }),
    ];
    expect(shouldRunOrchestrated(steps)).toBe(false);
  });

  it('counts only dependency-free steps as independent', () => {
    // a, b independent; c, d, e all depend → 2 independent < 3 → tracked
    const steps = [
      step('a'),
      step('b'),
      step('c', { input_from: ['a'] }),
      step('d', { input_from: ['b'] }),
      step('e', { input_from: ['c', 'd'] }),
    ];
    expect(shouldRunOrchestrated(steps)).toBe(false);
  });

  it('treats an empty input_from array as independent', () => {
    const steps = [
      step('a', { input_from: [] }),
      step('b', { input_from: [] }),
      step('c', { input_from: [] }),
    ];
    expect(shouldRunOrchestrated(steps)).toBe(true);
  });

  it('returns true with 3 independent steps even when later steps depend', () => {
    // a, b, c independent (3 ≥ 3) ; d depends → still orchestrated
    const steps = [
      step('a'),
      step('b'),
      step('c'),
      step('d', { input_from: ['a', 'b', 'c'] }),
    ];
    expect(shouldRunOrchestrated(steps)).toBe(true);
  });

  // --- Cheap-tier rule ---

  it('returns true when any step carries a cheap (haiku) tier', () => {
    // Only 2 sequential steps — fails the count rule — but one is haiku.
    const steps = [
      step('a'),
      step('b', { input_from: ['a'], model: 'haiku' }),
    ];
    expect(shouldRunOrchestrated(steps)).toBe(true);
  });

  it('returns true for a single cheap-tier step', () => {
    expect(shouldRunOrchestrated([step('a', { model: 'haiku' })])).toBe(true);
  });

  it('returns false for a sequential 2-step plan on sonnet/opus', () => {
    const steps = [
      step('a', { model: 'sonnet' }),
      step('b', { input_from: ['a'], model: 'opus' }),
    ];
    expect(shouldRunOrchestrated(steps)).toBe(false);
  });

  it('returns false when steps carry only non-cheap tiers and are sequential', () => {
    const steps = [
      step('a', { model: 'opus' }),
      step('b', { input_from: ['a'], model: 'sonnet' }),
    ];
    expect(shouldRunOrchestrated(steps)).toBe(false);
  });

  // --- Invariants ---

  it('exposes haiku as a cheap tier and a sane independent-step threshold', () => {
    expect(CHEAP_MODEL_TIERS.has('haiku')).toBe(true);
    expect(CHEAP_MODEL_TIERS.has('sonnet')).toBe(false);
    expect(CHEAP_MODEL_TIERS.has('opus')).toBe(false);
    expect(MIN_INDEPENDENT_STEPS_FOR_ORCHESTRATION).toBe(3);
  });
});
