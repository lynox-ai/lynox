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
