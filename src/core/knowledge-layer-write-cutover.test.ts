import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider, embedToBlob } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * S5b'-a: the flag-gated memory WRITE-path cutover. After S5b re-pointed RECALL onto
 * engine.db, the store()-time dedup + contradiction candidate scan must consult the
 * SAME store, else a confirm-vs-create / supersede decision diverges from what recall
 * surfaces. These tests prove the routing (`_dedupRecall`) flips to engine.db under the
 * co-gate — DETERMINISTICALLY, via engine-only seeds carrying the query's own embedding
 * (cosine 1.0), so the routing is proven without depending on ONNX cosine of two real
 * sentences crossing a threshold. Extraction is mocked EMPTY (no LLM, no entity writes);
 * detectContradictions is NOT mocked (the real routing is under test). The memory ROW
 * stays dual-written through S5b'-a — only the read SOURCE of dedup/contradiction moves.
 */
const mock = vi.hoisted(() => ({
  extraction: { entities: [], relations: [] } as ExtractionResult,
}));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});

describe("KnowledgeLayer memory WRITE cutover (S5b'-a)", () => {
  const provider = new LocalProvider();
  const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  const layers: KnowledgeLayer[] = [];

  function newLayer(dir: string, opts: { subjectGraph: boolean; memReads: boolean }): KnowledgeLayer {
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-s5bp');
    engines.push(engine);
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), provider, undefined, undefined,
      engine, opts.subjectGraph, opts.memReads,
    );
    layers.push(layer);
    return layer;
  }

  /** Seed a memory into engine.db ONLY (never the legacy store) via the last-created engine handle. */
  function seedEngineOnly(id: string, text: string, embVec: number[], createdAt?: string): void {
    new MemoryGraphStore(engines[engines.length - 1]!).upsertStub({
      id, text, namespace: 'knowledge', scopeType: scope.type, scopeId: scope.id,
      embedding: embedToBlob(embVec), ...(createdAt ? { createdAt } : {}),
    });
  }

  afterEach(async () => {
    for (const l of layers) { try { await l.close(); } catch { /* already closed */ } }
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    layers.length = 0; engines.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    mock.extraction = { entities: [], relations: [] };
    vi.clearAllMocks();
  });

  it('dedup consults engine.db when the co-gate is on (finds an engine-only duplicate)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpw-'));
    dirs.push(dir);
    const dupText = 'The archive bucket rotates its keys every ninety days.';
    const dupVec = await provider.embed(dupText);

    const writer = newLayer(dir, { subjectGraph: true, memReads: true });
    await writer.init();
    seedEngineOnly('engine-dup-1', dupText, dupVec); // engine.db only; legacy never got it

    const res = await writer.store(dupText, 'knowledge', scope);
    // routed to engine.db → the engine-only memory is a dedup hit → confirm, not create.
    expect(res.deduplicated).toBe(true);
    expect(res.stored).toBe(false);
    expect(res.memoryId).toBe('engine-dup-1');
  });

  it('dedup stays on legacy when the co-gate is off (the engine-only duplicate is invisible)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpw-'));
    dirs.push(dir);
    const dupText = 'The archive bucket rotates its keys every ninety days.';
    const dupVec = await provider.embed(dupText);

    // memReads:false → _dedupRecall routes to legacy, which never received the seed.
    const writer = newLayer(dir, { subjectGraph: true, memReads: false });
    await writer.init();
    seedEngineOnly('engine-dup-2', dupText, dupVec);

    const res = await writer.store(dupText, 'knowledge', scope);
    expect(res.deduplicated).toBe(false);
    expect(res.stored).toBe(true);
    expect(res.memoryId).not.toBe('engine-dup-2'); // a fresh row, not the engine-only seed
  });

  it("co-gate: memory_graph_reads WITHOUT subject_graph_enabled keeps the write path on legacy", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpw-'));
    dirs.push(dir);
    const dupText = 'The vault rotation window is the third Sunday of the month.';
    const dupVec = await provider.embed(dupText);

    // memReads:true but subjectGraph:false → memoryReadsActive=false → legacy dedup.
    const writer = newLayer(dir, { subjectGraph: false, memReads: true });
    await writer.init();
    seedEngineOnly('engine-dup-cogate', dupText, dupVec);

    const res = await writer.store(dupText, 'knowledge', scope);
    expect(res.deduplicated).toBe(false); // co-gate off → legacy, which never got the seed
  });

  it('dedup EXHAUSTIVE window threads through to engine.db (finds a duplicate past the retrieval window)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpw-'));
    dirs.push(dir);
    const dupText = 'The quarterly compliance audit covers all seven regional offices.';
    const dupVec = await provider.embed(dupText);
    const fillerVec = await provider.embed('Zebras graze on the open savanna at dawn.');

    const writer = newLayer(dir, { subjectGraph: true, memReads: true });
    await writer.init();
    // Target is the OLDEST; then 110 newer NON-matching noise rows push it past the
    // 100-row retrieval window. Only the exhaustive scan (LIMIT 5000) still reaches it.
    seedEngineOnly('engine-dup-old', dupText, dupVec, '2000-01-01T00:00:00.000Z');
    for (let i = 0; i < 110; i++) {
      seedEngineOnly(`noise-${i}`, `filler row ${i}`, fillerVec, `2026-01-01T00:00:00.${String(i).padStart(6, '0')}Z`);
    }

    const res = await writer.store(dupText, 'knowledge', scope);
    // store() passes exhaustive:true → _dedupRecall → findSimilarRecall raises the cap,
    // so the oldest duplicate is still caught (a windowed scan of the 100 newest misses it).
    expect(res.deduplicated).toBe(true);
    expect(res.memoryId).toBe('engine-dup-old');
  });

  it('contradiction consults engine.db when the co-gate is on (supersedes an engine-only prior)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpw-'));
    dirs.push(dir);
    const newText = 'The monthly budget is 9000 for the marketing team.';
    const newVec = await provider.embed(newText);

    const writer = newLayer(dir, { subjectGraph: true, memReads: true });
    await writer.init();
    // Prior memory contradicts on the NUMBER (5000 vs 9000). Its embedding is the NEW
    // text's vector (cosine 1.0 ≥ the 0.80 contradiction threshold), so recall on
    // engine.db surfaces it deterministically; the heuristic then flags the change.
    seedEngineOnly('engine-prior', 'The monthly budget is 5000 for the marketing team.', newVec);

    const res = await writer.store(newText, 'knowledge', scope);
    expect(res.contradictions.map(c => c.existingMemoryId)).toContain('engine-prior');
    // the supersession mirror flipped the engine-only prior inactive.
    expect(engines[engines.length - 1]!.getDb()
      .prepare('SELECT is_active FROM memories WHERE id = ?').get('engine-prior'))
      .toEqual({ is_active: 0 });
  });

  it('contradiction stays on legacy when the co-gate is off (the engine-only prior is invisible)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5bpw-'));
    dirs.push(dir);
    const newText = 'The monthly budget is 9000 for the marketing team.';
    const newVec = await provider.embed(newText);

    const writer = newLayer(dir, { subjectGraph: true, memReads: false });
    await writer.init();
    seedEngineOnly('engine-prior-off', 'The monthly budget is 5000 for the marketing team.', newVec);

    const res = await writer.store(newText, 'knowledge', scope);
    // legacy recall never saw the engine-only prior → no contradiction detected.
    expect(res.contradictions).toHaveLength(0);
  });
});
