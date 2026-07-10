import { describe, it, expect, vi } from 'vitest';
import {
  resolveActiveScopes,
  resolveWriteScope,
  scopeWeight,
  scopeToDir,
  parseScopeString,
  formatScopeRef,
  isMoreSpecific,
  inferScopeFromContext,
  buildEmbeddingsMap,
  SCOPE_ORDER,
  SEMANTIC_OVERRIDE_THRESHOLD,
} from './scope-resolver.js';
import type { EmbeddingProvider } from './embedding.js';
import { SCOPE_WEIGHTS } from '../types/index.js';

describe('resolveActiveScopes', () => {
  it('always includes global scope', () => {
    const scopes = resolveActiveScopes({});
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toEqual({ type: 'global', id: 'global' });
  });

  it('includes context scope when contextId is provided', () => {
    const scopes = resolveActiveScopes({ contextId: 'abc123' });
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).toEqual({ type: 'global', id: 'global' });
    expect(scopes[1]).toEqual({ type: 'context', id: 'abc123' });
  });

  it('includes user scope when userId is provided', () => {
    const scopes = resolveActiveScopes({ userId: 'alex' });
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).toEqual({ type: 'global', id: 'global' });
    expect(scopes[1]).toEqual({ type: 'user', id: 'alex' });
  });

  it('includes all 3 scopes when both contextId and userId are provided', () => {
    const scopes = resolveActiveScopes({ contextId: 'ctx1', userId: 'alex' });
    expect(scopes).toHaveLength(3);
    expect(scopes[0]).toEqual({ type: 'global', id: 'global' });
    expect(scopes[1]).toEqual({ type: 'context', id: 'ctx1' });
    expect(scopes[2]).toEqual({ type: 'user', id: 'alex' });
  });

  it('skips user scope when userId is undefined', () => {
    const scopes = resolveActiveScopes({ contextId: 'ctx1', userId: undefined });
    expect(scopes).toHaveLength(2);
    expect(scopes.some(s => s.type === 'user')).toBe(false);
  });

  it('skips context scope when contextId is undefined', () => {
    const scopes = resolveActiveScopes({ userId: 'alex', contextId: undefined });
    expect(scopes).toHaveLength(2);
    expect(scopes.some(s => s.type === 'context')).toBe(false);
  });

  it('empty strings are treated as falsy', () => {
    const scopes = resolveActiveScopes({ contextId: '', userId: '' });
    expect(scopes).toHaveLength(1);
  });

  it('maintains hierarchy order: global > context > user', () => {
    const scopes = resolveActiveScopes({ userId: 'u', contextId: 'c' });
    const types = scopes.map(s => s.type);
    expect(types).toEqual(['global', 'context', 'user']);
  });
});

describe('resolveWriteScope', () => {
  it('returns explicit scope when provided', () => {
    const scope = resolveWriteScope({ type: 'user', id: 'alex' }, 'default-ctx');
    expect(scope).toEqual({ type: 'user', id: 'alex' });
  });

  it('returns default context scope when explicit scope is undefined', () => {
    const scope = resolveWriteScope(undefined, 'ctx-123');
    expect(scope).toEqual({ type: 'context', id: 'ctx-123' });
  });

  it('returns explicit global scope when provided', () => {
    const scope = resolveWriteScope({ type: 'global', id: 'global' }, 'ctx-123');
    expect(scope).toEqual({ type: 'global', id: 'global' });
  });
});

describe('scopeWeight', () => {
  it('returns correct weight for user scope', () => {
    expect(scopeWeight('user')).toBe(1.0);
  });

  it('returns correct weight for context scope', () => {
    expect(scopeWeight('context')).toBe(0.8);
  });

  it('returns correct weight for global scope', () => {
    expect(scopeWeight('global')).toBe(0.3);
  });

  it('matches SCOPE_WEIGHTS values', () => {
    expect(scopeWeight('user')).toBe(SCOPE_WEIGHTS.user);
    expect(scopeWeight('context')).toBe(SCOPE_WEIGHTS.context);
    expect(scopeWeight('global')).toBe(SCOPE_WEIGHTS.global);
  });
});

describe('scopeToDir', () => {
  it('maps global scope to "global"', () => {
    expect(scopeToDir({ type: 'global', id: 'global' })).toBe('global');
  });

  it('maps context scope to bare ID', () => {
    expect(scopeToDir({ type: 'context', id: 'abc123' })).toBe('abc123');
  });

  it('maps user scope to user-prefixed dir', () => {
    expect(scopeToDir({ type: 'user', id: 'alex' })).toBe('user-alex');
  });

  it('handles special characters in IDs', () => {
    expect(scopeToDir({ type: 'context', id: 'a1b2c3d4e5f6' })).toBe('a1b2c3d4e5f6');
    expect(scopeToDir({ type: 'user', id: 'user-name' })).toBe('user-user-name');
  });

  it('rejects path traversal in scope IDs', () => {
    expect(() => scopeToDir({ type: 'context', id: '../../etc' })).toThrow('Invalid scope ID');
    expect(() => scopeToDir({ type: 'user', id: '../passwd' })).toThrow('Invalid scope ID');
  });

  it('rejects empty and invalid scope IDs', () => {
    expect(() => scopeToDir({ type: 'context', id: '' })).toThrow('Invalid scope ID');
    expect(() => scopeToDir({ type: 'user', id: '/absolute' })).toThrow('Invalid scope ID');
  });

  it('rejects dots in scope IDs (path traversal prevention)', () => {
    expect(() => scopeToDir({ type: 'context', id: 'my.project' })).toThrow('Invalid scope ID');
    expect(() => scopeToDir({ type: 'context', id: 'my..project' })).toThrow('Invalid scope ID');
  });
});

describe('parseScopeString', () => {
  it('parses "global" shorthand', () => {
    expect(parseScopeString('global')).toEqual({ type: 'global', id: 'global' });
  });

  it('parses "user:alex"', () => {
    expect(parseScopeString('user:alex')).toEqual({ type: 'user', id: 'alex' });
  });

  it('parses "context:abc123"', () => {
    expect(parseScopeString('context:abc123')).toEqual({ type: 'context', id: 'abc123' });
  });

  it('rejects unknown scope type "project:"', () => {
    expect(parseScopeString('project:abc123')).toBeUndefined();
  });

  it('parses "global:global"', () => {
    expect(parseScopeString('global:global')).toEqual({ type: 'global', id: 'global' });
  });

  it('returns undefined for unknown type', () => {
    expect(parseScopeString('team:t1')).toBeUndefined();
  });

  it('returns undefined for removed scope types', () => {
    expect(parseScopeString('organization:acme')).toBeUndefined();
    expect(parseScopeString('client:c1')).toBeUndefined();
  });

  it('returns undefined for empty ID', () => {
    expect(parseScopeString('user:')).toBeUndefined();
  });

  it('returns undefined for no colon (non-global)', () => {
    expect(parseScopeString('context')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseScopeString('')).toBeUndefined();
  });

  it('handles colons in ID', () => {
    expect(parseScopeString('user:alex:extra')).toEqual({ type: 'user', id: 'alex:extra' });
  });
});

describe('formatScopeRef', () => {
  it('formats global scope', () => {
    expect(formatScopeRef({ type: 'global', id: 'global' })).toBe('global');
  });

  it('formats context scope', () => {
    expect(formatScopeRef({ type: 'context', id: 'abc123' })).toBe('context:abc123');
  });

  it('formats user scope', () => {
    expect(formatScopeRef({ type: 'user', id: 'alex' })).toBe('user:alex');
  });
});

describe('SCOPE_ORDER', () => {
  it('has 3 entries in hierarchy order', () => {
    expect(SCOPE_ORDER).toEqual(['global', 'context', 'user']);
  });
});

describe('isMoreSpecific', () => {
  it('user is more specific than global', () => {
    expect(isMoreSpecific('user', 'global')).toBe(true);
  });

  it('global is not more specific than user', () => {
    expect(isMoreSpecific('global', 'user')).toBe(false);
  });

  it('context is more specific than global', () => {
    expect(isMoreSpecific('context', 'global')).toBe(true);
  });

  it('user is more specific than context', () => {
    expect(isMoreSpecific('user', 'context')).toBe(true);
  });

  it('context is less specific than user', () => {
    expect(isMoreSpecific('context', 'user')).toBe(false);
  });

  it('global is less specific than context', () => {
    expect(isMoreSpecific('global', 'context')).toBe(false);
  });

  it('same type is not more specific', () => {
    expect(isMoreSpecific('user', 'user')).toBe(false);
    expect(isMoreSpecific('context', 'context')).toBe(false);
    expect(isMoreSpecific('global', 'global')).toBe(false);
  });
});

describe('inferScopeFromContext', () => {
  it('returns empty for no entries', () => {
    expect(inferScopeFromContext([])).toEqual([]);
  });

  it('returns empty when entries are in different namespaces', () => {
    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text: 'same content that is long enough for match', scope: { type: 'global', id: 'global' } },
      { namespace: 'methods', text: 'same content that is long enough for match', scope: { type: 'user', id: 'alex' } },
    ]);
    expect(overrides).toEqual([]);
  });

  it('detects override when same namespace + matching prefix', () => {
    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text: 'Use ESLint strict mode for all projects in org', scope: { type: 'global', id: 'global' } },
      { namespace: 'knowledge', text: 'Use ESLint strict mode for all projects in org', scope: { type: 'user', id: 'alex' } },
    ]);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.specificScope.type).toBe('user');
    expect(overrides[0]!.generalScope.type).toBe('global');
  });

  it('detects global->context override', () => {
    const text = 'Always use TypeScript strict mode in all projects and modules';
    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text, scope: { type: 'global', id: 'global' } },
      { namespace: 'knowledge', text, scope: { type: 'context', id: 'ctx1' } },
    ]);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.specificScope.type).toBe('context');
    expect(overrides[0]!.generalScope.type).toBe('global');
  });

  it('detects context->user override', () => {
    const text = 'Deploy with Docker Compose on production always';
    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text, scope: { type: 'context', id: 'ctx1' } },
      { namespace: 'knowledge', text, scope: { type: 'user', id: 'alex' } },
    ]);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.specificScope.type).toBe('user');
    expect(overrides[0]!.generalScope.type).toBe('context');
  });

  it('does not detect override for short text (<10 chars)', () => {
    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text: 'short', scope: { type: 'global', id: 'global' } },
      { namespace: 'knowledge', text: 'short', scope: { type: 'user', id: 'alex' } },
    ]);
    expect(overrides).toHaveLength(0);
  });

  it('does not detect override between same scope types', () => {
    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text: 'same long content across different scopes here', scope: { type: 'user', id: 'alex' } },
      { namespace: 'knowledge', text: 'same long content across different scopes here', scope: { type: 'user', id: 'bob' } },
    ]);
    expect(overrides).toEqual([]);
  });

  it('case-insensitive matching', () => {
    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text: 'Use ESLint strict mode for all code quality', scope: { type: 'global', id: 'global' } },
      { namespace: 'knowledge', text: 'use eslint strict mode for all code quality', scope: { type: 'context', id: 'ctx1' } },
    ]);
    expect(overrides).toHaveLength(1);
  });
});

// --- Helper: create a normalized vector from raw components ---
function normalize(v: number[]): number[] {
  const mag = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return mag === 0 ? v : v.map(x => x / mag);
}

describe('inferScopeFromContext with embeddings', () => {
  it('detects semantic override when cosine similarity >= 0.85', () => {
    // Two identical normalized vectors -> cosine = 1.0
    const vec = normalize([1, 2, 3, 4, 5]);
    const embeddings = new Map<string, number[]>();
    embeddings.set('deploy with docker compose on production', vec);
    embeddings.set('use docker compose for production deploys', vec);

    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text: 'deploy with docker compose on production', scope: { type: 'global', id: 'global' } },
      { namespace: 'knowledge', text: 'use docker compose for production deploys', scope: { type: 'user', id: 'alex' } },
    ], embeddings);

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.specificScope.type).toBe('user');
    expect(overrides[0]!.generalScope.type).toBe('global');
  });

  it('no override when cosine similarity < 0.85', () => {
    // Two orthogonal vectors -> cosine = 0.0
    const vecA = normalize([1, 0, 0, 0, 0]);
    const vecB = normalize([0, 0, 0, 0, 1]);
    const embeddings = new Map<string, number[]>();
    // Texts differ in prefix too (>40 chars mismatch) so prefix match also fails
    embeddings.set('always use TypeScript strict mode in every project codebase', vecA);
    embeddings.set('prefer Python for data science and machine learning workflows', vecB);

    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text: 'always use TypeScript strict mode in every project codebase', scope: { type: 'global', id: 'global' } },
      { namespace: 'knowledge', text: 'prefer Python for data science and machine learning workflows', scope: { type: 'context', id: 'ctx1' } },
    ], embeddings);

    expect(overrides).toHaveLength(0);
  });

  it('falls back to prefix matching when embeddings map is missing the text', () => {
    // Embeddings map exists but does not contain these texts
    const embeddings = new Map<string, number[]>();
    embeddings.set('unrelated text', normalize([1, 0, 0]));

    // Same text in both scopes -> prefix match should fire
    const text = 'Use ESLint strict mode for all projects and modules';
    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text, scope: { type: 'global', id: 'global' } },
      { namespace: 'knowledge', text, scope: { type: 'context', id: 'ctx1' } },
    ], embeddings);

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.specificScope.type).toBe('context');
    expect(overrides[0]!.generalScope.type).toBe('global');
  });

  it('falls back to prefix matching when embeddings parameter is undefined', () => {
    const text = 'Always deploy via CI pipeline for consistency';
    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text, scope: { type: 'global', id: 'global' } },
      { namespace: 'knowledge', text, scope: { type: 'context', id: 'ctx1' } },
    ], undefined);

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.specificScope.type).toBe('context');
    expect(overrides[0]!.generalScope.type).toBe('global');
  });

  it('both semantic and prefix matching can contribute overrides', () => {
    // Pair 1: semantic match (different prefixes, but similar embeddings)
    const similarA = normalize([1, 2, 3, 4]);
    const similarB = normalize([1, 2, 3, 4.1]); // very close -> cosine ~0.9999
    const embeddings = new Map<string, number[]>();
    embeddings.set('deploy containers to kubernetes clusters always', similarA);
    embeddings.set('use k8s for containerized deployment strategy', similarB);

    // Pair 2: prefix match (no embeddings available for these)
    const prefixText = 'run tests before every merge to main branch';

    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text: 'deploy containers to kubernetes clusters always', scope: { type: 'global', id: 'global' } },
      { namespace: 'knowledge', text: 'use k8s for containerized deployment strategy', scope: { type: 'user', id: 'alex' } },
      { namespace: 'methods', text: prefixText, scope: { type: 'global', id: 'global' } },
      { namespace: 'methods', text: prefixText, scope: { type: 'context', id: 'ctx1' } },
    ], embeddings);

    expect(overrides).toHaveLength(2);
    const namespaces = overrides.map(o => o.namespace).sort();
    expect(namespaces).toEqual(['knowledge', 'methods']);
  });

  it('SEMANTIC_OVERRIDE_THRESHOLD is 0.85', () => {
    expect(SEMANTIC_OVERRIDE_THRESHOLD).toBe(0.85);
  });

  it('detects override at exactly 0.85 threshold', () => {
    // Construct two vectors whose cosine similarity is exactly at the threshold.
    // cos(theta) = 0.85 -> theta ~31.79 degrees. Use [cos(0), sin(0)] and [cos(theta), sin(theta)].
    const theta = Math.acos(0.85);
    const vecA = [Math.cos(0), Math.sin(0)];
    const vecB = [Math.cos(theta), Math.sin(theta)];
    const embeddings = new Map<string, number[]>();
    // Different prefix (to ensure only semantic path triggers)
    embeddings.set('always format code with prettier before commit aa', vecA);
    embeddings.set('use code formatter prettier on every staged file bb', vecB);

    const overrides = inferScopeFromContext([
      { namespace: 'knowledge', text: 'always format code with prettier before commit aa', scope: { type: 'global', id: 'global' } },
      { namespace: 'knowledge', text: 'use code formatter prettier on every staged file bb', scope: { type: 'user', id: 'u1' } },
    ], embeddings);

    // cosine ~0.85 -> should just barely be detected (>= threshold)
    expect(overrides).toHaveLength(1);
  });
});

describe('buildEmbeddingsMap', () => {
  it('creates map from texts using provider', async () => {
    const mockProvider: EmbeddingProvider = {
      name: 'mock',
      dimensions: 3,
      embed: vi.fn()
        .mockResolvedValueOnce([0.1, 0.2, 0.3])
        .mockResolvedValueOnce([0.4, 0.5, 0.6]),
    };

    const map = await buildEmbeddingsMap(['hello world', 'foo bar'], mockProvider);

    expect(map.size).toBe(2);
    expect(map.get('hello world')).toEqual([0.1, 0.2, 0.3]);
    expect(map.get('foo bar')).toEqual([0.4, 0.5, 0.6]);
    expect(mockProvider.embed).toHaveBeenCalledTimes(2);
    expect(mockProvider.embed).toHaveBeenCalledWith('hello world');
    expect(mockProvider.embed).toHaveBeenCalledWith('foo bar');
  });

  it('skips failed embeddings gracefully', async () => {
    const mockProvider: EmbeddingProvider = {
      name: 'mock',
      dimensions: 3,
      embed: vi.fn()
        .mockResolvedValueOnce([0.1, 0.2, 0.3])
        .mockRejectedValueOnce(new Error('embedding failed'))
        .mockResolvedValueOnce([0.7, 0.8, 0.9]),
    };

    const map = await buildEmbeddingsMap(['text-a', 'text-b', 'text-c'], mockProvider);

    expect(map.size).toBe(2);
    expect(map.get('text-a')).toEqual([0.1, 0.2, 0.3]);
    expect(map.has('text-b')).toBe(false);
    expect(map.get('text-c')).toEqual([0.7, 0.8, 0.9]);
  });

  it('deduplicates texts before embedding', async () => {
    const mockProvider: EmbeddingProvider = {
      name: 'mock',
      dimensions: 3,
      embed: vi.fn().mockResolvedValue([1, 2, 3]),
    };

    const map = await buildEmbeddingsMap(['same', 'same', 'same'], mockProvider);

    expect(map.size).toBe(1);
    expect(map.get('same')).toEqual([1, 2, 3]);
    expect(mockProvider.embed).toHaveBeenCalledTimes(1);
  });

  it('returns empty map for empty input', async () => {
    const mockProvider: EmbeddingProvider = {
      name: 'mock',
      dimensions: 3,
      embed: vi.fn(),
    };

    const map = await buildEmbeddingsMap([], mockProvider);

    expect(map.size).toBe(0);
    expect(mockProvider.embed).not.toHaveBeenCalled();
  });
});
