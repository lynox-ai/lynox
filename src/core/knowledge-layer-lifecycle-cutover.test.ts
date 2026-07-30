import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryScopeRef } from '../types/index.js';
import type { ExtractionResult } from './entity-extractor.js';

/**
 * S5b'-c: the memory LIFECYCLE port + metrics relocation.
 *
 * Part A (flag-gated on the MIRROR flag `subjectGraphEnabled`, NOT reads): a thread
 * purge and a dead-stub GC reap the engine.db stub store too — the authoritative recall
 * store under the cutover — so purged (privacy) statement text and superseded stubs don't
 * linger there. Purge uses the id-parity BRIDGE (legacy owns source_thread_id; the stub
 * shares the legacy memory id). Both delete `memories` rows only — a cross-thread SUBJECT
 * survives (durable substrate; Fork 1 = purge stubs-only).
 *
 * Part B (unconditional): the KPI `metrics` table moved agent-memory.db → history.db.
 *
 * Extraction is mocked (no LLM); with no anthropicClient store() takes the V1 path.
 */
const mock = vi.hoisted(() => ({ extraction: { entities: [], relations: [] } as ExtractionResult }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});

import { KnowledgeLayer } from './knowledge-layer.js';
import { RunHistory } from './run-history.js';
import { KpiEngine } from './kpi-engine.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';

/** A memory that mentions Acme Studio → one org subject per stored memory (dedup by name). */
const ACME: ExtractionResult = {
  entities: [{ name: 'Acme Studio', type: 'organization', confidence: 0.9 }],
  relations: [],
};

describe("KnowledgeLayer lifecycle cutover (S5b'-c)", () => {
  const provider = new LocalProvider();
  const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  const layers: KnowledgeLayer[] = [];
  const histories: RunHistory[] = [];

  function tmp(prefix = 'lynox-s5bpc-'): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  /** A KnowledgeLayer with an engine.db mirror. reads OFF by default — purge/gc must
   *  still reap stubs (the mirror-flag gate), which is the point of the slice. */
  async function newLayer(
    opts: { subjectGraph: boolean; runHistory?: RunHistory | undefined },
  ): Promise<{ layer: KnowledgeLayer; engine: EngineDb; dir: string }> {
    const dir = tmp();
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-s5bpc');
    engines.push(engine);
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), provider, undefined, opts.runHistory,
      engine, opts.subjectGraph, false,
    );
    layers.push(layer);
    await layer.init();
    return { layer, engine, dir };
  }

  afterEach(async () => {
    for (const l of layers) { try { await l.close(); } catch { /* already closed */ } }
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const h of histories) { try { h.close(); } catch { /* already closed */ } }
    layers.length = 0; engines.length = 0; histories.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    mock.extraction = { entities: [], relations: [] };
    vi.clearAllMocks();
  });

  // ── Part A: purge (id-parity bridge) ──────────────────────────

  it('purgeThread reaps the thread\'s engine.db stubs (id-parity), leaves other threads', async () => {
    const { layer, engine } = await newLayer({ subjectGraph: true });
    const graph = new MemoryGraphStore(engine);

    const a1 = await layer.store('fact one', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    const a2 = await layer.store('fact two', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    const b1 = await layer.store('fact three', 'knowledge', scope, { sourceThreadId: 'thread-B' });

    // All three stubs mirrored to engine.db (mirror writes even a subject-less stub).
    expect(graph.getStub(a1.memoryId)).not.toBeNull();
    expect(graph.getStub(a2.memoryId)).not.toBeNull();
    expect(graph.getStub(b1.memoryId)).not.toBeNull();

    const purged = layer.purgeThread('thread-A');
    expect(purged).toBe(2); // legacy count

    // thread-A's stubs are gone from the recall store; thread-B's survives.
    expect(graph.getStub(a1.memoryId)).toBeNull();
    expect(graph.getStub(a2.memoryId)).toBeNull();
    expect(graph.getStub(b1.memoryId)).not.toBeNull();
    // legacy is purged too (the thread has no ids left).
    expect(layer.getDb().getMemoryIdsByThread('thread-A')).toEqual([]);
  });

  it('purge is stubs-only: deletes NO subject — not the cross-thread one, not even an orphaned one', async () => {
    const { layer, engine } = await newLayer({ subjectGraph: true });
    const subjects = new SubjectStore(engine);
    const graph = new MemoryGraphStore(engine);

    // Acme is mentioned in BOTH threads (findOrCreate dedups → one subject linked by both).
    mock.extraction = ACME;
    const a1 = await layer.store('Acme Studio signed on Monday.', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    const b = await layer.store('Acme Studio paid the invoice.', 'knowledge', scope, { sourceThreadId: 'thread-B' });
    // Solo Corp is mentioned ONLY in thread-A → purging thread-A orphans it.
    mock.extraction = { entities: [{ name: 'Solo Corp', type: 'organization', confidence: 0.9 }], relations: [] };
    const a2 = await layer.store('Solo Corp churned this week.', 'knowledge', scope, { sourceThreadId: 'thread-A' });

    const acmeId = subjects.findCanonical('Acme Studio', 'organization')?.id;
    const soloId = subjects.findCanonical('Solo Corp', 'organization')?.id;
    expect(acmeId && soloId).toBeTruthy();
    expect(subjects.count()).toBe(2);

    layer.purgeThread('thread-A');

    // Stubs-only: BOTH subjects survive — the cross-thread one (still linked by thread-B)
    // AND the now-orphaned one (purge never reaps subjects; the orphan sweep is deferred).
    expect(subjects.count()).toBe(2);
    expect(subjects.getSubject(acmeId!)).not.toBeNull();
    expect(subjects.getSubject(soloId!)).not.toBeNull();
    // thread-A's stubs are gone; thread-B's stub + its Acme link remain.
    expect(graph.getStub(a1.memoryId)).toBeNull();
    expect(graph.getStub(a2.memoryId)).toBeNull();
    expect(graph.getStub(b.memoryId)).not.toBeNull();
    expect(graph.getLinkedSubjectIds(b.memoryId)).toContain(acmeId);
  });

  it('purgeThread reaps a durable engine.db stub even with the mirror flag OFF (no resurrection on re-flip)', async () => {
    // subjectGraph OFF → store() writes no stub; but a stub written during an
    // EARLIER flag-ON window is a durable row. The reap is gated on the STORE
    // existing (not the reversible flag), so such a stub must be reaped on purge —
    // else it survives a flag-OFF erase and resurrects (still recallable) on re-flip.
    const { layer, engine } = await newLayer({ subjectGraph: false });
    const graph = new MemoryGraphStore(engine);

    const res = await layer.store('legacy only', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    // No stub was mirrored (flag off)…
    expect(graph.getStub(res.memoryId)).toBeNull();
    // …plant one with the SAME id (id-parity) to stand in for a durable stub from a prior flag-ON window.
    graph.upsertStub({ id: res.memoryId, text: 'legacy only', namespace: 'knowledge', scopeType: scope.type, scopeId: scope.id });
    expect(graph.getStub(res.memoryId)).not.toBeNull();

    layer.purgeThread('thread-A');
    // Store exists → the durable stub IS reaped regardless of the flag; legacy purged too.
    expect(graph.getStub(res.memoryId)).toBeNull();
    expect(layer.getDb().getMemoryIdsByThread('thread-A')).toEqual([]);
  });

  // ── Part A: gc (inactive stubs) ───────────────────────────────

  it('gc deletes inactive engine.db stubs under the flag, keeps active ones', async () => {
    const { layer, engine } = await newLayer({ subjectGraph: true });
    const graph = new MemoryGraphStore(engine);

    const keep = await layer.store('active fact', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    const dead = await layer.store('superseded fact', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    graph.markSuperseded(dead.memoryId, keep.memoryId); // dead stub → is_active = 0

    await layer.gc({ dryRun: false });

    expect(graph.getStub(dead.memoryId)).toBeNull();     // reaped
    expect(graph.getStub(keep.memoryId)).not.toBeNull();  // survives
  });

  it('gc dry-run does NOT delete engine.db stubs', async () => {
    const { layer, engine } = await newLayer({ subjectGraph: true });
    const graph = new MemoryGraphStore(engine);

    const dead = await layer.store('superseded fact', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    graph.markSuperseded(dead.memoryId, dead.memoryId);

    await layer.gc({ dryRun: true });

    expect(graph.getStub(dead.memoryId)).not.toBeNull(); // dry-run touched nothing
  });

  it('gc does NOT touch engine.db when the mirror flag is OFF', async () => {
    const { layer, engine } = await newLayer({ subjectGraph: false });
    const graph = new MemoryGraphStore(engine);
    graph.upsertStub({ id: 'dead', text: 'd', namespace: 'knowledge', scopeType: 'context', scopeId: 'p', isActive: 0 });

    await layer.gc({ dryRun: false });
    expect(graph.getStub('dead')).not.toBeNull(); // gate off → engine.db inactive stub untouched
  });

  // ── Part A: engine.db failure handling — gc stays best-effort (swallow), but the
  //    privacy DELETE/erase family (purgeThread/eraseByPattern/deactivateByPattern)
  //    RE-THROWS so the legacy source survives for a self-healing retry ──

  it('purgeThread RE-THROWS an engine.db failure and leaves legacy intact (self-heal, not orphan)', async () => {
    const { layer, engine } = await newLayer({ subjectGraph: true });
    await layer.store('alpha thread fact for isolation', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    await layer.store('beta thread fact for isolation', 'knowledge', scope, { sourceThreadId: 'thread-A' });

    engine.close(); // engine.db ops (purgeMemories) now throw

    // engine.db is reaped FIRST: on a reap failure purgeThread re-throws BEFORE the
    // legacy purge, so the legacy ids survive and a retry re-derives + self-heals —
    // instead of orphaning a still-recallable engine.db stub under reads-ON.
    expect(() => layer.purgeThread('thread-A')).toThrow();
    expect(layer.getDb().getMemoryIdsByThread('thread-A')).toHaveLength(2); // legacy intact → retryable
  });

  it('gc swallows an engine.db failure and still runs legacy gc', async () => {
    const { layer, engine } = await newLayer({ subjectGraph: true });
    await layer.store('some fact for gc isolation', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    engine.close();

    // gcInactiveStubs throws (engine closed) but is swallowed → gc resolves with the legacy result.
    await expect(layer.gc({ dryRun: false })).resolves.toMatchObject({ supersededRemoved: expect.any(Number) });
  });

  // ── Part A: store-level primitives (unit) ─────────────────────

  it('MemoryGraphStore.purgeMemories deletes stubs + cascades the junction; chunks past 999', async () => {
    const dir = tmp();
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-unit'); engines.push(engine);
    const graph = new MemoryGraphStore(engine);
    const subjects = new SubjectStore(engine);
    const s = subjects.findOrCreate({ kind: 'organization', name: 'Acme', aliases: ['Acme'] }).id;

    const ids: string[] = [];
    for (let i = 0; i < 600; i++) {
      const id = `mem-${i}`;
      graph.upsertStub({ id, text: `t${i}`, namespace: 'knowledge', scopeType: 'context', scopeId: 'p' });
      graph.linkSubjects(id, [s]);
      ids.push(id);
    }
    const db = engine.getDb();
    expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(600);
    expect((db.prepare('SELECT COUNT(*) c FROM memory_subjects').get() as { c: number }).c).toBe(600);

    const deleted = graph.purgeMemories(ids); // >500 → exercises the chunk loop
    expect(deleted).toBe(600);
    expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM memory_subjects').get() as { c: number }).c).toBe(0); // cascaded
    expect(subjects.getSubject(s)).not.toBeNull(); // the subject survives the stub purge
    expect(graph.purgeMemories([])).toBe(0); // empty is a no-op
  });

  it('MemoryGraphStore.gcInactiveStubs deletes only is_active = 0', async () => {
    const dir = tmp();
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-unit'); engines.push(engine);
    const graph = new MemoryGraphStore(engine);
    graph.upsertStub({ id: 'active', text: 'a', namespace: 'knowledge', scopeType: 'context', scopeId: 'p' });
    graph.upsertStub({ id: 'dead', text: 'd', namespace: 'knowledge', scopeType: 'context', scopeId: 'p', isActive: 0 });

    expect(graph.gcInactiveStubs()).toBe(1);
    expect(graph.getStub('active')).not.toBeNull();
    expect(graph.getStub('dead')).toBeNull();
  });

  it('AgentMemoryDb.getMemoryIdsByThread returns exactly the thread\'s memory ids', async () => {
    const { layer } = await newLayer({ subjectGraph: true });
    // Distinct texts so vector dedup (cosine > 0.95) never collapses them into one row.
    const a1 = await layer.store('the quarterly report is due friday', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    const a2 = await layer.store('vendor onboarding needs a signed nda', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    await layer.store('the office move is scheduled for march', 'knowledge', scope, { sourceThreadId: 'thread-B' });

    const ids = layer.getDb().getMemoryIdsByThread('thread-A').sort();
    expect(ids).toEqual([a1.memoryId, a2.memoryId].sort());
    expect(layer.getDb().getMemoryIdsByThread('nope')).toEqual([]);
  });

  // ── Part B: metrics relocated to history.db ───────────────────

  it('RunHistory.upsertMetric/getMetrics round-trips + upserts on (name, window, scope)', () => {
    const dir = tmp();
    const rh = new RunHistory(join(dir, 'history.db')); histories.push(rh);

    rh.upsertMetric({ metricName: 'success_rate', value: 0.8, sampleCount: 10 });
    rh.upsertMetric({ metricName: 'success_rate', value: 0.9, sampleCount: 20 }); // same key → update
    rh.upsertMetric({ metricName: 'cost', value: 1.5, window: 'daily' });
    rh.upsertMetric({ metricName: 'cost', value: 2.0, window: 'weekly' }); // different window → new row
    // A scoped metric is a DISTINCT row from the same-name global one (scope in the key).
    rh.upsertMetric({ metricName: 'success_rate', value: 0.5, scopeType: 'context', scopeId: 'proj-1' });
    rh.upsertMetric({ metricName: 'success_rate', value: 0.6, scopeType: 'context', scopeId: 'proj-1' }); // updates the scoped row

    const sr = rh.getMetrics('success_rate'); // global + scoped rows
    expect(sr).toHaveLength(2);
    const global = sr.find(m => m.scope_id === null);
    const scoped = sr.find(m => m.scope_id === 'proj-1');
    expect(global!.value).toBeCloseTo(0.9, 5);
    expect(global!.sample_count).toBe(20);
    expect(scoped!.value).toBeCloseTo(0.6, 5); // the scoped row upserted independently
    expect(rh.getMetrics('cost')).toHaveLength(2);
    expect(rh.getMetrics('cost', 'daily')[0]!.value).toBeCloseTo(1.5, 5);
  });

  it('KnowledgeLayer.getMetrics reads history.db (populated via runIntelligence); [] with no history', async () => {
    const dir = tmp();
    const rh = new RunHistory(join(dir, 'history.db')); histories.push(rh);
    const runId = rh.insertRun({ sessionId: 's1', taskText: 't', modelTier: 'balanced', modelId: 'm' });
    rh.updateRun(runId, { status: 'completed', durationMs: 1000, costUsd: 0.02 });

    const { layer } = await newLayer({ subjectGraph: true, runHistory: rh });
    layer.runIntelligence(); // KpiEngine writes metrics INTO history.db

    const total = layer.getMetrics('total_runs');
    expect(total).toHaveLength(1);
    expect(total[0]!.value).toBe(1);

    // A KnowledgeLayer without a RunHistory has no metrics to read.
    const { layer: noHist } = await newLayer({ subjectGraph: true });
    expect(noHist.getMetrics()).toEqual([]);
  });
});
