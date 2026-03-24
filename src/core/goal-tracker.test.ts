import { describe, it, expect } from 'vitest';
import { GoalTracker } from './goal-tracker.js';

describe('GoalTracker', () => {
  describe('state machine', () => {
    it('starts as active', () => {
      const gt = new GoalTracker('build a house');
      expect(gt.getState().status).toBe('active');
      expect(gt.isComplete()).toBe(false);
    });

    it('active → complete', () => {
      const gt = new GoalTracker('build a house');
      gt.markComplete();
      expect(gt.getState().status).toBe('complete');
      expect(gt.isComplete()).toBe(true);
      expect(gt.getState().completedAt).toBeDefined();
    });

    it('active → failed', () => {
      const gt = new GoalTracker('build a house');
      gt.markFailed('ran out of bricks');
      expect(gt.getState().status).toBe('failed');
      expect(gt.isComplete()).toBe(true);
      expect(gt.getState().completedAt).toBeDefined();
    });

    it('failed state adds failure subtask', () => {
      const gt = new GoalTracker('deploy app');
      gt.markFailed('timeout');
      const state = gt.getState();
      expect(state.subtasks).toHaveLength(1);
      expect(state.subtasks[0]!.description).toBe('FAILED: timeout');
      expect(state.subtasks[0]!.status).toBe('failed');
    });
  });

  describe('parseResponse', () => {
    it('parses [GOAL_COMPLETE]', () => {
      const gt = new GoalTracker('test');
      gt.parseResponse('Some text [GOAL_COMPLETE] done');
      expect(gt.getState().status).toBe('complete');
    });

    it('parses [GOAL_FAILED]', () => {
      const gt = new GoalTracker('test');
      gt.parseResponse('The task [GOAL_FAILED] here');
      expect(gt.getState().status).toBe('failed');
    });

    it('parses [GOAL_FAILED: reason]', () => {
      const gt = new GoalTracker('test');
      gt.parseResponse('Output [GOAL_FAILED: disk full] end');
      const state = gt.getState();
      expect(state.status).toBe('failed');
      expect(state.subtasks.some(s => s.description.includes('disk full'))).toBe(true);
    });

    it('BUG 5 fix: [GOAL_FAILED_BADLY] does NOT trigger markFailed', () => {
      const gt = new GoalTracker('test');
      gt.parseResponse('Some text about [GOAL_FAILED_BADLY] stuff');
      expect(gt.getState().status).toBe('active');
      expect(gt.isComplete()).toBe(false);
    });

    it('no markers leaves state unchanged', () => {
      const gt = new GoalTracker('test');
      gt.parseResponse('just some regular text');
      expect(gt.getState().status).toBe('active');
    });
  });

  describe('subtasks', () => {
    it('addSubtask adds pending subtask', () => {
      const gt = new GoalTracker('goal');
      gt.addSubtask('step 1');
      gt.addSubtask('step 2');
      const state = gt.getState();
      expect(state.subtasks).toHaveLength(2);
      expect(state.subtasks[0]!.status).toBe('pending');
      expect(state.subtasks[1]!.status).toBe('pending');
    });

    it('completeSubtask finds first non-complete match', () => {
      const gt = new GoalTracker('goal');
      gt.addSubtask('step A');
      gt.addSubtask('step A'); // duplicate
      gt.completeSubtask('step A');
      const state = gt.getState();
      expect(state.subtasks[0]!.status).toBe('complete');
      expect(state.subtasks[1]!.status).toBe('pending');
    });

    it('completeSubtask is no-op for unknown description', () => {
      const gt = new GoalTracker('goal');
      gt.addSubtask('known');
      gt.completeSubtask('unknown');
      expect(gt.getState().subtasks[0]!.status).toBe('pending');
    });

    it('duplicate subtask descriptions are handled independently', () => {
      const gt = new GoalTracker('goal');
      gt.addSubtask('deploy');
      gt.addSubtask('deploy');
      gt.completeSubtask('deploy');
      gt.completeSubtask('deploy');
      const state = gt.getState();
      expect(state.subtasks[0]!.status).toBe('complete');
      expect(state.subtasks[1]!.status).toBe('complete');
    });
  });

  describe('continuationPrompt', () => {
    it('includes goal text', () => {
      const gt = new GoalTracker('refactor the codebase');
      const prompt = gt.continuationPrompt();
      expect(prompt).toContain('refactor the codebase');
    });

    it('includes progress fraction when subtasks exist', () => {
      const gt = new GoalTracker('goal');
      gt.addSubtask('a');
      gt.addSubtask('b');
      gt.addSubtask('c');
      gt.completeSubtask('a');
      const prompt = gt.continuationPrompt();
      expect(prompt).toContain('1/3');
    });

    it('lists pending subtasks', () => {
      const gt = new GoalTracker('goal');
      gt.addSubtask('first');
      gt.addSubtask('second');
      gt.completeSubtask('first');
      const prompt = gt.continuationPrompt();
      expect(prompt).toContain('- second');
      expect(prompt).not.toContain('- first');
    });

    it('handles no subtasks', () => {
      const gt = new GoalTracker('goal');
      const prompt = gt.continuationPrompt();
      expect(prompt).toContain('No subtasks registered yet');
    });
  });

  describe('summary', () => {
    it('returns completed subtasks only', () => {
      const gt = new GoalTracker('goal');
      gt.addSubtask('done step');
      gt.addSubtask('pending step');
      gt.completeSubtask('done step');
      const s = gt.summary();
      expect(s).toContain('Done: done step');
      expect(s).not.toContain('pending step');
    });

    it('returns fallback when no subtasks completed', () => {
      const gt = new GoalTracker('goal');
      gt.addSubtask('still pending');
      expect(gt.summary()).toBe('No subtasks completed yet.');
    });
  });

  describe('getState', () => {
    it('returns a copy that is mutation-safe', () => {
      const gt = new GoalTracker('goal');
      gt.addSubtask('sub');
      const state1 = gt.getState();
      state1.subtasks.push({ description: 'injected', status: 'complete' });
      const state2 = gt.getState();
      expect(state2.subtasks).toHaveLength(1);
    });

    it('contains all expected fields', () => {
      const gt = new GoalTracker('my goal');
      gt.recordIteration();
      gt.recordCost(1.5);
      const state = gt.getState();
      expect(state.goal).toBe('my goal');
      expect(state.subtasks).toEqual([]);
      expect(state.status).toBe('active');
      expect(state.iterationsUsed).toBe(1);
      expect(state.costUSD).toBe(1.5);
      expect(state.startedAt).toBeTruthy();
      expect(state.completedAt).toBeUndefined();
    });
  });

  describe('recordIteration and recordCost', () => {
    it('accumulates iterations', () => {
      const gt = new GoalTracker('goal');
      gt.recordIteration();
      gt.recordIteration();
      gt.recordIteration();
      expect(gt.getState().iterationsUsed).toBe(3);
    });

    it('accumulates cost', () => {
      const gt = new GoalTracker('goal');
      gt.recordCost(0.5);
      gt.recordCost(1.25);
      expect(gt.getState().costUSD).toBeCloseTo(1.75, 2);
    });
  });

  describe('edge cases', () => {
    it('empty goal string', () => {
      const gt = new GoalTracker('');
      expect(gt.getState().goal).toBe('');
      expect(gt.continuationPrompt()).toContain('Your goal:');
    });
  });
});
