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
import { Agent } from './agent.js';
import { UNTRUSTED_DATA_MARKER } from './data-boundary.js';
import { memoryListTool, memoryPromoteTool, memoryRecallTool, memoryStoreTool } from '../tools/builtin/memory.js';
import { recallTool } from '../tools/builtin/knowledge.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { IAgent, IMemory, MemoryScopeRef, KnowledgeEntry } from '../types/index.js';

/**
 * Memory text that came in untrusted reaches the model marked as untrusted data on every tool
 * path that returns it (`memory_recall`, `memory_list`, the line `memory_promote` quotes,
 * `recall`), so a clean turn that reads it is no longer clean: storing the same text again
 * lands at the unverified tier. A real agent (the model is a script), real tools, a real
 * knowledge layer and the engine's own store subscription.
 */
const mock = vi.hoisted(() => ({ extraction: { entities: [], relations: [] } as ExtractionResult, process: vi.fn() }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});
vi.mock('./contradiction-detector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contradiction-detector.js')>();
  return { ...actual, detectContradictions: vi.fn(async () => []) };
});
// memory_promote is data-destructive; this agent has no one to confirm it, so the guard is stood down.
vi.mock('../tools/permission-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/permission-guard.js')>()),
  isDangerous: vi.fn().mockReturnValue(null),
  isDangerousDetailed: vi.fn().mockReturnValue(null),
}));
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.process = mock.process;
    this.answered = () => false;
    this.turnEnded = () => false;
    this.partial = () => ({ usage: undefined, content: [] });
  }),
}));

const from: MemoryScopeRef = { type: 'user', id: 'alex' };
const to: MemoryScopeRef = { type: 'context', id: 'proj-1' };
const TEXT = 'Alice Schmidt is CTO at Acme GmbH.';
const LINE = `[2026-10-01] ${TEXT}`;
const CLEAN = 'Bob Keller leads engineering at Acme GmbH.';
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
  const dir = mkdtempSync(join(tmpdir(), 'lynox-read-mark-'));
  dirs.push(dir);
  const engine = new EngineDb(join(dir, 'engine.db'), '');
  const layer = new KnowledgeLayer(join(dir, 'mem.db'), new LocalProvider(), undefined, undefined, engine, true);
  await layer.init();
  current = { layer, engine, dir };
  return layer;
}

async function seed(layer: KnowledgeLayer, text: string, sourceUntrusted: boolean, sourceChannel: 'agent' | 'upload' = 'agent'): Promise<void> {
  const r = await layer.store(text, 'knowledge', from, { sourceChannel, sourceUntrusted, skipContradictionCheck: true });
  expect(r.stored).toBe(true);
}

/** The flat file of scope `from` holds both lines. */
function flatMemory(): IMemory {
  const flat = `${LINE}\n[2026-10-02] ${CLEAN}`;
  return {
    load: vi.fn(async () => flat), save: vi.fn(), append: vi.fn(async () => undefined),
    delete: vi.fn(async () => 1), update: vi.fn(async () => false), render: vi.fn(() => ''),
    hasContent: vi.fn(() => true), loadAll: vi.fn(), maybeUpdate: vi.fn(),
    appendScoped: vi.fn(async () => undefined), loadScoped: vi.fn(async (_ns: string, s: MemoryScopeRef) => (s.type === from.type ? flat : null)),
    deleteScoped: vi.fn(async () => 1), updateScoped: vi.fn(async () => false),
  } as unknown as IMemory;
}

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 150));
const tool = (id: string, name: string, input: unknown) => ({ content: [{ type: 'tool_use' as const, id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } });
const done = { content: [{ type: 'text' as const, text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };

function agentWith(layer: KnowledgeLayer, extra: Partial<ReturnType<typeof createToolContext>> = {}): Agent {
  return new Agent({
    name: 'test', model: 'claude-sonnet-4-6', memory: flatMemory(),
    tools: [memoryListTool, memoryRecallTool, memoryStoreTool, memoryPromoteTool, recallTool],
    activeScopes: [{ type: 'global', id: 'global' }, to, from],
    toolContext: { ...createToolContext({}), knowledgeLayer: layer, ...extra },
  });
}

function rowIn(scope: MemoryScopeRef, text: string): { source_untrusted: number; source_type: string } | undefined {
  const db = new Database(join(current!.dir, 'mem.db'), { readonly: true });
  try {
    return db.prepare('SELECT source_untrusted, source_type FROM memories WHERE scope_type = ? AND scope_id = ? AND text = ? AND is_active = 1')
      .get(scope.type, scope.id, text) as { source_untrusted: number; source_type: string } | undefined;
  } finally { db.close(); }
}

function resultOf(agent: Agent, id: string): string {
  for (const msg of agent.getMessages()) {
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content as unknown as Array<{ type?: string; tool_use_id?: string; content: unknown }>) {
      if (b.type === 'tool_result' && b.tool_use_id === id) return String(b.content);
    }
  }
  throw new Error(`no tool_result for ${id}`);
}

/** A clean turn reads with `read`, then stores `text` in scope `to`. */
async function readThenStore(agent: Agent, read: { name: string; input: unknown }, text: string): Promise<void> {
  mock.process
    .mockResolvedValueOnce(tool('r1', read.name, read.input))
    .mockResolvedValueOnce(tool('s1', 'memory_store', { namespace: 'knowledge', content: text, scope: 'context:proj-1' }))
    .mockResolvedValueOnce(done);
  await agent.send('what do we know about Acme');
  await settle();
}

afterEach(async () => {
  mock.process.mockReset();
  if (current) { await current.layer.close(); current.engine.close(); current = null; }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('memory text stored untrusted reaches the model marked', () => {
  const reads = [
    { name: 'memory_list', input: { namespace: 'knowledge', scope: 'user:alex' } },
    { name: 'memory_recall', input: { namespace: 'knowledge', query: 'Acme', scope: 'user:alex' } },
    { name: 'memory_recall', input: { namespace: 'knowledge', scope: 'user:alex' } },
  ];

  it.each(reads)('$name $input: a clean turn that reads it stores the same text as unverified', async (read) => {
    const layer = await open();
    await seed(layer, TEXT, true);
    const agent = agentWith(layer);
    expect(agent.conversationSawUntrusted).toBe(false);
    await readThenStore(agent, read, TEXT);
    const shown = resultOf(agent, 'r1');
    expect(shown).toContain(`${UNTRUSTED_DATA_MARKER} source="memory:knowledge">\n${LINE}\n</untrusted_data>`);
    expect(rowIn(to, TEXT)).toMatchObject({ source_untrusted: 1, source_type: 'external_unverified' });
  });

  it.each(reads)('$name $input: a line stored clean is not marked, and a clean turn stores it at the agent tier', async (read) => {
    const layer = await open();
    await seed(layer, TEXT, false);
    await seed(layer, CLEAN, false);
    const agent = agentWith(layer);
    await readThenStore(agent, read, CLEAN);
    expect(resultOf(agent, 'r1')).not.toContain(UNTRUSTED_DATA_MARKER);
    expect(rowIn(to, CLEAN)).toMatchObject({ source_untrusted: 0, source_type: 'agent_inferred' });
  });

  it('a line from an upload is marked, though its row was not written on an untrusted turn', async () => {
    const layer = await open();
    await seed(layer, TEXT, false, 'upload');
    const agent = agentWith(layer);
    await readThenStore(agent, reads[0]!, TEXT);
    expect(resultOf(agent, 'r1')).toContain(`${UNTRUSTED_DATA_MARKER} source="memory:knowledge">\n${LINE}\n</untrusted_data>`);
    expect(rowIn(to, TEXT)).toMatchObject({ source_untrusted: 1, source_type: 'external_unverified' });
  });

  it('memory_list marks the untrusted line only, the clean one beside it stays plain', async () => {
    const layer = await open();
    await seed(layer, TEXT, true);
    await seed(layer, CLEAN, false);
    const agent = agentWith(layer);
    await readThenStore(agent, reads[0]!, CLEAN);
    const shown = resultOf(agent, 'r1');
    expect(shown).toContain(`  - ${UNTRUSTED_DATA_MARKER} source="memory:knowledge">\n${LINE}\n</untrusted_data>`);
    expect(shown).toContain(`  - [2026-10-02] ${CLEAN}`);
  });

  it('a superseded line that came in untrusted is still marked', async () => {
    const layer = await open();
    await seed(layer, TEXT, true);
    const agent = agentWith(layer);
    const superseded = `[SUPERSEDED 2026-10-05] ${LINE}`;
    vi.mocked(agent.memory!.loadScoped).mockResolvedValue(superseded);
    await readThenStore(agent, reads[0]!, CLEAN);
    expect(resultOf(agent, 'r1')).toContain(`${UNTRUSTED_DATA_MARKER} source="memory:knowledge">\n${superseded}\n</untrusted_data>`);
  });

  it('the line memory_promote quotes is marked when it came in untrusted', async () => {
    const layer = await open();
    await seed(layer, TEXT, true);
    const agent = agentWith(layer);
    await readThenStore(agent, { name: 'memory_promote', input: { namespace: 'knowledge', content_pattern: 'Alice Schmidt', from_scope: 'user:alex', to_scope: 'global' } }, CLEAN);
    expect(resultOf(agent, 'r1')).toContain(`${UNTRUSTED_DATA_MARKER} source="memory:knowledge">\n${LINE}\n</untrusted_data>`);
    expect(rowIn(to, CLEAN)).toMatchObject({ source_untrusted: 1, source_type: 'external_unverified' });
  });

  it('the line memory_promote quotes stays plain when it came in clean', async () => {
    const layer = await open();
    await seed(layer, TEXT, false);
    const agent = agentWith(layer);
    await readThenStore(agent, { name: 'memory_promote', input: { namespace: 'knowledge', content_pattern: 'Alice Schmidt', from_scope: 'user:alex', to_scope: 'global' } }, CLEAN);
    expect(resultOf(agent, 'r1')).toContain(`"${LINE}"`);
    expect(rowIn(to, CLEAN)).toMatchObject({ source_untrusted: 0, source_type: 'agent_inferred' });
  });

  it('the line memory_promote quotes stays plain when no row vouches for it, though its copy is stored untrusted', async () => {
    const layer = await open();
    const agent = agentWith(layer);
    await readThenStore(agent, { name: 'memory_promote', input: { namespace: 'knowledge', content_pattern: 'Alice Schmidt', from_scope: 'user:alex', to_scope: 'global' } }, CLEAN);
    expect(resultOf(agent, 'r1')).toContain(`"${LINE}"`);
    expect(rowIn({ type: 'global', id: 'global' }, LINE)).toMatchObject({ source_untrusted: 1, source_type: 'external_unverified' });
    expect(rowIn(to, CLEAN)).toMatchObject({ source_untrusted: 0, source_type: 'agent_inferred' });
  });

  it('a line no knowledge row vouches for is not marked', async () => {
    const layer = await open();
    // Only the clean line has a row; the untrusted text is in the flat file with no row at all.
    await seed(layer, CLEAN, false);
    const agent = agentWith(layer);
    await readThenStore(agent, reads[0]!, TEXT);
    expect(resultOf(agent, 'r1')).not.toContain(UNTRUSTED_DATA_MARKER);
    expect(rowIn(to, TEXT)).toMatchObject({ source_untrusted: 0, source_type: 'agent_inferred' });
  });

  it('a lookup that fails marks every line, so the turn is no longer clean', async () => {
    const layer = await open();
    await seed(layer, CLEAN, false);
    const agent = agentWith(layer);
    vi.spyOn(layer, 'untrustedTextsIn').mockImplementation(() => { throw new Error('graph unreadable'); });
    await readThenStore(agent, reads[0]!, CLEAN);
    const shown = resultOf(agent, 'r1');
    expect(shown).toContain(`${UNTRUSTED_DATA_MARKER} source="memory:knowledge">\n[2026-10-02] ${CLEAN}\n</untrusted_data>`);
    expect(shown).toContain(`${UNTRUSTED_DATA_MARKER} source="memory:knowledge">\n${LINE}\n</untrusted_data>`);
    expect(rowIn(to, CLEAN)).toMatchObject({ source_untrusted: 1, source_type: 'external_unverified' });
  });

  it('a retired untrusted row no longer marks its text', async () => {
    const layer = await open();
    await seed(layer, TEXT, true);
    expect(await layer.deactivateByPattern(TEXT, 'knowledge')).toBe(1);
    const agent = agentWith(layer);
    await readThenStore(agent, reads[0]!, CLEAN);
    expect(resultOf(agent, 'r1')).not.toContain(UNTRUSTED_DATA_MARKER);
  });
});

describe('recall marks entries at the unverified tier', () => {
  function storeWith(entries: Array<Pick<KnowledgeEntry, 'id' | 'text' | 'sourceType'>>): NonNullable<IAgent['toolContext']['knowledgeStore']> {
    return {
      recall: vi.fn(() => entries),
      pendingCountForSubjectHint: vi.fn(() => 0),
    } as unknown as NonNullable<IAgent['toolContext']['knowledgeStore']>;
  }

  it('an unverified entry reaches the model wrapped, and a clean turn that reads it stores the text as unverified', async () => {
    const layer = await open();
    const agent = agentWith(layer, { knowledgeStore: storeWith([{ id: 'aaaaaaaa-1', text: TEXT, sourceType: 'external_unverified' }]) });
    await readThenStore(agent, { name: 'recall', input: { query: 'Acme' } }, TEXT);
    expect(resultOf(agent, 'r1')).toContain(`- [aaaaaaaa] ${UNTRUSTED_DATA_MARKER} source="recall">\n${TEXT}\n</untrusted_data> [unverified]`);
    expect(rowIn(to, TEXT)).toMatchObject({ source_untrusted: 1, source_type: 'external_unverified' });
  });

  it.each(['user_asserted', 'agent_inferred', 'tool_verified'] as const)('a %s entry stays plain and the turn stays clean', async (tier) => {
    const layer = await open();
    const agent = agentWith(layer, { knowledgeStore: storeWith([{ id: 'bbbbbbbb-1', text: CLEAN, sourceType: tier }]) });
    await readThenStore(agent, { name: 'recall', input: { query: 'Acme' } }, CLEAN);
    expect(resultOf(agent, 'r1')).not.toContain(UNTRUSTED_DATA_MARKER);
    expect(rowIn(to, CLEAN)).toMatchObject({ source_untrusted: 0, source_type: 'agent_inferred' });
  });
});
