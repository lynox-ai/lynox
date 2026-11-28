import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { EXPORT_RELATIONS_PER_ENTITY } from '../core/knowledge-layer.js';
import { MEMORY_TEXTS_RELATIONSHIPS_NOTE } from '../core/graph-export.js';
import { SecretStore } from '../core/secret-store.js';
import { EngineDb } from '../core/engine-db.js';
import { SubjectStore } from '../core/subject-store.js';
import { RelationshipStore } from '../core/relationship-store.js';
import { KnowledgeStore } from '../core/knowledge-store.js';
import Database from 'better-sqlite3';
import { AgentMemoryDb } from '../core/agent-memory-db.js';

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
    blocks: Record<string, string | null>; may_be_incomplete: boolean; enabled: boolean;
  };
  knowledge_graph: { entities: unknown[]; relationships: unknown[]; enabled: boolean; memories?: MemoryTexts }; knowledge_graph_may_be_incomplete: boolean;
  secrets: string[]; secrets_may_be_incomplete: boolean; secrets_note: string;
  set_aside_databases?: Array<{ database: string; files: string[] }>;
  set_aside_databases_unknown?: string;
};

type MemoryTexts = {
  'agent-memory.db'?: { memories: Array<Record<string, unknown>>; mentions: Array<Record<string, unknown>> };
  'engine.db'?: { memories: Array<Record<string, unknown>>; memory_subjects: Array<Record<string, unknown>>; relationships: Array<Record<string, unknown>>; relationships_note: string };
};

/** The remembered-text half of a store that holds none. */
const NO_MEMORY_TEXTS = {
  'agent-memory.db': { memories: [], mentions: [], supersedes: [], cooccurrences: [], metrics: [], entities: [], relations: [] },
  'engine.db': { memories: [], memory_subjects: [], relationships: [], relationships_note: MEMORY_TEXTS_RELATIONSHIPS_NOTE, supersedes: [], subject_cooccurrences: [], subject_mints: [] },
};

type EngineView = {
  getCRM: () => unknown;
  getDataStore: () => unknown;
  getThreadStore: () => unknown;
  getKnowledgeStore: () => unknown;
  getKnowledgeLayer: () => unknown;
  getSecretStore: () => unknown;
  getUserConfig: () => { durable_memory_enabled?: boolean | undefined; knowledge_graph_enabled?: boolean | undefined; subject_graph_enabled?: boolean | undefined };
  getEngineDb: () => unknown;
  _crm: unknown;
  _knowledgeStore: unknown;
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
    expect(body.durable_knowledge.enabled, 'switched on').toBe(true);
  }, 60_000);

  it('reads the knowledge graph without its layer when the layer is missing, and marks it while engine.db is down', async () => {
    expect(h.engine().getUserConfig().knowledge_graph_enabled, 'fixture: not switched off').not.toBe(false);
    expect(h.engine().getKnowledgeLayer(), 'fixture: no layer without the history database').toBeNull();
    // What the graph held before this boot; no layer holds the file now.
    const db = new AgentMemoryDb(join(h.dir(), 'agent-memory.db'));
    db.createEntity({ canonicalName: 'Alice', entityType: 'person', scopeType: 'global', scopeId: 'global' });
    db.close();

    const body = await h.exportBody();
    const graph = body.knowledge_graph as unknown as { entities: Array<{ canonicalName: string }>; enabled: boolean };
    expect(graph.entities.map(e => e.canonicalName), 'read from its store without the layer').toEqual(['Alice']);
    expect(body.knowledge_graph_may_be_incomplete, 'engine.db did not open: the texts it may hold cannot be counted').toBe(true);
    expect(body.knowledge_graph.enabled, 'not switched off').toBe(true);
  }, 60_000);
});

describe('export with every store open, durable memory off, then the CRM gone (real engine)', () => {
  const h = harness(() => {}, false);

  it('leaves durable knowledge and threads unmarked when nothing failed, and says durable memory is off', async () => {
    expect(h.engine().getUserConfig().durable_memory_enabled, 'fixture: durable memory off').toBe(false);
    expect(h.engine().getKnowledgeStore(), 'fixture: no store while it is off').toBeNull();
    expect(h.engine().getThreadStore(), 'fixture: the thread store opened').not.toBeNull();

    const body = await h.exportBody();
    expect(body.durable_knowledge.entries).toEqual([]);
    expect(body.durable_knowledge.may_be_incomplete, 'off: nothing is held, and the read did not fail').toBe(false);
    expect(body.durable_knowledge.enabled, 'switched off').toBe(false);
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

  it('leaves the knowledge graph and the secret names unmarked when both were read, and says values are not exported; durable memory off does not touch the graph', async () => {
    expect(h.engine().getSecretStore(), 'fixture: the secret store opened').not.toBeNull();
    expect(h.engine().getKnowledgeLayer(), 'fixture: the knowledge graph opened').not.toBeNull();
    const body = await h.exportBody();
    expect(body.secrets_may_be_incomplete, 'the secret store was read').toBe(false);
    expect(body.secrets_note).toBe('Names of the stored secrets only. Their values are not exported.');
    expect(body.knowledge_graph_may_be_incomplete, 'the graph was read in full').toBe(false);
    expect(body.knowledge_graph.enabled, 'on: no off marker').toBe(true);
    // Graph on, durable memory off: each block follows its own setting.
    expect(body.durable_knowledge.enabled, 'durable memory is off').toBe(false);
    expect(body.durable_knowledge.may_be_incomplete, 'nothing durable is held, read in full').toBe(false);
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
      expect(body.knowledge_graph, 'the remembered texts are read apart from the graph').toEqual({ entities: [], relationships: [], memories: NO_MEMORY_TEXTS, enabled: true });
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

  it('carries the remembered texts of both stores, masked, and marks the graph only when they cannot all be read', async () => {
    expect(h.engine().getKnowledgeLayer(), 'fixture: the knowledge graph opened').not.toBeNull();
    const engineDb = (h.engine().getEngineDb() as EngineDb | null);
    expect(engineDb, 'fixture: engine.db opened').not.toBeNull();
    const raw = engineDb!.getDb();
    // Built at RUNTIME, as the harness's secret is: a key-shaped literal is what the
    // commit-time scan looks for, and this repo is public.
    const key = `sk-ant-api03-${randomBytes(24).toString('hex')}`;
    // A second connection on the layer's own file, as another writer would be.
    const legacy = new Database(join(h.dir(), 'agent-memory.db'));
    try {
      legacy.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, is_active, embedding, created_at, updated_at) VALUES ('m-legacy', ?, 'knowledge', 'global', 'global', 0, x'00', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(`Alice's key is ${key}`);
      raw.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, is_active) VALUES ('m-held', ?, 'knowledge', 'global', 'global', 0)").run(engineDb!.enc(`Bob prefers mornings, key ${key}`));

      const res = await fetch(`${h.baseUrl()}/api/export`, { headers: { Authorization: `Bearer ${h.secret}` } });
      const text = await res.text();
      const body = JSON.parse(text) as ExportBody;
      const memories = body.knowledge_graph.memories!;
      const legacyRow = memories['agent-memory.db']!.memories.find(m => m['id'] === 'm-legacy');
      expect(legacyRow?.['text'], 'a replaced text of agent-memory.db, masked').toMatch(/^Alice's key is (?!sk-ant-)/);
      expect(text.includes(key), 'the key is not in the export').toBe(false);
      expect(legacyRow && 'embedding' in legacyRow, 'no embedding').toBe(false);
      expect(memories['engine.db']!.memories.map(m => m['id']), 'the one text engine.db holds, once').toEqual(['m-held']);
      const engineRow = memories['engine.db']!.memories[0];
      expect(engineRow?.['text'], 'engine.db, decrypted and masked').toMatch(/^Bob prefers mornings, key (?!sk-ant-)/);
      expect(body.knowledge_graph_may_be_incomplete, 'both stores read in full').toBe(false);

      const getEngineDb = h.engine().getEngineDb;
      h.engine().getEngineDb = () => null;
      try {
        const noEngineDb = await h.exportBody();
        expect(noEngineDb.knowledge_graph.memories?.['agent-memory.db']?.memories.map(m => m['id']), 'agent-memory.db is still read').toContain('m-legacy');
        expect(noEngineDb.knowledge_graph_may_be_incomplete, 'without engine.db its texts were not read').toBe(true);
      } finally {
        h.engine().getEngineDb = getEngineDb;
      }
    } finally {
      raw.prepare("DELETE FROM memories WHERE id = 'm-held'").run();
      legacy.prepare("DELETE FROM memories WHERE id = 'm-legacy'").run();
      legacy.close();
    }
    const after = await h.exportBody();
    expect(after.knowledge_graph.memories, 'with the texts gone nothing is left').toEqual(NO_MEMORY_TEXTS);
    expect(after.knowledge_graph_may_be_incomplete).toBe(false);
  }, 60_000);

  it('marks the knowledge graph while engine.db holds a subject no block lists, on the layer path', async () => {
    expect(h.engine().getKnowledgeLayer(), 'fixture: the knowledge graph opened').not.toBeNull();
    const engineDb = h.engine().getEngineDb() as EngineDb;
    const id = new SubjectStore(engineDb).createSubject({ kind: 'service', name: 'Hosting' });
    try {
      const held = await h.exportBody();
      expect(held.knowledge_graph_may_be_incomplete, 'with the subject graph off, a stored subject is in no block').toBe(true);
    } finally {
      engineDb.getDb().prepare('DELETE FROM subjects WHERE id = ?').run(id);
    }
    const after = await h.exportBody();
    expect(after.knowledge_graph_may_be_incomplete, 'with it gone nothing is left out').toBe(false);
  }, 60_000);

  it('counts with the subject-graph setting the layer started with, not one switched on in the config since', async () => {
    const layer = h.engine().getKnowledgeLayer() as { readsSubjectGraph: boolean } | null;
    expect(layer?.readsSubjectGraph, 'fixture: the layer started with the subject graph off').toBe(false);
    const engineDb = h.engine().getEngineDb() as EngineDb;
    // A person: listed if the layer read the subject graph, in no block since it does not.
    const id = new SubjectStore(engineDb).createSubject({ kind: 'person', name: 'Bob' });
    const getUserConfig = h.engine().getUserConfig;
    h.engine().getUserConfig = () => ({ ...getUserConfig.call(h.engine()), subject_graph_enabled: true });
    try {
      const body = await h.exportBody();
      expect(body.knowledge_graph_may_be_incomplete, 'the layer lists no subject, so Bob is left out').toBe(true);
    } finally {
      h.engine().getUserConfig = getUserConfig;
      engineDb.getDb().prepare('DELETE FROM subjects WHERE id = ?').run(id);
    }
  }, 60_000);

  it('carries which text replaced which in both stores, the reason masked, and does not mark the graph for it', async () => {
    const engineDb = h.engine().getEngineDb() as EngineDb;
    const raw = engineDb.getDb();
    const key = `sk-ant-api03-${randomBytes(24).toString('hex')}`;
    const legacy = new Database(join(h.dir(), 'agent-memory.db'));
    try {
      legacy.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, is_active, embedding, created_at, updated_at) VALUES ('l-old', 'old', 'knowledge', 'global', 'global', 0, x'00', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), ('l-new', 'new', 'knowledge', 'global', 'global', 1, x'00', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
      legacy.prepare("INSERT INTO supersedes (new_memory_id, old_memory_id, reason, created_at) VALUES ('l-new', 'l-old', ?, '2026-01-02')").run(`replaced, key ${key}`);
      raw.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, is_active) VALUES ('e-old', ?, 'knowledge', 'global', 'global', 0), ('e-new', ?, 'knowledge', 'global', 'global', 1)").run(engineDb.enc('old'), engineDb.enc('new'));
      raw.prepare("INSERT INTO supersedes (new_memory_id, old_memory_id, reason) VALUES ('e-new', 'e-old', ?)").run(`newer, key ${key}`);

      const res = await fetch(`${h.baseUrl()}/api/export`, { headers: { Authorization: `Bearer ${h.secret}` } });
      const text = await res.text();
      const body = JSON.parse(text) as ExportBody;
      const memories = body.knowledge_graph.memories!;
      const l = (memories['agent-memory.db'] as unknown as { supersedes: Array<Record<string, unknown>> }).supersedes;
      const e = (memories['engine.db'] as unknown as { supersedes: Array<Record<string, unknown>> }).supersedes;
      expect(l.map(r => [r['new_memory_id'], r['old_memory_id']]), 'agent-memory.db').toEqual([['l-new', 'l-old']]);
      expect(e.map(r => [r['new_memory_id'], r['old_memory_id']]), 'engine.db').toEqual([['e-new', 'e-old']]);
      expect(String(l[0]?.['reason']), 'masked').toMatch(/^replaced, key (?!sk-ant-)/);
      expect(String(e[0]?.['reason']), 'masked').toMatch(/^newer, key (?!sk-ant-)/);
      expect(text.includes(key), 'the key is not in the export').toBe(false);
      expect(body.knowledge_graph_may_be_incomplete, 'carried, so not marked').toBe(false);
    } finally {
      raw.prepare("DELETE FROM supersedes WHERE new_memory_id = 'e-new'").run();
      raw.prepare("DELETE FROM memories WHERE id IN ('e-old', 'e-new')").run();
      legacy.prepare("DELETE FROM supersedes WHERE new_memory_id = 'l-new'").run();
      legacy.prepare("DELETE FROM memories WHERE id IN ('l-old', 'l-new')").run();
      legacy.close();
    }
  }, 60_000);

  it('with the subject graph on, carries the older store\'s entities and relations, masked, and does not mark the graph for them', async () => {
    const key = `sk-ant-api03-${randomBytes(24).toString('hex')}`;
    const legacy = new Database(join(h.dir(), 'agent-memory.db'));
    const getKnowledgeLayer = h.engine().getKnowledgeLayer;
    const getUserConfig = h.engine().getUserConfig;
    try {
      legacy.prepare("INSERT INTO entities (id, canonical_name, entity_type, description, scope_type, scope_id, first_seen_at, last_seen_at) VALUES ('le-a', 'Alice', 'person', ?, 'global', 'global', '2026-01-01', '2026-01-01'), ('le-b', 'Acme', 'organization', '', 'global', 'global', '2026-01-01', '2026-01-01')").run(`key ${key}`);
      legacy.prepare("INSERT INTO relations (id, from_entity_id, to_entity_id, relation_type, description, created_at) VALUES ('lr-1', 'le-a', 'le-b', 'works_at', ?, '2026-01-01')").run(`badge ${key}`);
      // No layer, the subject graph on in the config: the graph block is read from engine.db.
      h.engine().getKnowledgeLayer = () => null;
      h.engine().getUserConfig = () => ({ ...getUserConfig.call(h.engine()), subject_graph_enabled: true });

      const res = await fetch(`${h.baseUrl()}/api/export`, { headers: { Authorization: `Bearer ${h.secret}` } });
      const text = await res.text();
      const body = JSON.parse(text) as ExportBody;
      const half = body.knowledge_graph.memories!['agent-memory.db'] as unknown as { entities: Array<Record<string, unknown>>; relations: Array<Record<string, unknown>> };
      expect(half.entities.map(r => r['id']).sort(), 'the legacy entities').toEqual(['le-a', 'le-b']);
      expect(String(half.entities.find(r => r['id'] === 'le-a')?.['description']), 'masked').toMatch(/^key (?!sk-ant-)/);
      expect(half.relations.map(r => [r['id'], r['from_entity_id'], r['to_entity_id']]), 'the legacy relation').toEqual([['lr-1', 'le-a', 'le-b']]);
      expect(String(half.relations[0]?.['description']), 'masked').toMatch(/^badge (?!sk-ant-)/);
      expect(text.includes(key), 'the key is not in the export').toBe(false);
      expect(body.knowledge_graph_may_be_incomplete, 'carried, so not marked').toBe(false);

      // Without engine.db the graph block falls back to the older store: its rows once, there.
      const getEngineDb = h.engine().getEngineDb;
      h.engine().getEngineDb = () => null;
      try {
        const fallback = await h.exportBody();
        const fallbackHalf = fallback.knowledge_graph.memories!['agent-memory.db'] as unknown as { entities: unknown[]; relations: unknown[] };
        expect([fallbackHalf.entities, fallbackHalf.relations], 'not here').toEqual([[], []]);
        expect((fallback.knowledge_graph.entities as Array<{ id?: string }>).map(e => e.id).sort(), 'in the graph block').toEqual(expect.arrayContaining(['le-a', 'le-b']));
      } finally {
        h.engine().getEngineDb = getEngineDb;
      }
    } finally {
      h.engine().getKnowledgeLayer = getKnowledgeLayer;
      h.engine().getUserConfig = getUserConfig;
      legacy.prepare("DELETE FROM relations WHERE id = 'lr-1'").run();
      legacy.prepare("DELETE FROM entities WHERE id IN ('le-a', 'le-b')").run();
      legacy.close();
    }
  }, 60_000);

  it('masks the graph block\'s entities and relations as it masks the remembered texts, a vault value written escaped in a JSON text included, with the layer, without it and from the subject graph', async () => {
    const store = h.engine().getSecretStore() as SecretStore | null;
    expect(store, 'fixture: the secret store opened').not.toBeNull();
    const engineDb = h.engine().getEngineDb() as EngineDb | null;
    expect(engineDb, 'fixture: engine.db opened').not.toBeNull();
    // A quote and a backslash, so the value has a second form once written inside a JSON text.
    const value = `q"${randomBytes(12).toString('hex')}\\z`;
    const escaped = JSON.stringify(value).slice(1, -1);
    expect(escaped, 'fixture: the escaped form differs').not.toBe(value);
    store!.set('GRAPH_MASK_PROBE', value);
    const legacy = new Database(join(h.dir(), 'agent-memory.db'));
    const subjects = new SubjectStore(engineDb!);
    const sa = subjects.createSubject({ kind: 'person', name: 'Trudy' });
    const sb = subjects.createSubject({ kind: 'organization', name: 'Globex' });
    const edge = new RelationshipStore(engineDb!).createRelationship({
      fromSubjectId: sa, toSubjectId: sb, kind: `audits ${value}`, description: `edge ${value}`,
      since: `from ${value}`, until: `to ${value}`, notes: `note ${value}`,
    });
    const getKnowledgeLayer = h.engine().getKnowledgeLayer;
    const getUserConfig = h.engine().getUserConfig;
    try {
      legacy.prepare("INSERT INTO entities (id, canonical_name, entity_type, aliases, description, scope_type, scope_id, first_seen_at, last_seen_at) VALUES ('gm-a', ?, ?, ?, ?, 'global', 'global', '2026-01-01', '2026-01-01'), ('gm-b', 'Acme', 'organization', '[]', '', 'global', 'global', '2026-01-01', '2026-01-01')")
        .run(`Mallory ${value}`, `kind ${value}`, JSON.stringify([`alias ${value}`]), `pin ${value}`);
      legacy.prepare("INSERT INTO relations (id, from_entity_id, to_entity_id, relation_type, description, created_at) VALUES ('gm-r', 'gm-a', 'gm-b', ?, ?, '2026-01-01')")
        .run(`owns ${value}`, `json {"pw":"${escaped}"}`);
      legacy.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, is_active, embedding, created_at, updated_at) VALUES ('gm-m', ?, 'knowledge', 'global', 'global', 0, x'00', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
        .run(JSON.stringify({ pw: value }));

      for (const path of ['layer', 'no layer', 'subject graph'] as const) {
        if (path === 'layer') expect(h.engine().getKnowledgeLayer(), 'fixture: the knowledge graph opened').not.toBeNull();
        else h.engine().getKnowledgeLayer = () => null;
        if (path === 'subject graph') h.engine().getUserConfig = () => ({ ...getUserConfig.call(h.engine()), subject_graph_enabled: true });
        const body = await h.exportBody();
        const graph = body.knowledge_graph as unknown as {
          entities: Array<{ id: string; canonicalName: string; entityType: string; aliases: string[]; description: string }>;
          relationships: Array<{ fromEntityId: string; relationType: string; description: string }>;
        };
        if (path === 'subject graph') {
          const relation = graph.relationships.find(r => r.fromEntityId === sa);
          expect(relation, `${path}: the subjects' relation is listed`).toBeDefined();
          expect(relation!.relationType, `${path}: its type, masked`).toMatch(/^audits \*\*\*/);
          expect(relation!.description, `${path}: its description, masked`).toMatch(/^edge \*\*\*/);
        } else {
          const entity = graph.entities.find(e => e.id === 'gm-a');
          expect(entity, `${path}: the entity is listed`).toBeDefined();
          expect(entity!.canonicalName, `${path}: its name, masked`).toMatch(/^Mallory \*\*\*/);
          expect(entity!.entityType, `${path}: its type, masked`).toMatch(/^kind \*\*\*/);
          expect(entity!.aliases.join(' '), `${path}: its aliases, masked`).toMatch(/^alias \*\*\*/);
          expect(entity!.description, `${path}: its description, masked`).toMatch(/^pin \*\*\*/);
          const relation = graph.relationships.find(r => r.fromEntityId === 'gm-a');
          expect(relation, `${path}: the relation is listed`).toBeDefined();
          expect(relation!.relationType, `${path}: its type, masked`).toMatch(/^owns \*\*\*/);
          expect(relation!.description, `${path}: its description, the escaped form masked`).toMatch(/^json \{"pw":"\*\*\*/);
        }
        const memory = body.knowledge_graph.memories!['agent-memory.db']!.memories.find(m => m['id'] === 'gm-m');
        expect(String(memory?.['text']), `${path}: the remembered JSON text, the escaped form masked`).toMatch(/^\{"pw":"\*\*\*/);
        const row = body.knowledge_graph.memories!['engine.db']!.relationships.find(r => r['id'] === edge);
        expect([row?.['kind'], row?.['description'], row?.['since'], row?.['until'], row?.['notes']].map(v => String(v).split(' ')[1]?.slice(0, 3)),
          `${path}: engine.db's relation among the remembered texts, each free text masked`).toEqual(['***', '***', '***', '***', '***']);
        const all = JSON.stringify(body.knowledge_graph);
        for (const form of [value, escaped]) {
          expect(all.includes(JSON.stringify(form).slice(1, -1)), `${path}: no form of the value is in the block`).toBe(false);
        }
      }
    } finally {
      h.engine().getKnowledgeLayer = getKnowledgeLayer;
      h.engine().getUserConfig = getUserConfig;
      store!.deleteSecret('GRAPH_MASK_PROBE');
      engineDb!.getDb().prepare('DELETE FROM relationships WHERE id = ?').run(edge);
      engineDb!.getDb().prepare('DELETE FROM subjects WHERE id IN (?, ?)').run(sa, sb);
      legacy.prepare("DELETE FROM relations WHERE id = 'gm-r'").run();
      legacy.prepare("DELETE FROM entities WHERE id IN ('gm-a', 'gm-b')").run();
      legacy.prepare("DELETE FROM memories WHERE id = 'gm-m'").run();
      legacy.close();
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

  it('marks the knowledge graph incomplete when the subject graph is on without its store, and does not carry the older store\'s entities a second time', async () => {
    const saved = h.engine().knowledgeLayer;
    const legacy = new Database(join(h.dir(), 'agent-memory.db'));
    // The layer started with the subject graph on, but its store did not open: it reads the older store.
    h.engine().knowledgeLayer = {
      readFallbackCount: 0,
      readsSubjectGraph: true,
      subjectGraphUnavailable: true,
      listEntities: ({ offset }: { offset: number }) => Promise.resolve(offset === 0 ? [{ id: 'lu-a' }] : []),
      stats: () => Promise.resolve({}),
      getEntityRelationsForExport: () => Promise.resolve([]),
    };
    try {
      legacy.prepare("INSERT INTO entities (id, canonical_name, entity_type, scope_type, scope_id, first_seen_at, last_seen_at) VALUES ('lu-a', 'Alice', 'person', 'global', 'global', '2026-01-01', '2026-01-01')").run();
      const body = await h.exportBody();
      expect(body.knowledge_graph_may_be_incomplete, 'only the legacy store was read').toBe(true);
      const half = body.knowledge_graph.memories!['agent-memory.db'] as unknown as { entities: unknown[] };
      expect(half.entities, 'not carried here as well').toEqual([]);
      expect((body.knowledge_graph.entities as Array<{ id?: string }>).map(e => e.id), 'the graph block, as the layer listed it').toEqual(['lu-a']);
    } finally {
      h.engine().knowledgeLayer = saved;
      legacy.prepare("DELETE FROM entities WHERE id = 'lu-a'").run();
      legacy.close();
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

  it('says the graph is off and, with nothing held, reads it as complete', async () => {
    expect(h.engine().getUserConfig().knowledge_graph_enabled, 'fixture: switched off').toBe(false);
    expect(h.engine().getKnowledgeLayer(), 'fixture: no layer while it is off').toBeNull();

    const body = await h.exportBody();
    expect(body.knowledge_graph).toMatchObject({ entities: [], relationships: [], enabled: false });
    expect(body.knowledge_graph_may_be_incomplete, 'off, and the graph never held anything: read in full').toBe(false);
    expect(body.durable_knowledge.enabled, 'durable memory is off too').toBe(false);
    expect(body.durable_knowledge.may_be_incomplete, 'nothing durable is held, read in full').toBe(false);
  }, 60_000);
});

describe('export with the knowledge graph switched off after it held entities and relations (real engine)', () => {
  // Written while it was on, then switched off: switching it off deletes nothing.
  const h = harness((dir) => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ knowledge_graph_enabled: false }));
    const db = new AgentMemoryDb(join(dir, 'agent-memory.db'));
    const alice = db.createEntity({ canonicalName: 'Alice', entityType: 'person', scopeType: 'global', scopeId: 'global' });
    const acme = db.createEntity({ canonicalName: 'ACME', entityType: 'organization', scopeType: 'global', scopeId: 'global' });
    db.createRelation(alice, acme, 'works_at', 'Alice works at ACME', 'm-not-stored');
    db.setEmbeddingDimensions(3);
    const memory = db.createMemory({ text: 'Alice prefers mornings', namespace: 'knowledge', scopeType: 'global', scopeId: 'global', embedding: [1, 0, 0] });
    db.createMention(memory, alice);
    db.close();
  }, false);

  it('carries what the graph still holds, says it is off, and reads it as complete', async () => {
    expect(h.engine().getUserConfig().knowledge_graph_enabled, 'fixture: switched off').toBe(false);
    expect(h.engine().getKnowledgeLayer(), 'fixture: no layer while it is off').toBeNull();

    const body = await h.exportBody();
    const graph = body.knowledge_graph as unknown as { entities: Array<{ canonicalName: string }>; relationships: Array<{ description: string }>; enabled: boolean };
    expect(graph.entities.map(e => e.canonicalName).sort()).toEqual(['ACME', 'Alice']);
    expect(graph.relationships.map(r => r.description)).toEqual(['Alice works at ACME']);
    expect(graph.enabled, 'switched off').toBe(false);
    const legacy = body.knowledge_graph.memories?.['agent-memory.db'];
    expect(legacy?.memories.map(m => m['text']), 'the remembered text it still holds').toEqual(['Alice prefers mornings']);
    expect(legacy?.mentions, 'and its mention of Alice').toHaveLength(1);
    expect(body.knowledge_graph_may_be_incomplete, 'read in full, the remembered text included').toBe(false);
  }, 60_000);

  it('marks the held graph while engine.db holds a subject no block lists', async () => {
    const engineDb = h.engine().getEngineDb() as EngineDb;
    const id = new SubjectStore(engineDb).createSubject({ kind: 'person', name: 'Bob' });
    try {
      const body = await h.exportBody();
      expect(body.knowledge_graph_may_be_incomplete, 'with the subject graph off, a stored subject is in no block').toBe(true);
    } finally {
      engineDb.getDb().prepare('DELETE FROM subjects WHERE id = ?').run(id);
    }
    const after = await h.exportBody();
    expect(after.knowledge_graph_may_be_incomplete, 'with it gone nothing is left out').toBe(false);
  }, 60_000);
});

describe('export with the knowledge graph switched off and durable memory on (real engine)', () => {
  const h = harness((dir) => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ knowledge_graph_enabled: false }));
    const db = new EngineDb(join(dir, 'engine.db'));
    new KnowledgeStore(db, new SubjectStore(db), null).write({ text: 'Quotes are valid for 30 days', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    db.close();
  }, true);

  it('reads durable knowledge in full under its own setting while the graph is off', async () => {
    expect(h.engine().getUserConfig().knowledge_graph_enabled, 'fixture: graph off').toBe(false);
    expect(h.engine().getUserConfig().durable_memory_enabled, 'fixture: durable memory on').toBe(true);
    expect(h.engine().getKnowledgeLayer(), 'fixture: no graph layer').toBeNull();
    expect(h.engine().getKnowledgeStore(), 'fixture: the durable store opened').not.toBeNull();

    const body = await h.exportBody();
    expect(body.knowledge_graph).toMatchObject({ entities: [], relationships: [], enabled: false });
    expect(body.knowledge_graph_may_be_incomplete, 'the entry\'s subject ACME is stored, and with the subject graph off no block lists it').toBe(true);
    expect(body.durable_knowledge.enabled, 'durable memory on').toBe(true);
    expect(body.durable_knowledge.entries.map((e) => e.text)).toEqual(['Quotes are valid for 30 days']);
    expect(body.durable_knowledge.may_be_incomplete, 'the graph being off does not mark durable knowledge').toBe(false);
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

  it('carries the entries and blocks it still holds, unmarked and marked as switched off, and changes nothing', async () => {
    expect(h.engine().getUserConfig().durable_memory_enabled, 'fixture: durable memory off').toBe(false);
    expect(h.engine().getKnowledgeStore(), 'fixture: no store while it is off').toBeNull();

    const db = h.engine().getEngineDb() as EngineDb;
    const changesBefore = (db.getDb().prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const body = await h.exportBody();
    expect(body.durable_knowledge.enabled, 'held, but switched off').toBe(false);
    expect(body.durable_knowledge.entries.map((e) => e.text)).toEqual(['ACME renews in March']);
    expect(body.durable_knowledge.blocks['profile']).toBe('Runs a small bakery');
    expect(body.durable_knowledge.blocks['playbook'], 'a key in a block is masked').not.toContain('Q'.repeat(40));
    expect(body.durable_knowledge.blocks['playbook']).toContain('***');
    expect(body.durable_knowledge.may_be_incomplete, 'read in full').toBe(false);
    expect((db.getDb().prepare('SELECT done FROM profile_seed_backfill WHERE id = 1').get() as { done: number }).done, 'the export wrote nothing').toBe(0);
    expect((db.getDb().prepare('SELECT total_changes() AS n').get() as { n: number }).n, 'no row of engine.db changed').toBe(changesBefore);
    expect(h.engine().getUserConfig().durable_memory_enabled, 'the export switched nothing on').toBe(false);
    expect(h.engine().getKnowledgeStore(), 'the export attached no store to the engine').toBeNull();
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

  it('carries what it holds when durable memory is switched on after boot, with no store built', async () => {
    const view = h.engine();
    const real = view.getUserConfig;
    view.getUserConfig = () => ({ ...real.call(view), durable_memory_enabled: true });
    try {
      expect(view.getKnowledgeStore(), 'fixture: the store is built only at boot').toBeNull();
      const body = await h.exportBody();
      expect(body.durable_knowledge.enabled, 'the setting now reads on').toBe(true);
      expect(body.durable_knowledge.entries.map((e) => e.text)).toEqual(['ACME renews in March']);
      expect(body.durable_knowledge.may_be_incomplete, 'read in full').toBe(false);
    } finally {
      view.getUserConfig = real;
    }
  }, 60_000);
});

describe('export with durable memory on and its store gone, engine.db open (real engine)', () => {
  const h = harness((dir) => {
    const db = new EngineDb(join(dir, 'engine.db'));
    new KnowledgeStore(db, new SubjectStore(db), null).write({ text: 'Delivery on Fridays', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    db.close();
  }, true);

  it('reads the entries through a store built only to read, unmarked', async () => {
    expect(h.engine().getEngineDb(), 'fixture: engine.db opened').not.toBeNull();
    // What the engine leaves behind when building the store at boot throws.
    h.engine()._knowledgeStore = null;
    expect(h.engine().getKnowledgeStore()).toBeNull();

    const body = await h.exportBody();
    expect(body.durable_knowledge.enabled).toBe(true);
    expect(body.durable_knowledge.entries.map((e) => e.text)).toEqual(['Delivery on Fridays']);
    expect(body.durable_knowledge.may_be_incomplete, 'read in full').toBe(false);
  }, 60_000);
});

// Built at runtime: a key-shaped literal is what the commit-time scan looks for, and this repo is public.
const OLD_KEY = `sk-ant-api03-${randomBytes(24).toString('hex')}`;

describe('export with durable memory on and a rejected or superseded entry stored (real engine)', () => {
  const h = harness((dir) => {
    const db = new EngineDb(join(dir, 'engine.db'));
    const store = new KnowledgeStore(db, new SubjectStore(db), null);
    const kept = store.write({ text: 'Invoices go out monthly', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    const held = store.write({ text: 'The warehouse closes at noon on Saturdays', subjectName: 'Lager', sourceChannel: 'agent', sourceUntrusted: false });
    const old = store.write({ text: `Invoices went out quarterly, key ${OLD_KEY}`, subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    if ([held, old].some(r => r.deduped === true)) throw new Error('fixture: an entry was merged into another');
    const raw = db.getDb();
    const changed = raw.prepare("UPDATE knowledge_entries SET status = 'rejected', updated_at = '2026-01-01 00:00:01' WHERE id = ?").run(held.id).changes
      + raw.prepare("UPDATE knowledge_entries SET status = 'superseded', superseded_by = ?, updated_at = '2026-01-01 00:00:02' WHERE id = ?").run(kept.id, old.id).changes;
    if (changed !== 2) throw new Error(`fixture: expected two entries to change, got ${String(changed)}`);
    db.close();
  }, true);

  it('carries the rejected and the superseded entry with status and successor, masked, and reads complete', async () => {
    expect(h.engine().getKnowledgeStore(), 'fixture: the store opened').not.toBeNull();
    const res = await fetch(`${h.baseUrl()}/api/export`, { headers: { Authorization: `Bearer ${h.secret}` } });
    const text = await res.text();
    const body = JSON.parse(text) as ExportBody;
    expect(body.durable_knowledge.entries.map((e) => e.text)).toEqual(['Invoices go out monthly']);
    const kept = (body.durable_knowledge.entries[0] as unknown as { id: string }).id;
    const retired = (body.durable_knowledge as unknown as { rejected_or_superseded_entries: Array<{ id: string; status: string; supersededBy: string | null; text: string }> }).rejected_or_superseded_entries;
    expect(retired.map(e => [e.status, e.supersededBy]), 'newest change first, each with its status').toEqual([['superseded', kept], ['rejected', null]]);
    expect(retired[1]?.text, 'the rejected entry').toBe('The warehouse closes at noon on Saturdays');
    expect(retired[0]?.text, 'the superseded entry, masked').toMatch(/^Invoices went out quarterly, key (?!sk-ant-)/);
    expect(text.includes(OLD_KEY), 'the key is not in the export').toBe(false);
    expect(body.durable_knowledge.may_be_incomplete, 'every stored entry is in the copy').toBe(false);
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

  it('names the set-aside file and marks durable knowledge and the knowledge graph incomplete, not the threads', async () => {
    const setAside = readdirSync(h.dir()).filter((f) => /^engine\.db\.corrupt-\d+$/.test(f));
    expect(setAside, 'fixture: the boot set engine.db aside').toHaveLength(1);
    expect(h.engine().getKnowledgeStore(), 'fixture: an empty knowledge store opened in its place').not.toBeNull();
    expect(h.engine().getUserConfig().subject_graph_enabled, 'fixture: the graph reads agent-memory.db').not.toBe(true);

    const body = await h.exportBody();
    expect(body.set_aside_databases).toEqual([{ database: 'engine.db', files: setAside }]);
    expect(body.durable_knowledge.may_be_incomplete, 'the old entries are in the set-aside file').toBe(true);
    expect(body.threads_may_be_incomplete, 'history.db was not set aside').toBe(false);
    expect(body.knowledge_graph_may_be_incomplete, 'the set-aside file holds remembered texts, which the block does not carry').toBe(true);
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

  it('still marks it after a config reload turned the switch off, since the layer keeps reading engine.db', async () => {
    // What a reload leaves: the config says off, the layer built at boot still reads the subject graph.
    const view = h.engine() as unknown as { userConfig: { subject_graph_enabled?: boolean } };
    const saved = view.userConfig;
    view.userConfig = { ...saved, subject_graph_enabled: false };
    try {
      expect(h.engine().getUserConfig().subject_graph_enabled, 'fixture: the config now says off').toBe(false);
      const body = await h.exportBody();
      expect(body.knowledge_graph_may_be_incomplete).toBe(true);
    } finally {
      view.userConfig = saved;
    }
  }, 60_000);
});
