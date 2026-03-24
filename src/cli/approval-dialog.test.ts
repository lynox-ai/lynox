import { describe, it, expect } from 'vitest';
import { showApprovalDialog, autoApproveDefaults } from './approval-dialog.js';
import type { PlanningResult } from './approval-dialog.js';
import type { PreApprovalPattern } from '../types/index.js';

function makeProposed(patterns: PreApprovalPattern[]): PlanningResult {
  return {
    patterns,
    reasoning: 'Test reasoning',
    estimatedToolCalls: 10,
  };
}

const LOW: PreApprovalPattern = { tool: 'bash', pattern: 'npm run *', label: 'npm run', risk: 'low' };
const MEDIUM: PreApprovalPattern = { tool: 'write_file', pattern: 'dist/**', label: 'dist writes', risk: 'medium' };
const HIGH: PreApprovalPattern = { tool: 'bash', pattern: 'docker push *', label: 'docker push', risk: 'high' };

describe('showApprovalDialog', () => {
  it('"Skip pre-approval" returns approved=false', async () => {
    const promptTabs = async () => ['Skip pre-approval', 'Approve all', '10 uses (default)'];
    const result = await showApprovalDialog(makeProposed([LOW, MEDIUM, HIGH]), 'test goal', promptTabs);
    expect(result.approved).toBe(false);
    expect(result.patterns).toHaveLength(0);
  });

  it('"Approve all" returns all patterns', async () => {
    const promptTabs = async () => ['Review patterns', 'Approve all', '10 uses (default)'];
    const result = await showApprovalDialog(makeProposed([LOW, MEDIUM, HIGH]), 'test goal', promptTabs);
    expect(result.approved).toBe(true);
    expect(result.patterns).toHaveLength(3);
  });

  it('"Low + medium risk only" filters high risk', async () => {
    const promptTabs = async () => ['Review patterns', 'Low + medium risk only', '10 uses (default)'];
    const result = await showApprovalDialog(makeProposed([LOW, MEDIUM, HIGH]), 'test goal', promptTabs);
    expect(result.approved).toBe(true);
    expect(result.patterns).toHaveLength(2);
    expect(result.patterns.every(p => p.risk !== 'high')).toBe(true);
  });

  it('"Low risk only" filters medium+high', async () => {
    const promptTabs = async () => ['Review patterns', 'Low risk only', '10 uses (default)'];
    const result = await showApprovalDialog(makeProposed([LOW, MEDIUM, HIGH]), 'test goal', promptTabs);
    expect(result.approved).toBe(true);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]!.risk).toBe('low');
  });

  it('limit "5 uses" sets maxUses=5', async () => {
    const promptTabs = async () => ['Review patterns', 'Approve all', '5 uses'];
    const result = await showApprovalDialog(makeProposed([LOW]), 'test goal', promptTabs);
    expect(result.maxUses).toBe(5);
  });

  it('limit "Unlimited" sets maxUses=0', async () => {
    const promptTabs = async () => ['Review patterns', 'Approve all', 'Unlimited'];
    const result = await showApprovalDialog(makeProposed([LOW]), 'test goal', promptTabs);
    expect(result.maxUses).toBe(0);
  });

  it('"None" risk filter returns approved=false', async () => {
    const promptTabs = async () => ['Review patterns', 'None', '10 uses (default)'];
    const result = await showApprovalDialog(makeProposed([LOW, MEDIUM]), 'test goal', promptTabs);
    expect(result.approved).toBe(false);
  });

  it('empty proposed returns approved=false', async () => {
    const promptTabs = async () => ['Review patterns', 'Approve all', '10 uses (default)'];
    const result = await showApprovalDialog(makeProposed([]), 'test goal', promptTabs);
    expect(result.approved).toBe(false);
  });

  it('cancelled dialog (empty answers) returns approved=false', async () => {
    const promptTabs = async () => [] as string[];
    const result = await showApprovalDialog(makeProposed([LOW]), 'test goal', promptTabs);
    expect(result.approved).toBe(false);
  });
});

describe('autoApproveDefaults', () => {
  it('auto-approves only low-risk patterns', () => {
    const result = autoApproveDefaults(makeProposed([LOW, MEDIUM, HIGH]));
    expect(result.approved).toBe(true);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]!.risk).toBe('low');
  });

  it('returns approved=false when no low-risk patterns', () => {
    const result = autoApproveDefaults(makeProposed([MEDIUM, HIGH]));
    expect(result.approved).toBe(false);
  });

  it('returns approved=false for empty proposed', () => {
    const result = autoApproveDefaults(makeProposed([]));
    expect(result.approved).toBe(false);
  });

  it('sets default maxUses=10', () => {
    const result = autoApproveDefaults(makeProposed([LOW]));
    expect(result.maxUses).toBe(10);
  });
});
