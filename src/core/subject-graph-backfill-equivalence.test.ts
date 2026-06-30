import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { SubjectGraphBackfill } from './subject-graph-backfill.js';

/**
 * The S2 ACCEPTANCE GATE in unit form: after the backfill, the flag-ON
 * subject-graph reads (`KnowledgeLayer.listEntities/getEntityRelations` over
 * engine.db) must equal the flag-OFF legacy reads (over agent-memory.db) for every
 * MAPPABLE entity/relation — read through the real `EntityRecord`/`RelationRecord`
 * surface, not the raw store. concept/location entities + edges touching them are
 * the documented D10 bounded drop (not subjects). Proves the re-map is faithful end
 * to end, which the store-level backfill tests cannot.
 */
const MAPPABLE = new Set(['person', 'organization', 'project', 'product']);

describe('S2 backfill → KnowledgeLayer read equivalence (acceptance gate #2)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); tmpDirs.length = 0; });

  it('flag-ON reads == flag-OFF reads for every mappable entity + relation; concept/location are the bounded drop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s2eq-'));
    tmpDirs.push(dir);
    const memPath = join(dir, 'mem.db');
    const enginePath = join(dir, 'engine.db');

    // 1. Seed the legacy graph (incl. a concept + a location = the bounded drop).
    const seed = new AgentMemoryDb(memPath);
    const e = (n: string, t: string): string => seed.createEntity({ canonicalName: n, entityType: t, scopeType: 'global', scopeId: 'g' });
    const alice = e('Alice Schmidt', 'person');
    const acme = e('Acme GmbH', 'organization');
    const phoenix = e('Project Phoenix', 'project');   // → engagement subject
    e('Widget Pro', 'product');
    const gdpr = e('GDPR', 'concept');                  // dropped on flag-ON
    e('Zürich', 'location');                            // dropped on flag-ON
    seed.createRelation(alice, acme, 'works_at', '', '');
    seed.createRelation(alice, phoenix, 'works_on', '', '');
    seed.createRelation(alice, gdpr, 'knows_about', '', ''); // edge to a concept → bounded drop
    seed.close();

    // 2. Backfill.
    const engine = new EngineDb(enginePath, '');
    const memForBackfill = new AgentMemoryDb(memPath);
    new SubjectGraphBackfill(engine, memForBackfill).run();
    memForBackfill.close();

    // 3. Read both ways over the same files.
    const off = new KnowledgeLayer(memPath, new LocalProvider(), undefined, undefined, undefined, false);
    const on = new KnowledgeLayer(memPath, new LocalProvider(), undefined, undefined, engine, true);

    // 4a. Entity equivalence: the MAPPABLE (type, name) set is identical.
    const key = (x: { canonicalName: string; entityType: string }): string => `${x.entityType}:${x.canonicalName}`;
    const offEntities = (await off.listEntities()).filter(x => MAPPABLE.has(x.entityType));
    const onEntities = await on.listEntities();
    expect(onEntities.map(key).sort()).toEqual(offEntities.map(key).sort());
    expect(onEntities.map(key).sort()).toEqual(['organization:Acme GmbH', 'person:Alice Schmidt', 'product:Widget Pro', 'project:Project Phoenix']);
    // Bounded drop: concept/location present OFF, absent ON.
    expect((await off.listEntities()).some(x => x.entityType === 'concept' || x.entityType === 'location')).toBe(true);
    expect(onEntities.some(x => x.entityType === 'concept' || x.entityType === 'location')).toBe(false);

    // 4b. Relation equivalence for the hub (Alice): mappable↔mappable edges match;
    //     the edge to the concept (GDPR) is the documented drop on the ON side.
    const relSet = async (layer: KnowledgeLayer, id: string, resolve: (oid: string) => Promise<string | null>): Promise<string[]> => {
      const out: string[] = [];
      for (const r of await layer.getEntityRelations(id)) {
        const otherId = r.fromEntityId === id ? r.toEntityId : r.fromEntityId;
        const name = await resolve(otherId);
        if (name !== null) out.push(`${r.relationType}->${name}`);
      }
      return out.sort();
    };
    const offResolve = async (oid: string): Promise<string | null> => (await off.getEntity(oid))?.canonicalName ?? null;
    const onResolve = async (oid: string): Promise<string | null> => (await on.getEntity(oid))?.canonicalName ?? null;
    const aliceSubjectId = onEntities.find(x => x.canonicalName === 'Alice Schmidt')!.id;
    const offAliceRels = (await relSet(off, alice, offResolve)).filter(s => !s.endsWith('->GDPR')); // drop the concept edge
    const onAliceRels = await relSet(on, aliceSubjectId, onResolve);
    expect(onAliceRels).toEqual(offAliceRels);
    expect(onAliceRels).toEqual(['works_at->Acme GmbH', 'works_on->Project Phoenix']);

    engine.close();
  });
});
