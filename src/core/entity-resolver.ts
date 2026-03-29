import type { EntityRecord, EntityType, MemoryScopeRef } from '../types/index.js';
import type { AgentMemoryDb, EntityRow } from './agent-memory-db.js';
import type { EmbeddingProvider } from './embedding.js';
import { channels } from './observability.js';

/**
 * Resolves entity names to canonical graph entities.
 *
 * Resolution priority:
 * 1. Exact match on canonical_name (case-insensitive)
 * 2. Exact match on any alias
 * 3. Create new entity if no match found
 */
export class EntityResolver {
  constructor(
    private readonly db: AgentMemoryDb,
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

    // 1. Exact canonical match (case-insensitive, scope-filtered)
    const exactMatch = this.db.findEntityByCanonicalName(normalized, scopeTypes);
    if (exactMatch) {
      this.db.incrementEntityMentions(exactMatch.id);
      return toEntityRecord(exactMatch);
    }

    // 2. Alias match
    const aliasMatch = this.db.findEntityByAlias(normalized);
    if (aliasMatch) {
      this.db.incrementEntityMentions(aliasMatch.id);
      return toEntityRecord(aliasMatch);
    }

    // 3. Canonical match without scope filter (fallback)
    const anyMatch = this.db.findEntityByCanonicalName(normalized);
    if (anyMatch) {
      this.db.addEntityAlias(anyMatch.id, normalized);
      this.db.incrementEntityMentions(anyMatch.id);
      return toEntityRecord(anyMatch);
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
    const source = this.db.getEntity(sourceId);
    if (!source) return;

    const sourceAliases = JSON.parse(source.aliases) as string[];

    // Add source aliases + canonical name to target
    for (const alias of [...sourceAliases, source.canonical_name]) {
      this.db.addEntityAlias(targetId, alias);
    }

    // Transfer mention count
    if (source.mention_count > 0) {
      const target = this.db.getEntity(targetId);
      if (target) {
        // Increment target mentions by source count (minus the 1 already there)
        for (let i = 0; i < source.mention_count; i++) {
          this.db.incrementEntityMentions(targetId);
        }
      }
    }

    // Delete source entity (cascades mentions, relations, cooccurrences)
    this.db.deleteEntity(sourceId);

    if (channels.knowledgeEntity.hasSubscribers) {
      channels.knowledgeEntity.publish({ event: 'entity_merge', sourceId, targetId });
    }
  }

  // === Internal ===

  private async _createEntity(
    name: string,
    entityType: EntityType,
    scopes: MemoryScopeRef[],
    description?: string | undefined,
  ): Promise<EntityRecord> {
    const scope = scopes.find(s => s.type === 'context')
      ?? scopes.find(s => s.type !== 'global')
      ?? scopes[0]
      ?? { type: 'context' as const, id: '' };

    let embedding: number[] | undefined;
    if (this.embeddingProvider && description) {
      try {
        embedding = await this.embeddingProvider.embed(`${name}: ${description}`);
      } catch {
        // Non-critical
      }
    }

    const id = this.db.createEntity({
      canonicalName: name,
      entityType,
      aliases: [name],
      description: description ?? '',
      scopeType: scope.type,
      scopeId: scope.id,
      embedding,
    });

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
}

/** Convert a DB row to an EntityRecord. */
export function toEntityRecord(row: EntityRow): EntityRecord {
  return {
    id: row.id,
    canonicalName: row.canonical_name,
    entityType: row.entity_type as EntityType,
    aliases: JSON.parse(row.aliases) as string[],
    description: row.description,
    scopeType: row.scope_type as EntityRecord['scopeType'],
    scopeId: row.scope_id,
    mentionCount: row.mention_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}
