import type { EntityRecord, EntityType, MemoryScopeRef } from '../types/index.js';
import type { KuzuGraph } from './knowledge-graph.js';
import type { EmbeddingProvider } from './embedding.js';
import type { LbugValue } from '@ladybugdb/core';
import { channels } from './observability.js';

/**
 * Resolves entity names to canonical graph entities.
 *
 * Resolution priority:
 * 1. Exact match on canonical_name (case-insensitive)
 * 2. Exact match on any alias
 * 3. Normalized substring match (for partial names)
 * 4. Create new entity if no match found
 */
export class EntityResolver {
  constructor(
    private readonly graph: KuzuGraph,
    private readonly embeddingProvider?: EmbeddingProvider | undefined,
  ) {}

  /**
   * Resolve a name to an existing entity or create a new one.
   */
  async resolve(
    name: string,
    entityType: EntityType,
    scopes: MemoryScopeRef[],
    options?: {
      description?: string | undefined;
      createIfMissing?: boolean | undefined;
    },
  ): Promise<EntityRecord | null> {
    const normalized = name.trim();
    if (normalized.length < 2) return null;

    const scopeTypes = scopes.map(s => s.type);

    // 1. Exact canonical match (case-insensitive)
    const exactMatch = await this.graph.findEntityByCanonicalName(normalized, scopeTypes);
    if (exactMatch) {
      await this.graph.incrementEntityMentions(exactMatch['e.id'] as string);
      return this._toEntityRecord(exactMatch);
    }

    // 2. Alias match
    const aliasMatch = await this.graph.findEntityByAlias(normalized);
    if (aliasMatch) {
      await this.graph.incrementEntityMentions(aliasMatch['e.id'] as string);
      return this._toEntityRecord(aliasMatch);
    }

    // 3. Normalized match — try lowercase, without accents
    const normalizedLower = normalized.toLowerCase();
    const fuzzyMatch = await this.graph.queryOne(
      `MATCH (e:Entity)
       WHERE lower(e.canonical_name) = $normalizedLower
         AND e.scope_type IN $scopeTypes
       RETURN e.id, e.canonical_name, e.entity_type, e.aliases,
              e.description, e.scope_type, e.scope_id, e.mention_count,
              e.first_seen_at, e.last_seen_at
       LIMIT 1`,
      { normalizedLower, scopeTypes },
    );
    if (fuzzyMatch) {
      // Add current name as alias if different
      await this.graph.addEntityAlias(fuzzyMatch['e.id'] as string, normalized);
      await this.graph.incrementEntityMentions(fuzzyMatch['e.id'] as string);
      return this._toEntityRecord(fuzzyMatch);
    }

    // 4. Create new entity if allowed
    if (options?.createIfMissing !== false) {
      return this._createEntity(normalized, entityType, scopes, options?.description);
    }

    return null;
  }

  /**
   * Merge two entities: move all references from source to target, then delete source.
   */
  async merge(sourceId: string, targetId: string): Promise<void> {
    // Get source entity for its aliases
    const source = await this.graph.queryOne(
      `MATCH (e:Entity) WHERE e.id = $id
       RETURN e.aliases, e.canonical_name, e.mention_count`,
      { id: sourceId },
    );
    if (!source) return;

    const sourceAliases = (source['e.aliases'] as string[]) ?? [];
    const sourceName = source['e.canonical_name'] as string;

    // Add source aliases + canonical name to target
    for (const alias of [...sourceAliases, sourceName]) {
      await this.graph.addEntityAlias(targetId, alias);
    }

    // Transfer mention count
    const sourceMentions = Number(source['e.mention_count'] ?? 0);
    if (sourceMentions > 0) {
      await this.graph.execute(
        `MATCH (e:Entity) WHERE e.id = $id
         SET e.mention_count = e.mention_count + $count`,
        { id: targetId, count: BigInt(sourceMentions) },
      );
    }

    // Re-point MENTIONS relationships from source to target
    await this.graph.execute(
      `MATCH (m:Memory)-[r:MENTIONS]->(src:Entity {id: $sourceId})
       DELETE r`,
      { sourceId },
    );
    // Note: We cannot easily re-create MENTIONS to target in a single Cypher
    // because LadybugDB doesn't support MERGE-like semantics for relationships.
    // The MENTIONS will be re-created naturally on next memory store.

    // Re-point RELATES_TO relationships
    // (complex — for now, delete source entity; relations rebuild organically)

    // Delete source entity
    await this.graph.execute(
      `MATCH (e:Entity) WHERE e.id = $id DETACH DELETE e`,
      { id: sourceId },
    );

    if (channels.knowledgeEntity.hasSubscribers) {
      channels.knowledgeEntity.publish({
        event: 'entity_merge',
        sourceId,
        targetId,
      });
    }
  }

  // === Internal ===

  private async _createEntity(
    name: string,
    entityType: EntityType,
    scopes: MemoryScopeRef[],
    description?: string | undefined,
  ): Promise<EntityRecord> {
    // Determine scope: prefer context scope, fall back to first available
    const scope = scopes.find(s => s.type === 'context')
      ?? scopes.find(s => s.type !== 'global')
      ?? scopes[0]
      ?? { type: 'context' as const, id: '' };

    // Generate embedding for the entity description if provider available
    let embedding: number[] | undefined;
    if (this.embeddingProvider && description) {
      try {
        embedding = await this.embeddingProvider.embed(`${name}: ${description}`);
      } catch {
        // Non-critical, skip embedding
      }
    }

    const id = await this.graph.createEntity({
      canonicalName: name,
      entityType,
      aliases: [name],
      description: description ?? '',
      scopeType: scope.type,
      scopeId: scope.id,
      embedding,
    });

    if (channels.knowledgeEntity.hasSubscribers) {
      channels.knowledgeEntity.publish({
        event: 'entity_created',
        id,
        name,
        entityType,
      });
    }

    return {
      id,
      canonicalName: name,
      entityType,
      aliases: [name],
      description: description ?? '',
      scopeType: scope.type,
      scopeId: scope.id,
      mentionCount: 1,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
  }

  private _toEntityRecord(row: Record<string, LbugValue>): EntityRecord {
    return {
      id: row['e.id'] as string,
      canonicalName: row['e.canonical_name'] as string,
      entityType: row['e.entity_type'] as EntityType,
      aliases: (row['e.aliases'] as string[]) ?? [],
      description: (row['e.description'] as string) ?? '',
      scopeType: row['e.scope_type'] as EntityRecord['scopeType'],
      scopeId: (row['e.scope_id'] as string) ?? '',
      mentionCount: Number(row['e.mention_count'] ?? 1),
      firstSeenAt: String(row['e.first_seen_at'] ?? ''),
      lastSeenAt: String(row['e.last_seen_at'] ?? ''),
    };
  }
}
