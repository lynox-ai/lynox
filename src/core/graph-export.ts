import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import type { EntityRecord, KnowledgeGraphStats, RelationRecord } from '../types/memory.js';
import type { EngineDb } from './engine-db.js';
import {
  AGENT_MEMORY_SCHEMA_VERSION, activeMemoryCountOn, agentMemoryVersionOn, entityCountOn,
  entityRelationsForExportOn, listEntitiesOn, relationCountOn,
} from './agent-memory-db.js';
import { toEntityRecord } from './entity-resolver.js';
import { EXPORT_TABLES } from './export-tables.js';
import { EXPORT_RELATIONS_PER_ENTITY, legacyRelationForExport, listSubjectEntitiesAfterOn, listSubjectEntitiesOn, relRowToRelationRecord } from './knowledge-layer.js';
import { sourceDeletedSql } from './relation-source.js';
import { RelationshipStore } from './relationship-store.js';
import { ENTITY_MAPPABLE_SUBJECT_KINDS, SubjectStore } from './subject-store.js';

/**
 * The knowledge graph as the data export writes it, from either of two sources: the live layer
 * while the graph is switched on, or the stores read directly while it is switched off (switching
 * it off deletes nothing, so what it held is still stored and belongs in the answer to an access
 * request). Both go through {@link collectGraphForExport}, so the two blocks are built the same way.
 */

export type ExportRelation = RelationRecord & { sourceDeleted: boolean };

/** What the export needs from a graph store: the entities page by page, and each one's relations. */
export interface GraphExportSource {
  listEntities(opts: { limit: number; offset: number }): Promise<EntityRecord[]> | EntityRecord[];
  /**
   * The next page after the entity `after` (by key; `null` starts at the first). A source that
   * offers it is walked by key, which is linear; `null` means it cannot read that way, and the
   * walk pages with `listEntities` instead.
   */
  listEntitiesAfter?(after: string | null, limit: number): Promise<EntityRecord[] | null> | EntityRecord[] | null;
  getEntityRelationsForExport(entityId: string): Promise<ExportRelation[]> | ExportRelation[];
}

export const EXPORT_RELATIONSHIPS_NOTE = 'sourceDeleted: the memory this relation was derived from was removed, '
  + 'or replaced by a newer memory that contradicts it. '
  + 'The relation is no longer shown or used, and is removed at the next cleanup.';

const PAGE = 200;
const MAX_PAGES = 1000;

/**
 * Page through ALL entities and collect their relations. A single { limit: 200 } call silently
 * dropped every entity past the first 200 from a user's GDPR export (an Art. 15/20 completeness
 * gap). The page cap bounds a runaway loop; hitting it sets `truncated`. The per-entity relation
 * read is capped too (newest first); an entity that returns the cap may hold more, which sets
 * `relationCapHit`. Relations whose source memory was deleted are still stored, so they are
 * collected too, marked `sourceDeleted`.
 */
export async function collectGraphForExport(source: GraphExportSource): Promise<{
  entities: EntityRecord[]; relationships: ExportRelation[]; truncated: boolean; relationCapHit: boolean;
}> {
  let entities: EntityRecord[] | null = source.listEntitiesAfter ? await walkByKey(source.listEntitiesAfter.bind(source)) : null;
  let truncated = entities === null ? true : entities.length >= MAX_PAGES * PAGE;
  if (entities === null) {
    // No key walk, or it failed part way: page from the start, so no entity is counted twice.
    entities = [];
    truncated = true;
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await source.listEntities({ limit: PAGE, offset: page * PAGE });
      entities.push(...batch);
      if (batch.length < PAGE) { truncated = false; break; }
    }
  }
  if (truncated) {
    // Surfaced, not silent: hitting the cap means the export may be incomplete.
    process.stderr.write(`⚠ /api/export: entity export hit the ${MAX_PAGES * PAGE}-row cap — dump may be incomplete\n`);
  }
  const relationSet = new Map<string, ExportRelation>();
  let relationCapHit = false;
  for (const entity of entities) {
    const relations = await source.getEntityRelationsForExport(entity.id);
    if (relations.length >= EXPORT_RELATIONS_PER_ENTITY) relationCapHit = true;
    for (const rel of relations) {
      // The source is part of the key: the legacy store keeps one row per assertion, and a
      // deleted one must not stand in for a live one.
      const key = `${rel.fromEntityId}:${rel.toEntityId}:${rel.relationType}:${rel.sourceMemoryId}`;
      if (!relationSet.has(key)) relationSet.set(key, rel);
    }
  }
  return { entities, relationships: [...relationSet.values()], truncated, relationCapHit };
}

/** Walks every entity by key, page by page; `null` when the source cannot, or stops part way. */
async function walkByKey(
  next: (after: string | null, limit: number) => Promise<EntityRecord[] | null> | EntityRecord[] | null,
): Promise<EntityRecord[] | null> {
  const entities: EntityRecord[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await next(after, PAGE);
    if (batch === null) return null;
    entities.push(...batch);
    if (batch.length < PAGE) return entities;
    after = batch[batch.length - 1]!.id;
  }
  return entities;
}

export interface HeldGraph {
  entities: EntityRecord[];
  relationships: ExportRelation[];
  stats: KnowledgeGraphStats;
  /** Not the whole of what is held: a read failed or was capped, the file's schema is not this
   * build's, or the subject graph is on and engine.db is not open. */
  mayBeIncomplete: boolean;
}

const NO_STATS: KnowledgeGraphStats = { memoryCount: 0, entityCount: 0, relationCount: 0, communityCount: 0 };

/**
 * What the knowledge graph holds while no layer is open (switched off, or on but its layer did
 * not start), read the way the layer reads it: with `subjectGraph` from engine.db, otherwise from
 * agent-memory.db, and the memory count from agent-memory.db either way.
 *
 * agent-memory.db is opened `{ readonly: true, fileMustExist: true }`: no store constructor, so no
 * WAL switch, no pragma, no migration and no checkpoint, and the file and its `-wal` stay as they
 * are. Rows still in a `-wal` are read. SQLite does create or rewrite the `-shm` beside a WAL file
 * when it opens it, even read-only, and may leave an empty `-wal` behind: that is how WAL readers
 * and writers coordinate, and what makes this read safe next to an erasure writing the same file.
 * Do not "clean them up" and do not open with `immutable=1`, which ignores the `-wal`.
 *
 * A file stamped with an older schema (the graph was off while an update ran, so nothing migrated
 * it) is read and marked. One stamped with a newer schema is not guessed at: its half is left
 * unread and the block marked. A memory count that fails marks the block and keeps what was read;
 * any other failure gives an empty block, marked. The remembered texts themselves are read by
 * {@link readMemoryTextsForExport}.
 */
export async function readHeldGraph(opts: {
  agentMemoryFile: string;
  engineDb: EngineDb | null;
  subjectGraph: boolean;
}): Promise<HeldGraph> {
  const empty: HeldGraph = { entities: [], relationships: [], stats: { ...NO_STATS }, mayBeIncomplete: true };
  let legacy: Database.Database | null = null;
  try {
    let incomplete = false;
    if (existsSync(opts.agentMemoryFile)) {
      legacy = new Database(opts.agentMemoryFile, { readonly: true, fileMustExist: true });
      const version = agentMemoryVersionOn(legacy);
      if (version > AGENT_MEMORY_SCHEMA_VERSION) {
        legacy.close();
        legacy = null;
        incomplete = true;
      } else if (version < AGENT_MEMORY_SCHEMA_VERSION) {
        incomplete = true;
      }
    }
    const db = legacy;
    // With the subject graph on, what only engine.db holds cannot be read without it.
    if (opts.subjectGraph && !opts.engineDb) incomplete = true;
    let memoryCount = 0;
    try {
      memoryCount = db ? activeMemoryCountOn(db) : 0;
    } catch {
      incomplete = true;
    }

    let source: GraphExportSource;
    let stats: KnowledgeGraphStats;
    if (opts.subjectGraph && opts.engineDb) {
      const subjects = new SubjectStore(opts.engineDb);
      const relationships = new RelationshipStore(opts.engineDb);
      source = {
        listEntities: (o) => listSubjectEntitiesOn(subjects, o),
        listEntitiesAfter: (after, limit) => listSubjectEntitiesAfterOn(subjects, after, limit),
        getEntityRelationsForExport: (id) => relationships.getRelationshipsForSubjectForExport(id, EXPORT_RELATIONS_PER_ENTITY)
          .map(r => ({ ...relRowToRelationRecord(r), sourceDeleted: r.source_deleted === 1 })),
      };
      stats = {
        memoryCount,
        entityCount: subjects.count({ kinds: ENTITY_MAPPABLE_SUBJECT_KINDS }),
        relationCount: relationships.count(),
        communityCount: 0,
      };
    } else {
      // With the subject graph on and engine.db not open, what only engine.db holds is not read;
      // the block is marked above.
      if (db) {
        source = {
          listEntities: (o) => listEntitiesOn(db, o).map(toEntityRecord),
          getEntityRelationsForExport: (id) => entityRelationsForExportOn(db, id, EXPORT_RELATIONS_PER_ENTITY).map(legacyRelationForExport),
        };
        stats = { memoryCount, entityCount: entityCountOn(db), relationCount: relationCountOn(db), communityCount: 0 };
      } else {
        source = { listEntities: () => [], getEntityRelationsForExport: () => [] };
        stats = { ...NO_STATS };
      }
    }
    const collected = await collectGraphForExport(source);
    return {
      entities: collected.entities,
      relationships: collected.relationships,
      stats,
      mayBeIncomplete: incomplete || collected.truncated || collected.relationCapHit,
    };
  } catch {
    process.stderr.write('⚠ /api/export: held knowledge graph could not be read — exported empty and marked incomplete\n');
    return empty;
  } finally {
    try { legacy?.close(); } catch { /* ignore */ }
  }
}

/** What a remembered text that could not be decrypted reads as in the export. */
export const UNREADABLE_MEMORY_TEXT = '[not readable: stored encrypted and could not be decrypted]';

/** Rows read per table. A table that returns more is cut here and marks the block. */
export const MEMORY_TEXT_EXPORT_CAP = 20_000;

export const MEMORY_TEXTS_RELATIONSHIPS_NOTE = 'source_deleted: 1 when the memory this relation was derived from '
  + 'was removed or replaced by a newer memory that contradicts it; the relation is no longer shown or used. '
  + 'With source_deleted 0, a source_memory_id that names no row in memories, or none at all, means the memory it '
  + 'came from was deleted, or that no source was recorded.';

type ExportRow = Record<string, unknown>;

export interface HeldMemoryTexts {
  /** The legacy store: each remembered text, which entity it mentions, which text replaced which
   * (with its reason), which entities appear together, and the counters kept per text. With the
   * subject graph on, also its entities and relations, which the graph block then does not read;
   * with it off they are empty here, since the graph block lists them. */
  'agent-memory.db': {
    memories: ExportRow[]; mentions: ExportRow[]; supersedes: ExportRow[]; cooccurrences: ExportRow[]; metrics: ExportRow[];
    entities: ExportRow[]; relations: ExportRow[];
    /** Which remembered lines came from a source that was not checked: fingerprints, no text. */
    untrusted_lines: ExportRow[];
  };
  /** The subject-graph store: each remembered text, which subject it is about, every relation
   * between subjects (those of a kind the graph block does not list included), which text
   * replaced which, which subjects appear together, and in which conversation each subject was
   * first made. */
  'engine.db': {
    memories: ExportRow[]; memory_subjects: ExportRow[]; relationships: ExportRow[]; relationships_note: string;
    supersedes: ExportRow[]; subject_cooccurrences: ExportRow[]; subject_mints: ExportRow[];
  };
  /** Not the whole of what is held: a read failed or was cut at the cap, a text could not be
   * decrypted, agent-memory.db has a newer schema than this build, or engine.db is not open. */
  mayBeIncomplete: boolean;
}

/**
 * Every remembered text both stores hold, and what links it to the graph, for the data export.
 * Active or not: a text that was replaced or retired is still stored, and Art. 15 asks what is
 * held. Each row carries its stored columns except the embedding (numbers, no content of their
 * own), which is not even read. Every text, and a relationship's free-text description and
 * notes, and the reason one text replaced another, goes through `mask`, as the other blocks do;
 * engine.db texts are decrypted first, and
 * one that cannot be, or is not stored as text at all, is written as
 * {@link UNREADABLE_MEMORY_TEXT}, never as what is stored.
 *
 * engine.db's relationships are read in full whatever the subject-graph setting: the graph block
 * lists only the subjects it maps to entities and reads a capped number of relations for each.
 *
 * agent-memory.db is opened read-only, as {@link readHeldGraph} opens it and for the same
 * reasons; one stamped with a newer schema is left unread. engine.db is read on the engine's
 * own handle. Each table is read on its own: one that fails is left empty and marks the block,
 * the others are still read.
 */
export function readMemoryTextsForExport(opts: {
  agentMemoryFile: string;
  engineDb: EngineDb | null;
  mask: (text: string) => string;
  /** Whether the graph block is read from engine.db, as the layer reads it. Then agent-memory.db's
   * entities and relations are in no other block and are read here. */
  subjectGraph?: boolean;
  /** Rows per table; {@link MEMORY_TEXT_EXPORT_CAP} unless a test sets a smaller one. */
  cap?: number;
}): HeldMemoryTexts {
  const cap = opts.cap ?? MEMORY_TEXT_EXPORT_CAP;
  let incomplete = false;
  /** The table's columns, the embedding left out, as a select list for alias `t`. */
  const columns = (db: Database.Database, table: string): string =>
    (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>)
      .filter(c => c.name !== 'embedding')
      .map(c => `t."${c.name.replaceAll('"', '""')}"`)
      .join(', ');
  const read = (db: Database.Database, table: string, extra: string, order: string, label: string): ExportRow[] => {
    try {
      const rows = db.prepare(`SELECT ${columns(db, table)}${extra} FROM ${table} t ORDER BY ${order} LIMIT ?`).all(cap + 1) as ExportRow[];
      if (rows.length > cap) {
        incomplete = true;
        process.stderr.write(`⚠ /api/export: ${label} hit the ${String(cap)}-row cap — knowledge graph marked incomplete\n`);
        rows.length = cap;
      }
      return rows;
    } catch {
      incomplete = true;
      process.stderr.write(`⚠ /api/export: ${label} could not be read — knowledge graph marked incomplete\n`);
      return [];
    }
  };
  const maskField = (row: ExportRow, field: string): ExportRow =>
    typeof row[field] === 'string' ? { ...row, [field]: opts.mask(row[field]) } : row;
  /** A text that is not stored as text cannot be read as one, and is not written out as stored. */
  const unreadable = (row: ExportRow): ExportRow => {
    incomplete = true;
    return { ...row, text: UNREADABLE_MEMORY_TEXT };
  };

  const legacyHalf: HeldMemoryTexts['agent-memory.db'] = { memories: [], mentions: [], supersedes: [], cooccurrences: [], metrics: [], entities: [], relations: [], untrusted_lines: [] };
  let legacy: Database.Database | null = null;
  try {
    if (existsSync(opts.agentMemoryFile)) {
      legacy = new Database(opts.agentMemoryFile, { readonly: true, fileMustExist: true });
      if (agentMemoryVersionOn(legacy) > AGENT_MEMORY_SCHEMA_VERSION) {
        incomplete = true;
      } else {
        legacyHalf.memories = read(legacy, 'memories', '', 't.created_at, t.id', 'agent-memory.db memories')
          .map(row => typeof row['text'] === 'string' ? maskField(row, 'text') : unreadable(row));
        legacyHalf.mentions = read(legacy, 'mentions', '', 't.created_at, t.memory_id, t.entity_id', 'agent-memory.db mentions');
        legacyHalf.supersedes = read(legacy, 'supersedes', '', 't.created_at, t.new_memory_id, t.old_memory_id', 'agent-memory.db supersedes')
          .map(row => maskField(row, 'reason'));
        legacyHalf.cooccurrences = read(legacy, 'cooccurrences', '', 't.last_seen_at, t.entity_a_id, t.entity_b_id', 'agent-memory.db cooccurrences');
        legacyHalf.metrics = read(legacy, 'metrics', '', 't.computed_at, t.id', 'agent-memory.db metrics');
        // A file older than this build that has no such table yet (one the engine has not
        // migrated) holds no marked lines, so nothing is missing. A current file without it is
        // read anyway, and fails as unreadable.
        const older = agentMemoryVersionOn(legacy) < AGENT_MEMORY_SCHEMA_VERSION;
        const hasMarks = legacy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'untrusted_lines'").get() !== undefined;
        legacyHalf.untrusted_lines = older && !hasMarks ? [] : read(legacy, 'untrusted_lines', '', 't.created_at, t.namespace, t.key', 'agent-memory.db untrusted_lines');
        if (opts.subjectGraph === true) {
          legacyHalf.entities = read(legacy, 'entities', '', 't.first_seen_at, t.id', 'agent-memory.db entities')
            .map(row => ['canonical_name', 'aliases', 'description', 'metadata'].reduce(maskField, row));
          legacyHalf.relations = read(legacy, 'relations', '', 't.created_at, t.id', 'agent-memory.db relations')
            .map(row => maskField(maskField(row, 'relation_type'), 'description'));
        }
      }
    }
  } catch {
    incomplete = true;
    process.stderr.write('⚠ /api/export: agent-memory.db could not be opened for its remembered texts — knowledge graph marked incomplete\n');
  } finally {
    try { legacy?.close(); } catch { /* ignore */ }
  }

  const engineHalf: HeldMemoryTexts['engine.db'] = {
    memories: [], memory_subjects: [], relationships: [], relationships_note: MEMORY_TEXTS_RELATIONSHIPS_NOTE,
    supersedes: [], subject_cooccurrences: [], subject_mints: [],
  };
  if (opts.engineDb) {
    const engineDb = opts.engineDb;
    const db = engineDb.getDb();
    engineHalf.memories = read(db, 'memories', '', 't.created_at, t.id', 'engine.db memories')
      .map(row => {
        if (typeof row['text'] !== 'string') return unreadable(row);
        let plain: string | null = null;
        try { plain = engineDb.tryDec(row['text']); } catch { plain = null; }
        if (plain === null) return unreadable(row);
        return { ...row, text: opts.mask(plain) };
      });
    engineHalf.memory_subjects = read(db, 'memory_subjects', '', 't.created_at, t.memory_id, t.subject_id', 'engine.db memory_subjects');
    engineHalf.relationships = read(db, 'relationships', `, CASE WHEN ${sourceDeletedSql('t')} THEN 1 ELSE 0 END AS source_deleted`, 't.created_at, t.id', 'engine.db relationships')
      .map(row => maskField(maskField(row, 'description'), 'notes'));
    engineHalf.supersedes = read(db, 'supersedes', '', 't.created_at, t.new_memory_id, t.old_memory_id', 'engine.db supersedes')
      .map(row => maskField(row, 'reason'));
    engineHalf.subject_cooccurrences = read(db, 'subject_cooccurrences', '', 't.last_seen_at, t.subject_a_id, t.subject_b_id', 'engine.db subject_cooccurrences');
    engineHalf.subject_mints = read(db, 'subject_mints', '', 't.minted_at, t.subject_id', 'engine.db subject_mints');
  } else {
    // No engine.db: what it holds was not read, and cannot be shown to be nothing.
    incomplete = true;
  }

  return { 'agent-memory.db': legacyHalf, 'engine.db': engineHalf, mayBeIncomplete: incomplete };
}

/**
 * Whether the stores hold graph rows that no block of the export carries, counted, never read:
 *  - engine.db subjects the graph block does not list: with the subject graph on, archived ones
 *    and those of a kind it maps to no entity; with it off, every subject, since the block is
 *    then read from agent-memory.db;
 *  - any row in an agent-memory.db table this build does not export (one an older schema kept);
 *  - with the subject graph off, agent-memory.db relations neither of whose entities is stored,
 *    since the graph block collects relations through their entities (with it on, the legacy
 *    entities and relations are carried in full by {@link readMemoryTextsForExport}).
 * The export says "complete" only when nothing stored is left out, so any such row marks the
 * graph block. A count that cannot be taken (no engine.db, a newer or unreadable
 * agent-memory.db, a failed query) cannot show there are none, and answers `true` as well.
 */
export function graphHoldsRowsNotExported(opts: {
  agentMemoryFile: string;
  engineDb: EngineDb | null;
  subjectGraph: boolean;
}): boolean {
  if (!opts.engineDb) return true;
  try {
    const subjects = new SubjectStore(opts.engineDb);
    const all = subjects.count({ includeArchived: true });
    const listed = opts.subjectGraph ? subjects.count({ kinds: ENTITY_MAPPABLE_SUBJECT_KINDS }) : 0;
    if (all > listed) return true;
  } catch {
    return true;
  }
  if (!existsSync(opts.agentMemoryFile)) return false;
  let legacy: Database.Database | null = null;
  try {
    legacy = new Database(opts.agentMemoryFile, { readonly: true, fileMustExist: true });
    if (agentMemoryVersionOn(legacy) > AGENT_MEMORY_SCHEMA_VERSION) return true;
    // A file this build can read may still hold a table it no longer knows (an older schema keeps
    // what a later one dropped, as v1's `episodes`): any row in one is in no block.
    // The tables the archive's list names for this store: what it carries and what it names as
    // holding no content. The two exports read the same list, so they cannot drift apart.
    const listed = EXPORT_TABLES['agent-memory.db'];
    const known = [...Object.keys(listed.include), ...Object.keys(listed.name)];
    const other = legacy.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (${known.map(() => '?').join(', ')})`,
    ).all(...known) as Array<{ name: string }>;
    for (const t of other) {
      const row = legacy.prepare(`SELECT EXISTS (SELECT 1 FROM "${t.name.replaceAll('"', '""')}") AS e`).get() as { e: number };
      if (row.e === 1) return true;
    }
    if (opts.subjectGraph) return false;
    const rows = legacy.prepare(
      'SELECT COUNT(*) AS n FROM relations r WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.id IN (r.from_entity_id, r.to_entity_id))',
    ).get() as { n: number };
    return rows.n > 0;
  } catch {
    return true;
  } finally {
    try { legacy?.close(); } catch { /* ignore */ }
  }
}
