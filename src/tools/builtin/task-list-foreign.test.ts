import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from '../../core/run-history.js';
import { EngineDb } from '../../core/engine-db.js';
import { TaskManager } from '../../core/task-manager.js';
import { taskListTool, taskUpdateTool } from './task.js';
import type { IAgent } from '../../types/index.js';
import { createToolContext } from '../../core/tool-context.js';
import { testAuditLog } from '../../../tests/helpers/audit-log.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from '../../core/request-principal.js';

/**
 * What a mandate's chat reads of the schedules another mandate set up or changed (`task_list`):
 * the schedule, without the values it binds — as the trigger list answers the same mandate.
 */

const IDA: RequestPrincipal = { kind: 'mandate', email: 'ida@example.invalid', mandateId: 'G-IDA' };
const OLE: RequestPrincipal = { kind: 'mandate', email: 'ole@example.invalid', mandateId: 'G-OLE' };

describe('task_list shows a mandate another mandate\'s schedules without their values', () => {
  let dir: string;
  let history: RunHistory;
  let engine: EngineDb;
  let tm: TaskManager;

  const agent = (principal: RequestPrincipal): IAgent => {
    const ctx = createToolContext({});
    ctx.taskManager = tm;
    ctx.runHistory = history;
    ctx.auditLog = testAuditLog().log;
    return { name: 't', model: 'm', memory: null, tools: [], onStream: null, activeScopes: undefined, toolContext: ctx, principal } as IAgent;
  };
  const seed = (id: string, params: string, createdBy: string, createdMandateId?: string): void => {
    history.insertTrigger({
      id, title: `Plan ${id}`, source: 'cron', effect: 'run_workflow', scheduleCron: '0 9 * * 1', nextRunAt: '2026-01-05T09:00:00.000Z',
      pipelineParams: params, createdBy, ...(createdMandateId !== undefined ? { createdMandateId } : {}),
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-task-list-foreign-'));
    history = new RunHistory(join(dir, 'h.db'));
    engine = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engine);
    tm = new TaskManager(history);
    seed('t-owner', '{"region":"owner-value"}', 'owner');
    seed('t-ida', '{"region":"ida-value"}', 'mandate:ida@example.invalid', 'G-IDA');
    seed('t-ole', '{"region":"ole-value"}', 'mandate:ole@example.invalid', 'G-OLE');
  });
  afterEach(() => {
    try { engine.close(); } catch { /* already closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists every schedule to a mandate, with its own and the owner\'s values, and none of another mandate\'s', async () => {
    const out = await taskListTool.handler({}, agent(IDA));
    for (const title of ['Plan t-owner', 'Plan t-ida', 'Plan t-ole']) expect(out).toContain(title);
    expect(out).toContain('ida-value');
    expect(out).toContain('owner-value');
    expect(out).not.toContain('ole-value');
  });

  it('lists a mandate its own schedule with its values after another mandate changed it', async () => {
    tm.markEditedBy('t-ida', OLE, true);
    const out = await taskListTool.handler({}, agent(IDA));
    expect(out).toContain('ida-value');
    expect(out).not.toContain('ole-value');
  });

  it('reports a mandate\'s change or completion of another mandate\'s schedule without its values', async () => {
    const updated = await taskUpdateTool.handler({ task_id: 't-ole', title: 'Renamed by ida' }, agent(IDA));
    expect(updated).toContain('Task updated');
    expect(updated).toContain('Renamed by ida');
    expect(updated).not.toContain('ole-value');
    const completed = await taskUpdateTool.handler({ task_id: 't-ole', status: 'completed' }, agent(IDA));
    expect(completed).toContain('Task completed');
    expect(completed).not.toContain('ole-value');
    // The positive control: the owner's report of the same change names the values.
    const byOwner = await taskUpdateTool.handler({ task_id: 't-owner', title: 'Renamed by owner' }, agent(OWNER_PRINCIPAL));
    expect(byOwner).toContain('owner-value');
  });

  it('lists every value to the owner', async () => {
    const out = await taskListTool.handler({}, agent(OWNER_PRINCIPAL));
    for (const value of ['owner-value', 'ida-value', 'ole-value']) expect(out).toContain(value);
  });
});
