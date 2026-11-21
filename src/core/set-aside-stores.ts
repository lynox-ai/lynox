import { readdirSync } from 'node:fs';

/** A database the boot set aside because it looked corrupt, and the files it left. */
export interface SetAsideStore {
  database: 'history.db' | 'engine.db';
  files: string[];
}

// The boot (`onCorruption: 'recreate'`) renames a corrupt history.db or engine.db to
// `<name>.corrupt-<ms>` and opens an empty one in its place; its `-wal` and `-shm` follow with a
// suffix and are not listed on their own. A restore that sets its target aside leaves the same name.
const SET_ASIDE = /^(history|engine)\.db\.corrupt-\d+$/;

/**
 * The databases of `dir` the boot set aside, with the set-aside file names (names only, never
 * content). Their data is still on disk but in none of the stores the engine reads, so an export
 * that reads those stores is missing it. Throws when `dir` cannot be listed.
 */
export function listSetAsideStores(dir: string): SetAsideStore[] {
  const byDb = new Map<SetAsideStore['database'], string[]>();
  for (const name of readdirSync(dir)) {
    const m = SET_ASIDE.exec(name);
    if (!m) continue;
    const db: SetAsideStore['database'] = m[1] === 'history' ? 'history.db' : 'engine.db';
    const files = byDb.get(db) ?? [];
    files.push(name);
    byDb.set(db, files);
  }
  return [...byDb.entries()]
    .map(([database, files]) => ({ database, files: files.sort() }))
    .sort((a, b) => a.database.localeCompare(b.database));
}
