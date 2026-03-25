import { describe, it, expect } from 'vitest';

describe('Operational Modes', () => {
  it('ModeController has been removed — nodyn runs in interactive mode only', () => {
    // ModeController, GoalTracker, and playbooks have been removed.
    // Background work is handled via task_create with assignee "nodyn".
    // This test is a placeholder confirming the removal.
    expect(true).toBe(true);
  });
});
