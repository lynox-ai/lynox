import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { ExtractionResultV2 } from './entity-extractor-v2.js';
import type { MemoryScopeRef } from '../types/index.js';
import { extractEntities } from './entity-extractor.js';
import { extractEntitiesV2 } from './entity-extractor-v2.js';

/**
 * The window AFTER the legacy insert. `store` commits the legacy row, then awaits the entity
 * extraction, and only then writes the engine.db stub. The private-mode switch stores the
 * flag and purges in one synchronous step, and purges find stubs through the legacy ids — so
 * a stub written after that purge is one no later purge reaches. The extractor here plays the
 * switch: it flips the flag and runs the purge while the extraction is "out".
 */
const hook = vi.hoisted(() => ({ during: (): void => undefined }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return {
    ...actual,
    extractEntities: vi.fn(async (): Promise<ExtractionResult> => {
      hook.during();
      return { entities: [{ name: 'Kestrel Weaving', type: 'organization' }], relations: [] } as unknown as ExtractionResult;
    }),
  };
});

// V2 is the default extractor whenever the layer has a client (`LYNOX_KG_EXTRACTOR` unset).
vi.mock('./entity-extractor-v2.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor-v2.js')>();
  return {
    ...actual,
    extractEntitiesV2: vi.fn(async (): Promise<ExtractionResultV2> => {
      hook.during();
      return { entities: [], relations: [] } as unknown as ExtractionResultV2;
    }),
  };
});

const provider = new LocalProvider();
const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
const TEXT = 'ZZMARKER the client Kestrel Weaving prefers invoices in CHF.';
const dirs: string[] = [];
const engines: EngineDb[] = [];
const layers: KnowledgeLayer[] = [];

function newLayer(memReads: boolean): { layer: KnowledgeLayer; engine: EngineDb } {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-private-window-'));
  dirs.push(dir);
  const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-private-window');
  engines.push(engine);
  const layer = new KnowledgeLayer(join(dir, 'mem.db'), provider, undefined, undefined, engine, true, memReads);
  layers.push(layer);
  return { layer, engine };
}

// Every row, not a text match: each test gets a fresh engine.db, and the stub text may be
// stored encrypted, so a LIKE on it would count nothing whatever was written.
const stubsWithMarker = (engine: EngineDb): number =>
  (engine.getDb().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;

afterEach(async () => {
  hook.during = () => undefined;
  for (const l of layers) { try { await l.close(); } catch { /* closed */ } }
  for (const e of engines) { try { e.close(); } catch { /* closed */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  layers.length = 0; engines.length = 0; dirs.length = 0;
});

describe.each([
  ['after the write cutover, V1 extractor', true, false],
  ['after the write cutover, V2 extractor', true, true],
  ['before the write cutover, V1 extractor + mirror', false, false],
  ['before the write cutover, V2 extractor + mirror', false, true],
])('KnowledgeLayer.store — private mode switched on during the entity extraction, %s', (_label, memReads, v2) => {
  it('leaves no stub behind once the switch has purged the thread', async () => {
    const { layer, engine } = newLayer(memReads);
    // A client is what selects V2; the extractor itself is mocked above.
    if (v2) layer.setAnthropicClient({} as never);
    let privateMode = false;
    hook.during = () => { privateMode = true; layer.purgeThread('t-1'); };
    const r = await layer.store(TEXT, 'knowledge', scope, {
      sourceThreadId: 't-1', skipContradictionCheck: true, cancelled: () => privateMode,
    });
    expect(r.stored).toBe(false);
    expect(stubsWithMarker(engine)).toBe(0);
    expect(layer.purgeThread('t-1')).toBe(0);
  });

  it('leaves no stub behind when the switch flipped during the metered gate', async () => {
    const { layer, engine } = newLayer(memReads);
    let privateMode = false;
    // The gate runs only for a metered tenant with a client; the extractor is never reached.
    layer.setAnthropicClient({} as never);
    layer.setMeteredHost({
      getContext: () => null,
      getHooks: () => [{ onBeforeRun: async () => { privateMode = true; layer.purgeThread('t-1'); } }],
    } as never);
    vi.mocked(extractEntities).mockClear();
    vi.mocked(extractEntitiesV2).mockClear();
    const r = await layer.store(TEXT, 'knowledge', scope, {
      sourceThreadId: 't-1', skipContradictionCheck: true, cancelled: () => privateMode,
    });
    expect(privateMode).toBe(true);
    expect(r.stored).toBe(false);
    expect(stubsWithMarker(engine)).toBe(0);
    // Stopped at the gate, before the extraction is paid for. (The check after the
    // extraction would also drop the stub, but only once the call has been made.)
    expect(vi.mocked(extractEntities)).not.toHaveBeenCalled();
    expect(vi.mocked(extractEntitiesV2)).not.toHaveBeenCalled();
  });

  it('writes the stub as before when the chat stays public', async () => {
    // Positive control on the same machinery: this store does write a stub.
    const { layer, engine } = newLayer(memReads);
    if (v2) layer.setAnthropicClient({} as never);
    const r = await layer.store(TEXT, 'knowledge', scope, {
      sourceThreadId: 't-1', skipContradictionCheck: true, cancelled: () => false,
    });
    expect(r.stored).toBe(true);
    expect(stubsWithMarker(engine)).toBe(1);
  });
});
