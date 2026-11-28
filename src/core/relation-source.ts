/**
 * The read rule for a relation whose source memory is retired.
 *
 * Both relation stores (`agent-memory.db` `relations`, `engine.db` `relationships`)
 * carry `source_memory_id` next to a `memories` table of the same database with
 * `is_active` + `superseded_by`. A relation follows the memory that carries its fact
 * today: when a memory is replaced by the same fact (a consolidation, a tier raise, a
 * move to another scope), its relations are moved onto the successor in the same write
 * ({@link repointRelationsSql}). A source that is retired and still holds relations is
 * therefore either gone for the user (deleted, removed from an edited memory document)
 * or replaced because it was contradicted, and the relation belongs to that outdated
 * fact. Either way it is hidden, and the GC removes it before the memory itself.
 *
 * A relation whose source is NULL (CRM, backfill) or no longer present stays readable.
 * That relies on the GC removing a retired source's relations before the memory;
 * otherwise a reaped source would read as missing and its relations would show again.
 *
 * `alias` is the SQL alias of the relation table in the calling query. The
 * subquery is correlated through it, so it must be a bare identifier.
 */
export function sourceDeletedSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM memories src_m WHERE src_m.id = ${alias}.source_memory_id`
    + ' AND src_m.is_active = 0)';
}

/** The readable side of {@link sourceDeletedSql}. */
export function sourceKeptSql(alias: string): string {
  return `NOT ${sourceDeletedSql(alias)}`;
}

/**
 * The GC's delete of every relation whose source memory is retired, for `table`
 * (`relations` or `relationships`). Runs before the retired memories are deleted, so
 * no relation outlives its source as a readable edge (see {@link sourceDeletedSql}).
 */
export function reapRetiredSourceSql(table: 'relations' | 'relationships'): string {
  return `DELETE FROM ${table} WHERE source_memory_id IN (SELECT id FROM memories WHERE is_active = 0)`;
}

/**
 * Move every relation of `fromId` onto `toId`: the source was replaced by the same fact.
 * Bound parameters: `toId`, then `fromId`.
 */
export function repointRelationsSql(table: 'relations' | 'relationships'): string {
  return `UPDATE ${table} SET source_memory_id = ? WHERE source_memory_id = ?`;
}

/** The longest replacement chain the migration follows. Measured chains reach 19 links. */
export const CHAIN_DEPTH_LIMIT = 64;

/**
 * The chain of every retired source that names a successor, followed to its end: the
 * first memory that is active, or retired without a successor (deleted). `start` is the
 * source, `end_id` its end. A chain that reaches a memory no longer present, loops, or
 * runs past {@link CHAIN_DEPTH_LIMIT} links has no end and is not listed.
 */
function chainEndsCte(table: 'relations' | 'relationships'): string {
  return `WITH RECURSIVE walk(start, cur, depth) AS (
      SELECT m.id, m.superseded_by, 1 FROM memories m
       WHERE m.is_active = 0 AND m.superseded_by IS NOT NULL
         AND m.id IN (SELECT source_memory_id FROM ${table} WHERE source_memory_id IS NOT NULL)
      UNION
      SELECT w.start, m.superseded_by, w.depth + 1 FROM walk w JOIN memories m ON m.id = w.cur
       WHERE m.is_active = 0 AND m.superseded_by IS NOT NULL AND w.depth < ${CHAIN_DEPTH_LIMIT}
    ),
    ends AS (
      SELECT w.start, MIN(w.cur) AS end_id, MAX(m.is_active) AS end_active FROM walk w
        JOIN memories m ON m.id = w.cur
       WHERE m.is_active = 1 OR m.superseded_by IS NULL
       GROUP BY w.start
    )`;
}

/**
 * The one-time move of relations whose source was replaced before relations followed
 * their fact: each goes to the end of its source's chain. An active end carries the fact
 * on; a deleted end hides the relation and lets the GC remove it, as the user deleted
 * that fact. A chain without an end leaves the relation where it is, on a retired source,
 * so it is hidden and removed too: whether the missing memory was deleted or replaced
 * cannot be told, and keeping it would leave a relation no later deletion can reach.
 * Running it again changes nothing: every moved relation then has an active or deleted
 * source, which no chain starts from.
 */
export function repointToChainEndSql(table: 'relations' | 'relationships'): string {
  return `${chainEndsCte(table)}
    UPDATE ${table} SET source_memory_id = (SELECT end_id FROM ends WHERE ends.start = ${table}.source_memory_id)
     WHERE source_memory_id IN (SELECT start FROM ends);`;
}

/**
 * What {@link repointToChainEndSql} will do, counted before it runs: relations moved to an
 * active end, to a deleted end, and left on a source whose chain has no end. Counts only.
 */
export function chainEndCountsSql(table: 'relations' | 'relationships'): string {
  return `${chainEndsCte(table)}
    SELECT
      (SELECT COUNT(*) FROM ${table} r JOIN ends e ON e.start = r.source_memory_id WHERE e.end_active = 1) AS to_active,
      (SELECT COUNT(*) FROM ${table} r JOIN ends e ON e.start = r.source_memory_id WHERE e.end_active = 0) AS to_deleted,
      (SELECT COUNT(*) FROM ${table} r JOIN memories m ON m.id = r.source_memory_id
        WHERE m.is_active = 0 AND m.superseded_by IS NOT NULL
          AND r.source_memory_id NOT IN (SELECT start FROM ends)) AS without_end`;
}

/** Writes the counts of {@link chainEndCountsSql} to stderr: numbers only, never content. */
export function logChainEndCounts(store: string, counts: { to_active: number; to_deleted: number; without_end: number } | undefined): void {
  if (!counts) return;
  process.stderr.write(
    `[lynox:memory] ${store}: relations of replaced memories moved to the current memory: ${counts.to_active}, `
    + `to a deleted memory: ${counts.to_deleted}, left on a memory whose successor is gone: ${counts.without_end}\n`,
  );
}

