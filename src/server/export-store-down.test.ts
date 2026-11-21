import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { EXPORT_RELATIONS_PER_ENTITY } from '../core/knowledge-layer.js';
import { SecretStore } from '../core/secret-store.js';

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
  durable_knowledge: { entries: unknown[]; may_be_incomplete: boolean };
  knowledge_graph: { entities: unknown[]; relationships: unknown[] }; knowledge_graph_may_be_incomplete: boolean;
  secrets: string[]; secrets_may_be_incomplete: boolean; secrets_note: string;
  set_aside_databases?: Array<{ database: string; files: string[] }>;
  set_aside_databases_unknown?: string;
};

type EngineView = {
  getCRM: () => unknown;
  getDataStore: () => unknown;
  getThreadStore: () => unknown;
  getKnowledgeStore: () => unknown;
  getKnowledgeLayer: () => unknown;
  getSecretStore: () => unknown;
  getUserConfig: () => { durable_memory_enabled?: boolean | undefined; knowledge_graph_enabled?: boolean | undefined; subject_graph_enabled?: boolean | undefined };
  _crm: unknown;
  knowledgeLayer: unknown;
  secretStore: unknown;
  secretVault: { set: (name: string, value: string) => void; delete: (name: string) => boolean } | null;
};

const ENV = [
  'LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY',
  'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_DURABLE_MEMORY_ENABLED', 'LYNOX_SUBJECT_GRAPH_ENABLED',
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
    delete process.env['LYNOX_SUBJECT_GRAPH_ENABLED'];
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

  return { engine, exportBody, baseUrl: () => state.baseUrl!, secret, dir: () => state.dir! };
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

  it('marks the knowledge graph incomplete when it is missing without being switched off', async () => {
    expect(h.engine().getUserConfig().knowledge_graph_enabled, 'fixture: not switched off').not.toBe(false);
    expect(h.engine().getKnowledgeLayer(), 'fixture: no layer without the history database').toBeNull();

    const body = await h.exportBody();
    expect(body.knowledge_graph).toEqual({ entities: [], relationships: [] });
    expect(body.knowledge_graph_may_be_incomplete, 'the graph was not read, not empty').toBe(true);
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
    expect(body.set_aside_databases, 'nothing was set aside').toBeUndefined();
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

  it('leaves the knowledge graph and the secret names unmarked when both were read, and says values are not exported', async () => {
    expect(h.engine().getSecretStore(), 'fixture: the secret store opened').not.toBeNull();
    expect(h.engine().getKnowledgeLayer(), 'fixture: the knowledge graph opened').not.toBeNull();
    const body = await h.exportBody();
    expect(body.secrets_may_be_incomplete, 'the secret store was read').toBe(false);
    expect(body.secrets_note).toBe('Names of the stored secrets only. Their values are not exported.');
    expect(body.knowledge_graph_may_be_incomplete, 'the graph was read in full').toBe(false);
  }, 60_000);

  it('marks the knowledge graph incomplete when reading it throws', async () => {
    const saved = h.engine().knowledgeLayer;
    // A layer whose first read throws, as a corrupt or locked database does.
    h.engine().knowledgeLayer = {
      listEntities: () => Promise.reject(new Error('read failed')),
      stats: () => Promise.reject(new Error('read failed')),
      getEntityRelationsForExport: () => Promise.reject(new Error('read failed')),
    };
    try {
      const body = await h.exportBody();
      expect(body.knowledge_graph).toEqual({ entities: [], relationships: [] });
      expect(body.knowledge_graph_may_be_incomplete, 'the graph threw, it was not read').toBe(true);
    } finally {
      h.engine().knowledgeLayer = saved;
    }
  }, 60_000);

  it('marks the knowledge graph incomplete when an entity returns the per-entity relation cap', async () => {
    const saved = h.engine().knowledgeLayer;
    const rel = (i: number) => ({ fromEntityId: 'a', toEntityId: `b${String(i)}`, relationType: 'knows', sourceMemoryId: `m${String(i)}`, sourceDeleted: false });
    const stub = (count: number) => ({
      readFallbackCount: 0,
      subjectGraphUnavailable: false,
      listEntities: ({ offset }: { offset: number }) => Promise.resolve(offset === 0 ? [{ id: 'a' }] : []),
      stats: () => Promise.resolve({}),
      getEntityRelationsForExport: () => Promise.resolve(Array.from({ length: count }, (_, i) => rel(i))),
    });
    try {
      h.engine().knowledgeLayer = stub(EXPORT_RELATIONS_PER_ENTITY - 1);
      const under = await h.exportBody();
      expect(under.knowledge_graph.relationships).toHaveLength(EXPORT_RELATIONS_PER_ENTITY - 1);
      expect(under.knowledge_graph_may_be_incomplete, 'below the cap, every relation was read').toBe(false);

      h.engine().knowledgeLayer = stub(EXPORT_RELATIONS_PER_ENTITY);
      const at = await h.exportBody();
      expect(at.knowledge_graph.relationships).toHaveLength(EXPORT_RELATIONS_PER_ENTITY);
      expect(at.knowledge_graph_may_be_incomplete, 'at the cap, the entity may hold more').toBe(true);
    } finally {
      h.engine().knowledgeLayer = saved;
    }
  }, 60_000);

  it('lists a secret written to the vault after boot by name, not by value', async () => {
    const vault = h.engine().secretVault;
    expect(vault, 'fixture: the vault opened').not.toBeNull();
    // Written past the store's map, as mail credentials and OAuth tokens are.
    const value = `v-${randomBytes(12).toString('hex')}`;
    vault!.set('LATE_VAULT_ROW', value);
    try {
      const res = await fetch(`${h.baseUrl()}/api/export`, { headers: { Authorization: `Bearer ${h.secret}` } });
      const text = await res.text();
      const body = JSON.parse(text) as ExportBody;
      expect(body.secrets).toContain('LATE_VAULT_ROW');
      expect(text.includes(value), 'the value is not exported').toBe(false);
      expect(body.secrets_may_be_incomplete).toBe(false);
    } finally {
      vault!.delete('LATE_VAULT_ROW');
    }
  }, 60_000);

  it('marks the secret names incomplete when the store has no vault', async () => {
    const saved = h.engine().secretStore;
    // What a vault that does not open at boot leaves behind: the store, built without it.
    h.engine().secretStore = new SecretStore(h.engine().getUserConfig() as never);
    try {
      const body = await h.exportBody();
      expect(body.secrets_may_be_incomplete, 'the vault file was not read').toBe(true);
    } finally {
      h.engine().secretStore = saved;
    }
  }, 60_000);

  it('marks the secret names incomplete when reading the vault file throws', async () => {
    const store = h.engine().secretStore as { listVaultNames: () => string[] };
    const original = store.listVaultNames;
    store.listVaultNames = () => { throw new Error('read failed'); };
    try {
      const body = await h.exportBody();
      expect(body.secrets_may_be_incomplete, 'the vault file was not read').toBe(true);
    } finally {
      store.listVaultNames = original;
    }
  }, 60_000);

  it('marks the knowledge graph incomplete when a read falls back to the legacy store', async () => {
    const saved = h.engine().knowledgeLayer;
    let fallbacks = 0;
    h.engine().knowledgeLayer = {
      get readFallbackCount() { return fallbacks; },
      subjectGraphUnavailable: false,
      // The subject graph threw and the legacy store answered instead.
      listEntities: () => { fallbacks += 1; return Promise.resolve([]); },
      stats: () => Promise.resolve({}),
      getEntityRelationsForExport: () => Promise.resolve([]),
    };
    try {
      const body = await h.exportBody();
      expect(body.knowledge_graph_may_be_incomplete, 'a fallback read may be partial').toBe(true);
      fallbacks = 0;
      h.engine().knowledgeLayer = {
        get readFallbackCount() { return 3; },
        subjectGraphUnavailable: false,
        listEntities: () => Promise.resolve([]),
        stats: () => Promise.resolve({}),
        getEntityRelationsForExport: () => Promise.resolve([]),
      };
      const steady = await h.exportBody();
      expect(steady.knowledge_graph_may_be_incomplete, 'fallbacks before the export do not count').toBe(false);
    } finally {
      h.engine().knowledgeLayer = saved;
    }
  }, 60_000);

  it('marks the knowledge graph incomplete when the subject graph is on without its store', async () => {
    const saved = h.engine().knowledgeLayer;
    h.engine().knowledgeLayer = {
      readFallbackCount: 0,
      subjectGraphUnavailable: true,
      listEntities: () => Promise.resolve([]),
      stats: () => Promise.resolve({}),
      getEntityRelationsForExport: () => Promise.resolve([]),
    };
    try {
      const body = await h.exportBody();
      expect(body.knowledge_graph_may_be_incomplete, 'only the legacy store was read').toBe(true);
    } finally {
      h.engine().knowledgeLayer = saved;
    }
  }, 60_000);

  it('marks the secret names incomplete when the secret store is unavailable', async () => {
    const saved = h.engine().secretStore;
    // What a failed open at boot leaves behind: there is no switch that turns the store off.
    h.engine().secretStore = null;
    try {
      const body = await h.exportBody();
      expect(body.secrets).toEqual([]);
      expect(body.secrets_may_be_incomplete, 'the store was not read, not empty').toBe(true);
    } finally {
      h.engine().secretStore = saved;
    }
  }, 60_000);
});

describe('export with the knowledge graph switched off (real engine)', () => {
  // Switched off the way a user does it, in config.json, so the engine boots without the layer.
  const h = harness((dir) => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ knowledge_graph_enabled: false }));
  }, false);

  it('leaves the empty knowledge graph unmarked, since nothing was opened and nothing failed', async () => {
    expect(h.engine().getUserConfig().knowledge_graph_enabled, 'fixture: switched off').toBe(false);
    expect(h.engine().getKnowledgeLayer(), 'fixture: no layer while it is off').toBeNull();

    const body = await h.exportBody();
    expect(body.knowledge_graph).toEqual({ entities: [], relationships: [] });
    expect(body.knowledge_graph_may_be_incomplete, 'off: no layer was opened, so nothing failed').toBe(false);
  }, 60_000);
});

/** Bytes that are not an SQLite database: the boot's open finds them corrupt and sets the file aside. */
function corrupt(dir: string, file: string): void {
  writeFileSync(join(dir, file), Buffer.from('not a database '.repeat(512)));
}
const IS_ROOT = process.getuid?.() === 0;

describe('export after the boot set a corrupt history.db aside (real engine)', () => {
  const h = harness((dir) => corrupt(dir, 'history.db'), true);

  it('names the set-aside file and marks the threads incomplete, not durable knowledge or the knowledge graph', async () => {
    const setAside = readdirSync(h.dir()).filter((f) => /^history\.db\.corrupt-\d+$/.test(f));
    expect(setAside, 'fixture: the boot set history.db aside').toHaveLength(1);
    expect(h.engine().getThreadStore(), 'fixture: an empty thread store opened in its place').not.toBeNull();

    const body = await h.exportBody();
    expect(body.set_aside_databases).toEqual([{ database: 'history.db', files: setAside }]);
    expect(body.threads).toEqual([]);
    expect(body.threads_may_be_incomplete, 'the old threads are in the set-aside file').toBe(true);
    expect(body.durable_knowledge.may_be_incomplete, 'engine.db was not set aside').toBe(false);
    expect(body.knowledge_graph_may_be_incomplete, 'the graph is not read from history.db').toBe(false);
  }, 60_000);
});

describe('export after the boot set a corrupt engine.db aside (real engine)', () => {
  const h = harness((dir) => corrupt(dir, 'engine.db'), true);

  it('names the set-aside file and marks durable knowledge incomplete, not the threads or the legacy knowledge graph', async () => {
    const setAside = readdirSync(h.dir()).filter((f) => /^engine\.db\.corrupt-\d+$/.test(f));
    expect(setAside, 'fixture: the boot set engine.db aside').toHaveLength(1);
    expect(h.engine().getKnowledgeStore(), 'fixture: an empty knowledge store opened in its place').not.toBeNull();
    expect(h.engine().getUserConfig().subject_graph_enabled, 'fixture: the graph reads agent-memory.db').not.toBe(true);

    const body = await h.exportBody();
    expect(body.set_aside_databases).toEqual([{ database: 'engine.db', files: setAside }]);
    expect(body.durable_knowledge.may_be_incomplete, 'the old entries are in the set-aside file').toBe(true);
    expect(body.threads_may_be_incomplete, 'history.db was not set aside').toBe(false);
    expect(body.knowledge_graph_may_be_incomplete, 'with the subject graph off the graph is not read from engine.db').toBe(false);
  }, 60_000);

  it.skipIf(IS_ROOT)('marks every block of every database when the data directory cannot be listed', async () => {
    const dir = h.dir();
    chmodSync(dir, 0o300);
    try {
      expect(() => readdirSync(dir), 'fixture: the directory cannot be listed').toThrow();
      const body = await h.exportBody();
      expect(body.set_aside_databases_unknown).toBeDefined();
      expect(body.threads_may_be_incomplete).toBe(true);
      expect(body.knowledge_graph_may_be_incomplete).toBe(true);
      expect(body.durable_knowledge.may_be_incomplete).toBe(true);
      expect(body.contacts_may_be_incomplete).toBe(true);
      expect(body.deals_may_be_incomplete).toBe(true);
      expect(body.datastore_may_be_incomplete).toBe(true);
    } finally {
      chmodSync(dir, 0o700);
    }
  }, 60_000);
});

describe('export with a restore\'s set-aside datastore.db and agent-memory.db left in the data directory (real engine)', () => {
  // A restore sets the database it replaces aside under the boot's name; the stores open on the
  // restored files.
  const h = harness((dir) => {
    writeFileSync(join(dir, 'datastore.db.corrupt-100'), '');
    writeFileSync(join(dir, 'agent-memory.db.corrupt-100'), '');
  }, false);

  it('names both and marks contacts, deals, tables and the knowledge graph incomplete, not the threads', async () => {
    expect(h.engine().getDataStore(), 'fixture: the store opened').not.toBeNull();
    expect(h.engine().getKnowledgeLayer(), 'fixture: the graph opened').not.toBeNull();

    const body = await h.exportBody();
    expect(body.set_aside_databases).toEqual([
      { database: 'agent-memory.db', files: ['agent-memory.db.corrupt-100'] },
      { database: 'datastore.db', files: ['datastore.db.corrupt-100'] },
    ]);
    expect(body.contacts_may_be_incomplete).toBe(true);
    expect(body.deals_may_be_incomplete).toBe(true);
    expect(body.datastore_may_be_incomplete).toBe(true);
    expect(body.knowledge_graph_may_be_incomplete).toBe(true);
    expect(body.threads_may_be_incomplete, 'history.db was not set aside').toBe(false);
  }, 60_000);
});

describe('export with a set-aside engine.db while the subject graph is on (real engine)', () => {
  // With the subject graph on, the knowledge graph block is read from engine.db.
  const h = harness((dir) => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ subject_graph_enabled: true }));
    writeFileSync(join(dir, 'engine.db.corrupt-100'), '');
  }, false);

  it('marks the knowledge graph incomplete as well', async () => {
    expect(h.engine().getUserConfig().subject_graph_enabled, 'fixture: the subject graph is on').toBe(true);

    const body = await h.exportBody();
    expect(body.set_aside_databases).toEqual([{ database: 'engine.db', files: ['engine.db.corrupt-100'] }]);
    expect(body.knowledge_graph_may_be_incomplete).toBe(true);
    expect(body.durable_knowledge.may_be_incomplete).toBe(true);
  }, 60_000);
});
