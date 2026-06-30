import type { EngineDb } from './engine-db.js';
import type { AgentMemoryDb, EntityRow } from './agent-memory-db.js';
import { SubjectStore, entityTypeToSubjectKind } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';

/**
 * Foundation Rework v2 — S2 data backfill (Template A: the knowledge-graph re-map).
 *
 * Replays the legacy `agent-memory.db` entity/relation graph into the engine.db
 * subject-graph so a tenant's full history is present BEFORE `subject_graph_enabled`
 * flips ON (a flag-ON read serves the subject-graph EXCLUSIVELY — pre-mirror
 * entities would otherwise vanish).
 *
 * Why a GLOBAL re-map and not a per-memory replay of `_mirrorToSubjectGraph`:
 * the live mirror runs per fresh extraction and only ever sees the entities +
 * relations of ONE memory. The legacy `relations` table is GLOBAL (entity↔entity,
 * `source_memory_id` nullable) and `entities` can be ORPHAN (no mention). Replaying
 * per-memory would drop orphan entities, null-source relations, and any edge whose
 * endpoints were extracted across two memories — breaking the S2 acceptance gate
 * (flag-ON reads must equal the legacy reads). So this enumerates ALL entities then
 * ALL relations, reusing the SAME store primitives the live mirror uses
 * (`findOrCreate`, `createRelationship`) so the field mapping + enc boundary stay
 * single-sourced — only the orchestration differs (global, not per-memory).
 *
 * Scope: entities + relations only. Memory provenance stubs + co-occurrences are
 * NOT read by the flag-ON entity/relation reads (`stats().memoryCount` stays legacy
 * per S1d) and are deferred to the memory sprint (which re-quiesces for the vector
 * move anyway). CRM person-detail (email/phone) is Template B (`CRM.backfillSubjectGraph`).
 *
 * Idempotency (D9 — strict deterministic 1:1, fuzzy-merge → S5): re-running over
 * the same legacy snapshot is convergent. `findOrCreate` name-dedups
 * person/organization/product; `createRelationship` upserts on the (from,kind,to)
 * triple. `engagement` is the one always-insert kind (`project → engagement`), so it
 * is created with a DETERMINISTIC id keyed on the legacy entity id + a pre-check, so
 * a re-run reuses it instead of doubling.
 */

/** Prefix for the deterministic engagement subject id (re-run guard, see class doc). */
const ENGAGEMENT_ID_PREFIX = 's2eng-';

export interface BackfillCounts {
  entitiesMapped: number;   // legacy entities that became (or matched) a subject
  entitiesDropped: number;  // concept/location/collection/unknown → no subject kind
  relationsMapped: number;  // legacy relations re-pointed onto a subject↔subject edge
  relationsDropped: number; // an endpoint dropped/unmapped, or a self-loop
}

export class SubjectGraphBackfill {
  private readonly subjects: SubjectStore;
  private readonly relationships: RelationshipStore;

  constructor(
    private readonly engineDb: EngineDb,
    private readonly memoryDb: AgentMemoryDb,
  ) {
    this.subjects = new SubjectStore(engineDb);
    this.relationships = new RelationshipStore(engineDb);
  }

  /**
   * Run the entity + relation re-map. Atomic: the whole pass is ONE engine.db
   * transaction, so a mid-run failure leaves engine.db untouched (the cutover's
   * cold snapshot is the outer safety net; this is the inner one). Returns the
   * mapped/dropped counts the equivalence proof asserts against.
   */
  run(opts?: { pageSize?: number | undefined }): BackfillCounts {
    const pageSize = Math.max(1, opts?.pageSize ?? 500);
    const counts: BackfillCounts = { entitiesMapped: 0, entitiesDropped: 0, relationsMapped: 0, relationsDropped: 0 };
    // legacy entity id → subject id (many-to-one: exact-name dupes collapse via findOrCreate).
    const entityToSubject = new Map<string, string>();

    this.engineDb.getDb().transaction(() => {
      // Pass 1 — entities → subjects. listAllEntities (NOT listEntities, which
      // clamps to 200 + sorts by mention_count) so no entity past the first page
      // is dropped and pagination is stable + sort-free.
      for (let offset = 0; ; offset += pageSize) {
        const batch = this.memoryDb.listAllEntities({ limit: pageSize, offset });
        for (const e of batch) {
          const subjectId = this._mapEntity(e);
          if (subjectId === null) { counts.entitiesDropped++; continue; }
          entityToSubject.set(e.id, subjectId);
          counts.entitiesMapped++;
        }
        if (batch.length < pageSize) break;
      }

      // Pass 2 — relations → subject↔subject edges (re-pointed via the pass-1 map).
      for (let offset = 0; ; offset += pageSize) {
        const batch = this.memoryDb.listAllRelations({ limit: pageSize, offset });
        for (const r of batch) {
          const from = entityToSubject.get(r.from_entity_id);
          const to = entityToSubject.get(r.to_entity_id);
          // Skip an edge whose endpoint dropped to a non-subject kind or is unmapped,
          // and any self-loop (two surface forms of one subject collapsed to one node).
          if (!from || !to || from === to) { counts.relationsDropped++; continue; }
          // source_memory_id is intentionally NOT carried: relationships.source_memory_id
          // is a REAL FK to engine.db `memories`, and the memory-stub backfill is deferred
          // to the memory sprint (stubs aren't read by the flag-ON entity/relation surface).
          // The provenance link is re-established when that sprint lands the stubs.
          this.relationships.createRelationship({
            fromSubjectId: from,
            toSubjectId: to,
            kind: r.relation_type,
            description: r.description,
            confidence: r.confidence,
          });
          counts.relationsMapped++;
        }
        if (batch.length < pageSize) break;
      }
    })();

    return counts;
  }

  /**
   * Map one legacy entity to a subject id, or null when its type has no subject
   * kind (concept/location/collection/unknown — the D10 bounded drop). Dedup kinds
   * go through `findOrCreate` (name-dedup, re-run convergent); `engagement` is the
   * lone always-insert kind, so it gets a deterministic id keyed on the legacy id
   * with a pre-check — re-running reuses it rather than minting a duplicate.
   */
  private _mapEntity(e: EntityRow): string | null {
    const kind = entityTypeToSubjectKind(e.entity_type);
    if (!kind) return null;
    const aliases = this._parseAliases(e.aliases);
    if (kind === 'engagement') {
      const id = ENGAGEMENT_ID_PREFIX + e.id;
      if (!this.subjects.getSubject(id)) {
        this.subjects.createSubject({ id, kind, name: e.canonical_name, aliases });
      }
      return id;
    }
    return this.subjects.findOrCreate({ kind, name: e.canonical_name, aliases }).id;
  }

  private _parseAliases(raw: string): string[] {
    try {
      const parsed: unknown = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
    } catch {
      return [];
    }
  }
}
