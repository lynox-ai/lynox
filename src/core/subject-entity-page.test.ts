import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { listSubjectEntitiesOn } from './knowledge-layer.js';
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

  it('lets the export collect every listed subject past the first page', async () => {
    seed(450);
    const { entities, truncated } = await collectGraphForExport({
      listEntities: (o) => listSubjectEntitiesOn(store, o),
      getEntityRelationsForExport: () => [],
    });
    expect(truncated).toBe(false);
    expect(entities.map(e => e.id)).toEqual(expectedOrder());
  });
});
