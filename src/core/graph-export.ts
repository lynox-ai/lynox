import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import type { EntityRecord, KnowledgeGraphStats, RelationRecord } from '../types/memory.js';
import type { EngineDb } from './engine-db.js';
import {
  AGENT_MEMORY_SCHEMA_VERSION, activeMemoryCountOn, agentMemoryVersionOn, entityCountOn,
  entityRelationsForExportOn, listEntitiesOn, memoryTextRowsOn, relationCountOn,
} from './agent-memory-db.js';
import { toEntityRecord } from './entity-resolver.js';
import { EXPORT_RELATIONS_PER_ENTITY, legacyRelationForExport, listSubjectEntitiesOn, relRowToRelationRecord } from './knowledge-layer.js';
import { countEngineMemoryRows } from './memory-graph-store.js';
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
  const entities: EntityRecord[] = [];
  let truncated = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await source.listEntities({ limit: PAGE, offset: page * PAGE });
    entities.push(...batch);
    if (batch.length < PAGE) { truncated = false; break; }
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

export interface HeldGraph {
  entities: EntityRecord[];
  relationships: ExportRelation[];
  stats: KnowledgeGraphStats;
  /** Not the whole of what is held: a read failed or was capped, the file's schema is not this
   * build's, or remembered texts are stored that the block does not carry. */
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
 * it) is read and marked; a newer one, or any failure, gives an empty block, marked.
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
      if (version > AGENT_MEMORY_SCHEMA_VERSION) return empty;
      if (version < AGENT_MEMORY_SCHEMA_VERSION) incomplete = true;
    }
    const db = legacy;
    // Remembered texts are held but not in this block (as on the layer's path): a missing
    // engine.db cannot show there are none.
    const textsHeld = opts.engineDb === null
      || countEngineMemoryRows(opts.engineDb) > 0
      || (db !== null && memoryTextRowsOn(db) > 0);
    const memoryCount = db ? activeMemoryCountOn(db) : 0;

    let source: GraphExportSource;
    let stats: KnowledgeGraphStats;
    if (opts.subjectGraph && opts.engineDb) {
      const subjects = new SubjectStore(opts.engineDb);
      const relationships = new RelationshipStore(opts.engineDb);
      source = {
        listEntities: (o) => listSubjectEntitiesOn(subjects, o),
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
      // The subject graph is on but engine.db is not open: what only engine.db holds is not read.
      if (opts.subjectGraph) incomplete = true;
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
      mayBeIncomplete: incomplete || collected.truncated || collected.relationCapHit || textsHeld,
    };
  } catch {
    process.stderr.write('⚠ /api/export: held knowledge graph could not be read — exported empty and marked incomplete\n');
    return empty;
  } finally {
    try { legacy?.close(); } catch { /* ignore */ }
  }
}
