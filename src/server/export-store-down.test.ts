import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { EngineDb } from '../core/engine-db.js';
import { SubjectStore } from '../core/subject-store.js';
import { KnowledgeStore } from '../core/knowledge-store.js';

/**
 * The engine opens its stores at boot and goes on without each one whose open fails. The
 * export then wrote that store's blocks empty and marked complete: a copy that says "nothing
 * here, nothing missing" about data it never read. On a real engine, with the stores' files
 * made unopenable before boot, because the null store is the engine's own reaction to the
 * failure, not something a mock decides.
 */
type ExportBody = {
  contacts: unknown[]; contacts_may_be_incomplete: boolean;
  deals: unknown[]; deals_may_be_incomplete: boolean;
  datastore: Record<string, unknown[]>; datastore_may_be_incomplete: boolean;
  threads: unknown[]; threads_may_be_incomplete: boolean;
  durable_knowledge: {
    entries: Array<{ text: string }>; pending_entries: unknown[]; sources: unknown[];
    blocks: Record<string, string | null>; may_be_incomplete: boolean;
  };
};

type EngineView = {
  getCRM: () => unknown;
  getDataStore: () => unknown;
  getThreadStore: () => unknown;
  getKnowledgeStore: () => unknown;
  getUserConfig: () => { durable_memory_enabled?: boolean | undefined };
  getEngineDb: () => unknown;
  _crm: unknown;
};

const ENV = [
  'LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY',
  'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_DURABLE_MEMORY_ENABLED',
];

function harness(prepare: (dir: string) => void, durableMemory: boolean) {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret
  // scan looks for, and this repo is public.
  const secret = `t-${randomBytes(12).toString('hex')}`;
  const saved: Record<string, string | undefined> = {};
  const state: { api?: LynoxHTTPApi; baseUrl?: string; dir?: string } = {};

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-export-down-'));
    state.dir = dir;
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = secret;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = durableMemory ? 'true' : 'false';
    reloadConfig();
    prepare(dir);
    const api = new LynoxHTTPApi();
    state.api = api;
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    state.baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  }, 120_000);

  afterAll(async () => {
    try {
      await state.api?.shutdown();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (state.dir !== undefined) rmSync(state.dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  const engine = (): EngineView => (state.api as unknown as { engine: EngineView }).engine;

  const exportBody = async (): Promise<ExportBody> => {
    const res = await fetch(`${state.baseUrl!}/api/export`, { headers: { Authorization: `Bearer ${secret}` } });
    expect(res.status).toBe(200);
    return await res.json() as ExportBody;
  };

  return { engine, exportBody };
}

describe('export with the stores down at boot (real engine)', () => {
  // A directory where each store's file belongs: it cannot be opened at all. The engine
  // boots without a DataStore (so without a CRM), without its history database (so without a
  // thread store) and without engine.db (so without the durable knowledge store, switched on
  // here).
  const h = harness((dir) => {
    for (const file of ['datastore.db', 'history.db', 'engine.db']) mkdirSync(join(dir, file));
  }, true);

  it('marks contacts, deals, the DataStore, threads and durable knowledge incomplete', async () => {
    expect(h.engine().getDataStore(), 'fixture: the store must have failed to open').toBeNull();
    expect(h.engine().getCRM(), 'fixture: no CRM without a store').toBeNull();
    expect(h.engine().getThreadStore(), 'fixture: no thread store without its database').toBeNull();
    expect(h.engine().getUserConfig().durable_memory_enabled, 'fixture: durable memory switched on').toBe(true);
    expect(h.engine().getKnowledgeStore(), 'fixture: no knowledge store without engine.db').toBeNull();

    const body = await h.exportBody();
    expect(body.contacts).toEqual([]);
    expect(body.deals).toEqual([]);
    expect(body.datastore).toEqual({});
    expect(body.threads).toEqual([]);
    expect(body.durable_knowledge.entries).toEqual([]);
    expect(body.contacts_may_be_incomplete, 'contacts were not read, not absent').toBe(true);
    expect(body.deals_may_be_incomplete, 'deals were not read, not absent').toBe(true);
    expect(body.datastore_may_be_incomplete, 'the DataStore was not read, not empty').toBe(true);
    expect(body.threads_may_be_incomplete, 'threads were not read, not absent').toBe(true);
    expect(body.durable_knowledge.may_be_incomplete, 'switched on but not read').toBe(true);
  }, 60_000);
});

describe('export with every store open, durable memory off, then the CRM gone (real engine)', () => {
  const h = harness(() => {}, false);

  it('leaves durable knowledge and threads unmarked when nothing failed', async () => {
    expect(h.engine().getUserConfig().durable_memory_enabled, 'fixture: durable memory off').toBe(false);
    expect(h.engine().getKnowledgeStore(), 'fixture: no store while it is off').toBeNull();
    expect(h.engine().getThreadStore(), 'fixture: the thread store opened').not.toBeNull();

    const body = await h.exportBody();
    expect(body.durable_knowledge.entries).toEqual([]);
    expect(body.durable_knowledge.may_be_incomplete, 'off: no store was opened, so nothing failed').toBe(false);
    expect(body.threads_may_be_incomplete, 'the thread store opened and was read').toBe(false);
  }, 60_000);

  it('marks contacts and deals incomplete and leaves the readable DataStore block complete', async () => {
    expect(h.engine().getDataStore(), 'fixture: the store opened').not.toBeNull();
    // What the engine's CRM init leaves behind when it throws.
    h.engine()._crm = null;
    expect(h.engine().getCRM()).toBeNull();

    const body = await h.exportBody();
    expect(body.contacts_may_be_incomplete).toBe(true);
    expect(body.deals_may_be_incomplete).toBe(true);
    expect(body.datastore_may_be_incomplete, 'the store itself was read in full').toBe(false);
  }, 60_000);
});

describe('export with durable memory switched off after it held entries (real engine)', () => {
  // Written while it was on: an entry and a memory block in engine.db, by the store the engine
  // builds when the setting is on. The engine then boots with it off and opens no store.
  const h = harness((dir) => {
    const db = new EngineDb(join(dir, 'engine.db'));
    const store = new KnowledgeStore(db, new SubjectStore(db), null);
    store.write({ text: 'ACME renews in March', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    store.setBlockContent('profile', 'Runs a small bakery');
    // Built at runtime, like the secret above: a key-shaped literal is what the commit scan reads.
    store.setBlockContent('playbook', `Never paste ${['sk', 'ant', 'api03'].join('-')}-${'Q'.repeat(40)} into a rule.`);
    // The full store ran its backfill; set it back, so a read that ran it again would show.
    db.getDb().prepare('UPDATE profile_seed_backfill SET done = 0 WHERE id = 1').run();
    db.close();
  }, false);

  it('carries the entries and blocks it still holds, unmarked', async () => {
    expect(h.engine().getUserConfig().durable_memory_enabled, 'fixture: durable memory off').toBe(false);
    expect(h.engine().getKnowledgeStore(), 'fixture: no store while it is off').toBeNull();

    const body = await h.exportBody();
    expect(body.durable_knowledge.entries.map((e) => e.text)).toEqual(['ACME renews in March']);
    expect(body.durable_knowledge.blocks['profile']).toBe('Runs a small bakery');
    expect(body.durable_knowledge.blocks['playbook'], 'a key in a block is masked').not.toContain('Q'.repeat(40));
    expect(body.durable_knowledge.blocks['playbook']).toContain('***');
    expect(body.durable_knowledge.may_be_incomplete, 'read in full').toBe(false);
    const db = h.engine().getEngineDb() as EngineDb;
    expect((db.getDb().prepare('SELECT done FROM profile_seed_backfill WHERE id = 1').get() as { done: number }).done, 'the export wrote nothing').toBe(0);
  }, 60_000);

  it('marks the block incomplete when the read fails', async () => {
    const view = h.engine();
    const real = view.getEngineDb;
    view.getEngineDb = () => ({ getDb: () => { throw new Error('closed'); } });
    try {
      const body = await h.exportBody();
      expect(body.durable_knowledge.entries).toEqual([]);
      expect(body.durable_knowledge.may_be_incomplete, 'not read').toBe(true);
    } finally {
      view.getEngineDb = real;
    }
  }, 60_000);
});

describe('export with durable memory off and engine.db unopenable (real engine)', () => {
  const h = harness((dir) => { mkdirSync(join(dir, 'engine.db')); }, false);

  it('marks durable knowledge incomplete: the tables were not read', async () => {
    expect(h.engine().getEngineDb(), 'fixture: engine.db failed to open').toBeNull();
    const body = await h.exportBody();
    expect(body.durable_knowledge.entries).toEqual([]);
    expect(body.durable_knowledge.may_be_incomplete).toBe(true);
  }, 60_000);
});
