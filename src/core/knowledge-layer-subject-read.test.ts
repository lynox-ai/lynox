import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { MemoryScopeRef, ContradictionInfo } from '../types/index.js';

/**
 * S1d: the flag-gated subject-graph READ migration. When `subjectGraphEnabled`,
 * the entity/relation read methods (listEntities/searchEntities/getEntity/
 * getEntityRelations/stats) serve from the engine.db subject-graph (populated by
 * the S1b mirror) instead of legacy agent-memory.db — mapped back to the byte-stable
 * EntityRecord/RelationRecord DTOs. Flag OFF → legacy, untouched. The V1 extractor +
 * contradiction detector are mocked so the populated subjects/edges are deterministic
 * (anthropicClient = undefined forces the V1 path, so the mock is exercised).
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

describe('KnowledgeLayer subject-graph READ migration (S1d)', () => {
  const tmpDirs: string[] = [];
  const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
  const TEXT = 'Alice Schmidt is CTO at Acme GmbH building Widget Pro for Project Phoenix using Shopify.';

  function makeLayer(opts: { flag: boolean; withEngine?: boolean }): { layer: KnowledgeLayer; engine: EngineDb | null } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-kls1d-'));
    tmpDirs.push(dir);
    const engine = (opts.withEngine ?? true) ? new EngineDb(join(dir, 'engine.db'), '') : null;
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), new LocalProvider(), undefined, undefined,
      engine ?? undefined, opts.flag,
    );
    return { layer, engine };
  }

  /** Person/org/product/project(+concept) entities + one works_at edge. */
  function seedExtraction(): void {
    mock.extraction = {
      entities: [
        { name: 'Acme GmbH', type: 'organization', confidence: 0.9 },
        { name: 'Alice Schmidt', type: 'person', confidence: 0.9 },
        { name: 'Widget Pro', type: 'product', confidence: 0.8 },
        { name: 'Project Phoenix', type: 'project', confidence: 0.7 },  // → engagement subject
        { name: 'Shopify', type: 'concept', confidence: 0.6 },          // NOT a subject → dropped
      ],
      relations: [
        { from: 'Alice Schmidt', to: 'Acme GmbH', relationType: 'works_at', description: 'CTO' },
      ],
    };
  }

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
    mock.extraction = { entities: [], relations: [] };
    mock.contradictions = [];
    vi.clearAllMocks();
  });

  it('flag ON: listEntities maps subjects → EntityRecord (reverse kind), drops non-subject kinds, full shape', async () => {
    seedExtraction();
    const { layer } = makeLayer({ flag: true });
    await layer.init();
    await layer.store(TEXT, 'knowledge', scope);

    const entities = await layer.listEntities();
    const byName = new Map(entities.map(e => [e.canonicalName, e]));
    // Shopify (concept) dropped; engagement maps back to 'project'.
    expect([...byName.keys()].sort()).toEqual(['Acme GmbH', 'Alice Schmidt', 'Project Phoenix', 'Widget Pro']);
    expect(byName.get('Alice Schmidt')!.entityType).toBe('person');
    expect(byName.get('Acme GmbH')!.entityType).toBe('organization');
    expect(byName.get('Widget Pro')!.entityType).toBe('product');
    expect(byName.get('Project Phoenix')!.entityType).toBe('project');

    const e = byName.get('Acme GmbH')!;
    expect(e).toMatchObject({
      canonicalName: 'Acme GmbH', entityType: 'organization', description: '',
      scopeType: 'global', scopeId: 'global', mentionCount: 0,
    });
    expect(typeof e.id).toBe('string');
    expect(Array.isArray(e.aliases)).toBe(true);
    expect(typeof e.firstSeenAt).toBe('string');
    expect(typeof e.lastSeenAt).toBe('string');
  });

  it('flag ON: list / search / getEntity share one ID space (round-trip)', async () => {
    seedExtraction();
    const { layer } = makeLayer({ flag: true });
    await layer.init();
    await layer.store(TEXT, 'knowledge', scope);

    const listed = await layer.listEntities();
    const acme = listed.find(e => e.canonicalName === 'Acme GmbH')!;
    const got = await layer.getEntity(acme.id);
    expect(got).not.toBeNull();
    expect(got!.canonicalName).toBe('Acme GmbH');

    const searched = await layer.searchEntities('acme', 50);
    expect(searched.map(e => e.id)).toContain(acme.id);  // same id as the list → /:id resolves
  });

  it('flag ON: getEntityRelations maps edges → RelationRecord', async () => {
    seedExtraction();
    const { layer } = makeLayer({ flag: true });
    await layer.init();
    await layer.store(TEXT, 'knowledge', scope);

    const listed = await layer.listEntities();
    const alice = listed.find(e => e.canonicalName === 'Alice Schmidt')!;
    const acme = listed.find(e => e.canonicalName === 'Acme GmbH')!;
    const rels = await layer.getEntityRelations(alice.id);
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      fromEntityId: alice.id, toEntityId: acme.id, relationType: 'works_at', description: 'CTO',
    });
    expect(typeof rels[0]!.confidence).toBe('number');
    expect(rels[0]!.createdAt).toBeTruthy();
    expect(rels[0]!.sourceMemoryId).toBeDefined();  // '' or an id, never undefined
  });

  it('flag ON: stats — entities/relations from subject-graph; memoryCount stays legacy (counts subject-less)', async () => {
    seedExtraction();
    const { layer } = makeLayer({ flag: true });
    await layer.init();
    await layer.store(TEXT, 'knowledge', scope);                  // 4 subjects + 1 edge (+ mirrored stub)
    mock.extraction = { entities: [], relations: [] };            // a subject-LESS memory → NO subject-graph stub
    await layer.store('Remember to file the quarterly taxes before the April 15 deadline.', 'knowledge', scope);

    const s = await layer.stats();
    expect(s.entityCount).toBe(4);    // unchanged — the 2nd memory minted no subject
    expect(s.relationCount).toBe(1);
    // BOTH memories counted → legacy authority. A subject-graph stub-count would be 1
    // (the subject-less memory gets no stub), so this assertion fails if memoryCount regresses to countActive().
    expect(s.memoryCount).toBe(2);
    expect(s.communityCount).toBe(0);
  });

  it('flag ON: searchEntities = name/alias substring (hit + miss)', async () => {
    seedExtraction();
    const { layer } = makeLayer({ flag: true });
    await layer.init();
    await layer.store(TEXT, 'knowledge', scope);

    const hit = await layer.searchEntities('widget', 50);
    expect(hit.map(e => e.canonicalName)).toEqual(['Widget Pro']);
    expect(await layer.searchEntities('zzz-no-match', 50)).toEqual([]);
  });

  it('flag ON: listEntities type filter maps legacy entity_type → subject kind; non-subject type → empty', async () => {
    seedExtraction();
    const { layer } = makeLayer({ flag: true });
    await layer.init();
    await layer.store(TEXT, 'knowledge', scope);

    expect((await layer.listEntities({ type: 'person' })).map(e => e.canonicalName)).toEqual(['Alice Schmidt']);
    expect((await layer.listEntities({ type: 'project' })).map(e => e.canonicalName)).toEqual(['Project Phoenix']);
    expect(await layer.listEntities({ type: 'concept' })).toEqual([]);  // concept → no subject kind
  });

  it('flag ON: kinds with no KG equivalent (service/other) are excluded; aliases round-trip', async () => {
    const { layer, engine } = makeLayer({ flag: true });
    await layer.init();
    const subs = new SubjectStore(engine!);
    const svc = subs.findOrCreate({ kind: 'service', name: 'Onboarding Service' });
    const other = subs.findOrCreate({ kind: 'other', name: 'Misc Thing' });
    const bob = subs.findOrCreate({ kind: 'person', name: 'Bob Meier', aliases: ['Bobby', 'Robert'] });

    const list = await layer.listEntities();
    const names = list.map(e => e.canonicalName);
    expect(names).not.toContain('Onboarding Service');  // service excluded
    expect(names).not.toContain('Misc Thing');          // other excluded
    expect(names).toContain('Bob Meier');

    expect(await layer.getEntity(svc.id)).toBeNull();    // kind has no EntityType → null
    expect(await layer.getEntity(other.id)).toBeNull();
    expect((await layer.getEntity(bob.id))!.aliases.sort()).toEqual(['Bobby', 'Robert']);
  });

  it('flag ON: getEntityRelations caps at the legacy default (50)', async () => {
    const { layer, engine } = makeLayer({ flag: true });
    await layer.init();
    const subs = new SubjectStore(engine!);
    const rels = new RelationshipStore(engine!);
    const hub = subs.findOrCreate({ kind: 'person', name: 'Hub Person' });
    for (let i = 0; i < 55; i++) {
      const t = subs.findOrCreate({ kind: 'organization', name: `Org ${i}` });
      rels.createRelationship({ fromSubjectId: hub.id, toSubjectId: t.id, kind: 'works_at' });
    }
    expect(await layer.getEntityRelations(hub.id)).toHaveLength(50);  // capped, not 55
  });

  it('flag ON: getEntity returns null for an unknown id', async () => {
    const { layer } = makeLayer({ flag: true });
    await layer.init();
    expect(await layer.getEntity('does-not-exist')).toBeNull();
  });

  it('flag OFF (engine present): reads use legacy agent-memory.db, NOT the subject-graph', async () => {
    seedExtraction();
    const { layer } = makeLayer({ flag: false });
    await layer.init();
    await layer.store(TEXT, 'knowledge', scope);

    // Legacy keeps concept entities (the subject-graph drops them) → differential proof of the legacy path.
    const names = (await layer.listEntities()).map(e => e.canonicalName);
    expect(names).toContain('Shopify');
  });

  it('flag ON: a broken engine.db read falls back to legacy + logs, never crashes', async () => {
    seedExtraction();
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { layer, engine } = makeLayer({ flag: true });
    try {
      await layer.init();
      await layer.store(TEXT, 'knowledge', scope);  // populates BOTH legacy + subject-graph
      engine!.close();                              // subject-graph reads now throw on the closed connection

      const list = await layer.listEntities();
      expect(list.some(e => e.canonicalName === 'Shopify')).toBe(true);  // legacy keeps concepts → fell back
      expect(Array.isArray(await layer.getEntityRelations('whatever'))).toBe(true);  // threw → legacy ([])
      expect((await layer.stats()).entityCount).toBeGreaterThanOrEqual(5);           // threw → legacy count
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[lynox:subject-graph] read'));
    } finally {
      errSpy.mockRestore();
      await layer.close();
    }
  });

  it('flag ON but no engineDb: stores are null → guard falls back to legacy reads', async () => {
    seedExtraction();
    const { layer } = makeLayer({ flag: true, withEngine: false });
    await layer.init();
    await layer.store(TEXT, 'knowledge', scope);

    const names = (await layer.listEntities()).map(e => e.canonicalName);
    expect(names).toContain('Shopify');  // legacy path (subjectStore === null)
  });
});
