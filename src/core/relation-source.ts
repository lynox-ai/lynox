/**
 * The read rule for a relation whose source memory the user deleted.
 *
 * Both relation stores (`agent-memory.db` `relations`, `engine.db` `relationships`)
 * carry `source_memory_id` next to a `memories` table of the same database with
 * `is_active` + `superseded_by`. A memory deleted by the user is `is_active = 0`
 * with no successor; a memory replaced by another (contradiction, consolidation)
 * is `is_active = 0` WITH one. Only the deleted case hides a relation: what the
 * user removed must not keep showing up through the edges derived from it, while a
 * replaced memory's edges still describe what the user knows.
 *
 * A relation whose source is NULL (CRM, backfill) or no longer present (the
 * memory was reaped) stays readable: the reap removes a deleted source's
 * relations before the memory itself, so neither state comes from a deletion
 * after it. What such a relation came from before that cannot be told apart.
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
