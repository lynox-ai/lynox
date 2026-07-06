import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { ThreadStore } from './thread-store.js';
import { RunHistory } from './run-history.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { MemoryScopeRef, ContradictionInfo } from '../types/index.js';

/**
 * M4: extraction routes engagement (project) subjects through the SAME
 * `findOrCreateEngagement(name, parent)` resolver `set_thread_context` uses, filed
 * under the thread's client anchor — so a project mentioned across many stored
 * memories converges on ONE engagement row instead of minting a duplicate each
 * time, and two clients' same-named projects stay distinct (isolation).
 *
 * Exercises the mirror path (flag ON, reads OFF): extraction is mocked to yield a
 * `project` entity so the resolution is deterministic. (The reads-ON authoritative
 * path shares the identical reroute + is covered by the staging re-seed gate.)
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

describe('KnowledgeLayer — extraction engagement dedup (M4)', () => {
  const tmpDirs: string[] = [];
  const histories: RunHistory[] = [];
  const engines: EngineDb[] = [];
  const layers: KnowledgeLayer[] = [];
  const scope: MemoryScopeRef = { type: 'context', id: 'http-api' };

  function makeLayer(): { layer: KnowledgeLayer; engine: EngineDb; threads: ThreadStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-m4eng-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    const runHistory = new RunHistory(join(dir, 'history.db'));
    histories.push(runHistory);
    const layer = new KnowledgeLayer(join(dir, 'mem.db'), new LocalProvider(), undefined, runHistory, engine, true, false);
    layers.push(layer);
    return { layer, engine, threads: new ThreadStore(runHistory.getDb()) };
  }

  afterEach(async () => {
    for (const l of layers) { try { await l.close(); } catch { /* ok */ } }
    for (const e of engines) { try { e.close(); } catch { /* ok */ } }
    for (const h of histories) { try { h.close(); } catch { /* ok */ } }
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    layers.length = 0; engines.length = 0; histories.length = 0; tmpDirs.length = 0;
    mock.extraction = { entities: [], relations: [] };
    vi.clearAllMocks();
  });

  it('converges a project mentioned across memories onto ONE row, filed under the anchored client', async () => {
    mock.extraction = { entities: [{ name: 'Orion', type: 'project', confidence: 0.9 }], relations: [] };
    const { layer, engine, threads } = makeLayer();
    await layer.init();

    const subs = new SubjectStore(engine);
    const org = subs.findOrCreate({ kind: 'organization', name: 'Kunde A' }).id;
    threads.createThread('t1');
    threads.updateThread('t1', { primary_subject_id: org });

    await layer.store('First note about the project.', 'knowledge', scope, { sourceThreadId: 't1' });
    await layer.store('Second note about the same project.', 'knowledge', scope, { sourceThreadId: 't1' });

    const engagements = subs.listSubjects({ kind: 'engagement' });
    expect(engagements).toHaveLength(1);                 // NOT one-per-store
    expect(engagements[0]!.name).toBe('Orion');
    expect(engagements[0]!.parent_id).toBe(org);         // filed under the anchored client
  });

  it('files a new project under the ORG of an engagement-anchored thread (sibling project)', async () => {
    mock.extraction = { entities: [{ name: 'Vega', type: 'project', confidence: 0.9 }], relations: [] };
    const { layer, engine, threads } = makeLayer();
    await layer.init();

    const subs = new SubjectStore(engine);
    const org = subs.findOrCreate({ kind: 'organization', name: 'Kunde A' }).id;
    const anchorProject = subs.findOrCreateEngagement('Orion', org).id;   // thread anchored to a PROJECT
    threads.createThread('t1');
    threads.updateThread('t1', { primary_subject_id: anchorProject });

    await layer.store('A note that also mentions a sibling project.', 'knowledge', scope, { sourceThreadId: 't1' });

    // _engagementParent lends the anchor engagement's OWN parent, so the extracted
    // "Vega" files under the client (org) as a sibling of Orion — NOT under Orion.
    const vega = subs.listSubjects({ kind: 'engagement' }).find(s => s.name === 'Vega')!;
    expect(vega.parent_id).toBe(org);
    expect(vega.parent_id).not.toBe(anchorProject);
  });

  it('keeps the same project name under two DIFFERENT clients as two distinct rows', async () => {
    mock.extraction = { entities: [{ name: 'Website', type: 'project', confidence: 0.9 }], relations: [] };
    const { layer, engine, threads } = makeLayer();
    await layer.init();

    const subs = new SubjectStore(engine);
    const orgA = subs.findOrCreate({ kind: 'organization', name: 'Kunde A' }).id;
    const orgB = subs.findOrCreate({ kind: 'organization', name: 'Kunde B' }).id;
    threads.createThread('tA'); threads.updateThread('tA', { primary_subject_id: orgA });
    threads.createThread('tB'); threads.updateThread('tB', { primary_subject_id: orgB });

    await layer.store('Website note for A.', 'knowledge', scope, { sourceThreadId: 'tA' });
    await layer.store('Website note for B.', 'knowledge', scope, { sourceThreadId: 'tB' });

    const engagements = subs.listSubjects({ kind: 'engagement' });
    expect(engagements).toHaveLength(2);                 // isolation: one "Website" per client
    expect(new Set(engagements.map(e => e.parent_id))).toEqual(new Set([orgA, orgB]));
  });
});
