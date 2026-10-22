import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentMemoryDb } from './agent-memory-db.js';
import { EngineDb } from './engine-db.js';
import { RelationshipStore } from './relationship-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import type { ExtractionResult } from './entity-extractor.js';

/**
 * A relation whose source memory the user deleted is left out of every read, in
 * both relation stores, and only the export still shows it, marked. A replaced
 * memory, a missing one (reaped) and no source at all keep the relation readable.
 */
const mock = vi.hoisted(() => ({ extraction: { entities: [], relations: [] } as ExtractionResult }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});
vi.mock('./contradiction-detector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contradiction-detector.js')>();
  return { ...actual, detectContradictions: vi.fn(async () => []) };
});

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-relsrc-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
  mock.extraction = { entities: [], relations: [] };
});

describe('legacy relations: the source state decides what is read', () => {
  function seed(): { db: AgentMemoryDb; a: string; b: string; src: string; bMem: string } {
    const db = new AgentMemoryDb(join(tmp(), 'mem.db'));
    const a = db.createEntity({ canonicalName: 'Alice', entityType: 'person', scopeType: 'global', scopeId: 'g' });
    const b = db.createEntity({ canonicalName: 'Acme', entityType: 'organization', scopeType: 'global', scopeId: 'g' });
    const src = db.createMemory({ text: 'Alice works at Acme', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
    db.createRelation(a, b, 'works_at', 'CTO', src);
    // A memory mentioning Acme, reached from Alice over the edge.
    const bMem = db.createMemory({ text: 'Acme ships widgets', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [0, 1, 0] });
    db.createMention(bMem, b);
    return { db, a, b, src, bMem };
  }

  function reads(db: AgentMemoryDb, a: string, b: string): Record<string, number> {
    return {
      relations: db.getEntityRelations(a).length,
      count: db.getRelationCount(),
      expand: db.getRelatedMemoriesViaEntities(a, 2, true, 10).length,
      path: db.findPath(a, b).length,
      hoodEntities: db.getNeighborhood(a, 1).entities.length,
      hoodRelations: db.getNeighborhood(a, 1).relations.length,
      backfill: db.listAllRelations().length,
    };
  }
  const ALL = { relations: 1, count: 1, expand: 1, path: 1, hoodEntities: 1, hoodRelations: 1, backfill: 1 };
  const NONE = { relations: 0, count: 0, expand: 0, path: 0, hoodEntities: 0, hoodRelations: 0, backfill: 0 };

  it('an active source keeps the relation in every read', () => {
    const { db, a, b } = seed();
    expect(reads(db, a, b)).toEqual(ALL);
    db.close();
  });

  it('a deleted source hides the relation from every read', () => {
    const { db, a, b } = seed();
    expect(db.deactivateMemoriesByPattern('Alice works at')).toHaveLength(1);
    expect(reads(db, a, b)).toEqual(NONE);
    db.close();
  });

  it('a replaced source keeps the relation', () => {
    const { db, a, b, src } = seed();
    const next = db.createMemory({ text: 'Alice leads Acme', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [0, 0, 1] });
    expect(db.supersedMemory(src, next)).toBe(true);
    expect(reads(db, a, b)).toEqual(ALL);
    db.close();
  });

  it('a source the reap already removed keeps the relation (its cause cannot be told)', () => {
    const { db, a, b, src } = seed();
    const next = db.createMemory({ text: 'Alice leads Acme', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [0, 0, 1] });
    db.supersedMemory(src, next);
    db.gc();
    expect(db.getMemory(src)).toBeNull();
    expect(reads(db, a, b)).toEqual(ALL);
    db.close();
  });

  it('a deleted source two hops away cuts the path and the neighbourhood there', () => {
    const { db, a, b } = seed();
    const c = db.createEntity({ canonicalName: 'Widget', entityType: 'product', scopeType: 'global', scopeId: 'g' });
    const far = db.createMemory({ text: 'Acme makes Widget', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [0, 0, 1] });
    db.createRelation(b, c, 'makes', '', far);
    expect(db.findPath(a, c).length).toBe(2);
    expect(db.getNeighborhood(a, 2).entities.map(e => e.canonical_name).sort()).toEqual(['Acme', 'Widget']);

    db.deactivateMemoriesByPattern('Acme makes Widget');
    expect(db.findPath(a, c)).toEqual([]);
    expect(db.getNeighborhood(a, 2).entities.map(e => e.canonical_name)).toEqual(['Acme']);
    db.close();
  });

  it('the export reads the relation of a deleted source, marked', () => {
    const { db, a } = seed();
    expect(db.getEntityRelationsForExport(a).map(r => r.source_deleted)).toEqual([0]);
    db.deactivateMemoriesByPattern('Alice works at');
    const rows = db.getEntityRelationsForExport(a);
    expect(rows.map(r => [r.description, r.source_deleted])).toEqual([['CTO', 1]]);
    db.close();
  });
});

describe('engine.db relationships: the source state decides what is read', () => {
  function seed(sourced: boolean): { engine: EngineDb; rels: RelationshipStore; mem: MemoryGraphStore } {
    const engine = new EngineDb(join(tmp(), 'engine.db'), '');
    const rels = new RelationshipStore(engine);
    const mem = new MemoryGraphStore(engine);
    const db = engine.getDb();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1','person','Alice'),('s2','organization','Acme')").run();
    mem.upsertStub({ id: 'm1', text: 'Alice works at Acme', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    // A memory on Acme, reached from Alice over the edge.
    mem.upsertStub({ id: 'm2', text: 'Acme ships widgets', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    mem.linkSubjects('m2', ['s2']);
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_at', description: 'CTO', ...(sourced ? { sourceMemoryId: 'm1' } : {}) });
    return { engine, rels, mem };
  }

  function reads(rels: RelationshipStore, mem: MemoryGraphStore): Record<string, number> {
    return {
      from: rels.getRelationshipsFrom('s1').length,
      fromKind: rels.getRelationshipsFrom('s1', 'works_at').length,
      to: rels.getRelationshipsTo('s2').length,
      toKind: rels.getRelationshipsTo('s2', 'works_at').length,
      subject: rels.getRelationshipsForSubject('s1').length,
      subjectCapped: rels.getRelationshipsForSubject('s1', 10).length,
      recent: rels.listRecent(10).length,
      count: rels.count(),
      expand: mem.relatedMemoriesViaSubjects('s1', true, 10).length,
    };
  }
  const ALL = { from: 1, fromKind: 1, to: 1, toKind: 1, subject: 1, subjectCapped: 1, recent: 1, count: 1, expand: 1 };
  const NONE = { from: 0, fromKind: 0, to: 0, toKind: 0, subject: 0, subjectCapped: 0, recent: 0, count: 0, expand: 0 };

  it('an active source keeps the edge in every read', () => {
    const { engine, rels, mem } = seed(true);
    expect(reads(rels, mem)).toEqual(ALL);
    engine.close();
  });

  it('a deleted source hides the edge from every read', () => {
    const { engine, rels, mem } = seed(true);
    expect(mem.deactivateByIds(['m1'])).toBe(1);
    expect(reads(rels, mem)).toEqual(NONE);
    engine.close();
  });

  it('a replaced source keeps the edge', () => {
    const { engine, rels, mem } = seed(true);
    mem.upsertStub({ id: 'm3', text: 'Alice leads Acme', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    mem.markSuperseded('m1', 'm3');
    expect(reads(rels, mem)).toEqual(ALL);
    engine.close();
  });

  it('an edge without a source (CRM, backfill, a reaped source) stays readable', () => {
    const { engine, rels, mem } = seed(false);
    expect(reads(rels, mem)).toEqual(ALL);
    engine.close();
  });

  it('the export reads the edge of a deleted source, marked', () => {
    const { engine, rels, mem } = seed(true);
    expect(rels.getRelationshipsForSubjectForExport('s1', 10).map(r => r.source_deleted)).toEqual([0]);
    mem.deactivateByIds(['m1']);
    const rows = rels.getRelationshipsForSubjectForExport('s1', 10);
    expect(rows.map(r => [r.description, r.source_deleted])).toEqual([['CTO', 1]]);
    engine.close();
  });
});

describe('an edge description stays with its source', () => {
  function make(): { engine: EngineDb; rels: RelationshipStore; mem: MemoryGraphStore } {
    const engine = new EngineDb(join(tmp(), 'engine.db'), '');
    const rels = new RelationshipStore(engine);
    const mem = new MemoryGraphStore(engine);
    engine.getDb().prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1','person','Alice'),('s2','organization','Acme')").run();
    for (const id of ['m1', 'm2']) {
      mem.upsertStub({ id, text: `fact ${id}`, namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    }
    return { engine, rels, mem };
  }
  const edge = (rels: RelationshipStore) => rels.getRelationshipsForSubjectForExport('s1', 10)[0]!;

  it('a re-assert from another source replaces the description, even with none', () => {
    const { engine, rels, mem } = make();
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_at', description: 'CTO since 2024', sourceMemoryId: 'm1' });
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_at', sourceMemoryId: 'm2' });
    expect([edge(rels).description, edge(rels).source_memory_id]).toEqual(['', 'm2']);
    // The first memory deleted: its text is in no relation any more.
    mem.deactivateByIds(['m1']);
    const texts = engine.getDb().prepare('SELECT description FROM relationships').all() as { description: string }[];
    expect(texts.map(t => t.description)).not.toContain('CTO since 2024');
    engine.close();
  });

  it('a re-assert from the same source keeps a filled description over an empty one', () => {
    const { engine, rels } = make();
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_at', description: 'CTO', sourceMemoryId: 'm1' });
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_at', sourceMemoryId: 'm1' });
    expect([edge(rels).description, edge(rels).source_memory_id]).toEqual(['CTO', 'm1']);
    engine.close();
  });

  it('a re-assert without a source makes the edge sourceless with its own description', () => {
    const { engine, rels, mem } = make();
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_for', description: 'CTO', sourceMemoryId: 'm1' });
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_for' });
    expect([edge(rels).description, edge(rels).source_memory_id]).toEqual(['', null]);
    // The edge no longer hangs on m1: deleting it leaves the edge, and m1's text is gone.
    mem.deactivateByIds(['m1']);
    expect(rels.getRelationshipsForSubject('s1')).toHaveLength(1);
    engine.close();
  });

  it('an edge without a source is not taken over by a memory', () => {
    const { engine, rels, mem } = make();
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_for' });
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_for', description: 'CTO', sourceMemoryId: 'm1' });
    expect([edge(rels).description, edge(rels).source_memory_id]).toEqual(['', null]);
    mem.deactivateByIds(['m1']);
    expect(rels.getRelationshipsForSubject('s1')).toHaveLength(1);
    engine.close();
  });

  it('a re-assert onto an edge hidden by a deletion shows it again without the deleted text', () => {
    const { engine, rels, mem } = make();
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_for', description: 'CTO', sourceMemoryId: 'm1' });
    mem.deactivateByIds(['m1']);
    expect(rels.getRelationshipsForSubject('s1')).toEqual([]);
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_for' });
    expect(rels.getRelationshipsForSubject('s1').map(r => [r.description, r.source_memory_id])).toEqual([['', null]]);
    engine.close();
  });

  it('a re-assert from another source with a description takes it', () => {
    const { engine, rels } = make();
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_at', description: 'CTO', sourceMemoryId: 'm1' });
    rels.createRelationship({ fromSubjectId: 's1', toSubjectId: 's2', kind: 'works_at', description: 'CEO', sourceMemoryId: 'm2' });
    expect([edge(rels).description, edge(rels).source_memory_id]).toEqual(['CEO', 'm2']);
    engine.close();
  });
});

describe('knowledge layer: a memory deleted by the user takes its relations out of the reads', () => {
  for (const flag of [false, true]) {
    it(`subject graph ${flag ? 'on' : 'off'}: hidden from the relations, kept and marked in the export`, async () => {
      mock.extraction = {
        entities: [
          { name: 'Alice Schmidt', type: 'person', confidence: 0.9 },
          { name: 'Acme GmbH', type: 'organization', confidence: 0.9 },
        ],
        relations: [{ from: 'Alice Schmidt', to: 'Acme GmbH', relationType: 'works_at', description: 'CTO' }],
      };
      const dir = tmp();
      const engine = new EngineDb(join(dir, 'engine.db'), '');
      const layer = new KnowledgeLayer(join(dir, 'mem.db'), new LocalProvider(), undefined, undefined, engine, flag);
      try {
        await layer.init();
        await layer.store('Alice Schmidt is CTO at Acme GmbH.', 'knowledge', { type: 'context', id: 'p1' });
        const alice = (await layer.listEntities()).find(e => e.canonicalName === 'Alice Schmidt')!;
        expect((await layer.getEntityRelations(alice.id)).map(r => r.description)).toEqual(['CTO']);
        expect((await layer.getEntityRelationsForExport(alice.id)).map(r => r.sourceDeleted)).toEqual([false]);

        expect(await layer.deactivateByPattern('Alice Schmidt is CTO')).toBeGreaterThan(0);

        expect(await layer.getEntityRelations(alice.id)).toEqual([]);
        expect((await layer.getGraph(50)).edges).toEqual([]);
        expect((await layer.stats()).relationCount).toBe(0);
        const exported = await layer.getEntityRelationsForExport(alice.id);
        expect(exported.map(r => [r.description, r.sourceDeleted])).toEqual([['CTO', true]]);
      } finally {
        await layer.close();
        engine.close();
      }
    });
  }
});
