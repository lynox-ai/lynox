import type { GateAdapter, GateSubmitParams, GateDecision } from './types.js';

type PromptFn = (q: string, opts?: string[]) => Promise<string>;

export class LocalGateAdapter implements GateAdapter {
  constructor(private readonly promptFn: PromptFn) {}

  async submit(params: GateSubmitParams): Promise<string> {
    return `local-${params.stepId}-${Date.now()}`;
  }

  async waitForDecision(approvalId: string): Promise<GateDecision> {
    const stepId = approvalId.split('-')[1] ?? approvalId;
    const answer = await this.promptFn(`Gate: approve step "${stepId}"?`, ['Yes, approve', 'No, reject']);
    const normalized = answer.trim().toLowerCase();
    return normalized.startsWith('y') ? { status: 'approved' } : { status: 'rejected', reason: 'User rejected' };
  }
}
