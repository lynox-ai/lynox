import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import { embedToBlob } from './embedding.js';

/**
 * S5b: the engine.db RECALL reads on MemoryGraphStore — the read side of the memory
 * cutover. These port the legacy AgentMemoryDb recall queries (findSimilarMemories /
 * listActiveMemories / graph-expand) over engine.db, decrypt text on read, and skip
 * any row whose ciphertext can't be decrypted (keyless / wrong key) so recall never
 * surfaces an `enc:` blob. Dim is fixed at 4 so the cosine ordering is exact.
 */
describe('MemoryGraphStore recall reads (Foundation Rework v2 — S5b)', () => {
  const DIM = 4;
  const tmpDirs: string[] = [];

  function make(key = ''): { dir: string; engine: EngineDb; mem: MemoryGraphStore; subs: SubjectStore; rels: RelationshipStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-recall-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    return {
      dir, engine,
      mem: new MemoryGraphStore(engine),
      subs: new SubjectStore(engine),
      rels: new RelationshipStore(engine),
    };
  }

  /** Seed a memory stub carrying an explicit 4-dim vector. */
  function seed(
    mem: MemoryGraphStore,
    id: string,
    text: string,
    vec: number[],
    opts?: { namespace?: string; scopeType?: string; scopeId?: string; isActive?: number },
  ): void {
    mem.upsertStub({
      id, text,
      namespace: opts?.namespace ?? 'knowledge',
      scopeType: opts?.scopeType ?? 'context',
      scopeId: opts?.scopeId ?? 'c1',
      embedding: embedToBlob(vec),
      isActive: opts?.isActive,
    });
  }

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('findSimilarRecall ranks by cosine, honours topK, decrypts text', () => {
    const { engine, mem } = make('vault-key-recall-1');
    seed(mem, 'm-near', 'the closest memory', [1, 0, 0, 0]);
    seed(mem, 'm-mid', 'a middling memory', [0.7, 0.7, 0, 0]);
    seed(mem, 'm-far', 'an orthogonal memory', [0, 1, 0, 0]);

    const out = mem.findSimilarRecall([1, 0, 0, 0], DIM, 2, 0.1);
    expect(out.map(r => r.id)).toEqual(['m-near', 'm-mid']); // topK=2, far pruned
    expect(out[0]!._similarity).toBeCloseTo(1.0, 5);
    // text decrypted on read — never the enc: ciphertext.
    expect(out[0]!.text).toBe('the closest memory');
    expect(out[0]!.text).not.toMatch(/^enc:/);
    engine.close();
  });

  it('findSimilarRecall applies threshold + namespace + scope_type filters', () => {
    const { engine, mem } = make();
    seed(mem, 'm-k', 'knowledge ns', [1, 0, 0, 0], { namespace: 'knowledge' });
    seed(mem, 'm-e', 'episodic ns', [1, 0, 0, 0], { namespace: 'episodic' });
    seed(mem, 'm-user', 'user scope', [1, 0, 0, 0], { scopeType: 'user', scopeId: 'u1' });

    // namespace filter: only the knowledge row (m-user is knowledge+user scope too)
    const nsOnly = mem.findSimilarRecall([1, 0, 0, 0], DIM, 10, 0.5, { namespace: 'knowledge' });
    expect(nsOnly.map(r => r.id).sort()).toEqual(['m-k', 'm-user']);
    // scope_type filter
    const scoped = mem.findSimilarRecall([1, 0, 0, 0], DIM, 10, 0.5, { scopeTypes: ['user'] });
    expect(scoped.map(r => r.id)).toEqual(['m-user']);
    // threshold excludes the orthogonal
    seed(mem, 'm-ortho', 'orthogonal', [0, 1, 0, 0], { namespace: 'knowledge' });
    const thr = mem.findSimilarRecall([1, 0, 0, 0], DIM, 10, 0.9, { namespace: 'knowledge' });
    expect(thr.map(r => r.id)).not.toContain('m-ortho');
    engine.close();
  });

  it('findSimilarRecall respects activeOnly (default) and includes inactive when off', () => {
    const { engine, mem } = make();
    seed(mem, 'm-active', 'active', [1, 0, 0, 0], { isActive: 1 });
    seed(mem, 'm-dead', 'superseded', [1, 0, 0, 0], { isActive: 0 });

    expect(mem.findSimilarRecall([1, 0, 0, 0], DIM, 10, 0.5).map(r => r.id)).toEqual(['m-active']);
    expect(
      mem.findSimilarRecall([1, 0, 0, 0], DIM, 10, 0.5, { activeOnly: false }).map(r => r.id).sort(),
    ).toEqual(['m-active', 'm-dead']);
    engine.close();
  });

  it('findSimilarRecall mirrors the legacy scan-cap: an old match past the newest 500 is not scanned', () => {
    const { engine, mem } = make();
    const db = engine.getDb();
    const ins = db.prepare(
      `INSERT INTO memories (id, text, namespace, scope_type, scope_id, embedding, created_at)
       VALUES (?, ?, 'knowledge', 'context', 'c1', ?, ?)`,
    );
    // Oldest row (t=0) is the ONLY vector match; 500 newer non-matches bury it past
    // the min(max(topK*10,100),500) cap → recall must NOT return it (parity).
    ins.run('m-old-match', 'old match', embedToBlob([1, 0, 0, 0]), '2020-01-01T00:00:00.000Z');
    for (let i = 1; i <= 500; i++) {
      const ts = `2020-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`;
      ins.run(`m-new-${i}`, `noise ${i}`, embedToBlob([0, 1, 0, 0]), ts);
    }
    const capped = mem.findSimilarRecall([1, 0, 0, 0], DIM, 5, 0.9);
    expect(capped.map(r => r.id)).not.toContain('m-old-match');

    // Make it the NEWEST row → now within the cap → returned.
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run('2099-01-01T00:00:00.000Z', 'm-old-match');
    const found = mem.findSimilarRecall([1, 0, 0, 0], DIM, 5, 0.9);
    expect(found.map(r => r.id)).toContain('m-old-match');
    engine.close();
  });

  it('exhaustive dedup scan finds an old match past the retrieval window (S5b\'-a parity)', () => {
    const { engine, mem } = make();
    const db = engine.getDb();
    const ins = db.prepare(
      `INSERT INTO memories (id, text, namespace, scope_type, scope_id, embedding, created_at)
       VALUES (?, ?, 'knowledge', 'context', 'c1', ?, ?)`,
    );
    // Oldest row is the only match; 600 newer non-matches bury it PAST the
    // non-exhaustive retrieval cap (topK=1 → min(max(10,100),500) = 100) but WITHIN
    // the 5000 exhaustive cap.
    ins.run('m-old-dup', 'old duplicate', embedToBlob([1, 0, 0, 0]), '2020-01-01T00:00:00.000Z');
    for (let i = 1; i <= 600; i++) {
      const ts = `2020-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`;
      ins.run(`m-noise-${i}`, `noise ${i}`, embedToBlob([0, 1, 0, 0]), ts);
    }
    // Non-exhaustive (100 cap) misses it; exhaustive (5000 cap) finds it — the
    // dedup-vs-duplicate decision must not silently store a re-stated fact twice.
    expect(mem.findSimilarRecall([1, 0, 0, 0], DIM, 1, 0.9).map(r => r.id)).not.toContain('m-old-dup');
    expect(mem.findSimilarRecall([1, 0, 0, 0], DIM, 1, 0.9, { exhaustive: true }).map(r => r.id)).toContain('m-old-dup');
    engine.close();
  });

  it('recall NEVER surfaces an enc: blob — a keyless reopen skips the undecryptable row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-recall-keyless-'));
    tmpDirs.push(dir);
    const path = join(dir, 'engine.db');
    // Write encrypted (embedding is raw, so cosine still matches), then reopen keyless.
    const keyed = new EngineDb(path, 'vault-key-keyless');
    new MemoryGraphStore(keyed).upsertStub({
      id: 'm-secret', text: 'Jane Roe owes CHF 4200', namespace: 'knowledge',
      scopeType: 'context', scopeId: 'c1', embedding: embedToBlob([1, 0, 0, 0]),
    });
    keyed.close();

    const keyless = new EngineDb(path, '');
    const memKeyless = new MemoryGraphStore(keyless);
    // The embedding matches (raw), so cosine passes — but the text can't decrypt →
    // the row is dropped, not surfaced as ciphertext, and recall does not crash.
    const out = memKeyless.findSimilarRecall([1, 0, 0, 0], DIM, 10, 0.5);
    expect(out).toHaveLength(0);
    expect(memKeyless.listRecentActiveRecall('knowledge', [{ type: 'context', id: 'c1' }], 10)).toHaveLength(0);
    keyless.close();
  });

  it('listRecentActiveRecall returns newest-first, active-only, scope-filtered', () => {
    const { engine, mem } = make();
    const db = engine.getDb();
    const ins = db.prepare(
      `INSERT INTO memories (id, text, namespace, scope_type, scope_id, is_active, created_at)
       VALUES (?, ?, 'knowledge', 'context', 'c1', ?, ?)`,
    );
    ins.run('r-old', 'old', 1, '2021-01-01T00:00:00.000Z');
    ins.run('r-new', 'new', 1, '2023-01-01T00:00:00.000Z');
    ins.run('r-dead', 'dead', 0, '2024-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO memories (id, text, namespace, scope_type, scope_id, is_active, created_at)
       VALUES ('r-other', 'other scope', 'knowledge', 'user', 'u9', 1, '2025-01-01T00:00:00.000Z')`,
    ).run();

    const out = mem.listRecentActiveRecall('knowledge', [{ type: 'context', id: 'c1' }], 10);
    expect(out.map(r => r.id)).toEqual(['r-new', 'r-old']); // newest-first, dead + other-scope excluded
    engine.close();
  });

  it('upsertStub carries created_at (immutable) + confirmation_count (preserve-on-omit) for recall parity', () => {
    const { engine, mem } = make();
    const db = engine.getDb();
    const readScoreCols = (id: string) =>
      db.prepare('SELECT created_at, confirmation_count FROM memories WHERE id = ?').get(id) as
        { created_at: string; confirmation_count: number };

    // Insert with an explicit historical created_at + a confirmation count.
    mem.upsertStub({
      id: 'm1', text: 'historical fact', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1',
      createdAt: '2021-06-01T12:00:00.000Z', confirmationCount: 3,
    });
    expect(readScoreCols('m1')).toEqual({ created_at: '2021-06-01T12:00:00.000Z', confirmation_count: 3 });

    // Re-upsert omitting both: created_at is IMMUTABLE, confirmation_count PRESERVED.
    mem.upsertStub({ id: 'm1', text: 'historical fact v2', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    expect(readScoreCols('m1')).toEqual({ created_at: '2021-06-01T12:00:00.000Z', confirmation_count: 3 });

    // A fresh insert with neither takes the defaults (now + 0), never NULL.
    mem.upsertStub({ id: 'm2', text: 'fresh', namespace: 'knowledge', scopeType: 'context', scopeId: 'c1' });
    const m2 = readScoreCols('m2');
    expect(m2.confirmation_count).toBe(0);
    expect(m2.created_at).toMatch(/^\d{4}-\d{2}-\d{2}/); // datetime('now') default applied
    engine.close();
  });

  it('memoriesMentioningSubject + relatedMemoriesViaSubjects traverse the subject junctions', () => {
    const { engine, mem, subs, rels } = make();
    const alice = subs.findOrCreate({ kind: 'person', name: 'Alice' }).id;
    const acme = subs.findOrCreate({ kind: 'organization', name: 'Acme' }).id;
    rels.createRelationship({ fromSubjectId: alice, toSubjectId: acme, kind: 'works_at', description: 'CTO' });

    // Two memories mention Alice; one mentions Acme.
    seed(mem, 'm-a1', 'Alice memo one', [1, 0, 0, 0]);
    seed(mem, 'm-a2', 'Alice memo two', [1, 0, 0, 0]);
    seed(mem, 'm-acme', 'Acme memo', [0, 1, 0, 0]);
    mem.linkSubjects('m-a1', [alice]);
    mem.linkSubjects('m-a2', [alice]);
    mem.linkSubjects('m-acme', [acme]);

    // direct: both Alice memories (subject-dedup can surface a superset — assert both).
    expect(mem.memoriesMentioningSubject(alice, true, 10).map(r => r.id).sort())
      .toEqual(['m-a1', 'm-a2']);
    // related: via alice→acme edge, the Acme memory surfaces (excludes alice's own).
    expect(mem.relatedMemoriesViaSubjects(alice, true, 10).map(r => r.id)).toEqual(['m-acme']);
    // decrypted text carried through the join.
    expect(mem.memoriesMentioningSubject(alice, true, 10)[0]!.text).toMatch(/Alice memo/);
    engine.close();
  });
});
