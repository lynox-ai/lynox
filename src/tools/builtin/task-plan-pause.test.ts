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
import { PAUSED_MODEL_TEXT, setPlanPauseForTests } from '../../core/plan-pause.js';

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
    expect(PAUSED_MODEL_TEXT).toBe("paused until the owner takes it over (the helper's access ended or was not renewed in time; takeover is not available yet, the owner can delete the plan)");
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
