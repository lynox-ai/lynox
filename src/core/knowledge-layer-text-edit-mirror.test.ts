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
 * Text-edit mirror. `updateMemoryText` refreshed the engine.db stub text/embedding
 * only under the READ flag (memoryReadsActive), while every sibling memory mutation
 * (deactivate/consolidate/confirm/gc) mirrors on the WRITE flag (subject_graph_enabled).
 * So a UI correction/redaction made during the dual-write window (write-on, read-off)
 * left the pre-edit text in engine.db forever; when reads flipped on, recall served the
 * stale (possibly redacted-away) content — the same privacy divergence the deactivate
 * mirror closes. The fix refreshes the stub text under the write flag.
 *
 * Extraction is mocked EMPTY so stored memories are subject-less — proving the mirror
 * works on the vector-recall stub alone (no subject graph to lean on).
 */
const mock = vi.hoisted(() => ({ extraction: { entities: [], relations: [] } as ExtractionResult }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});

describe('KnowledgeLayer text-edit mirror', () => {
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

  function newLayer(opts: { subjectGraph: boolean; memReads: boolean }): { layer: KnowledgeLayer; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-editmirror-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-editmirror');
    engines.push(engine);
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), provider, undefined, undefined,
      engine, opts.subjectGraph, opts.memReads,
    );
    layers.push(layer);
    return { layer, engine };
  }

  const readStubText = (engine: EngineDb, id: string): string => {
    const raw = engine.getDb().prepare('SELECT text FROM memories WHERE id = ?').get(id) as { text: string };
    return engine.dec(raw.text);
  };

  it('refreshes the engine.db stub text under subjectGraph ON even when reads are OFF (gate is writes, not reads)', async () => {
    const { layer, engine } = newLayer({ subjectGraph: true, memReads: false });
    await layer.init();

    const oldText = 'Customer Jane Roe owes CHF 4200 by Friday';
    const stored = await layer.store(oldText, 'knowledge', scope);
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)!.is_active).toBe(1);
    // The stub carries the pre-edit text (with the name that will be redacted).
    expect(readStubText(engine, stored.memoryId)).toContain('Jane Roe');

    // A redaction edit during the dual-write window (read-off).
    const newText = 'Customer owes CHF 4200 by Friday';
    expect(await layer.updateMemoryText(oldText, newText, 'knowledge', scope)).toBe(true);

    // The engine.db stub now carries the corrected text — the redacted name is GONE,
    // so a later reads-flip serves the correction, not the stale original.
    const after = readStubText(engine, stored.memoryId);
    expect(after).not.toContain('Jane Roe');
    expect(after).toContain('Customer owes CHF 4200');
  });

  it('does not touch engine.db when subjectGraph is OFF (legacy-only edit)', async () => {
    const { layer, engine } = newLayer({ subjectGraph: false, memReads: false });
    await layer.init();
    const stored = await layer.store('Alpha fact about Projekt Zed', 'knowledge', scope);
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).toBeNull(); // no stub written at all

    expect(await layer.updateMemoryText('Alpha fact about Projekt Zed', 'Beta fact about Projekt Zed', 'knowledge', scope)).toBe(true);
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).toBeNull(); // still none — edit stayed legacy-only
  });

  it('isolates an engine.db mirror failure: the legacy edit still applies, no throw', async () => {
    const { layer, engine } = newLayer({ subjectGraph: true, memReads: false });
    await layer.init();
    const stored = await layer.store('Gamma fact about Projekt Zed', 'knowledge', scope);
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)!.is_active).toBe(1);

    const spy = vi.spyOn(MemoryGraphStore.prototype, 'updateStubText').mockImplementationOnce(() => {
      throw new Error('engine.db locked');
    });
    // The mirror throw is swallowed; the legacy edit still succeeds.
    expect(await layer.updateMemoryText('Gamma fact about Projekt Zed', 'Delta fact about Projekt Zed', 'knowledge', scope)).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
