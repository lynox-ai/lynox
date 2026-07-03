import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import type { MemoryScopeRef } from '../types/index.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { ExtractionResultV2 } from './entity-extractor-v2.js';

/**
 * S5b'-b: the flag-gated ENTITY write-cutover. Under the read cutover
 * (memoryReadsActive), store()'s extraction persists straight onto engine.db subjects
 * as the AUTHORITATIVE entity store — the legacy entities/mentions/relations writes are
 * dropped; the legacy MEMORY row stays dual-written (the rollback anchor). Pre-cutover
 * the legacy persist + additive mirror are UNCHANGED.
 *
 * The core equivalence claim: the subject graph the authoritative path writes is
 * byte-equivalent (by name/kind/edge/link) to what the mirror produced from the legacy
 * leg on the SAME extraction — because the mirror never resolved subjects by legacy
 * IDENTITY, only by name → findOrCreate. Extraction is mocked to a fixed non-empty set
 * (no LLM); with no anthropicClient both paths take the V1 `extractEntities`.
 */
const mock = vi.hoisted(() => ({
  extraction: { entities: [], relations: [] } as ExtractionResult,
  extractionV2: { entities: [], relations: [] } as ExtractionResultV2,
}));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});
// V2 mock: shouldExtractV2 forced true so a store() WITH a client takes the V2 path
// (the no-client tests still take V1 — the V2 branch also requires an anthropicClient).
vi.mock('./entity-extractor-v2.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor-v2.js')>();
  return { ...actual, shouldExtractV2: () => true, extractEntitiesV2: vi.fn(async () => mock.extractionV2) };
});

import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';

/** Peter(person) works_for Acme Studio(org); Design(concept) is dropped (non-subject kind). */
const FIXTURE: ExtractionResult = {
  entities: [
    { name: 'Acme Studio', type: 'organization', confidence: 0.9 },
    { name: 'Peter', type: 'person', confidence: 0.9 },
    { name: 'Design', type: 'concept', confidence: 0.8 },
  ],
  relations: [
    { from: 'Peter', to: 'Acme Studio', relationType: 'works_for', description: 'employed at' },
  ],
};

interface GraphSnapshot {
  subjects: Array<{ kind: string; name: string }>;
  primaryName: string | null;
  linkedNames: string[];
  edges: Array<{ from: string; to: string; kind: string }>;
  cooccurrences: Array<{ pair: [string, string]; count: number }>;
}

describe("KnowledgeLayer ENTITY write cutover (S5b'-b)", () => {
  const provider = new LocalProvider();
  const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  const layers: KnowledgeLayer[] = [];

  function newLayer(
    dir: string,
    opts: { subjectGraph: boolean; memReads: boolean; client?: Anthropic | undefined },
  ): { layer: KnowledgeLayer; engine: EngineDb } {
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-s5bpb');
    engines.push(engine);
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), provider, opts.client, undefined,
      engine, opts.subjectGraph, opts.memReads,
    );
    layers.push(layer);
    return { layer, engine };
  }

  /** A metered host whose onBeforeRun throws → the extraction credit gate BLOCKS. */
  type MeteredHost = NonNullable<Parameters<KnowledgeLayer['setMeteredHost']>[0]>;
  function blockingHost(): MeteredHost {
    return {
      getHooks: () => [{ onBeforeRun: () => Promise.reject(new Error('AI budget for this period reached.')) }],
      getContext: () => undefined,
    };
  }

  /** Normalize the engine.db subject graph for a stored memory to a by-NAME structure. */
  function snapshot(engine: EngineDb, memoryId: string): GraphSnapshot {
    const store = new SubjectStore(engine);
    const graph = new MemoryGraphStore(engine);
    const db = engine.getDb();
    const nameOf = (id: string): string => store.getSubject(id)?.name ?? `?${id}`;

    const subjects = store.listSubjects()
      .map(s => ({ kind: s.kind, name: s.name }))
      .sort((a, b) => (a.name + a.kind).localeCompare(b.name + b.kind));

    const stub = graph.getStub(memoryId);
    const primaryName = stub?.subject_id ? nameOf(stub.subject_id) : null;

    const linkedNames = graph.getLinkedSubjectIds(memoryId).map(nameOf).sort();

    const edges = (db.prepare('SELECT from_subject_id, to_subject_id, kind FROM relationships')
      .all() as Array<{ from_subject_id: string; to_subject_id: string; kind: string }>)
      .map(r => ({ from: nameOf(r.from_subject_id), to: nameOf(r.to_subject_id), kind: r.kind }))
      .sort((a, b) => (a.from + a.to + a.kind).localeCompare(b.from + b.to + b.kind));

    const cooccurrences = (db.prepare('SELECT subject_a_id, subject_b_id, count FROM subject_cooccurrences')
      .all() as Array<{ subject_a_id: string; subject_b_id: string; count: number }>)
      .map(r => ({ pair: [nameOf(r.subject_a_id), nameOf(r.subject_b_id)].sort() as [string, string], count: r.count }))
      .sort((a, b) => a.pair.join().localeCompare(b.pair.join()));

    return { subjects, primaryName, linkedNames, edges, cooccurrences };
  }

  afterEach(async () => {
    for (const l of layers) { try { await l.close(); } catch { /* already closed */ } }
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    layers.length = 0; engines.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    mock.extraction = { entities: [], relations: [] };
    mock.extractionV2 = { entities: [], relations: [] };
    vi.clearAllMocks();
  });

  it('authoritative subject graph == the mirror output on the same extraction (byte-equivalent by name)', async () => {
    mock.extraction = FIXTURE;
    const text = 'Peter joined Acme Studio last spring to lead design.';

    // A: read cutover ON → authoritative subjects-only write.
    const dirA = mkdtempSync(join(tmpdir(), 'lynox-s5bpb-a-')); dirs.push(dirA);
    const { layer: layerA, engine: engineA } = newLayer(dirA, { subjectGraph: true, memReads: true });
    await layerA.init();
    const resA = await layerA.store(text, 'knowledge', scope);
    const snapA = snapshot(engineA, resA.memoryId);

    // B: cutover OFF → legacy persist + the additive mirror produces the subject graph.
    const dirB = mkdtempSync(join(tmpdir(), 'lynox-s5bpb-b-')); dirs.push(dirB);
    const { layer: layerB, engine: engineB } = newLayer(dirB, { subjectGraph: true, memReads: false });
    await layerB.init();
    const resB = await layerB.store(text, 'knowledge', scope);
    const snapB = snapshot(engineB, resB.memoryId);

    // The subject graphs are structurally identical (ids differ per-db; names don't).
    expect(snapA.subjects).toEqual([
      { kind: 'organization', name: 'Acme Studio' },
      { kind: 'person', name: 'Peter' },
    ]);
    expect(snapA.subjects).toEqual(snapB.subjects);
    expect(snapA.primaryName).toBe('Acme Studio'); // first person/org in extraction order
    expect(snapA.primaryName).toBe(snapB.primaryName);
    expect(snapA.linkedNames).toEqual(['Acme Studio', 'Peter']);
    expect(snapA.linkedNames).toEqual(snapB.linkedNames);
    expect(snapA.edges).toEqual([{ from: 'Peter', to: 'Acme Studio', kind: 'works_for' }]);
    expect(snapA.edges).toEqual(snapB.edges);
    expect(snapA.cooccurrences).toEqual([{ pair: ['Acme Studio', 'Peter'], count: 1 }]);
    expect(snapA.cooccurrences).toEqual(snapB.cooccurrences);
  });

  it('cutover ON writes NO legacy entities/mentions/relations, but KEEPS the legacy memory row', async () => {
    mock.extraction = FIXTURE;
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpb-')); dirs.push(dir);
    const { layer } = newLayer(dir, { subjectGraph: true, memReads: true });
    await layer.init();

    const res = await layer.store('Peter joined Acme Studio to lead design.', 'knowledge', scope);
    expect(res.stored).toBe(true);

    const legacy = layer.getDb();
    // The entity graph is frozen on the legacy store (subjects are authoritative)...
    expect(legacy.getEntityCount()).toBe(0);
    expect(legacy.getRelationCount()).toBe(0);
    // ...but the memory row stays dual-written (the rollback anchor for vector recall).
    expect(legacy.getActiveMemoryCount()).toBe(1);
    expect(legacy.getMemory(res.memoryId)?.text).toBe('Peter joined Acme Studio to lead design.');
  });

  it('cutover OFF still dual-writes the legacy entity graph (default path unchanged)', async () => {
    mock.extraction = FIXTURE;
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpb-')); dirs.push(dir);
    const { layer } = newLayer(dir, { subjectGraph: true, memReads: false });
    await layer.init();

    await layer.store('Peter joined Acme Studio to lead design.', 'knowledge', scope);

    const legacy = layer.getDb();
    // Acme + Peter + Design(concept) all become legacy entities → exactly 3.
    expect(legacy.getEntityCount()).toBe(3);
    expect(legacy.getActiveMemoryCount()).toBe(1);
  });

  it("store() result under the cutover is subject-sourced (ids resolve on the subject store)", async () => {
    mock.extraction = FIXTURE;
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpb-')); dirs.push(dir);
    const { layer, engine } = newLayer(dir, { subjectGraph: true, memReads: true });
    await layer.init();

    const res = await layer.store('Peter joined Acme Studio to lead design.', 'knowledge', scope);
    const store = new SubjectStore(engine);

    expect(res.entities.map(e => e.canonicalName).sort()).toEqual(['Acme Studio', 'Peter']);
    for (const e of res.entities) {
      expect(store.getSubject(e.id)?.name).toBe(e.canonicalName); // id is a real subject id
    }
    expect(res.relations).toHaveLength(1);
    expect(store.getSubject(res.relations[0]!.fromEntityId)?.name).toBe('Peter');
    expect(store.getSubject(res.relations[0]!.toEntityId)?.name).toBe('Acme Studio');
  });

  it('updateMemoryText under the cutover re-extracts onto subjects + refreshes the stub, no legacy mention', async () => {
    mock.extraction = FIXTURE;
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpb-')); dirs.push(dir);
    const { layer, engine } = newLayer(dir, { subjectGraph: true, memReads: true });
    await layer.init();

    const orig = 'Peter joined Acme Studio to lead design.';
    const res = await layer.store(orig, 'knowledge', scope);

    const updated = 'Peter joined Acme Studio to lead design and marketing.';
    const ok = await layer.updateMemoryText(orig, updated, 'knowledge', scope);
    expect(ok).toBe(true);

    // Stub text refreshed to the corrected version (recall reads engine.db under the flag).
    expect(new MemoryGraphStore(engine).getStub(res.memoryId)?.id).toBe(res.memoryId);
    const stubText = engine.getDb().prepare('SELECT text FROM memories WHERE id = ?').get(res.memoryId) as { text: string };
    expect(engine.dec(stubText.text)).toBe(updated);

    // No legacy mention/entity writes leaked through the update.
    expect(layer.getDb().getEntityCount()).toBe(0);
  });

  it('a blocked extraction gate STILL lands the engine.db stub (cutover path — recall never loses the memory)', async () => {
    mock.extraction = FIXTURE; // never reached — the gate blocks before the extractor
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpb-')); dirs.push(dir);
    // A client makes the gate active; the blocking host rejects onBeforeRun.
    const { layer, engine } = newLayer(dir, { subjectGraph: true, memReads: true, client: {} as Anthropic });
    await layer.init();
    layer.setMeteredHost(blockingHost());

    const res = await layer.store('Peter joined Acme Studio to lead design.', 'knowledge', scope);
    expect(res.stored).toBe(true);
    expect(res.entities).toHaveLength(0); // extractor was gated → no subjects resolved

    // The stub MUST still exist (subject-less) so recall — which reads engine.db under the
    // flag — never loses the memory. This is the regression the gate-coupling would cause.
    const stub = new MemoryGraphStore(engine).getStub(res.memoryId);
    expect(stub).not.toBeNull();
    expect(stub!.is_active).toBe(1);
    expect(stub!.subject_id).toBeNull();
    expect(new SubjectStore(engine).listSubjects()).toHaveLength(0);
  });

  it('a blocked extraction gate STILL lands the mirror stub (pre-cutover default path)', async () => {
    mock.extraction = FIXTURE;
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpb-')); dirs.push(dir);
    const { layer, engine } = newLayer(dir, { subjectGraph: true, memReads: false, client: {} as Anthropic });
    await layer.init();
    layer.setMeteredHost(blockingHost());

    const res = await layer.store('Peter joined Acme Studio to lead design.', 'knowledge', scope);
    expect(res.stored).toBe(true);

    // The additive mirror runs regardless of the gate → subject-less stub lands, and the
    // legacy memory row is present. No legacy entities (extractor never ran).
    const stub = new MemoryGraphStore(engine).getStub(res.memoryId);
    expect(stub).not.toBeNull();
    expect(stub!.subject_id).toBeNull();
    expect(layer.getDb().getActiveMemoryCount()).toBe(1);
    expect(layer.getDb().getEntityCount()).toBe(0);
  });

  it('a subject-less extraction (only non-subject kinds) still lands a stub, no edges/links', async () => {
    // Only a concept + a location → both map to no subject kind → dropped.
    mock.extraction = {
      entities: [
        { name: 'Design', type: 'concept', confidence: 0.8 },
        { name: 'Zurich', type: 'location', confidence: 0.9 },
      ],
      relations: [{ from: 'Design', to: 'Zurich', relationType: 'located_in', description: '' }],
    };
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpb-')); dirs.push(dir);
    const { layer, engine } = newLayer(dir, { subjectGraph: true, memReads: true });
    await layer.init();

    const res = await layer.store('Design work happens in Zurich mostly.', 'knowledge', scope);
    const snap = snapshot(engine, res.memoryId);

    expect(snap.subjects).toHaveLength(0);      // no subject-kind entity
    expect(snap.primaryName).toBeNull();        // stub written with subject_id NULL
    expect(snap.linkedNames).toHaveLength(0);
    expect(snap.edges).toHaveLength(0);
    expect(snap.cooccurrences).toHaveLength(0);
    // The stub still exists (vector recall must see it).
    expect(new MemoryGraphStore(engine).getStub(res.memoryId)).not.toBeNull();
  });

  it('a supersession under the cutover flips the prior stub AND writes the new subjects', async () => {
    mock.extraction = FIXTURE;
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpb-')); dirs.push(dir);
    const { layer, engine } = newLayer(dir, { subjectGraph: true, memReads: true });
    await layer.init();

    // First store establishes the prior (Peter + Acme + a stub).
    const first = await layer.store('The team budget is 5000 for Acme Studio under Peter.', 'knowledge', scope);
    // A contradicting fact (different number) → detectContradictions supersedes the prior,
    // and _writeSubjectsFromExtraction's markSuperseded flips the prior stub on engine.db.
    const second = await layer.store('The team budget is 9000 for Acme Studio under Peter.', 'knowledge', scope);

    expect(second.contradictions.map(c => c.existingMemoryId)).toContain(first.memoryId);
    const graph = new MemoryGraphStore(engine);
    expect(graph.getStub(first.memoryId)?.is_active).toBe(0);       // prior flipped inactive
    expect(graph.getStub(first.memoryId)?.superseded_by).toBe(second.memoryId);
    expect(graph.getStub(second.memoryId)?.is_active).toBe(1);      // the new memory is active
    // The subjects were still written on the superseding store.
    expect(new SubjectStore(engine).listSubjects().map(s => s.name).sort()).toEqual(['Acme Studio', 'Peter']);
  });

  it('the V2 extractor path resolves canonical + aliases onto subjects (subject/object edge mapping)', async () => {
    mock.extractionV2 = {
      entities: [
        { canonicalName: 'Acme Studio', type: 'organization', confidence: 0.9, aliases: ['Acme'], evidenceSpan: 'Acme' },
        { canonicalName: 'Peter', type: 'person', confidence: 0.9, aliases: [], evidenceSpan: 'Peter' },
      ],
      relations: [{ subject: 'Peter', predicate: 'works_for', object: 'Acme Studio', confidence: 0.9 }],
    };
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpb-')); dirs.push(dir);
    // A client → the V2 branch (shouldExtractV2 mocked true) fires.
    const { layer, engine } = newLayer(dir, { subjectGraph: true, memReads: true, client: {} as Anthropic });
    await layer.init();

    const res = await layer.store('Peter works for Acme.', 'knowledge', scope);
    const store = new SubjectStore(engine);

    // canonical 'Acme Studio' with alias 'Acme' folded into the subject.
    const acme = store.findCanonical('Acme Studio', 'organization');
    expect(acme).not.toBeNull();
    expect(JSON.parse(acme!.aliases) as string[]).toContain('Acme');
    // subject/object mapped to from/to correctly.
    expect(res.relations).toHaveLength(1);
    expect(store.getSubject(res.relations[0]!.fromEntityId)?.name).toBe('Peter');
    expect(store.getSubject(res.relations[0]!.toEntityId)?.name).toBe('Acme Studio');
  });
});
