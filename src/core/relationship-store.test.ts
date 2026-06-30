import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';

describe('RelationshipStore (Foundation Rework v2 — S1a)', () => {
  const tmpDirs: string[] = [];

  function make(): { rels: RelationshipStore; subs: SubjectStore; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-rel-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    return { rels: new RelationshipStore(engine), subs: new SubjectStore(engine), engine };
  }

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('creates and reads directional edges', () => {
    const { rels, subs, engine } = make();
    const person = subs.findOrCreate({ kind: 'person', name: 'Alice' }).id;
    const org = subs.findOrCreate({ kind: 'organization', name: 'Acme' }).id;
    const id = rels.createRelationship({ fromSubjectId: person, toSubjectId: org, kind: 'works_at', description: 'CTO since 2024' });
    expect(id).toBeTruthy();

    expect(rels.getRelationshipsFrom(person)).toHaveLength(1);
    expect(rels.getRelationshipsFrom(person, 'works_at')[0]!.description).toBe('CTO since 2024');
    expect(rels.getRelationshipsFrom(person, 'employed_by')).toHaveLength(0);
    expect(rels.getRelationshipsTo(org)).toHaveLength(1);
    expect(rels.getRelationshipsForSubject(org)).toHaveLength(1);
    engine.close();
  });

  it('is idempotent on the (from, kind, to) triple — re-assert updates, no duplicate', () => {
    const { rels, subs, engine } = make();
    const a = subs.findOrCreate({ kind: 'person', name: 'A' }).id;
    const b = subs.findOrCreate({ kind: 'organization', name: 'B' }).id;
    const id1 = rels.createRelationship({ fromSubjectId: a, toSubjectId: b, kind: 'works_at' });
    const id2 = rels.createRelationship({ fromSubjectId: a, toSubjectId: b, kind: 'works_at', description: 'now filled', confidence: 0.9 });
    expect(id2).toBe(id1);
    const edges = rels.getRelationshipsFrom(a, 'works_at');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.description).toBe('now filled');   // empty description didn't overwrite, but the filled one did
    expect(edges[0]!.confidence).toBe(0.9);
    engine.close();
  });

  it('CASCADE deletes edges when a subject is hard-deleted (FK ON DELETE CASCADE)', () => {
    const { rels, subs, engine } = make();
    const a = subs.findOrCreate({ kind: 'person', name: 'A' }).id;
    const b = subs.findOrCreate({ kind: 'organization', name: 'B' }).id;
    rels.createRelationship({ fromSubjectId: a, toSubjectId: b, kind: 'works_at' });
    engine.getDb().prepare('DELETE FROM subjects WHERE id = ?').run(a);
    expect(rels.getRelationshipsForSubject(b)).toHaveLength(0);
    engine.close();
  });
});
