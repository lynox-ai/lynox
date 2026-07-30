import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import { ThreadStore } from './thread-store.js';
import { RunHistory } from './run-history.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { MemoryScopeRef, ContradictionInfo } from '../types/index.js';

/**
 * Context-Hierarchy Scoping — Slice B: a memory written in a thread that is
 * anchored (via `set_thread_context`) inherits the thread's anchor subject as its
 * PRIMARY `subject_id`, overriding the person/org extraction heuristic. Exercised
 * on BOTH the pre-cutover mirror path and the post-cutover authoritative path.
 * The extractor + contradiction detector are mocked so the heuristic pick is
 * deterministic (extraction resolves an organization → the heuristic would pick it,
 * and we prove the anchor wins instead).
 */
const mock = vi.hoisted(() => ({
  extraction: { entities: [], relations: [] } as ExtractionResult,
  contradictions: [] as ContradictionInfo[],
}));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});
vi.mock('./contradiction-detector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contradiction-detector.js')>();
  return { ...actual, detectContradictions: vi.fn(async () => mock.contradictions) };
});

describe('KnowledgeLayer — thread-anchor write inheritance (Context-Hierarchy Scoping Slice B)', () => {
  const tmpDirs: string[] = [];
  const histories: RunHistory[] = [];
  const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };

  const engines: EngineDb[] = [];
  const layers: KnowledgeLayer[] = [];

  function makeLayer(opts: { flag: boolean; memoryGraphReads?: boolean }): {
    layer: KnowledgeLayer; engine: EngineDb; threads: ThreadStore;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-klb-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    const runHistory = new RunHistory(join(dir, 'history.db'));
    histories.push(runHistory);
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), new LocalProvider(), undefined, runHistory,
      engine, opts.flag, opts.memoryGraphReads ?? false,
    );
    layers.push(layer);
    const threads = new ThreadStore(runHistory.getDb());
    return { layer, engine, threads };
  }

  // Cleanup in afterEach (not inline) so a mid-test assertion failure never leaks handles.
  afterEach(async () => {
    for (const l of layers) { try { await l.close(); } catch { /* ok */ } }
    layers.length = 0;
    for (const e of engines) { try { e.close(); } catch { /* ok */ } }
    engines.length = 0;
    for (const h of histories) { try { h.close(); } catch { /* ok */ } }
    histories.length = 0;
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
    mock.extraction = { entities: [], relations: [] };
    mock.contradictions = [];
    vi.clearAllMocks();
  });

  it('mirror path (flag ON): a memory in an anchored thread takes the anchor as primary, overriding the org heuristic', async () => {
    mock.extraction = { entities: [{ name: 'Acme GmbH', type: 'organization', confidence: 0.9 }], relations: [] };
    const { layer, engine, threads } = makeLayer({ flag: true });
    await layer.init();

    const subs = new SubjectStore(engine);
    const projectId = subs.createSubject({ kind: 'engagement', name: 'Website Relaunch' });
    threads.createThread('t-1');
    threads.updateThread('t-1', { primary_subject_id: projectId });

    const res = await layer.store('Acme GmbH signed off the homepage.', 'knowledge', scope, { sourceThreadId: 't-1' });
    expect(res.stored).toBe(true);

    const mg = new MemoryGraphStore(engine);
    // Anchor (project) wins over the heuristic pick (the org).
    expect(mg.getStub(res.memoryId)!.subject_id).toBe(projectId);
    // ...but the extracted org is still a MENTIONED subject (only the PRIMARY flips).
    const org = subs.findCanonical('Acme GmbH', 'organization')!;
    expect(mg.getLinkedSubjectIds(res.memoryId)).toContain(org.id);
    // The anchor is the primary CONTEXT only — deliberately NOT a textual mention,
    // so it is not linked into memory_subjects (recall reaches it via subject_id).
    expect(mg.getLinkedSubjectIds(res.memoryId)).not.toContain(projectId);
  });

  it('subject-less extraction in an anchored thread: anchor is the primary, junction stays empty', async () => {
    mock.extraction = { entities: [], relations: [] }; // nothing extracted → no heuristic pick
    const { layer, engine, threads } = makeLayer({ flag: true });
    await layer.init();
    const projectId = new SubjectStore(engine).createSubject({ kind: 'engagement', name: 'Ops' });
    threads.createThread('t-empty');
    threads.updateThread('t-empty', { primary_subject_id: projectId });

    const res = await layer.store('The Q3 numbers look strong.', 'knowledge', scope, { sourceThreadId: 't-empty' });
    const mg = new MemoryGraphStore(engine);
    // Anchor becomes the primary even with no extracted subject (anchor ?? null → anchor).
    expect(mg.getStub(res.memoryId)!.subject_id).toBe(projectId);
    // No extracted subjects → no mentions (and the anchor is not force-linked either).
    expect(mg.getLinkedSubjectIds(res.memoryId)).toEqual([]);
  });

  it('mirror path: an UNANCHORED thread falls back to the person/org heuristic (back-compat)', async () => {
    mock.extraction = { entities: [{ name: 'Acme GmbH', type: 'organization', confidence: 0.9 }], relations: [] };
    const { layer, engine, threads } = makeLayer({ flag: true });
    await layer.init();
    threads.createThread('t-2'); // created but never anchored → primary_subject_id NULL

    const res = await layer.store('Acme GmbH is a customer.', 'knowledge', scope, { sourceThreadId: 't-2' });
    const subs = new SubjectStore(engine);
    const org = subs.findCanonical('Acme GmbH', 'organization')!;
    expect(new MemoryGraphStore(engine).getStub(res.memoryId)!.subject_id).toBe(org.id); // heuristic stands
  });

  it('mirror path: no sourceThreadId → heuristic (no anchor lookup possible)', async () => {
    mock.extraction = { entities: [{ name: 'Acme GmbH', type: 'organization', confidence: 0.9 }], relations: [] };
    const { layer, engine } = makeLayer({ flag: true });
    await layer.init();
    const res = await layer.store('Acme GmbH note.', 'knowledge', scope); // no options
    const org = new SubjectStore(engine).findCanonical('Acme GmbH', 'organization')!;
    expect(new MemoryGraphStore(engine).getStub(res.memoryId)!.subject_id).toBe(org.id);
    engine.close(); await layer.close();
  });

  it('a stale anchor (thread points at a hard-deleted subject) falls back to the heuristic, no FK throw', async () => {
    mock.extraction = { entities: [{ name: 'Acme GmbH', type: 'organization', confidence: 0.9 }], relations: [] };
    const { layer, engine, threads } = makeLayer({ flag: true, memoryGraphReads: true });
    await layer.init();
    threads.createThread('t-stale');
    // history.db threads → engine.db subjects is a soft ref (no FK); point at a dead id.
    threads.updateThread('t-stale', { primary_subject_id: 'subject-that-does-not-exist' });

    const res = await layer.store('Acme GmbH signed the contract.', 'knowledge', scope, { sourceThreadId: 't-stale' });
    expect(res.stored).toBe(true);
    const org = new SubjectStore(engine).findCanonical('Acme GmbH', 'organization')!;
    // Dangling anchor ignored → heuristic pick, and no FK-violation throw on the write.
    expect(new MemoryGraphStore(engine).getStub(res.memoryId)!.subject_id).toBe(org.id);
    engine.close(); await layer.close();
  });

  it('an anchor pointing at a MERGED subject resolves forward to the canonical (not the archived dup)', async () => {
    // A thread anchored to a subject that later got merged (soft-archived + stamped
    // merged_into). Even if the history.db anchor was never repointed — a pre-fix merge, or
    // a direct mergeSubjects — the anchor read must resolve the redirect FORWARD so new
    // memories attach to the LIVE canonical, not the archived dup stub.
    mock.extraction = { entities: [], relations: [] };
    const { layer, engine, threads } = makeLayer({ flag: true });
    await layer.init();

    const subs = new SubjectStore(engine);
    const dupProject = subs.createSubject({ kind: 'engagement', name: 'Website Relaunch (dup)' });
    const canonProject = subs.createSubject({ kind: 'engagement', name: 'Website Relaunch' });
    threads.createThread('t-merged');
    threads.updateThread('t-merged', { primary_subject_id: dupProject });
    subs.mergeSubjects(dupProject, canonProject); // primitive only → the anchor is now stale

    const res = await layer.store('The Q3 numbers look strong.', 'knowledge', scope, { sourceThreadId: 't-merged' });
    expect(res.stored).toBe(true);
    // Forwarded to the live canonical, NOT the archived dup.
    expect(new MemoryGraphStore(engine).getStub(res.memoryId)!.subject_id).toBe(canonProject);
  });

  it('cutover path (memoryGraphReads ON): the anchor overrides the heuristic on the authoritative write too', async () => {
    mock.extraction = { entities: [{ name: 'Acme GmbH', type: 'organization', confidence: 0.9 }], relations: [] };
    const { layer, engine, threads } = makeLayer({ flag: true, memoryGraphReads: true });
    await layer.init();
    const subs = new SubjectStore(engine);
    const projectId = subs.createSubject({ kind: 'engagement', name: 'Q3 Campaign' });
    threads.createThread('t-3');
    threads.updateThread('t-3', { primary_subject_id: projectId });

    const res = await layer.store('Acme GmbH approved the Q3 budget.', 'knowledge', scope, { sourceThreadId: 't-3' });
    expect(new MemoryGraphStore(engine).getStub(res.memoryId)!.subject_id).toBe(projectId);
    engine.close(); await layer.close();
  });

  it('flag OFF: the anchor is never read and engine.db stays untouched (no behavior change)', async () => {
    mock.extraction = { entities: [{ name: 'Acme GmbH', type: 'organization', confidence: 0.9 }], relations: [] };
    const { layer, engine, threads } = makeLayer({ flag: false });
    await layer.init();
    const projectId = new SubjectStore(engine).createSubject({ kind: 'engagement', name: 'X' });
    threads.createThread('t-4');
    threads.updateThread('t-4', { primary_subject_id: projectId });

    const res = await layer.store('Acme GmbH note.', 'knowledge', scope, { sourceThreadId: 't-4' });
    expect(res.stored).toBe(true);
    // Mirror is off → no engine.db memory stub written at all.
    expect(engine.getDb().prepare('SELECT COUNT(*) c FROM memories').get()).toMatchObject({ c: 0 });
    engine.close(); await layer.close();
  });

  it('updateMemoryText keeps the anchor across a text correction (does not revert to the heuristic)', async () => {
    mock.extraction = { entities: [{ name: 'Acme GmbH', type: 'organization', confidence: 0.9 }], relations: [] };
    const { layer, engine, threads } = makeLayer({ flag: true, memoryGraphReads: true });
    await layer.init();
    const subs = new SubjectStore(engine);
    const projectId = subs.createSubject({ kind: 'engagement', name: 'Rebrand' });
    threads.createThread('t-5');
    threads.updateThread('t-5', { primary_subject_id: projectId });

    const res = await layer.store('Acme GmbH kicked off the rebrand.', 'knowledge', scope, { sourceThreadId: 't-5' });
    const mg = new MemoryGraphStore(engine);
    expect(mg.getStub(res.memoryId)!.subject_id).toBe(projectId); // anchor at creation

    // A text correction re-extracts (org heuristic) — must NOT clobber the anchor.
    const ok = await layer.updateMemoryText(
      'Acme GmbH kicked off the rebrand.', 'Acme GmbH kicked off the full rebrand.', 'knowledge', scope,
    );
    expect(ok).toBe(true);
    expect(mg.getStub(res.memoryId)!.subject_id).toBe(projectId); // still the anchor
  });
});
