import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import { embedToBlob } from './embedding.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { ContradictionInfo, MemoryScopeRef } from '../types/index.js';

/**
 * S5b: the flag-gated memory RECALL cutover. When `memory_graph_reads` AND
 * `subject_graph_enabled`, KnowledgeLayer.retrieve / listRecentActive serve memories
 * from engine.db (populated by the S1b/S5a dual-write mirror) instead of legacy
 * agent-memory.db. Extraction is mocked EMPTY so every stored memory is subject-less
 * — which also proves the S5a harden (subject-less memories are recallable from
 * engine.db). Dual-write stays legacy; a failed engine.db read falls back per-read.
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

describe('KnowledgeLayer memory READ cutover (S5b)', () => {
  const provider = new LocalProvider();
  const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  const layers: KnowledgeLayer[] = [];

  const MEMORIES = [
    'The quarterly revenue target for the sales team is CHF 250000.',
    'Server backups run every night at 2am to the offsite bucket.',
    'The onboarding checklist has seven steps including the welcome email.',
    'Coffee machine maintenance is scheduled for the first Monday monthly.',
  ];

  function newLayer(dir: string, opts: { subjectGraph: boolean; memReads: boolean }): KnowledgeLayer {
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-s5b');
    engines.push(engine);
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), provider, undefined, undefined,
      engine, opts.subjectGraph, opts.memReads,
    );
    layers.push(layer);
    return layer;
  }

  /** Write MEMORIES through the dual-write mirror (both stores), then close the writer. */
  async function populate(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bread-'));
    dirs.push(dir);
    const writer = newLayer(dir, { subjectGraph: true, memReads: false });
    await writer.init();
    for (const text of MEMORIES) await writer.store(text, 'knowledge', scope);
    await writer.close();
    // close its engine so the readers open clean handles on the same files
    engines[engines.length - 1]!.close();
    return dir;
  }

  afterEach(async () => {
    for (const l of layers) { try { await l.close(); } catch { /* already closed */ } }
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    layers.length = 0; engines.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    mock.extraction = { entities: [], relations: [] };
    mock.contradictions = [];
    vi.clearAllMocks();
  });

  it('recall equivalence: engine.db vector top-K == legacy top-K (same ids, same order)', async () => {
    const dir = await populate();
    const legacy = newLayer(dir, { subjectGraph: true, memReads: false });
    const engine = newLayer(dir, { subjectGraph: true, memReads: true });
    await legacy.init(); await engine.init();

    const query = 'how much revenue should sales bring in';
    const opts = { topK: 3, threshold: 0.2, useHyDE: false, useGraphExpansion: false };
    const legacyRes = await legacy.retrieve(query, [scope], opts);
    const engineRes = await engine.retrieve(query, [scope], opts);

    expect(engineRes.memories.length).toBeGreaterThan(0);
    expect(engineRes.memories.map(m => m.id)).toEqual(legacyRes.memories.map(m => m.id));
    // and the surfaced text is plaintext, never a ciphertext blob
    for (const m of engineRes.memories) expect(m.text).not.toMatch(/^enc:/);
  });

  it('divergence probe: an engine.db-only memory surfaces ONLY with reads on', async () => {
    const dir = await populate();
    // Insert a memory into engine.db ONLY (bypass the legacy store) carrying the
    // query's own embedding so it scores 1.0.
    const probeText = 'The secret launch codename is Project Nightingale.';
    const vec = await provider.embed(probeText);
    const engineOnly = newLayer(dir, { subjectGraph: true, memReads: true });
    await engineOnly.init();
    const seedEngine = engines[engines.length - 1]!;
    new MemoryGraphStore(seedEngine).upsertStub({
      id: 'engine-only-1', text: probeText, namespace: 'knowledge',
      scopeType: scope.type, scopeId: scope.id, embedding: embedToBlob(vec),
    });

    const legacy = newLayer(dir, { subjectGraph: true, memReads: false });
    await legacy.init();

    const opts = { topK: 5, threshold: 0.2, useHyDE: false, useGraphExpansion: false };
    const onIds = (await engineOnly.retrieve(probeText, [scope], opts)).memories.map(m => m.id);
    const offIds = (await legacy.retrieve(probeText, [scope], opts)).memories.map(m => m.id);

    expect(onIds).toContain('engine-only-1');   // engine.db read sees it
    expect(offIds).not.toContain('engine-only-1'); // legacy store never got it
  });

  it('fallback-on-throw: a broken engine.db read returns the EXACT legacy result and never fails recall', async () => {
    const dir = await populate();
    const legacy = newLayer(dir, { subjectGraph: true, memReads: false });
    const broken = newLayer(dir, { subjectGraph: true, memReads: true });
    const brokenEngine = engines[engines.length - 1]!;
    await legacy.init(); await broken.init();

    const query = 'how much revenue should sales bring in';
    const opts = { topK: 3, threshold: 0.2, useHyDE: false, useGraphExpansion: false };
    const legacyIds = (await legacy.retrieve(query, [scope], opts)).memories.map(m => m.id);
    // Close the engine.db handle out from under `broken` → its engine.db recall read
    // throws → retrieve must fall back to the (still-open) legacy store, byte-for-byte.
    brokenEngine.close();
    const res = await broken.retrieve(query, [scope], opts);
    expect(res.memories.length).toBeGreaterThan(0);
    expect(res.memories.map(m => m.id)).toEqual(legacyIds); // exact legacy result, not just "no crash"
  });

  it('listRecentActive re-points onto engine.db when both flags are on', async () => {
    const dir = await populate();
    const engine = newLayer(dir, { subjectGraph: true, memReads: true });
    await engine.init();
    const rows = engine.listRecentActive('knowledge', [scope], 10);
    // all four dual-written memories are recallable from engine.db (order not asserted
    // — same-second created_at ties make it non-deterministic in this fixture)
    expect(rows.length).toBe(MEMORIES.length);
    for (const r of rows) expect(r.text).not.toMatch(/^enc:/);
  });

  it('CO-GATE: memory_graph_reads WITHOUT subject_graph_enabled stays on legacy', async () => {
    const dir = await populate();
    // Seed a memory into engine.db ONLY, then read with memReads:true but
    // subjectGraph:false → the co-gate resolves enabled=false → recall stays legacy,
    // so the engine-only memory must NOT surface.
    const probeText = 'The vault rotation window is the third Sunday.';
    const vec = await provider.embed(probeText);
    const cogate = newLayer(dir, { subjectGraph: false, memReads: true });
    await cogate.init();
    new MemoryGraphStore(engines[engines.length - 1]!).upsertStub({
      id: 'engine-only-cogate', text: probeText, namespace: 'knowledge',
      scopeType: scope.type, scopeId: scope.id, embedding: embedToBlob(vec),
    });

    const ids = (await cogate.retrieve(probeText, [scope], { topK: 5, threshold: 0.2, useHyDE: false, useGraphExpansion: false })).memories.map(m => m.id);
    expect(ids).not.toContain('engine-only-cogate'); // co-gate OFF → legacy, which never got it
  });

  it('graph-expand equivalence: engine.db subject-expand == legacy entity-expand for a mapped subject', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bexp-'));
    dirs.push(dir);
    // A memory whose extraction links a person subject, so both stores index a
    // memory↔(entity|subject) mention the query can graph-expand through.
    mock.extraction = { entities: [{ name: 'Zara Quinn', type: 'person', confidence: 0.9 }], relations: [] };
    const writer = newLayer(dir, { subjectGraph: true, memReads: false });
    await writer.init();
    await writer.store('Zara Quinn owns the west region account.', 'knowledge', scope);
    await writer.close();
    engines[engines.length - 1]!.close();

    const legacy = newLayer(dir, { subjectGraph: true, memReads: false });
    const engine = newLayer(dir, { subjectGraph: true, memReads: true });
    await legacy.init(); await engine.init();

    // A query naming the subject (+ a concept term that maps to NO subject kind → skipped).
    const query = 'tell me about Zara Quinn and Shopify';
    const opts = { topK: 5, threshold: 0.2, useHyDE: false, useGraphExpansion: true };
    const legacyIds = (await legacy.retrieve(query, [scope], opts)).memories.map(m => m.id).sort();
    const engineIds = (await engine.retrieve(query, [scope], opts)).memories.map(m => m.id).sort();
    expect(engineIds).toEqual(legacyIds); // subject-expand wiring diverges from legacy nowhere
  });

  it('confirm/penalize mirror: engine.db confirmation_count + confidence track legacy under the mirror flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bconf-'));
    dirs.push(dir);
    const layer = newLayer(dir, { subjectGraph: true, memReads: true });
    const engine = engines[engines.length - 1]!;
    await layer.init();
    const { memoryId } = await layer.store('The invoice number prefix is INV-2026.', 'knowledge', scope);

    const readStub = () => engine.getDb().prepare(
      'SELECT confirmation_count, confidence FROM memories WHERE id = ?',
    ).get(memoryId) as { confirmation_count: number; confidence: number };
    const before = readStub();

    // Positive feedback → legacy confirmMemory (+1 count, +0.05 conf) mirrored.
    layer.feedbackOnRetrieval([memoryId], 'useful');
    const afterConfirm = readStub();
    expect(afterConfirm.confirmation_count).toBe(before.confirmation_count + 1);
    expect(afterConfirm.confidence).toBeCloseTo(Math.min(before.confidence + 0.05, 1.0), 5);
    // and it matches what legacy recorded (parity).
    const legacyRow = layer.getDb().getMemory(memoryId)!;
    expect(afterConfirm.confirmation_count).toBe(legacyRow.confirmation_count);
    expect(afterConfirm.confidence).toBeCloseTo(legacyRow.confidence, 5);

    // Negative feedback → legacy penalizeMemory (−0.1) mirrored.
    layer.feedbackOnRetrieval([memoryId], 'wrong');
    expect(readStub().confidence).toBeCloseTo(layer.getDb().getMemory(memoryId)!.confidence, 5);
  });
});
