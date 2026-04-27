/**
 * Knowledge-graph cleanup.
 *
 * The pre-v2 entity extractor (`entity-extractor.ts`) had an incomplete
 * stopword list and no guard against pricing fragments, so KGs created
 * before v1.3.4 contain bad rows like `in` (person), `tools` (location),
 * `39/mo` (project), `create/update` (project). v2 rejects all of these
 * at extraction time, but legacy data remains until purged.
 *
 * `cleanupBadEntities()` walks every entity row, matches against
 * {@link isCleanupTarget} from `./kg-stopwords.js` (same gate as v2 uses
 * at write-time) and deletes the offenders along with their
 * mentions/relations/cooccurrences via deleteEntity.
 *
 * Safe to run repeatedly. Honors a `dryRun` flag for preview.
 */

import type { AgentMemoryDb } from './agent-memory-db.js';
import { isCleanupTarget } from './kg-stopwords.js';

export { isCleanupTarget } from './kg-stopwords.js';

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
