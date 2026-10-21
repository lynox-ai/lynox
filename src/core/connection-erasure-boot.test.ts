import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore } from './api-store.js';
import { RunHistory } from './run-history.js';
import { reloadConfig } from './config.js';
import { erasureRecords } from './connection-erasure.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The boot-wiring proof for erasure by connection, cut 1 (PRD-SOURCE-CONNECTION R8-3).
 *
 * `connection-erasure.test.ts` proves the covered set, the sweep and the fallback with the
 * databases handed in. What only a real boot shows: that `Engine.init` carries an engine.db from
 * before the record table to it and gives an existing connection the grant its epoch starts at,
 * that the delete reaches the sweep the boot wired into the tool context, and that the boot
 * itself sweeps a row that landed while no process ran.
 */
describe('Engine boot — erasure by connection', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  let prevDataDir: string | undefined;

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    vi.restoreAllMocks();
    reloadConfig();
  });

  async function boot(dir: string): Promise<Engine> {
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  const rowsOf = (dir: string, grantId: string): number => {
    const h = new RunHistory(join(dir, 'history.db'));
    try {
      return (h.getDb().prepare('SELECT COUNT(*) AS n FROM run_tool_calls WHERE grant_id = ?').get(grantId) as { n: number }).n;
    } finally {
      h.close();
    }
  };
  const landCall = (dir: string, grantId: string): void => {
    const h = new RunHistory(join(dir, 'history.db'));
    const runId = h.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
    h.insertToolCall({ runId, toolName: 'http_request', inputJson: '{}', outputJson: '', durationMs: 1, sequenceOrder: 0, connectionId: 'shop', grantId });
    h.updateRun(runId, { status: 'completed' });
    h.close();
  };

  it('an engine.db from before the record table erases through the boot\'s wiring, and the next boot sweeps a late row', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-boot-'));
    dirs.push(dir);

    // What a previous process left: a connection with a grant, on an engine.db from before v48.
    const before = new EngineDb(join(dir, 'engine.db'));
    const conn = new ConnectionStore(before);
    const store = new ApiStore();
    store.loadFromConnections(conn);
    store.setConnectionStore(conn);
    store.setGrantLedger(new GrantLedger(before.getDb()));
    expect(store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } }).ok).toBe(true);
    const grant = store.get('shop')!.oauth_grant!.grant_id!;
    before.getDb().exec('DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DELETE FROM schema_version WHERE version > 47;');
    before.close();
    landCall(dir, grant);

    const engine = await boot(dir);
    const db = engine.getEngineDb()!.getDb();
    expect((db.prepare("SELECT first_grant_id AS g FROM connections WHERE id = 'shop'").get() as { g: string | null }).g).toBe(grant);

    // The delete as the api_setup tool runs it: the store's removal, then the context's sweep.
    expect(engine.getApiStore()!.remove('shop', undefined, { record: 'erasure' })).toBe(true);
    // Every grant of the connection: the one it was created with, and any the boot minted since.
    const ledger = (db.prepare("SELECT grant_id AS g, reason FROM connection_grants WHERE connection_id = 'shop' ORDER BY rowid").all() as Array<{ g: string; reason: string }>);
    expect(ledger[0]).toEqual({ g: grant, reason: 'new' });
    // ...those with a host snapshot (R8-2).
    const withHosts = ledger.map((l) => l.g).filter((g) => db.prepare('SELECT 1 FROM connection_grant_hosts WHERE grant_id = ?').get(g) !== undefined);
    expect(erasureRecords(db, 'shop').map((r) => [r.kind, r.coveredGrants, r.historyState])).toEqual([['erasure', withHosts, 'pending']]);
    const sweep = engine.getToolContext().connectionErasureSweep;
    expect(sweep).not.toBeNull();
    sweep!();
    expect(rowsOf(dir, grant)).toBe(0);
    expect(erasureRecords(db, 'shop')[0]!.historyState).toBe('done');
    // The audit rows of R8-3, written by the engine's sweep under the owner: ids and states only.
    const audit = db.prepare("SELECT actor_kind AS a, target AS t, phase AS p FROM audit_log WHERE action = 'connection.erasure.run-history' ORDER BY rowid").all();
    expect(audit).toEqual([{ a: 'owner', t: 'shop pending', p: 'attempt' }, { a: 'owner', t: 'shop done', p: 'done' }]);
    await engine.shutdown();
    engines.length = 0;

    // A call that lands while no process runs is swept by the next boot.
    landCall(dir, grant);
    expect(rowsOf(dir, grant)).toBe(1);
    await boot(dir);
    expect(rowsOf(dir, grant)).toBe(0);
  }, 30_000); // two engine boots: under a loaded box one took past the default 10 s
});
