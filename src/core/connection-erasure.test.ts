import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { RunHistory } from './run-history.js';
import {
  blankRunHistoryContent,
  coveredGrantSet,
  erasureOnDeleteEnabled,
  erasureRecords,
  FALLBACK_MARKER,
  FALLBACK_CONTENT_COLUMNS,
  FALLBACK_KEPT_COLUMNS,
  runConnectionErasureSweeps,
  setErasureOnDeleteForTests,
} from './connection-erasure.js';
import { OWNER_PRINCIPAL, principalTag } from './request-principal.js';
import { apiSetupTool } from '../tools/builtin/api-setup.js';
import { bindingsAsMigrated } from '../../tests/helpers/vault-bindings.js';
import { testAuditLog } from '../../tests/helpers/audit-log.js';

/**
 * The acceptance tests T1–T3 of PRD-SOURCE-CONNECTION revision 8 (R8-8), written before the
 * logic they check. Each answers one regression the last delta found in the repairs:
 *  - T1 (J1): a call in flight at the delete lands after the first pass and is still erased, and so
 *    is one that lands after the store is `done`;
 *  - T2 (J2): a grant minted as `new` in the middle of a connection's life does not start an epoch;
 *  - T3 (J5): the fallback blanks every content column it names, and keeps the rows.
 */

describe('T1 — a call in flight at the delete is erased, also when it lands after the store is done', () => {
  let dir: string;
  let db: EngineDb;
  let conn: ConnectionStore;
  let ledger: GrantLedger;
  let store: ApiStore;
  let history: RunHistory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-t1-'));
    db = new EngineDb(join(dir, 'engine.db'));
    conn = new ConnectionStore(db);
    ledger = new GrantLedger(db.getDb());
    store = new ApiStore();
    store.loadFromConnections(conn);
    store.setConnectionStore(conn);
    store.setGrantLedger(ledger);
    history = new RunHistory(join(dir, 'history.db'));
  });
  afterEach(() => {
    history.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rowsOf = (grantId: string): number =>
    (history.getDb().prepare('SELECT COUNT(*) AS n FROM run_tool_calls WHERE grant_id = ?').get(grantId) as { n: number }).n;
  const call = (runId: string, connectionId: string, grantId: string, seq: number): void => {
    history.insertToolCall({ runId, toolName: 'http_request', inputJson: `{"url":"https://${connectionId}.example/${seq}"}`, outputJson: '', durationMs: 1, sequenceOrder: seq, connectionId, grantId });
  };
  const stateOf = (connectionId: string): string | undefined => erasureRecords(db.getDb(), connectionId)[0]?.historyState;

  it('stays pending while a run active at the delete runs, is done once it ended, and a late row is still erased', () => {
    expect(store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } }).ok).toBe(true);
    const grant = store.get('shop')!.oauth_grant!.grant_id!;
    const before = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    call(before, 'shop', grant, 0);
    history.updateRun(before, { status: 'completed' });
    // The run whose `http_request` is in flight when the connection is removed.
    const inFlight = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });

    expect(store.remove('shop', undefined, { record: 'erasure' })).toBe(true);
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(rowsOf(grant)).toBe(0);
    expect(stateOf('shop')).toBe('pending');

    // The call ends after the delete: its row lands, stamped before the request was sent.
    call(inFlight, 'shop', grant, 0);
    call(inFlight, 'crm', 'g-crm', 1); // another connection's row of the same run stays
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(rowsOf(grant)).toBe(0);
    expect(stateOf('shop')).toBe('pending'); // the run still runs

    history.updateRun(inFlight, { status: 'completed' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(stateOf('shop')).toBe('done');
    expect(rowsOf('g-crm')).toBe(1);

    // A call its run abandoned lands on the session's NEXT run (session.ts: `call.runId ??
    // this.currentRunId`), which was not active at the delete: the store is already done, and the
    // row is erased all the same.
    const next = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    call(next, 'shop', grant, 0);
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(rowsOf(grant)).toBe(0);
    expect(stateOf('shop')).toBe('done');
  });

  it('is late, not done, when the deadline passes while a run active at the delete still runs', () => {
    store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    store.remove('shop', undefined, { record: 'erasure' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(Date.now() + 31 * 24 * 3600 * 1000));
    expect(stateOf('shop')).toBe('late');
  });

  it('a removal without options writes no record at all', () => {
    store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    expect(store.remove('shop')).toBe(true);
    expect((db.getDb().prepare('SELECT COUNT(*) AS n FROM connection_records').get() as { n: number }).n).toBe(0);
  });

  it('a removal without the erasure kind writes a closing record that erases nothing', () => {
    store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    const grant = store.get('shop')!.oauth_grant!.grant_id!;
    const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    call(run, 'shop', grant, 0);
    history.updateRun(run, { status: 'completed' });
    expect(store.remove('shop', undefined, { record: 'closing' })).toBe(true);
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(rowsOf(grant)).toBe(1);
    expect(erasureRecords(db.getDb(), 'shop').map((r) => [r.kind, r.historyState])).toEqual([['closing', 'not reached']]);
  });
  it('names the connection until the store is done, a closing record never, and erases only the record\'s own connection\'s rows', () => {
    store.save({ id: 'shop', name: 'My Shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    store.save({ id: 'crm', name: 'My CRM', base_url: 'https://crm.example', description: 'd', auth: { type: 'bearer', vault_keys: ['CRM_KEY'] } });
    const grant = store.get('shop')!.oauth_grant!.grant_id!;
    const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    store.remove('shop', undefined, { record: 'erasure' });
    store.remove('crm', undefined, { record: 'closing' });
    const label = (id: string): unknown => (db.getDb().prepare('SELECT label FROM connection_records WHERE connection_id = ?').get(id) as { label: unknown }).label;
    expect(label('shop')).toBe('My Shop');
    expect(label('crm')).toBeNull();
    // A row stamped with the covered grant under another connection is not this record's
    // (R8-3: the connection AND the grant).
    call(run, 'other', grant, 0);
    history.updateRun(run, { status: 'completed' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(stateOf('shop')).toBe('done');
    expect(label('shop')).toBeNull();
    expect(rowsOf(grant)).toBe(1);
  });
  it('stops sweeping a record once its deadline passed', () => {
    store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    const grant = store.get('shop')!.oauth_grant!.grant_id!;
    store.remove('shop', undefined, { record: 'erasure' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(stateOf('shop')).toBe('done');
    const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    call(run, 'shop', grant, 0);
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(Date.now() + 31 * 24 * 3600 * 1000));
    expect(rowsOf(grant)).toBe(1);
  });

  it('erases nothing while a connection under the same id holds one of the record\'s grants again', () => {
    const profile = { id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer' as const, vault_keys: ['SHOP_KEY'] } };
    store.save(profile);
    const grant = store.get('shop')!.oauth_grant!.grant_id!;
    const stored = store.get('shop')!;
    store.remove('shop', undefined, { record: 'erasure' });
    // An import brings the profile back with the same grant (the store was emptied first).
    const apis = join(dir, 'apis');
    mkdirSync(apis);
    writeFileSync(join(apis, 'shop.json'), JSON.stringify(stored));
    expect(new ApiStore().importFromDirectoryIfNeeded(apis, conn)).toBe(1);
    const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    call(run, 'shop', grant, 0);
    history.updateRun(run, { status: 'completed' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(rowsOf(grant)).toBe(1);
  });

  it('tells the audit hook each change of a store\'s state once, not on every pass', () => {
    store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    store.remove('shop', undefined, { record: 'erasure' });
    const changes: string[] = [];
    const hook = (r: { connectionId: string }, state: string): void => { changes.push(`${r.connectionId}:${state}`); };
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(), hook);
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(), hook);
    history.updateRun(run, { status: 'completed' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(), hook);
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(), hook);
    expect(changes).toEqual(['shop:pending', 'shop:done']);
  });

  it('one record that fails does not keep the next from its pass', () => {
    for (const id of ['shop', 'crm']) store.save({ id, name: id, base_url: `https://${id}.example`, description: 'd', auth: { type: 'bearer', vault_keys: [`${id.toUpperCase()}_KEY`] } });
    const crmGrant = store.get('crm')!.oauth_grant!.grant_id!;
    store.remove('shop', undefined, { record: 'erasure' });
    store.remove('crm', undefined, { record: 'erasure' });
    db.getDb().exec(`CREATE TRIGGER fail_shop BEFORE UPDATE ON connection_records WHEN OLD.connection_id = 'shop' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    call(run, 'crm', crmGrant, 0);
    history.updateRun(run, { status: 'completed' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(rowsOf(crmGrant)).toBe(0);
    expect(stateOf('crm')).toBe('done');
  });

  it('a pass that sets a store done leaves no erased row in history.db or its WAL', () => {
    store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    const grant = store.get('shop')!.oauth_grant!.grant_id!;
    const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    history.insertToolCall({ runId: run, toolName: 'http_request', inputJson: '{"url":"https://shop.example/erasure-wal-mark-91b2"}', outputJson: '', durationMs: 1, sequenceOrder: 0, connectionId: 'shop', grantId: grant });
    history.updateRun(run, { status: 'completed' });
    const path = join(dir, 'history.db');
    const holds = (): boolean => [path, `${path}-wal`].some((f) => existsSync(f) && readFileSync(f).includes('erasure-wal-mark-91b2'));
    expect(holds()).toBe(true); // positive control: the same read finds the row before
    store.remove('shop', undefined, { record: 'erasure' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(stateOf('shop')).toBe('done');
    expect(holds()).toBe(false);
  });

  it('erases nothing while a connection brought back with a later grant of its epoch is stored', () => {
    const p = { id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer' as const, vault_keys: ['SHOP_KEY'] } };
    store.save(p);
    store.save({ ...p, auth: { type: 'bearer' as const, vault_keys: ['OTHER_KEY'] } });
    const later = store.get('shop')!.oauth_grant!.grant_id!;
    const stored = store.get('shop')!;
    store.remove('shop', undefined, { record: 'erasure' });
    const apis = join(dir, 'apis');
    mkdirSync(apis);
    writeFileSync(join(apis, 'shop.json'), JSON.stringify(stored));
    expect(new ApiStore().importFromDirectoryIfNeeded(apis, conn)).toBe(1);
    const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    call(run, 'shop', later, 0);
    history.updateRun(run, { status: 'completed' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(rowsOf(later)).toBe(1);
  });

  it('a record late because a live copy held it still erases once that copy is gone, and tells pending before late', () => {
    const p = { id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer' as const, vault_keys: ['SHOP_KEY'] } };
    store.save(p);
    const stored = store.get('shop')!;
    const grant = stored.oauth_grant!.grant_id!;
    store.remove('shop', undefined, { record: 'erasure' });
    // The copy comes back before the first pass, and stays past the deadline.
    const apis = join(dir, 'apis');
    mkdirSync(apis);
    writeFileSync(join(apis, 'shop.json'), JSON.stringify(stored));
    new ApiStore().importFromDirectoryIfNeeded(apis, conn);
    const told: string[] = [];
    const hook = (_r: unknown, state: string): void => { told.push(state); };
    const later = (days: number): Date => new Date(Date.now() + days * 24 * 3600 * 1000);
    runConnectionErasureSweeps(db.getDb(), history.getDb(), later(31), hook);
    expect(stateOf('shop')).toBe('late');
    expect(told).toEqual(['pending', 'late']);
    // The copy is removed; a call it left under the record's grant is erased by the next pass.
    db.getDb().prepare("DELETE FROM connections WHERE id = 'shop'").run();
    const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    call(run, 'shop', grant, 0);
    history.updateRun(run, { status: 'completed' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), later(32), hook);
    expect(rowsOf(grant)).toBe(0);
    expect(stateOf('shop')).toBe('late');
    expect(told).toEqual(['pending', 'late']);
  });

  it('a pending record skipped for a live copy turns late at its deadline', () => {
    const p = { id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer' as const, vault_keys: ['SHOP_KEY'] } };
    store.save(p);
    const stored = store.get('shop')!;
    history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' }); // still running
    store.remove('shop', undefined, { record: 'erasure' });
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
    expect(stateOf('shop')).toBe('pending');
    const apis = join(dir, 'apis');
    mkdirSync(apis);
    writeFileSync(join(apis, 'shop.json'), JSON.stringify(stored));
    new ApiStore().importFromDirectoryIfNeeded(apis, conn);
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(Date.now() + 31 * 24 * 3600 * 1000));
    expect(stateOf('shop')).toBe('late');
  });

  it('retries a blocked WAL checkpoint on the next pass, and stops once it went through', () => {
    store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    store.remove('shop', undefined, { record: 'erasure' });
    const real = history.getDb();
    const checkpoints: string[] = [];
    let busy = true;
    const blocking = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'pragma') {
          return (src: string, opts?: unknown) => {
            if (src.startsWith('wal_checkpoint')) { checkpoints.push(busy ? 'busy' : 'ok'); return [{ busy: busy ? 1 : 0, log: 0, checkpointed: 0 }]; }
            return (target.pragma as (s: string, o?: unknown) => unknown)(src, opts);
          };
        }
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    runConnectionErasureSweeps(db.getDb(), blocking, new Date());
    expect(stateOf('shop')).toBe('done');
    busy = false;
    runConnectionErasureSweeps(db.getDb(), blocking, new Date());
    runConnectionErasureSweeps(db.getDb(), blocking, new Date());
    expect(checkpoints).toEqual(['busy', 'ok']);
  });

  it('a record keeps the current and first grant as ended even when the epoch cannot be told', () => {
    store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    const grant = store.get('shop')!.oauth_grant!.grant_id!;
    db.getDb().prepare("UPDATE connections SET first_grant_id = 'g-foreign' WHERE id = 'shop'").run();
    store.remove('shop', undefined, { record: 'closing' });
    const ended = JSON.parse((db.getDb().prepare("SELECT ended_grants_json AS e FROM connection_records WHERE connection_id = 'shop'").get() as { e: string }).e) as string[];
    expect(ended.sort()).toEqual([grant, 'g-foreign'].sort());
  });

  it('writes the attempt and the result even when the first pass is already done, and a not-reached record once', () => {
    store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    store.save({ id: 'crm', name: 'crm', base_url: 'https://crm.example', description: 'd', auth: { type: 'bearer', vault_keys: ['CRM_KEY'] } });
    db.getDb().prepare("DELETE FROM connection_grant_hosts WHERE grant_id = ?").run(store.get('crm')!.oauth_grant!.grant_id!);
    store.remove('shop', undefined, { record: 'erasure' });
    store.remove('crm', undefined, { record: 'erasure' }); // no grant in scope: not reached
    const changes: string[] = [];
    const hook = (r: { connectionId: string }, state: string): void => { changes.push(`${r.connectionId}:${state}`); };
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(), hook);
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(), hook);
    expect(changes.sort()).toEqual(['crm:not reached', 'shop:done', 'shop:pending']);
  });

  it('a state change whose audit row cannot be written is not kept, and the next pass writes both', () => {
    store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });
    store.remove('shop', undefined, { record: 'erasure' });
    let fail = true;
    const changes: string[] = [];
    const hook = (_r: unknown, state: string): void => { if (fail) throw new Error('audit_log is full'); changes.push(state); };
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(), hook);
    expect(stateOf('shop')).toBe('pending');
    fail = false;
    runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date(), hook);
    expect(stateOf('shop')).toBe('done');
    expect(changes).toEqual(['pending', 'done']);
  });

  describe('the api_setup delete', () => {
    const owner = OWNER_PRINCIPAL;
    const mandate = { kind: 'mandate' as const, email: 'op@example.com', mandateId: 'm1' };
    const agentFor = (principal: typeof owner | typeof mandate): never => ({
      principal,
      sessionCounters: { httpRequests: 0 },
      promptUser: async () => 'Allow',
      toolContext: { auditLog: testAuditLog().log, apiStore: store, vaultNameBindings: bindingsAsMigrated(store), userConfig: {}, connectionErasureSweep: null, secretReleases: null },
    }) as never;
    const save = (createdBy?: string): void => {
      expect(store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] }, ...(createdBy ? { created_by: createdBy } : {}) }).ok).toBe(true);
    };
    let restore: () => void;
    beforeEach(() => { restore = setErasureOnDeleteForTests(true); });
    afterEach(() => restore());

    it('writes an erasure record when the owner deletes', async () => {
      save();
      expect(await apiSetupTool.handler({ action: 'delete', id: 'shop' }, agentFor(owner))).toContain('Deleted');
      expect(erasureRecords(db.getDb(), 'shop').map((r) => r.kind)).toEqual(['erasure']);
    });

    it('writes only a closing record when a mandate deletes a connection it set up', async () => {
      save(principalTag(mandate));
      expect(await apiSetupTool.handler({ action: 'delete', id: 'shop' }, agentFor(mandate))).toContain('Deleted');
      expect(erasureRecords(db.getDb(), 'shop').map((r) => r.kind)).toEqual(['closing']);
    });

    it('writes only a closing record while erasure on delete is off', async () => {
      restore();
      restore = setErasureOnDeleteForTests(false);
      save();
      const grant = store.get('shop')!.oauth_grant!.grant_id!;
      const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
      call(run, 'shop', grant, 0);
      history.updateRun(run, { status: 'completed' });
      expect(await apiSetupTool.handler({ action: 'delete', id: 'shop' }, agentFor(owner))).toContain('Deleted');
      expect(erasureRecords(db.getDb(), 'shop').map((r) => r.kind)).toEqual(['closing']);
      // Off erases nothing: the call stays after a sweep.
      runConnectionErasureSweeps(db.getDb(), history.getDb(), new Date());
      expect(rowsOf(grant)).toBe(1);
    });

    it('erasure on delete starts off, until the question names it', () => {
      restore();
      restore = () => {};
      expect(erasureOnDeleteEnabled()).toBe(false);
    });
  });
});

describe('T2 — the covered set is the connection\'s epoch, from the grant its row was created with', () => {
  let dir: string;
  let db: EngineDb;
  let conn: ConnectionStore;
  let ledger: GrantLedger;
  let store: ApiStore;

  const profile = (id: string, key = `${id.toUpperCase()}_KEY`): ApiProfile => ({
    id, name: id, base_url: `https://${id}.example`, description: 'd', auth: { type: 'bearer', vault_keys: [key] },
  });
  const grantOf = (id: string): string => store.get(id)!.oauth_grant!.grant_id!;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-t2-'));
    db = new EngineDb(join(dir, 'engine.db'));
    conn = new ConnectionStore(db);
    ledger = new GrantLedger(db.getDb());
    store = new ApiStore();
    store.loadFromConnections(conn);
    store.setConnectionStore(conn);
    store.setGrantLedger(ledger);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a `new` grant minted in the middle of the connection\'s life does not start an epoch', () => {
    // G1 (`new`) and G2 (`consent`) on one connection row.
    const oauth = (clientSecretKey: string): ApiProfile => ({
      id: 'shop-api', name: 'shop-api', base_url: 'https://api.shop.example/v1', description: 'd',
      auth: { type: 'oauth2', oauth: { token_url: 'https://api.shop.example/oauth/token', grant_type: 'refresh_token', client_id_key: 'SHOP_API_CID', client_secret_key: clientSecretKey } },
    });
    expect(store.save(oauth('SHOP_API_CSECRET')).ok).toBe(true);
    const g1 = grantOf('shop-api');
    expect(store.save(oauth('SHOP_API_CSECRET'), undefined, { newConsent: true, consentRefresh: null }).ok).toBe(true);
    const g2 = grantOf('shop-api');
    expect(g2).not.toBe(g1);

    // The stored row now points its client secret at its own token slot, so the next boot holds
    // the profile back (api-store.ts, `heldBack`) and leaves its row where it is.
    const row = conn.get('shop-api')!;
    const config = JSON.parse(row.configJson) as ApiProfile;
    config.auth!.oauth!.client_secret_key = 'SHOP_API_REFRESH_TOKEN';
    conn.upsert({ ...row, configJson: JSON.stringify(config) });

    const booted = new ApiStore();
    booted.loadFromConnections(conn);
    booted.setConnectionStore(conn);
    booted.setGrantLedger(ledger);
    expect(booted.get('shop-api')).toBeUndefined();
    expect(booted.knownProfiles().map((p) => p.id)).toEqual(['shop-api']);

    // Its corrected save is a create to the store, so it mints `new` — on the same row.
    expect(booted.save(oauth('SHOP_API_CSECRET'))).toEqual({ ok: true, isNew: true });
    const g3 = booted.get('shop-api')!.oauth_grant!.grant_id!;
    expect(ledger.get(g3)?.reason).toBe('new');
    expect(conn.get('shop-api')!.createdAt).toBe(row.createdAt);

    expect([...(coveredGrantSet(db.getDb(), 'shop-api') ?? [])].sort()).toEqual([g1, g2, g3].sort());
  });

  it('a connection that reuses the id of a removed one starts its own epoch', () => {
    store.save(profile('shop'));
    const old = grantOf('shop');
    expect(store.remove('shop')).toBe(true);
    store.save(profile('shop'));
    const fresh = grantOf('shop');

    const set = coveredGrantSet(db.getDb(), 'shop');
    expect(set).toEqual([fresh]);
    expect(set).not.toContain(old);
  });
  it('T4 — an import that carries a removed connection\'s later grant covers none of its grants', () => {
    // X1: `new`, then a later grant from a credentials change.
    store.save(profile('shop'));
    store.save(profile('shop', 'OTHER_KEY'));
    const x1Later = grantOf('shop');
    const x1Profile = store.get('shop')!;
    expect(store.remove('shop', undefined, { record: 'erasure' })).toBe(true);

    // A profile file for the same id, carrying X1's later grant, is imported into the empty store.
    const apis = join(dir, 'apis');
    mkdirSync(apis);
    writeFileSync(join(apis, 'shop.json'), JSON.stringify(x1Profile));
    const booted = new ApiStore();
    expect(booted.importFromDirectoryIfNeeded(apis, conn)).toBe(1);
    expect(JSON.parse(conn.get('shop')!.configJson).oauth_grant.grant_id).toBe(x1Later);

    expect(coveredGrantSet(db.getDb(), 'shop')).toBeNull();
  });
  it('covers nothing when the profile\'s current grant is outside its epoch (fails closed)', () => {
    store.save(profile('shop'));
    store.save(profile('crm'));
    // A row whose recorded grant is another connection's: no path of the store writes this, which
    // is the case the check exists for.
    const row = conn.get('shop')!;
    const config = JSON.parse(row.configJson) as ApiProfile;
    config.oauth_grant = { ...config.oauth_grant!, grant_id: grantOf('crm') };
    conn.upsert({ ...row, configJson: JSON.stringify(config) });
    expect(coveredGrantSet(db.getDb(), 'shop')).toBeNull();
  });

  it('keeps only grants in scope: one without a host snapshot, or with a Shopify Admin host, is left out', () => {
    store.save(profile('shop'));
    const g1 = grantOf('shop');
    store.save(profile('shop', 'OTHER_KEY'));
    const g2 = grantOf('shop');
    expect(coveredGrantSet(db.getDb(), 'shop')).toEqual([g1, g2]);
    db.getDb().prepare('DELETE FROM connection_grant_hosts WHERE grant_id = ?').run(g1);
    expect(coveredGrantSet(db.getDb(), 'shop')).toEqual([g2]);

    store.save({ id: 'store', name: 'store', base_url: 'https://acme.myshopify.com/admin/api', description: 'd', auth: { type: 'bearer', vault_keys: ['STORE_KEY'] } });
    expect(coveredGrantSet(db.getDb(), 'store')).toEqual([]);
  });
  it('a connection removed in settings and imported back with its only grant covers nothing', () => {
    store.save(profile('shop'));
    const stored = store.get('shop')!;
    expect(store.remove('shop', undefined, { record: 'closing' })).toBe(true);
    const apis = join(dir, 'apis');
    mkdirSync(apis);
    writeFileSync(join(apis, 'shop.json'), JSON.stringify(stored));
    expect(new ApiStore().importFromDirectoryIfNeeded(apis, conn)).toBe(1);
    expect(coveredGrantSet(db.getDb(), 'shop')).toBeNull();
  });

  it('a row that does not say where its epoch starts covers nothing', () => {
    store.save(profile('shop'));
    db.getDb().prepare("UPDATE connections SET first_grant_id = NULL WHERE id = 'shop'").run();
    expect(coveredGrantSet(db.getDb(), 'shop')).toBeNull();
  });
  it('a connection removed without a record and imported back with a later grant covers nothing', () => {
    store.save(profile('shop'));
    store.save(profile('shop', 'OTHER_KEY'));
    const stored = store.get('shop')!;
    expect(store.remove('shop')).toBe(true); // as before E2: no record
    const apis = join(dir, 'apis');
    mkdirSync(apis);
    writeFileSync(join(apis, 'shop.json'), JSON.stringify(stored));
    expect(new ApiStore().importFromDirectoryIfNeeded(apis, conn)).toBe(1);
    expect(coveredGrantSet(db.getDb(), 'shop')).toBeNull();
  });
});

describe('T3 — the fallback blanks every content column it names and keeps the rows', () => {
  let dir: string;
  let history: RunHistory;
  const MARK = 'erasure-marker-7f3c';
  const CONTENT_TABLES = ['advisor_suggestions', 'pending_prompts', 'pipeline_runs', 'pipeline_step_results', 'pre_approval_events', 'pre_approval_sets', 'processes', 'run_tool_calls', 'runs', 'security_events', 'wire_snapshots'];
  /** The history.db tables the fallback does not touch, each with why it holds no run content. */
  const NOT_RUN_CONTENT: Record<string, string> = {
    active_runs: 'ids, status and times of runs in flight',
    bulk_cost_days: 'costs per day',
    compaction_events: 'counts and the trigger kind',
    conversation_grants: 'thread and grant ids',
    deleted_threads: 'ids of deleted chats',
    metrics: 'computed numbers',
    model_provenance_backfill_marker: 'a marker',
    // Measured at 90d8a5ca: the snapshot (session.ts:1061, batch.ts:95) is the fixed prompt, the
    // language name, provider, model ids and tier map, the date and the fixed web/worker suffixes
    // (prompts.ts:239-389); no memory, contact, connection or vault name. Only a library embedder's
    // own `config.systemPrompt` adds text, and the server sets none (http-api.ts:1905).
    prompt_snapshots: 'the system prompt per hash: fixed text, language, model ids, date',
    run_spawns: 'ids',
    schema_version: 'the version',
    scopes: 'the scopes the customer set up',
    tasks: 'tasks the customer keeps and deletes (remainder)',
    tenants: 'tenant configuration',
    thread_messages: 'the chat itself: deleted with the chat, cut by cut 1b',
    threads: 'the chat itself: deleted with the chat',
    triggers: 'the legacy table, superseded by engine.db',
    workflow_run_claims: 'workflow, key and run ids',
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-t3-'));
    history = new RunHistory(join(dir, 'history.db'));
  });
  afterEach(() => {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One run in thread `thread-a` whose every content column holds the marker. */
  const seed = (): string => {
    const db = history.getDb();
    const runId = history.insertRun({ sessionId: 'thread-a', taskText: `task ${MARK}`, modelTier: 'sonnet', modelId: 'm' });
    history.updateRun(runId, { responseText: `reply ${MARK}`, errorText: `error ${MARK}`, status: 'failed', costUsd: 0.25 });
    db.prepare('UPDATE runs SET task_hash = ?, prompt_hash = ? WHERE id = ?').run(MARK, MARK, runId);
    history.insertToolCall({ runId, toolName: 'data_store_insert', inputJson: `{"v":"${MARK}"}`, outputJson: `failed ${MARK}`, durationMs: 1, sequenceOrder: 0 });
    db.prepare(`INSERT INTO pending_prompts (id, session_id, prompt_type, question, options_json, answer, questions_json, partial_answers_json, payload_json, answer_error, segments_json, origin_json, status, expires_at)
      VALUES ('p1', 'thread-a', 'ask_user', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'answered', '2099-01-01T00:00:00.000Z')`)
      .run(MARK, `["${MARK}"]`, MARK, `["${MARK}"]`, `{"a":"${MARK}"}`, `{"p":"${MARK}"}`, MARK, `[{"value":"${MARK}"}]`, `{"step_task":"${MARK}"}`);
    db.prepare(`INSERT INTO processes (id, name, description, source_run_id, steps_json, parameters_json) VALUES ('proc1', 'weekly', ?, ?, ?, ?)`)
      .run(MARK, runId, `[{"inputTemplate":{"q":"${MARK}"}}]`, `[{"default":"${MARK}"}]`);
    db.prepare(`INSERT INTO pipeline_runs (id, manifest_name, status, manifest_json, parent_run_id, error) VALUES ('pr1', 'wf', 'failed', ?, ?, ?)`)
      .run(`{"p":"${MARK}"}`, runId, MARK);
    db.prepare(`INSERT INTO pipeline_step_results (pipeline_run_id, step_id, status, result, error) VALUES ('pr1', 's1', 'failed', ?, ?)`).run(MARK, MARK);
    db.prepare(`INSERT INTO security_events (event_type, tool_name, input_preview, decision, run_id, detail) VALUES ('danger_flagged', 'http_request', ?, 'flagged', ?, ?)`)
      .run(MARK, runId, MARK);
    db.prepare(`INSERT INTO wire_snapshots (run_id, turn_index, model, provider, system_prompt_hash, user_message, user_message_chars, tool_names, tool_count, max_tokens, ephemeral_tail_present, ephemeral_tail_chars, captured_at)
      VALUES (?, 0, 'm', 'p', 'h', ?, 1, '[]', 0, 1, 0, 0, 0)`).run(runId, MARK);
    // No writer in src today, but the rows name a run and carry the strings a call matched.
    db.prepare(`INSERT INTO pre_approval_sets (id, task_summary, approved_by, patterns_json, max_uses, ttl_ms, run_id) VALUES ('s1', ?, 'owner', ?, 1, 1, ?)`)
      .run(MARK, `["${MARK}"]`, runId);
    db.prepare(`INSERT INTO pre_approval_events (set_id, pattern_idx, tool_name, match_string, pattern, decision, run_id) VALUES ('s1', 0, 'http_request', ?, ?, 'approved', ?)`)
      .run(MARK, MARK, runId);
    // No writer in src today (run-history.ts v10), but its rows name a run and carry text.
    db.prepare(`INSERT INTO advisor_suggestions (run_id, type, priority, title, detail, estimated_impact_json) VALUES (?, 'cost', 'low', ?, ?, ?)`)
      .run(runId, MARK, MARK, `{"note":"${MARK}"}`);
    return runId;
  };

  const tablesHoldingMarker = (): string[] => {
    const db = history.getDb();
    const hits: string[] = [];
    for (const [table, columns] of Object.entries(FALLBACK_CONTENT_COLUMNS)) {
      for (const column of columns) {
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" LIKE ?`).get(`%${MARK}%`) as { n: number }).n;
        if (n > 0) hits.push(`${table}.${column}`);
      }
    }
    return hits;
  };

  const rowCounts = (): Record<string, number> => {
    const db = history.getDb();
    const out: Record<string, number> = {};
    for (const t of CONTENT_TABLES) {
      out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
    }
    return out;
  };

  it('every table of history.db is either one the fallback blanks or named as holding no run content', () => {
    const tables = (history.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect([...CONTENT_TABLES, ...Object.keys(NOT_RUN_CONTENT)].sort()).toEqual(tables);
  });

  it('names every table that holds run content', () => {
    expect(Object.keys(FALLBACK_CONTENT_COLUMNS).sort()).toEqual(CONTENT_TABLES);
  });

  it('every text column of those tables is either blanked or named as kept, never both', () => {
    // A column added later fails here until someone decides which it is.
    const db = history.getDb();
    for (const table of CONTENT_TABLES) {
      const text = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>)
        .filter((c) => /TEXT/i.test(c.type)).map((c) => c.name).sort();
      const blanked = [...(FALLBACK_CONTENT_COLUMNS[table] ?? [])];
      const kept = [...(FALLBACK_KEPT_COLUMNS[table] ?? [])];
      expect(blanked.filter((c) => kept.includes(c)), table).toEqual([]);
      expect([...blanked, ...kept].sort(), table).toEqual(text);
    }
  });

  it('leaves no marker in any content column of the thread\'s runs, and keeps every row and cost', () => {
    const runId = seed();
    expect(tablesHoldingMarker().length).toBeGreaterThan(0); // the seed reaches the columns it checks
    const before = rowCounts();

    blankRunHistoryContent(history.getDb(), { threadIds: ['thread-a'] });

    expect(tablesHoldingMarker()).toEqual([]);
    expect(rowCounts()).toEqual(before);
    const cost = (history.getDb().prepare('SELECT cost_usd FROM runs WHERE id = ?').get(runId) as { cost_usd: number }).cost_usd;
    expect(cost).toBe(0.25);
  });

  it('a raw scan of every text column of history.db finds no marker after the fallback', () => {
    seed();
    blankRunHistoryContent(history.getDb(), { threadIds: ['thread-a'] });
    const db = history.getDb();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    const hits: string[] = [];
    for (const t of tables) {
      const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string; type: string }>).filter((c) => /TEXT/i.test(c.type));
      for (const c of cols) {
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE "${c.name}" LIKE ?`).get(`%${MARK}%`) as { n: number }).n;
        if (n > 0) hits.push(`${t}.${c.name}`);
      }
    }
    expect(hits).toEqual([]);
  });
  it('T5 — blanks to a fixed non-empty marker, keeps what readers count as no content, and keeps every error count', () => {
    const db = history.getDb();
    const runId = history.insertRun({ sessionId: 'thread-a', taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    history.insertToolCall({ runId, toolName: 'http_request', inputJson: `{"v":"${MARK}"}`, outputJson: '', durationMs: 1, sequenceOrder: 0 });
    history.insertToolCall({ runId, toolName: 'http_request', inputJson: `{"v":"${MARK}"}`, outputJson: `failed ${MARK}`, durationMs: 1, sequenceOrder: 1 });
    db.prepare(`INSERT INTO pipeline_runs (id, manifest_name, status, manifest_json, parent_run_id) VALUES ('pr5', 'wf', 'completed', '{}', ?)`).run(runId);
    db.prepare(`INSERT INTO pipeline_step_results (pipeline_run_id, step_id, status, result, error) VALUES ('pr5', 'ok', 'completed', '', NULL), ('pr5', 'bad', 'failed', ?, ?)`).run(MARK, MARK);
    const stats = (): unknown => history.getToolStats('', 3650);
    const stepErrors = (): number => history.getPipelineStepResults('pr5').filter((st) => st.error !== null && st.error !== '').length;
    const before = { stats: stats(), stepErrors: stepErrors() };

    blankRunHistoryContent(db, { threadIds: ['thread-a'] });

    expect({ stats: stats(), stepErrors: stepErrors() }).toEqual(before);
    const outputs = (db.prepare('SELECT output_json AS o FROM run_tool_calls WHERE run_id = ? ORDER BY sequence_order').all(runId) as Array<{ o: string }>).map((r) => r.o);
    expect(outputs).toEqual(['', FALLBACK_MARKER]);
    const steps = db.prepare("SELECT step_id, result, error FROM pipeline_step_results WHERE pipeline_run_id = 'pr5' ORDER BY step_id").all();
    expect(steps).toEqual([{ step_id: 'bad', result: FALLBACK_MARKER, error: FALLBACK_MARKER }, { step_id: 'ok', result: '', error: null }]);
  });

  it('T6 — the raw bytes of history.db and its WAL hold no marker after the fallback', () => {
    seed();
    blankRunHistoryContent(history.getDb(), { threadIds: ['thread-a'] });
    const path = join(dir, 'history.db');
    const bytes = [readFileSync(path), ...(existsSync(`${path}-wal`) ? [readFileSync(`${path}-wal`)] : [])];
    expect(bytes.some((b) => b.includes(MARK))).toBe(false);
    // Positive control: the same read finds a value the fallback did not reach.
    history.insertRun({ sessionId: 'thread-b', taskText: `kept ${MARK}`, modelTier: 'sonnet', modelId: 'm' });
    const after = [readFileSync(path), ...(existsSync(`${path}-wal`) ? [readFileSync(`${path}-wal`)] : [])];
    expect(after.some((b) => b.includes(MARK))).toBe(true);
  });
  it('reaches the runs a run of the thread spawned, which run under their own session', () => {
    const db = history.getDb();
    const parent = history.insertRun({ sessionId: 'thread-a', taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    const child = history.insertRun({ sessionId: 'spawned-session', taskText: `child ${MARK}`, modelTier: 'sonnet', modelId: 'm' });
    db.prepare('UPDATE runs SET spawn_parent_id = ? WHERE id = ?').run(parent, child);
    const other = history.insertRun({ sessionId: 'thread-b', taskText: `other ${MARK}`, modelTier: 'sonnet', modelId: 'm' });
    blankRunHistoryContent(db, { threadIds: ['thread-a'] });
    const text = (id: string): string => (db.prepare('SELECT task_text AS t FROM runs WHERE id = ?').get(id) as { t: string }).t;
    expect(text(child)).toBe(FALLBACK_MARKER);
    expect(text(other)).toBe(`other ${MARK}`);
  });
  it('reaches a workflow the thread started: its step runs, their calls, and a workflow nested in it', () => {
    const db = history.getDb();
    // As the runner writes them (orchestrator/runner.ts): a step run's session and spawn parent are
    // the pipeline run's id; a nested pipeline's parent is the outer pipeline's id.
    db.prepare(`INSERT INTO pipeline_runs (id, manifest_name, status, manifest_json, origin_thread_id) VALUES ('wf-outer', 'wf', 'completed', '{}', 'thread-a')`).run();
    db.prepare(`INSERT INTO pipeline_runs (id, manifest_name, status, manifest_json, parent_run_id) VALUES ('wf-inner', 'wf2', 'completed', '{}', 'wf-outer')`).run();
    const step = history.insertRun({ sessionId: 'wf-outer', taskText: `step ${MARK}`, modelTier: 'sonnet', modelId: 'm', runType: 'pipeline_step', spawnParentId: 'wf-outer' });
    history.insertToolCall({ runId: step, toolName: 'http_request', inputJson: `{"v":"${MARK}"}`, outputJson: '', durationMs: 1, sequenceOrder: 0 });
    const inner = history.insertRun({ sessionId: 'wf-inner', taskText: `inner ${MARK}`, modelTier: 'sonnet', modelId: 'm', runType: 'pipeline_step', spawnParentId: 'wf-inner' });
    const other = history.insertRun({ sessionId: 'wf-other', taskText: `other ${MARK}`, modelTier: 'sonnet', modelId: 'm', runType: 'pipeline_step', spawnParentId: 'wf-other' });
    blankRunHistoryContent(db, { threadIds: ['thread-a'] });
    const text = (id: string): string => (db.prepare('SELECT task_text AS t FROM runs WHERE id = ?').get(id) as { t: string }).t;
    expect([text(step), text(inner)]).toEqual([FALLBACK_MARKER, FALLBACK_MARKER]);
    expect((db.prepare('SELECT input_json AS i FROM run_tool_calls WHERE run_id = ?').get(step) as { i: string }).i).toBe(FALLBACK_MARKER);
    expect(text(other)).toBe(`other ${MARK}`);
  });

  it('a period given in ISO form reaches exactly the runs inside it', () => {
    const db = history.getDb();
    const at = (when: string): string => {
      const id = history.insertRun({ sessionId: 'thread-x', taskText: `run ${MARK}`, modelTier: 'sonnet', modelId: 'm' });
      db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(when, id);
      return id;
    };
    const before = at('2026-09-30 23:59:59');
    const first = at('2026-10-01 00:00:01');
    const last = at('2026-10-01 23:59:59');
    const after = at('2026-10-02 00:00:01');
    blankRunHistoryContent(db, { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' });
    const text = (id: string): string => (db.prepare('SELECT task_text AS t FROM runs WHERE id = ?').get(id) as { t: string }).t;
    expect([before, first, last, after].map(text)).toEqual([`run ${MARK}`, FALLBACK_MARKER, FALLBACK_MARKER, `run ${MARK}`]);
  });
  it('refuses a period it cannot read, instead of blanking nothing and saying done', () => {
    expect(() => blankRunHistoryContent(history.getDb(), { from: 'last week', to: '2026-10-02T00:00:00.000Z' })).toThrow(/period/);
    expect(() => blankRunHistoryContent(history.getDb(), { from: '2026-10-02T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' })).toThrow(/period/);
  });
});

describe('the migration that adds where an epoch starts', () => {
  it('takes the latest beginning grant, not an earlier connection\'s grant minted before the row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-mig-'));
    try {
      const path = join(dir, 'engine.db');
      const db = new EngineDb(path);
      const ledger = new GrantLedger(db.getDb());
      // An earlier connection under the id, removed before the column existed.
      const earlier = ledger.mint('shop', 'api', 'new');
      db.getDb().prepare("UPDATE connection_grants SET minted_at = '2026-01-01 00:00:00' WHERE grant_id = ?").run(earlier);
      // Today's row, written without a grant (an import), which the boot backfill gave one later.
      new ConnectionStore(db).upsert({ id: 'shop', kind: 'api', name: 'shop', subjectId: null, direction: 'outbound', configJson: '{"base_url":"https://shop.example","description":"d"}', vaultKeys: [], status: 'active' });
      db.getDb().prepare("UPDATE connections SET created_at = '2026-03-01 00:00:00' WHERE id = 'shop'").run();
      const backfill = ledger.mint('shop', 'api', 'backfill');
      db.getDb().prepare("UPDATE connection_grants SET minted_at = '2026-03-01 00:00:05' WHERE grant_id = ?").run(backfill);
      db.getDb().prepare("UPDATE connections SET config_json = json_set(config_json, '$.oauth_grant.grant_id', ?) WHERE id = 'shop'").run(backfill);
      db.getDb().exec('ALTER TABLE triggers DROP COLUMN paused_at; ALTER TABLE triggers DROP COLUMN paused_due_at; ALTER TABLE triggers DROP COLUMN paused_for; ALTER TABLE triggers DROP COLUMN pause_noticed_at; DROP INDEX IF EXISTS idx_audit_log_plan_run; ALTER TABLE audit_log DROP COLUMN trail_form; ALTER TABLE audit_log DROP COLUMN plan_run; ALTER TABLE bulk_targets DROP COLUMN unknown_sends; ALTER TABLE bulk_runs DROP COLUMN list_last_id; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DELETE FROM schema_version WHERE version > 48;');
      db.close();

      const migrated = new EngineDb(path);
      expect((migrated.getDb().prepare("SELECT first_grant_id AS g FROM connections WHERE id = 'shop'").get() as { g: string }).g).toBe(backfill);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

