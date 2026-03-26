import { Database, Connection } from '@ladybugdb/core';
import type { QueryResult, LbugValue } from '@ladybugdb/core';
import { randomUUID } from 'node:crypto';
import { channels } from './observability.js';

/** Schema version for knowledge graph migrations. */
const SCHEMA_VERSION = 1;

/** Default path for the knowledge graph database relative to lynox dir. */
export const KNOWLEDGE_GRAPH_DB_NAME = 'knowledge-graph';

/**
 * Low-level wrapper around LadybugDB (Kuzu fork) for the knowledge graph.
 * Handles DB lifecycle, schema creation, Cypher queries, and typed result extraction.
 */
export class KuzuGraph {
  private db: Database | null = null;
  private conn: Connection | null = null;
  private readonly dbPath: string;
  private _ready = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  get isReady(): boolean {
    return this._ready;
  }

  // === Lifecycle ===

  async init(): Promise<void> {
    if (this._ready) return;

    this.db = new Database(this.dbPath);
    await this.db.init();

    this.conn = new Connection(this.db);
    await this.conn.init();

    await this._initSchema();
    this._ready = true;
  }

  async close(): Promise<void> {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
    this._ready = false;
  }

  // === Query Execution ===

  /**
   * Execute a Cypher query and return all result rows.
   * Supports parameterized queries via prepared statements.
   */
  async query(
    cypher: string,
    params?: Record<string, LbugValue>,
  ): Promise<Record<string, LbugValue>[]> {
    const conn = this._getConnection();

    if (params && Object.keys(params).length > 0) {
      const stmt = await conn.prepare(cypher);
      if (!stmt.isSuccess()) {
        throw new Error(`Cypher prepare failed: ${stmt.getErrorMessage()}`);
      }
      const result = await conn.execute(stmt, params);
      return this._extractRows(result);
    }

    const result = await conn.query(cypher);
    return this._extractRows(result);
  }

  /**
   * Execute a Cypher statement that returns no rows (DDL, INSERT, SET, DELETE).
   */
  async execute(
    cypher: string,
    params?: Record<string, LbugValue>,
  ): Promise<void> {
    await this.query(cypher, params);
  }

  /**
   * Execute a Cypher query and return the first row, or null.
   */
  async queryOne(
    cypher: string,
    params?: Record<string, LbugValue>,
  ): Promise<Record<string, LbugValue> | null> {
    const rows = await this.query(cypher, params);
    return rows[0] ?? null;
  }

  /**
   * Execute a Cypher query and return a single scalar value, or null.
   */
  async queryScalar<T extends LbugValue>(
    cypher: string,
    params?: Record<string, LbugValue>,
  ): Promise<T | null> {
    const row = await this.queryOne(cypher, params);
    if (!row) return null;
    const keys = Object.keys(row);
    if (keys.length === 0) return null;
    return row[keys[0]!] as T;
  }

  // === Node Operations ===

  async createEntity(props: {
    id?: string | undefined;
    canonicalName: string;
    entityType: string;
    aliases?: string[] | undefined;
    description?: string | undefined;
    scopeType: string;
    scopeId: string;
    embedding?: number[] | undefined;
    metadata?: string | undefined;
  }): Promise<string> {
    const id = props.id ?? randomUUID();
    const now = new Date().toISOString();

    await this.execute(
      `CREATE (e:Entity {
        id: $id,
        canonical_name: $canonical_name,
        entity_type: $entity_type,
        aliases: $aliases,
        description: $description,
        scope_type: $scope_type,
        scope_id: $scope_id,
        first_seen_at: timestamp($first_seen_at),
        last_seen_at: timestamp($last_seen_at),
        mention_count: $mention_count,
        embedding: $embedding,
        metadata: $metadata
      })`,
      {
        id,
        canonical_name: props.canonicalName,
        entity_type: props.entityType,
        aliases: props.aliases ?? [props.canonicalName],
        description: props.description ?? '',
        scope_type: props.scopeType,
        scope_id: props.scopeId,
        first_seen_at: now,
        last_seen_at: now,
        mention_count: BigInt(1),
        embedding: props.embedding ?? [],
        metadata: props.metadata ?? '{}',
      },
    );

    return id;
  }

  async createMemory(props: {
    id?: string | undefined;
    text: string;
    namespace: string;
    scopeType: string;
    scopeId: string;
    sourceRunId?: string | undefined;
    provider?: string | undefined;
    embedding: number[];
  }): Promise<string> {
    const id = props.id ?? randomUUID();
    const now = new Date().toISOString();

    await this.execute(
      `CREATE (m:Memory {
        id: $id,
        text: $text,
        namespace: $namespace,
        scope_type: $scope_type,
        scope_id: $scope_id,
        source_run_id: $source_run_id,
        provider: $provider,
        embedding: $embedding,
        is_active: true,
        superseded_by: $superseded_by,
        created_at: timestamp($created_at),
        last_retrieved_at: timestamp($last_retrieved_at),
        retrieval_count: $retrieval_count
      })`,
      {
        id,
        text: props.text,
        namespace: props.namespace,
        scope_type: props.scopeType,
        scope_id: props.scopeId,
        source_run_id: props.sourceRunId ?? '',
        provider: props.provider ?? 'onnx',
        embedding: props.embedding,
        superseded_by: '',
        created_at: now,
        last_retrieved_at: now,
        retrieval_count: BigInt(0),
      },
    );

    return id;
  }

  // === Relationship Operations ===

  async createMention(memoryId: string, entityId: string, mentionType = 'direct'): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `MATCH (m:Memory), (e:Entity)
       WHERE m.id = $memoryId AND e.id = $entityId
       CREATE (m)-[:MENTIONS {mention_type: $mentionType, created_at: timestamp($created_at)}]->(e)`,
      { memoryId, entityId, mentionType, created_at: now },
    );
  }

  async createRelation(
    fromEntityId: string,
    toEntityId: string,
    relationType: string,
    description: string,
    sourceMemoryId: string,
    confidence = 1.0,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `MATCH (a:Entity), (b:Entity)
       WHERE a.id = $fromId AND b.id = $toId
       CREATE (a)-[:RELATES_TO {
         relation_type: $relationType,
         description: $description,
         confidence: $confidence,
         source_memory_id: $sourceMemoryId,
         created_at: timestamp($created_at)
       }]->(b)`,
      {
        fromId: fromEntityId,
        toId: toEntityId,
        relationType,
        description,
        confidence,
        sourceMemoryId,
        created_at: now,
      },
    );
  }

  async createSupersedes(newMemoryId: string, oldMemoryId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `MATCH (new:Memory), (old:Memory)
       WHERE new.id = $newId AND old.id = $oldId
       CREATE (new)-[:SUPERSEDES {reason: $reason, created_at: timestamp($created_at)}]->(old)`,
      { newId: newMemoryId, oldId: oldMemoryId, reason, created_at: now },
    );
  }

  async updateCooccurrence(entityAId: string, entityBId: string): Promise<void> {
    const now = new Date().toISOString();
    // Check if cooccurrence already exists
    const existing = await this.queryOne(
      `MATCH (a:Entity)-[r:COOCCURS]-(b:Entity)
       WHERE a.id = $aId AND b.id = $bId
       RETURN r.count AS count`,
      { aId: entityAId, bId: entityBId },
    );

    if (existing) {
      await this.execute(
        `MATCH (a:Entity)-[r:COOCCURS]-(b:Entity)
         WHERE a.id = $aId AND b.id = $bId
         SET r.count = r.count + 1, r.last_seen_at = timestamp($now)`,
        { aId: entityAId, bId: entityBId, now },
      );
    } else {
      await this.execute(
        `MATCH (a:Entity), (b:Entity)
         WHERE a.id = $aId AND b.id = $bId
         CREATE (a)-[:COOCCURS {count: 1, last_seen_at: timestamp($now)}]->(b)`,
        { aId: entityAId, bId: entityBId, now },
      );
    }
  }

  // === Query Helpers ===

  async findEntityByCanonicalName(
    name: string,
    scopeTypes?: string[] | undefined,
  ): Promise<Record<string, LbugValue> | null> {
    if (scopeTypes && scopeTypes.length > 0) {
      return this.queryOne(
        `MATCH (e:Entity)
         WHERE lower(e.canonical_name) = lower($name)
           AND e.scope_type IN $scopeTypes
         RETURN e.id, e.canonical_name, e.entity_type, e.aliases,
                e.description, e.scope_type, e.scope_id, e.mention_count,
                e.first_seen_at, e.last_seen_at
         LIMIT 1`,
        { name, scopeTypes },
      );
    }
    return this.queryOne(
      `MATCH (e:Entity)
       WHERE lower(e.canonical_name) = lower($name)
       RETURN e.id, e.canonical_name, e.entity_type, e.aliases,
              e.description, e.scope_type, e.scope_id, e.mention_count,
              e.first_seen_at, e.last_seen_at
       LIMIT 1`,
      { name },
    );
  }

  async findEntityByAlias(alias: string): Promise<Record<string, LbugValue> | null> {
    return this.queryOne(
      `MATCH (e:Entity)
       WHERE list_contains(e.aliases, $alias)
       RETURN e.id, e.canonical_name, e.entity_type, e.aliases,
              e.description, e.scope_type, e.scope_id, e.mention_count,
              e.first_seen_at, e.last_seen_at
       LIMIT 1`,
      { alias },
    );
  }

  async incrementEntityMentions(entityId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `MATCH (e:Entity)
       WHERE e.id = $id
       SET e.mention_count = e.mention_count + 1, e.last_seen_at = timestamp($now)`,
      { id: entityId, now },
    );
  }

  async addEntityAlias(entityId: string, alias: string): Promise<void> {
    await this.execute(
      `MATCH (e:Entity)
       WHERE e.id = $id AND NOT list_contains(e.aliases, $alias)
       SET e.aliases = list_append(e.aliases, $alias)`,
      { id: entityId, alias },
    );
  }

  async getMemoriesMentioningEntity(
    entityId: string,
    activeOnly = true,
    limit = 10,
  ): Promise<Record<string, LbugValue>[]> {
    const activeClause = activeOnly ? 'AND m.is_active = true' : '';
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    return this.query(
      `MATCH (m:Memory)-[:MENTIONS]->(e:Entity)
       WHERE e.id = $entityId ${activeClause}
       RETURN m.id, m.text, m.namespace, m.scope_type, m.scope_id, m.created_at
       ORDER BY m.created_at DESC
       LIMIT ${safeLimit}`,
      { entityId },
    );
  }

  async getRelatedMemoriesViaEntities(
    entityId: string,
    hops = 2,
    activeOnly = true,
    limit = 5,
  ): Promise<Record<string, LbugValue>[]> {
    const activeClause = activeOnly ? 'AND m.is_active = true' : '';
    if (hops === 1) {
      return this.getMemoriesMentioningEntity(entityId, activeOnly, limit);
    }
    // 2-hop: Memory → Entity → Entity → Memory
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    return this.query(
      `MATCH (m:Memory)-[:MENTIONS]->(e2:Entity)-[:RELATES_TO]-(e:Entity)
       WHERE e.id = $entityId ${activeClause}
       RETURN DISTINCT m.id, m.text, m.namespace, m.scope_type, m.scope_id, m.created_at
       ORDER BY m.created_at DESC
       LIMIT ${safeLimit}`,
      { entityId },
    );
  }

  async supersedMemory(memoryId: string, supersededById: string): Promise<void> {
    await this.execute(
      `MATCH (m:Memory)
       WHERE m.id = $id
       SET m.is_active = false, m.superseded_by = $supersededBy`,
      { id: memoryId, supersededBy: supersededById },
    );
  }

  async updateMemoryRetrieved(memoryId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `MATCH (m:Memory)
       WHERE m.id = $id
       SET m.retrieval_count = m.retrieval_count + 1,
           m.last_retrieved_at = timestamp($now)`,
      { id: memoryId, now },
    );
  }

  /**
   * Find active Memory nodes whose text contains the given pattern.
   */
  async findMemoriesByTextPattern(
    pattern: string,
    namespace?: string | undefined,
  ): Promise<Record<string, LbugValue>[]> {
    if (namespace) {
      return this.query(
        `MATCH (m:Memory)
         WHERE m.is_active = true AND contains(m.text, $pattern) AND m.namespace = $ns
         RETURN m.id, m.text, m.namespace, m.scope_type, m.scope_id`,
        { pattern, ns: namespace },
      );
    }
    return this.query(
      `MATCH (m:Memory)
       WHERE m.is_active = true AND contains(m.text, $pattern)
       RETURN m.id, m.text, m.namespace, m.scope_type, m.scope_id`,
      { pattern },
    );
  }

  /**
   * Deactivate Memory nodes whose text contains the given pattern.
   * Returns the number of memories deactivated.
   */
  async deactivateMemoriesByPattern(
    pattern: string,
    namespace?: string | undefined,
  ): Promise<number> {
    const matches = await this.findMemoriesByTextPattern(pattern, namespace);
    for (const row of matches) {
      await this.execute(
        `MATCH (m:Memory) WHERE m.id = $id SET m.is_active = false`,
        { id: row['m.id'] as string },
      );
    }
    return matches.length;
  }

  /**
   * Update the text of a Memory node found by old text content.
   * Returns the ID of the updated memory, or null if not found.
   */
  async updateMemoryText(
    oldText: string,
    newText: string,
    namespace?: string | undefined,
  ): Promise<string | null> {
    const row = namespace
      ? await this.queryOne(
          `MATCH (m:Memory)
           WHERE m.is_active = true AND contains(m.text, $oldText) AND m.namespace = $ns
           RETURN m.id
           LIMIT 1`,
          { oldText, ns: namespace },
        )
      : await this.queryOne(
          `MATCH (m:Memory)
           WHERE m.is_active = true AND contains(m.text, $oldText)
           RETURN m.id
           LIMIT 1`,
          { oldText },
        );
    if (!row) return null;

    const id = row['m.id'] as string;
    await this.execute(
      `MATCH (m:Memory) WHERE m.id = $id SET m.text = $newText`,
      { id, newText },
    );
    return id;
  }

  async getActiveMemoryCount(): Promise<number> {
    const result = await this.queryScalar<bigint>(
      'MATCH (m:Memory) WHERE m.is_active = true RETURN count(m) AS cnt',
    );
    return Number(result ?? 0);
  }

  async getEntityCount(): Promise<number> {
    const result = await this.queryScalar<bigint>(
      'MATCH (e:Entity) RETURN count(e) AS cnt',
    );
    return Number(result ?? 0);
  }

  async getRelationCount(): Promise<number> {
    const result = await this.queryScalar<bigint>(
      'MATCH ()-[r:RELATES_TO]->() RETURN count(r) AS cnt',
    );
    return Number(result ?? 0);
  }

  async getCommunityCount(): Promise<number> {
    const result = await this.queryScalar<bigint>(
      'MATCH (c:Community) RETURN count(c) AS cnt',
    );
    return Number(result ?? 0);
  }

  /**
   * Find memories with text similar to a given embedding.
   * Uses brute-force cosine for now; vector index via CALL when available.
   */
  async findSimilarMemories(
    embedding: number[],
    topK = 10,
    threshold = 0.65,
    filters?: {
      namespace?: string | undefined;
      scopeTypes?: string[] | undefined;
      activeOnly?: boolean | undefined;
    },
  ): Promise<Array<Record<string, LbugValue> & { _similarity: number }>> {
    // Build filter clauses — all values parameterized to prevent Cypher injection
    const clauses: string[] = [];
    const params: Record<string, LbugValue> = {};
    if (filters?.activeOnly !== false) clauses.push('m.is_active = true');
    if (filters?.namespace) {
      clauses.push('m.namespace = $filterNs');
      params['filterNs'] = filters.namespace;
    }
    if (filters?.scopeTypes && filters.scopeTypes.length > 0) {
      clauses.push(`m.scope_type IN $filterScopeTypes`);
      params['filterScopeTypes'] = filters.scopeTypes;
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    // Retrieve all candidate memories with embeddings
    const rows = await this.query(
      `MATCH (m:Memory) ${whereClause}
       RETURN m.id, m.text, m.namespace, m.scope_type, m.scope_id,
              m.created_at, m.embedding, m.is_active, m.retrieval_count`,
      Object.keys(params).length > 0 ? params : undefined,
    );

    // Compute cosine similarity in JS (brute-force — replaced by HNSW index in later version)
    const scored: Array<Record<string, LbugValue> & { _similarity: number }> = [];

    for (const row of rows) {
      const memEmb = row['m.embedding'];
      if (!Array.isArray(memEmb) || memEmb.length !== embedding.length) continue;

      const sim = cosineSim(embedding, memEmb as number[]);
      if (sim >= threshold) {
        scored.push({ ...row, _similarity: sim });
      }
    }

    scored.sort((a, b) => b._similarity - a._similarity);
    return scored.slice(0, topK);
  }

  // === Schema Init ===

  private async _initSchema(): Promise<void> {
    const conn = this._getConnection();

    // Check if schema already exists by looking for Entity table
    try {
      await conn.query('MATCH (e:Entity) RETURN e.id LIMIT 1');
      return; // Schema exists
    } catch {
      // Schema doesn't exist yet — create it
    }

    // Node tables
    await conn.query(`
      CREATE NODE TABLE IF NOT EXISTS Entity (
        id STRING PRIMARY KEY,
        canonical_name STRING,
        entity_type STRING,
        aliases STRING[],
        description STRING,
        scope_type STRING,
        scope_id STRING,
        first_seen_at TIMESTAMP,
        last_seen_at TIMESTAMP,
        mention_count INT64 DEFAULT 1,
        embedding DOUBLE[],
        metadata STRING
      )
    `);

    await conn.query(`
      CREATE NODE TABLE IF NOT EXISTS Memory (
        id STRING PRIMARY KEY,
        text STRING,
        namespace STRING,
        scope_type STRING,
        scope_id STRING,
        source_run_id STRING,
        provider STRING,
        embedding DOUBLE[],
        is_active BOOL DEFAULT TRUE,
        superseded_by STRING,
        created_at TIMESTAMP,
        last_retrieved_at TIMESTAMP,
        retrieval_count INT64 DEFAULT 0
      )
    `);

    await conn.query(`
      CREATE NODE TABLE IF NOT EXISTS Community (
        id STRING PRIMARY KEY,
        name STRING,
        description STRING,
        scope_type STRING,
        scope_id STRING,
        updated_at TIMESTAMP
      )
    `);

    // Relationship tables
    await conn.query(`
      CREATE REL TABLE IF NOT EXISTS MENTIONS (
        FROM Memory TO Entity,
        mention_type STRING DEFAULT 'direct',
        created_at TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE REL TABLE IF NOT EXISTS RELATES_TO (
        FROM Entity TO Entity,
        relation_type STRING,
        description STRING,
        confidence DOUBLE DEFAULT 1.0,
        source_memory_id STRING,
        created_at TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE REL TABLE IF NOT EXISTS SUPERSEDES (
        FROM Memory TO Memory,
        reason STRING,
        created_at TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE REL TABLE IF NOT EXISTS BELONGS_TO (
        FROM Entity TO Community,
        role STRING,
        joined_at TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE REL TABLE IF NOT EXISTS COOCCURS (
        FROM Entity TO Entity,
        count INT64 DEFAULT 1,
        last_seen_at TIMESTAMP
      )
    `);

    if (channels.knowledgeGraph?.hasSubscribers) {
      channels.knowledgeGraph.publish({
        event: 'schema_init',
        version: SCHEMA_VERSION,
      });
    }
  }

  private _getConnection(): Connection {
    if (!this.conn) {
      throw new Error('Knowledge graph not initialized. Call init() first.');
    }
    return this.conn;
  }

  /**
   * Extract rows from a query result, handling single or multi-result returns.
   */
  private async _extractRows(
    result: QueryResult | QueryResult[],
  ): Promise<Record<string, LbugValue>[]> {
    if (Array.isArray(result)) {
      // Multiple statements: return rows from the last result
      const last = result[result.length - 1];
      if (!last) return [];
      return last.getAll();
    }
    return result.getAll();
  }
}

// === Utility ===

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    magA += (a[i] ?? 0) ** 2;
    magB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
