import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { taskListTool, taskUpdateTool } from '../tools/builtin/task.js';
import type { IAgent } from '../types/index.js';
import { createToolContext } from './tool-context.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import { lastRunResultFor, memberNotesRepeat } from './member-connection-notes.js';
import { WORKER_NOTICES } from './worker-notices.js';
import { noticeLanguage } from './notice-language.js';
import { loadConfig } from './config.js';
import { triggerForRoute, rowForRoute } from '../server/http-api.js';
import { testAuditLog } from '../../tests/helpers/audit-log.js';

/**
 * A run's end with member-connection lines, as each reader reads it. The lines name another
 * member, their provider and profile; the result is the model's reply, which the refusal it read
 * tells to name them too. The owner reads both; anyone else reads a fixed sentence instead.
 */

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'ida@example.invalid', mandateId: 'G-1' };
const LINE = 'The plan "Weekly" did not use Shopify (profile shop-jo). jo@kanzlei.example set it up with their own login.';
const REPLY = 'I could not reach Shopify: jo@kanzlei.example set up profile shop-jo with their own login.';

describe("a run's end with member lines, by reader", () => {
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
  const seed = (id: string): void => {
    history.insertTrigger({ id, title: `Plan ${id}`, source: 'cron', effect: 'run_agent', scheduleCron: '0 9 * * 1', nextRunAt: '2026-01-05T09:00:00.000Z', confirmedAt: '2026-01-01T00:00:00.000Z' });
  };
  const stored = (id: string): { last_run_result: string | null; last_run_member_notes: string | null } =>
    engine.getDb().prepare('SELECT last_run_result, last_run_member_notes FROM triggers WHERE id = ?').get(id) as { last_run_result: string | null; last_run_member_notes: string | null };
  const forMandatesHere = (): string => WORKER_NOTICES[noticeLanguage(loadConfig().language)].memberEndForMandates;
  const forMandatesTool = (): string => WORKER_NOTICES[noticeLanguage(undefined)].memberEndForMandates;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-run-result-readers-'));
    history = new RunHistory(join(dir, 'h.db'));
    engine = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engine);
    tm = new TaskManager(history);
  });
  afterEach(() => {
    try { engine.close(); } catch { /* already closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores the lines apart from the result, and a later end without lines clears them', () => {
    seed('a');
    tm.recordTaskRun('a', REPLY, 'halted', { memberNotes: [LINE] });
    expect(stored('a')).toEqual({ last_run_result: REPLY, last_run_member_notes: JSON.stringify([LINE]) });
    expect(history.getTrigger('a')?.last_run_member_notes).toEqual([LINE]);
    tm.recordTaskRun('a', 'All done.', 'success');
    expect(stored('a')).toEqual({ last_run_result: 'All done.', last_run_member_notes: null });
    expect(history.getTrigger('a')?.last_run_member_notes).toBeUndefined();
  });

  it('a repeat is read off the stored lines', () => {
    seed('a');
    tm.recordTaskRun('a', REPLY, 'halted', { memberNotes: [LINE] });
    const row = history.getTrigger('a')!;
    expect(memberNotesRepeat(row, [LINE])).toBe(true);
    expect(memberNotesRepeat(row, ['another line'])).toBe(false);
  });

  it('lastRunResultFor: the owner reads result and lines, anyone else the sentence; without lines both read the result', () => {
    const row = { last_run_result: REPLY, last_run_member_notes: [LINE] };
    expect(lastRunResultFor(row, true, 'S')).toBe(`${REPLY}\n• ${LINE}`);
    expect(lastRunResultFor(row, false, 'S')).toBe('S');
    expect(lastRunResultFor({ last_run_result: REPLY }, false, 'S')).toBe(REPLY);
    expect(lastRunResultFor({ last_run_result: REPLY }, true, 'S')).toBe(REPLY);
  });

  it('the trigger routes: the owner reads the lines under the result, a mandate the sentence, neither the column', () => {
    seed('a');
    tm.recordTaskRun('a', REPLY, 'halted', { memberNotes: [LINE] });
    const row = history.getTrigger('a')!;
    const owner = triggerForRoute(row, OWNER_PRINCIPAL) as Record<string, unknown>;
    expect(owner['last_run_result']).toBe(`${REPLY}\n• ${LINE}`);
    expect(owner).not.toHaveProperty('last_run_member_notes');
    const mandate = triggerForRoute(row, MANDATE) as Record<string, unknown>;
    expect(mandate['last_run_result']).toBe(forMandatesHere());
    expect(JSON.stringify(mandate)).not.toContain('jo@kanzlei.example');
    expect(JSON.stringify(mandate)).not.toContain('shop-jo');
    expect(mandate).not.toHaveProperty('last_run_member_notes');
    // The task routes answer a trigger through the same shaping.
    expect((rowForRoute(row, MANDATE) as Record<string, unknown>)['last_run_result']).toBe(forMandatesHere());
    expect((rowForRoute(row, OWNER_PRINCIPAL) as Record<string, unknown>)['last_run_result']).toBe(`${REPLY}\n• ${LINE}`);
  });

  it('task_list: the owner reads the lines, a mandate the sentence and neither the name nor the profile', async () => {
    seed('a');
    tm.recordTaskRun('a', REPLY, 'halted', { memberNotes: [LINE] });
    const owner = await taskListTool.handler({}, agent(OWNER_PRINCIPAL));
    expect(owner).toContain('jo@kanzlei.example');
    expect(owner).toContain('shop-jo');
    const mandate = await taskListTool.handler({}, agent(MANDATE));
    expect(mandate).toContain('Plan a');
    expect(mandate).toContain(forMandatesTool());
    expect(mandate).not.toContain('jo@kanzlei.example');
    expect(mandate).not.toContain('shop-jo');
  });

  it('task_update, also as completion: a mandate reads the sentence on the row it acted on, the owner the lines', async () => {
    seed('a');
    seed('b');
    tm.recordTaskRun('a', REPLY, 'halted', { memberNotes: [LINE] });
    tm.recordTaskRun('b', REPLY, 'halted', { memberNotes: [LINE] });
    const updated = await taskUpdateTool.handler({ task_id: 'a', title: 'Renamed' }, agent(MANDATE));
    expect(updated).toContain(forMandatesTool());
    expect(updated).not.toContain('jo@kanzlei.example');
    const completed = await taskUpdateTool.handler({ task_id: 'b', status: 'completed' }, agent(MANDATE));
    expect(completed).not.toContain('jo@kanzlei.example');
    expect(completed).not.toContain('shop-jo');
    const byOwner = await taskUpdateTool.handler({ task_id: 'a', title: 'Renamed again' }, agent(OWNER_PRINCIPAL));
    expect(byOwner).toContain('jo@kanzlei.example');
  });
});
