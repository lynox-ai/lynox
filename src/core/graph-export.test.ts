import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMemoryDb, AGENT_MEMORY_SCHEMA_VERSION } from './agent-memory-db.js';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';
import { readHeldGraph } from './graph-export.js';

/**
 * The knowledge graph's held data, read for the export while no layer is open. Real files: the
 * point is what SQLite does with them, a write-ahead log left behind included.
 */

const sha = (file: string): string | null => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;

/**
 * Main file and -wal as bytes, the schema stamp and the -wal's size. The stamp is read from a copy
 * of both files, so taking the state does not touch the files it describes.
 */
function fileState(file: string): { main: string | null; wal: string | null; walSize: number | null; version: number } {
  const state = { main: sha(file), wal: sha(`${file}-wal`), walSize: existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : null };
  const copyDir = mkdtempSync(join(tmpdir(), 'lynox-graph-held-state-'));
  const copy = join(copyDir, 'state.db');
  try {
    copyFileSync(file, copy);
    if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${copy}-wal`);
    const probe = new Database(copy);
    try {
      return { ...state, version: (probe.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v };
    } finally {
      probe.close();
    }
  } finally {
    rmSync(copyDir, { recursive: true, force: true });
  }
}

/** Two entities and a relation between them whose source memory is not stored (as after a reap). */
function seedGraph(db: AgentMemoryDb): { alice: string; acme: string } {
  const alice = db.createEntity({ canonicalName: 'Alice', entityType: 'person', scopeType: 'global', scopeId: 'global' });
  const acme = db.createEntity({ canonicalName: 'ACME', entityType: 'organization', scopeType: 'global', scopeId: 'global' });
  db.createRelation(alice, acme, 'works_at', 'Alice works at ACME', 'm-not-stored');
  return { alice, acme };
}

describe('readHeldGraph', () => {
  let dir: string;
  let file: string;
  let engineDb: EngineDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-graph-held-'));
    file = join(dir, 'agent-memory.db');
    engineDb = new EngineDb(join(dir, 'engine.db'));
  });

  afterEach(() => {
    engineDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the entities and relations a switched-off graph still holds, as complete, without changing the file', async () => {
    const db = new AgentMemoryDb(file);
    seedGraph(db);
    db.close();
    expect(existsSync(`${file}-wal`), 'fixture: a clean close leaves no -wal').toBe(false);
    const before = fileState(file);

    const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: false });

    expect(held.entities.map(e => e.canonicalName).sort()).toEqual(['ACME', 'Alice']);
    expect(held.relationships.map(r => [r.relationType, r.description, r.sourceDeleted])).toEqual([['works_at', 'Alice works at ACME', false]]);
    expect(held.stats).toEqual({ memoryCount: 0, entityCount: 2, relationCount: 1, communityCount: 0 });
    expect(held.mayBeIncomplete, 'read in full, and no remembered text is held').toBe(false);
    const after = fileState(file);
    expect(after.main, 'the file is byte-identical').toBe(before.main);
    expect(after.version, 'the schema stamp is unchanged').toBe(before.version);
    // A WAL reader leaves an empty -wal (and an -shm) behind; it never holds a page.
    expect(after.walSize ?? 0, 'no page was written to a -wal').toBe(0);
  });

  it('reads the rows still in the -wal of a file left without a checkpoint, and changes neither file', async () => {
    const writer = new AgentMemoryDb(file);
    seedGraph(writer);
    // A crash image: main file and -wal as the process left them, without the checkpoint a
    // clean close runs.
    const image = join(dir, 'image.db');
    copyFileSync(file, image);
    copyFileSync(`${file}-wal`, `${image}-wal`);
    writer.close();
    expect(statSync(`${image}-wal`).size, 'fixture: the rows are in the -wal').toBeGreaterThan(0);
    const before = fileState(image);

    const held = await readHeldGraph({ agentMemoryFile: image, engineDb, subjectGraph: false });

    expect(held.entities.map(e => e.canonicalName).sort(), 'the rows in the -wal are read').toEqual(['ACME', 'Alice']);
    expect(held.relationships).toHaveLength(1);
    expect(held.mayBeIncomplete).toBe(false);
    const after = fileState(image);
    expect(after.main, 'main file unchanged: no checkpoint ran').toBe(before.main);
    expect(after.wal, 'the -wal is unchanged').toBe(before.wal);
  });

  it('reads beside a writer that still holds the file open, its uncommitted-to-main rows included', async () => {
    const writer = new AgentMemoryDb(file);
    try {
      seedGraph(writer);
      expect(statSync(`${file}-wal`).size, 'fixture: the rows are in the -wal').toBeGreaterThan(0);
      const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: false });
      expect(held.entities).toHaveLength(2);
    } finally {
      writer.close();
    }
  });

  it('marks the block while remembered texts or mentions are stored, which it does not carry', async () => {
    const db = new AgentMemoryDb(file);
    db.setEmbeddingDimensions(3);
    seedGraph(db);
    db.createMemory({ text: 'Alice prefers mornings', namespace: 'knowledge', scopeType: 'global', scopeId: 'global', embedding: [1, 0, 0] });
    db.close();

    const legacy = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: false });
    expect(legacy.entities, 'the graph is still read').toHaveLength(2);
    expect(legacy.stats.memoryCount).toBe(1);
    expect(legacy.mayBeIncomplete, 'a text in agent-memory.db').toBe(true);
  });

  it('marks the block while engine.db holds remembered texts', async () => {
    engineDb.getDb().prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, is_active) VALUES ('m1', 'held', 'knowledge', 'global', 'global', 0)").run();
    const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: false });
    expect(held.mayBeIncomplete, 'a text in engine.db, even one no longer active').toBe(true);
  });

  it('reads a fresh instance that never held graph data as complete', async () => {
    expect(existsSync(file), 'fixture: no agent-memory.db').toBe(false);
    const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: false });
    expect(held).toEqual({
      entities: [], relationships: [],
      stats: { memoryCount: 0, entityCount: 0, relationCount: 0, communityCount: 0 },
      mayBeIncomplete: false,
    });
    expect(existsSync(file), 'nothing was created').toBe(false);
  });

  it('marks the block when engine.db is not open, since its texts cannot be counted', async () => {
    const held = await readHeldGraph({ agentMemoryFile: file, engineDb: null, subjectGraph: false });
    expect(held.mayBeIncomplete).toBe(true);
  });

  it('reads a file stamped with an older schema and marks the block', async () => {
    const db = new AgentMemoryDb(file);
    seedGraph(db);
    db.close();
    const stamp = new Database(file);
    stamp.prepare('DELETE FROM schema_version WHERE version = ?').run(AGENT_MEMORY_SCHEMA_VERSION);
    stamp.close();

    const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: false });
    expect(held.entities, 'what it holds is still read').toHaveLength(2);
    expect(held.mayBeIncomplete, 'an older schema may hold more than this build reads').toBe(true);
  });

  it('gives an empty, marked block for a file stamped with a newer schema', async () => {
    const db = new AgentMemoryDb(file);
    seedGraph(db);
    db.close();
    const stamp = new Database(file);
    stamp.prepare('INSERT INTO schema_version (version) VALUES (?)').run(AGENT_MEMORY_SCHEMA_VERSION + 1);
    stamp.close();

    const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: false });
    expect(held.entities, 'a newer schema is not guessed at').toEqual([]);
    expect(held.mayBeIncomplete).toBe(true);
  });

  it('gives an empty, marked block for a file that is not a database', async () => {
    writeFileSync(file, 'not a database');
    const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: false });
    expect(held.entities).toEqual([]);
    expect(held.mayBeIncomplete).toBe(true);
  });

  it('reads the subject graph from engine.db when it is on, not the legacy file, as the layer does', async () => {
    const db = new AgentMemoryDb(file);
    seedGraph(db);
    db.close();
    const subjects = new SubjectStore(engineDb);
    const bob = subjects.createSubject({ kind: 'person', name: 'Bob' });
    const globex = subjects.createSubject({ kind: 'organization', name: 'Globex' });
    new RelationshipStore(engineDb).createRelationship({ fromSubjectId: bob, toSubjectId: globex, kind: 'works_at', description: 'Bob works at Globex' });

    const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: true });
    expect(held.entities.map(e => e.canonicalName).sort(), 'engine.db only: the legacy rows are mirrored there').toEqual(['Bob', 'Globex']);
    expect(held.relationships.map(r => r.description)).toEqual(['Bob works at Globex']);
    expect(held.stats.entityCount).toBe(2);
    expect(held.mayBeIncomplete).toBe(false);
  });

  it('marks the block when the subject graph is on and engine.db is not open', async () => {
    const db = new AgentMemoryDb(file);
    seedGraph(db);
    db.close();
    const held = await readHeldGraph({ agentMemoryFile: file, engineDb: null, subjectGraph: true });
    expect(held.entities, 'the legacy file is still read').toHaveLength(2);
    expect(held.mayBeIncomplete).toBe(true);
  });
});
