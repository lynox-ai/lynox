import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { ownerInstructionCounts, type RequestPrincipal } from './request-principal.js';
import { recipientConfirmDigest, recipientsConfirmable } from './recipient-confirm.js';
import { taskUpdateTool } from '../tools/builtin/task.js';
import { createToolContext } from './tool-context.js';
import { testAuditLog } from '../../tests/helpers/audit-log.js';
import type { IAgent } from '../types/index.js';

/** "Confirm recipients" on the store: what it writes, what it refuses, and what undoes it. */

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'h@x.ch', mandateId: 'g-1' };

describe('confirming a trigger\'s recipients', () => {
  let dir: string;
  let history: RunHistory;
  let engine: EngineDb;
  let tm: TaskManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-recipients-'));
    history = new RunHistory(join(dir, 'history.db'));
    engine = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engine);
    tm = new TaskManager(history);
  });
  afterEach(() => {
    try { engine.close(); } catch { /* closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const legacy = (extra: Record<string, unknown> = {}): string => {
    history.insertTrigger({ id: 'old-1', title: 'Bericht', description: 'an anna@firma.ch', effect: 'run_agent', confirmedAt: '2026-01-01T00:00:00.000Z', ...extra });
    return 'old-1';
  };
  const row = (): Record<string, unknown> => engine.getDb().prepare('SELECT * FROM triggers WHERE id = ?').get('old-1') as Record<string, unknown>;
  const counts = (): boolean => ownerInstructionCounts(history.getTrigger('old-1')!);
  const digest = (): string => recipientConfirmDigest(history.getTrigger('old-1')!);

  it('records the owner as the creator, and nothing else changes', () => {
    const id = legacy();
    const before = row();
    expect(counts(), 'positive control: before, the instruction is not the owner\'s').toBe(false);
    expect(history.confirmTriggerRecipients(id, digest())).toBe('confirmed');
    const after = row();
    expect(after['created_by']).toBe('owner');
    for (const k of Object.keys(before)) if (k !== 'created_by') expect(after[k], k).toEqual(before[k]);
    expect(counts()).toBe(true);
  });

  it('an instruction changed since the owner was shown it is not confirmed', () => {
    const id = legacy();
    const shown = digest();
    tm.update(id, { description: 'an x@evil.example' });
    expect(history.confirmTriggerRecipients(id, shown)).toBe('changed');
    expect(row()['created_by']).toBeNull();
  });

  it('one set up after outside content stays foreign: it cannot be confirmed', () => {
    const id = legacy({ createdUntrusted: 'external-tool' });
    expect(recipientsConfirmable(history.getTrigger(id)!)).toBe(false);
    expect(history.confirmTriggerRecipients(id, digest())).toBe('not_confirmable');
    expect(row()['created_by']).toBeNull();
    expect(counts()).toBe(false);
  });

  it('one a mandate changed, or a run changed last, cannot be confirmed', () => {
    const id = legacy();
    tm.markEditedBy(id, MANDATE, false);
    expect(history.confirmTriggerRecipients(id, digest())).toBe('not_confirmable');
    tm.markEditedByRun(id, 'trigger:t-9');
    expect(recipientsConfirmable(history.getTrigger(id)!)).toBe(false);
  });

  it('a mandate\'s change stays, even after the owner changed it last', () => {
    const id = legacy();
    tm.markEditedBy(id, MANDATE, false);
    // The owner's later change is the last one; the mandate's mark is never cleared by it.
    engine.getDb().prepare(`UPDATE triggers SET edited_by = 'owner' WHERE id = ?`).run(id);
    expect(row()['mandate_editor'], 'positive control: the mandate\'s mark is on the row').not.toBeNull();
    expect(recipientsConfirmable(history.getTrigger(id)!)).toBe(false);
    expect(history.confirmTriggerRecipients(id, digest())).toBe('not_confirmable');
    expect(row()['created_by']).toBeNull();
  });

  describe('a later change by anyone but the owner makes it foreign again', () => {
    const agentOf = (principal: RequestPrincipal, writeAuthor: string | null): IAgent => {
      const ctx = createToolContext({});
      ctx.taskManager = tm;
      ctx.runHistory = history;
      ctx.auditLog = testAuditLog().log;
      return { name: 't', model: 'm', memory: null, tools: [], onStream: null, toolContext: ctx, principal, writeAuthor } as unknown as IAgent;
    };
    const confirmed = (): string => {
      const id = legacy();
      expect(history.confirmTriggerRecipients(id, digest())).toBe('confirmed');
      expect(counts(), 'positive control: confirmed').toBe(true);
      return id;
    };

    it.each([
      ['a mandate\'s change over HTTP (the route marks it)', (id: string) => { tm.markEditedBy(id, MANDATE, true); }],
      ['a mandate\'s task_update', async (id: string) => { await taskUpdateTool.handler({ task_id: id, description: 'an x@evil.example' }, agentOf(MANDATE, 'mandate:h@x.ch')); }],
      ['a trigger\'s run task_update', async (id: string) => { await taskUpdateTool.handler({ task_id: id, description: 'an x@evil.example' }, agentOf({ kind: 'owner' }, 'trigger:t-1')); }],
      ['a workflow run\'s task_update with no recorded author', async (id: string) => { await taskUpdateTool.handler({ task_id: id, title: 'Bericht 2' }, agentOf({ kind: 'owner' }, null)); }],
    ])('%s', async (_l, change) => {
      const id = confirmed();
      await change(id);
      expect(counts()).toBe(false);
    });

    it('CONTROL: the owner\'s own change keeps it the owner\'s', async () => {
      const id = confirmed();
      await taskUpdateTool.handler({ task_id: id, description: 'an anna@firma.ch, jeden Montag' }, agentOf({ kind: 'owner' }, 'owner'));
      expect(counts()).toBe(true);
    });
  });
});
