import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { CRM } from '../core/crm.js';
import type { DataStore } from '../core/data-store.js';
import { TEST_STAMP } from '../../tests/helpers/row-stamp.js';

/**
 * The export read contacts, deals and every DataStore collection once through the store's
 * listing, which caps at 500 rows — so an Art. 15 copy of a CRM with 1 201 contacts held
 * 500 of them and said nothing about the rest. Seeded past several pages on a real engine,
 * because the cap lived in the store, not in the route: a mock would have served whatever
 * page size the test chose.
 */
describe('Art. 15 export carries every contact, deal and DataStore row (real engine)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret
  // scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const CONTACTS = 1201;   // past two full pages, so a walk that stops after one page is caught
  const DEALS = 501;       // one past a page: the smallest count the old cap dropped a row from
  const ROWS = 501;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];

  const engineOf = (): { getCRM: () => CRM | null; getDataStore: () => DataStore | null } =>
    (api as unknown as { engine: { getCRM: () => CRM | null; getDataStore: () => DataStore | null } }).engine;

  /** Insert in batches the store accepts (its per-call maximum is 1 000). */
  const insertAll = (ds: DataStore, collection: string, records: Record<string, unknown>[]): void => {
    for (let i = 0; i < records.length; i += 1000) {
      const res = ds.insertRecords({ collection, records: records.slice(i, i + 1000), stamp: TEST_STAMP });
      expect(res.errors, 'fixture: every row must land').toEqual([]);
    }
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-export-crm-'));
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

  it('exports all of them, each once, and marks nothing incomplete', async () => {
    const crm = engineOf().getCRM();
    const ds = engineOf().getDataStore();
    if (crm === null || ds === null) throw new Error('fixture: no CRM or data store');
    crm.ensureSchema();
    insertAll(ds, 'contacts', Array.from({ length: CONTACTS }, (_, i) => ({ name: `Contact ${i}`, email: `c${i}@example.invalid` })));
    insertAll(ds, 'deals', Array.from({ length: DEALS }, (_, i) => ({ title: `Deal ${i}`, contact_name: `Contact ${i}`, stage: 'lead' })));
    ds.createCollection({ name: 'many_rows', scope: { type: 'global', id: '' }, columns: [{ name: 'n', type: 'number' }] });
    insertAll(ds, 'many_rows', Array.from({ length: ROWS }, (_, i) => ({ n: i })));

    const res = await fetch(`${baseUrl}/api/export`, { headers: { Authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      contacts: Array<{ email: string }>; contacts_may_be_incomplete: boolean;
      deals: Array<{ title: string }>; deals_may_be_incomplete: boolean;
      datastore: Record<string, Array<{ n?: number }>>; datastore_may_be_incomplete: boolean;
    };

    // The SET, not only the count: a walk that repeats one page and drops another has the
    // right length.
    expect(new Set(body.contacts.map(c => c.email)).size).toBe(CONTACTS);
    expect(body.contacts).toHaveLength(CONTACTS);
    expect(new Set(body.deals.map(d => d.title)).size).toBe(DEALS);
    expect(body.deals).toHaveLength(DEALS);
    expect(new Set(body.datastore['many_rows']!.map(r => r.n)).size).toBe(ROWS);
    expect(body.datastore['many_rows']).toHaveLength(ROWS);
    // The CRM's own collections reach the DataStore block through the same walk.
    expect(body.datastore['contacts']).toHaveLength(CONTACTS);

    expect(body.contacts_may_be_incomplete).toBe(false);
    expect(body.deals_may_be_incomplete).toBe(false);
    expect(body.datastore_may_be_incomplete).toBe(false);
  }, 60_000);
});
