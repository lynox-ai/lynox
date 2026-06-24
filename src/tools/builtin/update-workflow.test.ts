import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateWorkflowTool } from './update-workflow.js';
import { _resetPipelineStore, getPipeline } from './pipeline.js';
import { createToolContext } from '../../core/tool-context.js';
import { RunHistory } from '../../core/run-history.js';
import type { IAgent, LynoxUserConfig, PlannedPipeline, InlinePipelineStep } from '../../types/index.js';
import type { CapabilityContract } from '../../types/capability-contract.js';

const mockConfig = { api_key: 'test-key' } as LynoxUserConfig;

function makeAgent(runHistory: RunHistory): IAgent {
  const toolContext = createToolContext(mockConfig);
  toolContext.runHistory = runHistory;
  return {
    name: 'test', model: 'test-model', memory: null, tools: [], onStream: null,
    currentRunId: 'run-1', toolContext,
  } as unknown as IAgent;
}

function makePlanned(overrides: Partial<PlannedPipeline> = {}): PlannedPipeline {
  const steps: InlinePipelineStep[] = overrides.steps ?? [
    { id: 'step-0', task: 'Fetch the data' },
    { id: 'step-1', task: 'Write the report', input_from: ['step-0'] },
  ];
  return {
    id: 'wf-1', name: 'Monthly Report', goal: 'report', steps,
    reasoning: '', estimatedCost: 0, createdAt: '2026-06-24T00:00:00.000Z',
    executed: false, executionMode: 'orchestrated', template: true,
    mode: 'autonomous', parameters: [],
    ...overrides,
  };
}

describe('update_workflow_steps (Slice C edit-via-chat tool)', () => {
  let dir: string;
  let history: RunHistory;

  beforeEach(() => {
    _resetPipelineStore();
    dir = mkdtempSync(join(tmpdir(), 'wf-edit-'));
    history = new RunHistory(join(dir, 'h.db'));
  });

  afterEach(() => {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites a step task and persists it', async () => {
    history.insertPlannedPipeline(makePlanned());
    _resetPipelineStore(); // drop the read-cache so we exercise the SQLite round-trip
    const agent = makeAgent(history);

    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-1', value: 'Write the report AND email it' }] },
      agent,
    );
    expect(out).toContain('✓ Updated workflow');

    const reread = getPipeline('wf-1', history)!;
    expect(reread.steps).toHaveLength(2);
    expect(reread.steps[1]!.task).toBe('Write the report AND email it');
  });

  it('adds a new step (with deps) and appends it by default', async () => {
    history.insertPlannedPipeline(makePlanned());
    const agent = makeAgent(history);

    await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'add_step', step_id: 'step-2', value: 'Email the summary', input_from: ['step-1'] }] },
      agent,
    );
    const reread = getPipeline('wf-1', history)!;
    expect(reread.steps.map(s => s.id)).toEqual(['step-0', 'step-1', 'step-2']);
    expect(reread.steps[2]!.input_from).toEqual(['step-1']);
  });

  it('inserts an added step after a named step', async () => {
    history.insertPlannedPipeline(makePlanned());
    const agent = makeAgent(history);

    await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'add_step', step_id: 'step-mid', value: 'Validate', after: 'step-0' }] },
      agent,
    );
    const reread = getPipeline('wf-1', history)!;
    expect(reread.steps.map(s => s.id)).toEqual(['step-0', 'step-mid', 'step-1']);
  });

  it('removes a step and drops it from dependents input_from', async () => {
    history.insertPlannedPipeline(makePlanned());
    const agent = makeAgent(history);

    await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'remove', step_id: 'step-0' }] },
      agent,
    );
    const reread = getPipeline('wf-1', history)!;
    expect(reread.steps.map(s => s.id)).toEqual(['step-1']);
    // step-1 depended on the removed step-0 → that dangling dep is cleaned up.
    expect(reread.steps[0]!.input_from).toBeUndefined();
  });

  it('errors on an unknown workflow', async () => {
    const agent = makeAgent(history);
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'nope', modifications: [{ action: 'remove', step_id: 'x' }] },
      agent,
    );
    expect(out).toContain('not found');
  });

  it('refuses to edit a one-shot (non-template) run', async () => {
    history.insertPlannedPipeline(makePlanned({ template: false }));
    const agent = makeAgent(history);
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'remove', step_id: 'step-0' }] },
      agent,
    );
    expect(out).toContain('one-shot run');
  });

  it('rejects removing every step', async () => {
    history.insertPlannedPipeline(makePlanned({ steps: [{ id: 'only', task: 'do it' }] }));
    const agent = makeAgent(history);
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'remove', step_id: 'only' }] },
      agent,
    );
    expect(out).toContain('at least one step');
    // The original is untouched.
    expect(getPipeline('wf-1', history)!.steps).toHaveLength(1);
  });

  it('rejects an add_step with a duplicate id / unknown dep / bad anchor', async () => {
    history.insertPlannedPipeline(makePlanned());
    const agent = makeAgent(history);

    const dup = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'add_step', step_id: 'step-0', value: 'x' }] }, agent);
    expect(dup).toContain('already exists');

    const badDep = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'add_step', step_id: 'step-9', value: 'x', input_from: ['ghost'] }] }, agent);
    expect(badDep).toContain('unknown step');

    const badAnchor = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'add_step', step_id: 'step-9', value: 'x', after: 'ghost' }] }, agent);
    expect(badAnchor).toContain('does not exist');
  });

  it('re-infers mode → interactive when an edit introduces a human-in-the-loop step', async () => {
    history.insertPlannedPipeline(makePlanned());
    const agent = makeAgent(history);

    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'add_step', step_id: 'step-ask', value: 'Use ask_user to confirm the recipient' }] },
      agent,
    );
    expect(out).toContain('autonomous → interactive');
    expect(getPipeline('wf-1', history)!.mode).toBe('interactive');
  });

  // === Destructive-edit guard (U5) ===

  describe('scheduled-workflow guard', () => {
    beforeEach(() => {
      history.insertPlannedPipeline(makePlanned());
      // An ENABLED cron task referencing the workflow → it is "scheduled".
      history.insertTrigger({ id: 'task-1', title: 'cron', scheduleCron: '0 9 * * *', pipelineId: 'wf-1' });
    });

    it('refuses without confirm and does NOT persist', async () => {
      const agent = makeAgent(history);
      const out = await updateWorkflowTool.handler(
        { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-0', value: 'changed' }] },
        agent,
      );
      expect(out).toContain('⚠️');
      expect(out).toContain('confirm');
      // Unchanged on disk.
      expect(getPipeline('wf-1', history)!.steps[0]!.task).toBe('Fetch the data');
    });

    it('proceeds with confirm:true', async () => {
      const agent = makeAgent(history);
      const out = await updateWorkflowTool.handler(
        { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-0', value: 'changed' }], confirm: true },
        agent,
      );
      expect(out).toContain('✓ Updated');
      expect(getPipeline('wf-1', history)!.steps[0]!.task).toBe('changed');
    });

    it('a disabled (paused) schedule does NOT trip the guard', async () => {
      history.setTriggerEnabled('task-1', false);
      const agent = makeAgent(history);
      const out = await updateWorkflowTool.handler(
        { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-0', value: 'changed' }] },
        agent,
      );
      expect(out).toContain('✓ Updated');
    });
  });

  it('clears confirmedAt for a contract-governed edit (consent is stale)', async () => {
    const contract: CapabilityContract = {
      version: 1, grantedTools: ['http_request'], httpMethods: ['POST'],
      hostPatterns: ['hooks.example.com'], pathPatterns: ['/report'], paramConstraints: {},
    };
    history.insertPlannedPipeline(makePlanned({ capabilityContract: contract, confirmedAt: '2026-06-24T10:00:00.000Z' }));
    history.insertTrigger({ id: 'task-1', title: 'cron', scheduleCron: '0 9 * * *', pipelineId: 'wf-1' });
    const agent = makeAgent(history);

    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-0', value: 'changed' }], confirm: true },
      agent,
    );
    expect(out).toContain('first-run-confirm was reset');
    expect(getPipeline('wf-1', history)!.confirmedAt).toBeUndefined();
  });
});
