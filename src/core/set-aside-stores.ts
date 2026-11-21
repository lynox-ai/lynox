import { readdirSync } from 'node:fs';

/** A database that was set aside as corrupt, and the files it left. */
export interface SetAsideStore {
  database: 'history.db' | 'engine.db' | 'datastore.db' | 'agent-memory.db';
  files: string[];
}

// The boot (`onCorruption: 'recreate'`) renames a corrupt history.db or engine.db to
// `<name>.corrupt-<ms>` and opens an empty one in its place; a restore sets any of the four
// databases aside under the same name. Builds before the restore re-check kept the file in place
// could also leave `engine.db.migration-tmp.corrupt-<ms>`. The same names the data erase removes.
// Their `-wal` and `-shm` follow with a suffix and are not listed on their own.
const SET_ASIDE = /^(?:(history|engine|datastore|agent-memory)\.db|(engine)\.db\.migration-tmp)\.corrupt-\d+$/;
const DATABASE: Readonly<Record<string, SetAsideStore['database']>> = {
  history: 'history.db', engine: 'engine.db', datastore: 'datastore.db', 'agent-memory': 'agent-memory.db',
};

/**
 * The databases of `dir` that were set aside, with the set-aside file names (names only, never
 * content). Their data is still on disk but in none of the stores the engine reads, so an export
 * that reads those stores is missing it. Throws when `dir` cannot be listed.
 */
export function listSetAsideStores(dir: string): SetAsideStore[] {
  const byDb = new Map<SetAsideStore['database'], string[]>();
  for (const name of readdirSync(dir)) {
    const m = SET_ASIDE.exec(name);
    const db = DATABASE[m?.[1] ?? m?.[2] ?? ''];
    if (db === undefined) continue;
    const files = byDb.get(db) ?? [];
    files.push(name);
    byDb.set(db, files);
  }
  return [...byDb.entries()]
    .map(([database, files]) => ({ database, files: files.sort() }))
    .sort((a, b) => a.database.localeCompare(b.database));
}
