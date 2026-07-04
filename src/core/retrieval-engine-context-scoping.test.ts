import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetrievalEngine } from './retrieval-engine.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import { EntityResolver } from './entity-resolver.js';
import { LocalProvider, embedToBlob } from './embedding.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * Context-Hierarchy Scoping — Slice C. The DoD: a thread anchored to Projekt A
 * weights A-memories highest, its customer (Kunde X) mid, a sibling project
 * (Projekt B) low, an unrelated customer's project lower still — but ALL stay
 * visible (a soft re-rank, never a hard filter). Also: no anchor / a stale anchor /
 * a subject-less memory all fall back to the flat scope_type weight (back-compat).
 *
 * All memories share ONE embedding (the query's), so vector similarity, decay and
 * the confidence multiplier are IDENTICAL across candidates — finalScore is then
 * strictly proportional to the walk-up weight, making the ORDERING deterministic
 * and clock-independent (the whole point of the DoD test).
 */
describe('RetrievalEngine — context-hierarchy walk-up weighting (Slice C)', () => {
  const scopes: MemoryScopeRef[] = [{ type: 'context', id: 'ctx1' }];
  let tempDir: string;
  let legacyDb: AgentMemoryDb;
  let engineDb: EngineDb;
  let subjects: SubjectStore;
  let mem: MemoryGraphStore;
  let engine: RetrievalEngine;
  let sharedVec: number[];

  // Subject ids (built in beforeAll).
  let kundeX: string, projektA: string, projektB: string, projektC: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-ctx-scope-'));
    const embedding = new LocalProvider();
    legacyDb = new AgentMemoryDb(join(tempDir, 'legacy.db'));
    legacyDb.setEmbeddingDimensions(embedding.dimensions);
    engineDb = new EngineDb(join(tempDir, 'engine.db'), '');
    subjects = new SubjectStore(engineDb);
    mem = new MemoryGraphStore(engineDb);
    const entityResolver = new EntityResolver(legacyDb, embedding);
    engine = new RetrievalEngine(legacyDb, embedding, entityResolver, undefined, undefined);
    // Turn the engine.db recall path ON (so candidates carry subject_id).
    engine.setMemoryGraphReads(mem, subjects, true);

    // Hierarchy: Kunde X → { Projekt A, Projekt B } ; Kunde Y → Projekt C.
    kundeX = subjects.findOrCreate({ kind: 'organization', name: 'Kunde X' }).id;
    projektA = subjects.createSubject({ kind: 'engagement', name: 'Projekt A', parentId: kundeX });
    projektB = subjects.createSubject({ kind: 'engagement', name: 'Projekt B', parentId: kundeX });
    const kundeY = subjects.findOrCreate({ kind: 'organization', name: 'Kunde Y' }).id;
    projektC = subjects.createSubject({ kind: 'engagement', name: 'Projekt C', parentId: kundeY });

    // One shared embedding for every memory (→ equal vector similarity to the query).
    sharedVec = await embedding.embed('a shared fact about the engagement');
    const seed = (id: string, subjectId: string | null): void => {
      mem.upsertStub({
        id, text: `memory ${id}`, namespace: 'knowledge',
        scopeType: 'context', scopeId: 'ctx1',
        subjectId, embedding: embedToBlob(sharedVec),
        createdAt: '2026-07-04T12:00:00Z', confidence: 0.9, confirmationCount: 1, isActive: 1,
      });
    };
    seed('m-A', projektA);   // in-context (the anchor)
    seed('m-KX', kundeX);    // up-hierarchy (parent)
    seed('m-B', projektB);   // sibling (shares Kunde X)
    seed('m-C', projektC);   // unrelated (different customer)
    seed('m-null', null);    // subject-less (legacy/back-compat → scope_type weight)
  });

  afterAll(async () => {
    legacyDb.close();
    engineDb.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  /** finalScore keyed by memory id from a retrieve() result. */
  async function scoresFor(anchor: string | null): Promise<Map<string, number>> {
    const res = await engine.retrieve('a shared fact about the engagement', scopes, {
      topK: 10, threshold: 0.1, useHyDE: false, useGraphExpansion: false,
      threadAnchorSubjectId: anchor,
    });
    return new Map(res.memories.map(m => [m.id, m.finalScore]));
  }

  it('anchored to Projekt A: A > Kunde X > (subject-less) > sibling B > unrelated C — all visible', async () => {
    const s = await scoresFor(projektA);
    // Every memory survived — soft weight, not a hard filter (NONE invisible).
    for (const id of ['m-A', 'm-KX', 'm-B', 'm-C', 'm-null']) {
      expect(s.get(id), `${id} present`).toBeGreaterThan(0);
    }
    // The hierarchy ordering: in-context > up-hierarchy > sibling > unrelated.
    expect(s.get('m-A')!).toBeGreaterThan(s.get('m-KX')!);   // anchor beats its customer
    expect(s.get('m-KX')!).toBeGreaterThan(s.get('m-B')!);   // customer beats a sibling project
    expect(s.get('m-B')!).toBeGreaterThan(s.get('m-C')!);    // sibling beats an unrelated customer
    // A subject-less memory keeps its scope_type weight (0.8 context) → it sits
    // between the anchor (1.0) and the parent (0.7), NOT suppressed to unrelated.
    expect(s.get('m-null')!).toBeGreaterThan(s.get('m-KX')!);
    expect(s.get('m-A')!).toBeGreaterThan(s.get('m-null')!);
  });

  it('no anchor: flat scope_type weighting — every candidate scores equally (back-compat)', async () => {
    const s = await scoresFor(null);
    const vals = [...s.values()];
    expect(vals).toHaveLength(5);
    // Same scope (context) + same vector/decay/confidence → identical finalScore.
    for (const v of vals) expect(v).toBeCloseTo(vals[0]!, 6);
  });

  it('a stale anchor (subject no longer exists) degrades to flat scoping — no throw', async () => {
    const s = await scoresFor('ghost-subject-that-was-purged');
    const vals = [...s.values()];
    expect(vals).toHaveLength(5);
    for (const v of vals) expect(v).toBeCloseTo(vals[0]!, 6); // identical → walk-up did not bite
  });
});
