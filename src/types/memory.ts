// === 4.5 IMemory Interface ===

export type MemoryNamespace = 'knowledge' | 'methods' | 'project-state' | 'learnings';

export const ALL_NAMESPACES: readonly MemoryNamespace[] = ['knowledge', 'methods', 'project-state', 'learnings'];

// === Context ===

export type ContextSource = 'cli' | 'telegram' | 'slack' | 'mcp' | 'pwa';

export interface LynoxContext {
  id: string;              // unique identifier (hash or explicit)
  name?: string | undefined; // human label: "acme-shop.ch", "lynox repo"
  source: ContextSource;
  workspaceDir: string;    // ~/.lynox/workspace/<id>/
  localDir?: string | undefined; // original cwd (CLI only, for file access)
}

// === Memory Scopes ===

export type MemoryScopeType = 'global' | 'context' | 'user';
export const SCOPE_TYPE_SET: ReadonlySet<MemoryScopeType> = new Set(['global', 'context', 'user']);

export interface MemoryScopeRef {
  type: MemoryScopeType;
  id: string;
}

export const SCOPE_WEIGHTS: Record<MemoryScopeType, number> = {
  user: 1.0,
  context: 0.8,
  global: 0.3,
};

/** Result of scope classification (heuristic-based, no API call) */
export interface ScopeClassification {
  scope: MemoryScopeRef;
  confidence: number; // 0-1
  reasoning: string;
}

export interface IMemory {
  load(ns: MemoryNamespace):                                    Promise<string | null>;
  save(ns: MemoryNamespace, content: string):                   Promise<void>;
  append(ns: MemoryNamespace, text: string):                    Promise<void>;
  delete(ns: MemoryNamespace, pattern: string):                 Promise<number>;
  update(ns: MemoryNamespace, oldText: string, newText: string): Promise<boolean>;
  render():                                                     string;
  hasContent():                                                 boolean;
  loadAll():                                                    Promise<void>;
  maybeUpdate(finalAnswer: string, toolsUsed?: number | undefined): Promise<void>;
  // Scope-aware methods (Phase 1)
  appendScoped(ns: MemoryNamespace, text: string, scope: MemoryScopeRef):            Promise<void>;
  loadScoped(ns: MemoryNamespace, scope: MemoryScopeRef):                            Promise<string | null>;
  deleteScoped(ns: MemoryNamespace, pattern: string, scope: MemoryScopeRef):         Promise<number>;
  updateScoped(ns: MemoryNamespace, oldText: string, newText: string, scope: MemoryScopeRef): Promise<boolean>;
  // Phase 3: auto-classification support
  setActiveScopes?(scopes: MemoryScopeRef[]): void;
}

// === Knowledge Graph ===

export type EntityType = 'person' | 'organization' | 'project' | 'product' | 'concept' | 'location' | 'collection';
export const ENTITY_TYPE_SET: ReadonlySet<EntityType> = new Set([
  'person', 'organization', 'project', 'product', 'concept', 'location', 'collection',
]);

/** Namespace-specific temporal decay half-lives in days. */
export const NAMESPACE_HALF_LIFE: Record<MemoryNamespace, number> = {
  'knowledge': 365,
  'methods': 180,
  'learnings': 120,
  'project-state': 21,
};

export interface EntityRecord {
  id: string;
  canonicalName: string;
  entityType: EntityType;
  aliases: string[];
  description: string;
  scopeType: MemoryScopeType;
  scopeId: string;
  mentionCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface RelationRecord {
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  description: string;
  confidence: number;
  sourceMemoryId: string;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  text: string;
  namespace: MemoryNamespace;
  scopeType: MemoryScopeType;
  scopeId: string;
  sourceRunId: string | null;
  isActive: boolean;
  supersededBy: string | null;
  createdAt: string;
  lastRetrievedAt: string | null;
  retrievalCount: number;
}

export interface ContradictionInfo {
  existingMemoryId: string;
  existingText: string;
  similarity: number;
  resolution: 'superseded' | 'coexist' | 'flagged';
}

export interface KnowledgeStoreResult {
  memoryId: string;
  entities: EntityRecord[];
  relations: RelationRecord[];
  contradictions: ContradictionInfo[];
  stored: boolean;
  deduplicated: boolean;
}

export interface KnowledgeRetrievalResult {
  memories: Array<{
    id: string;
    text: string;
    namespace: MemoryNamespace;
    scopeType: MemoryScopeType;
    scopeId: string;
    score: number;
    finalScore: number;
    source: 'vector' | 'graph' | 'fts';
  }>;
  entities: EntityRecord[];
  contextGraph: string;
}

export interface KnowledgeGraphStats {
  memoryCount: number;
  entityCount: number;
  relationCount: number;
  communityCount: number;
  episodeCount: number;
  patternCount: number;
}

// === Episodic Memory ===

export type EpisodeOutcomeSignal = 'success' | 'partial' | 'failed' | 'abandoned' | 'unknown';

export interface EpisodeRecord {
  id: string;
  runId: string | null;
  sessionId: string | null;
  task: string;
  approach: string | null;
  outcome: string | null;
  outcomeSignal: EpisodeOutcomeSignal;
  toolsUsed: string[];
  entitiesInvolved: string[];
  memoriesCreated: string[];
  durationMs: number | null;
  tokenCost: number | null;
  userFeedback: string | null;
  createdAt: string;
}

// === Pattern Engine ===

export type PatternType = 'sequence' | 'preference' | 'schedule' | 'anti-pattern';

export interface PatternRecord {
  id: string;
  patternType: PatternType;
  description: string;
  evidenceCount: number;
  confidence: number;
  lastSeenAt: string;
  metadata: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
}

export type MetricWindow = 'daily' | 'weekly' | 'all_time';

export interface MetricRecord {
  id: string;
  metricName: string;
  scopeType: string | null;
  scopeId: string | null;
  value: number;
  sampleCount: number;
  window: MetricWindow;
  computedAt: string;
}

export interface KnowledgeGcResult {
  supersededRemoved: number;
  orphanEntitiesRemoved: number;
  staleMemoriesRemoved: number;
}

export interface IKnowledgeLayer {
  init(): Promise<void>;
  close(): Promise<void>;

  store(
    text: string,
    namespace: MemoryNamespace,
    scope: MemoryScopeRef,
    options?: {
      sourceRunId?: string | undefined;
      skipContradictionCheck?: boolean | undefined;
      reuseEmbedding?: number[] | undefined;
    },
  ): Promise<KnowledgeStoreResult>;

  retrieve(
    query: string,
    scopes: MemoryScopeRef[],
    options?: {
      topK?: number | undefined;
      threshold?: number | undefined;
      useHyDE?: boolean | undefined;
      useGraphExpansion?: boolean | undefined;
      namespace?: MemoryNamespace | undefined;
    },
  ): Promise<KnowledgeRetrievalResult>;

  resolveEntity(name: string, scopes: MemoryScopeRef[]): Promise<EntityRecord | null>;
  getEntityRelations(entityId: string, depth?: number | undefined): Promise<RelationRecord[]>;
  mergeEntities(sourceId: string, targetId: string): Promise<void>;

  findPath(fromEntityId: string, toEntityId: string, maxHops?: number | undefined): Promise<RelationRecord[]>;
  getNeighborhood(entityId: string, hops?: number | undefined): Promise<{
    entities: EntityRecord[];
    relations: RelationRecord[];
  }>;

  checkContradictions(
    text: string,
    namespace: MemoryNamespace,
    scope: MemoryScopeRef,
  ): Promise<ContradictionInfo[]>;

  deactivateByPattern(pattern: string, namespace?: MemoryNamespace | undefined): Promise<number>;
  updateMemoryText(
    oldText: string,
    newText: string,
    namespace: MemoryNamespace,
    scope: MemoryScopeRef,
  ): Promise<boolean>;

  gc(options?: { dryRun?: boolean | undefined }): Promise<KnowledgeGcResult>;
  stats(): Promise<KnowledgeGraphStats>;

  // === Episodic Memory ===

  createEpisode(params: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    task: string;
    approach?: string | undefined;
    outcome?: string | undefined;
    outcomeSignal?: EpisodeOutcomeSignal | undefined;
    toolsUsed?: string[] | undefined;
    entitiesInvolved?: string[] | undefined;
    durationMs?: number | undefined;
    tokenCost?: number | undefined;
  }): string;

  updateEpisodeOutcome(id: string, params: {
    outcome?: string | undefined;
    outcomeSignal?: EpisodeOutcomeSignal | undefined;
    userFeedback?: string | undefined;
  }): void;

  queryEpisodes(filters?: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    outcomeSignal?: EpisodeOutcomeSignal | undefined;
    limit?: number | undefined;
  }): EpisodeRecord[];

  // === Pattern Engine ===

  getPatterns(opts?: {
    patternType?: PatternType | undefined;
    activeOnly?: boolean | undefined;
    limit?: number | undefined;
  }): PatternRecord[];

  getMetrics(metricName?: string | undefined, window?: MetricWindow | undefined): MetricRecord[];

  // === Intelligence ===

  runIntelligence(): void;
  feedbackOnRetrieval(memoryIds: string[], signal: 'useful' | 'wrong'): void;
  consolidateMemories(namespace: MemoryNamespace, scopeType: string, scopeId: string): number;
}
