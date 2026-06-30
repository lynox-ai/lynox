import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * S1b integration: the flag-gated additive mirror from KnowledgeLayer.store()
 * into the engine.db subject-graph. The V1 extractor is mocked so the extraction
 * (entities + relations) is fully deterministic — no LLM, no reliance on regex.
 */
const mock = vi.hoisted(() => ({ extraction: { entities: [], relations: [] } as ExtractionResult }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});

describe('KnowledgeLayer → engine.db subject-graph mirror (S1b)', () => {
  const tmpDirs: string[] = [];
  const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };

  function makeLayer(opts: { flag: boolean; withEngine?: boolean }): { layer: KnowledgeLayer; engine: EngineDb | null } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-klsg-'));
    tmpDirs.push(dir);
    const engine = (opts.withEngine ?? true) ? new EngineDb(join(dir, 'engine.db'), '') : null;
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), new LocalProvider(), undefined, undefined,
      engine ?? undefined, opts.flag,
    );
    return { layer, engine };
  }

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
    vi.clearAllMocks();
  });

  it('flag ON: entities→subjects (concept dropped), relations→edges (concept endpoint skipped), stub+links+cooccurrences', async () => {
    mock.extraction = {
      entities: [
        { name: 'Widget Pro', type: 'product', confidence: 0.8 },
        { name: 'Acme GmbH', type: 'organization', confidence: 0.9 },
        { name: 'Alice', type: 'person', confidence: 0.9 },
        { name: 'Shopify', type: 'concept', confidence: 0.6 },        // not a subject → dropped
      ],
      relations: [
        { from: 'Alice', to: 'Acme GmbH', relationType: 'works_at', description: 'CTO' },
        { from: 'Acme GmbH', to: 'Widget Pro', relationType: 'sells', description: '' },
        { from: 'Acme GmbH', to: 'Shopify', relationType: 'uses', description: '' },  // concept endpoint → skipped
      ],
    };
    const { layer, engine } = makeLayer({ flag: true });
    await layer.init();
    const res = await layer.store('Alice is CTO at Acme GmbH; they sell Widget Pro and use Shopify.', 'knowledge', scope);
    expect(res.stored).toBe(true);

    const subs = new SubjectStore(engine!);
    expect(subs.listSubjects().map(s => s.name).sort()).toEqual(['Acme GmbH', 'Alice', 'Widget Pro']); // Shopify dropped
    const org = subs.findCanonical('Acme GmbH', 'organization')!;
    const person = subs.findCanonical('Alice', 'person')!;
    const product = subs.listSubjects({ kind: 'product' })[0]!;

    // relations: Alice→Acme (works_at, description preserved), Acme→Widget (sells); Acme→Shopify skipped
    const rels = new RelationshipStore(engine!);
    const fromPerson = rels.getRelationshipsFrom(person.id);
    expect(fromPerson).toHaveLength(1);
    expect(fromPerson[0]!.kind).toBe('works_at');
    expect(fromPerson[0]!.to_subject_id).toBe(org.id);
    expect(fromPerson[0]!.description).toBe('CTO');
    const fromOrg = rels.getRelationshipsFrom(org.id);
    expect(fromOrg).toHaveLength(1);                          // sells→Widget only; uses→Shopify skipped
    expect(fromOrg[0]!.to_subject_id).toBe(product.id);

    // stub: primary = the first person/organization (org here, preferred over the earlier product)
    const mg = new MemoryGraphStore(engine!);
    const stub = mg.getStub(res.memoryId)!;
    expect(stub.subject_id).toBe(org.id);
    expect([...mg.getLinkedSubjectIds(res.memoryId)].sort()).toEqual([org.id, person.id, product.id].sort());

    // cooccurrences: 3 distinct subjects → C(3,2) = 3 pairs
    expect(engine!.getDb().prepare('SELECT COUNT(*) c FROM subject_cooccurrences').get()).toMatchObject({ c: 3 });

    engine!.close();
    await layer.close();
  });

  it('flag OFF: engine.db untouched, legacy still written (additive proof)', async () => {
    mock.extraction = { entities: [{ name: 'Acme GmbH', type: 'organization', confidence: 0.9 }], relations: [] };
    const { layer, engine } = makeLayer({ flag: false });
    await layer.init();
    const res = await layer.store('Acme GmbH is a customer.', 'knowledge', scope);
    expect(res.stored).toBe(true);

    expect(new SubjectStore(engine!).listSubjects()).toHaveLength(0);
    expect(engine!.getDb().prepare('SELECT COUNT(*) c FROM memories').get()).toMatchObject({ c: 0 });
    // legacy path ran regardless — the extracted entity is on the legacy graph
    expect((await layer.listEntities()).some(e => e.canonicalName === 'Acme GmbH')).toBe(true);

    engine!.close();
    await layer.close();
  });

  it('no engineDb provided: store works, nothing mirrored, no crash', async () => {
    mock.extraction = { entities: [{ name: 'Acme GmbH', type: 'organization', confidence: 0.9 }], relations: [] };
    const { layer } = makeLayer({ flag: true, withEngine: false });
    await layer.init();
    const res = await layer.store('Acme GmbH appears here.', 'knowledge', scope);
    expect(res.stored).toBe(true);
    await layer.close();
  });

  it('mirror failure is isolated: a broken engine.db never fails the legacy store', async () => {
    mock.extraction = { entities: [{ name: 'Acme GmbH', type: 'organization', confidence: 0.9 }], relations: [] };
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { layer, engine } = makeLayer({ flag: true });
    await layer.init();
    engine!.close();   // subsequent mirror writes throw on the closed connection

    const res = await layer.store('Acme GmbH appears here.', 'knowledge', scope);
    expect(res.stored).toBe(true);  // legacy committed; the mirror error was swallowed + logged
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[lynox:subject-graph] mirror failed'));
    expect((await layer.listEntities()).some(e => e.canonicalName === 'Acme GmbH')).toBe(true);

    errSpy.mockRestore();
    await layer.close();
  });

  it('no subject-bearing entities: no stub written (engine.db memories stays empty)', async () => {
    mock.extraction = {
      entities: [
        { name: 'Shopify', type: 'concept', confidence: 0.6 },
        { name: 'Berlin', type: 'location', confidence: 0.6 },
      ],
      relations: [],
    };
    const { layer, engine } = makeLayer({ flag: true });
    await layer.init();
    const res = await layer.store('Shopify is popular in Berlin.', 'knowledge', scope);
    expect(res.stored).toBe(true);
    expect(new SubjectStore(engine!).listSubjects()).toHaveLength(0);
    expect(engine!.getDb().prepare('SELECT COUNT(*) c FROM memories').get()).toMatchObject({ c: 0 });
    engine!.close();
    await layer.close();
  });
});
