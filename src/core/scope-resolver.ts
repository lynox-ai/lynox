import type { MemoryScopeType, MemoryScopeRef, MemoryNamespace } from '../types/index.js';
import { SCOPE_WEIGHTS } from '../types/index.js';
import type { EmbeddingProvider } from './embedding.js';
import { cosineSimilarity } from './embedding.js';

export interface ScopeContext {
  userId?: string | undefined;
  contextId?: string | undefined;
}

/** Hierarchy order from broadest to most specific. */
export const SCOPE_ORDER: MemoryScopeType[] = ['global', 'context', 'user'];

/**
 * Resolve which scopes are active for a given context.
 * Always includes global. Adds context/user if IDs are present.
 * Order: global > context > user.
 */
export function resolveActiveScopes(ctx: ScopeContext): MemoryScopeRef[] {
  const scopes: MemoryScopeRef[] = [
    { type: 'global', id: 'global' },
  ];
  const ctxId = ctx.contextId;
  if (ctxId) scopes.push({ type: 'context', id: ctxId });
  if (ctx.userId) scopes.push({ type: 'user', id: ctx.userId });
  return scopes;
}

/**
 * Resolve the write scope: explicit scope if given, otherwise default to context.
 */
export function resolveWriteScope(
  explicitScope: MemoryScopeRef | undefined,
  defaultContextId: string,
): MemoryScopeRef {
  return explicitScope ?? { type: 'context', id: defaultContextId };
}

/**
 * Get the weight for a scope type.
 */
export function scopeWeight(type: MemoryScopeType): number {
  return SCOPE_WEIGHTS[type];
}

/** Scope IDs must be safe for use as directory names — no path traversal. */
const SAFE_SCOPE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function validateScopeId(id: string): string {
  if (!SAFE_SCOPE_ID.test(id) || id.includes('..')) {
    throw new Error(`Invalid scope ID: ${id}`);
  }
  return id;
}

/**
 * Map a scope reference to a flat-file directory name.
 * 'context' maps to bare ID (same as old 'project' mapping — existing memory dirs stay valid).
 */
export function scopeToDir(scope: MemoryScopeRef): string {
  switch (scope.type) {
    case 'global': return 'global';
    case 'context': return validateScopeId(scope.id);
    case 'user': return `user-${validateScopeId(scope.id)}`;
  }
}

/**
 * Parse a scope string (e.g. "user:alex", "global", "context:abc123") into a MemoryScopeRef.
 * Returns undefined if the string is invalid.
 */
export function parseScopeString(scopeStr: string): MemoryScopeRef | undefined {
  if (scopeStr === 'global') {
    return { type: 'global', id: 'global' };
  }
  const colonIdx = scopeStr.indexOf(':');
  if (colonIdx === -1) return undefined;

  const type = scopeStr.slice(0, colonIdx);
  const id = scopeStr.slice(colonIdx + 1);
  if (!id) return undefined;

  if (type === 'user' || type === 'context' || type === 'global') {
    return { type, id };
  }
  return undefined;
}

/**
 * Format a scope reference as a human-readable string.
 */
export function formatScopeRef(scope: MemoryScopeRef): string {
  if (scope.type === 'global') return 'global';
  return `${scope.type}:${scope.id}`;
}

/**
 * Check if scope type `a` is more specific than `b` in the hierarchy.
 * Global < Context < User.
 */
export function isMoreSpecific(a: MemoryScopeType, b: MemoryScopeType): boolean {
  return SCOPE_ORDER.indexOf(a) > SCOPE_ORDER.indexOf(b);
}

export interface ScopeOverride {
  namespace: MemoryNamespace;
  specificScope: MemoryScopeRef;
  generalScope: MemoryScopeRef;
  specificText: string;
  generalText: string;
}

/** Semantic override detection threshold (cosine similarity) */
export const SEMANTIC_OVERRIDE_THRESHOLD = 0.85;

/**
 * Detect potential overrides where a more specific scope has content in the same
 * namespace that may conflict with a more general scope. Advisory read-only heuristic.
 *
 * When an `embeddingProvider` is supplied, uses cosine similarity for language-agnostic
 * semantic matching. Falls back to 40-char prefix matching without it.
 *
 * Entries are: { namespace, text, scope }
 */
export function inferScopeFromContext(
  entries: Array<{ namespace: MemoryNamespace; text: string; scope: MemoryScopeRef }>,
  embeddings?: Map<string, number[]> | undefined,
): ScopeOverride[] {
  const overrides: ScopeOverride[] = [];

  // Group entries by namespace
  const byNs = new Map<MemoryNamespace, typeof entries>();
  for (const e of entries) {
    const bucket = byNs.get(e.namespace) ?? [];
    bucket.push(e);
    byNs.set(e.namespace, bucket);
  }

  for (const nsEntries of byNs.values()) {
    // Compare each pair: if a more specific scope has similar-looking content, flag it
    for (let i = 0; i < nsEntries.length; i++) {
      for (let j = i + 1; j < nsEntries.length; j++) {
        const a = nsEntries[i]!;
        const b = nsEntries[j]!;
        if (a.scope.type === b.scope.type) continue;

        // Determine which is more specific
        const aMoreSpecific = isMoreSpecific(a.scope.type, b.scope.type);
        const bMoreSpecific = isMoreSpecific(b.scope.type, a.scope.type);
        if (!aMoreSpecific && !bMoreSpecific) continue;

        const specific = aMoreSpecific ? a : b;
        const general = aMoreSpecific ? b : a;

        let isOverride = false;

        if (embeddings) {
          // Semantic comparison via cosine similarity
          const embA = embeddings.get(a.text);
          const embB = embeddings.get(b.text);
          if (embA && embB && embA.length === embB.length) {
            isOverride = cosineSimilarity(embA, embB) >= SEMANTIC_OVERRIDE_THRESHOLD;
          }
        }

        if (!isOverride) {
          // Fallback: first 40 chars overlap (normalized lowercase, trimmed)
          const specNorm = specific.text.toLowerCase().trim().slice(0, 40);
          const genNorm = general.text.toLowerCase().trim().slice(0, 40);
          if (specNorm.length >= 10 && genNorm.length >= 10 && specNorm === genNorm) {
            isOverride = true;
          }
        }

        if (isOverride) {
          overrides.push({
            namespace: specific.namespace,
            specificScope: specific.scope,
            generalScope: general.scope,
            specificText: specific.text.slice(0, 100),
            generalText: general.text.slice(0, 100),
          });
        }
      }
    }
  }

  return overrides;
}

/**
 * Build an embeddings map for a set of texts using the given provider.
 * Returns Map<text, embedding> for use with inferScopeFromContext.
 */
export async function buildEmbeddingsMap(
  texts: string[],
  provider: EmbeddingProvider,
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  const unique = [...new Set(texts)];
  await Promise.all(unique.map(async (text) => {
    try {
      const embedding = await provider.embed(text);
      map.set(text, embedding);
    } catch {
      // Skip failed embeddings — fallback to prefix matching
    }
  }));
  return map;
}
