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
 * reads them; with it SQLite overwrites the content of every page THIS connection
 * frees. Pages freed before it was on (or by a connection without it) keep their
 * bytes on the freelist, and so can stale copies of rows that are still live; only
 * `scrubFreedPages` reaches those. Per connection, so every store that holds user
 * data calls this where it opens.
 */
export function zeroDeletedContent(db: { pragma: (source: string) => unknown }): void {
  db.pragma('secure_delete = ON');
}

/**
 * Rebuild the file without its free pages, then checkpoint the WAL into it and
 * truncate the WAL to zero bytes. `VACUUM` writes a fresh copy of every live page
 * and drops the rest, so nothing that sat on the freelist survives, however it got
 * there. The WAL keeps every page image it was written with, so a deleted value can
 * still be read from the `-wal` file until the checkpoint runs. Throws when another
 * connection is inside a read or write transaction (`busy` after the busy timeout),
 * because then the old images may still be there and the caller must not report
 * them gone. Costs a full rewrite of the file: meant for after an erasure, when the
 * store is close to empty, not for routine deletes.
 */
export function scrubFreedPages(db: { exec: (source: string) => unknown; pragma: (source: string) => unknown }): void {
  db.exec('VACUUM');
  const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  if ((rows[0]?.busy ?? 0) !== 0) {
    throw new Error('WAL checkpoint was blocked by another connection; deleted pages may remain in the WAL');
  }
}
