#!/usr/bin/env node
/**
 * Foundation Rework v2 — verb-layer backfill CLI (manual re-sync / repair).
 *
 * One-shot command that replays ALL legacy history.db verb DEFINITIONS — saved
 * workflows (`pipeline_runs status='planned'`), agent-triggers (`triggers`), and
 * user-tasks (`tasks`) — into the engine.db verb-graph. It shares the SAME
 * {@link VerbGraphBackfill} the engine runs automatically at boot (B1 self-heal,
 * gated once by the engine.db marker): a v1.22.0→v2.0.0 tenant is migrated on the
 * upgrade boot with no operator action. This CLI stays as a MANUAL re-sync / repair
 * tool — run it INSIDE a tenant container to force a re-backfill (e.g. after a
 * restore). Since mig v44 is now non-destructive, the legacy tables survive as its
 * source; running --apply also stamps the boot marker so the engine won't re-run it.
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
import { getLynoxDir, setDataDir, loadConfig } from '../core/config.js';
import { EngineDb } from '../core/engine-db.js';
import { RunHistory } from '../core/run-history.js';
import { getAllTasks, getAllPlannedPipelines, getLegacyTriggerRows } from '../core/run-history-persistence.js';
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
    'verb-layer backfill — relocate legacy history.db workflows+triggers+tasks into the engine.db verb-graph.\n' +
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
    // Dry-run is side-effect-free: it reads only the legacy history.db tables and
    // never constructs EngineDb (whose ctor would migrate/materialize engine.db).
    // (Since mig v44 is now non-destructive, merely opening RunHistory above no
    // longer drops anything either — the dry-run is fully read-only.)
    const legacy = {
      workflows: getAllPlannedPipelines(historyDb).length,
      triggers: getLegacyTriggerRows(historyDb).length,
      tasks: getAllTasks(historyDb).length,
    };
    const out = { mode: 'dry-run', legacy };
    process.stdout.write(args.json ? JSON.stringify(out) + '\n'
      : `[s3-backfill] DRY-RUN — would backfill ${legacy.workflows} workflow(s), ` +
        `${legacy.triggers} trigger(s), ${legacy.tasks} task(s). Re-run with --apply.\n`);
    closeAll(null, runHistory);
    return;
  }

  const engineDb = new EngineDb(join(dir, 'engine.db'));
  // S4a: resolve each task's assignee → subject only when the tenant is flag-ON
  // (a flag-OFF backfill mints no subjects, keeping engine.db subject-free).
  const resolveAssignee = loadConfig().subject_graph_enabled === true;
  const applied = new VerbGraphBackfill(engineDb, historyDb).run({ resolveAssignee });
  // A manual re-sync also satisfies the boot marker — the engine won't re-run it.
  engineDb.markVerbBackfillDone();

  const edb = engineDb.getDb();
  const post = {
    workflows: (edb.prepare('SELECT COUNT(*) n FROM workflows').get() as { n: number }).n,
    triggers: (edb.prepare('SELECT COUNT(*) n FROM triggers').get() as { n: number }).n,
    tasks: (edb.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n,
  };
  const out = { mode: 'apply', applied, post };
  process.stdout.write(args.json ? JSON.stringify(out) + '\n'
    : `[s3-backfill] APPLIED — workflows ${applied.workflows}, triggers ${applied.triggers}, ` +
      `tasks ${applied.tasks} (${applied.taskParentLinks} parent-links). engine.db now has ` +
      `${post.workflows} workflow(s), ${post.triggers} trigger(s), ${post.tasks} task(s).\n`);
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
