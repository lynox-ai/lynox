import { describe, it, expect, vi } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import { runManifest, retryManifest } from './runner.js';
import type { Manifest, RunHooks, RunState, AgentOutput, GateAdapter, GateDecision, GateSubmitParams } from './types.js';
import type { LynoxUserConfig } from '../types/index.js';

const CONFIG: LynoxUserConfig = { api_key: 'test-key' };

const MANIFEST: Manifest = {
  manifest_version: '1.0',
  name: 'test-flow',
  triggered_by: 'test',
  context: { env: 'test' },
  agents: [
    { id: 'step-1', agent: 'agent-a', runtime: 'mock' },
    { id: 'step-2', agent: 'agent-b', runtime: 'mock', input_from: ['step-1'] },
  ],
  gate_points: [],
  on_failure: 'stop',
};

describe('runManifest — happy path', () => {
  it('completes all steps and returns completed status', async () => {
    const mockResponses = new Map([
      ['agent-a', 'result-a'],
      ['agent-b', 'result-b'],
    ]);
    const state = await runManifest(MANIFEST, CONFIG, { mockResponses });
    expect(state.status).toBe('completed');
    expect(state.outputs.size).toBe(2);
    expect(state.outputs.get('step-1')?.result).toBe('result-a');
    expect(state.outputs.get('step-2')?.result).toBe('result-b');
  });

  it('step-2 receives step-1 output in context via input_from', async () => {
    const mockResponses = new Map([['agent-a', 'result-a'], ['agent-b', 'result-b']]);
    const state = await runManifest(MANIFEST, CONFIG, { mockResponses });
    // Both steps ran (not skipped)
    expect(state.outputs.get('step-1')?.skipped).toBe(false);
    expect(state.outputs.get('step-2')?.skipped).toBe(false);
  });

  it('sets runId and startedAt on state', async () => {
    const state = await runManifest(MANIFEST, CONFIG, { mockResponses: new Map() });
    expect(state.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.startedAt).toBeTruthy();
    expect(state.completedAt).toBeTruthy();
  });
});

describe('runManifest — condition skipping', () => {
  it('skips step when condition fails', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      context: { score: 30 },
      agents: [
        {
          id: 'step-1',
          agent: 'agent-a',
          runtime: 'mock',
          conditions: [{ path: 'score', operator: 'gt', value: 50 }],
        },
      ],
    };
    const state = await runManifest(manifest, CONFIG, { mockResponses: new Map() });
    expect(state.status).toBe('completed');
    expect(state.outputs.get('step-1')?.skipped).toBe(true);
    expect(state.outputs.get('step-1')?.skipReason).toBe('conditions not met');
  });

  it('runs step when condition passes', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      context: { score: 80 },
      agents: [
        {
          id: 'step-1',
          agent: 'agent-a',
          runtime: 'mock',
          conditions: [{ path: 'score', operator: 'gt', value: 50 }],
        },
      ],
    };
    const mockResponses = new Map([['agent-a', 'ran']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses });
    expect(state.outputs.get('step-1')?.skipped).toBe(false);
    expect(state.outputs.get('step-1')?.result).toBe('ran');
  });
});

describe('runManifest — on_failure', () => {
  it('stops on error when on_failure=stop', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      on_failure: 'stop',
      agents: [
        { id: 'step-1', agent: 'agent-a', runtime: 'mock' },
        { id: 'step-2', agent: 'agent-b', runtime: 'mock' },
      ],
    };
    // Provide no responses → spawnMock returns "mock:agent-a" etc. Actually mock always succeeds.
    // Instead let's use mockResponses=undefined but throw via a gate (no — simpler):
    // We need to force an error. Use a manifest with no mockResponses and runtime=mock,
    // but with a step that references a non-existent input_from (forward reference error).
    const manifestWithError: Manifest = {
      ...MANIFEST,
      on_failure: 'stop',
      agents: [
        { id: 'step-1', agent: 'agent-a', runtime: 'mock', input_from: ['does-not-exist'] },
        { id: 'step-2', agent: 'agent-b', runtime: 'mock' },
      ],
    };
    const state = await runManifest(manifestWithError, CONFIG, { mockResponses: new Map() });
    expect(state.status).toBe('failed');
    expect(state.error).toContain('has not run yet');
    // step-2 should not have run
    expect(state.outputs.has('step-2')).toBe(false);
  });

  it('continues on error when on_failure=continue', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      on_failure: 'continue',
      agents: [
        { id: 'step-1', agent: 'agent-a', runtime: 'mock', input_from: ['does-not-exist'] },
        { id: 'step-2', agent: 'agent-b', runtime: 'mock' },
      ],
    };
    const state = await runManifest(manifest, CONFIG, { mockResponses: new Map() });
    // step-1 errored but we continued
    expect(state.outputs.get('step-1')?.error).toBeDefined();
    // step-2 ran (it has no input_from dependency)
    expect(state.outputs.get('step-2')?.result).toBe('mock:agent-b');
    expect(state.status).toBe('completed');
  });
});

describe('runManifest — gate points', () => {
  it('calls onGateSubmit and onGateDecision hooks when gate approves', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      gate_points: ['step-1'],
      agents: [{ id: 'step-1', agent: 'agent-a', runtime: 'mock' }],
    };

    const gateAdapter: GateAdapter = {
      submit: async () => 'approval-id-123',
      waitForDecision: async (): Promise<GateDecision> => ({ status: 'approved' }),
    };

    const onGateSubmit = vi.fn();
    const onGateDecision = vi.fn();
    const hooks: RunHooks = { onGateSubmit, onGateDecision };

    const state = await runManifest(manifest, CONFIG, {
      mockResponses: new Map([['agent-a', 'ok']]),
      gateAdapter,
      hooks,
    });

    expect(state.status).toBe('completed');
    expect(onGateSubmit).toHaveBeenCalledWith('step-1', 'approval-id-123');
    expect(onGateDecision).toHaveBeenCalledWith('step-1', { status: 'approved' });
  });

  it('returns rejected status when gate rejects', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      gate_points: ['step-1'],
      agents: [{ id: 'step-1', agent: 'agent-a', runtime: 'mock' }],
    };

    const gateAdapter: GateAdapter = {
      submit: async () => 'approval-id',
      waitForDecision: async (): Promise<GateDecision> => ({ status: 'rejected', reason: 'Not allowed' }),
    };

    const state = await runManifest(manifest, CONFIG, {
      mockResponses: new Map([['agent-a', 'ok']]),
      gateAdapter,
    });

    expect(state.status).toBe('rejected');
    expect(state.error).toContain('rejected');
  });

  it('returns rejected status when gate times out', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      gate_points: ['step-1'],
      agents: [{ id: 'step-1', agent: 'agent-a', runtime: 'mock' }],
    };

    const gateAdapter: GateAdapter = {
      submit: async () => 'approval-id',
      waitForDecision: async (): Promise<GateDecision> => ({ status: 'timeout' }),
    };

    const state = await runManifest(manifest, CONFIG, {
      mockResponses: new Map([['agent-a', 'ok']]),
      gateAdapter,
    });

    expect(state.status).toBe('rejected');
    expect(state.error).toContain('timed out');
  });
});

describe('runManifest — per-step pre-approval', () => {
  it('step with pre_approve runs normally with mock', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      agents: [
        {
          id: 'step-1',
          agent: 'agent-a',
          runtime: 'mock',
          pre_approve: [
            { tool: 'bash', pattern: 'npm run *', risk: 'low' },
          ],
        },
      ],
    };
    const mockResponses = new Map([['agent-a', 'ok']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses });
    expect(state.status).toBe('completed');
    expect(state.outputs.get('step-1')?.result).toBe('ok');
  });

  it('step without pre_approve runs normally', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      agents: [
        { id: 'step-1', agent: 'agent-a', runtime: 'mock' },
      ],
    };
    const mockResponses = new Map([['agent-a', 'ok']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses });
    expect(state.status).toBe('completed');
  });

  it('pre_approve field accepted in manifest validation', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      agents: [
        {
          id: 'step-1',
          agent: 'agent-a',
          runtime: 'mock',
          pre_approve: [
            { tool: 'bash', pattern: 'npm *' },
            { tool: 'write_file', pattern: 'dist/**', risk: 'medium' },
          ],
        },
      ],
    };
    const mockResponses = new Map([['agent-a', 'ok']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses });
    expect(state.status).toBe('completed');
  });
});

describe('runManifest — hooks', () => {
  it('fires all hooks in correct order', async () => {
    const order: string[] = [];
    const hooks: RunHooks = {
      onStepStart: (id) => { order.push(`start:${id}`); },
      onStepComplete: (out) => { order.push(`complete:${out.stepId}`); },
      onRunComplete: () => { order.push('run-complete'); },
    };
    const mockResponses = new Map([['agent-a', 'r1'], ['agent-b', 'r2']]);
    await runManifest(MANIFEST, CONFIG, { mockResponses, hooks });
    expect(order).toEqual(['start:step-1', 'complete:step-1', 'start:step-2', 'complete:step-2', 'run-complete']);
  });

  it('fires onStepSkipped hook', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      agents: [
        {
          id: 'step-1',
          agent: 'agent-a',
          runtime: 'mock',
          conditions: [{ path: 'never', operator: 'exists' }],
        },
      ],
    };
    const skipped = vi.fn();
    await runManifest(manifest, CONFIG, { mockResponses: new Map(), hooks: { onStepSkipped: skipped } });
    expect(skipped).toHaveBeenCalledWith('step-1', 'conditions not met');
  });

  it('fires onError hook on step failure', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      on_failure: 'continue',
      agents: [
        { id: 'step-1', agent: 'agent-a', runtime: 'mock', input_from: ['nonexistent'] },
      ],
    };
    const onError = vi.fn();
    await runManifest(manifest, CONFIG, { mockResponses: new Map(), hooks: { onError } });
    expect(onError).toHaveBeenCalledWith('step-1', expect.any(Error));
  });
});

// --- v1.1 parallel execution tests ---

describe('runManifest — v1.1 parallel execution', () => {
  it('two independent steps run in parallel (both start before either completes)', async () => {
    const manifest: Manifest = {
      manifest_version: '1.1',
      name: 'parallel-test',
      triggered_by: 'test',
      context: {},
      agents: [
        { id: 'a', agent: 'agent-a', runtime: 'mock' },
        { id: 'b', agent: 'agent-b', runtime: 'mock' },
      ],
      gate_points: [],
      on_failure: 'stop',
    };
    const order: string[] = [];
    const hooks: RunHooks = {
      onStepStart: (id) => { order.push(`start:${id}`); },
      onStepComplete: (out) => { order.push(`complete:${out.stepId}`); },
    };
    const mockResponses = new Map([['agent-a', 'ra'], ['agent-b', 'rb']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses, hooks });
    expect(state.status).toBe('completed');
    expect(state.outputs.size).toBe(2);
    // In parallel mode both starts should happen before any complete
    expect(order.indexOf('start:a')).toBeLessThan(order.indexOf('complete:a'));
    expect(order.indexOf('start:b')).toBeLessThan(order.indexOf('complete:b'));
    // Both start events should come before both complete events
    const startIndices = [order.indexOf('start:a'), order.indexOf('start:b')];
    const completeIndices = [order.indexOf('complete:a'), order.indexOf('complete:b')];
    expect(Math.max(...startIndices)).toBeLessThan(Math.min(...completeIndices));
  });

  it('diamond dependency: D receives both B and C outputs', async () => {
    const manifest: Manifest = {
      manifest_version: '1.1',
      name: 'diamond',
      triggered_by: 'test',
      context: {},
      agents: [
        { id: 'a', agent: 'agent-a', runtime: 'mock' },
        { id: 'b', agent: 'agent-b', runtime: 'mock', input_from: ['a'] },
        { id: 'c', agent: 'agent-c', runtime: 'mock', input_from: ['a'] },
        { id: 'd', agent: 'agent-d', runtime: 'mock', input_from: ['b', 'c'] },
      ],
      gate_points: [],
      on_failure: 'stop',
    };
    const mockResponses = new Map([
      ['agent-a', 'ra'], ['agent-b', 'rb'], ['agent-c', 'rc'], ['agent-d', 'rd'],
    ]);
    const state = await runManifest(manifest, CONFIG, { mockResponses });
    expect(state.status).toBe('completed');
    expect(state.outputs.size).toBe(4);
    expect(state.outputs.get('d')?.result).toBe('rd');
  });

  it('conditions: skipped step does not block siblings in same phase', async () => {
    const manifest: Manifest = {
      manifest_version: '1.1',
      name: 'cond-parallel',
      triggered_by: 'test',
      context: { val: 5 },
      agents: [
        { id: 'a', agent: 'agent-a', runtime: 'mock',
          conditions: [{ path: 'val', operator: 'gt', value: 100 }] },
        { id: 'b', agent: 'agent-b', runtime: 'mock' },
      ],
      gate_points: [],
      on_failure: 'stop',
    };
    const mockResponses = new Map([['agent-a', 'ra'], ['agent-b', 'rb']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses });
    expect(state.status).toBe('completed');
    expect(state.outputs.get('a')?.skipped).toBe(true);
    expect(state.outputs.get('b')?.result).toBe('rb');
  });

  it('on_failure=stop: one fails, sibling completes, next phase skipped', async () => {
    const manifest: Manifest = {
      manifest_version: '1.1',
      name: 'stop-parallel',
      triggered_by: 'test',
      context: {},
      agents: [
        { id: 'a', agent: 'agent-a', runtime: 'mock', input_from: ['nonexistent'] },
        { id: 'b', agent: 'agent-b', runtime: 'mock' },
        { id: 'c', agent: 'agent-c', runtime: 'mock', input_from: ['a', 'b'] },
      ],
      gate_points: [],
      on_failure: 'stop',
    };
    const mockResponses = new Map([['agent-a', 'ra'], ['agent-b', 'rb'], ['agent-c', 'rc']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses });
    expect(state.status).toBe('failed');
    // Phase [a, b] ran; a failed (orphan ref), b succeeded
    expect(state.outputs.has('b')).toBe(true);
    // Phase [c] should not have run
    expect(state.outputs.has('c')).toBe(false);
  });

  it('on_failure=continue: error recorded, pipeline continues', async () => {
    const manifest: Manifest = {
      manifest_version: '1.1',
      name: 'continue-parallel',
      triggered_by: 'test',
      context: {},
      agents: [
        { id: 'a', agent: 'agent-a', runtime: 'mock', input_from: ['nonexistent'] },
        { id: 'b', agent: 'agent-b', runtime: 'mock' },
        { id: 'c', agent: 'agent-c', runtime: 'mock', input_from: ['b'] },
      ],
      gate_points: [],
      on_failure: 'continue',
    };
    const mockResponses = new Map([['agent-a', 'ra'], ['agent-b', 'rb'], ['agent-c', 'rc']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses });
    expect(state.status).toBe('completed');
    expect(state.outputs.get('a')?.error).toBeDefined();
    expect(state.outputs.get('b')?.result).toBe('rb');
    expect(state.outputs.get('c')?.result).toBe('rc');
  });

  it('on_failure=notify: hook + channel fire on parallel error', async () => {
    const manifest: Manifest = {
      manifest_version: '1.1',
      name: 'notify-parallel',
      triggered_by: 'test',
      context: {},
      agents: [
        { id: 'a', agent: 'agent-a', runtime: 'mock', input_from: ['nonexistent'] },
        { id: 'b', agent: 'agent-b', runtime: 'mock' },
      ],
      gate_points: [],
      on_failure: 'notify',
    };
    const onStepNotify = vi.fn();
    const mockResponses = new Map([['agent-a', 'ra'], ['agent-b', 'rb']]);

    const messages: unknown[] = [];
    const ch = channel('lynox:dag:notify');
    const handler = (msg: unknown) => { messages.push(msg); };
    ch.subscribe(handler);

    const state = await runManifest(manifest, CONFIG, {
      mockResponses,
      hooks: { onStepNotify },
    });
    ch.unsubscribe(handler);

    expect(state.status).toBe('completed');
    expect(onStepNotify).toHaveBeenCalledWith('a', expect.any(Error));
    expect(messages.length).toBe(1);
  });

  it('gate rejection in parallel: halts after phase', async () => {
    const manifest: Manifest = {
      manifest_version: '1.1',
      name: 'gate-parallel',
      triggered_by: 'test',
      context: {},
      agents: [
        { id: 'a', agent: 'agent-a', runtime: 'mock' },
        { id: 'b', agent: 'agent-b', runtime: 'mock', input_from: ['a'] },
      ],
      gate_points: ['a'],
      on_failure: 'stop',
    };
    const gateAdapter: GateAdapter = {
      submit: async () => 'approval-id',
      waitForDecision: async (): Promise<GateDecision> => ({ status: 'rejected', reason: 'no' }),
    };
    const mockResponses = new Map([['agent-a', 'ra'], ['agent-b', 'rb']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses, gateAdapter });
    expect(state.status).toBe('rejected');
    expect(state.outputs.has('b')).toBe(false);
  });

  it('execution: sequential forces sequential mode on v1.1', async () => {
    const manifest: Manifest = {
      manifest_version: '1.1',
      name: 'sequential-v11',
      triggered_by: 'test',
      context: {},
      agents: [
        { id: 'a', agent: 'agent-a', runtime: 'mock' },
        { id: 'b', agent: 'agent-b', runtime: 'mock' },
      ],
      gate_points: [],
      on_failure: 'stop',
      execution: 'sequential',
    };
    const order: string[] = [];
    const hooks: RunHooks = {
      onStepStart: (id) => { order.push(`start:${id}`); },
      onStepComplete: (out) => { order.push(`complete:${out.stepId}`); },
    };
    const mockResponses = new Map([['agent-a', 'ra'], ['agent-b', 'rb']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses, hooks });
    expect(state.status).toBe('completed');
    // Sequential: strict alternation
    expect(order).toEqual(['start:a', 'complete:a', 'start:b', 'complete:b']);
  });
});

describe('runManifest — v1.0 backwards compatibility', () => {
  it('v1.0 runs strictly sequential: start/complete alternation', async () => {
    const order: string[] = [];
    const hooks: RunHooks = {
      onStepStart: (id) => { order.push(`start:${id}`); },
      onStepComplete: (out) => { order.push(`complete:${out.stepId}`); },
    };
    const mockResponses = new Map([['agent-a', 'r1'], ['agent-b', 'r2']]);
    await runManifest(MANIFEST, CONFIG, { mockResponses, hooks });
    expect(order).toEqual(['start:step-1', 'complete:step-1', 'start:step-2', 'complete:step-2']);
  });
});

describe('runManifest — on_failure: notify', () => {
  it('continues and fires onStepNotify hook', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      on_failure: 'notify',
      agents: [
        { id: 'step-1', agent: 'agent-a', runtime: 'mock', input_from: ['does-not-exist'] },
        { id: 'step-2', agent: 'agent-b', runtime: 'mock' },
      ],
    };
    const onStepNotify = vi.fn();
    const mockResponses = new Map([['agent-a', 'ok'], ['agent-b', 'ok']]);
    const state = await runManifest(manifest, CONFIG, {
      mockResponses,
      hooks: { onStepNotify },
    });

    expect(state.status).toBe('completed');
    expect(state.outputs.get('step-1')?.error).toBeDefined();
    expect(state.outputs.get('step-2')?.result).toBe('ok');
    expect(onStepNotify).toHaveBeenCalledWith('step-1', expect.any(Error));
  });

  it('publishes to lynox:dag:notify diagnostics channel', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      on_failure: 'notify',
      agents: [
        { id: 'step-1', agent: 'agent-a', runtime: 'mock', input_from: ['does-not-exist'] },
      ],
    };

    const messages: unknown[] = [];
    const ch = channel('lynox:dag:notify');
    const handler = (msg: unknown) => { messages.push(msg); };
    ch.subscribe(handler);

    await runManifest(manifest, CONFIG, { mockResponses: new Map() });
    ch.unsubscribe(handler);

    expect(messages.length).toBe(1);
    const msg = messages[0] as Record<string, unknown>;
    expect(msg['stepId']).toBe('step-1');
    expect(msg['agentName']).toBe('agent-a');
    expect(msg['manifestName']).toBe('test-flow');
    expect(msg['error']).toContain('has not run yet');
    expect(msg['runId']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('on_failure: continue does NOT fire onStepNotify', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      on_failure: 'continue',
      agents: [
        { id: 'step-1', agent: 'agent-a', runtime: 'mock', input_from: ['does-not-exist'] },
      ],
    };
    const onStepNotify = vi.fn();
    await runManifest(manifest, CONFIG, {
      mockResponses: new Map(),
      hooks: { onStepNotify },
    });
    expect(onStepNotify).not.toHaveBeenCalled();
  });
});

describe('runManifest — inline runtime', () => {
  it('inline step uses mock when mockResponses provided', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      agents: [
        { id: 'step-1', agent: 'step-1', runtime: 'inline', task: 'Do something' },
      ],
    };
    const mockResponses = new Map([['step-1', 'inline-result']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses });
    expect(state.status).toBe('completed');
    expect(state.outputs.get('step-1')?.result).toBe('inline-result');
  });

  it('inline step without parentTools throws when no mockResponses', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      on_failure: 'continue',
      agents: [
        { id: 'step-1', agent: 'step-1', runtime: 'inline', task: 'Do something' },
      ],
    };
    const state = await runManifest(manifest, CONFIG, {});
    expect(state.outputs.get('step-1')?.error).toContain('no parentTools provided');
  });
});

// --- retryManifest tests ---

describe('retryManifest', () => {
  it('skips completed steps and re-executes failed ones', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      on_failure: 'continue',
      agents: [
        { id: 'step-1', agent: 'agent-a', runtime: 'mock' },
        { id: 'step-2', agent: 'agent-b', runtime: 'mock', input_from: ['step-1'] },
      ],
    };

    // Build a previous state where step-1 succeeded and step-2 failed
    const previousState: RunState = {
      runId: 'prev-run-id',
      manifestName: 'test-flow',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'failed',
      globalContext: { env: 'test' },
      outputs: new Map<string, AgentOutput>([
        ['step-1', {
          stepId: 'step-1', result: 'result-a', startedAt: '', completedAt: '',
          durationMs: 100, tokensIn: 10, tokensOut: 5, costUsd: 0.001, skipped: false,
        }],
        ['step-2', {
          stepId: 'step-2', result: '', startedAt: '', completedAt: '',
          durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, skipped: false,
          error: 'some failure',
        }],
      ]),
    };

    const mockResponses = new Map([['agent-a', 'result-a'], ['agent-b', 'result-b-retry']]);
    const hooks: RunHooks = {
      onStepRetrySkipped: vi.fn(),
      onStepStart: vi.fn(),
    };
    const state = await retryManifest(manifest, previousState, CONFIG, { mockResponses, hooks });

    expect(state.status).toBe('completed');
    // step-1 was cached (skipped in retry)
    expect(state.outputs.get('step-1')?.result).toBe('result-a');
    expect(hooks.onStepRetrySkipped).toHaveBeenCalledWith('step-1');
    // step-2 was re-executed
    expect(state.outputs.get('step-2')?.result).toBe('result-b-retry');
    expect(state.outputs.get('step-2')?.error).toBeUndefined();
  });

  it('does not cache skipped steps from previous state', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      on_failure: 'continue',
      agents: [
        { id: 'step-1', agent: 'agent-a', runtime: 'mock' },
      ],
    };

    const previousState: RunState = {
      runId: 'prev-run-id',
      manifestName: 'test-flow',
      startedAt: new Date().toISOString(),
      status: 'completed',
      globalContext: {},
      outputs: new Map<string, AgentOutput>([
        ['step-1', {
          stepId: 'step-1', result: '', startedAt: '', completedAt: '',
          durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
          skipped: true, skipReason: 'conditions not met',
        }],
      ]),
    };

    const mockResponses = new Map([['agent-a', 'fresh-result']]);
    const state = await retryManifest(manifest, previousState, CONFIG, { mockResponses });

    // step-1 should have been re-executed since it was skipped (not cached)
    expect(state.outputs.get('step-1')?.result).toBe('fresh-result');
    expect(state.outputs.get('step-1')?.skipped).toBe(false);
  });
});

describe('runManifest — cachedOutputs', () => {
  it('pre-populated cachedOutputs are used for matching step IDs', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      agents: [
        { id: 'step-1', agent: 'agent-a', runtime: 'mock' },
        { id: 'step-2', agent: 'agent-b', runtime: 'mock' },
      ],
    };
    const cachedOutput: AgentOutput = {
      stepId: 'step-1', result: 'cached-value', startedAt: '', completedAt: '',
      durationMs: 50, tokensIn: 5, tokensOut: 3, costUsd: 0.0001, skipped: false,
    };
    const cachedOutputs = new Map<string, AgentOutput>([['step-1', cachedOutput]]);
    const mockResponses = new Map([['agent-a', 'unused'], ['agent-b', 'result-b']]);

    const state = await runManifest(manifest, CONFIG, { mockResponses, cachedOutputs });
    expect(state.status).toBe('completed');
    expect(state.outputs.get('step-1')?.result).toBe('cached-value');
    expect(state.outputs.get('step-2')?.result).toBe('result-b');
  });

  it('onStepRetrySkipped fires for cached steps', async () => {
    const manifest: Manifest = {
      ...MANIFEST,
      agents: [
        { id: 'step-1', agent: 'agent-a', runtime: 'mock' },
      ],
    };
    const cachedOutput: AgentOutput = {
      stepId: 'step-1', result: 'cached', startedAt: '', completedAt: '',
      durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, skipped: false,
    };
    const cachedOutputs = new Map<string, AgentOutput>([['step-1', cachedOutput]]);
    const onStepRetrySkipped = vi.fn();

    await runManifest(manifest, CONFIG, {
      mockResponses: new Map(),
      cachedOutputs,
      hooks: { onStepRetrySkipped },
    });

    expect(onStepRetrySkipped).toHaveBeenCalledWith('step-1');
  });
});

describe('runManifest — phase hooks', () => {
  it('onPhaseStart and onPhaseComplete fire during parallel execution', async () => {
    const manifest: Manifest = {
      manifest_version: '1.1',
      name: 'phase-hooks',
      triggered_by: 'test',
      context: {},
      agents: [
        { id: 'a', agent: 'agent-a', runtime: 'mock' },
        { id: 'b', agent: 'agent-b', runtime: 'mock' },
        { id: 'c', agent: 'agent-c', runtime: 'mock', input_from: ['a', 'b'] },
      ],
      gate_points: [],
      on_failure: 'stop',
    };

    const events: string[] = [];
    const hooks: RunHooks = {
      onPhaseStart: (idx, ids) => { events.push(`phase-start:${idx}:[${ids.join(',')}]`); },
      onPhaseComplete: (idx) => { events.push(`phase-complete:${idx}`); },
    };
    const mockResponses = new Map([['agent-a', 'ra'], ['agent-b', 'rb'], ['agent-c', 'rc']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses, hooks });

    expect(state.status).toBe('completed');
    // Phase 0: [a, b], Phase 1: [c]
    expect(events).toContain('phase-start:0:[a,b]');
    expect(events).toContain('phase-complete:0');
    expect(events).toContain('phase-start:1:[c]');
    expect(events).toContain('phase-complete:1');
    // Phase 0 start before phase 0 complete
    expect(events.indexOf('phase-start:0:[a,b]')).toBeLessThan(events.indexOf('phase-complete:0'));
    // Phase 0 complete before phase 1 start
    expect(events.indexOf('phase-complete:0')).toBeLessThan(events.indexOf('phase-start:1:[c]'));
  });

  it('phase hooks do not fire in sequential (v1.0) mode', async () => {
    const onPhaseStart = vi.fn();
    const onPhaseComplete = vi.fn();
    const hooks: RunHooks = { onPhaseStart, onPhaseComplete };
    const mockResponses = new Map([['agent-a', 'r1'], ['agent-b', 'r2']]);
    await runManifest(MANIFEST, CONFIG, { mockResponses, hooks });
    expect(onPhaseStart).not.toHaveBeenCalled();
    expect(onPhaseComplete).not.toHaveBeenCalled();
  });
});

describe('runManifest — buildConditionContext', () => {
  it('conditions can reference non-input_from step results', async () => {
    // Step C has a condition referencing step A's result,
    // but input_from only references step B
    const manifest: Manifest = {
      manifest_version: '1.1',
      name: 'cond-context',
      triggered_by: 'test',
      context: {},
      agents: [
        { id: 'a', agent: 'agent-a', runtime: 'mock' },
        { id: 'b', agent: 'agent-b', runtime: 'mock' },
        { id: 'c', agent: 'agent-c', runtime: 'mock',
          input_from: ['b'],
          conditions: [{ path: 'a.result', operator: 'exists' as const }],
        },
      ],
      gate_points: [],
      on_failure: 'stop',
    };

    const mockResponses = new Map([
      ['agent-a', 'result-a'],
      ['agent-b', 'result-b'],
      ['agent-c', 'result-c'],
    ]);
    const state = await runManifest(manifest, CONFIG, { mockResponses });

    expect(state.status).toBe('completed');
    // c ran because condition on a.result was satisfied (via buildConditionContext)
    expect(state.outputs.get('c')?.skipped).toBe(false);
    expect(state.outputs.get('c')?.result).toBe('result-c');
  });

  it('condition on non-input_from step fails when step has not run', async () => {
    // Step B has a condition on step C which hasn't run yet (C depends on B)
    const manifest: Manifest = {
      ...MANIFEST,
      context: {},
      agents: [
        { id: 'a', agent: 'agent-a', runtime: 'mock',
          conditions: [{ path: 'nonexistent_step.result', operator: 'exists' as const }],
        },
      ],
    };

    const mockResponses = new Map([['agent-a', 'ra']]);
    const state = await runManifest(manifest, CONFIG, { mockResponses });

    expect(state.outputs.get('a')?.skipped).toBe(true);
    expect(state.outputs.get('a')?.skipReason).toBe('conditions not met');
  });
});
