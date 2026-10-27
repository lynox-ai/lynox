/**
 * The containment record (`containment.ts`, engine.db v40): its table on a fresh and on an
 * upgraded database, written once and never changed, read fail-closed; a bulk run contained in
 * the transaction that inserts it, from its planning chat or from the run it undoes; and the
 * memory guards and the end-of-turn capture that read it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { BulkLedger, type PlannedTarget } from './bulk-ledger.js';
import { runBulkEffect, type TargetWriter } from './bulk-apply.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { Containment, chatIsContained, containedRefusal, threadIsContained } from './containment.js';
import { createToolContext } from './tool-context.js';
import { bulkPlanTool } from '../tools/builtin/bulk.js';

const CP_ENV = {
  LYNOX_MANAGED_CONTROL_PLANE_URL: 'https://cp.example.invalid',
  LYNOX_MANAGED_INSTANCE_ID: 'inst-1',
  LYNOX_HTTP_SECRET: 's',
};

let dir: string;
let engineDb: EngineDb;
let containment: Containment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-contained-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), '');
  containment = new Containment(engineDb.getDb(), null);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const rows = (db: Database.Database = engineDb.getDb()): { container_kind: string; container_id: string; kind: string; connection_id: string }[] =>
  db.prepare('SELECT container_kind, container_id, kind, connection_id FROM contained ORDER BY container_kind, container_id, connection_id').all() as never;

describe('the contained table (v40)', () => {
  it('exists on a fresh database', () => {
    expect(rows()).toEqual([]);
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    expect(rows()).toEqual([{ container_kind: 'thread', container_id: 't1', kind: 'api', connection_id: 'shop-acme' }]);
  });

  it('is created on a database upgraded from v39, which keeps its rows', () => {
    const path = join(dir, 'old.db');
    new EngineDb(path, '').close();
    const raw = new Database(path);
    raw.exec(`DELETE FROM schema_version WHERE version >= 40; DROP INDEX IF EXISTS idx_audit_log_plan_run; ALTER TABLE audit_log DROP COLUMN trail_form; ALTER TABLE audit_log DROP COLUMN plan_run; ALTER TABLE bulk_targets DROP COLUMN unknown_sends; ALTER TABLE bulk_runs DROP COLUMN list_last_id; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events; ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent; ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id; DROP TRIGGER contained_written_once; DROP TABLE contained;
      INSERT INTO exact_marker (id, first_ok_at) VALUES (1, '2026-10-01 00:00:00');`);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'contained'").get()).toBeUndefined();
    raw.close();
    const e = new EngineDb(path, '');
    try {
      expect((e.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(56);
      expect(e.exactMarkerSet()).toBe(true);
      const c = new Containment(e.getDb(), null);
      c.contain({ kind: 'bulk_run', id: 'r1' }, { kind: 'api', connectionId: 'shop-acme' });
      expect(c.isContained({ bulkRunId: 'r1' })).toBe(true);
      expect(() => e.getDb().prepare("UPDATE contained SET connection_id = 'x'").run()).toThrow(/written once/);
    } finally {
      e.close();
    }
  });

  it('keeps the first stamp: a second contain is no new row, and no UPDATE gets through', () => {
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    // Backdated around the trigger, as an old row would be: the trigger is dropped and put back.
    const db = engineDb.getDb();
    db.exec("DROP TRIGGER contained_written_once; UPDATE contained SET first_at = '2026-01-01 00:00:00'; CREATE TRIGGER contained_written_once BEFORE UPDATE ON contained BEGIN SELECT RAISE(ABORT, 'contained rows are written once'); END;");
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM contained').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT first_at FROM contained').get()).toEqual({ first_at: '2026-01-01 00:00:00' });
    expect(() => db.prepare("UPDATE contained SET first_at = datetime('now')").run()).toThrow(/written once/);
    expect(() => db.prepare("UPDATE contained SET container_id = 't2'").run()).toThrow(/written once/);
    // A second connection of the same thread is a row of its own.
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-other' });
    expect(rows().map((r) => r.connection_id)).toEqual(['shop-acme', 'shop-other']);
  });

  it('the store has no way to remove or change a row, and no source file deletes or updates one', () => {
    expect(Object.getOwnPropertyNames(Containment.prototype).sort()).toEqual(['canContain', 'constructor', 'contain', 'containFromThread', 'containedThreadIds', 'engine', 'holds', 'isContained']);
    const SRC = fileURLToPath(new URL('..', import.meta.url));
    const sources = (d: string): string[] => readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? sources(p) : n.endsWith('.ts') && !n.endsWith('.test.ts') ? [p] : [];
    });
    const writers = sources(SRC)
      .filter((p) => /\b(DELETE\s+FROM|UPDATE|INSERT\s+(OR\s+\w+\s+)?INTO)\s+contained\b/i.test(readFileSync(p, 'utf-8')))
      .map((p) => relative(SRC, p).replace(/\\/g, '/'));
    // Only the module itself writes the table, and only by INSERT.
    expect(writers).toEqual(['core/containment.ts']);
    const own = readFileSync(join(SRC, 'core/containment.ts'), 'utf-8');
    expect(own).not.toMatch(/\b(DELETE\s+FROM|UPDATE)\s+contained\b/i);
    // history.db's copy (`history-markers.ts`): written by INSERT in that module alone.
    const mirrorWriters = sources(SRC)
      .filter((p) => /\b(DELETE\s+FROM|UPDATE|INSERT\s+(OR\s+\w+\s+)?INTO)\s+(contained_threads|exact_marker_mirror)\b/i.test(readFileSync(p, 'utf-8')))
      .map((p) => relative(SRC, p).replace(/\\/g, '/'));
    expect(mirrorWriters).toEqual(['core/history-markers.ts']);
    expect(readFileSync(join(SRC, 'core/history-markers.ts'), 'utf-8')).not.toMatch(/\b(DELETE\s+FROM|UPDATE)\s+(contained_threads|exact_marker_mirror)\b/i);
  });
});

describe('isContained reads fail-closed', () => {
  it('a thread or a run with a row is contained, one without is not (control)', () => {
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    containment.contain({ kind: 'bulk_run', id: 'r1' }, { kind: 'api', connectionId: 'shop-acme' });
    expect(containment.isContained({ threadId: 't1' })).toBe(true);
    expect(containment.isContained({ bulkRunId: 'r1' })).toBe(true);
    expect(containment.isContained({ threadId: 't2' })).toBe(false);
    expect(containment.isContained({ bulkRunId: 'r2' })).toBe(false);
    // The kinds do not cross: a run id is not a thread id.
    expect(containment.isContained({ threadId: 'r1' })).toBe(false);
    expect(containment.isContained({ threadId: 't2', bulkRunId: 'r1' })).toBe(true);
  });

  it('no key is contained', () => {
    expect(containment.isContained({})).toBe(true);
    expect(containment.isContained({ threadId: '', bulkRunId: '' })).toBe(true);
  });

  it('a store that throws is contained', () => {
    const throwing = new Containment({ prepare: () => { throw new Error('disk I/O error'); } } as never, null);
    expect(throwing.isContained({ threadId: 't2' })).toBe(true);
    // A closed database too.
    const e = new EngineDb(join(dir, 'closed.db'), '');
    const c = new Containment(e.getDb(), null);
    e.close();
    expect(c.isContained({ threadId: 't2' })).toBe(true);
  });

  it('without a store: contained on a provisioned instance, not elsewhere', () => {
    expect(threadIsContained(null, 't1')).toBe(false);
    for (const [k, v] of Object.entries(CP_ENV)) vi.stubEnv(k, v);
    expect(threadIsContained(null, 't1')).toBe(true);
  });

  it('without a store: contained on a provisioned instance whose control-plane env is incomplete', () => {
    // A billing tier marks the instance provisioned; no control-plane URL or secret this boot.
    vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
    expect(threadIsContained(null, 't1')).toBe(true);
  });
});

function agentIn(thread: { current?: string; origin?: string }, store: Containment | null = containment): never {
  const toolContext = createToolContext({});
  toolContext.containment = store;
  return { currentThreadId: thread.current, originThreadId: thread.origin, toolContext, principal: OWNER_PRINCIPAL } as never;
}

describe('the memory guards read the record', () => {
  it('refuse in a contained chat and in a child spawned from it, and not in another chat (control)', async () => {
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    expect(containedRefusal(agentIn({ current: 't1' }))).toMatch(/^Not stored: this chat has read data through a store connection/);
    // A spawn_agent child or a workflow step: no thread of its own, the chat it runs for.
    expect(containedRefusal(agentIn({ origin: 't1' }))).not.toBeNull();
    expect(containedRefusal(agentIn({ current: 't2' }))).toBeNull();
    expect(containedRefusal(agentIn({}))).toBeNull();
    expect(chatIsContained(agentIn({ current: 't1' }))).toBe(true);
  });

  it('a store that throws refuses', () => {
    const throwing = new Containment({ prepare: () => { throw new Error('disk I/O error'); } } as never, null);
    // The same answer stands for a record that cannot be read, so it does not claim the chat read the store.
    expect(containedRefusal(agentIn({ current: 't2' }, throwing))).toMatch(/^Not stored: this chat has read data through a store connection, or this engine cannot read whether it has, /);
  });

  it('remember, memory_store and memory_update answer with it before they look at anything else', async () => {
    const { rememberTool, memoryBlockEditTool } = await import('../tools/builtin/knowledge.js');
    const { memoryStoreTool, memoryUpdateTool } = await import('../tools/builtin/memory.js');
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    // The thread's private flag is off: the guard reads the containment record, not the flag.
    const threadStore = { getThread: () => ({ skip_extraction: 0 }) };
    for (const thread of [{ current: 't1' }, { origin: 't1' }]) {
      const agent = agentIn(thread) as unknown as { toolContext: { threadStore: unknown } };
      agent.toolContext.threadStore = threadStore;
      const answers = await Promise.all([
        rememberTool.handler({ text: 'x' } as never, agent as never),
        memoryBlockEditTool.handler({ block: 'profile', mode: 'append', new_text: 'x' } as never, agent as never),
        memoryStoreTool.handler({ namespace: 'knowledge', content: 'x' } as never, agent as never),
        memoryUpdateTool.handler({ namespace: 'knowledge', old_content: 'x', new_content: 'y' } as never, agent as never),
      ]);
      for (const a of answers) expect(a).toMatch(/^Not stored: this chat has read data through a store connection/);
    }
    // Control: another chat gets past the guard to the next check.
    const other = agentIn({ current: 't2' }) as unknown as { toolContext: { threadStore: unknown } };
    other.toolContext.threadStore = threadStore;
    expect(await rememberTool.handler({ text: 'x' } as never, other as never)).toBe('Durable memory is not enabled for this agent.');
  });

  it('every caller of privateThreadRefusal asks containedRefusal first, in the same expression', () => {
    const SRC = fileURLToPath(new URL('..', import.meta.url));
    let calls = 0;
    for (const f of ['tools/builtin/memory.ts', 'tools/builtin/knowledge.ts']) {
      for (const line of readFileSync(join(SRC, f), 'utf-8').split('\n')) {
        if (!/privateThreadRefusal\(agent\)/.test(line) || /^\s*(import|\*|\/\/)/.test(line)) continue;
        calls++;
        expect(line, `${f}: ${line.trim()}`).toMatch(/containedRefusal\(agent\) \?\? privateThreadRefusal\(agent\)/);
      }
    }
    expect(calls).toBe(5);
  });
});

describe('a bulk run is contained at its insert', () => {
  let ledger: BulkLedger;
  beforeEach(() => { ledger = new BulkLedger(engineDb, null); });

  const targets = (): PlannedTarget[] => [0, 1].map((i) => ({ key: `k${String(i)}`, before: { absent: false, value: `v${String(i)}` }, after: `w${String(i)}` }));

  it('planned in a contained chat: contained for the same connections, in one transaction with the run', () => {
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-other' });
    const run = ledger.recordDryRun({ createdBy: 't1', planningThread: 't1', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'mem', targets: targets() });
    expect(rows().filter((r) => r.container_kind === 'bulk_run')).toEqual([
      { container_kind: 'bulk_run', container_id: run.id, kind: 'api', connection_id: 'shop-acme' },
      { container_kind: 'bulk_run', container_id: run.id, kind: 'api', connection_id: 'shop-other' },
    ]);
    // Control: a run planned in another chat is not contained.
    const free = ledger.recordDryRun({ createdBy: 't2', planningThread: 't2', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'mem', targets: targets() });
    expect(containment.isContained({ bulkRunId: free.id })).toBe(false);
  });

  it('a containment that cannot be read plans no run at all', () => {
    engineDb.getDb().exec('DROP TRIGGER contained_written_once; DROP TABLE contained;');
    expect(() => ledger.recordDryRun({ createdBy: 't1', planningThread: 't1', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'mem', targets: targets() })).toThrow();
    expect(engineDb.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_runs').get()).toEqual({ n: 0 });
  });

  it('the external plans too, list or targets', () => {
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    const out = ledger.recordExternalPlan({
      createdBy: 't1', planningThread: 't1', principal: OWNER_PRINCIPAL, host: 'acme.myshopify.com',
      targets: [{ key: 'https://acme.myshopify.com/admin/api/2025-10/products/1.json', after: { status: 'draft' } }],
      contract: { version: 1, grants: [] } as never,
    });
    if (!out.ok) throw new Error(out.reason);
    expect(containment.isContained({ bulkRunId: out.status.id })).toBe(true);
  });

  it('bulk_plan from a spawned child, which has no thread of its own and plans with created_by NULL, contains the run through the chat it runs for', async () => {
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    const toolContext = createToolContext({});
    toolContext.containment = containment;
    toolContext.bulkLedger = ledger;
    const child = { currentThreadId: undefined, originThreadId: 't1', toolContext, principal: OWNER_PRINCIPAL };
    const answer = await bulkPlanTool.handler({
      // The list form the planner knows today; the host does not matter to the containment.
      target_system: 'http', target_host: 'shop.commerce.example',
      source_list: { path: '/wp-json/wc/v3/products', after: { status: 'draft' } },
    }, child as never);
    expect(answer).toMatch(/^List dry run recorded/);
    const run = engineDb.getDb().prepare('SELECT id, created_by FROM bulk_runs').get() as { id: string; created_by: string | null };
    expect(run.created_by).toBeNull();
    expect(containment.isContained({ bulkRunId: run.id })).toBe(true);
  });

  it('an undo run inherits its source run\'s containment; an undo of an uncontained run is not contained (control)', async () => {
    const undoOf = async (planningThread: string | undefined): Promise<{ runId: string; undoId: string }> => {
      const state = new Map<string, string>([['k0', 'v0'], ['k1', 'v1']]);
      const runId = ledger.recordDryRun({ createdBy: planningThread, planningThread, principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'mem', targets: targets() }).id;
      const approved = ledger.approve(runId, { checksum: ledger.computeChecksum(runId)!, maxTargets: 2 });
      if (!approved.ok) throw new Error(approved.reason);
      const writer: TargetWriter = {
        read: async (k) => ({ absent: false, value: state.get(k)! }),
        write: async (k, a) => { state.set(k, a.absent ? '' : String(a.value)); return 'ok'; },
      };
      await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: () => writer });
      const undo = ledger.planUndo(runId);
      if (!undo.ok) throw new Error(undo.reason);
      return { runId, undoId: undo.status.id };
    };
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    const contained = await undoOf('t1');
    expect(containment.isContained({ bulkRunId: contained.runId })).toBe(true);
    expect(rows().filter((r) => r.container_id === contained.undoId)).toEqual([
      { container_kind: 'bulk_run', container_id: contained.undoId, kind: 'api', connection_id: 'shop-acme' },
    ]);
    const free = await undoOf(undefined);
    expect(containment.isContained({ bulkRunId: free.undoId })).toBe(false);
  });
});

describe('the end-of-turn capture reads the record', () => {
  it('stands down in a chat a spawned child contained, with the chat agent\'s own flag off', async () => {
    const { Agent } = await import('./agent.js');
    const toolContext = createToolContext({});
    toolContext.containment = containment;
    const parent = Object.create(Agent.prototype) as { skipMemoryExtraction: boolean; currentThreadId: string; toolContext: unknown; memory: unknown; isInternalRun: boolean };
    parent.skipMemoryExtraction = false;
    parent.currentThreadId = 't1';
    parent.toolContext = toolContext;
    parent.memory = {};
    parent.isInternalRun = false;
    const gate = (): unknown => (parent as unknown as { _captureGate(): { suppressed: string | null } })._captureGate().suppressed;
    expect(gate()).toBeNull();
    // The child's request contains the chat it was spawned from: the parent's thread.
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    expect(parent.skipMemoryExtraction).toBe(false);
    expect(gate()).toBe('extraction_off');
  });

  it('the legacy extraction reads the record when it returns, not when it starts', async () => {
    const { Agent } = await import('./agent.js');
    const maybeUpdate = vi.fn().mockResolvedValue(undefined);
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', systemPrompt: 'SYS' });
    const inner = agent as unknown as { memory: unknown; toolContext: Record<string, unknown>; _captureAtTurnEnd(t: string): void };
    inner.memory = { maybeUpdate };
    inner.toolContext = { ...createToolContext({}), containment };
    agent.currentThreadId = 't1';
    inner._captureAtTurnEnd('a business fact');
    expect(maybeUpdate).toHaveBeenCalledTimes(1);
    const cancelled = maybeUpdate.mock.calls[0]?.[4] as () => boolean;
    expect(cancelled()).toBe(false);
    // A spawned child's request contains the chat while the extraction is out.
    containment.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    expect(agent.skipMemoryExtraction).toBe(false);
    expect(cancelled()).toBe(true);
  });
});
