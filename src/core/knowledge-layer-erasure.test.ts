import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb } from './engine-db.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * Erasure PR — `KnowledgeLayer.eraseByPattern` PHYSICALLY deletes matching memories
 * from BOTH stores (GDPR Art. 17), the terminal state of the Validity axis. This is
 * distinct from the SOFT `deactivateByPattern` (is_active = 0, row + text + embedding
 * persist and ride backups/exports) covered by knowledge-layer-delete-mirror.test.ts.
 *
 * Extraction is mocked EMPTY so stored memories are subject-less — the store-level
 * hard-delete is proven on the vector-recall path alone; the orphan-entity cascade is
 * unit-tested directly at the AgentMemoryDb layer (agent-memory-db.test.ts).
 */
const mock = vi.hoisted(() => ({ extraction: { entities: [], relations: [] } as ExtractionResult }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => mock.extraction) };
});

describe('KnowledgeLayer.eraseByPattern (Erasure — hard delete)', () => {
  const provider = new LocalProvider();
  const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
  const opts = { topK: 10, threshold: 0.2, useHyDE: false, useGraphExpansion: false };
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  const layers: KnowledgeLayer[] = [];

  afterEach(async () => {
    for (const l of layers) await l.close().catch(() => {});
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    layers.length = 0; engines.length = 0; dirs.length = 0;
  });

  function newLayer(o: { subjectGraph: boolean; memReads: boolean }): { layer: KnowledgeLayer; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-erasure');
    engines.push(engine);
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), provider, undefined, undefined,
      engine, o.subjectGraph, o.memReads,
    );
    layers.push(layer);
    return { layer, engine };
  }

  it('physically removes the row from BOTH stores (not a soft is_active = 0)', async () => {
    const { layer, engine } = newLayer({ subjectGraph: true, memReads: true });
    await layer.init();

    const secret = 'The launch code for Projekt Titan is seven seven three.';
    const stored = await layer.store(secret, 'knowledge', scope);
    expect(stored.stored).toBe(true);
    // Present in both stores before the erase.
    expect(layer.getDb().getMemory(stored.memoryId)).not.toBeNull();
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).not.toBeNull();

    const erased = await layer.eraseByPattern('launch code for Projekt Titan');
    expect(erased).toBe(1);

    // Hard delete: the legacy row is GONE (not is_active = 0) — its text + embedding no
    // longer ride any backup/export — and the engine.db recall stub is GONE too.
    expect(layer.getDb().getMemory(stored.memoryId)).toBeNull();
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).toBeNull();
    // And it no longer surfaces in recall.
    const after = await layer.retrieve(secret, [scope], opts);
    expect(after.memories.map(m => m.id)).not.toContain(stored.memoryId);
  });

  it('erases a row a PRIOR soft-delete left as is_active = 0 (reaps the residue)', async () => {
    const { layer, engine } = newLayer({ subjectGraph: true, memReads: true });
    await layer.init();

    const stored = await layer.store('Superseded secret about Projekt Nimbus', 'knowledge', scope);
    // Soft-delete first (the old "delete" — text/embedding persist at is_active = 0).
    await layer.deactivateByPattern('Superseded secret about Projekt Nimbus');
    expect(layer.getDb().getMemory(stored.memoryId)!.is_active).toBe(0);

    // A later erasure must physically remove that residue.
    const erased = await layer.eraseByPattern('Superseded secret about Projekt Nimbus');
    expect(erased).toBe(1);
    expect(layer.getDb().getMemory(stored.memoryId)).toBeNull();
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).toBeNull();
  });

  it('a failed engine.db reap RE-THROWS + surfaces a parity-loss, leaves legacy INTACT, and a retry self-heals', async () => {
    const { layer, engine } = newLayer({ subjectGraph: true, memReads: true });
    await layer.init();
    const secret = 'A fact whose engine.db reap will fail once';
    const stored = await layer.store(secret, 'knowledge', scope);

    const lines: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    const purgeSpy = vi.spyOn(MemoryGraphStore.prototype, 'purgeMemories').mockImplementationOnce(() => {
      throw new Error('engine.db locked');
    });
    try {
      // Erasure must be LOUD: the reap failure re-throws so an awaiting caller
      // (MemoryFacade.delete) fails the delete instead of reporting a false success.
      await expect(layer.eraseByPattern(secret)).rejects.toThrow('engine.db locked');
      expect(purgeSpy).toHaveBeenCalledOnce();
      expect(lines.some(l => l.includes('[lynox:mirror-parity] CRITICAL erase'))).toBe(true);
      // The marker carries the ids (not just a count) so a reconcile has a handle.
      expect(lines.some(l => l.includes(stored.memoryId))).toBe(true);
    } finally {
      errSpy.mockRestore();
      purgeSpy.mockRestore(); // restore so the retry below hits the REAL purge
    }
    // engine.db is reaped FIRST, so on its failure legacy is UNTOUCHED — no permanent
    // silent loss: the row still lives in BOTH stores and its ids stay re-derivable.
    expect(layer.getDb().getMemory(stored.memoryId)).not.toBeNull();
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).not.toBeNull();

    // Retry (real purge): re-derives the SAME ids from the intact legacy plaintext and
    // completes — self-healing, no manual reconciliation needed.
    const erased = await layer.eraseByPattern(secret);
    expect(erased).toBe(1);
    expect(layer.getDb().getMemory(stored.memoryId)).toBeNull();
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).toBeNull();
  });

  it('flag-off (subjectGraph off): erases legacy + runs a (no-op) engine.db reap since the store exists', async () => {
    const { layer, engine } = newLayer({ subjectGraph: false, memReads: false });
    await layer.init();
    const stored = await layer.store('Ephemeral note to erase later', 'knowledge', scope);

    const purgeSpy = vi.spyOn(MemoryGraphStore.prototype, 'purgeMemories');
    try {
      const erased = await layer.eraseByPattern('Ephemeral note');
      expect(erased).toBe(1);
      // Durable-reap: the reap is gated on the store existing, NOT the reversible
      // flag — so it fires with the matched ids (a no-op here, no stub was mirrored),
      // ensuring a stub from a prior flag-ON window can never survive a flag-OFF erase.
      expect(purgeSpy).toHaveBeenCalledWith([stored.memoryId]);
    } finally {
      purgeSpy.mockRestore();
    }
    expect(layer.getDb().getMemory(stored.memoryId)).toBeNull();
    // No stub was ever mirrored (subjectGraph off), so engine.db has no such id anyway.
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)).toBeNull();
  });

  it('returns 0 and touches nothing when no memory matches the pattern', async () => {
    const { layer } = newLayer({ subjectGraph: true, memReads: true });
    await layer.init();
    const stored = await layer.store('A fact that should survive', 'knowledge', scope);

    const erased = await layer.eraseByPattern('no such pattern anywhere');
    expect(erased).toBe(0);
    expect(layer.getDb().getMemory(stored.memoryId)).not.toBeNull(); // untouched
  });
});

// ── DEF-0015: the orphan-subject reap, end to end through the layer ──────────
//
// The layer is the one that can see EVERY reference a subject may still have — engine.db,
// the history.db thread anchor (via runHistory) and datastore.db (via `setRecordStore`, which
// the engine calls once the DataStore exists — the older bridge attach never fired in
// production, see engine.ts) — so it installs the reaper. These tests wire all three and prove: the subject an erased memory
// minted goes, a subject anything else still holds stays, and without the cross-DB oracle
// the reap is fail-closed (subject kept, one stderr line), never a guess.
import { RunHistory } from './run-history.js';
import { ThreadStore } from './thread-store.js';
import { DataStore } from './data-store.js';
import { SubjectStore, makeSubjectColumnBridge } from './subject-store.js';

describe('KnowledgeLayer erase → orphan-subject reap (DEF-0015)', () => {
  const provider = new LocalProvider();
  const scope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
  const dirs: string[] = [];
  const closers: Array<() => void | Promise<void>> = [];
  const ORG = (name: string): ExtractionResult => ({ entities: [{ name, type: 'organization', confidence: 0.9 }], relations: [] });

  afterEach(async () => {
    for (const c of closers.reverse()) { try { await c(); } catch { /* already closed */ } }
    closers.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    mock.extraction = { entities: [], relations: [] };
    vi.restoreAllMocks();
  });

  async function wired(o: { history: boolean; records: boolean }): Promise<{
    layer: KnowledgeLayer; engine: EngineDb; subjects: SubjectStore; threads: ThreadStore | null; ds: DataStore | null;
  }> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-reap-e2e-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-reap');
    closers.push(() => engine.close());
    const history = o.history ? new RunHistory(join(dir, 'history.db')) : undefined;
    if (history) closers.push(() => history.close());
    const layer = new KnowledgeLayer(join(dir, 'mem.db'), provider, undefined, history, engine, true, true);
    closers.push(() => layer.close());
    await layer.init();
    const subjects = new SubjectStore(engine);
    let ds: DataStore | null = null;
    if (o.records) {
      ds = new DataStore(join(dir, 'datastore.db'));
      const theDs = ds;
      closers.push(() => theDs.close());
      ds.setSubjectBridge(makeSubjectColumnBridge(subjects));
      layer.setRecordStore(ds);
    }
    const threads = history ? new ThreadStore(history.getDb()) : null;
    return { layer, engine, subjects, threads, ds };
  }

  it('erasing the only memory that minted a subject reaps the subject; a subject a surviving memory holds stays', async () => {
    const { layer, subjects } = await wired({ history: true, records: true });
    mock.extraction = ORG('Solo Corp');
    await layer.store('Solo Corp churned this week.', 'knowledge', scope);
    mock.extraction = ORG('Acme Studio');
    await layer.store('Acme Studio signed on Monday.', 'knowledge', scope);
    await layer.store('Acme Studio paid the invoice.', 'knowledge', scope);
    const solo = subjects.findCanonical('Solo Corp', 'organization')!.id;
    const acme = subjects.findCanonical('Acme Studio', 'organization')!.id;

    expect(await layer.eraseByPattern('Solo Corp churned')).toBe(1);
    expect(subjects.getSubject(solo)).toBeNull();          // the plaintext name is gone
    expect(subjects.getSubject(acme)).not.toBeNull();

    expect(await layer.eraseByPattern('signed on Monday')).toBe(1);
    expect(subjects.getSubject(acme)).not.toBeNull();      // one Acme memory survives → Acme stays
    expect(await layer.eraseByPattern('paid the invoice')).toBe(1);
    expect(subjects.getSubject(acme)).toBeNull();          // the last holder went → Acme goes
  });

  it('a history.db thread anchor keeps the subject through an erase (the cross-DB ref engine.db cannot see)', async () => {
    const { layer, subjects, threads } = await wired({ history: true, records: true });
    mock.extraction = ORG('Anchor AG');
    await layer.store('Anchor AG is the client on this thread.', 'knowledge', scope);
    const anchor = subjects.findCanonical('Anchor AG', 'organization')!.id;
    threads!.createThread('thread-1', { title: 't' });
    threads!.updateThread('thread-1', { primary_subject_id: anchor });

    expect(await layer.eraseByPattern('client on this thread')).toBe(1);
    expect(subjects.getSubject(anchor)).not.toBeNull();
    expect(subjects.referenceReason(anchor, { isThreadAnchor: () => false, hasRecords: () => false })).toBeNull(); // nothing in engine.db holds it — only the anchor did
  });

  it('a datastore.db record linking the subject keeps it through an erase', async () => {
    const { layer, subjects, ds } = await wired({ history: true, records: true });
    mock.extraction = ORG('Tabelle GmbH');
    await layer.store('Tabelle GmbH appears in a CRM table.', 'knowledge', scope);
    const org = subjects.findCanonical('Tabelle GmbH', 'organization')!.id;
    ds!.createCollection({
      name: 'kunden', scope: { type: 'context', id: '' },
      columns: [{ name: 'firma', type: 'subject', subjectKind: 'organization' }, { name: 'note', type: 'string' }],
    });
    ds!.insertRecords({ collection: 'kunden', records: [{ firma: 'Tabelle GmbH', note: 'x' }] });
    expect(ds!.hasRecordsForSubject(org)).toBe(true);       // the bridge resolved the name to THIS id

    expect(await layer.eraseByPattern('CRM table')).toBe(1);
    expect(subjects.getSubject(org)).not.toBeNull();
    expect(subjects.referenceReason(org, { isThreadAnchor: () => false, hasRecords: () => false })).toBeNull(); // only the record held it
  });

  it('a CRM contact detail (email) keeps a person through an erase', async () => {
    const { layer, subjects } = await wired({ history: true, records: true });
    mock.extraction = { entities: [{ name: 'Petra Muster', type: 'person', confidence: 0.9 }], relations: [] };
    await layer.store('Petra Muster asked for the offer.', 'knowledge', scope);
    const petra = subjects.findCanonical('Petra Muster', 'person')!.id;
    subjects.setPersonDetail(petra, { email: 'petra@example.com' });
    expect(await layer.eraseByPattern('asked for the offer')).toBe(1);
    expect(subjects.getSubject(petra)).not.toBeNull();
  });

  it('without the cross-DB oracle the reap is FAIL-CLOSED: subject kept, one stderr line per layer, erase still succeeds', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const variant of [{ history: false, records: true }, { history: true, records: false }]) {
      const { layer, subjects } = await wired(variant);
      mock.extraction = ORG('Orphan Ltd');
      await layer.store('Orphan Ltd would be reaped with the oracle.', 'knowledge', scope);
      await layer.store('Orphan Ltd second line.', 'knowledge', scope);
      const id = subjects.findCanonical('Orphan Ltd', 'organization')!.id;
      expect(await layer.eraseByPattern('would be reaped')).toBe(1);
      expect(await layer.eraseByPattern('second line')).toBe(1);
      expect(subjects.getSubject(id)).not.toBeNull();
    }
    const skips = stderr.mock.calls.filter(c => String(c[0]).includes('[lynox:subject-reap] skipped'));
    expect(skips).toHaveLength(2); // one per layer instance (two layers booted above), each naming its candidate count
    expect(String(skips[0]![0])).toMatch(/1 candidate subject\(s\) left in place/);
  });

  it('purgeThread (private mode) reaps the thread-only subject and keeps the cross-thread one', async () => {
    const { layer, subjects } = await wired({ history: true, records: true });
    mock.extraction = ORG('Acme Studio');
    await layer.store('Acme Studio signed on Monday.', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    await layer.store('Acme Studio paid the invoice.', 'knowledge', scope, { sourceThreadId: 'thread-B' });
    mock.extraction = ORG('Solo Corp');
    await layer.store('Solo Corp churned this week.', 'knowledge', scope, { sourceThreadId: 'thread-A' });
    const acme = subjects.findCanonical('Acme Studio', 'organization')!.id;
    const solo = subjects.findCanonical('Solo Corp', 'organization')!.id;

    expect(layer.purgeThread('thread-A')).toBe(2);
    expect(subjects.getSubject(solo)).toBeNull();
    expect(subjects.getSubject(acme)).not.toBeNull();
  });

  it('an oracle READ FAILURE keeps the subject (answers "referenced"), never fails the erase — and says so once', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { layer, subjects, threads } = await wired({ history: true, records: true });
    mock.extraction = ORG('Fragile AG');
    await layer.store('Fragile AG sits behind a broken anchor store.', 'knowledge', scope);
    const id = subjects.findCanonical('Fragile AG', 'organization')!.id;
    // Make the history.db anchor probe throw (a pre-v46 history.db has no such table/column).
    threads!['db'].exec('DROP TABLE threads');
    expect(await layer.eraseByPattern('broken anchor store')).toBe(1); // the erase still completes
    expect(subjects.getSubject(id)).not.toBeNull();                      // … and keeps the subject
    await layer.store('Fragile AG again.', 'knowledge', scope);
    expect(await layer.eraseByPattern('Fragile AG again')).toBe(1);
    const warns = stderr.mock.calls.filter(c => String(c[0]).includes('[lynox:subject-reap] thread-anchor probe failed'));
    expect(warns).toHaveLength(1); // once per layer, not once per probe
  });

  it('a RECORD-probe failure keeps the subject too (the other half of catch → referenced)', async () => {
    const { layer, subjects, ds } = await wired({ history: true, records: true });
    mock.extraction = ORG('Brittle AG');
    await layer.store('Brittle AG sits behind a broken record store.', 'knowledge', scope);
    const id = subjects.findCanonical('Brittle AG', 'organization')!.id;
    vi.spyOn(ds!, 'hasRecordsForSubject').mockImplementation(() => { throw new Error('datastore locked'); });
    expect(await layer.eraseByPattern('broken record store')).toBe(1);
    expect(subjects.getSubject(id)).not.toBeNull();
  });

  it('gc through the layer reaps the subject of a hard-deleted inactive stub (oracle wired)', async () => {
    const { layer, subjects } = await wired({ history: true, records: true });
    mock.extraction = ORG('Stale Corp');
    const stored = await layer.store('Stale Corp is no longer a client.', 'knowledge', scope);
    const id = subjects.findCanonical('Stale Corp', 'organization')!.id;
    // A `memory_delete`-style soft delete: is_active=0 on both stores, subject untouched …
    await layer.deactivateByPattern('no longer a client');
    expect(new MemoryGraphStore(layer['engineDb']!).getStub(stored.memoryId)!.is_active).toBe(0);
    expect(subjects.getSubject(id)).not.toBeNull();
    // … and gc is the hard delete that takes the name with it.
    await layer.gc();
    expect(new MemoryGraphStore(layer['engineDb']!).getStub(stored.memoryId)).toBeNull();
    expect(subjects.getSubject(id)).toBeNull();
  });

  it('gc: a reaper failure is logged and swallowed — the inactive stubs are STILL deleted (no rollback regression)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { layer, subjects } = await wired({ history: true, records: true });
    mock.extraction = ORG('Flaky Corp');
    const stored = await layer.store('Flaky Corp will trip the reaper.', 'knowledge', scope);
    const id = subjects.findCanonical('Flaky Corp', 'organization')!.id;
    await layer.deactivateByPattern('trip the reaper');
    vi.spyOn(SubjectStore.prototype, 'reapOrphans').mockImplementation(() => { throw new Error('reaper boom'); });
    await expect(layer.gc()).resolves.toBeDefined();                 // gc does not throw
    expect(new MemoryGraphStore(layer['engineDb']!).getStub(stored.memoryId)).toBeNull(); // stub gone
    expect(subjects.getSubject(id)).not.toBeNull();                   // subject left in place
    expect(stderr.mock.calls.some(c => String(c[0]).includes('[lynox:subject-reap] gc reap failed, 1 candidate'))).toBe(true);
  });
});
