#!/usr/bin/env node
/**
 * Foundation Rework v2 — S2 data backfill CLI.
 *
 * One-shot command, run INSIDE a quiesced tenant container, that replays the
 * legacy agent-memory.db entity/relation graph + the CRM contacts into the
 * engine.db subject-graph so the tenant's full history is present BEFORE
 * `subject_graph_enabled` flips ON. NOT a boot migration (it must be run by an
 * operator while the tenant is quiesced, verified before exposing, and abortable).
 *
 * Usage (in-container, e.g. via prod-rafael-exec.sh / staging-tenant-exec.sh):
 *   node dist/scripts/s2-backfill.js              # dry-run: report what WOULD map
 *   node dist/scripts/s2-backfill.js --apply      # run the re-map (idempotent)
 *   node dist/scripts/s2-backfill.js --apply --json   # + machine-readable counts
 *   node dist/scripts/s2-backfill.js --data-dir=/home/lynox/.lynox --apply
 *
 * Idempotent: re-running over the same legacy snapshot is convergent (findOrCreate
 * name-dedup, the (from,kind,to) edge upsert, the deterministic engagement id).
 * Reads each DB's LIVE schema_version on open (never a hardcoded number).
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ensureVaultKey, loadVaultKeyFromDotEnv } from '../core/engine-init.js';
import { getLynoxDir, setDataDir } from '../core/config.js';
import { EngineDb } from '../core/engine-db.js';
import { AgentMemoryDb } from '../core/agent-memory-db.js';
import { DataStore } from '../core/data-store.js';
import { CRM } from '../core/crm.js';
import { SubjectStore, entityTypeToSubjectKind, ENTITY_MAPPABLE_SUBJECT_KINDS } from '../core/subject-store.js';
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
    'S2 backfill — re-map legacy agent-memory.db + CRM into the engine.db subject-graph.\n' +
    '  (no flag)        dry-run: report counts that WOULD map\n' +
    '  --apply          run the re-map (idempotent, safe to re-run)\n' +
    '  --json           emit machine-readable counts\n' +
    '  --page-size=N    page size for the scans (default 500)\n' +
    '  --data-dir=PATH  override the .lynox data dir (else LYNOX_DATA_DIR / ~/.lynox)\n' +
    '  --allow-plaintext  proceed even when no vault key resolves (writes PII unencrypted)\n',
  );
}

/**
 * Count legacy entities whose type maps to a subject kind (the re-map's input
 * size, for the dry-run report). Uses listAllEntities (unclamped, PK-ordered) —
 * NOT listEntities, which clamps to 200 and would undercount past one page.
 */
function countMappableEntities(memoryDb: AgentMemoryDb, pageSize: number): number {
  let n = 0;
  for (let offset = 0; ; offset += pageSize) {
    const batch = memoryDb.listAllEntities({ limit: pageSize, offset });
    for (const e of batch) if (entityTypeToSubjectKind(e.entity_type)) n++;
    if (batch.length < pageSize) break;
  }
  return n;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.dataDir) setDataDir(args.dataDir);
  // Resolve the vault key EXACTLY as the engine does (env > ~/.lynox/.env >
  // vault.key > auto-gen) so engine.db's HKDF matches the engine's. A docker-exec'd
  // backfill does NOT inherit PID 1's exported key, so the .env read is essential —
  // without it engine.db PII would be written under a divergent key (or plaintext).
  loadVaultKeyFromDotEnv();
  ensureVaultKey();

  const dir = getLynoxDir();
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  const memoryDb = new AgentMemoryDb(join(dir, 'agent-memory.db'));
  const dataStore = new DataStore(join(dir, 'datastore.db'));
  const crm = new CRM(dataStore, { engineDb, subjectGraphEnabled: true });
  const subjects = new SubjectStore(engineDb);

  const legacyRelations = memoryDb.getRelationCount();
  const legacyContacts = dataStore.queryRecords({ collection: 'contacts', limit: 1 }).total;

  if (!args.apply) {
    const legacyMappableEntities = countMappableEntities(memoryDb, args.pageSize);
    const out = { mode: 'dry-run', legacy: { mappableEntities: legacyMappableEntities, relations: legacyRelations, contacts: legacyContacts } };
    process.stdout.write(args.json ? JSON.stringify(out) + '\n'
      : `[s2-backfill] DRY-RUN — would map ~${legacyMappableEntities} entities, ${legacyRelations} relations, ${legacyContacts} contacts. Re-run with --apply.\n`);
    closeAll(engineDb, memoryDb, dataStore);
    return;
  }

  // Safety gate: a tenant with a vault.db has an encryption key the engine uses for
  // engine.db. If we could NOT resolve it (e.g. the key was passed via `docker run
  // -e`, not .env, so a docker-exec'd backfill can't see it), engine.db.enc() would
  // write people.email/phone PLAINTEXT — a silent at-rest downgrade the engine can't
  // undo. Refuse rather than corrupt; --allow-plaintext is the deliberate override
  // for a genuinely keyless (self-host browse-mode) tenant.
  if (existsSync(join(dir, 'vault.db')) && !engineDb.isEncrypted && !args.allowPlaintext) {
    process.stderr.write(
      '✗ vault.db present but no vault key resolved — refusing to write PII unencrypted. ' +
      'Set LYNOX_VAULT_KEY in the exec env or ~/.lynox/.env, or pass --allow-plaintext to override.\n');
    closeAll(engineDb, memoryDb, dataStore);
    process.exit(1);
  }

  const kg = new SubjectGraphBackfill(engineDb, memoryDb).run({ pageSize: args.pageSize });
  const crmCounts = crm.backfillSubjectGraph({ pageSize: args.pageSize });

  const postSubjects = subjects.count({ kinds: ENTITY_MAPPABLE_SUBJECT_KINDS });
  const postRelationships = (engineDb.getDb().prepare('SELECT COUNT(*) n FROM relationships').get() as { n: number }).n;
  const postPeople = (engineDb.getDb().prepare('SELECT COUNT(*) n FROM people').get() as { n: number }).n;

  const out = {
    mode: 'apply',
    legacy: { mappableEntities: kg.entitiesMapped, relations: legacyRelations, contacts: legacyContacts },
    applied: { ...kg, contacts: crmCounts.contacts },
    post: { mappableSubjects: postSubjects, relationships: postRelationships, people: postPeople },
  };
  process.stdout.write(args.json ? JSON.stringify(out) + '\n'
    : `[s2-backfill] APPLIED — entities ${kg.entitiesMapped} mapped / ${kg.entitiesDropped} dropped · ` +
      `relations ${kg.relationsMapped} mapped / ${kg.relationsDropped} dropped · contacts ${crmCounts.contacts}. ` +
      `engine.db now has ${postSubjects} mappable subjects, ${postRelationships} relationships, ${postPeople} people.\n`);
  closeAll(engineDb, memoryDb, dataStore);
}

function closeAll(engineDb: EngineDb, memoryDb: AgentMemoryDb, dataStore: DataStore): void {
  try { engineDb.close(); } catch { /* best-effort */ }
  try { memoryDb.close(); } catch { /* best-effort */ }
  try { dataStore.close(); } catch { /* best-effort */ }
}

// Run only when invoked directly (`node dist/scripts/s2-backfill.js`), not when a
// test imports parseArgs — otherwise main() would run against the test runner's argv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
