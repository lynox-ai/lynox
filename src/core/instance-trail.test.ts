import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { AuditLog, INSTANCE_WRITE_UNRECORDED, TARGET_MAX } from './audit-log.js';
import { runInCallSlot, type CallSlot } from './call-connection.js';
import { fitInstanceTarget, instanceTrailFor, InstanceWriteUnrecorded, withInstanceWrite, type InstanceWriter } from './instance-trail.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import { auditLogSchema } from '../../tests/helpers/audit-log.js';

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', display: 'TEST-DISPLAY', mandateId: 'TEST-MANDATE-1' };
const throwing = { record: () => { throw new Error('disk full'); } } as unknown as AuditLog;

describe('withInstanceWrite', () => {
  let dir = '';
  let db: EngineDb;
  let log: AuditLog;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lynox-instance-trail-')); db = new EngineDb(join(dir, 'engine.db')); log = new AuditLog(db.getDb()); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const rows = (): Array<Record<string, unknown>> => db.getDb().prepare('SELECT * FROM audit_log ORDER BY id').all() as Array<Record<string, unknown>>;
  const writer = (principal: RequestPrincipal | undefined, auditLog: AuditLog | null = log): InstanceWriter => ({ principal, currentRunId: 'run-1', toolContext: { auditLog } });
  const slotFor = (by: InstanceWriter, tool = 'data_store_drop'): CallSlot => ({ instanceTrail: instanceTrailFor(by, tool) });

  it('writes the attempt before the block and `returned` after it, under one correlation id, with the slot\'s actor', () => {
    const by = writer(MANDATE);
    const seen: number[] = [];
    const r = runInCallSlot(slotFor(by), () => withInstanceWrite(by, { site: 'data_store_drop#delete', kind: 'delete', store: 'data_store' }, () => { seen.push(rows().length); return 'ok'; }));
    expect(r).toBe('ok');
    expect(seen, 'the attempt row is there when the block runs').toEqual([1]);
    const rs = rows();
    expect(rs.map(x => x['phase'])).toEqual(['attempt', 'returned']);
    for (const x of rs) {
      expect(x).toMatchObject({ actor_kind: 'mandate', actor_email: 'setup@example.org', mandate_id: 'TEST-MANDATE-1', action: 'instance:data_store_drop#delete:delete', target: 'data_store', run_id: 'run-1' });
    }
    expect(rs[0]!['correlation_id']).toBe(rs[1]!['correlation_id']);
  });

  it('writes `failed` when the block throws, and passes the throw on; the same for a rejected promise', async () => {
    const by = writer(MANDATE);
    expect(() => runInCallSlot(slotFor(by), () => withInstanceWrite(by, { site: 'artifact_delete#delete', kind: 'delete', store: 'artifacts' }, () => { throw new Error('boom'); }))).toThrow('boom');
    await expect(runInCallSlot(slotFor(by), () => withInstanceWrite(by, { site: 'artifact_delete#delete', kind: 'delete', store: 'artifacts' }, async () => { throw new Error('later'); }))).rejects.toThrow('later');
    expect(rows().map(x => x['phase'])).toEqual(['attempt', 'failed', 'attempt', 'failed']);
  });

  it('leaves the result as it is when the outcome row cannot be written: the attempt stands alone', () => {
    const db2 = new Database(':memory:');
    db2.exec(auditLogSchema());
    db2.exec(`CREATE TRIGGER no_outcome BEFORE INSERT ON audit_log WHEN NEW.phase <> 'attempt' BEGIN SELECT RAISE(ABORT, 'full'); END;`);
    const by = writer(MANDATE, new AuditLog(db2));
    expect(runInCallSlot(slotFor(by), () => withInstanceWrite(by, { site: 'artifact_delete#delete', kind: 'delete', store: 'artifacts' }, () => 'kept'))).toBe('kept');
    expect((db2.prepare('SELECT phase FROM audit_log').all() as Array<{ phase: string }>).map(r => r.phase)).toEqual(['attempt']);
  });

  it('does not run the block when the attempt cannot be written, and poisons the call: a later write is refused too', () => {
    const fn = vi.fn(() => 'x');
    const slot: CallSlot = { instanceTrail: instanceTrailFor(writer(MANDATE, throwing), 'remember') };
    let caught: unknown;
    try {
      runInCallSlot(slot, () => withInstanceWrite(writer(MANDATE, throwing), { site: 'remember#create', kind: 'create', store: 'knowledge' }, fn));
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(InstanceWriteUnrecorded);
    expect((caught as Error).message).toBe(INSTANCE_WRITE_UNRECORDED);
    expect(fn).not.toHaveBeenCalled();
    expect(slot.instanceRefused).toBe(true);
    // The log works again; the call stays refused.
    (slot as { instanceTrail: unknown }).instanceTrail = instanceTrailFor(writer(MANDATE), 'remember');
    expect(() => runInCallSlot(slot, () => withInstanceWrite(writer(MANDATE), { site: 'remember#create', kind: 'create', store: 'knowledge' }, fn))).toThrow(InstanceWriteUnrecorded);
    expect(fn).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it('refuses a mandate without a log', () => {
    const fn = vi.fn();
    const slot = slotFor(writer(MANDATE, null));
    expect(() => runInCallSlot(slot, () => withInstanceWrite(writer(MANDATE, null), { site: 'contacts_save#save', kind: 'save', store: 'contacts' }, fn))).toThrow(INSTANCE_WRITE_UNRECORDED);
    expect(fn).not.toHaveBeenCalled();
    expect(slot.instanceRefused).toBe(true);
    // Outside a slot as well.
    expect(() => withInstanceWrite(writer(MANDATE, null), { site: 'contacts_save#save', kind: 'save', store: 'contacts' }, fn)).toThrow(InstanceWriteUnrecorded);
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses and poisons when the target or the kind cannot be read', () => {
    const fn = vi.fn();
    for (const spec of [
      { site: 'task_update#change' as const, kind: 'change' as const, store: 'tasks' as const, target: () => { throw new Error('store gone'); } },
      { site: 'api_setup#save' as const, kind: () => { throw new Error('store gone'); }, store: 'api_profiles' as const },
    ]) {
      const slot = slotFor(writer(MANDATE));
      expect(() => runInCallSlot(slot, () => withInstanceWrite(writer(MANDATE), spec, fn))).toThrow(InstanceWriteUnrecorded);
      expect(slot.instanceRefused).toBe(true);
    }
    expect(fn).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it('writes no row for the owner and never reads its target or kind, even with a log that throws', () => {
    const target = vi.fn(() => [['task', 't-1']] as const);
    const kind = vi.fn(() => 'change' as const);
    const fn = vi.fn(() => 'ran');
    const owner = writer(OWNER_PRINCIPAL, throwing);
    expect(runInCallSlot(slotFor(owner), () => withInstanceWrite(owner, { site: 'task_update#change', kind, store: 'tasks', target }, fn))).toBe('ran');
    expect(withInstanceWrite(owner, { site: 'task_update#change', kind, store: 'tasks', target }, fn)).toBe('ran');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(target).not.toHaveBeenCalled();
    expect(kind).not.toHaveBeenCalled();
  });

  it('outside a call, takes the actor from the writer now: a mandate gets rows, the owner none', () => {
    withInstanceWrite(writer(MANDATE), { site: 'memory_store#create', kind: 'create', store: 'memory', target: () => [['ns', 'knowledge']] }, () => undefined);
    withInstanceWrite(writer(OWNER_PRINCIPAL), { site: 'memory_store#create', kind: 'create', store: 'memory' }, () => undefined);
    expect(rows().map(r => [r['actor_kind'], r['phase'], r['target']])).toEqual([['mandate', 'attempt', 'memory ns=knowledge'], ['mandate', 'returned', 'memory ns=knowledge']]);
  });

  it('refuses a writer that names no principal, in a call and outside one: the block does not run', () => {
    const fn = vi.fn(() => 'ran');
    const spec = { site: 'memory_store#create', kind: 'create', store: 'memory' } as const;
    expect(() => withInstanceWrite(writer(undefined), spec, fn)).toThrow(InstanceWriteUnrecorded);
    expect(() => runInCallSlot(slotFor(writer(undefined), 'memory_store'), () => withInstanceWrite(writer(undefined), spec, fn))).toThrow(InstanceWriteUnrecorded);
    expect(fn).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it('refuses a real writer handler called with an agent that names no principal, and its store is not touched', async () => {
    const { contactsSaveTool } = await import('../tools/builtin/contacts.js');
    const upsert = vi.fn();
    const by = { toolContext: { auditLog: log, crm: { upsertContact: upsert, findContact: vi.fn(), upsert } } } as unknown as Parameters<typeof contactsSaveTool.handler>[1];
    expect(await contactsSaveTool.handler({ name: 'Ada' }, by)).toContain(INSTANCE_WRITE_UNRECORDED);
    expect(upsert).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it('records the principal fixed when the slot was built, not the one the writer has when the block settles', async () => {
    // A session resets its agent's principal per run; an abandoned call can end in the owner's.
    const agent = { principal: MANDATE as RequestPrincipal, currentRunId: 'run-mandate', toolContext: { auditLog: log } };
    const slot = slotFor(agent, 'data_store_insert');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const done = runInCallSlot(slot, () => withInstanceWrite(agent, { site: 'data_store_insert#save', kind: 'save', store: 'data_store' }, async () => { await gate; return 'late'; }));
    agent.principal = OWNER_PRINCIPAL;
    agent.currentRunId = 'run-owner';
    release();
    expect(await done).toBe('late');
    const rs = rows();
    expect(rs.map(r => r['phase'])).toEqual(['attempt', 'returned']);
    for (const r of rs) expect(r).toMatchObject({ actor_kind: 'mandate', mandate_id: 'TEST-MANDATE-1', run_id: 'run-mandate' });
  });

  it('a block that never settles leaves exactly one row, the attempt', async () => {
    const by = writer(MANDATE);
    void runInCallSlot(slotFor(by), () => withInstanceWrite(by, { site: 'data_store_insert#save', kind: 'save', store: 'data_store' }, () => new Promise<never>(() => { /* never */ })));
    await new Promise((r) => setTimeout(r, 20));
    expect(rows().map(r => r['phase'])).toEqual(['attempt']);
  });

  it('the attempt is committed before the block: a second connection reads it from inside the block', () => {
    const other = new Database(join(dir, 'engine.db'), { readonly: true });
    try {
      const by = writer(MANDATE);
      const seen = runInCallSlot(slotFor(by), () => withInstanceWrite(by, { site: 'data_store_create#create', kind: 'create', store: 'data_store' }, () =>
        (other.prepare('SELECT action, phase FROM audit_log').all() as Array<{ action: string; phase: string }>)));
      expect(seen).toEqual([{ action: 'instance:data_store_create#create:create', phase: 'attempt' }]);
    } finally {
      other.close();
    }
  });
});

describe('fitInstanceTarget', () => {
  it('names the store and escapes each value where it could shape the row', () => {
    expect(fitInstanceTarget('artifacts', [['artifact', 'ab%c=d'], ['version', 3], ['gone', undefined]])).toBe('artifacts artifact=ab%25c%3Dd version=3');
    expect(fitInstanceTarget('contacts', [])).toBe('contacts');
  });

  it('cuts only whole pairs, says how many more, and stays within the row\'s bound measured on the escaped text', () => {
    // Each `=` triples when escaped: measured on the raw text the list would seem to fit.
    const pairs = Array.from({ length: 40 }, (_, i) => ['k', `${'='.repeat(10)}${String(i)}`] as const);
    const t = fitInstanceTarget('subjects', pairs);
    expect(t.length).toBeLessThanOrEqual(TARGET_MAX);
    expect(t).toMatch(/ \+\d+ more$/);
    const shown = t.replace(/ \+\d+ more$/, '').split(' ').slice(1);
    for (const p of shown) expect(p).toMatch(/^k=(%3D){10}\d+$/);
    expect(shown.length + Number(/\+(\d+) more$/.exec(t)![1])).toBe(40);
  });
});

describe('INSTANCE_WRITE_UNRECORDED', () => {
  it('is the contract\'s text, word for word', () => {
    expect(INSTANCE_WRITE_UNRECORDED).toBe('Not made: this change cannot be recorded in the instance log right now, so nothing was changed. Do not retry it in this run. If a user is in this conversation, tell them in one sentence that the change was not made and that they can try again later or ask the owner of this instance to make it.');
  });
});
