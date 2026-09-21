/**
 * seed — prepares a fresh engine data directory BEFORE the engine boots.
 *
 * Runs inside the engine image, as the engine's own user, against the run's data
 * volume (see env.mjs `seedVolume`). Two things only, both through the engine's own
 * code or plain files — never hand-written SQL, so the seeded state has exactly the
 * shape the engine itself would have produced:
 *
 *   1. files under /seed-in/workspace/ are copied to <lynox dir>/workspace/;
 *   2. collections listed in /seed-in/collections.json are created through
 *      `DataStore.createCollection`, the same call `data_store_create` makes.
 *
 * Why (2) exists: the engine registers the data-store tools only when a collection
 * already exists at boot. A configured setup prepares its tables; the recurring flow
 * fills them. The probe therefore measures the filling, not the table creation.
 *
 * It FAILS rather than seeding nothing. An earlier version guarded each step with
 * `existsSync`, which returns false for a directory it may not read — so an
 * unreadable seed dir produced "seeded: true" and an empty volume. Every input is
 * now read directly (an access error throws), and the result is read back and
 * reported as counts the caller compares against what it asked for.
 */
import { cpSync, readFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SEED = '/seed-in';
const dist = process.env.LYNOX_DIST ?? '/app/dist';
const { getLynoxDir } = await import(`${dist}/core/config.js`);
const lynoxDir = getLynoxDir();

const entries = readdirSync(SEED); // throws on EACCES — deliberately
const report = { lynoxDir, files: 0, collections: [] };

function countFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    n += statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

if (entries.includes('workspace')) {
  const dest = join(lynoxDir, 'workspace');
  mkdirSync(dest, { recursive: true });
  cpSync(join(SEED, 'workspace'), dest, { recursive: true });
  report.files = countFiles(dest);
  report.workspace = relative('/', dest);
}

if (entries.includes('collections.json')) {
  const { DataStore } = await import(`${dist}/core/data-store.js`);
  const store = new DataStore();
  const specs = JSON.parse(readFileSync(join(SEED, 'collections.json'), 'utf8'));
  for (const spec of specs) {
    store.createCollection({
      name: spec.name,
      // The tool's own default when the model passes no scope (data_store_create).
      scope: spec.scope ?? { type: 'context', id: '' },
      columns: spec.columns,
      uniqueKey: spec.uniqueKey,
    });
  }
  report.collections = store.listCollections().map(c => c.name).sort();
  store.close();
}

process.stdout.write(JSON.stringify(report) + '\n');
