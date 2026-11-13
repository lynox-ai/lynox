import Database from 'better-sqlite3';

/**
 * A consistent copy of a SQLite store, taken with `VACUUM INTO` (crash-safe, consistent even
 * while another connection writes in WAL mode). One helper for the three writers that copy a
 * store — backup, migration export and the data export — which differ in everything after the
 * copy (backup keeps the ciphertext and restores bytes, migration ships the store to another
 * engine, the export decrypts and writes parts), so the copy is the one step they share.
 *
 * `destPath` must not exist: SQLite refuses to vacuum into an existing file.
 */
export function snapshotSqlite(srcPath: string, destPath: string): void {
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(srcPath, { readonly: true });
    // The path is a literal in the statement: escape the single quote, the only character that ends it.
    const safePath = destPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${safePath}'`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * An upper bound on the bytes a snapshot of `srcPath` takes: its page count times its page size.
 * `VACUUM INTO` writes no more pages than the source has in use (freelist pages are dropped), so
 * the bound holds for the copy. Read on a read-only connection.
 */
export function snapshotBound(srcPath: string): number {
  const db = new Database(srcPath, { readonly: true });
  try {
    const pages = db.pragma('page_count', { simple: true }) as number;
    const size = db.pragma('page_size', { simple: true }) as number;
    return pages * size;
  } finally {
    db.close();
  }
}
