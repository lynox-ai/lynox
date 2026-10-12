import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { setupMemoryStoreSubscription } from './engine-init.js';
import { channels } from './observability.js';
import type { EmbeddingProvider } from './embedding.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * The private-mode switch purges, synchronously, what carries a thread's id. A write whose
 * embedding was still out when the switch ran would land afterwards and keep the id. These
 * cases drive the two places such a write passes: `KnowledgeLayer.store` itself, and the
 * `memory:store` subscriber that feeds it from the legacy extraction.
 */

/** An embedder that runs `onEmbed` inside the await — the moment the switch can flip. */
class HookedEmbedder implements EmbeddingProvider {
  readonly name = 'hooked-test';
  readonly model = 'hooked-test';
  readonly dimensions = 8;
  onEmbed: () => void = () => undefined;
  private n = 0;
  async embed(): Promise<number[]> {
    this.onEmbed();
    // Distinct vectors, so no write dedups against an earlier one.
    const v = [0, 0, 0, 0, 0, 0, 0, 0];
    v[this.n++ % 8] = 1;
    return v;
  }
}

const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
const dirs: string[] = [];
const layers: KnowledgeLayer[] = [];

function newLayer(): { layer: KnowledgeLayer; embedder: HookedEmbedder } {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-private-late-'));
  dirs.push(dir);
  const embedder = new HookedEmbedder();
  const layer = new KnowledgeLayer(join(dir, 'mem.db'), embedder);
  layers.push(layer);
  return { layer, embedder };
}

afterEach(async () => {
  for (const l of layers) { try { await l.close(); } catch { /* closed */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  layers.length = 0; dirs.length = 0;
});

describe('KnowledgeLayer.store — cancelled', () => {
  it('stores nothing when cancelled turns true during the embedding', async () => {
    const { layer, embedder } = newLayer();
    let privateMode = false;
    embedder.onEmbed = () => { privateMode = true; };
    const r = await layer.store('The client prefers invoices in CHF.', 'knowledge', scope, {
      sourceThreadId: 't-1', skipContradictionCheck: true, cancelled: () => privateMode,
    });
    expect(r.stored).toBe(false);
    expect(layer.purgeThread('t-1')).toBe(0);
  });

  it('stores nothing when cancelled turns true during the contradiction check', async () => {
    const { layer } = newLayer();
    // False on the first read (after the embedding), true on the second (after the
    // contradiction check): only the second check can stop this write.
    let reads = 0;
    const r = await layer.store('The client prefers invoices in CHF.', 'knowledge', scope, {
      sourceThreadId: 't-1', cancelled: () => ++reads >= 2,
    });
    expect(reads).toBe(2);
    expect(r.stored).toBe(false);
    expect(layer.purgeThread('t-1')).toBe(0);
  });

  it('stores as before when never cancelled', async () => {
    const { layer } = newLayer();
    const r = await layer.store('The client prefers invoices in CHF.', 'knowledge', scope, {
      sourceThreadId: 't-1', cancelled: () => false,
    });
    expect(r.stored).toBe(true);
    expect(layer.purgeThread('t-1')).toBe(1);
  });
});

describe('memory:store subscriber — private threads', () => {
  // One subscriber for the file: `diagnostics_channel` offers no unsubscribe through this
  // helper, and a second one would store every message twice.
  const privateThreads = new Set<string>();
  let current: { layer: KnowledgeLayer; embedder: HookedEmbedder } | null = null;
  const proxy = new Proxy({} as KnowledgeLayer, {
    get: (_t, prop) => {
      const layer = current!.layer as unknown as Record<string | symbol, unknown>;
      const v = layer[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current!.layer) : v;
    },
  });
  setupMemoryStoreSubscription(proxy, null, null, 'proj-1', (id) => privateThreads.has(id));

  const publish = (threadId: string, content: string): void => {
    channels.memoryStore.publish({
      namespace: 'knowledge', content, scopeType: 'context', scopeId: 'proj-1',
      sourceThreadId: threadId, sourceChannel: 'agent',
    });
  };
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 50));

  it('drops a publish from a thread that is already private, and stores a public one', async () => {
    current = newLayer();
    privateThreads.clear();
    privateThreads.add('t-private');
    let embeds = 0;
    current.embedder.onEmbed = () => { embeds++; };
    publish('t-private', 'The client prefers invoices in CHF.');
    publish('t-public', 'The client pays within thirty days.');
    await settle();
    expect(current.layer.purgeThread('t-private')).toBe(0);
    expect(current.layer.purgeThread('t-public')).toBe(1);
    // An already-private thread is dropped before its embedding is paid for: one embed, the
    // public one. (The check inside `store` would also drop it, but only after embedding.)
    expect(embeds).toBe(1);
  });

  it('drops a publish whose thread turned private while its embedding was out', async () => {
    current = newLayer();
    privateThreads.clear();
    current.embedder.onEmbed = () => { privateThreads.add('t-flip'); };
    publish('t-flip', 'The client prefers invoices in CHF.');
    await settle();
    expect(privateThreads.has('t-flip')).toBe(true);
    expect(current.layer.purgeThread('t-flip')).toBe(0);
  });
});
