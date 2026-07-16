// === 4.5 IMemory Interface ===

export type MemoryNamespace = 'knowledge' | 'methods' | 'status' | 'learnings';

export const ALL_NAMESPACES: readonly MemoryNamespace[] = ['knowledge', 'methods', 'status', 'learnings'];

// === Context ===

export type ContextSource = 'cli' | 'pwa';

export interface LynoxContext {
  id: string;              // unique identifier (hash or explicit)
  name?: string | undefined; // human label: "acme-shop.ch", "lynox repo"
  source: ContextSource;
  workspaceDir: string;    // ~/.lynox/workspace/<id>/
  localDir?: string | undefined; // original cwd (CLI only, for file access)
}

// === Memory Scopes ===

export type MemoryScopeType = 'global' | 'context' | 'user';

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
  maybeUpdate(finalAnswer: string, toolsUsed?: number | undefined, sourceThreadId?: string | undefined, sourceRunId?: string | undefined): Promise<void>;
  // Scope-aware methods (Phase 1)
  appendScoped(ns: MemoryNamespace, text: string, scope: MemoryScopeRef):            Promise<void>;
  loadScoped(ns: MemoryNamespace, scope: MemoryScopeRef):                            Promise<string | null>;
  deleteScoped(ns: MemoryNamespace, pattern: string, scope: MemoryScopeRef, options?: { exact?: boolean | undefined } | undefined): Promise<number>;
  updateScoped(ns: MemoryNamespace, oldText: string, newText: string, scope: MemoryScopeRef): Promise<boolean>;
  // Phase 3: auto-classification support
  setActiveScopes?(scopes: MemoryScopeRef[]): void;
}

// === Knowledge Graph ===

export type EntityType = 'person' | 'organization' | 'project' | 'product' | 'concept' | 'location' | 'collection';

/** Namespace-specific temporal decay half-lives in days. */
export const NAMESPACE_HALF_LIFE: Record<MemoryNamespace, number> = {
  'knowledge': 365,
  'methods': 180,
  'learnings': 120,
  'status': 21,
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

// === Provenance (SSOT — PRD v3 "provenance lifecycle") ===

/**
 * Source tier of a stored datum — the trust property that must travel WITH the
 * data through storage, recall, and compaction (never re-derivable: a guessed
 * value is otherwise byte-identical to a verified one).
 * - `user_asserted`       — the user stated it (authoritative for intent).
 * - `tool_verified`       — produced by a tool result this session (fresh, citable).
 * - `agent_inferred`      — the model derived/extracted it without a tool call.
 * - `external_unverified` — from untrusted external content (e.g. a fetched page).
 */
export type ProvenanceKind =
  | 'user_asserted'
  | 'tool_verified'
  | 'agent_inferred'
  | 'external_unverified';

export const ALL_PROVENANCE_KINDS: readonly ProvenanceKind[] = [
  'user_asserted',
  'tool_verified',
  'agent_inferred',
  'external_unverified',
];

/** Conservative default when the capture site can't determine the tier. */
export const DEFAULT_PROVENANCE_KIND: ProvenanceKind = 'agent_inferred';

// === Durable Knowledge Substrate (DK.1) ===

/** The shape of a durable knowledge entry. `block_edit` records a memory-block edit as an
 *  auditable archival row (DK.2 apply-on-approval); the rest are the substantive kinds. */
export type KnowledgeKind = 'fact' | 'preference' | 'rule' | 'event' | 'block_edit';
export const ALL_KNOWLEDGE_KINDS: readonly KnowledgeKind[] = ['fact', 'preference', 'rule', 'event', 'block_edit'];

/** Lifecycle status of a knowledge entry. Only `active` is agent-readable; `pending_review`
 *  is queued (not yet knowledge); `rejected`/`superseded` are kept (auditable), not deleted. */
export type KnowledgeStatus = 'active' | 'pending_review' | 'rejected' | 'superseded';

/** The two STORED memory blocks (the `focus` block is derived per turn, never persisted). */
export type MemoryBlockId = 'profile' | 'playbook';
export const ALL_MEMORY_BLOCK_IDS: readonly MemoryBlockId[] = ['profile', 'playbook'];

/** Default char bounds — the loud-error boundary for each block (no silent trim). */
export const MEMORY_BLOCK_CHAR_LIMITS: Readonly<Record<MemoryBlockId, number>> = {
  profile: 2000,
  playbook: 3000,
};

/** The derived `focus` block cap (≤2 subject cards). Derived per turn, never stored. */
export const FOCUS_BLOCK_CHAR_LIMIT = 2500;

/** A durable knowledge entry (decrypted view). Mirrors the v9 `knowledge_entries` table. */
export interface KnowledgeEntry {
  id: string;
  subjectId: string | null;
  /** Surface name when the write was not (or not yet) subject-linked. Never minted. */
  subjectHint: string | null;
  kind: KnowledgeKind;
  text: string;
  pinned: boolean;
  /** 0 = incidental, 1 = normal, 2 = important. */
  importance: number;
  status: KnowledgeStatus;
  sourceChannel: string | null;
  sourceUntrusted: boolean;
  /** Derived trust tier (re-derivable from the evidence columns via provenance.ts). */
  sourceType: ProvenanceKind;
  sourceThreadId: string | null;
  sourceRunId: string | null;
  supersededBy: string | null;
  reviewedAt: string | null;
  reviewAction: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Edit modes for `memory_block_edit`. */
export type MemoryBlockEditMode = 'replace' | 'append' | 'remove';

export interface MemoryRecord {
  id: string;
  text: string;
  namespace: MemoryNamespace;
  scopeType: MemoryScopeType;
  scopeId: string;
  sourceRunId: string | null;
  sourceType: ProvenanceKind;
  sourceToolName: string | null;
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
  /**
   * The provenance tier of the EXISTING (contradicted) row — carried forward from the
   * recall row so the write-trust gate (Memory Foundation Wave 2) can decide, at the
   * single resolution-finalization site, whether the incoming write is trusted enough
   * to retire it. Optional: pre-gate callers / rows without a projected `source_type`
   * leave it undefined (the gate then treats the pair as ungated — legacy behaviour).
   */
  existingSourceType?: ProvenanceKind | undefined;
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
    /** Where this row came from in the retrieval pipeline. `'recency'` is
     *  used by `KnowledgeLayer.listRecentActive` (no-query memory_recall) —
     *  these rows are date-ordered, not similarity-ranked. */
    source: 'vector' | 'graph' | 'fts' | 'recency';
    /** Provenance tier captured at write time — surfaced as a structural
     *  `<fact kind=…>` marker at recall (PRD v3). Volatile per-fact metadata:
     *  rides the uncached ephemeral context block, never the cached prefix. */
    sourceType: ProvenanceKind;
    sourceToolName: string | null;
    /** Stored confidence of the datum (0–1), distinct from the relevance
     *  `score`/`finalScore`. Surfaced in the recall marker. */
    confidence: number;
    createdAt: string;
  }>;
  entities: EntityRecord[];
  contextGraph: string;
}

export interface KnowledgeGraphStats {
  memoryCount: number;
  entityCount: number;
  relationCount: number;
  communityCount: number;
}

// === Metrics ===

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
      // Interface had drifted: the impl already accepts (and persists)
      // sourceThreadId — declare it so callers are typed against reality.
      sourceThreadId?: string | undefined;
      // Wave 1.3: callers supply EVIDENCE (channel + untrusted signal), never a tier.
      // The tier is derived at the store boundary (§3). `sourceType` is intentionally gone.
      sourceChannel?: string | undefined;
      sourceUntrusted?: boolean | undefined;
      sourceToolName?: string | undefined;
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

  /** Recency-ordered slice for the no-query `memory_recall` path. Optional
   *  on the interface so non-KnowledgeLayer impls (or test doubles) don't
   *  have to wire it; the caller falls back gracefully via optional-chaining. */
  listRecentActive?(
    namespace: MemoryNamespace,
    scopes: MemoryScopeRef[],
    limit?: number,
  ): KnowledgeRetrievalResult['memories'];

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
  eraseByPattern(pattern: string, namespace?: MemoryNamespace | undefined): Promise<number>;
  updateMemoryText(
    oldText: string,
    newText: string,
    namespace: MemoryNamespace,
    scope: MemoryScopeRef,
  ): Promise<boolean>;

  gc(options?: { dryRun?: boolean | undefined }): Promise<KnowledgeGcResult>;
  stats(): Promise<KnowledgeGraphStats>;

  // === Metrics ===

  getMetrics(metricName?: string | undefined, window?: MetricWindow | undefined): MetricRecord[];

  // === Intelligence ===

  runIntelligence(): void;
  feedbackOnRetrieval(memoryIds: string[], signal: 'useful' | 'wrong'): void;
  consolidateMemories(namespace: MemoryNamespace, scopeType: string, scopeId: string): number;
}
