import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';

/**
 * What the data export reads off the layer to tell whether its graph block is whole: how many
 * subject-graph reads fell back to the legacy store, and whether the subject graph is on with
 * no store behind it. Either means the block may be partial.
 */
describe('KnowledgeLayer signals for the data export', () => {
  const provider = new LocalProvider();
  const dirs: string[] = [];
  const layers: KnowledgeLayer[] = [];
  const engines: EngineDb[] = [];

  afterEach(async () => {
    for (const l of layers) await l.close().catch(() => {});
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    layers.length = 0; engines.length = 0; dirs.length = 0;
  });

  async function newLayer(opts: { subjectGraph: boolean; engine: boolean }): Promise<{ layer: KnowledgeLayer; engine: EngineDb | null }> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-kg-export-'));
    dirs.push(dir);
    const engine = opts.engine ? new EngineDb(join(dir, 'engine.db'), 'vault-key-kg-export') : null;
    if (engine) engines.push(engine);
    const layer = new KnowledgeLayer(join(dir, 'mem.db'), provider, undefined, undefined, engine ?? undefined, opts.subjectGraph, false);
    layers.push(layer);
    await layer.init();
    return { layer, engine };
  }

  it('counts a subject-graph read that falls back to the legacy store', async () => {
    const { layer, engine } = await newLayer({ subjectGraph: true, engine: true });
    await layer.listEntities({ limit: 10, offset: 0 });
    expect(layer.readFallbackCount, 'a read the subject graph answered is not a fallback').toBe(0);

    // engine.db closed under the layer: the subject read throws and the legacy store answers.
    engine!.close();
    await layer.listEntities({ limit: 10, offset: 0 });
    expect(layer.readFallbackCount).toBe(1);
  });

  it('reports the subject graph unavailable when it is on and engine.db is missing, and only then', async () => {
    expect((await newLayer({ subjectGraph: true, engine: false })).layer.subjectGraphUnavailable).toBe(true);
    expect((await newLayer({ subjectGraph: true, engine: true })).layer.subjectGraphUnavailable).toBe(false);
    expect((await newLayer({ subjectGraph: false, engine: false })).layer.subjectGraphUnavailable).toBe(false);
  });
});
