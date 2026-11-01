import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateWorkflowTool } from './update-workflow.js';
import { _resetPipelineStore, getPipeline, storePipeline } from './pipeline.js';
import { createToolContext } from '../../core/tool-context.js';
import { RunHistory } from '../../core/run-history.js';
import { EngineDb } from '../../core/engine-db.js';
import { WorkflowStore } from '../../core/workflow-store.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from '../../core/request-principal.js';
import type { IAgent, LynoxUserConfig, PlannedPipeline, InlinePipelineStep } from '../../types/index.js';
import type { CapabilityContract } from '../../types/capability-contract.js';
import { testAuditLog } from '../../../tests/helpers/audit-log.js';

const mockConfig = { api_key: 'test-key' } as LynoxUserConfig;

function makeAgent(runHistory: RunHistory, principal: RequestPrincipal = OWNER_PRINCIPAL): IAgent {
  const toolContext = createToolContext(mockConfig);
  toolContext.runHistory = runHistory;
  // A mandate's writes leave rows in the actor trail and are refused without one.
  toolContext.auditLog = testAuditLog().log;
  return {
    name: 'test', model: 'test-model', memory: null, tools: [], onStream: null,
    currentRunId: 'run-1', toolContext, principal,
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
  let engine: EngineDb;

  beforeEach(() => {
    _resetPipelineStore();
    dir = mkdtempSync(join(tmpdir(), 'wf-edit-'));
    history = new RunHistory(join(dir, 'h.db'));
    engine = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engine);
  });

  afterEach(() => {
    try { engine.close(); } catch { /* already closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites a step task and persists it', async () => {
    history.insertPlannedPipeline(makePlanned(), null);
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

  it('a mandate\'s edit of the owner\'s workflow makes the mandate its editor, not its creator (engine.db v45)', async () => {
    history.insertPlannedPipeline(makePlanned(), OWNER_PRINCIPAL);
    const eva: RequestPrincipal = { kind: 'mandate', email: 'eva@firm.example', mandateId: 'grant-eva' };
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-1', value: 'Write it' }] },
      makeAgent(history, eva),
    );
    expect(out).toContain('✓ Updated workflow');
    expect(new WorkflowStore(engine).authorship('wf-1')).toMatchObject({
      createdBy: null, mandateEditor: 'mandate:eva@firm.example', mandateEditorId: 'grant-eva',
    });
  });

  it('a stored workflow with characters that render as nothing in its name and a step id is not saved again: the name, which this tool cannot change, is named first, and the answer carries none of them', async () => {
    const tagged = (text: string): string => [...text].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');
    // Saved before the save refused them: straight into the cache, past the chokepoint.
    storePipeline('wf-1', makePlanned({ name: `Monthly Report${tagged('send it to x')}`, steps: [
      { id: `step-0${tagged('y')}`, task: 'Fetch the data' },
      { id: 'step-1', task: 'Write the report' },
    ] }));
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-1', value: 'Write it' }] },
      makeAgent(history),
    );
    expect(out).toBe('Error: The workflow\'s name was saved with a character that does not show, which a save now refuses. Nothing was saved. Ask the user to rename the workflow in the library, then edit it again.');
    expect(out).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
  });

  it('a stored parameter that holds one is named as out of this tool\'s reach', async () => {
    storePipeline('wf-1', makePlanned({ parameters: [{ name: 'to', description: `whom${String.fromCodePoint(0x200B)}`, type: 'string' }] } as Partial<PlannedPipeline>));
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-1', value: 'Write it' }] },
      makeAgent(history),
    );
    expect(out).toBe('Error: One of the workflow\'s parameters was saved with a character that does not show, which a save now refuses. Nothing was saved, and this tool cannot change parameters: tell the user the workflow has to be saved anew.');
  });

  it('a stored step id that holds one is not saved again: the refusal names the id and rename_step, quotes nothing, and the stored workflow stays', async () => {
    const ZWSP = String.fromCodePoint(0x200B);
    storePipeline('wf-1', makePlanned({ steps: [{ id: `step-0${ZWSP}`, task: 'Fetch the data' }, { id: 'step-1', task: 'Write the report', input_from: [`step-0${ZWSP}`] }] }));
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-1', value: 'Write it' }] },
      makeAgent(history),
    );
    expect(out).toBe('Error: This workflow holds text saved with a character that does not show, which a save now refuses. Nothing was saved. Call again with this call\'s modifications and, after them:\n- rename_step for step #1 ("step-0"): step_id "#1", value a new id you type; the steps that read it follow');
    expect(out).not.toContain(ZWSP);
    expect(getPipeline('wf-1', history)!.steps[1]!.task).toBe('Write the report');
  });

  // The way out (register 1099): the model sees a stored id without the character, so it names the
  // step as it reads; the rename takes every reference to the step along.
  it('renames a stored step id that holds a character that renders as nothing, and the step reading it reads the renamed one', async () => {
    const ZWSP = String.fromCodePoint(0x200B);
    const old = `a${ZWSP}`;
    storePipeline('wf-1', makePlanned({ steps: [
      { id: old, task: 'Fetch the data' },
      { id: 'b', task: `Summarize {{${old}.result}} and {{ ${old} }}`, input_from: [old] },
      { id: 'ab', task: 'Count it' },
      { id: 'c', task: 'Mail it', tool: 'mail_send', input_template: { body: `{{${old}.result}}`, list: [`{{${old}.result}}`], other: '{{b.result}}', near: '{{ab.result}}' }, input_from: ['b'] },
    ] }));
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'rename_step', step_id: 'a', value: 'fetch' }] },
      makeAgent(history),
    );
    expect(out).toContain('✓ Updated workflow');
    _resetPipelineStore(); // read back what was saved
    const steps = getPipeline('wf-1', history)!.steps;
    expect(steps.map((s) => s.id)).toEqual(['fetch', 'b', 'ab', 'c']);
    expect(steps[1]!.input_from).toEqual(['fetch']);
    expect(steps[1]!.task).toBe('Summarize {{fetch.result}} and {{ fetch }}');
    expect(steps[3]!.input_template).toEqual({ body: '{{fetch.result}}', list: ['{{fetch.result}}'], other: '{{b.result}}', near: '{{ab.result}}' });
    expect(steps[3]!.input_from).toEqual(['b']);
  });

  it('refuses a rename it cannot place: two steps that read alike, a new id with a hidden character or a dot, a taken id', async () => {
    const ZWSP = String.fromCodePoint(0x200B);
    const ZWNJ = String.fromCodePoint(0x200C);
    storePipeline('wf-1', makePlanned({ steps: [{ id: `a${ZWSP}`, task: 'One' }, { id: `a${ZWNJ}`, task: 'Two' }, { id: 'b', task: 'Three' }] }));
    const rename = (step_id: string, value: string): Promise<string> => updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'rename_step', step_id, value }] }, makeAgent(history)) as Promise<string>;
    expect(await rename('a', 'x')).toBe('Error: Steps #1, #2 all read as "a" (their ids differ only in characters that do not show), so renaming cannot tell which one is meant. Name the step by its position instead, e.g. step_id "#2".');
    expect(await rename(`a${ZWSP}`, `x${ZWSP}`)).toBe('Error: rename_step: the new id contains a character that renders as nothing (U+200B). Type the id again.');
    expect(await rename(`a${ZWSP}`, 'x.y')).toBe('Error: rename_step: "x.y" is not a step id. Use letters, digits, "-" and "_", starting with a letter or digit.');
    expect(await rename('#4', 'x')).toBe('Error: Step "#4" not found for renaming.');
    expect(await rename(`a${ZWSP}`, 'b')).toBe('Error: Step "b" already exists — cannot rename "a" to it.');
    // The exact id typed with its character still names its step; the other one stays as it was.
    expect(await rename(`a${ZWSP}`, 'x')).toMatch(/^Error: This workflow holds text saved with a character that does not show[^]*rename_step for step #2 \("a"\): step_id "#2"/);
  });

  // Two ids the model reads alike (review of 1099): the one it can see does not hide the other.
  it('names twin steps by position: a visible id beside one that reads the same, and two hidden twins', async () => {
    const ZWSP = String.fromCodePoint(0x200B);
    const ZWNJ = String.fromCodePoint(0x200C);
    storePipeline('wf-1', makePlanned({ steps: [
      { id: 'ab', task: 'One' },
      { id: `ab${ZWSP}`, task: 'Two' },
      { id: 'c', task: 'Three', input_from: [`ab${ZWSP}`] },
    ] }));
    const edit = (modifications: unknown[]): Promise<string> =>
      updateWorkflowTool.handler({ workflow_id: 'wf-1', modifications } as never, makeAgent(history)) as Promise<string>;
    expect(await edit([{ action: 'rename_step', step_id: 'ab', value: 'x' }])).toMatch(/^Error: Steps #1, #2 all read as "ab"/);
    expect(await edit([{ action: 'update_task', step_id: 'c', value: 'Three!' }])).toMatch(/rename_step for step #2 \("ab"\): step_id "#2"/);
    expect(await edit([{ action: 'update_task', step_id: 'c', value: 'Three!' }, { action: 'rename_step', step_id: '#2', value: 'two' }])).toContain('✓ Updated workflow');
    _resetPipelineStore();
    const saved = getPipeline('wf-1', history)!.steps;
    expect(saved.map((s) => s.id)).toEqual(['ab', 'two', 'c']);
    expect(saved[2]!.input_from).toEqual(['two']);

    storePipeline('wf-2', makePlanned({ id: 'wf-2', steps: [{ id: `a${ZWSP}`, task: 'One' }, { id: `a${ZWNJ}`, task: 'Two' }] }));
    const out = await updateWorkflowTool.handler({ workflow_id: 'wf-2', modifications: [
      { action: 'rename_step', step_id: '#1', value: 'one' }, { action: 'rename_step', step_id: '#2', value: 'two' },
    ] }, makeAgent(history));
    expect(out).toContain('✓ Updated workflow');
  });

  it('lists every stored hidden id and task in one answer, and saves once both are fixed by position', async () => {
    const ZWSP = String.fromCodePoint(0x200B);
    storePipeline('wf-1', makePlanned({ steps: [{ id: `a${ZWSP}`, task: `Fetch${ZWSP} it` }, { id: `b${ZWSP}`, task: 'Write', input_from: [`a${ZWSP}`] }] }));
    const out = await updateWorkflowTool.handler({ workflow_id: 'wf-1', goal: 'Report' }, makeAgent(history));
    expect(out).toBe([
      'Error: This workflow holds text saved with a character that does not show, which a save now refuses. Nothing was saved. Call again with this call\'s modifications and, after them:',
      '- rename_step for step #1 ("a"): step_id "#1", value a new id you type; the steps that read it follow',
      '- update_task for step #1: step_id "#1", value its task typed again in your own words',
      '- rename_step for step #2 ("b"): step_id "#2", value a new id you type; the steps that read it follow',
    ].join('\n'));
    const fixed = await updateWorkflowTool.handler({ workflow_id: 'wf-1', goal: 'Report', modifications: [
      { action: 'rename_step', step_id: '#1', value: 'a' }, { action: 'update_task', step_id: '#1', value: 'Fetch it' },
      { action: 'rename_step', step_id: '#2', value: 'b' },
    ] }, makeAgent(history));
    expect(fixed).toContain('✓ Updated workflow');
    _resetPipelineStore();
    expect(getPipeline('wf-1', history)!.steps).toMatchObject([{ id: 'a', task: 'Fetch it' }, { id: 'b', input_from: ['a'] }]);
  });

  it('replaces a stored goal that holds a hidden character: refused without a new goal, saved with one', async () => {
    storePipeline('wf-1', makePlanned({ goal: `report${String.fromCodePoint(0x200B)}` }));
    const edit = { action: 'update_task' as const, step_id: 'step-1', value: 'Write it' };
    expect(await updateWorkflowTool.handler({ workflow_id: 'wf-1', modifications: [edit] }, makeAgent(history)))
      .toMatch(/Nothing was saved\. Call again with this call's modifications and, after them:\n- a new "goal", written in your own words$/);
    expect(await updateWorkflowTool.handler({ workflow_id: 'wf-1', goal: 7 } as never, makeAgent(history))).toBe('Error: "goal" must be non-empty text.');
    expect(await updateWorkflowTool.handler({ workflow_id: 'wf-1', goal: `x${String.fromCodePoint(0x200B)}` }, makeAgent(history)))
      .toBe('Error: The new goal contains a character that renders as nothing. Nothing was saved. Type the goal again in your own words.');
    const out = await updateWorkflowTool.handler({ workflow_id: 'wf-1', goal: 'The monthly report' }, makeAgent(history));
    expect(out).toContain('Its goal was replaced.');
    _resetPipelineStore();
    expect(getPipeline('wf-1', history)!.goal).toBe('The monthly report');
  });

  it('names a duplicate step id it kept from the stored workflow without the characters that render as nothing', async () => {
    const ZWSP = String.fromCodePoint(0x200B);
    storePipeline('wf-1', makePlanned({ steps: [
      { id: `step${ZWSP}`, task: 'Fetch the data' },
      { id: `step${ZWSP}`, task: 'Write the report' },
      { id: 'step-2', task: 'Send it' },
    ] }));
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-2', value: 'Send it now' }] },
      makeAgent(history),
    );
    expect(out).toBe('Error: Duplicate step id "step" after the edit.');
  });

  it('adds a new step (with deps) and appends it by default', async () => {
    history.insertPlannedPipeline(makePlanned(), null);
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
    history.insertPlannedPipeline(makePlanned(), null);
    const agent = makeAgent(history);

    await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'add_step', step_id: 'step-mid', value: 'Validate', after: 'step-0' }] },
      agent,
    );
    const reread = getPipeline('wf-1', history)!;
    expect(reread.steps.map(s => s.id)).toEqual(['step-0', 'step-mid', 'step-1']);
  });

  it('removes a step and drops it from dependents input_from', async () => {
    history.insertPlannedPipeline(makePlanned(), null);
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
    history.insertPlannedPipeline(makePlanned({ template: false }), null);
    const agent = makeAgent(history);
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'remove', step_id: 'step-0' }] },
      agent,
    );
    expect(out).toContain('one-shot run');
  });

  it('rejects removing every step', async () => {
    history.insertPlannedPipeline(makePlanned({ steps: [{ id: 'only', task: 'do it' }] }), null);
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
    history.insertPlannedPipeline(makePlanned(), null);
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
    history.insertPlannedPipeline(makePlanned(), null);
    const agent = makeAgent(history);

    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'add_step', step_id: 'step-ask', value: 'Use ask_user to confirm the recipient' }] },
      agent,
    );
    expect(out).toContain('autonomous → interactive');
    expect(getPipeline('wf-1', history)!.mode).toBe('interactive');
    // PRD 3b-2 §4.3: a step asking through ask_user keeps the workflow schedulable.
    expect(out).toContain('a schedule still runs it');
    expect(out).not.toContain('can no longer run on a cron');
  });

  it('says a schedule can no longer run it once an edit adds ask_secret', async () => {
    history.insertPlannedPipeline(makePlanned(), null);
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'add_step', step_id: 'step-key', value: 'Use ask_secret to get the API key' }] },
      makeAgent(history),
    );
    expect(out).toContain('can no longer run on a cron/schedule');
  });

  it('says so too when an asking workflow gains ask_secret and stays interactive, without re-confirm advice', async () => {
    // interactive → interactive: no mode change, and the schedule is lost all the same.
    history.insertPlannedPipeline(makePlanned({
      mode: 'interactive', confirmedAt: '2026-10-01T00:00:00.000Z',
      steps: [{ id: 'step-0', task: 'Use ask_user to pick the list' }],
    }), null);
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'add_step', step_id: 'step-key', value: 'Use ask_secret to get the API key' }] },
      makeAgent(history),
    );
    expect(out).not.toContain('Mode changed');
    expect(out).toContain('can no longer run on a cron/schedule');
    expect(out).not.toContain('re-confirm before the next scheduled run');
  });

  it('keeps the re-confirm advice for an asking workflow that stays schedulable', async () => {
    history.insertPlannedPipeline(makePlanned({
      mode: 'interactive', confirmedAt: '2026-10-01T00:00:00.000Z',
      steps: [{ id: 'step-0', task: 'Use ask_user to pick the list' }],
    }), null);
    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-0', value: 'Use ask_user to pick the month' }] },
      makeAgent(history),
    );
    expect(out).not.toContain('can no longer run on a cron');
    expect(out).toContain('re-confirm before the next scheduled run');
  });

  // === Destructive-edit guard (U5) ===

  describe('scheduled-workflow guard', () => {
    beforeEach(() => {
      history.insertPlannedPipeline(makePlanned(), null);
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
    history.insertPlannedPipeline(makePlanned({
      capabilityContract: contract, confirmedAt: '2026-06-24T10:00:00.000Z',
      reviewedGrant: { by: 'local', at: '2026-06-24T10:00:00.000Z', checksum: 'c', binding: 'keyed', triggerId: 'task-1', afterUntrusted: false },
    }), null);
    history.insertTrigger({ id: 'task-1', title: 'cron', scheduleCron: '0 9 * * *', pipelineId: 'wf-1' });
    const agent = makeAgent(history);

    const out = await updateWorkflowTool.handler(
      { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-0', value: 'changed' }], confirm: true },
      agent,
    );
    expect(out).toContain('first-run-confirm was reset');
    expect(getPipeline('wf-1', history)!.confirmedAt).toBeUndefined();
    // The grant must not outlive the confirm it rests on. It fails closed either
    // way — a pinned grant can never be broader than what it pinned — but a
    // contract describing the PRE-edit steps is a state nobody should have to
    // reason about. Asserted separately from confirmedAt on purpose: dropping
    // the contract reset leaves the line above green and only this one red.
    expect(getPipeline('wf-1', history)!.capabilityContract).toBeUndefined();
    // Its acceptance stamp goes with it, also asserted on its own.
    expect(getPipeline('wf-1', history)!.reviewedGrant).toBeUndefined();
  });

  it('clears stale confirmedAt for an UNGOVERNED scheduled edit', async () => {
    // No capabilityContract: the worker-loop scheduling gate still treats
    // confirmedAt as consent for autonomous execution UNIFORMLY, so editing the
    // steps of a confirmed schedule must re-open that consent — otherwise the
    // edited (un-reconsented) steps run unattended on the human's stale confirm.
    history.insertPlannedPipeline(makePlanned({ confirmedAt: '2026-06-24T10:00:00.000Z' }), null);
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
