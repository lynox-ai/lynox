/**
 * How the engine's boot lines about DataStore tables name a table in the container log.
 *
 * A table's name is run text: the model names a table (`data_store_create`), and it can name it
 * after what a run read from a store. On an instance with an exact connection the log names no
 * table, as the error text beside these lines is reduced there (`error-egress.ts`): a line about
 * one table says "a table", a line about several counts them,
 * and the database's own text, which can quote the table it failed on, is left out. Elsewhere
 * the lines read as they did, which self-hosted debugging reads.
 *
 * The lines themselves stay `process.stderr.write` calls in `engine.ts`, and the database's text
 * stays inline in its line, so the census of error sinks (`error-egress-census.test.ts`) still
 * sees it there.
 */

/** One table: `table "<name>"`, or `a table` when `reduced` (or the name is not a valid one). */
export function tableInLog(name: string | null, reduced: boolean): string {
  if (reduced) return 'a table';
  return name === null ? 'a table with an invalid name' : `table "${name}"`;
}
