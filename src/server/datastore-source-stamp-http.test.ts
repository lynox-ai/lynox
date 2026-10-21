import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { DataStore, SOURCE_COLUMNS } from '../core/data-store.js';
import { dataStoreInsertTool } from '../tools/builtin/data-store.js';
import type { IAgent } from '../types/index.js';

/**
 * The DataStore's source columns on a real engine (PRD connection-attribution A5).
 *
 * What only a boot shows: that `Engine.init` adds the columns to a table an older build
 * created, which no DataStore constructor does. What only the routes show: that the
 * table route leaves the columns out and the export keeps them.
 */
describe('DataStore source columns on a real engine', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret
  // scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];

  const dataStoreOf = (): DataStore => {
    const ds = (api as unknown as { engine: { getDataStore: () => DataStore | null } }).engine.getDataStore();
    if (ds === null) throw new Error('fixture: no data store');
    return ds;
  };
  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-ds-stamp-http-'));
    // What an older build left: a collection without the source columns, with one row.
    const seed = new DataStore(join(dir, 'datastore.db'));
    seed.close();
    const raw = new Database(join(dir, 'datastore.db'));
    raw.exec('CREATE TABLE "ds_legacy" (_id INTEGER PRIMARY KEY AUTOINCREMENT, _created_at TEXT NOT NULL, _updated_at TEXT NOT NULL, "v" TEXT)');
    raw.prepare("INSERT INTO ds_collections (name, scope_type, scope_id, schema_json, unique_key, record_count, created_at, updated_at) VALUES ('legacy', 'global', '', ?, NULL, 1, 'x', 'x')")
      .run(JSON.stringify([{ name: 'v', type: 'string' }]));
    raw.prepare("INSERT INTO ds_legacy (_created_at, _updated_at, v) VALUES ('x', 'x', 'old')").run();
    raw.close();

    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  }, 120_000);

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('the boot adds the columns to an older table, keeps its row NULL, and it takes stamped writes', () => {
    const ds = dataStoreOf();
    const db = ds['db'] as Database.Database;
    const cols = (db.prepare('SELECT name FROM pragma_table_info(?)').all('ds_legacy') as Array<{ name: string }>).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([...SOURCE_COLUMNS]));
    ds.insertRecords({ collection: 'legacy', records: [{ v: 'new' }], stamp: { grants: ['g-a'], runId: 'run-1' } });
    expect(db.prepare('SELECT v, _source_grants, _source_run_id FROM ds_legacy ORDER BY _id').all()).toEqual([
      { v: 'old', _source_grants: null, _source_run_id: null },
      { v: 'new', _source_grants: '["g-a"]', _source_run_id: 'run-1' },
    ]);
  });

  it('data_store_insert in a real Session writes the thread\'s grant set', async () => {
    const engine = (api as unknown as { engine: { createSession: (o: { sessionId: string }) => unknown } }).engine;
    const session = engine.createSession({ sessionId: 'stamp-thread' });
    const agent = (session as { agent: IAgent }).agent;
    // What a fetch through a grant adds (K7's seat); here added directly.
    agent.conversationGrants!.add('g-session');
    const ds = dataStoreOf();
    ds.createCollection({ name: 'from_chat', scope: { type: 'global', id: '' }, columns: [{ name: 'v', type: 'string' }] });
    await dataStoreInsertTool.handler({ collection: 'from_chat', records: [{ v: 'x' }] }, agent);
    expect(ds.listRecordsForExport({ collection: 'from_chat', limit: 10 })).toEqual([
      expect.objectContaining({ v: 'x', _source_grants: '["g-session"]' }),
    ]);
  });

  it('GET /api/datastore/:collection leaves the source columns out', async () => {
    const ds = dataStoreOf();
    ds.createCollection({ name: 'stamped', scope: { type: 'global', id: '' }, columns: [{ name: 'v', type: 'string' }] });
    ds.insertRecords({ collection: 'stamped', records: [{ v: 'x' }], stamp: { grants: ['g-b'], runId: 'run-2' } });
    const body = await get('/api/datastore/stamped') as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ v: 'x' });
    for (const col of SOURCE_COLUMNS) expect(body.rows[0]).not.toHaveProperty(col);
  });

  it('GET /api/export keeps the source columns', async () => {
    const body = await get('/api/export') as { datastore: Record<string, Array<Record<string, unknown>>> };
    expect(body.datastore['stamped']).toEqual([expect.objectContaining({ v: 'x', _source_grants: '["g-b"]', _source_run_id: 'run-2' })]);
    expect(body.datastore['legacy']).toEqual([
      expect.objectContaining({ v: 'old', _source_grants: null, _source_run_id: null }),
      expect.objectContaining({ v: 'new', _source_grants: '["g-a"]' }),
    ]);
  });
});
