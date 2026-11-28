import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { KnowledgeLayer } from './knowledge-layer.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { EngineDb } from './engine-db.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import { RelationshipStore } from './relationship-store.js';
import { LocalProvider, type EmbeddingProvider } from './embedding.js';
import { repointToChainEndSql } from './relation-source.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { ContradictionInfo } from './contradiction-detector.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * A relation follows the memory that carries its fact today. Replacing a memory by the
 * same fact (a consolidation, a tier raise, a move) hands its relations to the successor
 * in both stores; a contradiction does not, and its relations go with the outdated fact.
 * Relations from before this rule are moved once, by a migration, to the end of their
 * source's chain of successors.
 */
const mock = vi.hoisted(() => ({
  extraction: { entities: [], relations: [] } as ExtractionResult,
  contradictions: [] as ContradictionInfo[],
}));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});
vi.mock('./contradiction-detector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contradiction-detector.js')>();
  return { ...actual, detectContradictions: vi.fn(async () => mock.contradictions) };
});

const EDGE: ExtractionResult = {
  entities: [
    { name: 'Alice', type: 'person', confidence: 0.9 },
    { name: 'Acme GmbH', type: 'organization', confidence: 0.9 },
  ],
  relations: [{ from: 'Alice', to: 'Acme GmbH', relationType: 'works_at', description: 'CTO' }],
};
const NONE: ExtractionResult = { entities: [], relations: [] };
/** The same two entities, no relation: a keeper names what its duplicate named. */
const NAMES: ExtractionResult = { entities: EDGE.entities, relations: [] };
const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };

/** Every pair is cosine 1.0, so a re-assert of the same text dedups (and may raise). */
class ConstantEmbedder implements EmbeddingProvider {
  readonly name = 'const-test';
  readonly model = 'const-test';
  readonly dimensions = 8;
  async embed(): Promise<number[]> { return [1, 0, 0, 0, 0, 0, 0, 0]; }
}

const dirs: string[] = [];
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers.reverse()) { try { await c(); } catch { /* already closed */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  closers.length = 0; dirs.length = 0;
  mock.extraction = NONE;
  mock.contradictions = [];
  vi.restoreAllMocks();
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-relfollow-'));
  dirs.push(dir);
  return dir;
}

function makeLayer(opts: { dir?: string; provider?: EmbeddingProvider; trustGate?: boolean; reads?: boolean } = {}): { layer: KnowledgeLayer; engine: EngineDb; dir: string } {
  const dir = opts.dir ?? tmp();
  const engine = new EngineDb(join(dir, 'engine.db'), '');
  const layer = new KnowledgeLayer(
    join(dir, 'mem.db'), opts.provider ?? new LocalProvider(), undefined, undefined,
    engine, true, opts.reads ?? false, false, false, opts.trustGate ?? false,
  );
  closers.push(() => engine.close(), () => layer.close());
  return { layer, engine, dir };
}

/** The sources of the relations every read returns, legacy store. */
function legacySources(layer: KnowledgeLayer): string[] {
  return layer.getDb().listAllRelations().map(r => r.source_memory_id ?? 'none').sort();
}
/** The sources of the edges every read returns, engine.db. */
function engineSources(engine: EngineDb): string[] {
  return new RelationshipStore(engine).listRecent(100).map(r => r.source_memory_id ?? 'none').sort();
}
/** Every relation row, readable or not, legacy store. */
function legacyRows(dir: string): number {
  const raw = new Database(join(dir, 'mem.db'), { readonly: true });
  const c = (raw.prepare('SELECT COUNT(*) AS c FROM relations').get() as { c: number }).c;
  raw.close();
  return c;
}
/** Every edge row, readable or not, engine.db. */
function engineRows(engine: EngineDb): number {
  return (engine.getDb().prepare('SELECT COUNT(*) AS c FROM relationships').get() as { c: number }).c;
}

describe('a relation follows the memory that carries its fact, in both stores', () => {
  it('a consolidation hands the duplicate\'s relations to the keeper; deleting the keeper then hides them', async () => {
    const { layer, engine } = makeLayer();
    await layer.init();
    mock.extraction = NAMES;
    const keeper = (await layer.store('Meridian AG uses PostgreSQL for the backend database layer in production.', 'knowledge', scope)).memoryId;
    mock.extraction = EDGE;
    const victim = (await layer.store('Meridian AG uses PostgreSQL for the backend database layer.', 'knowledge', scope)).memoryId;
    expect(legacySources(layer)).toEqual([victim]);
    expect(engineSources(engine)).toEqual([victim]);

    expect(layer.consolidateMemories('knowledge', 'context', 'proj-1')).toBe(1);
    expect(legacySources(layer)).toEqual([keeper]);
    expect(engineSources(engine)).toEqual([keeper]);

    // The GC removes the duplicate itself and keeps what it handed on.
    await layer.gc();
    expect(layer.getDb().getMemory(victim)).toBeNull();
    expect(legacySources(layer)).toEqual([keeper]);
    expect(engineSources(engine)).toEqual([keeper]);

    // Deleting the keeper takes the relations with it.
    expect(await layer.deactivateByPattern('backend database layer in production')).toBeGreaterThan(0);
    expect(legacySources(layer)).toEqual([]);
    expect(engineSources(engine)).toEqual([]);
  });

  it.each([['legacy reads', false], ['engine.db reads', true]] as const)('a contradiction does not hand the relations on: they go with the outdated fact, and the GC removes them (%s)', async (_label, reads) => {
    const { layer, engine, dir } = makeLayer({ reads });
    await layer.init();
    mock.extraction = EDGE;
    const old = (await layer.store('Alice works at Acme GmbH as CTO.', 'knowledge', scope)).memoryId;
    mock.extraction = NONE;
    mock.contradictions = [{ existingMemoryId: old, existingText: 'Alice works at Acme GmbH as CTO.', similarity: 0.8, resolution: 'superseded' }];
    const next = (await layer.store('The quarterly report shows Acme GmbH revenue grew twelve percent.', 'knowledge', scope)).memoryId;
    expect(layer.getDb().getMemory(old)!.superseded_by).toBe(next);

    // Still on the outdated memory, and hidden from every read.
    expect((engine.getDb().prepare('SELECT source_memory_id AS s FROM relationships').all() as Array<{ s: string }>).map(r => r.s)).toEqual([old]);
    expect(legacySources(layer)).toEqual([]);
    expect(engineSources(engine)).toEqual([]);

    await layer.gc();
    expect(engineRows(engine)).toBe(0);
    expect(legacyRows(dir)).toBe(0);
  });

  it('a tier raise hands the relations to the raised row', async () => {
    const { layer, engine } = makeLayer({ provider: new ConstantEmbedder(), trustGate: true });
    await layer.init();
    const TEXT = 'The primary contact for Orion is Ada Lovelace';
    mock.extraction = EDGE;
    const weak = (await layer.store(TEXT, 'knowledge', scope, { sourceChannel: 'agent' })).memoryId;
    mock.extraction = NONE;
    const raised = (await layer.store(TEXT, 'knowledge', scope, { sourceChannel: 'ui' })).memoryId;
    expect(raised).not.toBe(weak);
    expect(layer.getDb().getMemory(weak)!.superseded_by).toBe(raised);

    expect(legacySources(layer)).toEqual([raised]);
    expect(engineSources(engine)).toEqual([raised]);
  });

  it('a move hands the relations to the copy, only from the rows it names as moved', async () => {
    const { layer, engine } = makeLayer();
    await layer.init();
    mock.extraction = EDGE;
    const original = (await layer.store('Alice works at Acme GmbH as CTO.', 'knowledge', scope)).memoryId;
    mock.extraction = NONE;
    const copy = (await layer.store('The quarterly report shows Acme GmbH revenue grew twelve percent.', 'knowledge', { type: 'global', id: 'global' })).memoryId;

    const retired = await layer.retireForMove('Alice works at Acme', 'knowledge', scope);
    expect(retired).toEqual([original]);
    // Retired without a successor yet: read as removed.
    expect(legacySources(layer)).toEqual([]);

    layer.markMoved(retired, copy);
    expect(legacySources(layer)).toEqual([copy]);
    expect(engineSources(engine)).toEqual([copy]);
  });

  it('a hard delete of the successor takes the handed-on relations with it, and clears the predecessor\'s pointer in engine.db', async () => {
    const { layer, engine } = makeLayer();
    await layer.init();
    mock.extraction = NAMES;
    const keeper = (await layer.store('Meridian AG uses PostgreSQL for the backend database layer in production.', 'knowledge', scope)).memoryId;
    mock.extraction = EDGE;
    const victim = (await layer.store('Meridian AG uses PostgreSQL for the backend database layer.', 'knowledge', scope)).memoryId;
    layer.consolidateMemories('knowledge', 'context', 'proj-1');

    expect(await layer.eraseByPattern('backend database layer in production')).toBeGreaterThan(0);
    expect(engineRows(engine)).toBe(0);
    expect(legacySources(layer)).toEqual([]);
    const pointer = engine.getDb().prepare('SELECT superseded_by AS s FROM memories WHERE id = ?').get(victim) as { s: string | null } | undefined;
    if (pointer) expect(pointer.s).toBeNull();
    expect(layer.getDb().getMemory(keeper)).toBeNull();
  });
});

describe('engine.db purge', () => {
  it('clears the successor pointer of every memory that named a purged one, as the legacy store does', () => {
    const engine = new EngineDb(join(tmp(), 'engine.db'), '');
    closers.push(() => engine.close());
    const mem = new MemoryGraphStore(engine);
    for (const id of ['a', 'b']) mem.upsertStub({ id, text: id, namespace: 'knowledge', scopeType: 'context', scopeId: 'c' });
    mem.markSuperseded('a', 'b');
    expect(mem.purgeMemories(['b'])).toBe(1);
    expect(mem.getStub('a')!.superseded_by).toBeNull();
  });
});

/**
 * Data from before relations followed their fact: memories replaced with their relations
 * left on them. Chains: a → b → c (c active), e → d (d deleted), f → a memory the GC
 * already removed. Relations on a, b, c, e and f.
 */
function seedOldLegacy(path: string): void {
  const db = new AgentMemoryDb(path);
  const x = db.createEntity({ canonicalName: 'Alice', entityType: 'person', scopeType: 'global', scopeId: 'g' });
  const y = db.createEntity({ canonicalName: 'Acme', entityType: 'organization', scopeType: 'global', scopeId: 'g' });
  const ids: Record<string, string> = {};
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
    ids[k] = db.createMemory({ text: `memory ${k}`, namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
  }
  db.supersedMemory(ids['a']!, ids['b']!);
  db.supersedMemory(ids['b']!, ids['c']!);
  db.supersedMemory(ids['e']!, ids['d']!);
  db.deactivateMemoriesByPattern('memory d');
  db.supersedMemory(ids['f']!, 'a-memory-the-gc-removed');
  for (const k of ['a', 'b', 'c', 'e', 'f']) db.createRelation(x, y, `rel_${k}`, k, ids[k]!);
  db.close();
  const raw = new Database(path);
  raw.prepare('DELETE FROM schema_version WHERE version >= 8').run();
  raw.exec('DROP INDEX IF EXISTS idx_relations_origin; ALTER TABLE relations DROP COLUMN origin_memory_id;');
  // Name the memories by letter so the assertions can read them.
  for (const [k, id] of Object.entries(ids)) {
    raw.prepare('UPDATE relations SET source_memory_id = ? WHERE source_memory_id = ?').run(`m-${k}`, id);
    raw.prepare('UPDATE memories SET superseded_by = ? WHERE superseded_by = ?').run(`m-${k}`, id);
    raw.prepare('UPDATE memories SET id = ? WHERE id = ?').run(`m-${k}`, id);
  }
  raw.close();
}

function seedOldEngine(path: string): void {
  const engine = new EngineDb(path, '');
  const mem = new MemoryGraphStore(engine);
  const rels = new RelationshipStore(engine);
  const db = engine.getDb();
  db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1','person','Alice'),('s2','organization','Acme')").run();
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) mem.upsertStub({ id: `m-${k}`, text: `memory ${k}`, namespace: 'knowledge', scopeType: 'context', scopeId: 'c' });
  mem.markSuperseded('m-a', 'm-b');
  mem.markSuperseded('m-b', 'm-c');
  mem.markSuperseded('m-e', 'm-d');
  mem.deactivateByIds(['m-d']);
  db.prepare("UPDATE memories SET is_active = 0, superseded_by = 'a-memory-the-gc-removed' WHERE id = 'm-f'").run();
  // One edge per triple in engine.db: a kind per source keeps them apart.
  for (const k of ['a', 'b', 'c', 'e', 'f']) rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: `rel_${k}`, description: k, sourceMemoryId: `m-${k}` });
  db.prepare('DELETE FROM schema_version WHERE version >= 72').run();
  db.exec('ALTER TABLE bulk_runs DROP COLUMN planner_untrusted; ALTER TABLE bulk_runs DROP COLUMN planner_grants; ALTER TABLE bulk_targets DROP COLUMN before_grants; ALTER TABLE bulk_targets DROP COLUMN write_grants; ALTER TABLE triggers DROP COLUMN last_run_member_notes; ALTER TABLE bulk_runs DROP COLUMN phase_before_undo; DROP INDEX IF EXISTS idx_bulk_runs_superseded; ALTER TABLE bulk_runs DROP COLUMN superseded_by; ALTER TABLE triggers DROP COLUMN last_escalation_chat_kind; ALTER TABLE triggers DROP COLUMN last_escalation_thread_id; ALTER TABLE triggers DROP COLUMN last_escalation_case; ALTER TABLE bulk_targets DROP COLUMN refusal_detail; ALTER TABLE bulk_targets DROP COLUMN target_title; DROP INDEX IF EXISTS idx_rel_origin_memory; ALTER TABLE relationships DROP COLUMN origin_memory_id; ALTER TABLE triggers DROP COLUMN last_run_cause;');
  engine.close();
}

function legacyBySource(path: string): Record<string, string> {
  const raw = new Database(path, { readonly: true });
  const rows = raw.prepare('SELECT relation_type AS k, source_memory_id AS s FROM relations ORDER BY relation_type').all() as Array<{ k: string; s: string }>;
  raw.close();
  return Object.fromEntries(rows.map(r => [r.k, r.s]));
}
function engineBySource(engine: EngineDb): Record<string, string> {
  const rows = engine.getDb().prepare('SELECT kind AS k, source_memory_id AS s FROM relationships ORDER BY kind').all() as Array<{ k: string; s: string }>;
  return Object.fromEntries(rows.map(r => [r.k, r.s]));
}

describe('the migration moves relations from before the rule to the end of their chain', () => {
  const MOVED = { rel_a: 'm-c', rel_b: 'm-c', rel_c: 'm-c', rel_e: 'm-d', rel_f: 'm-f' };

  it('both stores, on the first start: the whole chain to its active end, a deleted end hides, a chain without an end stays on its retired source', async () => {
    const dir = tmp();
    seedOldLegacy(join(dir, 'mem.db'));
    seedOldEngine(join(dir, 'engine.db'));
    const logged: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { logged.push(String(chunk)); return true; });

    const { layer, engine } = makeLayer({ dir });
    await layer.init();
    expect(legacyBySource(join(dir, 'mem.db'))).toEqual(MOVED);
    expect(engineBySource(engine)).toEqual(MOVED);
    // The origin is filled from the source before the move and is not moved itself.
    const ORIGIN = { rel_a: 'm-a', rel_b: 'm-b', rel_c: 'm-c', rel_e: 'm-e', rel_f: 'm-f' };
    const rawLegacy = new Database(join(dir, 'mem.db'), { readonly: true });
    expect(Object.fromEntries((rawLegacy.prepare('SELECT relation_type AS k, origin_memory_id AS o FROM relations').all() as Array<{ k: string; o: string }>).map(r => [r.k, r.o]))).toEqual(ORIGIN);
    rawLegacy.close();
    expect(Object.fromEntries((engine.getDb().prepare('SELECT kind AS k, origin_memory_id AS o FROM relationships').all() as Array<{ k: string; o: string }>).map(r => [r.k, r.o]))).toEqual(ORIGIN);

    // Counts only, per class: a and b to c, e to the deleted d, f without an end.
    const counts = logged.filter(l => l.includes('relations of replaced memories'));
    expect(counts).toHaveLength(2);
    for (const line of counts) expect(line).toContain('moved to the current memory: 2, to a deleted memory: 1, left on a memory whose successor is gone: 1');

    // Readable: only what the active end carries.
    expect(legacySources(layer)).toEqual(['m-c', 'm-c', 'm-c']);
    expect(engineSources(engine)).toEqual(['m-c', 'm-c', 'm-c']);
  });

  it('the reap of the first start, run right after the stores open, keeps every relation the chain hands to its active end', async () => {
    const dir = tmp();
    seedOldLegacy(join(dir, 'mem.db'));
    seedOldEngine(join(dir, 'engine.db'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { layer, engine } = makeLayer({ dir });
    await layer.gc();
    expect(legacyBySource(join(dir, 'mem.db'))).toEqual({ rel_a: 'm-c', rel_b: 'm-c', rel_c: 'm-c' });
    expect(engineBySource(engine)).toEqual({ rel_a: 'm-c', rel_b: 'm-c', rel_c: 'm-c' });
    expect(legacySources(layer)).toEqual(['m-c', 'm-c', 'm-c']);
    expect(engineSources(engine)).toEqual(['m-c', 'm-c', 'm-c']);
  });

  it('a chain without an end is not readable after the migration, and the GC removes its relation', async () => {
    const dir = tmp();
    seedOldLegacy(join(dir, 'mem.db'));
    seedOldEngine(join(dir, 'engine.db'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { layer, engine } = makeLayer({ dir });
    expect(legacySources(layer)).not.toContain('m-f');
    expect(engineSources(engine)).not.toContain('m-f');
    await layer.gc();
    expect(legacyBySource(join(dir, 'mem.db'))['rel_f']).toBeUndefined();
    expect(engineBySource(engine)['rel_f']).toBeUndefined();
  });

  it('running the migration again changes nothing, in either store', () => {
    const dir = tmp();
    seedOldLegacy(join(dir, 'mem.db'));
    seedOldEngine(join(dir, 'engine.db'));
    for (const [file, table] of [['mem.db', 'relations'], ['engine.db', 'relationships']] as const) {
      // From the state before the migration: the first run moves, the second changes nothing.
      const raw = new Database(join(dir, file));
      const seeded = raw.prepare(`SELECT id, source_memory_id FROM ${table} ORDER BY id`).all();
      raw.exec(repointToChainEndSql(table));
      const once = raw.prepare(`SELECT id, source_memory_id FROM ${table} ORDER BY id`).all();
      expect(once).not.toEqual(seeded);
      raw.exec(repointToChainEndSql(table));
      expect(raw.prepare(`SELECT id, source_memory_id FROM ${table} ORDER BY id`).all()).toEqual(once);
      raw.close();
    }
  });
});

describe('a hard deletion of the memory a relation came from takes it, wherever it moved', () => {
  async function consolidated(): Promise<{ layer: KnowledgeLayer; engine: EngineDb; keeper: string; victim: string }> {
    const { layer, engine } = makeLayer();
    await layer.init();
    mock.extraction = NAMES;
    const keeper = (await layer.store('Meridian AG uses PostgreSQL for the backend database layer in production.', 'knowledge', scope, { sourceThreadId: 't-keeper' })).memoryId;
    mock.extraction = EDGE;
    const victim = (await layer.store('Meridian AG uses PostgreSQL for the backend database layer.', 'knowledge', scope, { sourceThreadId: 't-victim' })).memoryId;
    expect(layer.consolidateMemories('knowledge', 'context', 'proj-1')).toBe(1);
    expect(legacySources(layer)).toEqual([keeper]);
    expect(engineSources(engine)).toEqual([keeper]);
    return { layer, engine, keeper, victim };
  }

  it('the GC of the replaced duplicate does not: what it handed on stays on the keeper', async () => {
    const { layer, engine, keeper, victim } = await consolidated();
    await layer.gc();
    expect(layer.getDb().getMemory(victim)).toBeNull();
    expect(legacySources(layer)).toEqual([keeper]);
    expect(engineSources(engine)).toEqual([keeper]);
  });

  it('purging the duplicate\'s chat removes its relations from the keeper, in both stores', async () => {
    const { layer, engine, keeper } = await consolidated();
    expect(layer.purgeThread('t-victim')).toBeGreaterThan(0);
    expect(layer.getDb().getMemory(keeper)!.is_active).toBe(1);
    expect(legacySources(layer)).toEqual([]);
    expect(engineRows(engine)).toBe(0);
  });

  it('erasing the duplicate by a pattern only it matches removes its relations from the keeper', async () => {
    const { layer, engine, keeper } = await consolidated();
    expect(await layer.eraseByPattern('backend database layer.')).toBeGreaterThan(0);
    expect(layer.getDb().getMemory(keeper)!.is_active).toBe(1);
    expect(legacySources(layer)).toEqual([]);
    expect(engineRows(engine)).toBe(0);
  });

  it('the person erasure\'s purge of the duplicate removes its relations from the keeper', async () => {
    const { layer, engine, victim } = await consolidated();
    layer.purgeMemoryStubsForErasure([victim]);
    layer.purgeLegacyMemoriesForErasure([victim], []);
    expect(legacySources(layer)).toEqual([]);
    expect(engineRows(engine)).toBe(0);
  });
});

describe('the origin is never moved: a → b → c', () => {
  function legacyChain(): { db: AgentMemoryDb; ids: Record<string, string> } {
    const db = new AgentMemoryDb(join(tmp(), 'mem.db'));
    closers.push(() => db.close());
    const x = db.createEntity({ canonicalName: 'Alice', entityType: 'person', scopeType: 'global', scopeId: 'g' });
    const y = db.createEntity({ canonicalName: 'Acme', entityType: 'organization', scopeType: 'global', scopeId: 'g' });
    const ids: Record<string, string> = {};
    for (const k of ['a', 'b', 'c', 'other']) ids[k] = db.createMemory({ text: `memory ${k}`, namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
    // Mentions from another memory keep both entities out of the orphan reap.
    db.createMention(ids['other']!, x); db.createMention(ids['other']!, y);
    db.createRelation(x, y, 'works_at', 'CTO', ids['a']!);
    db.supersedMemory(ids['a']!, ids['b']!); db.repointRelations(ids['a']!, ids['b']!);
    db.supersedMemory(ids['b']!, ids['c']!); db.repointRelations(ids['b']!, ids['c']!);
    expect(db.listAllRelations().map(r => r.source_memory_id)).toEqual([ids['c']]);
    return { db, ids };
  }
  function engineChain(): { engine: EngineDb; mem: MemoryGraphStore } {
    const engine = new EngineDb(join(tmp(), 'engine.db'), '');
    closers.push(() => engine.close());
    const mem = new MemoryGraphStore(engine);
    engine.getDb().prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1','person','Alice'),('s2','organization','Acme')").run();
    for (const k of ['a', 'b', 'c']) mem.upsertStub({ id: k, text: k, namespace: 'knowledge', scopeType: 'context', scopeId: 'c' });
    new RelationshipStore(engine).createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_at', description: 'CTO', sourceMemoryId: 'a' });
    mem.markSuperseded('a', 'b', { carryRelationships: true });
    mem.markSuperseded('b', 'c', { carryRelationships: true });
    expect(engineSources(engine)).toEqual(['c']);
    return { engine, mem };
  }

  it('erasing the step in between keeps the relation, in both stores', () => {
    const { db, ids } = legacyChain();
    db.purgeMemoriesByIds([ids['b']!]);
    expect(db.listAllRelations().map(r => r.source_memory_id)).toEqual([ids['c']]);
    const { engine, mem } = engineChain();
    mem.purgeMemories(['b']);
    expect(engineSources(engine)).toEqual(['c']);
  });

  it('erasing the first memory removes the relation, in both stores', () => {
    const { db, ids } = legacyChain();
    db.purgeMemoriesByIds([ids['a']!]);
    expect(db.listAllRelations()).toEqual([]);
    const { engine, mem } = engineChain();
    mem.purgeMemories(['a']);
    expect(engineRows(engine)).toBe(0);
  });

  it('a re-assert that writes the description takes the writer as origin; one that keeps it keeps the origin', () => {
    const { engine } = engineChain();
    const rels = new RelationshipStore(engine);
    const origin = (): string | null => (engine.getDb().prepare('SELECT origin_memory_id AS o FROM relationships').get() as { o: string | null }).o;
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_at', description: '', sourceMemoryId: 'c' });
    expect(origin()).toBe('a');
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_at', description: 'CEO', sourceMemoryId: 'c' });
    expect(origin()).toBe('c');
  });
});

describe('a successor without an engine.db stub gets one before relations move to it', () => {
  it('consolidation: the keeper\'s stub is written from its legacy row, the mirror stands and the edges move', async () => {
    const { layer, engine } = makeLayer();
    await layer.init();
    mock.extraction = NONE;
    const keeper = (await layer.store('Meridian AG uses PostgreSQL for the backend database layer in production.', 'knowledge', scope)).memoryId;
    mock.extraction = EDGE;
    const victim = (await layer.store('Meridian AG uses PostgreSQL for the backend database layer.', 'knowledge', scope)).memoryId;
    layer.getDb().confirmMemory(keeper); layer.getDb().confirmMemory(keeper); layer.getDb().confirmMemory(victim);
    // A keeper written before the subject graph: no stub in engine.db.
    engine.getDb().prepare('DELETE FROM memories WHERE id = ?').run(keeper);
    const mem = new MemoryGraphStore(engine);
    expect(mem.getStub(keeper)).toBeNull();

    expect(layer.consolidateMemories('knowledge', 'context', 'proj-1')).toBe(1);
    expect(mem.getStub(victim)!.is_active).toBe(0);
    expect(mem.getStub(keeper)!.is_active).toBe(1);
    // The stub carries the legacy count, which already holds this run's transfer; no second addition.
    const count = (engine.getDb().prepare('SELECT confirmation_count AS c FROM memories WHERE id = ?').get(keeper) as { c: number }).c;
    expect(count).toBe(layer.getDb().getMemory(keeper)!.confirmation_count);
    expect(count).toBe(3);
    expect(engineSources(engine)).toEqual([keeper]);
  });

  it('a move: the copy\'s stub is written from its legacy row and the edges move without an alarm', async () => {
    const { layer, engine } = makeLayer();
    await layer.init();
    mock.extraction = EDGE;
    const original = (await layer.store('Alice works at Acme GmbH as CTO.', 'knowledge', scope)).memoryId;
    mock.extraction = NONE;
    const copy = (await layer.store('The quarterly report shows Acme GmbH revenue grew twelve percent.', 'knowledge', { type: 'global', id: 'global' })).memoryId;
    engine.getDb().prepare('DELETE FROM memories WHERE id = ?').run(copy);
    const logged: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { logged.push(String(chunk)); return true; });

    const retired = await layer.retireForMove('Alice works at Acme', 'knowledge', scope);
    expect(() => layer.markMoved(retired, copy)).not.toThrow();
    expect(new MemoryGraphStore(engine).getStub(copy)).not.toBeNull();
    expect(engineSources(engine)).toEqual([copy]);
    expect(logged.filter(l => /CRITICAL|parity/i.test(l))).toEqual([]);
  });
});

describe('a replaced stub hands on only what is still visible', () => {
  it('a victim stub already deleted in engine.db keeps its hidden edges when the consolidation mirror retires it', () => {
    const engine = new EngineDb(join(tmp(), 'engine.db'), '');
    closers.push(() => engine.close());
    const mem = new MemoryGraphStore(engine);
    engine.getDb().prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1','person','Alice'),('s2','organization','Acme')").run();
    for (const k of ['victim', 'keeper']) mem.upsertStub({ id: k, text: k, namespace: 'knowledge', scopeType: 'context', scopeId: 'c' });
    new RelationshipStore(engine).createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_at', description: 'CTO', sourceMemoryId: 'victim' });
    mem.deactivateByIds(['victim']);
    expect(engineSources(engine)).toEqual([]);

    mem.markSuperseded('victim', 'keeper', { carryRelationships: true });
    expect(engineSources(engine)).toEqual([]);
    expect((engine.getDb().prepare('SELECT source_memory_id AS s FROM relationships').get() as { s: string }).s).toBe('victim');
  });
});

