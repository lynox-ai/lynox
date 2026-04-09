import type { MemoryScopeRef, ScopeClassification } from '../types/index.js';

/**
 * Classify which scope a memory entry belongs to using a simple heuristic.
 * No API call — instant, zero cost.
 *
 * Rules:
 * - Text mentions personal preference → user scope
 * - Universally applicable → global scope
 * - Default → context scope
 */
export function classifyScope(
  text: string,
  _namespace: string,
  activeScopes: MemoryScopeRef[],
  _options?: {
    model?: string | undefined;
    apiKey?: string | undefined;
    apiBaseURL?: string | undefined;
    projectId?: string | undefined;
  },
): ScopeClassification {
  // Default fallback: context scope (or first non-global scope, or global)
  const fallbackScope = activeScopes.find(s => s.type === 'context')
    ?? activeScopes.find(s => s.type !== 'global')
    ?? activeScopes[0]
    ?? { type: 'context' as const, id: '' };

  if (activeScopes.length <= 1) {
    return { scope: fallbackScope, confidence: 1.0, reasoning: 'Single scope active' };
  }

  const lower = text.toLowerCase();

  // Personal preference patterns → user scope (EN + DE + FR)
  const userPatterns = [
    // English
    'i prefer', 'my preference', 'i like', 'i want', 'my style',
    'my editor', 'my workflow', 'i always', 'i never', 'i usually',
    'my config', 'my setup', 'personally',
    // German
    'ich bevorzuge', 'meine präferenz', 'ich nutze immer', 'ich will',
    'mein workflow', 'bei mir', 'persönlich', 'ich mag', 'ich verwende',
    'mein setup', 'meine konfiguration',
    // French
    'je préfère', 'ma préférence', "j'utilise toujours", 'personnellement',
  ];
  const userScope = activeScopes.find(s => s.type === 'user');
  if (userScope && userPatterns.some(p => lower.includes(p))) {
    return { scope: userScope, confidence: 0.8, reasoning: 'Personal preference detected' };
  }

  // Universal knowledge patterns → global scope (EN + DE + FR)
  const globalPatterns = [
    // English
    'best practice', 'always use', 'never use', 'general rule',
    'industry standard', 'convention', 'pattern', 'anti-pattern',
    'security', 'performance tip',
    // German
    'best practice', 'immer verwenden', 'nie verwenden', 'grundregel',
    'branchenstandard', 'konvention', 'sicherheit',
    // French
    'bonne pratique', 'toujours utiliser', 'ne jamais utiliser',
    'règle générale', 'convention',
  ];
  const globalScope = activeScopes.find(s => s.type === 'global');
  if (globalScope && globalPatterns.some(p => lower.includes(p))) {
    return { scope: globalScope, confidence: 0.7, reasoning: 'Universal knowledge detected' };
  }

  // Default: context scope
  return { scope: fallbackScope, confidence: 0.6, reasoning: 'Default context scope' };
}
