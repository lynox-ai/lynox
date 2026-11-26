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
import { OWNER_PRINCIPAL, type RequestPrincipal } from '../../core/request-principal.js';
import { ACCESS_ENDED_PAUSED_RESULT, ACCESS_ENDED_RESULT, PAUSED_DONE_MODEL_TEXT, PAUSED_DONE_UPDATE_REFUSAL, PAUSED_MODEL_TEXT, setPlanPauseForTests } from '../../core/plan-pause.js';

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

  it('the completed plan\'s model text, exactly, offers a new plan after the workflow\'s takeover where it needs one, and no takeover of the plan (U-275)', () => {
    expect(PAUSED_DONE_MODEL_TEXT).toBe("completed, and paused because the helper's access ended. It cannot be taken over or run again; if it should run again, offer to set up a new plan. If it runs a workflow that the person with this access created or last changed, that workflow has to be taken over first, under \"Workflows\" with \"Take over workflow\".");
    expect(PAUSED_DONE_UPDATE_REFUSAL).toBe("Error: this plan is completed, and paused because the helper's access ended. It cannot be changed, taken over or run again; if it should run again, offer to set up a new plan. If it runs a workflow that the person with this access created or last changed, that workflow has to be taken over first, under \"Workflows\" with \"Take over workflow\".");
    for (const text of [PAUSED_DONE_MODEL_TEXT, PAUSED_DONE_UPDATE_REFUSAL]) expect(text).not.toMatch(/takes? it over|until the owner/);
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
