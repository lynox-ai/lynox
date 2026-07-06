import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider, cosineSimilarity } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * S5b'-c consolidation parity. `consolidateMemories` (GC-triggered) superseded the
 * losing duplicates on the LEGACY store only — so under the read cutover a
 * consolidated-away duplicate stayed recallable from engine.db and the two stores
 * diverged on every GC. The fix mirrors each supersede + confirmation transfer onto
 * the engine.db stubs, and adds the M1 subject-agreement veto to the clusterer so
 * two DIFFERENT projects' facts are never merged.
 *
 * Extraction is mocked EMPTY so the memories are subject-less — the mirror + veto
 * work on the text/vector layer alone.
 */
const mock = vi.hoisted(() => ({ extraction: { entities: [], relations: [] } as ExtractionResult }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});

describe('KnowledgeLayer consolidation mirror (S5b\'-c)', () => {
  const provider = new LocalProvider();
  const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  const layers: KnowledgeLayer[] = [];

  afterEach(async () => {
    for (const l of layers) await l.close().catch(() => {});
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    layers.length = 0; engines.length = 0; dirs.length = 0;
  });

  function newLayer(): { layer: KnowledgeLayer; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-consmirror-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-consmirror');
    engines.push(engine);
    const layer = new KnowledgeLayer(join(dir, 'mem.db'), provider, undefined, undefined, engine, true, true);
    layers.push(layer);
    return { layer, engine };
  }

  /** The set of ids whose stub is active in engine.db, among the given ids. */
  function activeEngineIds(engine: EngineDb, ids: string[]): Set<string> {
    const mgs = new MemoryGraphStore(engine);
    return new Set(ids.filter(id => mgs.getStub(id)?.is_active === 1));
  }
  /** The set of ids active in the legacy store, among the given ids. */
  function activeLegacyIds(layer: KnowledgeLayer, ids: string[]): Set<string> {
    const db = layer.getDb();
    return new Set(ids.filter(id => db.getMemory(id)?.is_active === 1));
  }

  it('mirrors consolidation supersedes so legacy and engine.db active sets stay equal', async () => {
    const { layer, engine } = newLayer();
    await layer.init();

    // Three near-identical same-subject memories → one cluster, two superseded.
    const texts = [
      'Meridian AG uses PostgreSQL for the backend database layer in production.',
      'Meridian AG uses PostgreSQL for the backend database layer in prod.',
      'Meridian AG uses PostgreSQL for the backend database layer.',
    ];
    const ids: string[] = [];
    for (const t of texts) ids.push((await layer.store(t, 'knowledge', scope)).memoryId);

    const merged = layer.consolidateMemories('knowledge', 'context', 'proj-1');
    expect(merged).toBe(2);   // two of the three merged into the keeper

    // The core parity guarantee: the active-id sets match across both stores AND
    // equal the CORRECT survivor (the keeper = longest text = ids[0]). Asserting
    // set-equality alone would pass a symmetric bug that killed the keeper in both.
    const expectedActive = new Set([ids[0]!]);
    expect(activeLegacyIds(layer, ids)).toEqual(expectedActive);
    expect(activeEngineIds(engine, ids)).toEqual(expectedActive);
  });

  it('mirrors the confirmation-count transfer so the keeper stub matches legacy', async () => {
    const { layer, engine } = newLayer();
    await layer.init();

    // Two same-subject near-duplicates (cluster, but distinct — below the 0.95 dedup
    // gate). Confirm each once so the victim carries a NON-zero count to transfer.
    const longText = 'Meridian AG uses PostgreSQL for the backend database layer in production.';
    const shortText = 'Meridian AG uses PostgreSQL for the backend database layer.';
    const keeperId = (await layer.store(longText, 'knowledge', scope)).memoryId;
    await layer.store(longText, 'knowledge', scope);   // exact re-store → dedup-confirm (count→1)
    const victimId = (await layer.store(shortText, 'knowledge', scope)).memoryId;
    await layer.store(shortText, 'knowledge', scope);  // dedup-confirm the victim (count→1)
    expect(victimId).not.toBe(keeperId);               // did NOT dedup into the keeper

    const merged = layer.consolidateMemories('knowledge', 'context', 'proj-1');
    expect(merged).toBe(1);

    // Keeper survives with the transferred count (own 1 + victim's 1 = 2) and the
    // engine.db stub matches legacy exactly — the addConfirmations mirror.
    const legacyCount = layer.getDb().getMemory(keeperId)!.confirmation_count;
    const stubCount = (engine.getDb().prepare('SELECT confirmation_count FROM memories WHERE id = ?')
      .get(keeperId) as { confirmation_count: number }).confirmation_count;
    expect(legacyCount).toBe(2);
    expect(stubCount).toBe(legacyCount);
  });

  it('does NOT consolidate two different subjects even when their text is near-identical', async () => {
    const { layer, engine } = newLayer();
    await layer.init();

    // Same template, different project name → high cosine but distinct subjects.
    const textA = 'Kunde Orion hat ein Jahresbudget von genau 30000 Franken bestaetigt.';
    const textB = 'Kunde Vega hat ein Jahresbudget von genau 30000 Franken bestaetigt.';
    // Guard against a vacuous pass: the pair MUST exceed the 0.85 cluster threshold,
    // so it is the subject veto — not low similarity — that prevents the merge.
    const sim = cosineSimilarity(await provider.embed(textA), await provider.embed(textB));
    expect(sim).toBeGreaterThanOrEqual(0.85);

    const a = (await layer.store(textA, 'knowledge', scope)).memoryId;
    const b = (await layer.store(textB, 'knowledge', scope)).memoryId;

    const merged = layer.consolidateMemories('knowledge', 'context', 'proj-1');
    expect(merged).toBe(0);   // the subject-agreement veto blocked the cross-project merge

    // Both survive in BOTH stores.
    expect(activeLegacyIds(layer, [a, b])).toEqual(new Set([a, b]));
    expect(activeEngineIds(engine, [a, b])).toEqual(new Set([a, b]));
  });

  it('isolates an engine.db mirror failure: legacy consolidation stands, no throw', async () => {
    const { layer } = newLayer();
    await layer.init();
    const ids: string[] = [];
    for (const t of [
      'Meridian AG uses PostgreSQL for the backend database layer in production.',
      'Meridian AG uses PostgreSQL for the backend database layer.',
    ]) ids.push((await layer.store(t, 'knowledge', scope)).memoryId);

    // Force the engine.db supersede mirror to throw.
    const spy = vi.spyOn(MemoryGraphStore.prototype, 'markSuperseded').mockImplementationOnce(() => {
      throw new Error('engine.db locked');
    });
    const merged = layer.consolidateMemories('knowledge', 'context', 'proj-1');
    expect(merged).toBe(1);                 // legacy consolidation still reported
    expect(spy).toHaveBeenCalled();
    // Legacy still consolidated despite the mirror failure.
    expect(activeLegacyIds(layer, ids)).toEqual(new Set([ids[0]!]));
    spy.mockRestore();
  });
});
