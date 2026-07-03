#!/usr/bin/env node
/**
 * Foundation Rework v2 — S5a memory-statement backfill CLI.
 *
 * One-shot command, run INSIDE a quiesced tenant container, that replays the legacy
 * agent-memory.db `memories` (statement text + embedding + lifecycle + subject
 * links + supersedes) into the engine.db subject-graph, so the tenant's full memory
 * history is present in engine.db BEFORE the S5b vector-recall cutover reads from it.
 *
 * It runs the FULL subject-graph backfill (`run({ includeMemories: true })`):
 * entities + relations (idempotent — a no-op on a tenant where S2 already ran, but
 * REQUIRED to rebuild the entity→subject map the memory pass links against) THEN the
 * memory pass. Distinct from `s2-backfill` (entities/relations only). Additive +
 * image-revert-safe: nothing reads engine.db memories until S5b.
 *
 * Usage (in-container, e.g. via prod-rafael-exec.sh / staging-tenant-exec.sh):
 *   node dist/scripts/s5-backfill.js              # dry-run: report what WOULD backfill
 *   node dist/scripts/s5-backfill.js --apply      # run the backfill (idempotent)
 *   node dist/scripts/s5-backfill.js --apply --json   # + machine-readable counts
 *   node dist/scripts/s5-backfill.js --data-dir=/home/lynox/.lynox --apply
 *
 * Idempotent: memory stubs upsert on id, subject links + supersedes INSERT OR IGNORE,
 * and co-occurrences are REBUILT from the junction (never incremented) — so a re-run
 * over the same legacy snapshot is convergent, embeddings included.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ensureVaultKey, loadVaultKeyFromDotEnv } from '../core/engine-init.js';
import { getLynoxDir, setDataDir } from '../core/config.js';
import { EngineDb } from '../core/engine-db.js';
import { AgentMemoryDb } from '../core/agent-memory-db.js';
import { SubjectGraphBackfill } from '../core/subject-graph-backfill.js';

export interface Args { apply: boolean; json: boolean; pageSize: number; dataDir: string | null; allowPlaintext: boolean }

export function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, json: false, pageSize: 500, dataDir: null, allowPlaintext: false };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a === '--allow-plaintext') args.allowPlaintext = true;
    else if (a.startsWith('--page-size=')) args.pageSize = Math.max(1, Number(a.slice('--page-size='.length)) || 500);
    else if (a.startsWith('--data-dir=')) args.dataDir = a.slice('--data-dir='.length);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { process.stderr.write(`unknown arg: ${a}\n`); printHelp(); process.exit(2); }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    'S5a memory backfill — replay legacy agent-memory.db memories into the engine.db subject-graph.\n' +
    '  (no flag)        dry-run: report counts that WOULD backfill\n' +
    '  --apply          run the backfill (idempotent, safe to re-run)\n' +
    '  --json           emit machine-readable counts\n' +
    '  --page-size=N    page size for the scans (default 500)\n' +
    '  --data-dir=PATH  override the .lynox data dir (else LYNOX_DATA_DIR / ~/.lynox)\n' +
    '  --allow-plaintext  proceed even when no vault key resolves (writes PII unencrypted)\n',
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.dataDir) setDataDir(args.dataDir);
  const dir = getLynoxDir();

  if (!args.apply) {
    // Dry-run is side-effect-free: it opens ONLY the legacy agent-memory.db and
    // counts (text there is plaintext, so no vault key is needed) — it never
    // resolves/mints a vault key and never constructs EngineDb (whose ctor migrates
    // engine.db). The vault-key resolution below is deliberately in the --apply path.
    const memoryDb = new AgentMemoryDb(join(dir, 'agent-memory.db'));
    const memories = memoryDb.getMemoryCount();
    const supersedes = memoryDb.listAllSupersedes().length;
    memoryDb.close();
    const out = { mode: 'dry-run', legacy: { memories, supersedes } };
    process.stdout.write(args.json ? JSON.stringify(out) + '\n'
      : `[s5-backfill] DRY-RUN — would backfill ${memories} memories, ${supersedes} supersedes. Re-run with --apply.\n`);
    return;
  }

  // --apply only: resolve the vault key EXACTLY as the engine does (env > ~/.lynox/.env
  // > vault.key > auto-gen) so engine.db's HKDF matches the engine's. A docker-exec'd
  // backfill does NOT inherit PID 1's exported key, so the .env read is essential —
  // without it engine.db memory text (PII) would be written under a divergent key.
  loadVaultKeyFromDotEnv();
  ensureVaultKey();

  const engineDb = new EngineDb(join(dir, 'engine.db'));
  const memoryDb = new AgentMemoryDb(join(dir, 'agent-memory.db'));
  try {
    // Safety gate (same as s2-backfill): a tenant with a vault.db has a key the engine
    // uses for engine.db. If we could NOT resolve it, engine.db.enc() would write memory
    // TEXT (PII — customer data flows through memory) PLAINTEXT: a silent at-rest
    // downgrade the engine can't undo. Refuse rather than corrupt; --allow-plaintext is
    // the deliberate override for a genuinely keyless (self-host browse-mode) tenant.
    if (existsSync(join(dir, 'vault.db')) && !engineDb.isEncrypted && !args.allowPlaintext) {
      process.stderr.write(
        '✗ vault.db present but no vault key resolved — refusing to write PII unencrypted. ' +
        'Set LYNOX_VAULT_KEY in the exec env or ~/.lynox/.env, or pass --allow-plaintext to override.\n');
      process.exitCode = 1;
      return;
    }

    const applied = new SubjectGraphBackfill(engineDb, memoryDb).run({ pageSize: args.pageSize, includeMemories: true });

    const post = { memories: (engineDb.getDb().prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n };
    const out = { mode: 'apply', applied, post };
    process.stdout.write(args.json ? JSON.stringify(out) + '\n'
      : `[s5-backfill] APPLIED — memories ${applied.memoriesMapped} (${applied.memoriesSubjectless} subject-less) · ` +
        `supersedes ${applied.supersedesMapped}. engine.db now has ${post.memories} memories.\n`);
  } finally {
    closeAll(engineDb, memoryDb);
  }
}

function closeAll(engineDb: EngineDb, memoryDb: AgentMemoryDb): void {
  try { engineDb.close(); } catch { /* best-effort */ }
  try { memoryDb.close(); } catch { /* best-effort */ }
}

// Run only when invoked directly (`node dist/scripts/s5-backfill.js`), not when a
// test imports parseArgs — otherwise main() would run against the test runner's argv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
