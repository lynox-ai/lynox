/**
 * Single source of truth for "this string is not a real entity".
 *
 * Used by:
 *   - {@link ./entity-extractor-v2.ts} as a post-filter on LLM tool-call output.
 *     Even with a strict prompt, Haiku occasionally returns common nouns at
 *     ≥0.8 confidence; this guards write-time.
 *   - {@link ./kg-cleanup.ts} as the rule for the historical purge.
 *
 * Keeping the gate in one file means the prompt, the runtime filter, and the
 * cleanup endpoint can never drift apart.
 *
 * Extending the set: add lowercase singular AND plural for safety. Only add
 * generic nouns / verbs / adjectives — never add tokens that could be a real
 * proper noun (e.g. don't add "apple", "amazon").
 */

/**
 * Bad single-word names. Lowercase. Matched against `name.toLowerCase()`
 * exactly (no substring) so we don't nuke legitimate compounds like
 * "Personal Access Token" or "GitHub Tools".
 */
export const KG_COMMON_NOUNS: ReadonlySet<string> = new Set([
  // Prepositions / conjunctions / particles / WH-words
  'in', 'on', 'at', 'to', 'of', 'for', 'with', 'by', 'from', 'into',
  'when', 'where', 'how', 'why',
  // Verbs that v1 mis-promoted to entities
  'sync', 'syncs', 'syncing', 'synced',
  'provides', 'provided', 'providing',
  'generates', 'generated', 'generating',
  'validation', 'validates', 'validate',
  'create', 'creates', 'created', 'creating', 'creation',
  'update', 'updates', 'updated', 'updating',
  'delete', 'deletes', 'deleted', 'deleting',
  'fetch', 'fetches', 'fetched', 'fetching',
  'process', 'processes', 'processed', 'processing',
  'manage', 'manages', 'managed', 'managing',
  'review', 'reviews', 'reviewed', 'reviewing',
  'launch', 'launches', 'launched', 'launching',
  'build', 'builds', 'built', 'building',
  'log', 'logs', 'logging', 'logged',
  'monitor', 'monitors', 'monitoring', 'monitored',
  'support', 'supports', 'supported', 'supporting',
  // Generic concept nouns
  'tools', 'tool', 'einzeltools',
  'workflow', 'workflows',
  'timeline', 'timelines',
  'pipeline', 'pipelines',
  'dashboard', 'dashboards',
  'setup', 'config', 'configuration',
  'project', 'projects',
  'notification', 'notifications',
  'message', 'messages',
  'name', 'names',
  'street', 'number', 'numbers',
  'personal',
  'direct', 'interactive',
  // Adjective fragments
  'standard', 'default', 'custom',
  'strict', 'strictest',
  // Generic business/process nouns observed polluting the graph (2026-07 cleanup).
  // These reached the graph as bare person/org entities @≥0.8 — never a proper noun.
  'management', 'compliance', 'data', 'input', 'inputs', 'output', 'outputs',
  'page', 'pages', 'website', 'websites', 'information', 'feedback',
  'segment', 'segments', 'target', 'targets', 'estimate', 'estimates',
  'note', 'notes', 'owner', 'owners', 'shareholder', 'shareholders',
  'identifying', 'deployment', 'deployments', 'dismissal',
  'clarification', 'confirmation', 'communication', 'communications',
  'count', 'counts', 'agreement', 'agreements', 'opt', 'import', 'imports',
  'service', 'services', 'testimonial', 'testimonials', 'meeting', 'meetings',
  'online', 'offline', 'news',
  // English function words mis-promoted to person/org
  'as', 'before', 'has', 'have', 'had', 'must', 'will', 'would', 'work', 'works',
  // German function/generic words
  'ist', 'sitzt', 'als', 'vor', 'hat', 'muss', 'wird',
]);

/**
 * Currency- or per-period pricing fragments AND digit-only ratios with
 * unit suffixes ("10/1k", "5/100m"). Case-insensitive.
 *
 * Two alternations:
 *   1. Optional currency + number + slash + named period   →  "CHF 39/mo"
 *   2. Plain number + slash + number(+ optional k/m/b)     →  "10/1k", "5/100"
 */
export const KG_PRICING_RE =
  /^(?:(?:chf|eur|usd|gbp|\$|€|£)\s*)?\d+(?:[.,]\d+)?\s*\/\s*(?:\d+[kmb]?|mo|mos|month|months|yr|yrs|year|years|k|hour|hours|hr|hrs|h|day|days|d|week|weeks|wk|min|mins|sec)$/i;

/**
 * Slash-separated enum/verb pairs that aren't org/repo. v1 captured these
 * as PROJECT via REPO_RE; we drop both halves if either side is generic.
 */
export const KG_ENUM_RE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/i;

/**
 * Returns true if `name` is a generic noun, pricing fragment, or slash-enum
 * with at least one generic half. Case-insensitive on the input.
 *
 * Single source of truth for both the v2 extractor post-filter and the
 * historical cleanup pass.
 */
export function isCleanupTarget(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (KG_PRICING_RE.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  if (!lower.includes(' ') && KG_COMMON_NOUNS.has(lower)) return true;
  // Phrase-fragment slash pairs: two all-lowercase alphabetic words (≥3 chars
  // each, no digits/hyphens/domains). Real slash-entities (AC/DC, TCP/IP,
  // S/4HANA, hyphenated org/repo) survive — they carry uppercase, digits, or
  // hyphens. Catches "death/disability", "risk/safety", "home/lynox".
  if (/^[a-z]{3,}\/[a-z]{3,}$/.test(lower)) return true;
  if (KG_ENUM_RE.test(lower)) {
    const parts = lower.match(/^([a-z0-9-]+)\/([a-z0-9-]+)$/i);
    if (parts) {
      const left = parts[1];
      const right = parts[2];
      if ((left && KG_COMMON_NOUNS.has(left)) || (right && KG_COMMON_NOUNS.has(right))) return true;
    }
  }
  return false;
}
