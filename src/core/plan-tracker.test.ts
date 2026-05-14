import { describe, it, expect } from 'vitest';
import {
  startTrackedPlan,
  markStepStarted,
  recordStepComplete,
  checkAndFinalize,
} from './plan-tracker.js';
import { createToolContext } from './tool-context.js';
import type { PlannedPipeline } from '../types/index.js';

function makePlan(stepIds: readonly string[]): PlannedPipeline {
  return {
    id: 'plan-1',
    name: 'test',
    goal: 'test goal',
    steps: stepIds.map(id => ({ id, task: `task ${id}` })),
    reasoning: '',
    estimatedCost: 0,
    createdAt: new Date().toISOString(),
    executed: false,
    executionMode: 'tracked',
    template: false,
    mode: 'autonomous',
  } as PlannedPipeline;
}

describe('plan-tracker checkAndFinalize', () => {
  it('does not finalize when markStepStarted has pre-seeded a later step', () => {
    const ctx = createToolContext({});
    startTrackedPlan(makePlan(['s1', 's2']), ctx);

    // Step 1 completes, which in real flow triggers markStepStarted('s2') first.
    markStepStarted('s1', ctx);
    recordStepComplete('s1', 'done', 'completed', ctx);
    markStepStarted('s2', ctx);

    const finalized = checkAndFinalize(ctx, null);
    expect(finalized).toBe(false);
    expect(ctx.activePlan).not.toBeNull();
  });

  it('finalizes only after every step has recorded a completion', () => {
    const ctx = createToolContext({});
    startTrackedPlan(makePlan(['s1', 's2']), ctx);

    markStepStarted('s1', ctx);
    recordStepComplete('s1', 'done', 'completed', ctx);
    markStepStarted('s2', ctx);
    expect(checkAndFinalize(ctx, null)).toBe(false);

    recordStepComplete('s2', 'done', 'completed', ctx);
    expect(checkAndFinalize(ctx, null)).toBe(true);
    expect(ctx.activePlan).toBeNull();
  });

  it('treats failed and skipped statuses as terminal for finalization', () => {
    const ctx = createToolContext({});
    startTrackedPlan(makePlan(['s1', 's2']), ctx);

    recordStepComplete('s1', 'oops', 'failed', ctx);
    recordStepComplete('s2', 'skip', 'skipped', ctx);
    expect(checkAndFinalize(ctx, null)).toBe(true);
  });
});
