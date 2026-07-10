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
 * S5b'-c delete mirror. `memory_delete` / `memory_update` route to
 * KnowledgeLayer.deactivateByPattern, which deactivated ONLY the legacy store —
 * so under the read cutover (recall serves engine.db) the "deleted" statement
 * stayed recallable from engine.db: the "deleted means gone" privacy promise was
 * broken by the cutover. The fix mirrors the deactivation onto the engine.db
 * stubs by id (matched on the legacy plaintext, reaped by id in engine.db).
 *
 * Extraction is mocked EMPTY so stored memories are subject-less — proving the
 * mirror works on the vector-recall path alone (no subject graph to lean on).
 */
const mock = vi.hoisted(() => ({ extraction: { entities: [], relations: [] } as ExtractionResult }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});

describe('KnowledgeLayer delete mirror (S5b\'-c)', () => {
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

  function newLayer(opts: { subjectGraph: boolean; memReads: boolean }): { layer: KnowledgeLayer; engine: EngineDb; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-delmirror-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-delmirror');
    engines.push(engine);
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), provider, undefined, undefined,
      engine, opts.subjectGraph, opts.memReads,
    );
    layers.push(layer);
    return { layer, engine, dir };
  }

  it('reaps the engine.db stub so a deleted fact stops surfacing under the read cutover', async () => {
    const { layer, engine } = newLayer({ subjectGraph: true, memReads: true });
    await layer.init();

    const secret = 'The launch code for Projekt Titan is seven seven three.';
    const stored = await layer.store(secret, 'knowledge', scope);
    expect(stored.stored).toBe(true);

    // Recallable from engine.db before the delete. (LocalProvider is a positional
    // char-hash embedder, so the recall query must closely match the stored text
    // to clear the threshold — this test exercises the mirror, not recall quality.)
    const before = await layer.retrieve(secret, [scope], opts);
    expect(before.memories.map(m => m.id)).toContain(stored.memoryId);

    // memory_delete → deactivateByPattern on a matching substring.
    const count = await layer.deactivateByPattern('launch code for Projekt Titan');
    expect(count).toBe(1);

    // Gone from engine.db recall …
    const after = await layer.retrieve(secret, [scope], opts);
    expect(after.memories.map(m => m.id)).not.toContain(stored.memoryId);
    // … and the underlying stub is actually is_active=0 (not merely out-ranked).
    const stub = new MemoryGraphStore(engine).getStub(stored.memoryId);
    expect(stub!.is_active).toBe(0);
  });

  it('mirrors under subjectGraph ON even when reads are OFF (gate is writes, not reads)', async () => {
    // The mirror WRITES stubs whenever subjectGraph is on, so a delete must reap
    // them whenever it's on — independent of the read cutover. A regression that
    // re-gated on memoryReadsActive would leave the stub active here.
    const { layer, engine } = newLayer({ subjectGraph: true, memReads: false });
    await layer.init();

    const stored = await layer.store('Dual-write only secret about Projekt Nimbus', 'knowledge', scope);
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)!.is_active).toBe(1);

    const count = await layer.deactivateByPattern('Dual-write only secret');
    expect(count).toBe(1);
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)!.is_active).toBe(0);
  });

  it('§0.1: a failed engine.db reap THROWS (erasure must be loud), legacy still deactivated', async () => {
    const { layer } = newLayer({ subjectGraph: true, memReads: true });
    await layer.init();
    const stored = await layer.store('Fact whose mirror reap will fail', 'knowledge', scope);
    expect(stored.stored).toBe(true);

    // Force the engine.db reap to throw for this one call.
    const spy = vi.spyOn(MemoryGraphStore.prototype, 'deactivateByIds').mockImplementationOnce(() => {
      throw new Error('engine.db locked');
    });
    try {
      // §0.1 (was: swallowed + returned the legacy count). The fleet reads engine.db
      // primary, so a swallowed reap leaves the "deleted" content recallable — a silent
      // erasure failure. Deletion must be loud: the mirror failure now RE-THROWS so a
      // caller that awaits can surface a half-completed erasure.
      await expect(layer.deactivateByPattern('Fact whose mirror reap will fail')).rejects.toThrow('engine.db locked');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore(); // restore even if an assertion above throws (no prototype-spy leak)
    }
    // The legacy deactivation ran BEFORE the mirror reap (deactivateMemoriesByPattern
    // at the top of deactivateByPattern), so it still stands — assert it, don't just
    // claim it: the row is is_active=0 even though the engine.db half threw (the
    // honest partial state the throw signals).
    expect(layer.getDb().getMemory(stored.memoryId)!.is_active).toBe(0);
  });

  it('§0.1: a failed engine.db stub write surfaces a HARD parity-loss + preserves the legacy row', async () => {
    const { layer, engine } = newLayer({ subjectGraph: true, memReads: true });
    await layer.init();

    // Capture stderr to assert the distinct, monitorable parity marker.
    const lines: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    // Force the recall-authoritative stub write to fail on the reads-active path.
    const stubSpy = vi.spyOn(MemoryGraphStore.prototype, 'upsertStub').mockImplementationOnce(() => {
      throw new Error('engine.db disk full');
    });

    let stored: Awaited<ReturnType<typeof layer.store>>;
    try {
      stored = await layer.store('A fact whose engine.db stub write will fail', 'knowledge', scope);
    } finally {
      // Restore in finally so a surprise throw can never leak the global stderr mock
      // into later tests (which would silently swallow all their stderr).
      errSpy.mockRestore();
      stubSpy.mockRestore();
    }

    // Preserve: the legacy row still lands (no data loss — it rides backup/export).
    expect(stored.stored).toBe(true);
    expect(stored.memoryId).toBeTruthy();
    // Surface: a distinct CRITICAL mirror-parity line was emitted (NOT the routine
    // best-effort swallow), so monitoring can alert + the Adapter-PR reconcile can act.
    expect(lines.some(l => l.includes('[lynox:mirror-parity] CRITICAL store'))).toBe(true);
    // And the stub genuinely never landed in engine.db (the silent-loss the old
    // swallow hid) — which is exactly why the read-back parity check fired.
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).toBeNull();
  });

  it('§0.1: a SUCCESSFUL reads-active store emits NO parity-loss marker (read-back does not false-fire)', async () => {
    // Guards the read-back getStub: a regression that fired a parity-loss on the happy
    // path (or a stub that silently fails to land) would surface here, not in prod.
    const { layer } = newLayer({ subjectGraph: true, memReads: true });
    await layer.init();
    const lines: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    try {
      const stored = await layer.store('A perfectly normal fact that stores cleanly', 'knowledge', scope);
      expect(stored.stored).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
    expect(lines.some(l => l.includes('[lynox:mirror-parity]'))).toBe(false);
  });

  it('flag-off: deactivates legacy only, returns the count, never touches engine.db', async () => {
    // subjectGraph OFF → the mirror gate is skipped even though an engine.db exists.
    const { layer, engine } = newLayer({ subjectGraph: false, memReads: false });
    await layer.init();

    const stored = await layer.store('Ephemeral note to delete later', 'knowledge', scope);
    expect(stored.stored).toBe(true);

    const count = await layer.deactivateByPattern('Ephemeral note');
    expect(count).toBe(1);
    // No stub was ever mirrored (subjectGraph off), so engine.db has no such id.
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).toBeNull();
  });
});
