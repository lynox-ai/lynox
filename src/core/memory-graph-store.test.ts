import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore, entityTypeToSubjectKind } from './subject-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';

describe('entityTypeToSubjectKind (Foundation Rework v2 — S1b)', () => {
  it('maps subject-bearing KG types and drops graph-metadata types', () => {
    expect(entityTypeToSubjectKind('person')).toBe('person');
    expect(entityTypeToSubjectKind('organization')).toBe('organization');
    expect(entityTypeToSubjectKind('project')).toBe('engagement');
    expect(entityTypeToSubjectKind('product')).toBe('product');
    expect(entityTypeToSubjectKind('concept')).toBeNull();
    expect(entityTypeToSubjectKind('location')).toBeNull();
    expect(entityTypeToSubjectKind('collection')).toBeNull();
    expect(entityTypeToSubjectKind('something-unknown')).toBeNull();
  });
});

describe('MemoryGraphStore (Foundation Rework v2 — S1b)', () => {
  const tmpDirs: string[] = [];

  function make(key = ''): { engine: EngineDb; mem: MemoryGraphStore; subs: SubjectStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-memgraph-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    return { engine, mem: new MemoryGraphStore(engine), subs: new SubjectStore(engine) };
  }

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('upserts a stub idempotently, keeps source_thread_id NULL, fills subject_id without clobbering', () => {
    const { engine, mem, subs } = make();
    const sid = subs.findOrCreate({ kind: 'organization', name: 'Acme' }).id;

    mem.upsertStub({ id: 'm1', text: 'hello', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    expect(mem.getStub('m1')!.subject_id).toBeNull();

    // source_thread_id must stay NULL — it is a REAL FK to engine.db threads,
    // which S1b does not populate; a live thread id here would break the FK.
    const raw = engine.getDb().prepare('SELECT source_thread_id FROM memories WHERE id = ?').get('m1') as { source_thread_id: string | null };
    expect(raw.source_thread_id).toBeNull();

    // a later upsert fills subject_id …
    mem.upsertStub({ id: 'm1', text: 'hello v2', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1', subjectId: sid });
    expect(mem.getStub('m1')!.subject_id).toBe(sid);
    // … and a bare re-upsert (subjectId omitted) must NOT null the set primary.
    mem.upsertStub({ id: 'm1', text: 'hello v3', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    expect(mem.getStub('m1')!.subject_id).toBe(sid);

    expect(engine.getDb().prepare('SELECT COUNT(*) c FROM memories WHERE id = ?').get('m1')).toMatchObject({ c: 1 });
    engine.close();
  });

  it('encrypts the stub text at rest (S0 boundary: memories.text is PII-bearing)', () => {
    const { engine, mem } = make('vault-key-for-memgraph-1');
    mem.upsertStub({ id: 'm1', text: 'Customer Jane Roe owes CHF 4200', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    const raw = engine.getDb().prepare('SELECT text FROM memories WHERE id = ?').get('m1') as { text: string };
    expect(raw.text).toMatch(/^enc:/);
    expect(raw.text).not.toContain('Jane Roe');
    expect(raw.text).not.toContain('4200');
    expect(engine.dec(raw.text)).toBe('Customer Jane Roe owes CHF 4200');
    engine.close();
  });

  it('links subjects idempotently (memory_subjects junction)', () => {
    const { engine, mem, subs } = make();
    const a = subs.findOrCreate({ kind: 'organization', name: 'Acme' }).id;
    const b = subs.findOrCreate({ kind: 'person', name: 'Alice' }).id;
    mem.upsertStub({ id: 'm1', text: 't', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    mem.linkSubjects('m1', [a, b]);
    mem.linkSubjects('m1', [a]);   // re-link is a no-op (INSERT OR IGNORE)
    expect([...mem.getLinkedSubjectIds('m1')].sort()).toEqual([a, b].sort());
    engine.close();
  });

  it('bumps cooccurrences with canonical (a<b) ordering and counts re-mentions', () => {
    const { engine, mem, subs } = make();
    const a = subs.findOrCreate({ kind: 'organization', name: 'Acme' }).id;
    const b = subs.findOrCreate({ kind: 'person', name: 'Alice' }).id;
    mem.bumpCooccurrences([a, b]);
    mem.bumpCooccurrences([b, a]);       // reversed order collapses onto the same row
    mem.bumpCooccurrences([a, a, b]);    // duplicate input de-duped → still the (a,b) pair
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const row = engine.getDb().prepare('SELECT count FROM subject_cooccurrences WHERE subject_a_id = ? AND subject_b_id = ?').get(lo, hi) as { count: number };
    expect(row.count).toBe(3);
    expect(engine.getDb().prepare('SELECT COUNT(*) c FROM subject_cooccurrences').get()).toMatchObject({ c: 1 });
    engine.close();
  });

  it('bumpCooccurrences no-ops below 2 distinct subjects', () => {
    const { engine, mem, subs } = make();
    const a = subs.findOrCreate({ kind: 'organization', name: 'Acme' }).id;
    mem.bumpCooccurrences([a]);
    mem.bumpCooccurrences([a, a]);
    expect(engine.getDb().prepare('SELECT COUNT(*) c FROM subject_cooccurrences').get()).toMatchObject({ c: 0 });
    engine.close();
  });

  it('markSuperseded flips is_active and no-ops on a missing stub', () => {
    const { engine, mem } = make();
    mem.upsertStub({ id: 'old', text: 't', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    mem.markSuperseded('old', 'new');
    const stub = mem.getStub('old')!;
    expect(stub.is_active).toBe(0);
    expect(stub.superseded_by).toBe('new');
    expect(() => mem.markSuperseded('ghost', 'new')).not.toThrow();   // missing stub → silent no-op
    expect(mem.getStub('ghost')).toBeNull();
    engine.close();
  });

  it('deactivateByIds flips is_active for the given ids only, and no-ops on empty', () => {
    const { engine, mem } = make();
    mem.upsertStub({ id: 'm1', text: 'delete me', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    mem.upsertStub({ id: 'm2', text: 'delete me too', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    mem.upsertStub({ id: 'm3', text: 'keep me', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });

    const changed = mem.deactivateByIds(['m1', 'm2']);
    expect(changed).toBe(2);
    expect(mem.getStub('m1')!.is_active).toBe(0);
    expect(mem.getStub('m2')!.is_active).toBe(0);
    expect(mem.getStub('m3')!.is_active).toBe(1);   // untouched

    expect(mem.deactivateByIds([])).toBe(0);          // empty → no-op
    expect(mem.deactivateByIds(['ghost'])).toBe(0);   // unknown id → 0 changes, no throw
    engine.close();
  });

  it('carries embedding/is_active/superseded_by/confidence, and PRESERVES them on a bare re-upsert (S5a)', () => {
    const { engine, mem } = make();
    const emb = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    mem.upsertStub({
      id: 'm1', text: 't', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1',
      embedding: emb, isActive: 0, supersededBy: 'm2', confidence: 0.42,
    });
    let raw = engine.getDb().prepare('SELECT embedding, is_active, superseded_by, confidence FROM memories WHERE id = ?')
      .get('m1') as { embedding: Buffer; is_active: number; superseded_by: string; confidence: number };
    expect(raw.embedding.equals(emb)).toBe(true);
    expect(raw.is_active).toBe(0);
    expect(raw.superseded_by).toBe('m2');
    expect(raw.confidence).toBeCloseTo(0.42, 6);

    // A bare re-upsert (S1b-style, none of the four fields given) must NOT reset them.
    mem.upsertStub({ id: 'm1', text: 't v2', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    raw = engine.getDb().prepare('SELECT embedding, is_active, superseded_by, confidence FROM memories WHERE id = ?')
      .get('m1') as { embedding: Buffer; is_active: number; superseded_by: string; confidence: number };
    expect(raw.embedding.equals(emb)).toBe(true);   // vector preserved
    expect(raw.is_active).toBe(0);                   // supersession NOT revived
    expect(raw.superseded_by).toBe('m2');
    expect(raw.confidence).toBeCloseTo(0.42, 6);
    engine.close();
  });

  it('fresh insert with the four fields omitted takes the column defaults', () => {
    const { engine, mem } = make();
    mem.upsertStub({ id: 'm1', text: 't', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    const raw = engine.getDb().prepare('SELECT embedding, is_active, confidence FROM memories WHERE id = ?')
      .get('m1') as { embedding: Buffer | null; is_active: number; confidence: number };
    expect(raw.embedding).toBeNull();
    expect(raw.is_active).toBe(1);
    expect(raw.confidence).toBeCloseTo(0.75, 6);
    engine.close();
  });

  it('recordSupersedes inserts the junction only when both stubs exist (guarded, idempotent)', () => {
    const { engine, mem } = make();
    mem.upsertStub({ id: 'new', text: 't', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    mem.upsertStub({ id: 'old', text: 't', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    const count = (): number => (engine.getDb().prepare('SELECT COUNT(*) c FROM supersedes').get() as { c: number }).c;

    mem.recordSupersedes('new', 'old', 'contradiction');
    expect(count()).toBe(1);
    mem.recordSupersedes('new', 'old', 'contradiction');   // idempotent (INSERT OR IGNORE)
    expect(count()).toBe(1);
    // A pair with a missing endpoint is skipped (no FK throw, no row).
    expect(() => mem.recordSupersedes('new', 'ghost', 'contradiction')).not.toThrow();
    expect(count()).toBe(1);
    engine.close();
  });

  it('rebuildCooccurrences derives counts from the junction and is idempotent (no doubling)', () => {
    const { engine, mem, subs } = make();
    const a = subs.findOrCreate({ kind: 'organization', name: 'Acme' }).id;
    const b = subs.findOrCreate({ kind: 'person', name: 'Alice' }).id;
    const c = subs.findOrCreate({ kind: 'person', name: 'Bob' }).id;
    for (const id of ['m1', 'm2']) {
      mem.upsertStub({ id, text: 't', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
      mem.linkSubjects(id, [a, b]);         // m1,m2 both co-mention (Acme, Alice)
    }
    mem.upsertStub({ id: 'm3', text: 't', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    mem.linkSubjects('m3', [a, c]);          // m3 co-mentions (Acme, Bob)

    mem.rebuildCooccurrences();
    const pair = (x: string, y: string): number => {
      const [lo, hi] = x < y ? [x, y] : [y, x];
      return (engine.getDb().prepare('SELECT count FROM subject_cooccurrences WHERE subject_a_id = ? AND subject_b_id = ?')
        .get(lo, hi) as { count: number } | undefined)?.count ?? 0;
    };
    expect(pair(a, b)).toBe(2);   // Acme–Alice in m1,m2
    expect(pair(a, c)).toBe(1);   // Acme–Bob in m3
    expect(pair(b, c)).toBe(0);   // never co-mentioned

    mem.rebuildCooccurrences();   // re-run: full DELETE+re-aggregate, no doubling
    expect(pair(a, b)).toBe(2);
    expect(engine.getDb().prepare('SELECT COUNT(*) c FROM subject_cooccurrences').get()).toMatchObject({ c: 2 });
    engine.close();
  });

  it('CASCADE/SET NULL on subject hard-delete (links + cooccurrences drop, stub.subject_id nulls)', () => {
    const { engine, mem, subs } = make();
    const a = subs.findOrCreate({ kind: 'organization', name: 'Acme' }).id;
    const b = subs.findOrCreate({ kind: 'person', name: 'Alice' }).id;
    mem.upsertStub({ id: 'm1', text: 't', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1', subjectId: a });
    mem.linkSubjects('m1', [a, b]);
    mem.bumpCooccurrences([a, b]);

    engine.getDb().prepare('DELETE FROM subjects WHERE id = ?').run(a);
    expect(mem.getLinkedSubjectIds('m1')).toEqual([b]);                                  // memory_subjects CASCADE
    expect(engine.getDb().prepare('SELECT COUNT(*) c FROM subject_cooccurrences').get()).toMatchObject({ c: 0 }); // cooccurrence CASCADE
    expect(mem.getStub('m1')!.subject_id).toBeNull();                                    // memories.subject_id SET NULL
    engine.close();
  });
});
