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
import { EXPORT_TABLES } from './export-tables.js';
import { MEMORY_TEXTS_RELATIONSHIPS_NOTE, MEMORY_TEXT_EXPORT_CAP, UNREADABLE_MEMORY_TEXT, graphHoldsRowsNotExported, readHeldGraph, readMemoryTextsForExport } from './graph-export.js';
import { EXPORT_RELATIONS_PER_ENTITY } from './knowledge-layer.js';

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

  it('does not mark the graph for stored remembered texts, which the export now reads on its own', async () => {
    const db = new AgentMemoryDb(file);
    db.setEmbeddingDimensions(3);
    seedGraph(db);
    db.createMemory({ text: 'Alice prefers mornings', namespace: 'knowledge', scopeType: 'global', scopeId: 'global', embedding: [1, 0, 0] });
    db.close();
    engineDb.getDb().prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, is_active) VALUES ('m1', 'held', 'knowledge', 'global', 'global', 0)").run();

    const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: false });
    expect(held.entities, 'the graph is still read').toHaveLength(2);
    expect(held.stats.memoryCount).toBe(1);
    expect(held.mayBeIncomplete, 'the texts are carried by readMemoryTextsForExport').toBe(false);
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

  it('marks the block when an entity reaches the per-entity relation limit', async () => {
    const db = new AgentMemoryDb(file);
    const hub = db.createEntity({ canonicalName: 'Hub', entityType: 'organization', scopeType: 'global', scopeId: 'global' });
    for (let i = 0; i < EXPORT_RELATIONS_PER_ENTITY; i++) {
      const spoke = db.createEntity({ canonicalName: `Spoke ${String(i)}`, entityType: 'person', scopeType: 'global', scopeId: 'global' });
      db.createRelation(spoke, hub, 'works_at', '', `m-${String(i)}`);
    }
    db.close();

    const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: false });
    expect(held.relationships).toHaveLength(EXPORT_RELATIONS_PER_ENTITY);
    expect(held.mayBeIncomplete, 'the hub may hold more relations than were read').toBe(true);
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

  it('takes the memory count from agent-memory.db with the subject graph on, as the layer does', async () => {
    const db = new AgentMemoryDb(file);
    db.setEmbeddingDimensions(3);
    db.createMemory({ text: 'Bob prefers mornings', namespace: 'knowledge', scopeType: 'global', scopeId: 'global', embedding: [1, 0, 0] });
    db.close();
    const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: true });
    expect(held.stats.memoryCount).toBe(1);
    expect(held.mayBeIncomplete, 'the subject graph was read in full').toBe(false);
  });

  it('keeps the subject graph and marks the block when the memory count fails', async () => {
    // A file whose `memories` table is gone: every count over it fails.
    const db = new AgentMemoryDb(file);
    db.close();
    const drop = new Database(file);
    drop.exec('DROP TABLE IF EXISTS mentions; DROP TABLE IF EXISTS memories');
    drop.close();
    const subjects = new SubjectStore(engineDb);
    subjects.createSubject({ kind: 'person', name: 'Bob' });

    const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: true });
    expect(held.entities.map(e => e.canonicalName), 'engine.db is still read').toEqual(['Bob']);
    expect(held.stats.memoryCount).toBe(0);
    expect(held.mayBeIncomplete).toBe(true);
  });

  it('still reads the subject graph when agent-memory.db is stamped with a newer schema', async () => {
    const db = new AgentMemoryDb(file);
    seedGraph(db);
    db.close();
    const stamp = new Database(file);
    stamp.prepare('INSERT INTO schema_version (version) VALUES (?)').run(AGENT_MEMORY_SCHEMA_VERSION + 1);
    stamp.close();
    const subjects = new SubjectStore(engineDb);
    subjects.createSubject({ kind: 'person', name: 'Bob' });

    const held = await readHeldGraph({ agentMemoryFile: file, engineDb, subjectGraph: true });
    expect(held.entities.map(e => e.canonicalName)).toEqual(['Bob']);
    expect(held.mayBeIncomplete, 'the newer file was left unread').toBe(true);
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

describe('readMemoryTextsForExport', () => {
  let dir: string;
  let file: string;
  let engineDb: EngineDb;
  const mask = (t: string): string => t.replaceAll('hunter2', '[masked]');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-memory-texts-'));
    file = join(dir, 'agent-memory.db');
    engineDb = new EngineDb(join(dir, 'engine.db'), 'memory-texts-test-key');
  });

  afterEach(() => {
    engineDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A legacy store with an active text, a text it replaced, and a mention of an entity. */
  function seedLegacy(): { oldId: string; newId: string; entity: string } {
    const db = new AgentMemoryDb(file);
    db.setEmbeddingDimensions(3);
    const oldId = db.createMemory({ text: 'Alice used password hunter2', namespace: 'knowledge', scopeType: 'global', scopeId: 'global', embedding: [1, 0, 0] });
    const newId = db.createMemory({ text: 'Alice prefers mornings', namespace: 'knowledge', scopeType: 'global', scopeId: 'global', embedding: [0, 1, 0] });
    db.supersedMemory(oldId, newId);
    const entity = db.createEntity({ canonicalName: 'Alice', entityType: 'person', scopeType: 'global', scopeId: 'global' });
    db.createMention(newId, entity);
    db.close();
    return { oldId, newId, entity };
  }

  it('carries every agent-memory.db table the archive carries, and the archive every one this export carries', () => {
    new AgentMemoryDb(file).close();
    const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask });
    // The graph block carries entities and relations with the subject graph off, this block with
    // it on; this block carries the rest on either setting.
    const carried = Object.keys(texts['agent-memory.db']).sort();
    expect(carried).toEqual(Object.keys(EXPORT_TABLES['agent-memory.db'].include).sort());
  });

  it('with the subject graph on, carries the agent-memory.db entities and relations, masked, and with it off leaves them to the graph block', () => {
    const db = new AgentMemoryDb(file);
    const alice = db.createEntity({ canonicalName: 'Alice', entityType: 'person', description: 'pin hunter2', scopeType: 'global', scopeId: 'global' });
    const acme = db.createEntity({ canonicalName: 'Acme', entityType: 'organization', scopeType: 'global', scopeId: 'global' });
    db.createRelation(alice, acme, 'hunter2_contact', 'badge hunter2', 'm-source');
    db.close();
    const on = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask, subjectGraph: true })['agent-memory.db'];
    expect(on.entities.map(r => [r['id'], r['canonical_name'], r['description']]).sort(), 'entities, masked').toEqual([[alice, 'Alice', 'pin [masked]'], [acme, 'Acme', '']].sort());
    expect(on.entities.every(r => !('embedding' in r)), 'no embedding').toBe(true);
    expect(on.relations.map(r => [r['from_entity_id'], r['to_entity_id'], r['relation_type'], r['description']]), 'relations, type and description masked').toEqual([[alice, acme, '[masked]_contact', 'badge [masked]']]);
    const off = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask, subjectGraph: false })['agent-memory.db'];
    expect([off.entities, off.relations], 'with it off the graph block lists them').toEqual([[], []]);
  });

  it('with the subject graph on, marks the block when the agent-memory.db entities or relations cannot be read', () => {
    for (const table of ['entities', 'relations']) {
      rmSync(file, { force: true });
      new AgentMemoryDb(file).close();
      const raw = new Database(file);
      raw.exec(`PRAGMA foreign_keys = OFF; DROP TABLE ${table}`);
      raw.close();
      const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask, subjectGraph: true });
      expect(texts.mayBeIncomplete, `without its ${table} table`).toBe(true);
      expect(readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask, subjectGraph: false }).mayBeIncomplete, `control: with it off ${table} is not read here`).toBe(false);
    }
  });

  it('carries the link and history tables of both stores, row by row, the reason a text was replaced masked', () => {
    const { oldId, newId, entity } = seedLegacy();
    const legacy = new AgentMemoryDb(file);
    const other = legacy.createEntity({ canonicalName: 'Acme', entityType: 'organization', scopeType: 'global', scopeId: 'global' });
    legacy.upsertMetric({ metricName: 'kg_extraction_refused', value: 2, sampleCount: 2, scopeType: 'memory', scopeId: oldId });
    legacy.close();
    const legacyRaw = new Database(file);
    try {
      legacyRaw.prepare("INSERT INTO supersedes (new_memory_id, old_memory_id, reason, created_at) VALUES (?, ?, 'it said hunter2', '2026-01-01')").run(newId, oldId);
      legacyRaw.prepare("INSERT INTO cooccurrences (entity_a_id, entity_b_id, count, last_seen_at) VALUES (?, ?, 3, '2026-01-01')").run(entity, other);
    } finally {
      legacyRaw.close();
    }
    const subjects = new SubjectStore(engineDb);
    const a = subjects.createSubject({ kind: 'person', name: 'A' });
    const b = subjects.createSubject({ kind: 'service', name: 'B' });
    const raw = engineDb.getDb();
    raw.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES ('o', ?, 'knowledge', 'global', 'global'), ('n', ?, 'knowledge', 'global', 'global')").run(engineDb.enc('old'), engineDb.enc('new'));
    raw.prepare("INSERT INTO supersedes (new_memory_id, old_memory_id, reason) VALUES ('n', 'o', 'was hunter2')").run();
    raw.prepare('INSERT INTO subject_cooccurrences (subject_a_id, subject_b_id, count) VALUES (?, ?, 4)').run(a, b);
    raw.prepare("INSERT INTO subject_mints (subject_id, thread_id) VALUES (?, 'thread-1')").run(a);

    const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask });
    const l = texts['agent-memory.db'];
    expect(l.supersedes.map(r => [r['new_memory_id'], r['old_memory_id'], r['reason']]), 'agent-memory.db supersedes, masked').toEqual([[newId, oldId, 'it said [masked]']]);
    expect(l.cooccurrences.map(r => [r['entity_a_id'], r['entity_b_id'], r['count']]), 'agent-memory.db cooccurrences').toEqual([[entity, other, 3]]);
    expect(l.metrics.map(r => [r['metric_name'], r['scope_type'], r['scope_id'], r['value']]), 'agent-memory.db metrics').toEqual([['kg_extraction_refused', 'memory', oldId, 2]]);
    const e = texts['engine.db'];
    expect(e.supersedes.map(r => [r['new_memory_id'], r['old_memory_id'], r['reason']]), 'engine.db supersedes, masked').toEqual([['n', 'o', 'was [masked]']]);
    expect(e.subject_cooccurrences.map(r => [r['subject_a_id'], r['subject_b_id'], r['count']]), 'engine.db subject_cooccurrences').toEqual([[a, b, 4]]);
    expect(e.subject_mints.map(r => [r['subject_id'], r['thread_id']]), 'engine.db subject_mints').toEqual([[a, 'thread-1']]);
    expect(texts.mayBeIncomplete, 'read in full').toBe(false);
  });

  it('reads every remembered text and mention of agent-memory.db, a replaced one included, masked, without the embedding', () => {
    const { oldId, newId, entity } = seedLegacy();
    const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask });
    const memories = texts['agent-memory.db'].memories;
    expect(memories.map(m => [m['id'], m['text'], m['is_active']]).sort()).toEqual([
      [oldId, 'Alice used password [masked]', 0],
      [newId, 'Alice prefers mornings', 1],
    ].sort());
    expect(memories.every(m => !('embedding' in m)), 'the embedding is left out').toBe(true);
    expect(texts['agent-memory.db'].mentions.map(m => [m['memory_id'], m['entity_id']])).toEqual([[newId, entity]]);
    expect(texts.mayBeIncomplete, 'read in full').toBe(false);
  });

  it('reads the texts still in the -wal of a file left without a checkpoint, and changes neither file nor its schema stamp', () => {
    const writer = new AgentMemoryDb(file);
    writer.setEmbeddingDimensions(3);
    writer.createMemory({ text: 'Dora prefers tea', namespace: 'knowledge', scopeType: 'global', scopeId: 'global', embedding: [1, 0, 0] });
    // A crash image: main file and -wal as the process left them, without the checkpoint a
    // clean close runs. A connection that may write checkpoints the -wal into the main file
    // when it closes; one opened read-only cannot.
    const image = join(dir, 'image.db');
    copyFileSync(file, image);
    copyFileSync(`${file}-wal`, `${image}-wal`);
    writer.close();
    expect(statSync(`${image}-wal`).size, 'fixture: the text is in the -wal').toBeGreaterThan(0);
    const before = fileState(image);
    const mtime = statSync(image).mtimeMs;

    const texts = readMemoryTextsForExport({ agentMemoryFile: image, engineDb, mask });
    expect(texts['agent-memory.db'].memories.map(m => m['text']), 'the row in the -wal is read').toEqual(['Dora prefers tea']);
    const after = fileState(image);
    expect(after.main, 'main file unchanged: no checkpoint ran').toBe(before.main);
    expect(after.wal, 'the -wal is unchanged').toBe(before.wal);
    expect(statSync(image).mtimeMs, 'the main file was not written').toBe(mtime);
    expect(after.version, 'the schema stamp is unchanged').toBe(before.version);
  });

  it('leaves a newer agent-memory.db unread and unmigrated, marks the block, and still reads engine.db', () => {
    seedLegacy();
    const stamp = new Database(file);
    stamp.prepare('INSERT INTO schema_version (version) VALUES (?)').run(AGENT_MEMORY_SCHEMA_VERSION + 1);
    stamp.close();
    engineDb.getDb().prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES ('e1', ?, 'knowledge', 'global', 'global')").run(engineDb.enc('Bob is in Bern'));
    const before = fileState(file);

    const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask });
    expect(texts['agent-memory.db'], 'a newer schema is not guessed at').toEqual({ memories: [], mentions: [], supersedes: [], cooccurrences: [], metrics: [], entities: [], relations: [] });
    expect(texts['engine.db'].memories.map(m => m['text'])).toEqual(['Bob is in Bern']);
    expect(texts.mayBeIncomplete).toBe(true);
    const after = fileState(file);
    expect(after.main).toBe(before.main);
    expect(after.version, 'not migrated').toBe(AGENT_MEMORY_SCHEMA_VERSION + 1);
  });

  it('reads engine.db texts decrypted and masked, their subjects, and every relationship, masked and marked by its source', () => {
    const subjects = new SubjectStore(engineDb);
    const bob = subjects.createSubject({ kind: 'person', name: 'Bob' });
    const globex = subjects.createSubject({ kind: 'organization', name: 'Globex' });
    const raw = engineDb.getDb();
    raw.prepare("INSERT INTO memories (id, text, namespace, subject_id, scope_type, scope_id, is_active, embedding) VALUES ('e1', ?, 'knowledge', ?, 'global', 'global', 0, x'00')").run(engineDb.enc('Bob uses hunter2'), bob);
    raw.prepare("INSERT INTO memory_subjects (memory_id, subject_id) VALUES ('e1', ?)").run(bob);
    new RelationshipStore(engineDb).createRelationship({ fromSubjectId: bob, toSubjectId: globex, kind: 'works_at', description: 'Bob told hunter2 at Globex' });
    raw.prepare("UPDATE relationships SET notes = 'note with hunter2', source_memory_id = 'e1'").run();
    expect(String((raw.prepare("SELECT text FROM memories WHERE id = 'e1'").get() as { text: string }).text).startsWith('enc:'), 'fixture: stored encrypted').toBe(true);

    const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask });
    expect(texts['engine.db'].memories.map(m => [m['id'], m['text'], m['is_active'], 'embedding' in m])).toEqual([['e1', 'Bob uses [masked]', 0, false]]);
    expect(texts['engine.db'].memory_subjects.map(m => [m['memory_id'], m['subject_id']])).toEqual([['e1', bob]]);
    expect(texts['engine.db'].relationships.map(r => [r['from_subject_id'], r['to_subject_id'], r['description'], r['notes'], r['source_deleted']]),
      'its source e1 is no longer active').toEqual([[bob, globex, 'Bob told [masked] at Globex', 'note with [masked]', 1]]);
    expect(texts['engine.db'].relationships_note).toBe(MEMORY_TEXTS_RELATIONSHIPS_NOTE);
    expect(texts.mayBeIncomplete).toBe(false);
  });

  it('carries a relationship between subjects the graph block does not list', () => {
    const subjects = new SubjectStore(engineDb);
    const hosting = subjects.createSubject({ kind: 'service', name: 'Hosting' });
    const misc = subjects.createSubject({ kind: 'other', name: 'Misc' });
    new RelationshipStore(engineDb).createRelationship({ fromSubjectId: hosting, toSubjectId: misc, kind: 'related_to', description: 'Hosting relates to Misc' });
    const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask });
    expect(texts['engine.db'].relationships.map(r => [r['description'], r['source_deleted']])).toEqual([['Hosting relates to Misc', 0]]);
  });

  it('writes a text stored as something other than text as the marker, and marks the block', () => {
    engineDb.getDb().prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES ('e3', x'656e633a41414141', 'knowledge', 'global', 'global')").run();
    const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask });
    expect(texts['engine.db'].memories.map(m => m['text'])).toEqual([UNREADABLE_MEMORY_TEXT]);
    expect(texts.mayBeIncomplete).toBe(true);
  });

  it('writes a text it cannot decrypt as the marker, never as ciphertext, and marks the block', () => {
    const ciphertext = engineDb.enc('Carol lives in Basel');
    engineDb.close();
    // Read with another key: the stored value does not decrypt.
    engineDb = new EngineDb(join(dir, 'engine.db'), 'another-key');
    engineDb.getDb().prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES ('e2', ?, 'knowledge', 'global', 'global')").run(ciphertext);

    const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask });
    expect(texts['engine.db'].memories.map(m => m['text'])).toEqual([UNREADABLE_MEMORY_TEXT]);
    const out = JSON.stringify(texts);
    expect(out.includes(ciphertext.slice(4, 24)), 'no part of the ciphertext is written').toBe(false);
    expect(out.includes('enc:'), 'no ciphertext prefix is written').toBe(false);
    expect(texts.mayBeIncomplete).toBe(true);
  });

  it('cuts a table at the cap and marks the block; one row under it is read in full', () => {
    const raw = engineDb.getDb();
    for (let i = 0; i < 3; i++) {
      raw.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES (?, ?, 'knowledge', 'global', 'global')").run(`e${String(i)}`, engineDb.enc(`text ${String(i)}`));
    }
    const at = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask, cap: 2 });
    expect(at['engine.db'].memories).toHaveLength(2);
    expect(at.mayBeIncomplete, 'more rows than the cap').toBe(true);

    const under = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask, cap: 3 });
    expect(under['engine.db'].memories).toHaveLength(3);
    expect(under.mayBeIncomplete, 'exactly the cap: every row was read').toBe(false);
    expect(MEMORY_TEXT_EXPORT_CAP, 'the default cap').toBe(20_000);
  });

  it('cuts every table at the cap, mentions, subjects and relationships included', () => {
    seedLegacy();
    const legacy = new AgentMemoryDb(file);
    const second = legacy.createEntity({ canonicalName: 'Bob', entityType: 'person', scopeType: 'global', scopeId: 'global' });
    const [first] = (legacy as unknown as { db: Database.Database }).db.prepare('SELECT id FROM memories').all() as Array<{ id: string }>;
    legacy.createMention(first!.id, second);
    legacy.close();
    const subjects = new SubjectStore(engineDb);
    const a = subjects.createSubject({ kind: 'person', name: 'A' });
    const b = subjects.createSubject({ kind: 'person', name: 'B' });
    const raw = engineDb.getDb();
    for (const id of ['x1', 'x2']) {
      raw.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES (?, 't', 'knowledge', 'global', 'global')").run(id);
      raw.prepare('INSERT INTO memory_subjects (memory_id, subject_id) VALUES (?, ?)').run(id, a);
    }
    const rels = new RelationshipStore(engineDb);
    rels.createRelationship({ fromSubjectId: a, toSubjectId: b, kind: 'knows', description: '' });
    rels.createRelationship({ fromSubjectId: b, toSubjectId: a, kind: 'knows', description: '' });

    const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask, cap: 1 });
    expect([
      texts['agent-memory.db'].memories.length, texts['agent-memory.db'].mentions.length,
      texts['engine.db'].memories.length, texts['engine.db'].memory_subjects.length, texts['engine.db'].relationships.length,
    ], 'each table holds two rows and is cut to one').toEqual([1, 1, 1, 1, 1]);
    expect(texts.mayBeIncomplete).toBe(true);
  });

  it('marks the block without engine.db, and still reads agent-memory.db', () => {
    seedLegacy();
    const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb: null, mask });
    expect(texts['agent-memory.db'].memories).toHaveLength(2);
    expect(texts['engine.db']).toEqual({ memories: [], memory_subjects: [], relationships: [], relationships_note: MEMORY_TEXTS_RELATIONSHIPS_NOTE, supersedes: [], subject_cooccurrences: [], subject_mints: [] });
    expect(texts.mayBeIncomplete, 'what engine.db holds was not read').toBe(true);
  });

  it('keeps the tables it could read when one cannot be read, and marks the block', () => {
    seedLegacy();
    const drop = new Database(file);
    drop.exec('DROP TABLE mentions');
    drop.close();
    const closed = new EngineDb(join(dir, 'closed.db'), 'memory-texts-test-key');
    closed.close();

    const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb: closed, mask });
    expect(texts['agent-memory.db'].memories, 'the texts are still read').toHaveLength(2);
    expect(texts['agent-memory.db'].mentions).toEqual([]);
    expect(texts['engine.db'].memories).toEqual([]);
    expect(texts.mayBeIncomplete).toBe(true);
  });

  it('reads a fresh instance that holds no texts as complete, and creates no agent-memory.db', () => {
    const texts = readMemoryTextsForExport({ agentMemoryFile: file, engineDb, mask });
    expect(texts).toEqual({
      'agent-memory.db': { memories: [], mentions: [], supersedes: [], cooccurrences: [], metrics: [], entities: [], relations: [] },
      'engine.db': { memories: [], memory_subjects: [], relationships: [], relationships_note: MEMORY_TEXTS_RELATIONSHIPS_NOTE, supersedes: [], subject_cooccurrences: [], subject_mints: [] },
      mayBeIncomplete: false,
    });
    expect(existsSync(file)).toBe(false);
  });
});

describe('graphHoldsRowsNotExported', () => {
  let dir: string;
  let file: string;
  let engineDb: EngineDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-not-exported-'));
    file = join(dir, 'agent-memory.db');
    engineDb = new EngineDb(join(dir, 'engine.db'), 'not-exported-test-key');
  });

  afterEach(() => {
    engineDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const held = (subjectGraph: boolean, db: EngineDb | null = engineDb) => graphHoldsRowsNotExported({ agentMemoryFile: file, engineDb: db, subjectGraph });

  it('finds nothing left out when every source is empty, on either setting', () => {
    new AgentMemoryDb(file).close();
    expect(held(true), 'subject graph on').toBe(false);
    expect(held(false), 'subject graph off').toBe(false);
  });

  it('with the subject graph on, no longer counts the agent-memory.db entities and relations, a relation without its entities included', () => {
    const db = new AgentMemoryDb(file);
    seedGraph(db);
    db.createEntity({ canonicalName: 'Eve', entityType: 'person', scopeType: 'global', scopeId: 'global' });
    db.close();
    expect(held(true), 'entities and relations are carried').toBe(false);
    const raw = new Database(file);
    raw.exec('PRAGMA foreign_keys = OFF; DELETE FROM entities');
    const left = raw.prepare('SELECT (SELECT COUNT(*) FROM entities) AS e, (SELECT COUNT(*) FROM relations) AS r').get();
    raw.close();
    expect(left, 'fixture: no entity, one relation').toEqual({ e: 0, r: 1 });
    expect(held(true), 'a relation with no entity left is carried too').toBe(false);
    expect(held(false), 'control: with it off the block reaches it through no entity').toBe(true);
  });

  it('with the subject graph on, finds an archived subject', () => {
    const subjects = new SubjectStore(engineDb);
    const bob = subjects.createSubject({ kind: 'person', name: 'Bob' });
    expect(held(true), 'fixture: a listed subject is exported').toBe(false);
    subjects.archiveSubject(bob);
    expect(held(true)).toBe(true);
  });

  it('with the subject graph on, finds a subject of a kind the block maps to no entity', () => {
    new SubjectStore(engineDb).createSubject({ kind: 'service', name: 'Hosting' });
    expect(held(true), 'service').toBe(true);
    engineDb.getDb().prepare("UPDATE subjects SET kind = 'other'").run();
    expect(held(true), 'other').toBe(true);
  });

  it('with the subject graph off, finds any subject, since the block then reads agent-memory.db', () => {
    new SubjectStore(engineDb).createSubject({ kind: 'person', name: 'Bob' });
    expect(held(false)).toBe(true);
  });

  it('no longer counts the engine.db link and history tables, which the export now carries: supersedes, subject co-occurrences, subject mints', () => {
    const subjects = new SubjectStore(engineDb);
    const a = subjects.createSubject({ kind: 'person', name: 'A' });
    const b = subjects.createSubject({ kind: 'person', name: 'B' });
    const raw = engineDb.getDb();
    raw.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES ('o', 't', 'knowledge', 'global', 'global'), ('n', 't', 'knowledge', 'global', 'global')").run();
    raw.prepare("INSERT INTO supersedes (new_memory_id, old_memory_id, reason) VALUES ('n', 'o', 'newer')").run();
    expect(held(true), 'supersedes').toBe(false);
    raw.prepare('INSERT INTO subject_cooccurrences (subject_a_id, subject_b_id) VALUES (?, ?)').run(a, b);
    expect(held(true), 'subject_cooccurrences').toBe(false);
    raw.prepare("INSERT INTO subject_mints (subject_id, thread_id) VALUES (?, 't1')").run(a);
    expect(held(true), 'subject_mints').toBe(false);
    subjects.archiveSubject(b);
    expect(held(true), 'control: an archived subject still counts').toBe(true);
  });

  it('does not count the agent-memory.db link and history tables, which the export now carries: supersedes, co-occurrences, metrics', () => {
    const db = new AgentMemoryDb(file);
    db.setEmbeddingDimensions(3);
    const { alice, acme } = seedGraph(db);
    const o = db.createMemory({ text: 'old', namespace: 'knowledge', scopeType: 'global', scopeId: 'global', embedding: [1, 0, 0] });
    const n = db.createMemory({ text: 'new', namespace: 'knowledge', scopeType: 'global', scopeId: 'global', embedding: [0, 1, 0] });
    db.upsertMetric({ metricName: 'kg_extraction_refused', value: 1, sampleCount: 1, scopeType: 'memory', scopeId: o });
    db.close();
    const raw = new Database(file);
    try {
      raw.prepare("INSERT INTO supersedes (new_memory_id, old_memory_id, reason, created_at) VALUES (?, ?, 'newer', '2026-01-01')").run(n, o);
      raw.prepare("INSERT INTO cooccurrences (entity_a_id, entity_b_id, last_seen_at) VALUES (?, ?, '2026-01-01')").run(alice, acme);
      expect(raw.prepare('SELECT (SELECT COUNT(*) FROM supersedes) + (SELECT COUNT(*) FROM cooccurrences) + (SELECT COUNT(*) FROM metrics) AS n').get(), 'fixture: a row in each').toEqual({ n: 3 });
    } finally {
      raw.close();
    }
    expect(held(false), 'with the subject graph off, where nothing else counts').toBe(false);
  });

  it('finds a row in an agent-memory.db table the export does not know, and not an empty one', () => {
    new AgentMemoryDb(file).close();
    const raw = new Database(file);
    try {
      raw.exec('CREATE TABLE episodes (id TEXT PRIMARY KEY, task TEXT NOT NULL)');
      expect(held(false), 'an empty leftover table holds nothing').toBe(false);
      expect(held(true), 'nor with the subject graph on').toBe(false);
      raw.prepare("INSERT INTO episodes (id, task) VALUES ('e1', 'call Alice')").run();
      expect(held(false), 'a row in it is in no block').toBe(true);
      expect(held(true), 'on either setting').toBe(true);
    } finally {
      raw.close();
    }
  });

  it('with the subject graph off, finds a relation neither of whose entities is stored, and not one the block reaches', () => {
    const db = new AgentMemoryDb(file);
    const { alice } = seedGraph(db);
    db.close();
    const raw = new Database(file);
    try {
      raw.exec('PRAGMA foreign_keys = OFF');
      raw.prepare('DELETE FROM entities WHERE id = ?').run(alice);
      expect(held(false), 'one entity left: the block reaches the relation through it').toBe(false);
      raw.exec('DELETE FROM entities');
      expect(raw.prepare('SELECT COUNT(*) AS n FROM relations').get(), 'fixture: the relation is still stored').toEqual({ n: 1 });
      expect(held(false), 'no entity left: the block cannot reach it').toBe(true);
    } finally {
      raw.close();
    }
  });

  it('answers true when a count cannot be taken: no engine.db, a closed one, a missing table, a newer or broken file', () => {
    expect(held(false, null), 'no engine.db').toBe(true);
    const closed = new EngineDb(join(dir, 'closed.db'), 'not-exported-test-key');
    closed.close();
    expect(held(false, closed), 'closed engine.db').toBe(true);

    const db = new AgentMemoryDb(file);
    db.close();
    const drop = new Database(file);
    drop.exec('DROP TABLE relations');
    drop.close();
    expect(held(false), 'agent-memory.db without its relations table').toBe(true);

    rmSync(file);
    new AgentMemoryDb(file).close();
    const stamp = new Database(file);
    stamp.prepare('INSERT INTO schema_version (version) VALUES (?)').run(AGENT_MEMORY_SCHEMA_VERSION + 1);
    stamp.close();
    expect(held(true), 'a newer agent-memory.db').toBe(true);

    rmSync(file);
    writeFileSync(file, 'not a database');
    expect(held(true), 'a file that is not a database').toBe(true);
  });

  it('counts the rows still in a -wal and changes neither file', () => {
    const writer = new AgentMemoryDb(file);
    const raw = new Database(file);
    raw.pragma('foreign_keys = OFF');
    raw.prepare("INSERT INTO relations (id, from_entity_id, to_entity_id, relation_type, created_at) VALUES ('r-orphan', 'gone-a', 'gone-b', 'knows', '2026-01-01')").run();
    const image = join(dir, 'image.db');
    copyFileSync(file, image);
    copyFileSync(`${file}-wal`, `${image}-wal`);
    raw.close();
    writer.close();
    expect(statSync(`${image}-wal`).size, 'fixture: the -wal holds pages').toBeGreaterThan(0);
    const mainOnly = join(dir, 'main-only.db');
    copyFileSync(image, mainOnly);
    const probe = new Database(mainOnly, { readonly: true });
    try {
      const hasTable = (probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'relations'").get() as { n: number }).n === 1;
      const inMain = hasTable ? (probe.prepare("SELECT COUNT(*) AS n FROM relations WHERE id = 'r-orphan'").get() as { n: number }).n : 0;
      expect(inMain, 'fixture: the relation is not in the main file').toBe(0);
    } finally {
      probe.close();
    }
    const before = fileState(image);

    expect(graphHoldsRowsNotExported({ agentMemoryFile: image, engineDb, subjectGraph: false }), 'the row in the -wal is counted').toBe(true);
    const after = fileState(image);
    expect(after.main, 'main file unchanged: no checkpoint ran').toBe(before.main);
    expect(after.wal, 'the -wal is unchanged').toBe(before.wal);
  });
});
