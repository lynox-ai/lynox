import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { listSubjectEntitiesAfterOn, listSubjectEntitiesOn } from './knowledge-layer.js';
import type { EntityRecord } from '../types/memory.js';
import { collectGraphForExport } from './graph-export.js';

describe('listSubjectEntitiesOn reads one page from the store per call', () => {
  let dir: string;
  let engineDb: EngineDb;
  let store: SubjectStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-subject-page-'));
    engineDb = new EngineDb(join(dir, 'engine.db'));
    store = new SubjectStore(engineDb);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engineDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seeds `n` listed subjects (persons and organizations), each with its own `updated_at`, newest last. */
  function seed(n: number): string[] {
    const raw = engineDb.getDb();
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = store.createSubject({ kind: i % 2 === 0 ? 'person' : 'organization', name: `S${String(i).padStart(4, '0')}` });
      raw.prepare('UPDATE subjects SET updated_at = ? WHERE id = ?').run(`2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(4, '0')}Z`, id);
      ids.push(id);
    }
    return ids;
  }

  /** The listed subjects as the list orders them: newest change first, ties by id. */
  function expectedOrder(): string[] {
    return (engineDb.getDb().prepare(
      "SELECT id FROM subjects WHERE kind IN ('person', 'organization', 'engagement', 'product') AND archived_at IS NULL ORDER BY updated_at DESC, id ASC",
    ).all() as Array<{ id: string }>).map(r => r.id);
  }

  it('returns the right rows for a page past the first, and pages cover every listed subject once', () => {
    seed(450);
    const hidden = store.createSubject({ kind: 'service', name: 'Hosting' });
    const archived = store.createSubject({ kind: 'person', name: 'Gone' });
    store.archiveSubject(archived);
    const order = expectedOrder();
    expect(order, 'fixture: the listed subjects').toHaveLength(450);

    const pages = [0, 1, 2].map(p => listSubjectEntitiesOn(store, { limit: 200, offset: p * 200 }).map(e => e.id));
    expect(pages[1], 'the second page').toEqual(order.slice(200, 400));
    expect(pages[2], 'the last, short page').toEqual(order.slice(400));
    expect(pages.flat(), 'every listed subject once, in order').toEqual(order);
    expect(pages.flat(), 'a service subject is not listed').not.toContain(hidden);
    expect(pages.flat(), 'an archived subject is not listed').not.toContain(archived);
    expect(listSubjectEntitiesOn(store, { limit: 200, offset: 600 }), 'a page past the end').toEqual([]);
  });

  it('does not load every subject for a page', () => {
    seed(30);
    const all = vi.spyOn(store, 'listSubjects');
    const page = vi.spyOn(store, 'listSubjectPage');
    const rows = listSubjectEntitiesOn(store, { limit: 10, offset: 10 });
    expect(rows.map(e => e.id), 'the page itself').toEqual(expectedOrder().slice(10, 20));
    expect(all, 'no full read').not.toHaveBeenCalled();
    expect(page, 'one page read').toHaveBeenCalledTimes(1);
    expect(page.mock.results[0]?.value, 'the store returned the page, not all rows').toHaveLength(10);
  });

  it('pages without overlap or gap when subjects share a timestamp', () => {
    const ids = seed(25);
    const raw = engineDb.getDb();
    raw.prepare("UPDATE subjects SET updated_at = '2026-01-01T00:00:00.000Z'").run();
    const pages = [0, 1, 2].map(p => listSubjectEntitiesOn(store, { limit: 10, offset: p * 10 }).map(e => e.id));
    expect(pages.flat(), 'ties ordered by id').toEqual([...ids].sort());
  });

  it('keeps the kind filter on a page, and an unmapped type lists nothing', () => {
    seed(40);
    const page = listSubjectEntitiesOn(store, { type: 'person', limit: 5, offset: 5 });
    const persons = (engineDb.getDb().prepare(
      "SELECT id FROM subjects WHERE kind = 'person' AND archived_at IS NULL ORDER BY updated_at DESC, id ASC",
    ).all() as Array<{ id: string }>).map(r => r.id);
    expect(page.map(e => e.id)).toEqual(persons.slice(5, 10));
    expect(page.every(e => e.entityType === 'person'), 'persons only').toBe(true);
    expect(listSubjectEntitiesOn(store, { type: 'concept', limit: 5, offset: 0 }), 'no subject kind for concept').toEqual([]);
  });

  it('fills the mention count of each row on the page', () => {
    const [a, b] = seed(2) as [string, string];
    const raw = engineDb.getDb();
    raw.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES ('m1', 't', 'knowledge', 'global', 'global'), ('m2', 't', 'knowledge', 'global', 'global')").run();
    raw.prepare("INSERT INTO memory_subjects (memory_id, subject_id) VALUES ('m1', ?), ('m2', ?), ('m1', ?)").run(a, a, b);
    const counts = new Map(listSubjectEntitiesOn(store, { limit: 10, offset: 0 }).map(e => [e.id, e.mentionCount]));
    expect(counts.get(a)).toBe(2);
    expect(counts.get(b)).toBe(1);
  });

  it('still matches a search case-insensitively beyond ASCII, on name and alias', () => {
    const doc = store.createSubject({ kind: 'organization', name: 'Ärztehaus Nord', aliases: ['Ärztehaus Nord', 'Praxis Öschberg'] });
    store.createSubject({ kind: 'person', name: 'Unrelated' });
    expect(listSubjectEntitiesOn(store, { q: 'ärztehaus', limit: 10 }).map(e => e.id), 'name').toEqual([doc]);
    expect(listSubjectEntitiesOn(store, { q: 'öschberg', limit: 10 }).map(e => e.id), 'alias').toEqual([doc]);
  });

  it('reads the page without the embedding', () => {
    store.createSubject({ kind: 'person', name: 'Embedded', embedding: Buffer.alloc(16, 1) });
    const [row] = store.listSubjectPage({ kinds: ['person'], limit: 1, offset: 0 });
    expect(row?.name, 'fixture: the row is read').toBe('Embedded');
    expect(row, 'no embedding column').not.toHaveProperty('embedding');
  });

  /** The SQL each `prepare` on the store's connection was given, while `run` executes. */
  function sqlDuring<T>(run: () => T): { result: T; sql: string[] } {
    const raw = engineDb.getDb();
    const prepare = raw.prepare.bind(raw);
    const sql: string[] = [];
    const spy = vi.spyOn(raw, 'prepare').mockImplementation(((text: string) => { sql.push(text); return prepare(text); }) as typeof raw.prepare);
    try {
      return { result: run(), sql };
    } finally {
      spy.mockRestore();
    }
  }

  it('cuts the web page in the query, with LIMIT and OFFSET', () => {
    seed(30);
    const { result, sql } = sqlDuring(() => store.listSubjectPage({ kinds: ['person', 'organization'], limit: 10, offset: 10 }));
    expect(result.map(r => r.id)).toEqual(expectedOrder().slice(10, 20));
    const reads = sql.filter(t => /FROM subjects/.test(t));
    expect(reads, 'one read').toHaveLength(1);
    expect(reads[0], 'cut in the query').toMatch(/LIMIT \? OFFSET \?/);
  });

  it('answers an offset or limit no SQLite integer can hold with an empty or bounded page, not an error', () => {
    seed(5);
    expect(listSubjectEntitiesOn(store, { limit: 10, offset: 1e20 }), 'offset past every row').toEqual([]);
    expect(listSubjectEntitiesOn(store, { limit: 10, offset: Number.NaN }).map(e => e.id), 'NaN offset reads from the start').toEqual(expectedOrder());
    expect(listSubjectEntitiesOn(store, { limit: 1e20, offset: 0 }).map(e => e.id), 'huge limit reads every row').toEqual(expectedOrder());
  });

  it('walks every listed subject by key, one page per read, each read past the last id', () => {
    seed(450);
    const hidden = store.createSubject({ kind: 'other', name: 'Misc' });
    const archived = store.createSubject({ kind: 'organization', name: 'Gone' });
    store.archiveSubject(archived);
    const { result: pages, sql } = sqlDuring(() => {
      const out: string[][] = [];
      let after: string | null = null;
      for (;;) {
        const batch: EntityRecord[] = listSubjectEntitiesAfterOn(store, after, 200);
        out.push(batch.map(e => e.id));
        if (batch.length < 200) break;
        after = batch[batch.length - 1]!.id;
      }
      return out;
    });
    const byId = [...expectedOrder()].sort();
    expect(pages.map(p => p.length), 'three pages').toEqual([200, 200, 50]);
    expect(pages.flat(), 'every listed subject once, by id').toEqual(byId);
    expect(pages.flat(), 'kind other is not listed').not.toContain(hidden);
    expect(pages.flat(), 'an archived subject is not listed').not.toContain(archived);
    const reads = sql.filter(t => /FROM subjects/.test(t));
    expect(reads, 'one read per page').toHaveLength(3);
    expect(reads[0], 'the first page starts at the first id').not.toMatch(/id > \?/);
    for (const r of reads.slice(1)) {
      expect(r, 'a later page reads past the last id').toMatch(/AND id > \?/);
      expect(r, 'no offset').not.toMatch(/OFFSET/);
    }
  });

  it('reads a key page as a range on the primary key, without sorting', () => {
    seed(5);
    const { sql } = sqlDuring(() => store.listSubjectsAfter({ kinds: ['person', 'organization'], after: 'x', limit: 2 }));
    const read = sql.find(t => /FROM subjects/.test(t))!;
    const plan = (engineDb.getDb().prepare(`EXPLAIN QUERY PLAN ${read}`).all('person', 'organization', 'x', 2) as Array<{ detail: string }>).map(r => r.detail);
    expect(plan.join(' | '), 'the primary key, by range').toMatch(/USING INDEX sqlite_autoindex_subjects_1 \(id>\?\)/);
    expect(plan.join(' | '), 'no sort per page').not.toMatch(/TEMP B-TREE/);
  });

  it('lets the export walk every listed subject by key', async () => {
    seed(450);
    const byOffset = vi.fn((o: { limit: number; offset: number }) => listSubjectEntitiesOn(store, o));
    const { entities, truncated } = await collectGraphForExport({
      listEntities: byOffset,
      listEntitiesAfter: (after, limit) => listSubjectEntitiesAfterOn(store, after, limit),
      getEntityRelationsForExport: () => [],
    });
    expect(truncated).toBe(false);
    expect(entities.map(e => e.id)).toEqual([...expectedOrder()].sort());
    expect(byOffset, 'no offset page').not.toHaveBeenCalled();
  });

  it('pages the export by offset from the start when the key walk is not offered or stops part way', async () => {
    seed(450);
    const plain = await collectGraphForExport({
      listEntities: (o) => listSubjectEntitiesOn(store, o),
      getEntityRelationsForExport: () => [],
    });
    expect(plain.entities.map(e => e.id), 'no key walk: offset pages').toEqual(expectedOrder());

    let calls = 0;
    const stopped = await collectGraphForExport({
      listEntities: (o) => listSubjectEntitiesOn(store, o),
      listEntitiesAfter: (after, limit) => (++calls === 2 ? null : listSubjectEntitiesAfterOn(store, after, limit)),
      getEntityRelationsForExport: () => [],
    });
    expect(calls, 'fixture: the walk stopped at its second page').toBe(2);
    expect(stopped.entities.map(e => e.id), 'from the start, each entity once').toEqual(expectedOrder());
    expect(stopped.truncated).toBe(false);
  });
});
