/**
 * Unified Agent Memory — SQLite storage layer.
 *
 * Replaces LadybugDB (KuzuGraph) with a single crash-safe SQLite database.
 * Uses better-sqlite3 (already a project dependency) with WAL mode.
 *
 * Tables: memories, entities, relations, mentions, cooccurrences, supersedes,
 *         episodes, patterns, metrics.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { embedToBlob, blobToEmbed, cosineSimilarity } from './embedding.js';
import { channels } from './observability.js';

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

export interface EpisodeRow {
  id: string;
  run_id: string | null;
  session_id: string | null;
  task: string;
  approach: string | null;
  outcome: string | null;
  outcome_signal: string;
  tools_used: string;         // JSON array
  entities_involved: string;  // JSON array
  memories_created: string;   // JSON array
  duration_ms: number | null;
  token_cost: number | null;
  user_feedback: string | null;
  created_at: string;
}

export interface PatternRow {
  id: string;
  pattern_type: string;
  description: string;
  evidence_count: number;
  confidence: number;
  last_seen_at: string;
  metadata: string;  // JSON
  is_active: number;
  created_at: string;
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

   CREATE TABLE IF NOT EXISTS patterns (
     id TEXT PRIMARY KEY,
     pattern_type TEXT NOT NULL,
     description TEXT NOT NULL,
     evidence_count INTEGER NOT NULL DEFAULT 1,
     confidence REAL NOT NULL DEFAULT 0.5,
     last_seen_at TEXT NOT NULL,
     metadata TEXT NOT NULL DEFAULT '{}',
     is_active INTEGER NOT NULL DEFAULT 1,
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
   CREATE INDEX IF NOT EXISTS idx_patterns_type ON patterns(pattern_type, is_active);
   CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(metric_name, window);`,
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
      this.db.exec(MIGRATIONS[i]!);
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

  listEntities(opts?: { type?: string | undefined; limit?: number | undefined }): EntityRow[] {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    if (opts?.type) {
      return this.db.prepare(`
        SELECT * FROM entities WHERE entity_type = ? ORDER BY mention_count DESC LIMIT ?
      `).all(opts.type, limit) as EntityRow[];
    }
    return this.db.prepare(`
      SELECT * FROM entities ORDER BY mention_count DESC LIMIT ?
    `).all(limit) as EntityRow[];
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

  // ── Memory Operations ─────────────────────────────────────────

  createMemory(props: {
    id?: string | undefined;
    text: string;
    namespace: string;
    scopeType: string;
    scopeId: string;
    sourceRunId?: string | undefined;
    provider?: string | undefined;
    embedding: number[];
  }): string {
    const id = props.id ?? randomUUID();
    const now = new Date().toISOString();
    const embBlob = embedToBlob(props.embedding);

    this.db.prepare(`
      INSERT INTO memories (id, text, namespace, scope_type, scope_id, source_run_id,
        provider, embedding, confidence, is_active, retrieval_count, confirmation_count,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.75, 1, 0, 0, ?, ?)
    `).run(
      id, props.text, props.namespace, props.scopeType, props.scopeId,
      props.sourceRunId ?? null, props.provider ?? 'onnx', embBlob, now, now,
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

  updateMemoryText(oldText: string, newText: string, namespace?: string | undefined): string | null {
    const row = namespace
      ? this.db.prepare(`
          SELECT id FROM memories WHERE is_active = 1 AND text LIKE ? AND namespace = ? LIMIT 1
        `).get(`%${oldText}%`, namespace) as { id: string } | undefined
      : this.db.prepare(`
          SELECT id FROM memories WHERE is_active = 1 AND text LIKE ? LIMIT 1
        `).get(`%${oldText}%`) as { id: string } | undefined;

    if (!row) return null;
    this.db.prepare('UPDATE memories SET text = ?, updated_at = ? WHERE id = ?')
      .run(newText, new Date().toISOString(), row.id);
    return row.id;
  }

  getActiveMemoryCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memories WHERE is_active = 1').get() as { cnt: number };
    return row.cnt;
  }

  /** Brute-force cosine similarity search over memory embeddings. */
  findSimilarMemories(
    embedding: number[],
    topK = 10,
    threshold = 0.65,
    filters?: {
      namespace?: string | undefined;
      scopeTypes?: string[] | undefined;
      activeOnly?: boolean | undefined;
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

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // Cap SQL results to prevent loading unbounded rows into JS for brute-force cosine.
    // 500 candidates is 3-10x typical topK, leaving room for threshold filtering.
    const sqlLimit = Math.min(Math.max(topK * 10, 100), 500);
    clauses.length > 0
      ? params.push(sqlLimit)
      : params.push(sqlLimit);
    const rows = this.db.prepare(
      `SELECT * FROM memories ${whereClause} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params) as MemoryRow[];

    const dim = this._embeddingDimensions ?? (embedding.length || 384);
    const scored: ScoredMemoryRow[] = [];

    for (const row of rows) {
      if (!row.embedding || row.embedding.length === 0) continue;
      if (row.embedding.length !== dim * 8) continue;

      const memEmb = blobToEmbed(row.embedding, dim);
      const sim = cosineSimilarity(embedding, memEmb);
      if (sim >= threshold) {
        scored.push({ ...row, _similarity: sim });
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
    const existing = this.db.prepare(`
      SELECT count FROM cooccurrences WHERE entity_a_id = ? AND entity_b_id = ?
    `).get(a, b) as { count: number } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE cooccurrences SET count = count + 1, last_seen_at = ?
        WHERE entity_a_id = ? AND entity_b_id = ?
      `).run(now, a, b);
    } else {
      this.db.prepare(`
        INSERT INTO cooccurrences (entity_a_id, entity_b_id, count, last_seen_at)
        VALUES (?, ?, 1, ?)
      `).run(a, b, now);
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

  // ── Episode Operations ────────────────────────────────────────

  createEpisode(props: {
    id?: string | undefined;
    runId?: string | undefined;
    sessionId?: string | undefined;
    task: string;
    approach?: string | undefined;
    outcome?: string | undefined;
    outcomeSignal?: string | undefined;
    toolsUsed?: string[] | undefined;
    entitiesInvolved?: string[] | undefined;
    durationMs?: number | undefined;
    tokenCost?: number | undefined;
  }): string {
    const id = props.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO episodes (id, run_id, session_id, task, approach, outcome,
        outcome_signal, tools_used, entities_involved, memories_created,
        duration_ms, token_cost, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)
    `).run(
      id, props.runId ?? null, props.sessionId ?? null, props.task,
      props.approach ?? null, props.outcome ?? null,
      props.outcomeSignal ?? 'unknown',
      JSON.stringify(props.toolsUsed ?? []),
      JSON.stringify(props.entitiesInvolved ?? []),
      props.durationMs ?? null, props.tokenCost ?? null, now,
    );
    return id;
  }

  updateEpisodeOutcome(id: string, params: {
    outcome?: string | undefined;
    outcomeSignal?: string | undefined;
    userFeedback?: string | undefined;
  }): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (params.outcome !== undefined) { sets.push('outcome = ?'); values.push(params.outcome); }
    if (params.outcomeSignal !== undefined) { sets.push('outcome_signal = ?'); values.push(params.outcomeSignal); }
    if (params.userFeedback !== undefined) { sets.push('user_feedback = ?'); values.push(params.userFeedback); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE episodes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getEpisode(id: string): EpisodeRow | null {
    return this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as EpisodeRow | undefined ?? null;
  }

  queryEpisodes(filters?: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    outcomeSignal?: string | undefined;
    limit?: number | undefined;
  }): EpisodeRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters?.runId) { clauses.push('run_id = ?'); params.push(filters.runId); }
    if (filters?.sessionId) { clauses.push('session_id = ?'); params.push(filters.sessionId); }
    if (filters?.outcomeSignal) { clauses.push('outcome_signal = ?'); params.push(filters.outcomeSignal); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(filters?.limit ?? 50, 200);
    params.push(limit);
    return this.db.prepare(`SELECT * FROM episodes ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as EpisodeRow[];
  }

  linkMemoriesToEpisode(episodeId: string, memoryIds: string[]): void {
    const episode = this.getEpisode(episodeId);
    if (!episode) return;
    const existing = JSON.parse(episode.memories_created) as string[];
    const merged = [...new Set([...existing, ...memoryIds])];
    this.db.prepare('UPDATE episodes SET memories_created = ? WHERE id = ?')
      .run(JSON.stringify(merged), episodeId);
    const now = new Date().toISOString();
    for (const mid of memoryIds) {
      this.db.prepare('UPDATE memories SET source_episode_id = ?, updated_at = ? WHERE id = ?')
        .run(episodeId, now, mid);
    }
  }

  getEpisodeCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM episodes').get() as { cnt: number };
    return row.cnt;
  }

  // ── Pattern Operations ────────────────────────────────────────

  createPattern(props: {
    patternType: string;
    description: string;
    confidence?: number | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO patterns (id, pattern_type, description, evidence_count, confidence,
        last_seen_at, metadata, is_active, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?)
    `).run(id, props.patternType, props.description, props.confidence ?? 0.5,
      now, JSON.stringify(props.metadata ?? {}), now);
    return id;
  }

  incrementPatternEvidence(patternId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE patterns SET evidence_count = evidence_count + 1, last_seen_at = ?,
        confidence = MIN(confidence + 0.05, 1.0) WHERE id = ?
    `).run(now, patternId);
  }

  getPatterns(opts?: {
    patternType?: string | undefined;
    activeOnly?: boolean | undefined;
    limit?: number | undefined;
  }): PatternRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.patternType) { clauses.push('pattern_type = ?'); params.push(opts.patternType); }
    if (opts?.activeOnly !== false) { clauses.push('is_active = 1'); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(opts?.limit ?? 50, 200);
    params.push(limit);
    return this.db.prepare(`SELECT * FROM patterns ${where} ORDER BY confidence DESC LIMIT ?`).all(...params) as PatternRow[];
  }

  getPatternCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM patterns WHERE is_active = 1').get() as { cnt: number };
    return row.cnt;
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

  // ── Transaction helper ────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
