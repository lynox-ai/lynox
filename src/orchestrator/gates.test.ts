import { describe, it, expect } from 'vitest';
import { LocalGateAdapter } from './gates.js';
import type { GateSubmitParams } from '../types/orchestration.js';

const TEST_PARAMS: GateSubmitParams = {
  manifestName: 'test-manifest',
  stepId: 'step-1',
  agentName: 'my-agent',
  context: { foo: 'bar' },
  runId: 'run-123',
};

describe('LocalGateAdapter', () => {
  it('submit returns a local ID with stepId', async () => {
    const adapter = new LocalGateAdapter(async () => 'Yes, approve');
    const approvalId = await adapter.submit(TEST_PARAMS);
    expect(approvalId).toContain('local-step-1-');
  });

  it('waitForDecision returns approved when prompt starts with Yes', async () => {
    const adapter = new LocalGateAdapter(async () => 'Yes, approve');
    const decision = await adapter.waitForDecision('local-step-1-123');
    expect(decision.status).toBe('approved');
  });

  it('waitForDecision returns rejected when prompt does not start with Yes', async () => {
    const adapter = new LocalGateAdapter(async () => 'No, reject');
    const decision = await adapter.waitForDecision('local-step-1-123');
    expect(decision.status).toBe('rejected');
    expect(decision.status === 'rejected' && (decision as { reason?: string }).reason).toBe('User rejected');
  });
});
