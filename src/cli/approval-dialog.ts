import type { PreApprovalPattern, TabQuestion } from '../types/index.js';

export interface PlanningResult {
  patterns: PreApprovalPattern[];
  reasoning: string;
  estimatedToolCalls: number;
}

export interface ApprovalDialogResult {
  approved: boolean;
  patterns: PreApprovalPattern[];
  maxUses: number;
  ttlMs: number;
}

const RISK_LEVELS = ['low', 'medium', 'high'] as const;

function filterByRisk(
  patterns: PreApprovalPattern[],
  maxRisk: 'low' | 'medium' | 'high',
): PreApprovalPattern[] {
  const allowed = new Set<string>();
  for (const r of RISK_LEVELS) {
    allowed.add(r);
    if (r === maxRisk) break;
  }
  return patterns.filter(p => allowed.has(p.risk));
}

function parseMaxUses(answer: string): number {
  if (answer.startsWith('Unlimited')) return 0;
  const num = parseInt(answer, 10);
  return isNaN(num) ? 10 : num;
}

export async function showApprovalDialog(
  proposed: PlanningResult,
  goal: string,
  promptTabs: (questions: TabQuestion[]) => Promise<string[]>,
): Promise<ApprovalDialogResult> {
  if (proposed.patterns.length === 0) {
    return { approved: false, patterns: [], maxUses: 10, ttlMs: 0 };
  }

  const patternSummary = proposed.patterns
    .map(p => `  [${p.risk}] ${p.tool}: ${p.pattern} — ${p.label}`)
    .join('\n');

  const questions: TabQuestion[] = [
    {
      header: 'Summary',
      question: `Goal: ${goal}\n\nReasoning: ${proposed.reasoning}\nEstimated tool calls: ${proposed.estimatedToolCalls}\n\nProposed patterns:\n${patternSummary}`,
      options: ['Review patterns', 'Skip pre-approval', '\x00'],
    },
    {
      header: 'Risk Filter',
      question: 'Which risk levels should be auto-approved?',
      options: ['Approve all', 'Low + medium risk only', 'Low risk only', 'None', '\x00'],
    },
    {
      header: 'Limits',
      question: 'Maximum uses per pattern before requiring manual approval:',
      options: ['5 uses', '10 uses (default)', '25 uses', 'Unlimited', '\x00'],
    },
  ];

  const answers = await promptTabs(questions);

  // Cancelled or empty
  if (answers.length === 0) {
    return { approved: false, patterns: [], maxUses: 10, ttlMs: 0 };
  }

  // Tab 1: Skip check
  const summaryAnswer = answers[0] ?? '';
  if (summaryAnswer === 'Skip pre-approval') {
    return { approved: false, patterns: [], maxUses: 10, ttlMs: 0 };
  }

  // Tab 2: Risk filter
  const riskAnswer = answers[1] ?? 'Low + medium risk only';
  let filteredPatterns: PreApprovalPattern[];
  if (riskAnswer === 'Approve all') {
    filteredPatterns = [...proposed.patterns];
  } else if (riskAnswer === 'Low + medium risk only') {
    filteredPatterns = filterByRisk(proposed.patterns, 'medium');
  } else if (riskAnswer === 'Low risk only') {
    filteredPatterns = filterByRisk(proposed.patterns, 'low');
  } else if (riskAnswer === 'None') {
    return { approved: false, patterns: [], maxUses: 10, ttlMs: 0 };
  } else {
    filteredPatterns = filterByRisk(proposed.patterns, 'medium');
  }

  if (filteredPatterns.length === 0) {
    return { approved: false, patterns: [], maxUses: 10, ttlMs: 0 };
  }

  // Tab 3: Limits
  const limitAnswer = answers[2] ?? '10 uses (default)';
  const maxUses = parseMaxUses(limitAnswer);

  return {
    approved: true,
    patterns: filteredPatterns,
    maxUses,
    ttlMs: 0,
  };
}

/**
 * Non-TTY fallback: auto-approve only low-risk patterns.
 */
export function autoApproveDefaults(proposed: PlanningResult): ApprovalDialogResult {
  if (proposed.patterns.length === 0) {
    return { approved: false, patterns: [], maxUses: 10, ttlMs: 0 };
  }

  const lowOnly = proposed.patterns.filter(p => p.risk === 'low');
  if (lowOnly.length === 0) {
    return { approved: false, patterns: [], maxUses: 10, ttlMs: 0 };
  }

  return {
    approved: true,
    patterns: lowOnly,
    maxUses: 10,
    ttlMs: 0,
  };
}
