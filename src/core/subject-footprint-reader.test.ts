import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import { TaskStore } from './task-store.js';
import { ThreadStore } from './thread-store.js';
import { DataStore } from './data-store.js';
import { SubjectFootprintReader } from './subject-footprint-reader.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * Record-on-Spine R2b — the composed subject-footprint read. Assembles records
 * (datastore.db) + threads (a thread store handle) into ONE occurrence timeline, with
 * memories + tasks (engine.db) as adjacent sections. Uses a real full stack so the
 * cross-store gather + merge-sort + stale-safety are exercised end-to-end.
 */
describe('SubjectFootprintReader (Foundation Rework v2 — R2b)', () => {
  const scope: MemoryScopeRef = { type: 'context', id: 'p1' };
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const stores: DataStore[] = [];

  function make(): {
    engine: EngineDb;
    subs: SubjectStore;
    ds: DataStore;
    reader: SubjectFootprintReader;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-fp-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'));
    engines.push(engine);
    const ds = new DataStore(join(dir, 'datastore.db'));
    stores.push(ds);
    const subs = new SubjectStore(engine);
    const mem = new MemoryGraphStore(engine);
    const tasks = new TaskStore(engine);
    const threads = new ThreadStore(engine.getDb()); // engine.db carries the threads DDL
    const reader = new SubjectFootprintReader(subs, ds, mem, threads, tasks);
    return { engine, subs, ds, reader };
  }

  afterEach(() => {
    for (const s of stores) { try { s.close(); } catch { /* ignore */ } }
    stores.length = 0;
    for (const e of engines) { try { e.close(); } catch { /* ignore */ } }
    engines.length = 0;
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  /** Seed the full footprint of `subjectId` across all four stores. */
  function seedFootprint(engine: EngineDb, ds: DataStore, subjectId: string, tag: string): void {
    // records — an invoices collection with a subject client column + occurred_at
    if (!ds.getCollectionInfo('invoices')) {
      ds.createCollection({
        name: 'invoices', scope,
        columns: [
          { name: 'label', type: 'string' },
          { name: 'client', type: 'subject', subjectKind: 'organization' },
          { name: 'invoice_date', type: 'date', role: 'occurred_at' },
        ],
      });
    }
    ds.insertRecords({ collection: 'invoices', records: [
      { label: `${tag}-old`, client: subjectId, invoice_date: '2026-01-10' },
      { label: `${tag}-new`, client: subjectId, invoice_date: '2026-03-15' },
    ] });

    // memory (linked via the memory_subjects junction)
    const mem = new MemoryGraphStore(engine);
    mem.upsertStub({
      id: `mem-${tag}`, text: `${tag} prefers email`,
      namespace: 'knowledge', scopeType: 'context', scopeId: 'p1',
      createdAt: '2026-02-01', confidence: 0.9,
    });
    mem.linkSubjects(`mem-${tag}`, [subjectId]);

    // task assigned to the subject
    engine.getDb().prepare(
      'INSERT INTO tasks (id, title, assignee_subject_id, updated_at) VALUES (?, ?, ?, ?)',
    ).run(`task-${tag}`, `${tag} follow-up`, subjectId, '2026-02-15');

    // thread anchored to the subject (a future activity time → tops the timeline)
    engine.getDb().prepare(
      'INSERT INTO threads (id, primary_subject_id, updated_at) VALUES (?, ?, ?)',
    ).run(`th-${tag}`, subjectId, '2026-06-01');
  }

  it('assembles the full footprint: records+threads timeline, memories+tasks adjacent', () => {
    const { engine, subs, ds, reader } = make();
    const acme = subs.findOrCreate({ kind: 'organization', name: 'Acme GmbH' }).id;
    seedFootprint(engine, ds, acme, 'acme');

    const fp = reader.getFootprint(acme);
    expect(fp).not.toBeNull();
    expect(fp!.subject).toEqual({ id: acme, kind: 'organization', name: 'Acme GmbH' });

    // timeline = 1 thread + 2 records, newest-first (thread activity 2026-06-01 tops it)
    expect(fp!.timeline.map(e => e.type)).toEqual(['thread', 'record', 'record']);
    const first = fp!.timeline[0]!;
    expect(first.type).toBe('thread');
    if (first.type === 'thread') expect(first.thread.id).toBe('th-acme');
    const recordTimes = fp!.timeline.filter(e => e.type === 'record').map(e => e.occurredAt);
    expect(recordTimes).toEqual(['2026-03-15', '2026-01-10']); // occurrence-ordered

    // adjacent sections
    expect(fp!.memories.map(m => m.id)).toEqual(['mem-acme']);
    expect(fp!.memories[0]!.text).toBe('acme prefers email');
    expect(fp!.tasks.map(t => t.id)).toEqual(['task-acme']);

    // nothing truncated at this size
    expect(fp!.truncated).toEqual({ records: false, threads: false, memories: false, tasks: false });
  });

  it('sets each truncated flag when a section exceeds the limit', () => {
    const { engine, subs, ds, reader } = make();
    const acme = subs.findOrCreate({ kind: 'organization', name: 'Acme GmbH' }).id;
    seedFootprint(engine, ds, acme, 'acme'); // 2 records, 1 memory, 1 task, 1 thread
    // Add a 2nd memory / task / thread so every section holds >= 2 rows.
    const mem = new MemoryGraphStore(engine);
    mem.upsertStub({
      id: 'mem-acme2', text: 'second note',
      namespace: 'knowledge', scopeType: 'context', scopeId: 'p1', createdAt: '2026-02-02',
    });
    mem.linkSubjects('mem-acme2', [acme]);
    engine.getDb().prepare(
      'INSERT INTO tasks (id, title, assignee_subject_id, updated_at) VALUES (?, ?, ?, ?)',
    ).run('task-acme2', 'second follow-up', acme, '2026-02-16');
    engine.getDb().prepare(
      'INSERT INTO threads (id, primary_subject_id, updated_at) VALUES (?, ?, ?)',
    ).run('th-acme2', acme, '2026-06-02');

    const fp = reader.getFootprint(acme, { limit: 1 })!;
    expect(fp.truncated).toEqual({ records: true, threads: true, memories: true, tasks: true });
    expect(fp.memories).toHaveLength(1);
    expect(fp.tasks).toHaveLength(1);
    expect(fp.timeline.filter(e => e.type === 'record')).toHaveLength(1);
    expect(fp.timeline.filter(e => e.type === 'thread')).toHaveLength(1);
  });

  it('projects memories to a lean shape (no embedding blob leaks into the footprint)', () => {
    const { engine, subs, ds, reader } = make();
    const acme = subs.findOrCreate({ kind: 'organization', name: 'Acme GmbH' }).id;
    seedFootprint(engine, ds, acme, 'acme');
    const mem = reader.getFootprint(acme)!.memories[0]!;
    expect(Object.keys(mem).sort()).toEqual(['confidence', 'createdAt', 'id', 'text']);
    expect('embedding' in mem).toBe(false);
  });

  it('isolates subjects — one subject\'s footprint never bleeds another\'s rows', () => {
    const { engine, subs, ds, reader } = make();
    const acme = subs.findOrCreate({ kind: 'organization', name: 'Acme GmbH' }).id;
    const beta = subs.findOrCreate({ kind: 'organization', name: 'Beta AG' }).id;
    seedFootprint(engine, ds, acme, 'acme');
    seedFootprint(engine, ds, beta, 'beta');

    const fp = reader.getFootprint(acme)!;
    // every timeline record belongs to acme; the anchored thread is th-acme
    for (const e of fp.timeline) {
      if (e.type === 'record') expect(String(e.row['label'])).toMatch(/^acme-/);
      else expect(e.thread.id).toBe('th-acme');
    }
    expect(fp.memories.map(m => m.id)).toEqual(['mem-acme']);
    expect(fp.tasks.map(t => t.id)).toEqual(['task-acme']);
  });

  it('returns null for a stale / unknown subject id (dangling cross-DB soft ref)', () => {
    const { reader } = make();
    expect(reader.getFootprint('subj-does-not-exist')).toBeNull();
  });

  it('an empty subject yields an empty-but-shaped footprint', () => {
    const { subs, reader } = make();
    const lonely = subs.findOrCreate({ kind: 'person', name: 'Nobody' }).id;
    const fp = reader.getFootprint(lonely)!;
    expect(fp.timeline).toEqual([]);
    expect(fp.memories).toEqual([]);
    expect(fp.tasks).toEqual([]);
    expect(fp.truncated).toEqual({ records: false, threads: false, memories: false, tasks: false });
  });
});
