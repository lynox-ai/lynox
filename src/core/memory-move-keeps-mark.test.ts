import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { setupMemoryStoreSubscription } from './engine-init.js';
import { createToolContext } from './tool-context.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { memoryPromoteTool, memoryUpdateTool } from '../tools/builtin/memory.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { IAgent, MemoryScopeRef } from '../types/index.js';

/**
 * A memory that came in untrusted keeps that mark when a clean turn moves it to another
 * scope (`memory_promote`) or replaces it (`memory_update`). The flat-file line carries no
 * mark, so the tools read it from the knowledge rows of the same text; where none can be
 * read, the new row counts as untrusted. Runs the real tools against a real knowledge layer
 * and the engine's own store subscription.
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
const LINE = `[2026-10-01] ${TEXT}`;
const dirs: string[] = [];
let current: { layer: KnowledgeLayer; engine: EngineDb; dir: string } | null = null;

// One subscriber for the file (the channel offers no unsubscribe); it serves `current`.
const proxy = new Proxy({} as KnowledgeLayer, {
  get: (_t, prop) => {
    const layer = current!.layer as unknown as Record<string | symbol, unknown>;
    const v = layer[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current!.layer) : v;
  },
});
setupMemoryStoreSubscription(proxy, null, null, 'proj-1', () => false);

async function open(): Promise<KnowledgeLayer> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-move-mark-'));
  dirs.push(dir);
  const engine = new EngineDb(join(dir, 'engine.db'), '');
  const layer = new KnowledgeLayer(join(dir, 'mem.db'), new LocalProvider(), undefined, undefined, engine, true);
  await layer.init();
  current = { layer, engine, dir };
  return layer;
}

/** The original's knowledge row, written the way the store subscription writes it. */
async function seed(layer: KnowledgeLayer, evidence: { sourceUntrusted?: boolean; sourceChannel?: 'agent' | 'upload' }): Promise<string> {
  const r = await layer.store(TEXT, 'knowledge', from, {
    sourceChannel: evidence.sourceChannel ?? 'agent',
    ...(evidence.sourceUntrusted !== undefined ? { sourceUntrusted: evidence.sourceUntrusted } : {}),
    skipContradictionCheck: true,
  });
  expect(r.stored).toBe(true);
  return r.memoryId;
}

/** A clean turn: none of the untrusted signals is set. */
function cleanAgent(layer: KnowledgeLayer, flat: Partial<NonNullable<IAgent['memory']>>): IAgent {
  const memory = {
    load: vi.fn(async () => LINE), save: vi.fn(), append: vi.fn(async () => undefined),
    delete: vi.fn(async () => 1), update: vi.fn(async () => false), render: vi.fn(() => ''),
    hasContent: vi.fn(() => true), loadAll: vi.fn(), maybeUpdate: vi.fn(),
    appendScoped: vi.fn(async () => undefined), loadScoped: vi.fn(async () => LINE),
    deleteScoped: vi.fn(async () => 1), updateScoped: vi.fn(async () => false),
    ...flat,
  } as unknown as NonNullable<IAgent['memory']>;
  return {
    name: 'test', model: 'test-model', memory, tools: [], onStream: null, principal: OWNER_PRINCIPAL,
    activeScopes: [{ type: 'global', id: 'global' }, { type: 'context', id: 'proj-1' }, from],
    toolContext: { ...createToolContext({}), knowledgeLayer: layer },
  } as unknown as IAgent;
}

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 150));

type Mark = { source_untrusted: number; source_type: string; is_active: number };
function rowsIn(scope: MemoryScopeRef): (Mark & { text: string })[] {
  const db = new Database(join(current!.dir, 'mem.db'), { readonly: true });
  try {
    return db.prepare('SELECT text, source_untrusted, source_type, is_active FROM memories WHERE scope_type = ? AND scope_id = ?')
      .all(scope.type, scope.id) as (Mark & { text: string })[];
  } finally { db.close(); }
}
function rowById(id: string): Mark {
  const db = new Database(join(current!.dir, 'mem.db'), { readonly: true });
  try {
    return db.prepare('SELECT source_untrusted, source_type, is_active FROM memories WHERE id = ?').get(id) as Mark;
  } finally { db.close(); }
}

const to: MemoryScopeRef = { type: 'context', id: 'proj-1' };
async function promote(agent: IAgent): Promise<string> {
  const out = await memoryPromoteTool.handler(
    { namespace: 'knowledge', content_pattern: 'Alice Schmidt', from_scope: 'user:alex', to_scope: 'context:proj-1' },
    agent,
  );
  await settle();
  return out;
}

afterEach(async () => {
  if (current) { await current.layer.close(); current.engine.close(); current = null; }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  mock.extraction = { entities: [], relations: [] };
});

describe('memory_promote keeps the mark of the line it moves', () => {
  it('a line stored untrusted stays untrusted when a clean turn promotes it', async () => {
    const layer = await open();
    await seed(layer, { sourceUntrusted: true });
    expect(await promote(cleanAgent(layer, {}))).toContain('Promoted entry');
    const copies = rowsIn(to);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ source_untrusted: 1, source_type: 'external_unverified' });
  });

  it('a line from an upload stays at the upload tier when a clean turn promotes it', async () => {
    const layer = await open();
    await seed(layer, { sourceChannel: 'upload' });
    await promote(cleanAgent(layer, {}));
    const copies = rowsIn(to);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ source_untrusted: 1, source_type: 'external_unverified' });
  });

  it('a clean line promoted on a clean turn lands active at the agent tier, not marked', async () => {
    const layer = await open();
    const originalId = await seed(layer, { sourceUntrusted: false });
    await promote(cleanAgent(layer, {}));
    const copies = rowsIn(to);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ source_untrusted: 0, source_type: 'agent_inferred', is_active: 1 });
    expect(rowById(originalId).is_active).toBe(0);
  });

  it('a line whose knowledge row cannot be found is promoted as untrusted', async () => {
    const layer = await open();
    // No row for the line: the flat file holds a fact the graph never saw.
    await promote(cleanAgent(layer, {}));
    const copies = rowsIn(to);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ source_untrusted: 1, source_type: 'external_unverified' });
  });

  it('a retired row does not vouch for a line: with no active row the copy is untrusted', async () => {
    const layer = await open();
    await seed(layer, { sourceUntrusted: false });
    expect(await layer.deactivateByPattern(TEXT, 'knowledge')).toBe(1);
    await promote(cleanAgent(layer, {}));
    expect(rowsIn(to)[0]).toMatchObject({ source_untrusted: 1, source_type: 'external_unverified' });
  });

  it('reads the mark in the source scope only: an untrusted twin elsewhere does not mark a clean line', async () => {
    const layer = await open();
    await seed(layer, { sourceUntrusted: false });
    const elsewhere = await layer.store(TEXT, 'knowledge', { type: 'context', id: 'other' }, { sourceChannel: 'agent', sourceUntrusted: true, skipContradictionCheck: true });
    expect(elsewhere.stored).toBe(true);
    await promote(cleanAgent(layer, {}));
    expect(rowsIn(to)[0]).toMatchObject({ source_untrusted: 0, source_type: 'agent_inferred' });
  });
});

describe('memory_update keeps the mark of the lines it replaces', () => {
  const NEW = 'Bob Keller leads engineering at Acme GmbH since March.';
  async function supersede(agent: IAgent): Promise<string> {
    const out = await memoryUpdateTool.handler(
      { namespace: 'knowledge', old_content: 'Alice Schmidt CTO Acme', new_content: NEW, scope: 'user:alex' },
      agent,
    );
    await settle();
    return out;
  }
  function newRow(): Mark | undefined {
    return rowsIn(from).find(r => r.text === NEW);
  }

  it('the line that replaces an untrusted line stays untrusted on a clean turn', async () => {
    const layer = await open();
    await seed(layer, { sourceUntrusted: true });
    expect(await supersede(cleanAgent(layer, {}))).toContain('Superseded 1');
    expect(newRow()).toMatchObject({ source_untrusted: 1, source_type: 'external_unverified' });
  });

  it('the line that replaces a clean line on a clean turn lands at the agent tier', async () => {
    const layer = await open();
    await seed(layer, { sourceUntrusted: false });
    expect(await supersede(cleanAgent(layer, {}))).toContain('Superseded 1');
    expect(newRow()).toMatchObject({ source_untrusted: 0, source_type: 'agent_inferred' });
  });

  it('a line that replaces nothing takes the mark of its turn only', async () => {
    const layer = await open();
    await seed(layer, { sourceUntrusted: true });
    const agent = cleanAgent(layer, { loadScoped: vi.fn(async () => '') });
    expect(await supersede(agent)).toContain('no prior memory matched');
    expect(newRow()).toMatchObject({ source_untrusted: 0, source_type: 'agent_inferred' });
  });

  it('an exact edit of an untrusted line on a clean turn keeps the row untrusted', async () => {
    const layer = await open();
    const id = await seed(layer, { sourceUntrusted: true });
    const agent = cleanAgent(layer, { updateScoped: vi.fn(async () => true) });
    const out = await memoryUpdateTool.handler(
      { namespace: 'knowledge', old_content: 'CTO', new_content: 'CEO', scope: 'user:alex' },
      agent,
    );
    expect(out).toContain('Updated content');
    await settle();
    expect(rowById(id)).toMatchObject({ source_untrusted: 1, source_type: 'external_unverified' });
  });
});
