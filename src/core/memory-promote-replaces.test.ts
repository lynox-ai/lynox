import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { setupMemoryStoreSubscription } from './engine-init.js';
import { channels } from './observability.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * A promotion moves a memory to another scope: the copy is stored there and the original
 * retired. The original is retired as REPLACED by the copy, in both stores, so it still
 * reads as the same fact and what was derived from it keeps a live successor. Only when
 * no copy was stored is it plainly deactivated, as before.
 */
const mock = vi.hoisted(() => ({ extraction: { entities: [], relations: [] } as ExtractionResult }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});
vi.mock('./contradiction-detector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contradiction-detector.js')>();
  return { ...actual, detectContradictions: vi.fn(async () => []) };
});

const from: MemoryScopeRef = { type: 'user', id: 'alex' };
const TEXT = 'Alice Schmidt is CTO at Acme GmbH.';
const dirs: string[] = [];
let current: { layer: KnowledgeLayer; engine: EngineDb; dir: string } | null = null;
const privateThreads = new Set<string>();

// One subscriber for the file (the channel offers no unsubscribe); it serves `current`.
const proxy = new Proxy({} as KnowledgeLayer, {
  get: (_t, prop) => {
    const layer = current!.layer as unknown as Record<string | symbol, unknown>;
    const v = layer[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current!.layer) : v;
  },
});
setupMemoryStoreSubscription(proxy, null, null, 'proj-1', (id) => privateThreads.has(id));

async function seed(): Promise<{ layer: KnowledgeLayer; engine: EngineDb; originalId: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-promote-'));
  dirs.push(dir);
  const engine = new EngineDb(join(dir, 'engine.db'), '');
  const layer = new KnowledgeLayer(join(dir, 'mem.db'), new LocalProvider(), undefined, undefined, engine, true);
  await layer.init();
  current = { layer, engine, dir };
  mock.extraction = {
    entities: [
      { name: 'Alice Schmidt', type: 'person', confidence: 0.9 },
      { name: 'Acme GmbH', type: 'organization', confidence: 0.9 },
    ],
    relations: [{ from: 'Alice Schmidt', to: 'Acme GmbH', relationType: 'works_at', description: 'CTO' }],
  };
  const r = await layer.store(TEXT, 'knowledge', from, { sourceChannel: 'agent', skipContradictionCheck: true });
  expect(r.stored).toBe(true);
  return { layer, engine, originalId: r.memoryId };
}

/** What the promote tool publishes for its copy. */
function publishCopy(threadId: string, opts: { replaces?: boolean } = {}): void {
  channels.memoryStore.publish({
    namespace: 'knowledge', content: TEXT, scopeType: 'context', scopeId: 'proj-1',
    sourceThreadId: threadId, sourceChannel: 'agent',
    ...(opts.replaces === false ? {} : { replaces: { pattern: TEXT } }),
  });
}
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 100));

type Row = { is_active: number; superseded_by: string | null };
function legacy<T>(read: (db: Database.Database) => T): T {
  const db = new Database(join(current!.dir, 'mem.db'), { readonly: true });
  try { return read(db); } finally { db.close(); }
}
function legacyRow(_layer: KnowledgeLayer, id: string): Row {
  return legacy(db => db.prepare('SELECT is_active, superseded_by FROM memories WHERE id = ?').get(id) as Row);
}
function engineRow(engine: EngineDb, id: string): Row {
  return engine.getDb().prepare('SELECT is_active, superseded_by FROM memories WHERE id = ?').get(id) as Row;
}
function copyId(layer: KnowledgeLayer, originalId: string): string {
  void layer;
  const row = legacy(db => db.prepare(
    "SELECT id FROM memories WHERE scope_type = 'context' AND scope_id = 'proj-1' AND id <> ?",
  ).get(originalId) as { id: string } | undefined);
  return row!.id;
}

afterEach(async () => {
  if (current) { await current.layer.close(); current.engine.close(); current = null; }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  privateThreads.clear();
  mock.extraction = { entities: [], relations: [] };
});

describe('memory:store subscriber — a promotion replaces the original', () => {
  it('retires the original as replaced by the stored copy, in both stores', async () => {
    const { layer, engine, originalId } = await seed();
    publishCopy('t-1');
    await settle();
    const copy = copyId(layer, originalId);
    expect(legacyRow(layer, originalId)).toEqual({ is_active: 0, superseded_by: copy });
    expect(engineRow(engine, originalId)).toEqual({ is_active: 0, superseded_by: copy });
    expect(legacyRow(layer, copy).is_active).toBe(1);
    // The relation derived from the original still names it, and it now has a live successor.
    const rel = engine.getDb().prepare('SELECT source_memory_id FROM relationships').get() as { source_memory_id: string };
    expect([originalId, copy]).toContain(rel.source_memory_id);
  });

  it('deactivates the original as before when no copy is stored (a private thread)', async () => {
    const { layer, engine, originalId } = await seed();
    privateThreads.add('t-private');
    publishCopy('t-private');
    await settle();
    expect(legacyRow(layer, originalId)).toEqual({ is_active: 0, superseded_by: null });
    expect(engineRow(engine, originalId)).toEqual({ is_active: 0, superseded_by: null });
  });

  it('leaves the original alone for an ordinary store', async () => {
    const { layer, originalId } = await seed();
    publishCopy('t-1', { replaces: false });
    await settle();
    expect(legacyRow(layer, originalId)).toEqual({ is_active: 1, superseded_by: null });
  });
});
