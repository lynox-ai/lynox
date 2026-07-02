/**
 * Unified Agent Memory — SQLite storage layer.
 *
 * Replaces LadybugDB (KuzuGraph) with a single crash-safe SQLite database.
 * Uses better-sqlite3 (already a project dependency) with WAL mode.
 *
 * Tables: memories, entities, relations, mentions, cooccurrences, supersedes,
 *         thread_insights, metrics.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { embedToBlob, blobToEmbed, cosineSimilarity } from './embedding.js';
import { channels } from './observability.js';
import { DEFAULT_PROVENANCE_KIND, type ProvenanceKind } from '../types/memory.js';

/** Row cap for an `exhaustive` similarity scan (dedup). 50× the old dedup floor
 *  of 100 so an older duplicate past the newest window is caught, but still a
 *  hard ceiling: an uncapped SELECT would do an O(N) blob-decode + cosine on
 *  every store() for a large, ceiling-less scope (e.g. `global`). A single scope
 *  realistically stays well under this because dedup + GC keep it bounded. */
const DEDUP_EXHAUSTIVE_SCAN_LIMIT = 5_000;

// ── Row Types (internal, not exported) ──────────────────────────

export interface MemoryRow {
  id: string;
  text: string;
  namespace: string;
  scope_type: string;
  scope_id: string;
  source_run_id: string | null;
  source_episode_id: string | null;
  provider: string | null;
  embedding: Buffer | null;
  confidence: number;
  is_active: number;
  superseded_by: string | null;
  retrieval_count: number;
  confirmation_count: number;
  last_retrieved_at: string | null;
  created_at: string;
  updated_at: string;
  // v5 provenance lifecycle — present on every row (NOT NULL DEFAULT backfill).
  source_type: string;
  source_tool_name: string | null;
}

export interface EntityRow {
  id: string;
  canonical_name: string;
  entity_type: string;
  aliases: string;       // JSON array
  description: string;
  scope_type: string;
  scope_id: string;
  mention_count: number;
  embedding: Buffer | null;
  metadata: string;      // JSON object
  first_seen_at: string;
  last_seen_at: string;
}

export interface RelationRow {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: string;
  description: string;
  confidence: number;
  source_memory_id: string | null;
  created_at: string;
}

export interface MentionRow {
  memory_id: string;
  entity_id: string;
  mention_type: string;
  created_at: string;
}

export interface CooccurrenceRow {
  entity_a_id: string;
  entity_b_id: string;
  count: number;
  last_seen_at: string;
}

export interface MetricRow {
  id: string;
  metric_name: string;
  scope_type: string | null;
  scope_id: string | null;
  value: number;
  sample_count: number;
  window: string;
  computed_at: string;
}

// ── Scored memory (vector search result) ────────────────────────

export interface ScoredMemoryRow extends MemoryRow {
  _similarity: number;
}

// ── Migration SQL ───────────────────────────────────────────────

const MIGRATIONS: string[] = [
  // v1: Full Agent Memory schema
  `INSERT OR IGNORE INTO schema_version (version) VALUES (1);

   CREATE TABLE IF NOT EXISTS memories (
     id TEXT PRIMARY KEY,
     text TEXT NOT NULL,
     namespace TEXT NOT NULL,
     scope_type TEXT NOT NULL,
     scope_id TEXT NOT NULL,
     source_run_id TEXT,
     source_episode_id TEXT,
     provider TEXT,
     embedding BLOB,
     confidence REAL NOT NULL DEFAULT 0.75,
     is_active INTEGER NOT NULL DEFAULT 1,
     superseded_by TEXT,
     retrieval_count INTEGER NOT NULL DEFAULT 0,
     confirmation_count INTEGER NOT NULL DEFAULT 0,
     last_retrieved_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );

   CREATE TABLE IF NOT EXISTS entities (
     id TEXT PRIMARY KEY,
     canonical_name TEXT NOT NULL,
     entity_type TEXT NOT NULL,
     aliases TEXT NOT NULL DEFAULT '[]',
     description TEXT NOT NULL DEFAULT '',
     scope_type TEXT NOT NULL,
     scope_id TEXT NOT NULL,
     mention_count INTEGER NOT NULL DEFAULT 1,
     embedding BLOB,
     metadata TEXT NOT NULL DEFAULT '{}',
     first_seen_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL
   );

   CREATE TABLE IF NOT EXISTS relations (
     id TEXT PRIMARY KEY,
     from_entity_id TEXT NOT NULL REFERENCES entities(id),
     to_entity_id TEXT NOT NULL REFERENCES entities(id),
     relation_type TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     confidence REAL NOT NULL DEFAULT 1.0,
     source_memory_id TEXT,
     created_at TEXT NOT NULL
   );

   CREATE TABLE IF NOT EXISTS mentions (
     memory_id TEXT NOT NULL REFERENCES memories(id),
     entity_id TEXT NOT NULL REFERENCES entities(id),
     mention_type TEXT NOT NULL DEFAULT 'direct',
     created_at TEXT NOT NULL,
     PRIMARY KEY (memory_id, entity_id)
   );

   CREATE TABLE IF NOT EXISTS cooccurrences (
     entity_a_id TEXT NOT NULL REFERENCES entities(id),
     entity_b_id TEXT NOT NULL REFERENCES entities(id),
     count INTEGER NOT NULL DEFAULT 1,
     last_seen_at TEXT NOT NULL,
     PRIMARY KEY (entity_a_id, entity_b_id)
   );

   CREATE TABLE IF NOT EXISTS supersedes (
     new_memory_id TEXT NOT NULL REFERENCES memories(id),
     old_memory_id TEXT NOT NULL REFERENCES memories(id),
     reason TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (new_memory_id, old_memory_id)
   );

   CREATE TABLE IF NOT EXISTS episodes (
     id TEXT PRIMARY KEY,
     run_id TEXT,
     session_id TEXT,
     task TEXT NOT NULL,
     approach TEXT,
     outcome TEXT,
     outcome_signal TEXT NOT NULL DEFAULT 'unknown',
     tools_used TEXT NOT NULL DEFAULT '[]',
     entities_involved TEXT NOT NULL DEFAULT '[]',
     memories_created TEXT NOT NULL DEFAULT '[]',
     duration_ms INTEGER,
     token_cost REAL,
     user_feedback TEXT,
     created_at TEXT NOT NULL
   );

   CREATE TABLE IF NOT EXISTS metrics (
     id TEXT PRIMARY KEY,
     metric_name TEXT NOT NULL,
     scope_type TEXT,
     scope_id TEXT,
     value REAL NOT NULL,
     sample_count INTEGER NOT NULL DEFAULT 1,
     window TEXT NOT NULL DEFAULT 'all_time',
     computed_at TEXT NOT NULL
   );

   CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace, is_active);
   CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope_type, scope_id, is_active);
   CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
   CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(canonical_name COLLATE NOCASE);
   CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
   CREATE INDEX IF NOT EXISTS idx_entities_scope ON entities(scope_type, scope_id);
   CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
   CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);
   CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions(entity_id);
   CREATE INDEX IF NOT EXISTS idx_episodes_run ON episodes(run_id);
   CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at);
   CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(metric_name, window);`,

  // v2: Drop episodes table (data now lives in RunHistory)
  `INSERT OR IGNORE INTO schema_version (version) VALUES (2);
   DROP TABLE IF EXISTS episodes;
   DROP TABLE IF EXISTS episodes_deprecated;
   DROP TABLE IF EXISTS thread_insights;`,

  // v3: Per-thread source tracking (for private-mode purge)
  `INSERT OR IGNORE INTO schema_version (version) VALUES (3);
   ALTER TABLE memories ADD COLUMN source_thread_id TEXT;
   CREATE INDEX IF NOT EXISTS idx_memories_thread ON memories(source_thread_id);`,

  // v4: Drop patterns table (behavioral pattern-detection removed — dead feature)
  `INSERT OR IGNORE INTO schema_version (version) VALUES (4);
   DROP INDEX IF EXISTS idx_patterns_type;
   DROP TABLE IF EXISTS patterns;`,

  // v5: Provenance lifecycle (PRD v3) — capture the source tier of each datum.
  // NOT NULL DEFAULT backfills every pre-existing row to the conservative
  // 'agent_inferred' tier (we cannot retroactively know if it was user/tool).
  `INSERT OR IGNORE INTO schema_version (version) VALUES (5);
   ALTER TABLE memories ADD COLUMN source_type TEXT NOT NULL DEFAULT 'agent_inferred';
   ALTER TABLE memories ADD COLUMN source_tool_name TEXT;`,
];

// ── Database Class ──────────────────────────────────────────────

/**
 * Low-level SQLite wrapper for the Unified Agent Memory.
 * All methods are synchronous (better-sqlite3 is sync).
 * Follows RunHistory constructor pattern.
 */
export class AgentMemoryDb {
  private db: Database.Database;
  private readonly dbPath: string;
  private _embeddingDimensions: number | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._ensureSchemaVersion();
    this._migrate();
  }

  get path(): string { return this.dbPath; }

  close(): void {
    this.db.close();
  }

  /** Set expected embedding dimensions (for blobToEmbed). */
  setEmbeddingDimensions(dim: number): void {
    this._embeddingDimensions = dim;
  }

  // ── Schema Migration ──────────────────────────────────────────

  private _ensureSchemaVersion(): void {
    this.db.prepare('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)').run();
  }

  private _getVersion(): number {
    try {
      const row = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number } | undefined;
      return row?.v ?? 0;
    } catch {
      return 0;
    }
  }

  private _migrate(): void {
    const currentVersion = this._getVersion();
    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      // Run each migration atomically. db.exec auto-commits each statement, and
      // every migration stamps schema_version BEFORE its DDL — so a crash (or a
      // failing statement) between the stamp and the DDL would leave the version
      // bumped but the schema un-applied. The migration is then skipped forever
      // and every query hits the missing table/column: the DB is bricked. The
      // wrapping transaction makes the stamp + DDL all-or-nothing, so a failure
      // rolls the stamp back and the migration retries cleanly on next boot.
      this.db.transaction(() => { this.db.exec(MIGRATIONS[i]!); })();
    }
  }

  // ── Entity Operations ─────────────────────────────────────────

  createEntity(props: {
    id?: string | undefined;
    canonicalName: string;
    entityType: string;
    aliases?: string[] | undefined;
    description?: string | undefined;
    scopeType: string;
    scopeId: string;
    embedding?: number[] | undefined;
    metadata?: string | undefined;
  }): string {
    const id = props.id ?? randomUUID();
    const now = new Date().toISOString();
    const aliases = props.aliases ?? [props.canonicalName];
    const embBlob = props.embedding ? embedToBlob(props.embedding) : null;

    this.db.prepare(`
      INSERT INTO entities (id, canonical_name, entity_type, aliases, description,
        scope_type, scope_id, mention_count, embedding, metadata, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      id, props.canonicalName, props.entityType, JSON.stringify(aliases),
      props.description ?? '', props.scopeType, props.scopeId,
      embBlob, props.metadata ?? '{}', now, now,
    );

    if (channels.knowledgeEntity.hasSubscribers) {
      channels.knowledgeEntity.publish({ event: 'entity_created', id, name: props.canonicalName, type: props.entityType });
    }

    return id;
  }

  findEntityByCanonicalName(name: string, scopeTypes?: string[] | undefined): EntityRow | null {
    if (scopeTypes && scopeTypes.length > 0) {
      const placeholders = scopeTypes.map(() => '?').join(',');
      return this.db.prepare(`
        SELECT * FROM entities
        WHERE canonical_name = ? COLLATE NOCASE
          AND scope_type IN (${placeholders})
        LIMIT 1
      `).get(name, ...scopeTypes) as EntityRow | undefined ?? null;
    }
    return this.db.prepare(`
      SELECT * FROM entities WHERE canonical_name = ? COLLATE NOCASE LIMIT 1
    `).get(name) as EntityRow | undefined ?? null;
  }

  findEntityByAlias(alias: string): EntityRow | null {
    // JSON array search: look for the alias string within the JSON aliases column
    const escaped = alias.replace(/[%_]/g, c => `\\${c}`);
    return this.db.prepare(`
      SELECT * FROM entities
      WHERE aliases LIKE ? ESCAPE '\\'
      LIMIT 1
    `).get(`%"${escaped}"%`) as EntityRow | undefined ?? null;
  }

  getEntity(id: string): EntityRow | null {
    return this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined ?? null;
  }

  incrementEntityMentions(entityId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE entities SET mention_count = mention_count + 1, last_seen_at = ? WHERE id = ?
    `).run(now, entityId);
  }

  addEntityAlias(entityId: string, alias: string): void {
    const row = this.getEntity(entityId);
    if (!row) return;
    const aliases = JSON.parse(row.aliases) as string[];
    if (aliases.includes(alias)) return;
    aliases.push(alias);
    this.db.prepare('UPDATE entities SET aliases = ? WHERE id = ?').run(JSON.stringify(aliases), entityId);
  }

  listEntities(opts?: { type?: string | undefined; limit?: number | undefined; offset?: number | undefined }): EntityRow[] {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const offset = Math.max(opts?.offset ?? 0, 0);
    if (opts?.type) {
      return this.db.prepare(`
        SELECT * FROM entities WHERE entity_type = ? ORDER BY mention_count DESC LIMIT ? OFFSET ?
      `).all(opts.type, limit, offset) as EntityRow[];
    }
    return this.db.prepare(`
      SELECT * FROM entities ORDER BY mention_count DESC LIMIT ? OFFSET ?
    `).all(limit, offset) as EntityRow[];
  }

  getEntityCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM entities').get() as { cnt: number };
    return row.cnt;
  }

  deleteEntity(entityId: string): void {
    this.db.prepare('DELETE FROM mentions WHERE entity_id = ?').run(entityId);
    this.db.prepare('DELETE FROM cooccurrences WHERE entity_a_id = ? OR entity_b_id = ?').run(entityId, entityId);
    this.db.prepare('DELETE FROM relations WHERE from_entity_id = ? OR to_entity_id = ?').run(entityId, entityId);
    this.db.prepare('DELETE FROM entities WHERE id = ?').run(entityId);
  }

  /**
   * Re-point every graph reference from `sourceId` onto `targetId` — used by an
   * entity MERGE so the merge does not silently DROP the source's mentions,
   * relations and cooccurrences (a `deleteEntity` alone hard-deletes them). Run
   * this BEFORE `deleteEntity(sourceId)`: the OR IGNORE updates move whatever the
   * target doesn't already have, and `deleteEntity` then removes the leftovers
   * that collided with an existing target row. Atomic (all-or-nothing).
   */
  repointEntityReferences(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    this.transaction((): void => {
      // mentions PK (memory_id, entity_id): OR IGNORE skips a memory the target
      // already mentions; the leftover source rows are cleaned by deleteEntity.
      this.db.prepare('UPDATE OR IGNORE mentions SET entity_id = ? WHERE entity_id = ?').run(targetId, sourceId);
      // relations keyed by a surrogate id (no unique on the triple): re-point
      // both endpoints, then drop the self-loop the merge collapsed into (a
      // former source→target edge becomes target→target — meaningless). Scope
      // the delete to the TARGET's own self-loop — an unscoped `from = to` would
      // wipe every unrelated reflexive edge (`Z→Z`) in the whole table.
      this.db.prepare('UPDATE relations SET from_entity_id = ? WHERE from_entity_id = ?').run(targetId, sourceId);
      this.db.prepare('UPDATE relations SET to_entity_id = ? WHERE to_entity_id = ?').run(targetId, sourceId);
      this.db.prepare('DELETE FROM relations WHERE from_entity_id = ? AND to_entity_id = ?').run(targetId, targetId);
      // cooccurrences PK (entity_a_id, entity_b_id): OR IGNORE on collision, then
      // drop the self-cooccurrence a merged source↔target pair produced — again
      // scoped to the target so unrelated self-cooccurrences are untouched.
      this.db.prepare('UPDATE OR IGNORE cooccurrences SET entity_a_id = ? WHERE entity_a_id = ?').run(targetId, sourceId);
      this.db.prepare('UPDATE OR IGNORE cooccurrences SET entity_b_id = ? WHERE entity_b_id = ?').run(targetId, sourceId);
      this.db.prepare('DELETE FROM cooccurrences WHERE entity_a_id = ? AND entity_b_id = ?').run(targetId, targetId);
    });
  }

  /**
   * Purge all knowledge extracted from a specific thread.
   * Uses subqueries instead of IN-list placeholders to avoid SQLite's 999-param limit.
   * Deletes memories, orphaned entities (reference-counted), and their relations.
   * Returns count of deleted memories.
   */
  purgeByThread(threadId: string): number {
    return this.transaction(() => {
      const countRow = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM memories WHERE source_thread_id = ?',
      ).get(threadId) as { cnt: number };

      if (countRow.cnt === 0) return 0;

      // Subquery used everywhere — avoids placeholder overflow for large threads
      const memSub = 'SELECT id FROM memories WHERE source_thread_id = ?';

      // 1. Find orphan entities: only mentioned by this thread's memories
      const orphanEntities = this.db.prepare(`
        SELECT DISTINCT m.entity_id FROM mentions m
        WHERE m.memory_id IN (${memSub})
        AND NOT EXISTS (
          SELECT 1 FROM mentions m2
          WHERE m2.entity_id = m.entity_id
          AND m2.memory_id NOT IN (${memSub})
        )
      `).all(threadId, threadId) as Array<{ entity_id: string }>;

      // 2. Delete mentions for these memories
      this.db.prepare(`DELETE FROM mentions WHERE memory_id IN (${memSub})`).run(threadId);

      // 3. Delete relations sourced from these memories
      this.db.prepare(`DELETE FROM relations WHERE source_memory_id IN (${memSub})`).run(threadId);

      // 4. Clean supersedes: clear superseded_by pointers, then delete records
      this.db.prepare(`UPDATE memories SET superseded_by = NULL WHERE superseded_by IN (${memSub})`).run(threadId);
      this.db.prepare(`DELETE FROM supersedes WHERE new_memory_id IN (${memSub}) OR old_memory_id IN (${memSub})`).run(threadId, threadId);

      // 5. Delete orphan entities (and their cooccurrences/relations)
      if (orphanEntities.length > 0) {
        const deleteCooc = this.db.prepare('DELETE FROM cooccurrences WHERE entity_a_id = ? OR entity_b_id = ?');
        const deleteRel = this.db.prepare('DELETE FROM relations WHERE from_entity_id = ? OR to_entity_id = ?');
        const deleteEnt = this.db.prepare('DELETE FROM entities WHERE id = ?');
        for (const oe of orphanEntities) {
          deleteCooc.run(oe.entity_id, oe.entity_id);
          deleteRel.run(oe.entity_id, oe.entity_id);
          deleteEnt.run(oe.entity_id);
        }
      }

      // 6. Delete the memories themselves
      this.db.prepare('DELETE FROM memories WHERE source_thread_id = ?').run(threadId);

      return countRow.cnt;
    });
  }

  // ── Memory Operations ─────────────────────────────────────────

  createMemory(props: {
    id?: string | undefined;
    text: string;
    namespace: string;
    scopeType: string;
    scopeId: string;
    sourceRunId?: string | undefined;
    sourceThreadId?: string | undefined;
    sourceType?: ProvenanceKind | undefined;
    sourceToolName?: string | undefined;
    provider?: string | undefined;
    embedding: number[];
  }): string {
    const id = props.id ?? randomUUID();
    const now = new Date().toISOString();
    const embBlob = embedToBlob(props.embedding);

    this.db.prepare(`
      INSERT INTO memories (id, text, namespace, scope_type, scope_id, source_run_id,
        source_thread_id, source_type, source_tool_name, provider, embedding, confidence,
        is_active, retrieval_count, confirmation_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.75, 1, 0, 0, ?, ?)
    `).run(
      id, props.text, props.namespace, props.scopeType, props.scopeId,
      props.sourceRunId ?? null, props.sourceThreadId ?? null,
      props.sourceType ?? DEFAULT_PROVENANCE_KIND, props.sourceToolName ?? null,
      props.provider ?? 'onnx', embBlob, now, now,
    );

    return id;
  }

  getMemory(id: string): MemoryRow | null {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined ?? null;
  }

  supersedMemory(memoryId: string, supersededById: string): void {
    this.db.prepare(`
      UPDATE memories SET is_active = 0, superseded_by = ?, updated_at = ? WHERE id = ?
    `).run(supersededById, new Date().toISOString(), memoryId);
  }

  /** Increment confirmation count and boost confidence (capped at 1.0). Called on dedup match. */
  confirmMemory(memoryId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE memories SET confirmation_count = confirmation_count + 1,
        confidence = MIN(confidence + 0.05, 1.0), updated_at = ? WHERE id = ?
    `).run(now, memoryId);
  }

  updateMemoryRetrieved(memoryId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE memories SET retrieval_count = retrieval_count + 1, last_retrieved_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, memoryId);
  }

  findMemoriesByTextPattern(pattern: string, namespace?: string | undefined): MemoryRow[] {
    if (namespace) {
      return this.db.prepare(`
        SELECT * FROM memories WHERE is_active = 1 AND text LIKE ? AND namespace = ?
      `).all(`%${pattern}%`, namespace) as MemoryRow[];
    }
    return this.db.prepare(`
      SELECT * FROM memories WHERE is_active = 1 AND text LIKE ?
    `).all(`%${pattern}%`) as MemoryRow[];
  }

  /**
   * Find an active memory by exact text match within an optional namespace and
   * scope set. Returns the most recent match (created_at DESC). Used by the
   * supersession-aware update path: equality, not substring — so an "update of
   * X" only fires on an exact prior X, not on any line that happens to contain X.
   */
  findActiveMemoryByExactText(
    text: string,
    namespace?: string | undefined,
    scopes?: Array<{ type: string; id: string }> | undefined,
  ): MemoryRow | null {
    const clauses: string[] = ['is_active = 1', 'text = ?'];
    const params: unknown[] = [text];
    if (namespace) {
      clauses.push('namespace = ?');
      params.push(namespace);
    }
    if (scopes && scopes.length > 0) {
      const scopeClauses = scopes.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
      clauses.push(`(${scopeClauses})`);
      for (const s of scopes) { params.push(s.type, s.id); }
    }
    const row = this.db.prepare(
      `SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 1`,
    ).get(...params) as MemoryRow | undefined;
    return row ?? null;
  }

  /**
   * List the most recently-created active memories filtered by namespace and a
   * set of scopes. Returns rows in `created_at DESC` order, capped at `limit`.
   * Used by `memory_recall` for the no-query path (the query path uses vector
   * search via `findSimilarMemories`).
   */
  listActiveMemories(
    namespace: string,
    scopes: Array<{ type: string; id: string }>,
    limit = 50,
  ): MemoryRow[] {
    if (scopes.length === 0) return [];
    // Defensive: a non-finite limit (NaN, Infinity) would bind as a
    // non-integer SQLite parameter and either throw or return garbage. The
    // caller is hard-coded today (KG_NO_QUERY_LIMIT=20) but harden the boundary.
    const safeLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.floor(limit), 1), 500)
      : 50;
    const scopeClauses = scopes.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
    const params: unknown[] = [namespace];
    for (const s of scopes) { params.push(s.type, s.id); }
    params.push(safeLimit);
    return this.db.prepare(
      `SELECT * FROM memories
       WHERE is_active = 1 AND namespace = ? AND (${scopeClauses})
       ORDER BY created_at DESC LIMIT ?`,
    ).all(...params) as MemoryRow[];
  }

  deactivateMemoriesByPattern(pattern: string, namespace?: string | undefined): number {
    if (namespace) {
      const result = this.db.prepare(`
        UPDATE memories SET is_active = 0, updated_at = ? WHERE is_active = 1 AND text LIKE ? AND namespace = ?
      `).run(new Date().toISOString(), `%${pattern}%`, namespace);
      return result.changes;
    }
    const result = this.db.prepare(`
      UPDATE memories SET is_active = 0, updated_at = ? WHERE is_active = 1 AND text LIKE ?
    `).run(new Date().toISOString(), `%${pattern}%`);
    return result.changes;
  }

  updateMemoryText(
    oldText: string,
    newText: string,
    namespace?: string | undefined,
    embedding?: number[] | undefined,
  ): string | null {
    const row = namespace
      ? this.db.prepare(`
          SELECT id FROM memories WHERE is_active = 1 AND text LIKE ? AND namespace = ? LIMIT 1
        `).get(`%${oldText}%`, namespace) as { id: string } | undefined
      : this.db.prepare(`
          SELECT id FROM memories WHERE is_active = 1 AND text LIKE ? LIMIT 1
        `).get(`%${oldText}%`) as { id: string } | undefined;

    if (!row) return null;
    // Update the embedding in the SAME statement when the caller supplies one,
    // so the stored vector can never drift from the text (a text-only update
    // leaves embed(oldText) behind, silently poisoning similarity search).
    if (embedding) {
      this.db.prepare('UPDATE memories SET text = ?, embedding = ?, updated_at = ? WHERE id = ?')
        .run(newText, embedToBlob(embedding), new Date().toISOString(), row.id);
    } else {
      this.db.prepare('UPDATE memories SET text = ?, updated_at = ? WHERE id = ?')
        .run(newText, new Date().toISOString(), row.id);
    }
    return row.id;
  }

  getActiveMemoryCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memories WHERE is_active = 1').get() as { cnt: number };
    return row.cnt;
  }

  /** Cosine similarity search over memory embeddings with in-place scoring. */
  findSimilarMemories(
    embedding: number[],
    topK = 10,
    threshold = 0.65,
    filters?: {
      namespace?: string | undefined;
      scopeTypes?: string[] | undefined;
      scopeIds?: string[] | undefined;
      activeOnly?: boolean | undefined;
      /** Raise the row cap to `DEDUP_EXHAUSTIVE_SCAN_LIMIT` (dedup) instead of the
       *  retrieval window. Dedup must consider prior memories deep in the
       *  (scope-narrowed) set — a `created_at DESC LIMIT 100` window silently
       *  misses an older duplicate, so a re-stated fact is saved twice. Still
       *  capped (not unbounded) to bound per-store cost on a large scope. */
      exhaustive?: boolean | undefined;
    },
  ): ScoredMemoryRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.activeOnly !== false) clauses.push('is_active = 1');
    if (filters?.namespace) {
      clauses.push('namespace = ?');
      params.push(filters.namespace);
    }
    if (filters?.scopeTypes && filters.scopeTypes.length > 0) {
      clauses.push(`scope_type IN (${filters.scopeTypes.map(() => '?').join(',')})`);
      params.push(...filters.scopeTypes);
    }
    // Scope-id filter prevents cross-tenant/cross-project bleed when callers
    // (e.g. KG dedup) want to scope to a specific scope.id within a scope.type.
    if (filters?.scopeIds && filters.scopeIds.length > 0) {
      clauses.push(`scope_id IN (${filters.scopeIds.map(() => '?').join(',')})`);
      params.push(...filters.scopeIds);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // Exhaustive scans (dedup) raise the row cap far above the retrieval window
    // so an older near-duplicate past the newest 100 is still caught, but keep a
    // high safety ceiling (an uncapped SELECT would be O(N) blob-decode + cosine
    // on every store() for a ceiling-less scope like `global`).
    const sqlLimit = filters?.exhaustive === true
      ? DEDUP_EXHAUSTIVE_SCAN_LIMIT
      : Math.min(Math.max(topK * 10, 100), 500);
    params.push(sqlLimit);
    const rows = this.db.prepare(
      `SELECT * FROM memories ${whereClause} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params) as MemoryRow[];

    const dim = this._embeddingDimensions ?? (embedding.length || 384);
    const expectedBlobLen = dim * 8;

    // Score in-place using a min-heap approach: keep only topK results
    const scored: ScoredMemoryRow[] = [];
    let minScore = threshold;

    for (const row of rows) {
      if (!row.embedding || row.embedding.length !== expectedBlobLen) continue;

      const memEmb = blobToEmbed(row.embedding, dim);
      const sim = cosineSimilarity(embedding, memEmb);
      if (sim < minScore) continue;

      // Assign _similarity directly on the row object to avoid spreading
      (row as ScoredMemoryRow)._similarity = sim;
      scored.push(row as ScoredMemoryRow);

      // Once we have enough candidates, raise the floor to prune early
      if (scored.length > topK * 2) {
        scored.sort((a, b) => b._similarity - a._similarity);
        scored.length = topK;
        minScore = scored[scored.length - 1]!._similarity;
      }
    }

    scored.sort((a, b) => b._similarity - a._similarity);
    return scored.slice(0, topK);
  }

  // ── Relationship Operations ───────────────────────────────────

  createMention(memoryId: string, entityId: string, mentionType = 'direct'): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO mentions (memory_id, entity_id, mention_type, created_at)
      VALUES (?, ?, ?, ?)
    `).run(memoryId, entityId, mentionType, now);
  }

  createRelation(
    fromEntityId: string,
    toEntityId: string,
    relationType: string,
    description: string,
    sourceMemoryId: string,
    confidence = 1.0,
  ): void {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO relations (id, from_entity_id, to_entity_id, relation_type,
        description, confidence, source_memory_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, fromEntityId, toEntityId, relationType, description, confidence, sourceMemoryId, now);
  }

  createSupersedes(newMemoryId: string, oldMemoryId: string, reason: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO supersedes (new_memory_id, old_memory_id, reason, created_at)
      VALUES (?, ?, ?, ?)
    `).run(newMemoryId, oldMemoryId, reason, now);
  }

  updateCooccurrence(entityAId: string, entityBId: string): void {
    const now = new Date().toISOString();
    const [a, b] = entityAId < entityBId ? [entityAId, entityBId] : [entityBId, entityAId];
    // Use INSERT OR REPLACE with COALESCE to handle both insert and update in one statement
    this.db.prepare(`
      INSERT INTO cooccurrences (entity_a_id, entity_b_id, count, last_seen_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(entity_a_id, entity_b_id)
      DO UPDATE SET count = count + 1, last_seen_at = excluded.last_seen_at
    `).run(a, b, now);
  }

  /** Batch upsert cooccurrences for a set of entity IDs. O(N²/2) pairs but single-statement each. */
  updateCooccurrencesBatch(entityIds: string[]): void {
    if (entityIds.length < 2) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO cooccurrences (entity_a_id, entity_b_id, count, last_seen_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(entity_a_id, entity_b_id)
      DO UPDATE SET count = count + 1, last_seen_at = excluded.last_seen_at
    `);
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        const [a, b] = entityIds[i]! < entityIds[j]! ? [entityIds[i]!, entityIds[j]!] : [entityIds[j]!, entityIds[i]!];
        stmt.run(a, b, now);
      }
    }
  }

  /** Batch lookup entities by canonical names. Returns a Map of lowercase name → EntityRow. */
  findEntitiesByNames(names: string[]): Map<string, EntityRow> {
    if (names.length === 0) return new Map();
    const result = new Map<string, EntityRow>();
    // Use batched query with IN clause for canonical name lookup
    const placeholders = names.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT * FROM entities WHERE canonical_name COLLATE NOCASE IN (${placeholders})
    `).all(...names) as EntityRow[];
    for (const row of rows) {
      result.set(row.canonical_name.toLowerCase(), row);
    }
    // For names not found by canonical, try alias lookup individually (aliases are JSON arrays)
    for (const name of names) {
      if (!result.has(name.toLowerCase())) {
        const aliasRow = this.findEntityByAlias(name);
        if (aliasRow) result.set(name.toLowerCase(), aliasRow);
      }
    }
    return result;
  }

  /** Batch increment mention counts for multiple entity IDs. */
  incrementEntityMentionsBatch(entityIds: string[]): void {
    if (entityIds.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE entities SET mention_count = mention_count + 1, last_seen_at = ? WHERE id = ?
    `);
    for (const id of entityIds) {
      stmt.run(now, id);
    }
  }

  // ── Graph Queries ─────────────────────────────────────────────

  getEntityRelations(entityId: string, limit = 50): RelationRow[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    return this.db.prepare(`
      SELECT * FROM relations
      WHERE from_entity_id = ? OR to_entity_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(entityId, entityId, safeLimit) as RelationRow[];
  }

  getRelationCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM relations').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Offset-paged scan over the ENTIRE relations table (Foundation Rework v2 S2
   * backfill). `getEntityRelations` is per-entity + capped at 200 newest — it
   * cannot enumerate the global edge set (a hub entity's older edges drop), so the
   * data re-map needs this stable-ordered full scan. Ordered by the PRIMARY KEY so
   * pagination is stable across pages even as rows are read.
   */
  listAllRelations(opts?: { limit?: number | undefined; offset?: number | undefined }): RelationRow[] {
    const limit = Math.max(1, opts?.limit ?? 500);
    const offset = Math.max(0, opts?.offset ?? 0);
    return this.db.prepare('SELECT * FROM relations ORDER BY id LIMIT ? OFFSET ?').all(limit, offset) as RelationRow[];
  }

  /**
   * Offset-paged scan over the ENTIRE entities table (Foundation Rework v2 S2
   * backfill). Distinct from {@link listEntities}, which HARD-CLAMPS its limit to
   * 200 (a browse-list cap) and orders by `mention_count` — both wrong for a full
   * re-map: the clamp would silently drop every entity past the first page, and the
   * unindexed sort costs a full sort per page. This is unclamped and PK-ordered so
   * pagination is stable + sort-free and no entity is ever dropped.
   */
  listAllEntities(opts?: { limit?: number | undefined; offset?: number | undefined }): EntityRow[] {
    const limit = Math.max(1, opts?.limit ?? 500);
    const offset = Math.max(0, opts?.offset ?? 0);
    return this.db.prepare('SELECT * FROM entities ORDER BY id LIMIT ? OFFSET ?').all(limit, offset) as EntityRow[];
  }

  getMemoriesMentioningEntity(entityId: string, activeOnly = true, limit = 10): MemoryRow[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const activeClause = activeOnly ? 'AND m.is_active = 1' : '';
    return this.db.prepare(`
      SELECT m.* FROM memories m
      JOIN mentions mn ON m.id = mn.memory_id
      WHERE mn.entity_id = ? ${activeClause}
      ORDER BY m.created_at DESC LIMIT ?
    `).all(entityId, safeLimit) as MemoryRow[];
  }

  getRelatedMemoriesViaEntities(entityId: string, hops = 2, activeOnly = true, limit = 5): MemoryRow[] {
    if (hops === 1) return this.getMemoriesMentioningEntity(entityId, activeOnly, limit);
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const activeClause = activeOnly ? 'AND m.is_active = 1' : '';
    return this.db.prepare(`
      SELECT DISTINCT m.* FROM memories m
      JOIN mentions mn ON m.id = mn.memory_id
      JOIN relations r ON (mn.entity_id = r.from_entity_id OR mn.entity_id = r.to_entity_id)
      WHERE (r.from_entity_id = ? OR r.to_entity_id = ?)
        AND mn.entity_id != ?
        ${activeClause}
      ORDER BY m.created_at DESC LIMIT ?
    `).all(entityId, entityId, entityId, safeLimit) as MemoryRow[];
  }

  /** Find path between two entities using recursive CTE (max 3 hops). */
  findPath(fromEntityId: string, toEntityId: string, maxHops = 3): RelationRow[] {
    const safeHops = Math.min(maxHops, 5);
    const pathRow = this.db.prepare(`
      WITH RECURSIVE path(entity_id, depth, path_ids, relation_ids) AS (
        SELECT to_entity_id, 1,
               from_entity_id || ',' || to_entity_id,
               id
        FROM relations WHERE from_entity_id = ?
        UNION ALL
        SELECT r.to_entity_id, p.depth + 1,
               p.path_ids || ',' || r.to_entity_id,
               p.relation_ids || ',' || r.id
        FROM relations r JOIN path p ON r.from_entity_id = p.entity_id
        WHERE p.depth < ?
          AND instr(p.path_ids, r.to_entity_id) = 0
      )
      SELECT relation_ids FROM path
      WHERE entity_id = ?
      ORDER BY depth ASC LIMIT 1
    `).get(fromEntityId, safeHops, toEntityId) as { relation_ids: string } | undefined;

    if (!pathRow) return [];
    const relIds = pathRow.relation_ids.split(',');
    if (relIds.length === 0) return [];
    const placeholders = relIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM relations WHERE id IN (${placeholders})`).all(...relIds) as RelationRow[];
  }

  /** Get neighborhood entities within N hops. */
  getNeighborhood(entityId: string, hops = 2): { entities: EntityRow[]; relations: RelationRow[] } {
    const safeHops = Math.min(hops, 3);
    const entityRows = this.db.prepare(`
      WITH RECURSIVE neighbors(entity_id, depth) AS (
        SELECT CASE WHEN from_entity_id = ? THEN to_entity_id ELSE from_entity_id END, 1
        FROM relations WHERE from_entity_id = ? OR to_entity_id = ?
        UNION
        SELECT CASE WHEN r.from_entity_id = n.entity_id THEN r.to_entity_id ELSE r.from_entity_id END,
               n.depth + 1
        FROM relations r JOIN neighbors n ON (r.from_entity_id = n.entity_id OR r.to_entity_id = n.entity_id)
        WHERE n.depth < ?
      )
      SELECT DISTINCT e.* FROM entities e
      JOIN neighbors n ON e.id = n.entity_id
      WHERE e.id != ?
      LIMIT 20
    `).all(entityId, entityId, entityId, safeHops, entityId) as EntityRow[];

    const relations = this.getEntityRelations(entityId);
    return { entities: entityRows, relations };
  }

  // ── Metric Operations ─────────────────────────────────────────

  upsertMetric(props: {
    metricName: string;
    value: number;
    sampleCount?: number | undefined;
    window?: string | undefined;
    scopeType?: string | undefined;
    scopeId?: string | undefined;
  }): void {
    const now = new Date().toISOString();
    const window = props.window ?? 'all_time';
    const existing = this.db.prepare(`
      SELECT id FROM metrics WHERE metric_name = ? AND window = ?
        AND COALESCE(scope_type, '') = COALESCE(?, '')
        AND COALESCE(scope_id, '') = COALESCE(?, '')
    `).get(props.metricName, window, props.scopeType ?? '', props.scopeId ?? '') as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE metrics SET value = ?, sample_count = ?, computed_at = ? WHERE id = ?
      `).run(props.value, props.sampleCount ?? 1, now, existing.id);
    } else {
      this.db.prepare(`
        INSERT INTO metrics (id, metric_name, scope_type, scope_id, value, sample_count, window, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), props.metricName, props.scopeType ?? null, props.scopeId ?? null,
        props.value, props.sampleCount ?? 1, window, now);
    }
  }

  getMetrics(metricName?: string | undefined, window?: string | undefined): MetricRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (metricName) { clauses.push('metric_name = ?'); params.push(metricName); }
    if (window) { clauses.push('window = ?'); params.push(window); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM metrics ${where} ORDER BY computed_at DESC`).all(...params) as MetricRow[];
  }

  // ── Garbage Collection ────────────────────────────────────────

  gc(dryRun = false): { supersededRemoved: number; orphanEntitiesRemoved: number; staleMemoriesRemoved: number } {
    const supersededCount = (this.db.prepare(
      'SELECT COUNT(*) as cnt FROM memories WHERE is_active = 0',
    ).get() as { cnt: number }).cnt;

    const orphanRows = this.db.prepare(`
      SELECT e.id FROM entities e
      WHERE NOT EXISTS (
        SELECT 1 FROM mentions mn
        JOIN memories m ON mn.memory_id = m.id
        WHERE mn.entity_id = e.id AND m.is_active = 1
      )
    `).all() as Array<{ id: string }>;

    if (dryRun) {
      return { supersededRemoved: supersededCount, orphanEntitiesRemoved: orphanRows.length, staleMemoriesRemoved: 0 };
    }

    this.db.prepare('DELETE FROM mentions WHERE memory_id IN (SELECT id FROM memories WHERE is_active = 0)').run();
    this.db.prepare('DELETE FROM supersedes WHERE old_memory_id IN (SELECT id FROM memories WHERE is_active = 0)').run();
    this.db.prepare('DELETE FROM memories WHERE is_active = 0').run();

    for (const row of orphanRows) {
      this.deleteEntity(row.id);
    }

    return { supersededRemoved: supersededCount, orphanEntitiesRemoved: orphanRows.length, staleMemoriesRemoved: 0 };
  }

  // ── Confidence Feedback ────────────────────────────────────────

  /** Reduce confidence when a memory was retrieved but turned out wrong. Floor at 0.1. */
  penalizeMemory(memoryId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE memories SET confidence = MAX(confidence - 0.1, 0.1), updated_at = ? WHERE id = ?
    `).run(now, memoryId);
  }

  // ── Memory Consolidation ──────────────────────────────────────

  /**
   * Find clusters of similar active memories and merge them.
   * Keeps the longest (or most-confirmed) memory, supersedes the rest.
   * Returns number of memories consolidated.
   */
  consolidateMemories(
    namespace: string,
    scopeType: string,
    scopeId: string,
    threshold = 0.85,
  ): number {
    // scopeId='*' means all scopes of this type
    const rows = scopeId === '*'
      ? this.db.prepare(`
          SELECT * FROM memories
          WHERE is_active = 1 AND namespace = ? AND scope_type = ?
          ORDER BY created_at DESC LIMIT 500
        `).all(namespace, scopeType) as MemoryRow[]
      : this.db.prepare(`
          SELECT * FROM memories
          WHERE is_active = 1 AND namespace = ? AND scope_type = ? AND scope_id = ?
          ORDER BY created_at DESC LIMIT 500
        `).all(namespace, scopeType, scopeId) as MemoryRow[];

    if (rows.length < 2) return 0;

    const dim = this._embeddingDimensions ?? 384;
    const expectedBlobLen = dim * 8;

    // Pre-compute all embeddings once (O(N)) instead of re-decoding per pair
    const embeddings: (number[] | null)[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      embeddings[i] = (row.embedding && row.embedding.length === expectedBlobLen)
        ? blobToEmbed(row.embedding, dim)
        : null;
    }

    // Wrap in transaction for atomicity
    return this.transaction(() => {
    const merged = new Set<number>(); // track by index to avoid Set<string> hashing
    let consolidatedCount = 0;

    for (let i = 0; i < rows.length; i++) {
      if (merged.has(i)) continue;
      const anchorEmb = embeddings[i];
      if (!anchorEmb) continue;

      const cluster: number[] = [i];

      for (let j = i + 1; j < rows.length; j++) {
        if (merged.has(j)) continue;
        const candEmb = embeddings[j];
        if (!candEmb) continue;

        const sim = cosineSimilarity(anchorEmb, candEmb);
        if (sim >= threshold) {
          cluster.push(j);
        }
      }

      if (cluster.length < 2) continue;

      // Keep the best memory: highest confirmation_count, then longest text
      cluster.sort((a, b) => {
        const ra = rows[a]!;
        const rb = rows[b]!;
        if (rb.confirmation_count !== ra.confirmation_count) return rb.confirmation_count - ra.confirmation_count;
        return rb.text.length - ra.text.length;
      });

      const keeper = rows[cluster[0]!]!;
      const now = new Date().toISOString();
      for (let k = 1; k < cluster.length; k++) {
        const victim = rows[cluster[k]!]!;
        this.supersedMemory(victim.id, keeper.id);
        this.createSupersedes(keeper.id, victim.id, 'consolidation');
        if (victim.confirmation_count > 0) {
          this.db.prepare(`
            UPDATE memories SET confirmation_count = confirmation_count + ?, updated_at = ? WHERE id = ?
          `).run(victim.confirmation_count, now, keeper.id);
        }
        merged.add(cluster[k]!);
        consolidatedCount++;
      }
    }

    return consolidatedCount;
    }); // end transaction
  }

  // ── Transaction helper ────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
