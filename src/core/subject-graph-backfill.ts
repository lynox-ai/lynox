import type { EngineDb } from './engine-db.js';
import type { AgentMemoryDb, EntityRow } from './agent-memory-db.js';
import { SubjectStore, entityTypeToSubjectKind } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';

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
 * Scope: entities + relations by default. The S5a memory-statement backfill (the
 * memory sprint) is an OPT-IN third pass (`run({ includeMemories: true })`) that
 * shares this same transaction + the pass-1 `entityToSubject` map — so a memory
 * links to the exact subjects its mentions resolved to. It stays opt-in so the S2
 * callers (`s2-backfill`) keep their entities+relations-only contract unchanged.
 * CRM person-detail (email/phone) is Template B (`CRM.backfillSubjectGraph`).
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
  // S5a memory pass (0 unless run({ includeMemories: true })).
  memoriesMapped: number;      // legacy memory statements replayed into engine.db
  memoriesSubjectless: number; // of those, how many resolved NO subject (still stored)
  supersedesMapped: number;    // supersession provenance edges replayed
}

export class SubjectGraphBackfill {
  private readonly subjects: SubjectStore;
  private readonly relationships: RelationshipStore;
  private readonly memoryGraph: MemoryGraphStore;

  constructor(
    private readonly engineDb: EngineDb,
    private readonly memoryDb: AgentMemoryDb,
  ) {
    this.subjects = new SubjectStore(engineDb);
    this.relationships = new RelationshipStore(engineDb);
    this.memoryGraph = new MemoryGraphStore(engineDb);
  }

  /**
   * Run the entity + relation re-map. Atomic: the whole pass is ONE engine.db
   * transaction, so a mid-run failure leaves engine.db untouched (the cutover's
   * cold snapshot is the outer safety net; this is the inner one). Returns the
   * mapped/dropped counts the equivalence proof asserts against.
   */
  run(opts?: { pageSize?: number | undefined; includeMemories?: boolean | undefined }): BackfillCounts {
    const pageSize = Math.max(1, opts?.pageSize ?? 500);
    const counts: BackfillCounts = {
      entitiesMapped: 0, entitiesDropped: 0, relationsMapped: 0, relationsDropped: 0,
      memoriesMapped: 0, memoriesSubjectless: 0, supersedesMapped: 0,
    };
    // legacy entity id → subject id (many-to-one: exact-name dupes collapse via findOrCreate).
    const entityToSubject = new Map<string, string>();
    // subject id → its kind, for the memory pass's primary-subject pick (person/org-first).
    const subjectKind = new Map<string, string>();

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
          // Same kind _mapEntity used (subjectId != null ⟹ a mappable kind).
          const kind = entityTypeToSubjectKind(e.entity_type);
          if (kind) subjectKind.set(subjectId, kind);
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
          // source_memory_id is intentionally NOT carried here: relationships.source_memory_id
          // is a REAL FK to engine.db `memories`. Even with the S5a memory pass on, an edge
          // created in pass 2 predates its memory stub (pass 3), so re-establishing edge
          // provenance is a follow-up (it needs a legacy-relation → engine-relationship id
          // map pass 2 does not keep). The memory STUBS themselves land in pass 3.
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

      // Pass 3 — memory statements (opt-in). Shares this transaction + the pass-1
      // map so a memory links to the exact subjects its mentions resolved to.
      if (opts?.includeMemories) {
        this._backfillMemories(pageSize, entityToSubject, subjectKind, counts);
      }
    })();

    return counts;
  }

  /**
   * Pass 3 — replay legacy `memories` into engine.db, carrying the embedding BLOB +
   * lifecycle (is_active/superseded_by/confidence) byte-for-byte, link each memory
   * to the subjects it mentions, replay the supersedes provenance, and rebuild the
   * derived co-occurrence counts. Runs INSIDE {@link run}'s transaction (the caller
   * gates it on `includeMemories`) so it can reuse the pass-1 `entityToSubject` map.
   */
  private _backfillMemories(
    pageSize: number,
    entityToSubject: Map<string, string>,
    subjectKind: Map<string, string>,
    counts: BackfillCounts,
  ): void {
    // Index mentions by memory id (memory → mentioned legacy entity ids) so the
    // per-memory subject resolve is a map lookup, not an N+1 query.
    const mentionsByMemory = new Map<string, string[]>();
    for (let offset = 0; ; offset += pageSize) {
      const batch = this.memoryDb.listAllMentions({ limit: pageSize, offset });
      for (const m of batch) {
        const arr = mentionsByMemory.get(m.memory_id);
        if (arr) arr.push(m.entity_id);
        else mentionsByMemory.set(m.memory_id, [m.entity_id]);
      }
      if (batch.length < pageSize) break;
    }

    // Replay each memory statement into the engine.db stub + its subject links. A
    // memory that resolves NO subject is STILL stored (subject_id is nullable) — the
    // S5a mirror-harden lets a subject-less memory participate in vector recall.
    for (let offset = 0; ; offset += pageSize) {
      const batch = this.memoryDb.listAllMemories({ limit: pageSize, offset });
      for (const mem of batch) {
        const entityIds = mentionsByMemory.get(mem.id) ?? [];
        const subjectIds = [...new Set(
          entityIds.map(eid => entityToSubject.get(eid)).filter((s): s is string => s !== undefined),
        )];
        this.memoryGraph.upsertStub({
          id: mem.id,
          text: mem.text,
          namespace: mem.namespace,
          scopeType: mem.scope_type,
          scopeId: mem.scope_id,
          subjectId: this._pickPrimarySubject(subjectIds, subjectKind),
          sourceRunId: mem.source_run_id,
          sourceType: mem.source_type,
          sourceToolName: mem.source_tool_name,
          provider: mem.provider,
          embedding: mem.embedding,      // Buffer|null → carried byte-for-byte (no re-embed)
          isActive: mem.is_active,
          supersededBy: mem.superseded_by,
          confidence: mem.confidence,
        });
        if (subjectIds.length > 0) this.memoryGraph.linkSubjects(mem.id, subjectIds);
        counts.memoriesMapped++;
        if (subjectIds.length === 0) counts.memoriesSubjectless++;
      }
      if (batch.length < pageSize) break;
    }

    // Supersession provenance — replayed AFTER every stub exists so both FK
    // endpoints resolve (recordSupersedes skips a pair a GC removed a memory from).
    for (const s of this.memoryDb.listAllSupersedes()) {
      this.memoryGraph.recordSupersedes(s.new_memory_id, s.old_memory_id, s.reason);
      counts.supersedesMapped++;
    }

    // subject_cooccurrences is a DERIVED materialization — rebuild it deterministically
    // from the freshly-linked memory_subjects so a re-run never doubles the counts.
    this.memoryGraph.rebuildCooccurrences();
  }

  /**
   * Pick a memory's primary subject with the live mirror's POLICY
   * (`_mirrorToSubjectGraph`): the first person/organization the memory concerns,
   * else the first resolved subject of any kind; null when it resolved none. The
   * "first" here is the stable mention scan order (by memory_id, entity_id), NOT the
   * mirror's extraction order — so for a memory with 2+ co-equal person/org subjects
   * the resolved primary can differ from what the live mirror chose. That only moves
   * the denormalized `memories.subject_id` pointer (the `memory_subjects` links are
   * identical either way); the pick is deterministic per store, so a re-run is
   * idempotent. Unifying the tie-break is a follow-up if the pointer ever matters.
   */
  private _pickPrimarySubject(subjectIds: string[], subjectKind: Map<string, string>): string | null {
    let first: string | null = null;
    for (const sid of subjectIds) {
      if (first === null) first = sid;
      const kind = subjectKind.get(sid);
      if (kind === 'person' || kind === 'organization') return sid;
    }
    return first;
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
