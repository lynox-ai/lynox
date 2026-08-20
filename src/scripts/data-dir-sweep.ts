/**
 * Report what is on a data dir that `data-dir-inventory.ts` does not declare.
 *
 * The static coverage gate sees the SOURCE, and its recall is measured, not assumed:
 * 6 of 8 path shapes a review pass constructed are caught; helper indirection and a spread
 * argument still evade it, and nothing static can see a directory that arrived some OTHER
 * way at all. Both leftovers found on a live instance on 2026-08-20 were exactly that:
 * an `ads-optimizer.db` from a feature that never merged, holding one real customer
 * profile, and a hand-placed `files/` holding a customer contract — invisible to backup,
 * to migration, and to any code scan, because no code creates them.
 *
 * So this is the runtime half. It reads a data dir, compares it against the table, and
 * exits non-zero when something is there that nobody declared.
 *
 *   node dist/scripts/data-dir-sweep.js [--data-dir=PATH] [--json]
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getLynoxDir, setDataDir } from '../core/config.js';
import { DATA_DIR_INVENTORY } from '../core/data-dir-inventory.js';

export interface SweepFinding {
  name: string;
  kind: 'dir' | 'file';
  bytes: number;
}

export interface SweepResult {
  dataDir: string;
  undeclared: SweepFinding[];
  declaredButAbsent: string[];
  /** Declared entries that are carried by a backup and have grown past `OVERSIZE_BYTES`. */
  oversize: SweepFinding[];
}

/**
 * A backed-up directory past this size is worth an operator's attention. `workspace/` is the
 * agent's own file area — written by the fs tools and by `bash`, with no cap and no
 * exclusions — and every backup copies it recursively, checksums each file, optionally
 * encrypts each, and optionally uploads the result to Google Drive, daily, kept 30 days.
 * Measured at 12 KiB today; the risk is what it becomes, so the sweep says so before the
 * bill does.
 */
export const OVERSIZE_BYTES = 100 * 1024 * 1024;

/** SQLite sidecars belong to their database, not to the entry they would otherwise look like. */
const SIDECAR = /\.(db-wal|db-shm)$/;
/** Timestamped copies the engine itself leaves beside a database during a migration. */
const ENGINE_BACKUP = /\.(bak-|pre-s\d)/;

function sizeOf(path: string): number {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const entry of readdirSync(path)) total += sizeOf(join(path, entry));
    return total;
  } catch { return 0; }
}

export function sweepDataDir(dataDir: string): SweepResult {
  const declared = new Set(DATA_DIR_INVENTORY.map(e => e.name));
  const undeclared: SweepFinding[] = [];
  const present = new Set<string>();

  for (const name of existsSync(dataDir) ? readdirSync(dataDir) : []) {
    present.add(name);
    if (declared.has(name) || SIDECAR.test(name) || ENGINE_BACKUP.test(name)) continue;
    const path = join(dataDir, name);
    let isDir = false;
    try { isDir = statSync(path).isDirectory(); } catch { continue; }
    undeclared.push({ name, kind: isDir ? 'dir' : 'file', bytes: sizeOf(path) });
  }

  const oversize: SweepFinding[] = [];
  for (const entry of DATA_DIR_INVENTORY) {
    if (!entry.backup || !present.has(entry.name)) continue;
    const bytes = sizeOf(join(dataDir, entry.name));
    if (bytes > OVERSIZE_BYTES) oversize.push({ name: entry.name, kind: entry.kind === 'dir' ? 'dir' : 'file', bytes });
  }

  return {
    dataDir,
    undeclared: undeclared.sort((a, b) => b.bytes - a.bytes),
    declaredButAbsent: DATA_DIR_INVENTORY.map(e => e.name).filter(n => !present.has(n)).sort(),
    oversize: oversize.sort((a, b) => b.bytes - a.bytes),
  };
}

export function main(): void {
  const args = process.argv.slice(2);
  const dirArg = args.find(a => a.startsWith('--data-dir='));
  if (dirArg) setDataDir(dirArg.slice('--data-dir='.length));
  const result = sweepDataDir(getLynoxDir());

  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    process.stdout.write(`[data-dir-sweep] ${result.dataDir}\n`);
    if (result.undeclared.length === 0) {
      process.stdout.write('  nothing undeclared.\n');
    } else {
      process.stdout.write(`  ${String(result.undeclared.length)} UNDECLARED — in no backup list, no migration list, and no deletion path:\n`);
      for (const f of result.undeclared) {
        process.stdout.write(`    ${f.kind === 'dir' ? 'DIR ' : 'FILE'} ${f.name}  ${String(Math.round(f.bytes / 1024))} KiB\n`);
      }
    }
    for (const f of result.oversize) {
      process.stdout.write(`  OVERSIZE ${f.name} is ${String(Math.round(f.bytes / (1024 * 1024)))} MiB and rides EVERY backup (checksummed, optionally encrypted, optionally uploaded)\n`);
    }
    if (result.declaredButAbsent.length > 0) {
      process.stdout.write(`  declared but absent here (fine — most entries are created on demand): ${result.declaredButAbsent.join(', ')}\n`);
    }
  }
  if (result.undeclared.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
