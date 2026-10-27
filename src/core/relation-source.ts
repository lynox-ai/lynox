/**
 * The read rule for a relation whose source memory was retired without a successor.
 *
 * Both relation stores (`agent-memory.db` `relations`, `engine.db` `relationships`)
 * carry `source_memory_id` next to a `memories` table of the same database with
 * `is_active` + `superseded_by`. A memory retired WITH a successor was replaced
 * (contradiction, consolidation) and its relations still describe what the user
 * knows. A memory retired without one (`is_active = 0`, `superseded_by` NULL) is
 * gone for the user: deleted by them, removed from an edited memory document, or
 * moved to another scope (re-extracted there). Its relations are hidden, so what
 * the user removed does not keep showing up through the edges derived from it.
 *
 * A relation whose source is NULL (CRM, backfill) or no longer present (the
 * memory was reaped) stays readable. That relies on the GC removing such a
 * source's relations before the memory itself; otherwise a reaped source would
 * read as missing and its relations would show again.
 *
 * `alias` is the SQL alias of the relation table in the calling query. The
 * subquery is correlated through it, so it must be a bare identifier.
 */
export function sourceDeletedSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM memories src_m WHERE src_m.id = ${alias}.source_memory_id`
    + ' AND src_m.is_active = 0 AND src_m.superseded_by IS NULL)';
}

/** The readable side of {@link sourceDeletedSql}. */
export function sourceKeptSql(alias: string): string {
  return `NOT ${sourceDeletedSql(alias)}`;
}
