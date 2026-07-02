#!/usr/bin/env node
/**
 * Foundation Rework v2 — verb-layer TASK backfill CLI.
 *
 * One-shot command, run INSIDE a quiesced tenant container, that replays the
 * legacy history.db user-TASK rows into the engine.db verb-graph. Tasks are the one
 * verb primitive still legacy-authoritative + mirrored after the S3f write-cutover
 * (S4 will cut them over); workflows + triggers already cut over and their legacy
 * storage is dropped in mig v44, so this backfill covers TASKS only. Because it
 * reads solely the legacy `tasks` table (which v44 never touches) it is safe to run
 * on the S3f image. NOT a boot migration (an operator runs it while quiesced,
 * verifies, and can abort). The PRE-S3f full three-type backfill lives in the
 * v1.22.0 image, which the deploy playbook runs before cutting workflows/triggers.
 *
 * Usage (in-container, e.g. via prod-rafael-exec.sh / staging-tenant-exec.sh):
 *   node dist/scripts/s3-backfill.js              # dry-run: report what WOULD backfill
 *   node dist/scripts/s3-backfill.js --apply      # run the backfill (idempotent)
 *   node dist/scripts/s3-backfill.js --apply --json   # + machine-readable counts
 *   node dist/scripts/s3-backfill.js --data-dir=/home/lynox/.lynox --apply
 *
 * Idempotent: re-running over the same legacy snapshot is convergent (every write
 * is an ON CONFLICT DO UPDATE upsert; preserved legacy timestamps make a re-run
 * land byte-identical rows).
 *
 * No PII gate: every task column relocated here — title / description / tags — is
 * PLAINTEXT in both the legacy and engine.db schema, so there is no at-rest
 * downgrade to guard against. The vault key is still resolved so engine.db opens
 * EXACTLY as the engine does.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureVaultKey, loadVaultKeyFromDotEnv } from '../core/engine-init.js';
import { getLynoxDir, setDataDir } from '../core/config.js';
import { EngineDb } from '../core/engine-db.js';
import { RunHistory } from '../core/run-history.js';
import { getAllTasks } from '../core/run-history-persistence.js';
import { VerbGraphBackfill } from '../core/verb-graph-backfill.js';

export interface Args { apply: boolean; json: boolean; dataDir: string | null }

export function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, json: false, dataDir: null };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a.startsWith('--data-dir=')) args.dataDir = a.slice('--data-dir='.length);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { process.stderr.write(`unknown arg: ${a}\n`); printHelp(); process.exit(2); }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    'verb-layer TASK backfill — relocate legacy history.db tasks into the engine.db verb-graph.\n' +
    '  (no flag)        dry-run: report counts that WOULD backfill\n' +
    '  --apply          run the backfill (idempotent, safe to re-run)\n' +
    '  --json           emit machine-readable counts\n' +
    '  --data-dir=PATH  override the .lynox data dir (else LYNOX_DATA_DIR / ~/.lynox)\n',
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.dataDir) setDataDir(args.dataDir);
  // Resolve the vault key EXACTLY as the engine does so engine.db opens with the
  // same isEncrypted state (a docker-exec'd process does not inherit PID 1's key).
  loadVaultKeyFromDotEnv();
  ensureVaultKey();

  const dir = getLynoxDir();
  const runHistory = new RunHistory();
  const historyDb = runHistory.getDb();

  if (!args.apply) {
    // Dry-run is side-effect-free: it reads only legacy history.db and never
    // constructs EngineDb (whose ctor would migrate/materialize engine.db).
    const tk = getAllTasks(historyDb).length;
    const out = { mode: 'dry-run', legacy: { tasks: tk } };
    process.stdout.write(args.json ? JSON.stringify(out) + '\n'
      : `[s3-backfill] DRY-RUN — would backfill ${tk} tasks. Re-run with --apply.\n`);
    closeAll(null, runHistory);
    return;
  }

  const engineDb = new EngineDb(join(dir, 'engine.db'));
  const applied = new VerbGraphBackfill(engineDb, historyDb).run();

  const edb = engineDb.getDb();
  const post = {
    tasks: (edb.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n,
  };
  const out = { mode: 'apply', applied, post };
  process.stdout.write(args.json ? JSON.stringify(out) + '\n'
    : `[s3-backfill] APPLIED — tasks ${applied.tasks} (${applied.taskParentLinks} parent-links). ` +
      `engine.db now has ${post.tasks} tasks.\n`);
  closeAll(engineDb, runHistory);
}

function closeAll(engineDb: EngineDb | null, runHistory: RunHistory): void {
  if (engineDb) { try { engineDb.close(); } catch { /* best-effort */ } }
  try { runHistory.close(); } catch { /* best-effort */ }
}

// Run only when invoked directly (`node dist/scripts/s3-backfill.js`), not when a
// test imports parseArgs — otherwise main() would run against the test runner's argv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
