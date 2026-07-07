import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';

/**
 * Flag-ON (`subject_graph_enabled`) KG graph-read path: `getGraph` returns the
 * CONNECTED subgraph — the most-recent relationships (edges) plus exactly the
 * subjects they touch (nodes) — and `mentionCount` reflects the real
 * memory_subjects link count (the "0× Erwähnungen" bug fix), not a hardcoded 0.
 * Seeds the engine.db subject-graph DIRECTLY (subjects + relationships +
 * memory_subjects links) so the graph is deterministic without the extractor.
 */
describe('KnowledgeLayer getGraph + mentionCount (subject-graph read)', () => {
  const tmpDirs: string[] = [];

  interface Seed {
    layer: KnowledgeLayer;
    engine: EngineDb;
    subs: SubjectStore;
    ids: { alice: string; acme: string; widget: string; orphan: string };
  }

  /** 4 subjects (3 connected + 1 orphan), 2 edges, memory_subjects: alice×2, acme×1, widget×1. */
  function makeSeed(): Seed {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-klgraph-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), new LocalProvider(), undefined, undefined, engine, true,
    );

    const subs = new SubjectStore(engine);
    const rels = new RelationshipStore(engine);
    const mgs = new MemoryGraphStore(engine);

    const alice = subs.findOrCreate({ kind: 'person', name: 'Alice Schmidt' }).id;
    const acme = subs.findOrCreate({ kind: 'organization', name: 'Acme GmbH' }).id;
    const widget = subs.findOrCreate({ kind: 'product', name: 'Widget Pro' }).id;
    const orphan = subs.findOrCreate({ kind: 'person', name: 'Nobody Connected' }).id;

    rels.createRelationship({ fromSubjectId: alice, toSubjectId: acme, kind: 'works_at', description: 'CTO' });
    rels.createRelationship({ fromSubjectId: acme, toSubjectId: widget, kind: 'makes' });

    // memory_subjects links (FK: the memory stub must exist first).
    const link = (memId: string, subjectIds: string[]): void => {
      mgs.upsertStub({ id: memId, text: `mem ${memId}`, namespace: 'knowledge', scopeType: 'global', scopeId: 'global' });
      mgs.linkSubjects(memId, subjectIds);
    };
    link('m1', [alice, acme]);
    link('m2', [alice]);   // alice → 2 links total
    link('m3', [widget]);  // acme → 1, widget → 1

    return { layer, engine, subs, ids: { alice, acme, widget, orphan } };
  }

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('flag ON: getGraph returns exactly the connected subjects as nodes, edges with both endpoints present', async () => {
    const { layer, ids } = makeSeed();
    await layer.init();

    const graph = await layer.getGraph(80);
    const nodeIds = new Set(graph.nodes.map(n => n.id));

    // Exactly the 3 edge-touched subjects — the orphan (no edge) is NOT a node.
    expect(nodeIds).toEqual(new Set([ids.alice, ids.acme, ids.widget]));
    expect(nodeIds.has(ids.orphan)).toBe(false);

    // Both edges present, and every edge's endpoints are among the returned nodes.
    expect(graph.edges).toHaveLength(2);
    for (const e of graph.edges) {
      expect(nodeIds.has(e.fromEntityId)).toBe(true);
      expect(nodeIds.has(e.toEntityId)).toBe(true);
    }
    const edgeKinds = graph.edges.map(e => e.relationType).sort();
    expect(edgeKinds).toEqual(['makes', 'works_at']);

    await layer.close();
  });

  it('flag ON: getGraph nodes carry the real memory_subjects mentionCount (not hardcoded 0)', async () => {
    const { layer, ids } = makeSeed();
    await layer.init();

    const graph = await layer.getGraph(80);
    const byId = new Map(graph.nodes.map(n => [n.id, n]));

    expect(byId.get(ids.alice)!.mentionCount).toBe(2);
    expect(byId.get(ids.acme)!.mentionCount).toBe(1);
    expect(byId.get(ids.widget)!.mentionCount).toBe(1);

    await layer.close();
  });

  it('flag ON: getGraph drops an edge whose endpoint was archived (node filtered out)', async () => {
    const { layer, subs, ids } = makeSeed();
    await layer.init();

    subs.archiveSubject(ids.widget);   // the acme→widget edge loses an endpoint

    const graph = await layer.getGraph(80);
    const nodeIds = new Set(graph.nodes.map(n => n.id));
    expect(nodeIds.has(ids.widget)).toBe(false);              // archived node dropped
    expect(graph.edges.map(e => e.relationType)).toEqual(['works_at']);  // 'makes' edge dropped
    // acme survives — it still has the alice→acme edge (not orphaned by widget's loss).
    expect(nodeIds.has(ids.acme)).toBe(true);

    await layer.close();
  });

  it('flag ON: getGraph prunes nodes left orphan when the hub endpoint is archived', async () => {
    const { layer, subs, ids } = makeSeed();
    await layer.init();

    // Archive the hub `acme`: BOTH edges (alice→acme, acme→widget) lose an endpoint,
    // so alice + widget have no surviving edge → they must be pruned, not left as
    // edge-less orphan nodes. Result: an empty connected subgraph.
    subs.archiveSubject(ids.acme);

    const graph = await layer.getGraph(80);
    expect(graph.edges).toHaveLength(0);
    expect(graph.nodes).toHaveLength(0);   // no orphan alice/widget nodes leak through

    await layer.close();
  });

  it('flag ON: listEntities reports the real mentionCount for a subject with links (0× bug fix)', async () => {
    const { layer, ids } = makeSeed();
    await layer.init();

    const entities = await layer.listEntities();
    const byId = new Map(entities.map(e => [e.id, e]));

    // The subject path previously hardcoded 0 for every entity.
    expect(byId.get(ids.alice)!.mentionCount).toBe(2);
    expect(byId.get(ids.acme)!.mentionCount).toBe(1);
    expect(byId.get(ids.orphan)!.mentionCount).toBe(0);  // no links → 0 (not undefined)

    await layer.close();
  });
});
