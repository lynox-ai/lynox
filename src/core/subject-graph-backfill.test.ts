import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { SubjectStore } from './subject-store.js';
import { SubjectGraphBackfill } from './subject-graph-backfill.js';

/**
 * S2 backfill (Template A) — the equivalence proof in unit form: the re-mapped
 * subject-graph must read the SAME mappable entities/relations as the legacy
 * agent-memory.db (the S2 acceptance gate), and a re-run must be convergent.
 */
describe('SubjectGraphBackfill (Foundation Rework v2 — S2 Template A)', () => {
  const tmpDirs: string[] = [];

  function setup(): { engineDb: EngineDb; memoryDb: AgentMemoryDb; subjects: SubjectStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s2-'));
    tmpDirs.push(dir);
    const engineDb = new EngineDb(join(dir, 'engine.db'), '');
    const memoryDb = new AgentMemoryDb(join(dir, 'agent-memory.db'));
    return { engineDb, memoryDb, subjects: new SubjectStore(engineDb), dir };
  }

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function entity(memoryDb: AgentMemoryDb, name: string, type: string, aliases?: string[]): string {
    return memoryDb.createEntity({ canonicalName: name, entityType: type, aliases, scopeType: 'global', scopeId: 'g' });
  }
  function subjectNames(subjects: SubjectStore, kind: string): string[] {
    return subjects.listSubjects({ kind }).map(s => s.name).sort();
  }
  function relCount(engineDb: EngineDb): number {
    return (engineDb.getDb().prepare('SELECT COUNT(*) n FROM relationships').get() as { n: number }).n;
  }

  it('re-maps every mappable entity to a subject and drops concept/location (D10)', () => {
    const { engineDb, memoryDb, subjects } = setup();
    entity(memoryDb, 'Alice', 'person');
    entity(memoryDb, 'Acme', 'organization');
    entity(memoryDb, 'Website Redesign', 'project');   // → engagement
    entity(memoryDb, 'Widget Pro', 'product');
    entity(memoryDb, 'GDPR', 'concept');                // dropped
    entity(memoryDb, 'Zürich', 'location');             // dropped

    const counts = new SubjectGraphBackfill(engineDb, memoryDb).run();

    expect(counts.entitiesMapped).toBe(4);
    expect(counts.entitiesDropped).toBe(2);
    expect(subjectNames(subjects, 'person')).toEqual(['Alice']);
    expect(subjectNames(subjects, 'organization')).toEqual(['Acme']);
    expect(subjectNames(subjects, 'engagement')).toEqual(['Website Redesign']);
    expect(subjectNames(subjects, 'product')).toEqual(['Widget Pro']);
    engineDb.close(); memoryDb.close();
  });

  it('maps an ORPHAN entity (no relations, no mentions) — the case a per-memory replay would drop', () => {
    const { engineDb, memoryDb, subjects } = setup();
    entity(memoryDb, 'Lonely Org', 'organization'); // never mentioned, never in a relation
    new SubjectGraphBackfill(engineDb, memoryDb).run();
    expect(subjectNames(subjects, 'organization')).toEqual(['Lonely Org']);
    engineDb.close(); memoryDb.close();
  });

  it('re-points relations onto subject↔subject edges; drops edges with a non-subject endpoint + self-loops', () => {
    const { engineDb, memoryDb, subjects } = setup();
    const alice = entity(memoryDb, 'Alice', 'person');
    const acme = entity(memoryDb, 'Acme', 'organization');
    const gdpr = entity(memoryDb, 'GDPR', 'concept');
    memoryDb.createRelation(alice, acme, 'works_for', '', '');        // mappable both → kept
    memoryDb.createRelation(alice, gdpr, 'knows_about', '', '');      // endpoint concept → dropped
    memoryDb.createRelation(alice, alice, 'self', '', '');            // self-loop → dropped

    const counts = new SubjectGraphBackfill(engineDb, memoryDb).run();

    expect(counts.relationsMapped).toBe(1);
    expect(counts.relationsDropped).toBe(2);
    const aliceSid = subjects.findCanonical('Alice', 'person')!.id;
    const acmeSid = subjects.findCanonical('Acme', 'organization')!.id;
    const edge = engineDb.getDb()
      .prepare('SELECT from_subject_id f, to_subject_id t, kind FROM relationships')
      .get() as { f: string; t: string; kind: string };
    expect(edge).toMatchObject({ f: aliceSid, t: acmeSid, kind: 'works_for' });
    engineDb.close(); memoryDb.close();
  });

  it('collapses exact-name legacy duplicates into ONE subject and re-points both their relations (D9 deterministic dedup)', () => {
    const { engineDb, memoryDb, subjects } = setup();
    const alice1 = entity(memoryDb, 'Alice', 'person');
    const alice2 = entity(memoryDb, 'Alice', 'person'); // legacy dupe (same name+kind)
    const acme = entity(memoryDb, 'Acme', 'organization');
    memoryDb.createRelation(alice2, acme, 'works_for', '', '');

    new SubjectGraphBackfill(engineDb, memoryDb).run();

    // Both legacy Alices collapse to one subject; the relation off the SECOND
    // dupe still re-points (proves the entity→subject map covers every legacy id).
    expect(subjects.listSubjects({ kind: 'person' })).toHaveLength(1);
    expect(relCount(engineDb)).toBe(1);
    expect(alice1).not.toBe(alice2);
    engineDb.close(); memoryDb.close();
  });

  it('is convergent on a double-apply — no duplicate subjects/edges, no doubled engagement', () => {
    const { engineDb, memoryDb, subjects } = setup();
    const alice = entity(memoryDb, 'Alice', 'person');
    const proj = entity(memoryDb, 'Website Redesign', 'project'); // engagement = always-insert kind
    const acme = entity(memoryDb, 'Acme', 'organization');
    memoryDb.createRelation(alice, acme, 'works_for', '', '');
    memoryDb.createRelation(alice, proj, 'works_on', '', '');

    const backfill = new SubjectGraphBackfill(engineDb, memoryDb);
    const first = backfill.run();
    const subjectsAfter1 = subjects.count();
    const relsAfter1 = relCount(engineDb);
    const second = backfill.run();

    expect(subjects.count()).toBe(subjectsAfter1);   // no new subjects on re-run
    expect(relCount(engineDb)).toBe(relsAfter1);      // no duplicate edges
    expect(subjects.listSubjects({ kind: 'engagement' })).toHaveLength(1); // engagement NOT doubled
    expect(second.entitiesMapped).toBe(first.entitiesMapped);
    engineDb.close(); memoryDb.close();
  });

  it('keeps subject names PLAINTEXT and aliases intact (dedup index correctness)', () => {
    const { engineDb, memoryDb, subjects } = setup();
    entity(memoryDb, 'Beatrice Vogt', 'person', ['B. Vogt', 'Bea']);
    new SubjectGraphBackfill(engineDb, memoryDb).run();
    const row = subjects.findCanonical('Beatrice Vogt', 'person')!;
    expect(row.name).toBe('Beatrice Vogt'); // plaintext (not enc:-prefixed)
    expect(JSON.parse(row.aliases)).toEqual(expect.arrayContaining(['B. Vogt', 'Bea']));
    engineDb.close(); memoryDb.close();
  });

  it('pages correctly across a small page size (no entity/relation dropped at a page boundary)', () => {
    const { engineDb, memoryDb, subjects } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(entity(memoryDb, `Person ${i}`, 'person'));
    for (let i = 0; i < 6; i++) memoryDb.createRelation(ids[i]!, ids[i + 1]!, 'knows', '', '');

    const counts = new SubjectGraphBackfill(engineDb, memoryDb).run({ pageSize: 2 });

    expect(counts.entitiesMapped).toBe(7);
    expect(subjects.listSubjects({ kind: 'person' })).toHaveLength(7);
    expect(counts.relationsMapped).toBe(6);
    expect(relCount(engineDb)).toBe(6);
    engineDb.close(); memoryDb.close();
  });

  it('maps MORE than 200 entities at the default page size (regression: listEntities clamps to 200)', () => {
    const { engineDb, memoryDb, subjects } = setup();
    for (let i = 0; i < 250; i++) entity(memoryDb, `Person ${String(i).padStart(3, '0')}`, 'person');

    // Default pageSize 500 vs the legacy listEntities 200-clamp: a naive scan would
    // stop after one 200-row page and silently drop 50 entities. listAllEntities fixes it.
    const counts = new SubjectGraphBackfill(engineDb, memoryDb).run();

    expect(counts.entitiesMapped).toBe(250);
    expect(subjects.listSubjects({ kind: 'person' })).toHaveLength(250);
    engineDb.close(); memoryDb.close();
  });

  it('re-pointed relationships carry NULL source_memory_id (memory-stub backfill deferred) and no memory stub is created', () => {
    const { engineDb, memoryDb } = setup();
    const a = entity(memoryDb, 'Alice', 'person');
    const o = entity(memoryDb, 'Acme', 'organization');
    memoryDb.createRelation(a, o, 'works_for', '', 'some-legacy-memory-id'); // non-empty source

    new SubjectGraphBackfill(engineDb, memoryDb).run();

    const srcMem = (engineDb.getDb().prepare('SELECT source_memory_id FROM relationships').get() as { source_memory_id: string | null }).source_memory_id;
    expect(srcMem).toBeNull(); // deferred scoping locked — no engine.db memory to FK-reference yet
    expect((engineDb.getDb().prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n).toBe(0);
    engineDb.close(); memoryDb.close();
  });

  it('handles an empty legacy DB without crashing (all-zero counts)', () => {
    const { engineDb, memoryDb } = setup();
    expect(new SubjectGraphBackfill(engineDb, memoryDb).run({ includeMemories: true }))
      .toEqual({
        entitiesMapped: 0, entitiesDropped: 0, relationsMapped: 0, relationsDropped: 0,
        memoriesMapped: 0, memoriesSubjectless: 0, supersedesMapped: 0,
      });
    engineDb.close(); memoryDb.close();
  });

  it('does NOT touch memories unless includeMemories is set (S2 callers unchanged)', () => {
    const { engineDb, memoryDb } = setup();
    const mem = memoryDb.createMemory({
      text: 'Alice leads the Website Redesign engagement.',
      namespace: 'business', scopeType: 'global', scopeId: 'g', embedding: [0.1, 0.2, 0.3],
    });
    memoryDb.createMention(mem, entity(memoryDb, 'Alice', 'person'));

    // Default run (S2 contract) leaves engine.db memories empty …
    const s2 = new SubjectGraphBackfill(engineDb, memoryDb).run();
    expect(s2.memoriesMapped).toBe(0);
    expect((engineDb.getDb().prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n).toBe(0);
    engineDb.close(); memoryDb.close();
  });
});
