/**
 * Knowledge-graph cleanup.
 *
 * The pre-v2 entity extractor (`entity-extractor.ts`) had an incomplete
 * stopword list and no guard against pricing fragments, so KGs created
 * before v1.3.4 contain bad rows like `in` (person), `tools` (location),
 * `39/mo` (project), `create/update` (project). v2 rejects all of these
 * at extraction time, but legacy data remains until purged.
 *
 * `cleanupBadEntities()` walks every entity row, matches against the
 * extended stopword set + pricing pattern, and deletes the offenders
 * (along with their mentions/relations/cooccurrences via deleteEntity).
 *
 * Safe to run repeatedly. Honors a `dryRun` flag for preview.
 */

import type { AgentMemoryDb } from './agent-memory-db.js';

/**
 * Bad single-word names. Lowercase. Matched against `entity.name.toLowerCase()`
 * exactly (no substring) so we don't nuke legitimate compounds like
 * "Personal Access Token" or "GitHub Tools".
 */
export const KG_CLEANUP_STOPWORDS: ReadonlySet<string> = new Set([
  // Prepositions / conjunctions / particles
  'in', 'on', 'at', 'to', 'of', 'for', 'with', 'by', 'from', 'into',
  // Verbs that v1 mis-promoted to entities
  'sync', 'syncs', 'syncing', 'synced',
  'provides', 'provided', 'providing',
  'generates', 'generated', 'generating',
  'validation', 'validates', 'validate',
  'create', 'creates', 'created', 'creating',
  'update', 'updates', 'updated', 'updating',
  'delete', 'deletes', 'deleted', 'deleting',
  'fetch', 'fetches', 'fetched', 'fetching',
  'process', 'processes', 'processed', 'processing',
  'manage', 'manages', 'managed', 'managing',
  'review', 'reviews', 'reviewed', 'reviewing',
  'launch', 'launches', 'launched', 'launching',
  'build', 'builds', 'built', 'building',
  // Generic concept nouns
  'tools', 'tool', 'einzeltools',
  'workflow', 'workflows',
  'timeline', 'timelines',
  'pipeline', 'pipelines',
  'dashboard', 'dashboards',
  'setup', 'config', 'configuration',
  'project', 'projects',
  'personal',
  'direct', 'interactive',
  // Adjective fragments
  'standard', 'default', 'custom',
]);

/** Currency- or per-period pricing fragments. Case-insensitive. */
export const KG_CLEANUP_PRICING_RE =
  /^(?:(?:chf|eur|usd|gbp|\$|€|£)\s*)?\d+(?:[.,]\d+)?\s*\/\s*(?:mo|yr|k|month|year|hour|hr|day|week|wk)$/i;

/**
 * Slash-separated enum/verb pairs that aren't org/repo. v1 captured these
 * as PROJECT via REPO_RE; we drop both halves if either side is generic.
 */
export const KG_CLEANUP_ENUM_RE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/i;

export function isCleanupTarget(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (KG_CLEANUP_PRICING_RE.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  if (!lower.includes(' ') && KG_CLEANUP_STOPWORDS.has(lower)) return true;
  const slash = KG_CLEANUP_ENUM_RE.exec(lower);
  if (slash) {
    const parts = /^([a-z0-9-]+)\/([a-z0-9-]+)$/i.exec(lower);
    if (parts) {
      const left = parts[1];
      const right = parts[2];
      if ((left && KG_CLEANUP_STOPWORDS.has(left)) || (right && KG_CLEANUP_STOPWORDS.has(right))) return true;
    }
  }
  return false;
}

export interface CleanupResult {
  scanned: number;
  matched: number;
  purged: number;
  sample: { id: string; name: string; type: string }[];
}

/**
 * Iterate every entity row and purge those matching `isCleanupTarget`.
 * `dryRun` returns the same shape but skips deletion (purged === 0,
 * matched === would-be-purged count).
 */
export function cleanupBadEntities(db: AgentMemoryDb, opts?: { dryRun?: boolean }): CleanupResult {
  const dryRun = opts?.dryRun === true;
  const total = db.getEntityCount();
  const sample: { id: string; name: string; type: string }[] = [];
  let matched = 0;
  let purged = 0;

  const PAGE = 200;
  for (let offset = 0; offset < total; offset += PAGE) {
    const rows = db.listEntities({ limit: PAGE, offset });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!isCleanupTarget(row.canonical_name)) continue;
      matched++;
      if (sample.length < 20) sample.push({ id: row.id, name: row.canonical_name, type: row.entity_type });
      if (!dryRun) {
        db.deleteEntity(row.id);
        purged++;
      }
    }
  }

  return { scanned: total, matched, purged, sample };
}
