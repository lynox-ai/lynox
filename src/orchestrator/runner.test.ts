import { describe, it, expect, vi } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runManifest, retryManifest, workflowBoundExceeded } from './runner.js';
import { RunHistory } from '../core/run-history.js';
import type { Manifest, RunHooks, RunState, AgentOutput, GateAdapter, GateDecision, GateSubmitParams } from '../types/orchestration.js';
import type { LynoxUserConfig } from '../types/index.js';
import type { SessionCounters } from '../types/agent.js';

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

describe('runManifest — empty manifest guard', () => {
  it('throws a clear error when agents is missing', async () => {
    const bad = { ...MANIFEST, agents: undefined as unknown as Manifest['agents'] };
    await expect(runManifest(bad, CONFIG)).rejects.toThrow(/no agents/);
  });

  it('throws a clear error when agents is empty', async () => {
    const bad: Manifest = { ...MANIFEST, agents: [] };
    await expect(runManifest(bad, CONFIG)).rejects.toThrow(/no agents/);
  });
});

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

describe('runManifest — A2 step-recording (pipeline_step rows + billing isolation)', () => {
  function tmpHistory(): { h: RunHistory; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'runner-a2-'));
    return { h: new RunHistory(join(dir, 'history.db')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('records a `pipeline_step` run per step (status running→completed, chained via spawn_parent_id)', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      const mockResponses = new Map([['agent-a', 'ra'], ['agent-b', 'rb']]);
      const state = await runManifest(MANIFEST, CONFIG, { mockResponses, runHistory: h });

      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      const stepRows = db.prepare(
        `SELECT task_text, status, run_type, model_id, tool_call_count FROM runs WHERE spawn_parent_id = ? AND run_type = 'pipeline_step' ORDER BY created_at`,
      ).all(state.runId) as Array<{ task_text: string; status: string; run_type: string; model_id: string; tool_call_count: number }>;

      expect(stepRows).toHaveLength(2);
      expect(stepRows.every(r => r.status === 'completed')).toBe(true);
      // No step left dangling in 'running'.
      expect(stepRows.some(r => r.status === 'running')).toBe(false);
      // Mock steps resolve no model and record no tool calls, so the finalize
      // leaves model_id='' + tool_call_count=0. The populated path (a real
      // inline/agent step stamping the resolved model + recorded call count) is
      // staging-verified — it can't run here without a live LLM.
      expect(stepRows.every(r => r.model_id === '')).toBe(true);
      expect(stepRows.every(r => r.tool_call_count === 0)).toBe(true);
    } finally {
      h.close();
      cleanup();
    }
  });

  it('those pipeline_step rows do NOT pollute getStats / getUsageSummary (billing isolation, end-to-end)', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      await runManifest(MANIFEST, CONFIG, { mockResponses: new Map([['agent-a', 'ra'], ['agent-b', 'rb']]), runHistory: h });
      // Only pipeline_step rows exist → every spend/stats aggregate must read zero.
      const stats = h.getStats();
      expect(stats.total_cost_usd).toBe(0);
      expect(stats.user_turn_runs).toBe(0);
      expect(stats.cost_by_model).toEqual([]);
      const usage = h.getUsageSummary({ startIso: '2000-01-01T00:00:00.000Z', endIso: '2100-01-01T00:00:00.000Z', source: 'rolling', label: 'all' });
      expect(usage.used_cents).toBe(0);
      expect(usage.by_model).toEqual([]);
    } finally {
      h.close();
      cleanup();
    }
  });
});

describe('runManifest — 2a durable pipeline_runs record', () => {
  function tmpHistory(): { h: RunHistory; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'runner-2a-'));
    return { h: new RunHistory(join(dir, 'history.db')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('writes exactly ONE pipeline_runs row: born running → finalized terminal, with totals + workflow linkage', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      const mockResponses = new Map([['agent-a', 'ra'], ['agent-b', 'rb']]);
      const state = await runManifest(MANIFEST, CONFIG, { mockResponses, runHistory: h, workflowId: 'wf-123' });

      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      const rows = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').all(state.runId) as Array<Record<string, unknown>>;
      // I1: the start-INSERT is the SOLE INSERT — no double-fire, exactly one row.
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.status).toBe('completed');        // finalize-UPDATE settled it
      expect(row.completed_at).not.toBeNull();      // finalize stamps completed_at
      expect(row.started_at).not.toBeNull();        // start-INSERT default
      expect(row.workflow_id).toBe('wf-123');       // run→workflow linkage threaded
      // B2: step_count + token/duration totals are 0 at the start-INSERT and
      // ONLY the finalize UPDATE carries them (spawnMock emits 10 in / 20 out /
      // 1ms per step across the 2-step MANIFEST) — so these exact non-default
      // values prove the finalize wired every B2 column, not the DEFAULT 0.
      expect(row.step_count).toBe(2);
      expect(row.total_tokens_in).toBe(20);
      expect(row.total_tokens_out).toBe(40);
      expect(row.total_duration_ms).toBe(2);
    } finally {
      h.close();
      cleanup();
    }
  });

  it('makes the run VISIBLE as running mid-flight — completed_at still NULL (the 2a headline)', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      // onStepStart fires after the start-INSERT (before the step loop) and
      // before the finalize (in the finally) — so the row is observable in its
      // in-flight state. The DB is fresh, so the sole 'running' row is this run.
      let midRun: { status: string; completed_at: string | null } | undefined;
      const hooks = {
        onStepStart: () => {
          midRun ??= db.prepare("SELECT status, completed_at FROM pipeline_runs WHERE status = 'running'")
            .get() as { status: string; completed_at: string | null } | undefined;
        },
      };
      await runManifest(MANIFEST, CONFIG, { mockResponses: new Map([['agent-a', 'ra'], ['agent-b', 'rb']]), runHistory: h, hooks });

      expect(midRun?.status).toBe('running');       // durable-from-START, not only at end
      expect(midRun?.completed_at).toBeNull();       // in-flight: not yet finalized
    } finally {
      h.close();
      cleanup();
    }
  });

  it('finalizes the row as a terminal status (never stuck at running) when the run does not complete', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      const mockResponses = new Map([['agent-a', 'result-a'], ['agent-b', 'result-b']]);
      // maxIterations:1 aborts the run mid-way → status 'failed', not 'completed'.
      const state = await runManifest(MANIFEST, CONFIG, { mockResponses, runHistory: h, limits: { maxIterations: 1 } });
      expect(state.status).toBe('failed');

      const row = h.getPipelineRun(state.runId);
      expect(row?.status).toBe('failed');           // finalized terminal, NOT 'running'
      expect(row?.completed_at).not.toBeNull();     // no stuck-running row
    } finally {
      h.close();
      cleanup();
    }
  });

  it('a nested sub-pipeline (depth > 0) writes its own row with parent_run_id + is filtered from the top-level list (B5/I6)', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      // A top-level run (parent_run_id NULL) + a nested run (depth 1 with a
      // parent_run_id, as spawnPipeline threads).
      await runManifest(MANIFEST, CONFIG, { mockResponses: new Map([['agent-a', 'ra'], ['agent-b', 'rb']]), runHistory: h });
      await runManifest({ ...MANIFEST, name: 'sub-flow' }, CONFIG, { mockResponses: new Map([['agent-a', 'ra'], ['agent-b', 'rb']]), runHistory: h, depth: 1, parentRunId: 'outer-run-id' });

      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      // Both runs wrote a row — the nested one carries its parent link.
      const all = db.prepare('SELECT parent_run_id FROM pipeline_runs ORDER BY started_at').all() as Array<{ parent_run_id: string | null }>;
      expect(all).toHaveLength(2);
      expect(all.some(r => r.parent_run_id === 'outer-run-id')).toBe(true);

      // ...but the top-level list shows ONLY the top-level run (I6 filter).
      const list = h.getRecentPipelineRuns(20);
      expect(list).toHaveLength(1);
      expect(list[0]!.manifest_name).toBe('test-flow');
    } finally {
      h.close();
      cleanup();
    }
  });

  it('a real runtime:pipeline step threads the OUTER runId onto its nested run row (B5, end-to-end)', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      // A runtime:'pipeline' step actually nests through executeStep → spawnPipeline
      // → the nested runManifest (this is the ONLY path that exercises executeStep
      // passing `state.runId` as the parent). The inner inline step fails
      // DETERMINISTICALLY — a missing dependency throws "has not run yet" in
      // buildStepContext, before any model call — so the test needs no network.
      const nestingManifest: Manifest = {
        manifest_version: '1.1',
        name: 'outer-flow',
        triggered_by: 'test',
        context: {},
        execution: 'sequential',
        agents: [
          {
            id: 'nest', agent: 'nest', runtime: 'pipeline',
            pipeline: [{ id: 'inner', task: 'x', input_from: ['does-not-exist'] }],
          } as unknown as Manifest['agents'][number],
        ],
        gate_points: [],
        on_failure: 'continue',
      };
      // NO mockResponses → the pipeline step nests for real (not spawnMock).
      const state = await runManifest(nestingManifest, CONFIG, { runHistory: h });

      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      const nested = db.prepare('SELECT parent_run_id FROM pipeline_runs WHERE parent_run_id IS NOT NULL').get() as { parent_run_id: string } | undefined;
      // The nested row's parent is the OUTER run's id — proving executeStep passed
      // state.runId (not step.id / the undefined top-level parentRunId).
      expect(nested?.parent_run_id).toBe(state.runId);
      // ...and the nested run is filtered out of the top-level list (only the outer).
      expect(h.getRecentPipelineRuns(20).map(r => r.id)).toEqual([state.runId]);
    } finally {
      h.close();
      cleanup();
    }
  });

  it('both top-level views exclude nested runs, which stay reachable by id (B5 / I6)', () => {
    const { h, cleanup } = tmpHistory();
    try {
      h.insertPipelineRun({ id: 'top', manifestName: 'wf', status: 'completed', manifestJson: '{}', totalCostUsd: 3, stepCount: 1 });
      h.insertPipelineRun({ id: 'child', manifestName: 'nest-sub', status: 'completed', manifestJson: '{}', totalCostUsd: 5, stepCount: 1, parentRunId: 'top' });

      // Cost stats: only the top-level manifest bucket, no synthetic 'nest-sub'.
      expect(h.getPipelineCostStats(30).map(s => s.manifest_name)).toEqual(['wf']);
      // Run list: only the top-level run.
      expect(h.getRecentPipelineRuns(20).map(r => r.id)).toEqual(['top']);
      // But the nested run is still retrievable by id — drill-down preserved.
      expect(h.getPipelineRun('child')?.parent_run_id).toBe('top');
    } finally {
      h.close();
      cleanup();
    }
  });

  it('getPipelineStepStats (per-manifest step view) also excludes nested runs (B5)', () => {
    const { h, cleanup } = tmpHistory();
    try {
      h.insertPipelineRun({ id: 'top', manifestName: 'wf', status: 'completed', manifestJson: '{}' });
      h.insertPipelineRun({ id: 'child', manifestName: 'nest-sub', status: 'completed', manifestJson: '{}', parentRunId: 'top' });
      h.insertPipelineStepResult({ pipelineRunId: 'top', stepId: 's1', status: 'completed', costUsd: 1, modelTier: 'balanced' });
      h.insertPipelineStepResult({ pipelineRunId: 'child', stepId: 's2', status: 'completed', costUsd: 1, modelTier: 'balanced' });
      // Only the top-level workflow's steps — no synthetic 'nest-sub' bucket.
      expect(h.getPipelineStepStats(30).map(s => s.manifest_name)).toEqual(['wf']);
    } finally {
      h.close();
      cleanup();
    }
  });

  it('getPipelineCostStats excludes non-terminal (running/interrupted) rows (B6 / I8)', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      // A completed run (real $1 cost) + a stuck 'running' row (0 cost, no
      // finalize): the aggregate must count ONLY the completed one, else the
      // in-flight row halves the average and inflates the count.
      h.insertPipelineRun({ id: 'done', manifestName: 'wf', status: 'completed', manifestJson: '{}', totalCostUsd: 1, stepCount: 1 });
      h.insertPipelineRun({ id: 'live', manifestName: 'wf', status: 'running', manifestJson: '{}' });
      const stats = h.getPipelineCostStats(30);
      const wf = stats.find(s => s.manifest_name === 'wf');
      expect(wf?.run_count).toBe(1);          // the 'running' row is not counted
      expect(wf?.avg_cost_usd).toBe(1);        // not diluted to 0.5
    } finally {
      h.close();
      cleanup();
    }
  });

  it('completes cleanly when no runHistory is provided — the writer is opt-in, never crashes', async () => {
    // No runHistory → no record + no throw. There is no DB to inspect; the
    // guarantee is that the opt-in writer degrades silently, not that a row
    // is written.
    const state = await runManifest(MANIFEST, CONFIG, { mockResponses: new Map([['agent-a', 'ra'], ['agent-b', 'rb']]) });
    expect(state.status).toBe('completed');
  });
});

describe('runManifest — 2a/B3 durable step-record', () => {
  function tmpHistory(): { h: RunHistory; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'runner-b3-'));
    return { h: new RunHistory(join(dir, 'history.db')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('writes step rows AS-COMPLETED with the result DEFERRED — empty mid-run, filled only at finalize (I4)', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      const mockResponses = new Map([['agent-a', 'result-a'], ['agent-b', 'result-b']]);
      // onStepComplete fires BEFORE this step's own row is inserted, so the first
      // NON-EMPTY snapshot is step-1's row seen at step-2's callback — the run is
      // still in flight, so its result MUST be '' (the structural 2b fence:
      // partial result-text is never persisted mid-run).
      let midRun: Array<{ status: string; result: string }> = [];
      const hooks = {
        onStepComplete: () => {
          if (midRun.length === 0) {
            midRun = db.prepare('SELECT status, result FROM pipeline_step_results ORDER BY id').all() as Array<{ status: string; result: string }>;
          }
        },
      };
      const state = await runManifest(MANIFEST, CONFIG, { mockResponses, runHistory: h, hooks });
      expect(state.status).toBe('completed');

      expect(midRun.length).toBeGreaterThanOrEqual(1);
      expect(midRun[0]!.status).toBe('completed');
      expect(midRun[0]!.result).toBe(''); // I4: NOT persisted mid-run

      // After finalize the result-text is filled — by rowid, so both distinct
      // rows get their OWN result (I5: no UNIQUE(run_id, step_id) collapse).
      const rows = db.prepare('SELECT step_id, status, result FROM pipeline_step_results ORDER BY id').all() as Array<{ step_id: string; status: string; result: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.map(r => r.status)).toEqual(['completed', 'completed']);
      expect(rows.find(r => r.step_id === 'step-1')?.result).toBe('result-a');
      expect(rows.find(r => r.step_id === 'step-2')?.result).toBe('result-b');
    } finally {
      h.close();
      cleanup();
    }
  });

  it('records a stop-failed step in pipeline_step_results even though it never enters state.outputs', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      const manifestWithError: Manifest = {
        ...MANIFEST,
        on_failure: 'stop',
        agents: [
          { id: 'step-1', agent: 'agent-a', runtime: 'mock', input_from: ['does-not-exist'] },
          { id: 'step-2', agent: 'agent-b', runtime: 'mock' },
        ],
      };
      const state = await runManifest(manifestWithError, CONFIG, { mockResponses: new Map(), runHistory: h });
      expect(state.status).toBe('failed');
      expect(state.outputs.has('step-1')).toBe(false); // the batch writer's blind spot

      // B3 closes the gap: /:id/steps (which reads ONLY pipeline_step_results)
      // now shows the failed step. step-2 never ran (halt) → exactly one row.
      const rows = db.prepare('SELECT step_id, status, result FROM pipeline_step_results ORDER BY id').all() as Array<{ step_id: string; status: string; result: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.step_id).toBe('step-1');
      expect(rows[0]!.status).toBe('failed');
      expect(rows[0]!.result).toBe(''); // a failed step carries no result
    } finally {
      h.close();
      cleanup();
    }
  });

  it('a nested sub-pipeline (depth > 0) writes its step rows under its OWN run row — no orphan (B5)', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      const state = await runManifest({ ...MANIFEST, name: 'sub-flow' }, CONFIG, { mockResponses: new Map([['agent-a', 'ra'], ['agent-b', 'rb']]), runHistory: h, depth: 1, parentRunId: 'outer-run-id' });
      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      // The nested run now writes a pipeline_runs row (parent exists), so its
      // step rows attach to its OWN run id — never orphaned.
      const rows = db.prepare('SELECT pipeline_run_id FROM pipeline_step_results').all() as Array<{ pipeline_run_id: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.every(r => r.pipeline_run_id === state.runId)).toBe(true);
    } finally {
      h.close();
      cleanup();
    }
  });

  it('fills result-text by ROWID, not by (run_id, step_id) — two rows sharing a step_id keep distinct results (I5)', () => {
    const { h, cleanup } = tmpHistory();
    try {
      // Simulate the for_each shape: two step rows under the SAME run_id + step_id
      // (no UNIQUE forbids it). A finalize keyed on (run_id, step_id) would collapse
      // both to one result; keyed on the returned rowid, each keeps its own.
      h.insertPipelineRun({ id: 'run-x', manifestName: 'wf', status: 'running', manifestJson: '{}' });
      const rowA = h.insertPipelineStepResult({ pipelineRunId: 'run-x', stepId: 'loop', status: 'completed', result: '' });
      const rowB = h.insertPipelineStepResult({ pipelineRunId: 'run-x', stepId: 'loop', status: 'completed', result: '' });
      expect(rowA).not.toBe(rowB);
      h.updatePipelineStepResultText(rowA, 'item-A');
      h.updatePipelineStepResultText(rowB, 'item-B');
      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      const rows = db.prepare("SELECT result FROM pipeline_step_results WHERE pipeline_run_id = 'run-x' ORDER BY id").all() as Array<{ result: string }>;
      expect(rows.map(r => r.result)).toEqual(['item-A', 'item-B']);
    } finally {
      h.close();
      cleanup();
    }
  });

  it('records step rows for a PARALLEL run (v1.1), each row keeping its own result', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      const parallelManifest: Manifest = {
        manifest_version: '1.1',
        name: 'par-flow',
        triggered_by: 'test',
        context: {},
        execution: 'parallel',
        agents: [
          { id: 'p-a', agent: 'agent-a', runtime: 'mock' },
          { id: 'p-b', agent: 'agent-b', runtime: 'mock' },
        ],
        gate_points: [],
        on_failure: 'stop',
      };
      const state = await runManifest(parallelManifest, CONFIG, { mockResponses: new Map([['agent-a', 'ra'], ['agent-b', 'rb']]), runHistory: h });
      expect(state.status).toBe('completed');
      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      const rows = db.prepare('SELECT step_id, status, result FROM pipeline_step_results ORDER BY step_id').all() as Array<{ step_id: string; status: string; result: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.find(r => r.step_id === 'p-a')?.result).toBe('ra');
      expect(rows.find(r => r.step_id === 'p-b')?.result).toBe('rb');
    } finally {
      h.close();
      cleanup();
    }
  });

  it('records a cached (retry-reused) step with its CACHED result, not blank', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      const cached: AgentOutput = {
        stepId: 'step-1', result: 'cached-a', startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(), durationMs: 5, tokensIn: 1, tokensOut: 2, costUsd: 0, skipped: false,
      };
      const state = await runManifest(MANIFEST, CONFIG, { mockResponses: new Map([['agent-b', 'rb']]), runHistory: h, cachedOutputs: new Map([['step-1', cached]]) });
      expect(state.status).toBe('completed');
      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      const rows = db.prepare('SELECT step_id, result FROM pipeline_step_results ORDER BY step_id').all() as Array<{ step_id: string; result: string }>;
      // The cached step's row must carry its reused result, not '' (a bug pushing
      // '' instead of cached.result would leave it blank at finalize).
      expect(rows.find(r => r.step_id === 'step-1')?.result).toBe('cached-a');
      expect(rows.find(r => r.step_id === 'step-2')?.result).toBe('rb');
    } finally {
      h.close();
      cleanup();
    }
  });

  it('emits exactly ONE row per step under on_failure=continue (fail + success = 2 rows, no double-emit)', async () => {
    const { h, cleanup } = tmpHistory();
    try {
      const manifest: Manifest = {
        ...MANIFEST,
        on_failure: 'continue',
        agents: [
          { id: 'step-1', agent: 'agent-a', runtime: 'mock', input_from: ['does-not-exist'] },
          { id: 'step-2', agent: 'agent-b', runtime: 'mock' },
        ],
      };
      await runManifest(manifest, CONFIG, { mockResponses: new Map([['agent-b', 'rb']]), runHistory: h });
      const db = (h as unknown as { db: import('better-sqlite3').Database }).db;
      const rows = db.prepare('SELECT step_id, status FROM pipeline_step_results ORDER BY step_id').all() as Array<{ step_id: string; status: string }>;
      // The continue-failed step enters state.outputs AND hits the catch — it must
      // still produce exactly ONE row (a double-emit would make this 3).
      expect(rows).toHaveLength(2);
      expect(rows.find(r => r.step_id === 'step-1')?.status).toBe('failed');
      expect(rows.find(r => r.step_id === 'step-2')?.status).toBe('completed');
    } finally {
      h.close();
      cleanup();
    }
  });
});

// === Slice B: per-workflow DoS bounds (S3) ===
describe('workflowBoundExceeded', () => {
  const counters: SessionCounters = {
    httpRequests: 0,
    writeBytes: 0,
    costUSD: 0,
    approvedOutboundDomains: new Set<string>(),
    pendingOutboundPrompts: new Map<string, Promise<boolean>>(),
  };

  it('returns null when no limits are set (unbounded run)', () => {
    expect(workflowBoundExceeded(undefined, Date.now(), 999, counters)).toBeNull();
  });

  it('returns null while within all bounds', () => {
    const limits = { maxIterations: 50, maxWallClockMs: 60_000, maxSpendUsd: 5 };
    expect(workflowBoundExceeded(limits, Date.now(), 3, { ...counters, costUSD: 0.2 })).toBeNull();
  });

  it('aborts on the step (iteration) limit', () => {
    const r = workflowBoundExceeded({ maxIterations: 5 }, Date.now(), 5, counters);
    expect(r).toContain('step limit');
  });

  it('aborts on the wall-clock limit', () => {
    // Started 10s ago, limit 1s → exceeded.
    const r = workflowBoundExceeded({ maxWallClockMs: 1_000 }, Date.now() - 10_000, 0, counters);
    expect(r).toContain('wall-clock');
  });

  it('aborts on the spend limit (opt-in)', () => {
    const r = workflowBoundExceeded({ maxSpendUsd: 1 }, Date.now(), 0, { ...counters, costUSD: 2.5 });
    expect(r).toContain('spend limit');
  });
});

describe('runManifest — DoS bound wiring', () => {
  it('aborts a sequential run mid-way when the step limit is hit', async () => {
    const mockResponses = new Map([['agent-a', 'result-a'], ['agent-b', 'result-b']]);
    // maxIterations:1 → step-1 runs, then the pre-step-2 check aborts the run.
    const state = await runManifest(MANIFEST, CONFIG, { mockResponses, limits: { maxIterations: 1 } });
    expect(state.status).toBe('failed');
    expect(state.error).toContain('step limit');
    expect(state.outputs.has('step-1')).toBe(true);
    expect(state.outputs.has('step-2')).toBe(false);
  });

  it('does not abort a run that stays within its limits', async () => {
    const mockResponses = new Map([['agent-a', 'result-a'], ['agent-b', 'result-b']]);
    const state = await runManifest(MANIFEST, CONFIG, { mockResponses, limits: { maxIterations: 50, maxWallClockMs: 60_000 } });
    expect(state.status).toBe('completed');
    expect(state.outputs.size).toBe(2);
  });

  it('also enforces the bound on the PARALLEL execution path (between phases)', async () => {
    // manifest_version '1.1' with a dependency → 2 phases → parallel runner.
    const parallelManifest: Manifest = {
      manifest_version: '1.1',
      name: 'parallel-flow',
      triggered_by: 'test',
      context: {},
      agents: [
        { id: 'p1', agent: 'agent-a', runtime: 'mock' },
        { id: 'p2', agent: 'agent-b', runtime: 'mock', input_from: ['p1'] },
      ],
      gate_points: [],
      on_failure: 'stop',
    };
    const mockResponses = new Map([['agent-a', 'result-a'], ['agent-b', 'result-b']]);
    const state = await runManifest(parallelManifest, CONFIG, { mockResponses, limits: { maxIterations: 1 } });
    expect(state.status).toBe('failed');
    expect(state.error).toContain('step limit');
    expect(state.outputs.has('p1')).toBe(true);
    expect(state.outputs.has('p2')).toBe(false);
  });
});
