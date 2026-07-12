import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * Erasure PR — `KnowledgeLayer.eraseByPattern` PHYSICALLY deletes matching memories
 * from BOTH stores (GDPR Art. 17), the terminal state of the Validity axis. This is
 * distinct from the SOFT `deactivateByPattern` (is_active = 0, row + text + embedding
 * persist and ride backups/exports) covered by knowledge-layer-delete-mirror.test.ts.
 *
 * Extraction is mocked EMPTY so stored memories are subject-less — the store-level
 * hard-delete is proven on the vector-recall path alone; the orphan-entity cascade is
 * unit-tested directly at the AgentMemoryDb layer (agent-memory-db.test.ts).
 */
const mock = vi.hoisted(() => ({ extraction: { entities: [], relations: [] } as ExtractionResult }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});

describe('KnowledgeLayer.eraseByPattern (Erasure — hard delete)', () => {
  const provider = new LocalProvider();
  const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
  const opts = { topK: 10, threshold: 0.2, useHyDE: false, useGraphExpansion: false };
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  const layers: KnowledgeLayer[] = [];

  afterEach(async () => {
    for (const l of layers) await l.close().catch(() => {});
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    layers.length = 0; engines.length = 0; dirs.length = 0;
  });

  function newLayer(o: { subjectGraph: boolean; memReads: boolean }): { layer: KnowledgeLayer; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-erasure');
    engines.push(engine);
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), provider, undefined, undefined,
      engine, o.subjectGraph, o.memReads,
    );
    layers.push(layer);
    return { layer, engine };
  }

  it('physically removes the row from BOTH stores (not a soft is_active = 0)', async () => {
    const { layer, engine } = newLayer({ subjectGraph: true, memReads: true });
    await layer.init();

    const secret = 'The launch code for Projekt Titan is seven seven three.';
    const stored = await layer.store(secret, 'knowledge', scope);
    expect(stored.stored).toBe(true);
    // Present in both stores before the erase.
    expect(layer.getDb().getMemory(stored.memoryId)).not.toBeNull();
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).not.toBeNull();

    const erased = await layer.eraseByPattern('launch code for Projekt Titan');
    expect(erased).toBe(1);

    // Hard delete: the legacy row is GONE (not is_active = 0) — its text + embedding no
    // longer ride any backup/export — and the engine.db recall stub is GONE too.
    expect(layer.getDb().getMemory(stored.memoryId)).toBeNull();
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).toBeNull();
    // And it no longer surfaces in recall.
    const after = await layer.retrieve(secret, [scope], opts);
    expect(after.memories.map(m => m.id)).not.toContain(stored.memoryId);
  });

  it('erases a row a PRIOR soft-delete left as is_active = 0 (reaps the residue)', async () => {
    const { layer, engine } = newLayer({ subjectGraph: true, memReads: true });
    await layer.init();

    const stored = await layer.store('Superseded secret about Projekt Nimbus', 'knowledge', scope);
    // Soft-delete first (the old "delete" — text/embedding persist at is_active = 0).
    await layer.deactivateByPattern('Superseded secret about Projekt Nimbus');
    expect(layer.getDb().getMemory(stored.memoryId)!.is_active).toBe(0);

    // A later erasure must physically remove that residue.
    const erased = await layer.eraseByPattern('Superseded secret about Projekt Nimbus');
    expect(erased).toBe(1);
    expect(layer.getDb().getMemory(stored.memoryId)).toBeNull();
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).toBeNull();
  });

  it('a failed engine.db reap RE-THROWS + surfaces a parity-loss, leaves legacy INTACT, and a retry self-heals', async () => {
    const { layer, engine } = newLayer({ subjectGraph: true, memReads: true });
    await layer.init();
    const secret = 'A fact whose engine.db reap will fail once';
    const stored = await layer.store(secret, 'knowledge', scope);

    const lines: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    const purgeSpy = vi.spyOn(MemoryGraphStore.prototype, 'purgeMemories').mockImplementationOnce(() => {
      throw new Error('engine.db locked');
    });
    try {
      // Erasure must be LOUD: the reap failure re-throws so an awaiting caller
      // (MemoryFacade.delete) fails the delete instead of reporting a false success.
      await expect(layer.eraseByPattern(secret)).rejects.toThrow('engine.db locked');
      expect(purgeSpy).toHaveBeenCalledOnce();
      expect(lines.some(l => l.includes('[lynox:mirror-parity] CRITICAL erase'))).toBe(true);
      // The marker carries the ids (not just a count) so a reconcile has a handle.
      expect(lines.some(l => l.includes(stored.memoryId))).toBe(true);
    } finally {
      errSpy.mockRestore();
      purgeSpy.mockRestore(); // restore so the retry below hits the REAL purge
    }
    // engine.db is reaped FIRST, so on its failure legacy is UNTOUCHED — no permanent
    // silent loss: the row still lives in BOTH stores and its ids stay re-derivable.
    expect(layer.getDb().getMemory(stored.memoryId)).not.toBeNull();
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).not.toBeNull();

    // Retry (real purge): re-derives the SAME ids from the intact legacy plaintext and
    // completes — self-healing, no manual reconciliation needed.
    const erased = await layer.eraseByPattern(secret);
    expect(erased).toBe(1);
    expect(layer.getDb().getMemory(stored.memoryId)).toBeNull();
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).toBeNull();
  });

  it('flag-off (subjectGraph off): erases legacy + runs a (no-op) engine.db reap since the store exists', async () => {
    const { layer, engine } = newLayer({ subjectGraph: false, memReads: false });
    await layer.init();
    const stored = await layer.store('Ephemeral note to erase later', 'knowledge', scope);

    const purgeSpy = vi.spyOn(MemoryGraphStore.prototype, 'purgeMemories');
    try {
      const erased = await layer.eraseByPattern('Ephemeral note');
      expect(erased).toBe(1);
      // Durable-reap: the reap is gated on the store existing, NOT the reversible
      // flag — so it fires with the matched ids (a no-op here, no stub was mirrored),
      // ensuring a stub from a prior flag-ON window can never survive a flag-OFF erase.
      expect(purgeSpy).toHaveBeenCalledWith([stored.memoryId]);
    } finally {
      purgeSpy.mockRestore();
    }
    expect(layer.getDb().getMemory(stored.memoryId)).toBeNull();
    // No stub was ever mirrored (subjectGraph off), so engine.db has no such id anyway.
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).toBeNull();
  });

  it('returns 0 and touches nothing when no memory matches the pattern', async () => {
    const { layer } = newLayer({ subjectGraph: true, memReads: true });
    await layer.init();
    const stored = await layer.store('A fact that should survive', 'knowledge', scope);

    const erased = await layer.eraseByPattern('no such pattern anywhere');
    expect(erased).toBe(0);
    expect(layer.getDb().getMemory(stored.memoryId)).not.toBeNull(); // untouched
  });
});
