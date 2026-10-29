/**
 * 660a-3 — the entries a mandate's act leaves behind it, written apart from the call (K1–K3, K5,
 * r1 B1/B2/B4/B5, Delta r1).
 *
 *  - K1: every `memory:store` publish carries its actor as a value (`publishMemoryStore`), read
 *    from the agent at the publish, and the act's row (`trail`).
 *  - K2: the one subscriber writes a `derived#memory` row before `KnowledgeLayer.store`, outside
 *    the publisher's call slot, from the actor on the message; refused → `store` does not run;
 *    no actor → a line on stderr and `store` runs; the owner leaves no row.
 *  - K3: `memory_update`'s re-extraction, left running, is a `derived#memory_update` write of its
 *    own; no other `void` write is left in the tools.
 *  - K5: the subscribers of `memory:store` and `datastore:insert`, and the callers of
 *    `KnowledgeLayer.store`, are closed sets.
 *  - B1: a mandate's upload archives nothing. B4: the counts say what is NEW.
 *
 * The turn-end writes (K4) are in `capture-trail.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('../tools/permission-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/permission-guard.js')>()),
  isDangerous: vi.fn().mockReturnValue(null),
  isDangerousDetailed: vi.fn().mockReturnValue(null),
}));
// The knowledge layer's extraction, for the counting tests below: no model call.
const mock = vi.hoisted(() => ({ extraction: { entities: [], relations: [] } as import('./entity-extractor.js').ExtractionResult }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});
vi.mock('./contradiction-detector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contradiction-detector.js')>();
  return { ...actual, detectContradictions: vi.fn(async () => []) };
});

import { testAuditLog, type TestAuditLog } from '../../tests/helpers/audit-log.js';
import { Agent } from './agent.js';
import { INSTANCE_WRITE_UNRECORDED } from './audit-log.js';
import { createToolContext } from './tool-context.js';
import { channels, publishMemoryStore } from './observability.js';
import { derivedStoreCounts, setupMemoryStoreSubscription } from './engine-init.js';
import { inCallSlot, runInCallSlot, type CallSlot } from './call-connection.js';
import { InstanceWriteUnrecorded, withInstanceWriteAs } from './instance-trail.js';
import { DERIVED_WRITE_SITES } from './mandate-tool-lock.js';
import { CP_ADMIN_PRINCIPAL, OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import { ingestDocumentText, type DocumentMemorySink } from './document-ingest.js';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';
import { memoryStoreTool, memoryUpdateTool } from '../tools/builtin/memory.js';
import type { KnowledgeStoreResult, MemoryScopeRef, ToolEntry } from '../types/index.js';

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', mandateId: 'M-1' };
const SRC = resolve(__dirname, '..');

// ── the subscriber, over a stand-in knowledge layer ───────────────────────────────────────────

interface StoreCall { content: string; attemptBefore: boolean; inSlot: boolean }
const kl = {
  log: null as TestAuditLog | null,
  calls: [] as StoreCall[],
  moved: [] as Array<{ ids: string[]; successor: string }>,
  result: null as KnowledgeStoreResult | null,
};
const stored = (over: Partial<KnowledgeStoreResult> = {}): KnowledgeStoreResult => ({
  memoryId: 'abcd1234-0000-4000-8000-0000000000aa', entities: [], relations: [], contradictions: [],
  stored: true, deduplicated: false, created: { entities: 0, relations: 0, subjects: 0 }, ...over,
});
const fakeLayer = {
  // What `store` sees at its first line, before its first change: the derived attempt row, and
  // whether it runs inside any call's slot.
  store: async (content: string): Promise<KnowledgeStoreResult> => {
    const rows = kl.log?.rows() ?? [];
    kl.calls.push({ content, attemptBefore: rows.some(r => r.action === 'instance:derived#memory:create' && r.phase === 'attempt'), inSlot: inCallSlot() });
    return kl.result ?? stored();
  },
  markMoved: (ids: string[], successor: string): void => { kl.moved.push({ ids, successor }); },
} as unknown as KnowledgeLayer;
// One subscriber for the file (the channel offers no unsubscribe), reading the current log.
setupMemoryStoreSubscription(fakeLayer, null, null, 'proj-1', () => false, () => kl.log?.log ?? null);

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 30));
const derivedRows = (log: TestAuditLog, site = 'derived#memory') => log.rows().filter(r => r.action.startsWith(`instance:${site}:`));
/** A log that refuses the rows of `site`: the insert throws, as on a full disk. */
function refusing(site: string): TestAuditLog {
  const log = testAuditLog();
  log.db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON audit_log WHEN NEW.action LIKE 'instance:${site}:%' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
  return log;
}

let stderr: ReturnType<typeof vi.spyOn>;
const stderrText = (): string => stderr.mock.calls.map(c => String(c[0])).join('');
beforeEach(() => {
  kl.calls = []; kl.moved = []; kl.result = null; kl.log = testAuditLog();
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { stderr.mockRestore(); });

const memoryMock = (over: Record<string, unknown> = {}): object => ({
  load: vi.fn(async () => ''), loadScoped: vi.fn(async () => ''), append: vi.fn(async () => true), appendScoped: vi.fn(async () => true),
  delete: vi.fn(async () => 0), deleteScoped: vi.fn(async () => 0), update: vi.fn(async () => false), updateScoped: vi.fn(async () => false),
  render: vi.fn(() => ''), ...over,
});

/** One call of `tool` through the agent's real dispatch, as `principal`. */
async function dispatch(tool: ToolEntry, input: Record<string, unknown>, opts: { principal: RequestPrincipal; log: TestAuditLog; memory?: object; knowledgeLayer?: object; lockAside?: boolean }): Promise<string> {
  const toolContext = createToolContext({} as never);
  toolContext.auditLog = opts.log.log;
  if (opts.knowledgeLayer) (toolContext as unknown as Record<string, unknown>)['knowledgeLayer'] = opts.knowledgeLayer;
  const agent = new Agent({
    name: 'test', model: 'claude-sonnet-4-6', tools: [tool], toolContext, principal: opts.principal, currentRunId: 'run-1',
    ...(opts.memory ? { memory: opts.memory as never } : {}),
  });
  // `memory_update` is a pattern writer the lock holds back from a mandate; its block is proven
  // with the lock set aside, as in `mandate-inside-writes.test.ts`.
  if (opts.lockAside) (agent as unknown as { _toolLock: ReadonlySet<string> | null })._toolLock = null;
  const result = await (agent as unknown as { _executeOneInner(tc: unknown): Promise<{ content: unknown }> })
    ._executeOneInner({ type: 'tool_use', id: 'tu_1', name: tool.definition.name, input });
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

// ── K1 / K2 ────────────────────────────────────────────────────────────────────────────────────

describe('a mandate\'s memory_store: the derived entry is written under the mandate, after its own row', () => {
  it('the publish carries the agent\'s principal, and the derived row names the act\'s row', async () => {
    const log = kl.log!;
    await dispatch(memoryStoreTool as ToolEntry, { namespace: 'knowledge', content: 'ACME renews in March' }, { principal: MANDATE, log, memory: memoryMock() });
    await settle();
    const act = log.rows().find(r => r.action === 'instance:memory_store#create:create' && r.phase === 'attempt');
    expect(act).toBeDefined();
    const derived = derivedRows(log);
    expect(derived.map(r => r.phase)).toEqual(['attempt', 'returned']);
    for (const r of derived) {
      expect(r.actor_kind).toBe('mandate');
      expect(r.actor_email).toBe('setup@example.org');
      expect(r.run_id).toBe('run-1');
    }
    // A pair's value is escaped in the row (`namedTarget`): `#` reads `%23`.
    expect(derived[0]!.target).toBe(`knowledge from=memory_store%23create ref=${act!.correlation_id}`);
    expect(kl.calls).toHaveLength(1);
  });

  it('the row is in the log before store makes its first change, and store runs outside the call\'s slot', async () => {
    await dispatch(memoryStoreTool as ToolEntry, { namespace: 'knowledge', content: 'ACME renews in March' }, { principal: MANDATE, log: kl.log!, memory: memoryMock() });
    await settle();
    expect(kl.calls).toEqual([{ content: 'ACME renews in March', attemptBefore: true, inSlot: false }]);
  });

  it('B2: the derived row refused inside the open memory_store — the tool is not refused, its row returned, store not run', async () => {
    const log = refusing('derived#memory');
    kl.log = log;
    const text = await dispatch(memoryStoreTool as ToolEntry, { namespace: 'knowledge', content: 'ACME renews in March' }, { principal: MANDATE, log, memory: memoryMock() });
    await settle();
    expect(text).not.toContain(INSTANCE_WRITE_UNRECORDED);
    expect(text).toContain('Stored in knowledge');
    expect(log.rows().filter(r => r.action === 'instance:memory_store#create:create').map(r => r.phase)).toEqual(['attempt', 'returned']);
    expect(kl.calls).toEqual([]);
    expect(stderrText()).toContain('[lynox:trail] derived knowledge write refused: its row could not be written (knowledge)');
  });

  it('fail-closed: a log that cannot take the derived row keeps store from running', async () => {
    const log = refusing('derived#memory');
    kl.log = log;
    publishMemoryStore({ namespace: 'knowledge', content: 'ACME renews in March', actor: { principal: MANDATE, runId: 'run-1' } });
    await settle();
    expect(kl.calls).toEqual([]);
    expect(derivedRows(log)).toEqual([]);
  });

  it('a publish from a slot that is already refused: the derived row is its own, and written', async () => {
    const other = testAuditLog();
    runInCallSlot({ instanceRefused: true, instanceTrail: { log: other.log, principal: MANDATE, runId: 'run-0', tool: 'memory_store' } }, () => {
      publishMemoryStore({ namespace: 'knowledge', content: 'ACME renews in March', actor: { principal: MANDATE, runId: 'run-1' }, trail: { site: 'memory_store#create', correlationId: 'c-1' } });
    });
    await settle();
    expect(derivedRows(kl.log!).map(r => r.phase)).toEqual(['attempt', 'returned']);
    expect(derivedRows(kl.log!)[0]!.run_id).toBe('run-1');
    expect(other.rows()).toEqual([]);
    expect(kl.calls).toHaveLength(1);
  });

  it('a refusal of withInstanceWriteAs inside a call\'s slot leaves that slot unpoisoned', () => {
    const slot: CallSlot = {};
    let ran = false;
    runInCallSlot(slot, () => {
      expect(() => withInstanceWriteAs({ principal: MANDATE, runId: 'run-1' }, refusing('derived#memory').log, { site: 'derived#memory', kind: 'create', store: 'knowledge' }, () => { ran = true; })).toThrow(InstanceWriteUnrecorded);
    });
    expect(ran).toBe(false);
    expect(slot.instanceRefused).toBeUndefined();
  });

  it('withInstanceWriteAs inside a slot that is refused and belongs to the owner: neither is read, its row is written', () => {
    // The subscriber leaves the slot first (`runOutsideCallSlot`); this holds the wrapper itself
    // to the same rule, so neither guard stands in for the other.
    let ran = false;
    runInCallSlot({ instanceRefused: true, instanceTrail: 'exempt' }, () => {
      withInstanceWriteAs({ principal: MANDATE, runId: 'run-1' }, kl.log!.log, { site: 'derived#memory', kind: 'create', store: 'knowledge' }, () => { ran = true; });
    });
    expect(ran).toBe(true);
    expect(derivedRows(kl.log!).map(r => [r.phase, r.actor_kind])).toEqual([['attempt', 'mandate'], ['returned', 'mandate']]);
  });

  it('the outcome row counts what is new, never names it: entities, relations, subjects, dedup', async () => {
    kl.result = stored({ created: { entities: 3, relations: 2, subjects: 1 } });
    publishMemoryStore({ namespace: 'knowledge', content: 'ACME renews in March', actor: { principal: MANDATE, runId: 'run-1' } });
    await settle();
    const out = derivedRows(kl.log!).find(r => r.phase === 'returned')!;
    expect(out.target).toBe('knowledge wrote=all new_entities=3 new_relations=2 new_subjects=1');
    kl.log = testAuditLog();
    kl.result = stored({ stored: false, deduplicated: true });
    publishMemoryStore({ namespace: 'knowledge', content: 'ACME renews in March', actor: { principal: MANDATE, runId: 'run-1' } });
    await settle();
    expect(derivedRows(kl.log).find(r => r.phase === 'returned')!.target).toBe('knowledge new_entities=0 new_relations=0 new_subjects=0 dedup=1');
  });

  it('a forged act: a site off the list and a ref not shaped like a row id are left out of the row', async () => {
    publishMemoryStore({ namespace: 'knowledge', content: 'forged', actor: { principal: MANDATE, runId: 'run-1' },
      trail: { site: 'memory_store#create x=1' as never, correlationId: 'not-a-row ref=planted' } });
    publishMemoryStore({ namespace: 'knowledge', content: 'genuine', actor: { principal: MANDATE, runId: 'run-1' },
      trail: { site: 'memory_store#create', correlationId: 'abcd1234-0000-4000-8000-000000000001' } });
    await settle();
    const attempts = derivedRows(kl.log!).filter(r => r.phase === 'attempt').map(r => r.target);
    expect(attempts).toEqual(['knowledge', 'knowledge from=memory_store%23create ref=abcd1234-0000-4000-8000-000000000001']);
    expect(kl.calls.map(c => c.content)).toEqual(['forged', 'genuine']);
  });

  it('a move: naming the copy the successor is a step of the same derived write', async () => {
    publishMemoryStore({ namespace: 'methods', content: 'x line', replaces: { ids: ['old-1'] }, actor: { principal: MANDATE, runId: 'run-1' } });
    await settle();
    expect(kl.moved).toEqual([{ ids: ['old-1'], successor: 'abcd1234-0000-4000-8000-0000000000aa' }]);
    expect(derivedRows(kl.log!).map(r => r.phase)).toEqual(['attempt', 'returned']);
  });

  it('no actor on the message: a line on stderr, and the entry is written as before', async () => {
    channels.memoryStore.publish({ namespace: 'knowledge', content: 'raw without actor' });
    publishMemoryStore({ namespace: 'learnings', content: 'null actor', actor: null });
    await settle();
    expect(kl.calls.map(c => c.content).sort()).toEqual(['null actor', 'raw without actor']);
    expect(stderrText()).toContain('[lynox:trail] derived knowledge write without an actor (knowledge)');
    expect(stderrText()).toContain('[lynox:trail] derived knowledge write without an actor (learnings)');
    expect(kl.log!.rows()).toEqual([]);
  });

  it('the owner: no row, store runs', async () => {
    await dispatch(memoryStoreTool as ToolEntry, { namespace: 'knowledge', content: 'ACME renews in March' }, { principal: OWNER_PRINCIPAL, log: kl.log!, memory: memoryMock() });
    publishMemoryStore({ namespace: 'knowledge', content: 'direct', actor: { principal: OWNER_PRINCIPAL, runId: undefined } });
    await settle();
    expect(kl.log!.rows()).toEqual([]);
    expect(kl.calls.map(c => c.content)).toEqual(['ACME renews in March', 'direct']);
  });
});

// ── K3 / B5 ────────────────────────────────────────────────────────────────────────────────────

describe('memory_update#exact: the re-extraction left running is a derived write of its own', () => {
  function updateKg(changed: boolean): { obj: object; calls: Array<{ inSlot: boolean; rowBefore: boolean }>; log: () => TestAuditLog } {
    const calls: Array<{ inSlot: boolean; rowBefore: boolean }> = [];
    return {
      calls,
      log: () => kl.log!,
      obj: {
        updateMemoryText: vi.fn(async () => changed),
        updateMemoryTextReporting: vi.fn(async () => {
          calls.push({ inSlot: inCallSlot(), rowBefore: derivedRows(kl.log!, 'derived#memory_update').some(r => r.phase === 'attempt') });
          return { changed, created: { entities: 2, relations: 0, subjects: 1 } };
        }),
      },
    };
  }
  const input = { namespace: 'knowledge', old_content: 'renews in March', new_content: 'renews in April' };

  it('as a mandate: its row names the act\'s row and the counts, and it runs outside the call\'s slot', async () => {
    const kg = updateKg(true);
    const text = await dispatch(memoryUpdateTool as ToolEntry, input, { principal: MANDATE, log: kl.log!, memory: memoryMock({ update: vi.fn(async () => true) }), knowledgeLayer: kg.obj, lockAside: true });
    await settle();
    expect(text).toContain('Updated content in knowledge');
    const act = kl.log!.rows().find(r => r.action === 'instance:memory_update#exact:change' && r.phase === 'attempt')!;
    const rows = derivedRows(kl.log!, 'derived#memory_update');
    expect(rows.map(r => r.phase)).toEqual(['attempt', 'returned']);
    expect(rows[0]!.actor_kind).toBe('mandate');
    expect(rows[0]!.target).toBe(`knowledge from=memory_update%23exact ref=${act.correlation_id}`);
    expect(rows[1]!.target).toBe(`knowledge wrote=all from=memory_update%23exact ref=${act.correlation_id} changed=1 new_entities=2 new_relations=0 new_subjects=1`);
    expect(kg.calls).toEqual([{ inSlot: false, rowBefore: true }]);
  });

  it('a derived log that refuses: the re-extraction does not run, and the tool is not refused', async () => {
    const log = refusing('derived#memory_update');
    kl.log = log;
    const kg = updateKg(true);
    const text = await dispatch(memoryUpdateTool as ToolEntry, input, { principal: MANDATE, log, memory: memoryMock({ update: vi.fn(async () => true) }), knowledgeLayer: kg.obj, lockAside: true });
    await settle();
    expect(text).toContain('Updated content in knowledge');
    expect(text).not.toContain(INSTANCE_WRITE_UNRECORDED);
    expect(log.rows().filter(r => r.action === 'instance:memory_update#exact:change').map(r => r.phase)).toEqual(['attempt', 'returned']);
    expect(kg.calls).toEqual([]);
    expect(stderrText()).toContain('[lynox:trail] derived knowledge write refused: its row could not be written (memory_update)');
  });

  it('the owner: no row, the re-extraction runs', async () => {
    const kg = updateKg(false);
    await dispatch(memoryUpdateTool as ToolEntry, input, { principal: OWNER_PRINCIPAL, log: kl.log!, memory: memoryMock({ update: vi.fn(async () => true) }), knowledgeLayer: kg.obj });
    await settle();
    expect(kl.log!.rows()).toEqual([]);
    expect(kg.calls).toHaveLength(1);
  });
});

// ── B1: a mandate's upload ─────────────────────────────────────────────────────────────────────

describe('document upload: a mandate archives nothing', () => {
  const scope: MemoryScopeRef = { type: 'context', id: 'p' };
  const sink = (): { sink: DocumentMemorySink; calls: string[] } => {
    const calls: string[] = [];
    return { calls, sink: { store: async (text: string) => { calls.push(text); return stored(); } } as unknown as DocumentMemorySink };
  };
  const params = (principal: RequestPrincipal, durableKnowledgeActive: boolean) => ({
    text: 'A document about ACME and its renewal in March.', fileName: 'a.pdf', scope, threadId: 't-1',
    durableKnowledgeActive, isPrivate: () => false, cutAtExtraction: false, principal,
  });

  it('a mandate with the durable store on: nothing stored', async () => {
    const s = sink();
    expect(await ingestDocumentText(s.sink, params(MANDATE, true))).toBe(0);
    expect(s.calls).toEqual([]);
  });

  it('a mandate with the coupling broken (durable store off): still nothing stored, and said', async () => {
    const s = sink();
    expect(await ingestDocumentText(s.sink, params(MANDATE, false))).toBe(0);
    expect(s.calls).toEqual([]);
    expect(stderrText()).toContain('document archive skipped for a mandate');
  });

  it('the control plane\'s admin and the owner archive as before', async () => {
    for (const p of [CP_ADMIN_PRINCIPAL, OWNER_PRINCIPAL]) {
      const s = sink();
      expect(await ingestDocumentText(s.sink, params(p, false))).toBe(1);
      expect(s.calls).toHaveLength(1);
    }
  });
});

// ── B4: what is new ────────────────────────────────────────────────────────────────────────────

describe('the counts say what a store created, not what it mentioned', () => {
  const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
  const dirs: string[] = [];
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    mock.extraction = { entities: [], relations: [] };
  });
  async function layer(opts: { engine: boolean; reads: boolean }): Promise<KnowledgeLayer> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-660a3-'));
    dirs.push(dir);
    const engine = opts.engine ? new EngineDb(join(dir, 'engine.db'), '') : undefined;
    const l = new KnowledgeLayer(join(dir, 'mem.db'), new LocalProvider(), undefined, undefined, engine, opts.engine, opts.reads);
    await l.init();
    closers.push(async () => { await l.close(); engine?.close(); });
    return l;
  }
  const pair = (r: KnowledgeStoreResult, name: string): unknown => derivedStoreCounts(r).find(p => p[0] === name)?.[1];
  const ALICE = { name: 'Alice Schmidt', type: 'person' as const, confidence: 0.9 };
  const ACME = { name: 'Acme GmbH', type: 'organization' as const, confidence: 0.9 };
  const WORKS = { from: 'Alice Schmidt', to: 'Acme GmbH', relationType: 'works_at', description: '' };

  it('legacy path: one entity already known, one new → new_entities=1 while two are mentioned', async () => {
    const l = await layer({ engine: false, reads: false });
    mock.extraction = { entities: [ALICE], relations: [] };
    const first = await l.store('Alice Schmidt leads the procurement team.', 'knowledge', scope, { sourceChannel: 'agent' });
    expect(pair(first, 'new_entities')).toBe(1);
    mock.extraction = { entities: [ALICE, ACME], relations: [] };
    const second = await l.store('Quarterly budgets are approved in the first week of each new year at Acme GmbH.', 'knowledge', scope, { sourceChannel: 'agent' });
    expect(second.entities).toHaveLength(2);
    expect(pair(second, 'new_entities')).toBe(1);
  });

  it('legacy path: the plain insert of an edge counts as new every time', async () => {
    const l = await layer({ engine: false, reads: false });
    mock.extraction = { entities: [ALICE, ACME], relations: [WORKS] };
    const first = await l.store('Alice Schmidt is the CTO at Acme GmbH since last spring.', 'knowledge', scope, { sourceChannel: 'agent' });
    expect(pair(first, 'new_relations')).toBe(1);
    const second = await l.store('Invoices from Acme GmbH go through Alice Schmidt before payment.', 'knowledge', scope, { sourceChannel: 'agent' });
    expect(pair(second, 'new_relations')).toBe(1);
  });

  it('subject graph (authoritative): the same edge twice → new_relations=1, then 0; subjects only once', async () => {
    const l = await layer({ engine: true, reads: true });
    mock.extraction = { entities: [ALICE, ACME], relations: [WORKS] };
    const first = await l.store('Alice Schmidt is the CTO at Acme GmbH since last spring.', 'knowledge', scope, { sourceChannel: 'agent' });
    expect([pair(first, 'new_relations'), pair(first, 'new_subjects')]).toEqual([1, 2]);
    const second = await l.store('Invoices from Acme GmbH go through Alice Schmidt before payment.', 'knowledge', scope, { sourceChannel: 'agent' });
    expect(second.stored).toBe(true);
    expect([pair(second, 'new_relations'), pair(second, 'new_subjects')]).toEqual([0, 0]);
  });

  it('subject graph mirror (pre-cutover): a subject already known is not new', async () => {
    const l = await layer({ engine: true, reads: false });
    mock.extraction = { entities: [ALICE], relations: [] };
    const first = await l.store('Alice Schmidt leads the procurement team.', 'knowledge', scope, { sourceChannel: 'agent' });
    expect(pair(first, 'new_subjects')).toBe(1);
    mock.extraction = { entities: [ALICE, ACME], relations: [] };
    const second = await l.store('Quarterly budgets are approved in the first week of each new year at Acme GmbH.', 'knowledge', scope, { sourceChannel: 'agent' });
    expect(pair(second, 'new_subjects')).toBe(1);
  });

  it('a text edit counts the entities its re-extraction created', async () => {
    const l = await layer({ engine: false, reads: false });
    mock.extraction = { entities: [ALICE], relations: [] };
    await l.store('Alice Schmidt leads the procurement team.', 'knowledge', scope, { sourceChannel: 'agent' });
    mock.extraction = { entities: [ALICE, ACME], relations: [] };
    const r = await l.updateMemoryTextReporting('leads the procurement team', 'leads the procurement team at Acme GmbH', 'knowledge', scope);
    expect(r).toEqual({ changed: true, created: { entities: 1, relations: 0, subjects: 0 } });
    expect(await l.updateMemoryText('no such text anywhere', 'x', 'knowledge', scope)).toBe(false);
  });

  it('the store\'s own upsert says which call inserted the edge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-660a3-rel-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    closers.push(() => engine.close());
    const subs = new SubjectStore(engine);
    const rels = new RelationshipStore(engine);
    const a = subs.createSubject({ kind: 'person', name: 'Alice' });
    const b = subs.createSubject({ kind: 'organization', name: 'Acme' });
    const first = rels.createRelationshipReporting({ fromSubjectId: a, toSubjectId: b, kind: 'works_at' });
    const again = rels.createRelationshipReporting({ fromSubjectId: a, toSubjectId: b, kind: 'works_at' });
    expect([first.created, again.created]).toEqual([true, false]);
    expect(again.id).toBe(first.id);
    expect(rels.createRelationship({ fromSubjectId: a, toSubjectId: b, kind: 'works_at' })).toBe(first.id);
  });
});

// ── source scans: K1, K3, K5, B1 ───────────────────────────────────────────────────────────────

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...sourceFiles(p)); continue; }
    if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const parse = (file: string, text?: string): ts.SourceFile => ts.createSourceFile(file, text ?? readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const rel = (sf: ts.SourceFile): string => relative(SRC, sf.fileName).split('\\').join('/');
const lineOf = (sf: ts.SourceFile, n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const SOURCES = sourceFiles(SRC).map(f => parse(f));

/** `channels.<name>.publish(` calls, by the property chain, outside the one helper's file. */
function rawPublishes(sf: ts.SourceFile, channel: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'publish') {
      const recv = n.expression.expression;
      if (ts.isPropertyAccessExpression(recv) && recv.name.text === channel) out.push(`${rel(sf)}:${String(lineOf(sf, n))}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every other way to reach the memory:store channel past the helper. Matched by NAME, not by the
 * object it is read from, so a renamed import (`import { channels as ch }`, `obs.channels`) and a
 * destructuring (`const { memoryStore } = channels`, also by assignment) are found as well: a
 * `.memoryStore`, a `['memoryStore']` (quoted, template or computed), a binding or an object
 * property of that name, and the channel's name `lynox:memory:store` in any string or template
 * literal. A listener's `.subscribe(` is the one use let through. Each finding is
 * `<file>:<line> <form>`.
 *
 * What this cannot see, a named limit: a reach with no name in it at all — the channel's name built
 * at run time (a concatenation, a constant from another file), and the channels read wholesale
 * (`Object.values(channels)`, a spread, `for…in`). Those are left to review.
 */
function memoryStoreReach(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const at = (n: ts.Node, form: string): void => { out.push(`${rel(sf)}:${String(lineOf(sf, n))} ${form}`); };
  const isName = (n: ts.Node | undefined): boolean => {
    if (n === undefined) return false;
    const inner = ts.isComputedPropertyName(n) ? n.expression : n;
    return (ts.isIdentifier(inner) || ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) && inner.text === 'memoryStore';
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === 'lynox:memory:store') {
      // A listed listener may name the channel it formats, as a map key or a `case` label, and
      // nowhere else: a name held in a variable, or wrapped in a call, can open the channel and
      // publish past the helper.
      const p = n.parent;
      const labelOnly = (ts.isPropertyAssignment(p) && p.name === n) || (ts.isCaseClause(p) && p.expression === n);
      if (!labelOnly || !Object.hasOwn(LISTENERS['memoryStore']!, rel(sf))) at(n, "'lynox:memory:store'");
    }
    if (ts.isElementAccessExpression(n) && isName(n.argumentExpression)) at(n, "['memoryStore']");
    if (ts.isBindingElement(n) && isName(n.propertyName ?? n.name)) at(n, '{ memoryStore }');
    if ((ts.isShorthandPropertyAssignment(n) || ts.isPropertyAssignment(n)) && isName(n.name)) at(n, '{ memoryStore }');
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'memoryStore') {
      const up = n.parent;
      const use = ts.isPropertyAccessExpression(up) && up.expression === n ? up.name.text : null;
      const listener = use === 'subscribe' && Object.hasOwn(LISTENERS['memoryStore']!, rel(sf));
      if (!listener) at(n, `.memoryStore${use !== null ? `.${use}` : ''}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('K1: every memory:store publish goes through publishMemoryStore', () => {
  it('no raw publish outside observability.ts', () => {
    const raw = SOURCES.filter(sf => rel(sf) !== 'core/observability.ts').flatMap(sf => rawPublishes(sf, 'memoryStore'));
    expect(raw).toEqual([]);
  });

  it('no other way to the channel outside observability.ts: by name, by key, by alias, renamed or destructured (listeners\' subscribe excepted)', () => {
    expect(SOURCES.filter(sf => rel(sf) !== 'core/observability.ts').flatMap(memoryStoreReach)).toEqual([]);
  });

  it('the reach scan sees each form, and lets a listed listener subscribe (planted)', () => {
    const planted = parse(join(SRC, 'core/planted.ts'), `
      const a = channel('lynox:memory:store');
      const b = channels['memoryStore'];
      const c = channels.memoryStore;
      let d; d = channels.memoryStore;
      channels.memoryStore.subscribe(fn);
      const e = obs.channels.memoryStore;
      const f = ch.memoryStore;
      const { memoryStore } = channels;
      const { memoryStore: g } = obs.channels;
      const h = tracingChannel(\`lynox:memory:store\`);
      const i = channels[\`memoryStore\`];
      const { ['memoryStore']: j } = channels;
      let k; ({ memoryStore: k } = channels);
      channel('lynox:datastore:insert'); channels.dataStoreInsert; const { dataStoreInsert } = channels;
    `);
    expect(memoryStoreReach(planted).map(f => f.split(' ').slice(1).join(' '))).toEqual([
      "'lynox:memory:store'", "['memoryStore']", '.memoryStore', '.memoryStore', '.memoryStore.subscribe',
      '.memoryStore', '.memoryStore', '{ memoryStore }', '{ memoryStore }', "'lynox:memory:store'",
      "['memoryStore']", '{ memoryStore }', '{ memoryStore }',
    ]);
    expect(memoryStoreReach(parse(join(SRC, 'core/engine-init.ts'), 'channels.memoryStore.subscribe(fn);'))).toEqual([]);
    // A listed listener may name the channel as a key or a label, nowhere else: not as a call's
    // argument, not held in a variable it can open later, not wrapped.
    const listener = parse(join(SRC, 'core/debug-subscriber.ts'), `
      const groups = { 'lynox:memory:store': 'memory' };
      switch (name) { case 'lynox:memory:store': break; }
      channel('lynox:memory:store').publish(x);
      const N = 'lynox:memory:store'; channel(N).publish(x);
      channel(('lynox:memory:store' as string));
    `);
    expect(memoryStoreReach(listener).map(f => f.split(' ').slice(1).join(' '))).toEqual([
      "'lynox:memory:store'", "'lynox:memory:store'", "'lynox:memory:store'",
    ]);
  });

  it('the six publishers use the helper (positive control), and the scan sees a raw one (planted)', () => {
    const helperCalls = SOURCES.flatMap(sf => {
      const out: string[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'publishMemoryStore') out.push(rel(sf));
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return out;
    });
    expect(helperCalls.sort()).toEqual(['core/memory.ts', 'core/memory.ts', 'tools/builtin/memory.ts', 'tools/builtin/memory.ts', 'tools/builtin/memory.ts', 'tools/builtin/memory.ts']);
    expect(rawPublishes(parse(join(SRC, 'planted.ts'), 'channels.memoryStore.publish({ namespace: "k" }); a.memoryStore.publish(x); channels.other.publish(y);'), 'memoryStore')).toHaveLength(2);
  });
});

/**
 * K5: who listens on the two channels whose publishers name no write of their own. A listener
 * that writes needs the publisher to carry `actor` (memory:store does; datastore:insert has no
 * writing listener, so it does not). Found by: `channels.<x>.subscribe(`, a `subscribe(` whose
 * first argument names the channel or an array holding its name, and a loop over every channel
 * (`Object.entries(channels)`), which subscribes to both.
 */
const CHANNEL_NAMES: Readonly<Record<string, string>> = { memoryStore: 'lynox:memory:store', dataStoreInsert: 'lynox:datastore:insert' };
function subscribersOf(sf: ts.SourceFile, key: string): string[] {
  const name = CHANNEL_NAMES[key]!;
  const out = new Set<string>();
  const namesIt = (e: ts.Node | undefined): boolean => e !== undefined && (
    (ts.isStringLiteral(e) && e.text === name)
    || (ts.isIdentifier(e) && sf.text.includes(`'${name}'`))
    || (ts.isArrayLiteralExpression(e) && e.elements.some(x => ts.isStringLiteral(x) && x.text === name)));
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isPropertyAccessExpression(e) && e.name.text === 'subscribe' && ts.isPropertyAccessExpression(e.expression)
        && e.expression.name.text === key) out.add(rel(sf));
      if (ts.isIdentifier(e) && e.text === 'subscribe' && namesIt(n.arguments[0])) out.add(rel(sf));
      // `Object.entries(channels)` / `Object.values(channels)`: every channel, these two included.
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Object'
        && (e.name.text === 'entries' || e.name.text === 'values') && n.arguments[0] !== undefined && ts.isIdentifier(n.arguments[0]) && n.arguments[0].text === 'channels') out.add(rel(sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...out];
}

/** The listeners, each with what it does with a message. None but the first writes a store. */
const LISTENERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  memoryStore: {
    'core/engine-init.ts': 'writes the derived knowledge entry, under the actor on the message, with its own row',
    'core/debug-subscriber.ts': 'prints a line per message to the debug log when LYNOX_DEBUG is set; writes no store',
  },
  dataStoreInsert: {
    'core/transcribe/glossary/session-builder.ts': 'invalidates the glossary cache; writes no store',
    'core/debug-subscriber.ts': 'subscribes to every channel in the debug groups; datastore:insert is in none, and it writes no store',
  },
};

describe('K5: the listeners of memory:store and datastore:insert are a closed set', () => {
  for (const key of Object.keys(CHANNEL_NAMES)) {
    it(`${key}: every listener is on the list with what it does, and the list holds nothing gone`, () => {
      const found = SOURCES.flatMap(sf => subscribersOf(sf, key)).sort();
      expect(found, 'a new listener: does it write? then its publisher must carry `actor`').toEqual(Object.keys(LISTENERS[key]!).sort());
    });
  }

  it('the scan sees each way of listening (planted)', () => {
    const planted = parse(join(SRC, 'core/planted.ts'), `
      channels.memoryStore.subscribe(fn);
      subscribe('lynox:datastore:insert', fn);
      for (const [k, ch] of Object.entries(channels)) ch.subscribe(fn);
    `);
    expect(subscribersOf(planted, 'memoryStore')).toEqual(['core/planted.ts']);
    expect(subscribersOf(parse(join(SRC, 'core/a.ts'), "subscribe('lynox:datastore:insert', fn);"), 'dataStoreInsert')).toEqual(['core/a.ts']);
    expect(subscribersOf(parse(join(SRC, 'core/b.ts'), 'channels.dataStoreInsert.subscribe(fn);'), 'memoryStore')).toEqual([]);
  });
});

/** B1: the callers of `KnowledgeLayer.store` — any `.store(` call in the engine's source. */
function storeCallers(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'store') out.push(rel(sf));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const STORE_CALLERS: Readonly<Record<string, string>> = {
  'core/engine-init.ts': 'the memory:store subscriber, inside derived#memory',
  'core/memory-facade.ts': 'the owner\'s web UI (ownerOnly routes)',
  'core/document-ingest.ts': 'the upload archive, which a mandate never reaches (it returns 0 for one)',
};

describe('B1: the callers of KnowledgeLayer.store are a closed set', () => {
  it('each caller is on the list with why it needs no row of its own', () => {
    expect(SOURCES.flatMap(storeCallers).sort()).toEqual(Object.keys(STORE_CALLERS).sort());
    expect(storeCallers(parse(join(SRC, 'core/x.ts'), 'void kl.store(t); store(t); a.storeX(t);'))).toEqual(['core/x.ts']);
  });
});

/**
 * K3 / B5′: no write in the tools is left running after the handler (`void <x>.store…(` and the
 * other write verbs), unless it runs as `runOutsideCallSlot(() => withInstanceWriteAs(…))` — the
 * wrapper is what is checked, not a list of lines. A floating `<x>.<verb>…(…).catch(` with no
 * `void` is the same thing left running, and is found too. The voids that write telemetry are free
 * functions, not a store's method; they are listed with their reason.
 *
 * What it does NOT see, and does not claim to: a write left running without `void` and without a
 * chained `.catch/.then/.finally` (a bare `kg.eraseAll(p);` statement), a promise assigned and never
 * awaited, a write scheduled through a timer, a callee read by key (`void kg['storeX'](…)`), a
 * write inside a `void` immediately-invoked function, and a callee not in camelCase (`store2`,
 * `upsert_x`). Those are left to review.
 *
 * The verb is the whole camelCase head of the callee (`setFlag`, `set`), never a prefix of a longer
 * word (`settle`, `setup`); the timer functions, whose head is a write verb, are not writes.
 */
const WRITE_VERB = /^(store|write|update|delete|deactivate|append|insert|mark|retire|erase|create|set|upsert|link|merge)(?=$|[A-Z])/;
const NOT_WRITES: ReadonlySet<string> = new Set(['setTimeout', 'setInterval', 'setImmediate']);
interface VoidWrite { at: string; callee: string; wrapped: boolean }
function voidWrites(sf: ts.SourceFile): VoidWrite[] {
  const out: VoidWrite[] = [];
  /** The callee of the call a void runs, through `.catch`/`.then`/`.finally`. */
  const innermost = (e: ts.Expression): ts.CallExpression | undefined => {
    let cur: ts.Expression = e;
    while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    if (!ts.isCallExpression(cur)) return undefined;
    const c = cur.expression;
    if (ts.isPropertyAccessExpression(c) && ['catch', 'then', 'finally'].includes(c.name.text)) return innermost(c.expression);
    return cur;
  };
  /** Inside `runOutsideCallSlot(() => withInstanceWriteAs(…))` (the arrow may be async). */
  const wrapped = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent) {
      if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'runOutsideCallSlot') {
        const fn = p.arguments[0];
        if (fn !== undefined && ts.isArrowFunction(fn) && ts.isCallExpression(fn.body) && ts.isIdentifier(fn.body.expression) && fn.body.expression.text === 'withInstanceWriteAs') return true;
      }
    }
    return false;
  };
  /** A statement that is only `<call>.catch(…)` (or `.then`/`.finally`): a promise left floating. */
  const floating = (n: ts.Node): ts.Expression | undefined => {
    if (!ts.isExpressionStatement(n)) return undefined;
    let e: ts.Expression = n.expression;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ['catch', 'then', 'finally'].includes(e.expression.name.text) ? e : undefined;
  };
  const visit = (n: ts.Node): void => {
    const left = ts.isVoidExpression(n) ? n.expression : floating(n);
    if (left !== undefined) {
      const call = innermost(left);
      const callee = call === undefined ? undefined
        : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text
          : ts.isIdentifier(call.expression) ? call.expression.text : undefined;
      if (callee !== undefined && ((WRITE_VERB.test(callee) && !NOT_WRITES.has(callee)) || callee === 'runOutsideCallSlot')) {
        const inner = callee === 'runOutsideCallSlot' ? call!.arguments[0] : call;
        const isWrapped = callee === 'runOutsideCallSlot'
          ? inner !== undefined && ts.isArrowFunction(inner) && ts.isCallExpression(inner.body) && ts.isIdentifier(inner.body.expression) && inner.body.expression.text === 'withInstanceWriteAs'
          : wrapped(n);
        out.push({ at: `${rel(sf)}:${String(lineOf(sf, n))}`, callee, wrapped: isWrapped });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
/** `<file>|<callee>` → why it is no entry. */
const TELEMETRY_VOIDS: Readonly<Record<string, string>> = {
  'tools/builtin/knowledge.ts|appendUntrustedCauseLog': 'the untrusted-cause measurement file, not an entry',
  'tools/builtin/knowledge.ts|appendCaptureTelemetry': 'the capture telemetry file, not an entry',
  'tools/builtin/memory.ts|appendUntrustedCauseLog': 'the untrusted-cause measurement file, not an entry',
};

describe('K3: no write left running after a tool\'s handler, outside a derived write', () => {
  const builtin = SOURCES.filter(sf => rel(sf).startsWith('tools/builtin/'));
  const found = builtin.flatMap(voidWrites);

  it('every void write is a derived write, or telemetry with its reason', () => {
    const bad = found.filter(v => !v.wrapped && TELEMETRY_VOIDS[`${v.at.split(':')[0]}|${v.callee}`] === undefined);
    expect(bad).toEqual([]);
  });

  it('finds the one derived write and the telemetry (positive control), and lists nothing gone', () => {
    expect(found.filter(v => v.wrapped).map(v => v.at.split(':')[0])).toEqual(['tools/builtin/memory.ts']);
    const seen = new Set(found.map(v => `${v.at.split(':')[0]}|${v.callee}`));
    expect(Object.keys(TELEMETRY_VOIDS).filter(k => !seen.has(k))).toEqual([]);
  });

  it('the scan sees a void or chained write, through .catch and across lines, and the wrapper; not a bare call, not a timer (planted)', () => {
    const planted = parse(join(SRC, 'tools/builtin/planted.ts'), `
      void agent.toolContext.knowledgeLayer.updateMemoryText(a, b).catch(() => {});
      void
        kg.storeThing(x);
      void runOutsideCallSlot(async () => withInstanceWriteAs(actor, log, spec, (w) => w.run('u', () => kg.update(), ifTrue)));
      void runOutsideCallSlot(() => kg.update());
      void appendTelemetry(x);
      void deps.streamHandler(e);
      kg.retireForMove(p).catch(() => {});
      (store.upsertThing(x)).then(() => 1);
      kg.eraseAll(p);
      void kg.mergeEntities(a, b); void kg.linkSubjects(a); void kg.setFlag(a); void kg.createX(a);
      void setTimeout(fn, 1); void settle(x); void kg.setup(); void kg.created(); void kg.storedCount();
    `);
    expect(voidWrites(planted).map(v => `${v.callee}:${String(v.wrapped)}`)).toEqual([
      'updateMemoryText:false', 'storeThing:false', 'runOutsideCallSlot:true', 'runOutsideCallSlot:false', 'appendTelemetry:false',
      'retireForMove:false', 'upsertThing:false', 'mergeEntities:false', 'linkSubjects:false', 'setFlag:false', 'createX:false',
    ]);
  });
});

// ── the derived sites have their fixtures ─────────────────────────────────────────────────────

describe('every derived site is exercised by a test that reads its rows', () => {
  it('each DERIVED_WRITE_SITES entry is named as a site literal in this file or capture-trail.test.ts', () => {
    const texts = ['core/instance-trail-derived.test.ts', 'core/capture-trail.test.ts'].map(f => readFileSync(join(SRC, f), 'utf8')).join('\n');
    // The tests read a site's rows by its literal (`rowsOf(log, '<site>')`, `derivedRows(…)`).
    const missing = DERIVED_WRITE_SITES.filter(s => !texts.includes(`'${s}'`) && !texts.includes(`instance:${s}:`));
    expect(missing).toEqual([]);
  });
});
