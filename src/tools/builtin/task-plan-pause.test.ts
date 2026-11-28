import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from '../../core/run-history.js';
import { EngineDb } from '../../core/engine-db.js';
import { TaskManager } from '../../core/task-manager.js';
import { taskUpdateTool, taskListTool, triggerDetailLine } from './task.js';
import type { IAgent } from '../../types/index.js';
import { createToolContext } from '../../core/tool-context.js';
import { MandateEnds } from '../../core/mandate-ends.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from '../../core/request-principal.js';
import { ACCESS_ENDED_PAUSED_RESULT, ACCESS_ENDED_RESULT, PAUSED_DONE_ITS_WORKFLOW_FIRST, PAUSED_MODEL_TEXT, pausedDoneModelText, pausedDoneUpdateRefusal, setPlanPauseForTests } from '../../core/plan-pause.js';

// A completed agent plan runs no workflow: its sentence has no workflow takeover (U-275 N6).
const PAUSED_DONE_MODEL_TEXT = pausedDoneModelText({ kind: 'none' });
const PAUSED_DONE_UPDATE_REFUSAL = pausedDoneUpdateRefusal({ kind: 'none' });

/**
 * What the model reads of a paused plan (`plan-pause.ts`), and what its tools may do to one.
 */

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'ida@example.invalid', mandateId: 'G-1' };

describe('a paused plan in the task tools', () => {
  let dir: string;
  let history: RunHistory;
  let engine: EngineDb;
  let tm: TaskManager;
  let restore: () => void;

  const agent = (principal: RequestPrincipal = OWNER_PRINCIPAL): IAgent => {
    const ctx = createToolContext({});
    ctx.taskManager = tm;
    ctx.runHistory = history;
    ctx.mandateEnds = new MandateEnds(engine.getDb());
    return { name: 't', model: 'm', memory: null, tools: [], onStream: null, activeScopes: undefined, toolContext: ctx, principal } as IAgent;
  };
  const seed = (id: string, paused: boolean): void => {
    history.insertTrigger({ id, title: `Plan ${id}`, source: 'cron', effect: 'notify', scheduleCron: '0 9 * * 1', nextRunAt: '2026-01-05T09:00:00.000Z', confirmedAt: '2026-01-01T00:00:00.000Z' });
    if (paused) engine.getDb().prepare('UPDATE triggers SET paused_at = 1 WHERE id = ?').run(id);
  };
  const marks = (id: string): unknown => engine.getDb().prepare('SELECT title, edited_by, mandate_editor, status FROM triggers WHERE id = ?').get(id);

  beforeEach(() => {
    restore = setPlanPauseForTests(true);
    dir = mkdtempSync(join(tmpdir(), 'lynox-task-pause-'));
    history = new RunHistory(join(dir, 'h.db'));
    engine = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engine);
    tm = new TaskManager(history);
  });
  afterEach(() => {
    restore();
    try { engine.close(); } catch { /* already closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the model text, exactly', () => {
    expect(PAUSED_MODEL_TEXT).toBe("paused until the owner takes it over (the helper's access ended or was not renewed in time)");
    expect(PAUSED_MODEL_TEXT).not.toMatch(/recreate/i);
  });

  it('the detail line says paused first and no "NO NEXT RUN"', () => {
    const line = triggerDetailLine({ effect: 'run_agent', status: 'open', last_run_status: 'stopped', last_run_result: 'x', paused_at: 1 });
    expect(line).toContain(`PAUSED — ${PAUSED_MODEL_TEXT}`);
    expect(line).not.toContain('NO NEXT RUN');
    // Without the pause, the same row reads as before.
    expect(triggerDetailLine({ effect: 'run_agent', status: 'open', last_run_status: 'failed', last_run_result: 'x' })).toContain('NO NEXT RUN');
  });

  it('task_list filters on paused and lists only paused plans', async () => {
    seed('a', true);
    seed('b', false);
    const out = await taskListTool.handler({ status: 'paused' }, agent());
    expect(out).toContain('Plan a');
    expect(out).not.toContain('Plan b');
    expect(out).toContain(PAUSED_MODEL_TEXT);
  });

  it("task_update by a mandate is refused before the plan is marked", async () => {
    seed('a', true);
    const before = marks('a');
    const out = await taskUpdateTool.handler({ task_id: 'a', title: 'Renamed' }, agent(MANDATE));
    expect(out).toContain(PAUSED_MODEL_TEXT);
    expect(marks('a')).toEqual(before);
    const done = await taskUpdateTool.handler({ task_id: 'a', status: 'completed' }, agent(MANDATE));
    expect(done).toContain(PAUSED_MODEL_TEXT);
    expect(marks('a')).toEqual(before);
  });

  it('the owner may complete it through the tool, not edit it', async () => {
    seed('a', true);
    expect(await taskUpdateTool.handler({ task_id: 'a', title: 'Renamed' }, agent())).toContain(PAUSED_MODEL_TEXT);
    expect(await taskUpdateTool.handler({ task_id: 'a', status: 'completed' }, agent())).toContain('Task completed');
  });

  it('the completed plan\'s model text, exactly, per case: the workflow\'s takeover first where it needs one, the condition where that is not known, and no takeover of the plan (U-275 N6)', () => {
    const base = "completed, and paused because the helper's access ended. It cannot be taken over or run again; if it should run again, offer to set up a new plan.";
    const refusal = "Error: this plan is completed, and paused because the helper's access ended. It cannot be changed, taken over or run again; if it should run again, offer to set up a new plan.";
    const its = ' Its workflow was created or last changed by someone whose access has ended: the owner first takes over that workflow, under "Workflows" with "Take over workflow".';
    const condition = ' If it runs a workflow that the person whose access ended created or last changed, the owner first takes over that workflow, under "Workflows" with "Take over workflow".';
    const workflow = { kind: 'workflow', workflowId: 'wf-1', name: 'Monatsbericht' } as const;
    expect(pausedDoneModelText(workflow)).toBe(base + its);
    expect(pausedDoneUpdateRefusal(workflow)).toBe(refusal + its);
    expect(pausedDoneModelText({ kind: 'none' })).toBe(base);
    expect(pausedDoneUpdateRefusal({ kind: 'none' })).toBe(refusal);
    expect(pausedDoneModelText({ kind: 'unknown' })).toBe(base + condition);
    expect(pausedDoneUpdateRefusal({ kind: 'unknown' })).toBe(refusal + condition);
    // The model never reads the workflow's name, and no text sends anyone to a takeover of the plan.
    for (const c of [workflow, { kind: 'none' } as const, { kind: 'unknown' } as const]) {
      for (const text of [pausedDoneModelText(c), pausedDoneUpdateRefusal(c)]) {
        expect(text).not.toContain('Monatsbericht');
        expect(text).not.toMatch(/takes? it over|until the owner/);
      }
    }
  });

  it('a completed plan that keeps its pause reads its own sentence in the detail line, task_list and task_update; an open one the takeover', async () => {
    const done = triggerDetailLine({ effect: 'run_agent', status: 'completed', last_run_status: 'success', last_run_result: 'x', paused_at: 1 });
    expect(done).toContain(`PAUSED — ${PAUSED_DONE_MODEL_TEXT}`);
    expect(done).not.toContain(PAUSED_MODEL_TEXT);
    // A stop that paused it stored the takeover sentence; completed since, it is read without it.
    const stopped = { effect: 'run_agent', last_run_status: 'stopped', last_run_result: ACCESS_ENDED_PAUSED_RESULT, paused_at: 1 };
    const doneStopped = triggerDetailLine({ ...stopped, status: 'completed' });
    expect(doneStopped).toContain(`: ${ACCESS_ENDED_RESULT}`);
    expect(doneStopped).not.toMatch(/takes it over/);
    expect(triggerDetailLine({ ...stopped, status: 'open' }), 'control: an open paused plan keeps it').toContain(ACCESS_ENDED_PAUSED_RESULT);
    // Taken over (no pause any more), the same stored stop no longer says the plan is paused.
    const takenOver = triggerDetailLine({ ...stopped, status: 'open', paused_at: undefined });
    expect(takenOver).toContain(`: ${ACCESS_ENDED_RESULT}`);
    expect(takenOver).not.toMatch(/takes it over/);
    seed('a', true);
    seed('b', true);
    engine.getDb().prepare("UPDATE triggers SET status = 'completed' WHERE id = 'a'").run();
    const list = await taskListTool.handler({ status: 'paused' }, agent());
    // One entry is its head line and the detail lines indented under it.
    const lineOf = (title: string): string => list.split(/\n(?=\S)/).find((l) => l.includes(title)) ?? '';
    expect(lineOf('Plan a')).toContain(PAUSED_DONE_MODEL_TEXT);
    expect(lineOf('Plan a')).not.toContain(PAUSED_MODEL_TEXT);
    expect(lineOf('Plan b')).toContain(PAUSED_MODEL_TEXT);
    for (const who of [agent(), agent(MANDATE)]) {
      expect(await taskUpdateTool.handler({ task_id: 'a', title: 'Renamed' }, who)).toBe(PAUSED_DONE_UPDATE_REFUSAL);
      expect(await taskUpdateTool.handler({ task_id: 'b', title: 'Renamed' }, who)).toBe(`Error: this plan is ${PAUSED_MODEL_TEXT}. It cannot be changed until then.`);
    }
  });

  it('a completed paused workflow plan reads its workflow\'s case in task_list, task_update and the completion line (U-275 N6)', async () => {
    const W = { kind: 'mandate' as const, email: 'wim@example.invalid', mandateId: 'G-W' };
    history.insertPlannedPipeline({ id: 'wf-w', name: 'FX-wim', goal: 'g', steps: [{ id: 's1', task: 't' }], reasoning: '', estimatedCost: 0, createdAt: '2026-01-01T00:00:00.000Z', template: true }, W);
    // W's access ended: a record with an end in the past.
    const nowS = Math.floor(Date.now() / 1000);
    new MandateEnds(engine.getDb()).record({ ...W, mandateExp: nowS - 3600 }, nowS - 7200);
    const wfPlan = (id: string): void => {
      history.insertTrigger({ id, title: `Plan ${id}`, source: 'cron', effect: 'run_workflow', pipelineId: 'wf-w', scheduleCron: '0 9 * * 1', nextRunAt: '2026-01-05T09:00:00.000Z', confirmedAt: '2026-01-01T00:00:00.000Z' });
      engine.getDb().prepare('UPDATE triggers SET paused_at = 1 WHERE id = ?').run(id);
    };
    wfPlan('w1');
    wfPlan('w2');
    engine.getDb().prepare("UPDATE triggers SET status = 'completed' WHERE id = 'w1'").run();
    const its = pausedDoneModelText({ kind: 'workflow', workflowId: 'wf-w', name: 'FX-wim' });
    expect(its).toContain(PAUSED_DONE_ITS_WORKFLOW_FIRST);
    const list = await taskListTool.handler({ status: 'paused' }, agent());
    const lineOf = (title: string): string => list.split(/\n(?=\S)/).find((l) => l.includes(title)) ?? '';
    expect(lineOf('Plan w1')).toContain(its);
    expect(await taskUpdateTool.handler({ task_id: 'w1', title: 'Renamed' }, agent())).toBe(pausedDoneUpdateRefusal({ kind: 'workflow', workflowId: 'wf-w', name: null }));
    // The owner completes the open one: its line already reads the case.
    expect(await taskUpdateTool.handler({ task_id: 'w2', status: 'completed' }, agent())).toContain(its);
    // The model never reads the workflow's name.
    expect(list).not.toContain('FX-wim');
  });

  it('a person with access reads her own way at a completed paused plan on another live person\'s workflow, in task_list and task_update; the owner the new plan (U-489)', async () => {
    const OTTO = { kind: 'mandate' as const, email: 'otto@example.invalid', mandateId: 'G-O' };
    history.insertPlannedPipeline({ id: 'wf-o', name: 'FX-otto', goal: 'g', steps: [{ id: 's1', task: 't' }], reasoning: '', estimatedCost: 0, createdAt: '2026-01-01T00:00:00.000Z', template: true }, OTTO);
    // Otto's access is live: a record with an end ahead.
    const nowS = Math.floor(Date.now() / 1000);
    new MandateEnds(engine.getDb()).record({ ...OTTO, mandateExp: nowS + 3600 }, nowS - 60);
    history.insertTrigger({ id: 'o1', title: 'Plan o1', source: 'cron', effect: 'run_workflow', pipelineId: 'wf-o', scheduleCron: '0 9 * * 1', nextRunAt: '2026-01-05T09:00:00.000Z', confirmedAt: '2026-01-01T00:00:00.000Z' });
    engine.getDb().prepare("UPDATE triggers SET paused_at = 1, status = 'completed' WHERE id = 'o1'").run();
    const foreign = { kind: 'foreign', workflowId: 'wf-o', name: null } as const;
    expect(await taskUpdateTool.handler({ task_id: 'o1', title: 'Renamed' }, agent(MANDATE))).toBe(pausedDoneUpdateRefusal(foreign));
    const list = await taskListTool.handler({ status: 'paused' }, agent(MANDATE));
    expect(list).toContain(pausedDoneModelText(foreign));
    expect(list).not.toContain('FX-otto');
    // CONTROL: the owner may plan on any workflow, so a new plan is the owner's way, in both.
    expect(await taskUpdateTool.handler({ task_id: 'o1', title: 'Renamed' }, agent())).toBe(pausedDoneUpdateRefusal({ kind: 'none' }));
    const ownerList = await taskListTool.handler({ status: 'paused' }, agent());
    expect(ownerList).toContain(pausedDoneModelText({ kind: 'none' }));
    expect(ownerList).not.toContain(pausedDoneModelText(foreign));
  });

  it('with the switch off a paused_at is not read', async () => {
    restore();
    restore = setPlanPauseForTests(false);
    seed('a', true);
    expect(await taskUpdateTool.handler({ task_id: 'a', title: 'Renamed' }, agent())).toContain('Task updated');
    expect(triggerDetailLine({ effect: 'run_agent', paused_at: 1 })).not.toContain('PAUSED');
    // Nor filtered on: a `paused_at` left from a time with the switch on lists nothing as paused.
    seed('c', true);
    const listed = await taskListTool.handler({ status: 'paused' }, agent());
    expect(listed).not.toContain('Plan c');
    // The same row is listed without the filter: the assert above reads the list it would be in.
    expect(await taskListTool.handler({}, agent())).toContain('Plan c');
  });
});
