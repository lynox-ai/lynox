import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
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
import { triggerDbRowToRecord } from './trigger-store.js';
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

  it('a run that keeps its schedule (a hand run, a webhook, a pause) also clears the lines of the run before', () => {
    seed('a');
    tm.recordTaskRun('a', REPLY, 'halted', { memberNotes: [LINE], keepSchedule: true });
    expect(stored('a')).toEqual({ last_run_result: REPLY, last_run_member_notes: JSON.stringify([LINE]) });
    tm.recordTaskRun('a', 'All done.', 'success', { keepSchedule: true });
    expect(stored('a')).toEqual({ last_run_result: 'All done.', last_run_member_notes: null });
  });

  it('the migration splits a result recorded with its lines: the owner reads it as before, a mandate the sentence', () => {
    // A database from before: the column and its version taken back out, a result with its lines under it.
    const path = join(dir, 'old.db');
    new EngineDb(path, '').close();
    const raw = new Database(path);
    const legacy = `${REPLY}\n• ${LINE}\n• Another line.`;
    raw.exec('ALTER TABLE triggers DROP COLUMN last_run_member_notes; DELETE FROM schema_version WHERE version >= 71;');
    raw.prepare("INSERT INTO triggers (id, title, source, effect, last_run_result, last_run_status) VALUES ('old', 'Old', 'cron', 'run_agent', ?, 'halted')").run(legacy);
    const listed = 'Done:\n• first item\n• second item';
    const failedWithList = `Found:\n• one\n• ${LINE}`;
    const insert = raw.prepare('INSERT INTO triggers (id, title, source, effect, last_run_result, last_run_status) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('plain', 'Plain', 'cron', 'run_agent', 'All done.', 'success');
    insert.run('listed', 'Listed', 'cron', 'run_agent', listed, 'success');
    insert.run('failed', 'Failed', 'cron', 'run_agent', failedWithList, 'failed');
    insert.run('headless', 'Headless', 'cron', 'run_agent', `\n• ${LINE}`, 'halted');
    insert.run('none', 'None', 'cron', 'run_agent', null, null);
    insert.run('unstated', 'Unstated', 'cron', 'run_agent', `${REPLY}\n• ${LINE}`, null);
    raw.close();
    const migrated = new EngineDb(path, '');
    const rows = migrated.getDb().prepare('SELECT id, last_run_result, last_run_member_notes FROM triggers ORDER BY id').all();
    migrated.close();
    expect(rows).toEqual([
      { id: 'failed', last_run_result: 'Found:', last_run_member_notes: JSON.stringify([`one\n• ${LINE}`]) },
      { id: 'headless', last_run_result: '', last_run_member_notes: JSON.stringify([LINE]) },
      // A success never carries lines: its own list stays where it is.
      { id: 'listed', last_run_result: listed, last_run_member_notes: null },
      { id: 'none', last_run_result: null, last_run_member_notes: null },
      { id: 'old', last_run_result: REPLY, last_run_member_notes: JSON.stringify([`${LINE}\n• Another line.`]) },
      { id: 'plain', last_run_result: 'All done.', last_run_member_notes: null },
      // No status says success: split, the side that hides.
      { id: 'unstated', last_run_result: REPLY, last_run_member_notes: JSON.stringify([LINE]) },
    ]);
    // Read back as the routes read it: the owner the text as it was stored, a mandate the sentence.
    const reopened = new EngineDb(path, '');
    try {
      const read = (id: string): Record<string, unknown> => {
        const row = reopened.getDb().prepare(`SELECT * FROM triggers WHERE id = ?`).get(id) as Parameters<typeof triggerDbRowToRecord>[0];
        return triggerForRoute(triggerDbRowToRecord(row), OWNER_PRINCIPAL) as Record<string, unknown>;
      };
      const readAsMandate = (id: string): Record<string, unknown> => {
        const row = reopened.getDb().prepare(`SELECT * FROM triggers WHERE id = ?`).get(id) as Parameters<typeof triggerDbRowToRecord>[0];
        return triggerForRoute(triggerDbRowToRecord(row), MANDATE) as Record<string, unknown>;
      };
      expect(read('old')['last_run_result']).toBe(legacy);
      expect(read('failed')['last_run_result']).toBe(failedWithList);
      expect(read('headless')['last_run_result']).toBe(`\n• ${LINE}`);
      expect(read('listed')['last_run_result']).toBe(listed);
      for (const id of ['old', 'failed', 'headless']) expect(readAsMandate(id)['last_run_result']).toBe(forMandatesHere());
      expect(readAsMandate('listed')['last_run_result']).toBe(listed);
      expect(readAsMandate('unstated')['last_run_result']).toBe(forMandatesHere());
    } finally { reopened.close(); }
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
    expect(owner).toContain(`• ${LINE}`);
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
    expect(completed).toContain(forMandatesTool());
    expect(completed).not.toContain('jo@kanzlei.example');
    expect(completed).not.toContain('shop-jo');
    const byOwner = await taskUpdateTool.handler({ task_id: 'a', title: 'Renamed again' }, agent(OWNER_PRINCIPAL));
    expect(byOwner).toContain(`• ${LINE}`);
  });
});
