/**
 * Shared low-level SQLite tuning constants for the per-tenant engine DBs
 * (engine.db, history.db, datastore.db, agent-memory.db).
 */

/**
 * How long a connection waits for a held lock before throwing SQLITE_BUSY.
 * The operator subject-sweep opens a second handle against the live engine's
 * DBs; without this, that contention throws an instant SQLITE_BUSY — which
 * mid-migration used to be mistaken for corruption and trigger a data-destroying
 * recreate. 5s comfortably outlasts any single-statement write.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * Turn on `secure_delete` for a connection. Without it a `DELETE` takes a row out
 * of every query and leaves its bytes on the freed page, where `strings` still
 * reads them; with it SQLite overwrites deleted content with zeros. Per connection,
 * so every store that holds user data calls this where it opens.
 */
export function zeroDeletedContent(db: { pragma: (source: string) => unknown }): void {
  db.pragma('secure_delete = ON');
}

/**
 * Checkpoint the WAL into the main file and truncate it to zero bytes. The WAL
 * keeps every page image it was written with, so a value that was deleted from the
 * main file can still be read from the `-wal` file until this runs. Throws when
 * another connection holds the WAL open (`busy`), because then the old images may
 * still be there and the caller must not report them gone.
 */
export function truncateWal(db: { pragma: (source: string) => unknown }): void {
  const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  if ((rows[0]?.busy ?? 0) !== 0) {
    throw new Error('WAL checkpoint was blocked by another connection; deleted pages may remain in the WAL');
  }
}
