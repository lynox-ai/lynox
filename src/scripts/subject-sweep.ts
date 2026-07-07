#!/usr/bin/env node
/**
 * Subject garbage-sweep — Slice 1: ARCHIVE phase (Approach C, Fable-designed).
 *
 * A one-shot command, run INSIDE a tenant container, that soft-archives the legacy
 * junk subjects the old extractor minted (faithfully copied into engine.db by
 * s5-backfill). The M1–M5 write path already BLOCKS new junk; this is a bounded,
 * reversible cleanup of legacy debt, NOT a standing lifecycle service.
 *
 * What it does (archive phase):
 *   - candidate ⇔ `isCleanupTarget(subjects.name)` (the single-source junk oracle,
 *     kg-stopwords.ts) — no parallel predicate; escaped-slash names are REPORTED for
 *     human review (fix by extending kg-stopwords, which also hardens write-time).
 *   - guardrails (skip + report, never archive): is_self, has active children,
 *     referenced by a verb/noun row (tasks/triggers/connections/artifacts/engagements),
 *     a history.db thread anchor, or a detail row with substantive data (email/phone/
 *     domain/vat_id) — a "junk" name with a real email is a misclassified real entity.
 *   - archive = one UPDATE on `subjects` (touches nothing else) + NULL the primary
 *     `memories.subject_id` that pointed at the junk (a strict ranking improvement:
 *     a junk primary scores UNRELATED 0.3 under anchored threads vs the flat
 *     scopeWeight 0.8/1.0 fallback — retrieval-engine.ts). Memories are NEVER deleted;
 *     the vector recall path is subject-independent.
 *
 * Reversible: a JSON ledger (full before-state) is written to
 * `~/.lynox/sweeps/sweep-<ts>.json` BEFORE mutating; `--rollback=<ledger>` restores.
 *
 * Usage (in-container, via prod-rafael-exec.sh / staging-tenant-exec.sh):
 *   node dist/scripts/subject-sweep.js                    # dry-run report
 *   node dist/scripts/subject-sweep.js --apply            # archive + write ledger
 *   node dist/scripts/subject-sweep.js --apply --json
 *   node dist/scripts/subject-sweep.js --rollback=<ledger-path>
 *   node dist/scripts/subject-sweep.js --data-dir=/home/lynox/.lynox --apply
 *
 * No vault key required: subject names are plaintext by design; slice 1 never
 * decrypts memory text. The EngineDb ctor migrates engine.db on open (no-op here).
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { getLynoxDir, setDataDir } from '../core/config.js';
import { EngineDb } from '../core/engine-db.js';
import { SubjectStore, personNameTokens, isPersonSubsetSafe } from '../core/subject-store.js';
import { DataStore } from '../core/data-store.js';
import { ThreadStore } from '../core/thread-store.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../core/sqlite-constants.js';
import { runMerge, rollbackMergeRun } from '../core/subject-merge-runner.js';
import type { MergeLedgerFile, MergeRunResult } from '../core/subject-merge-runner.js';
import { isCleanupTarget, isJunkPersonShape } from '../core/kg-stopwords.js';

// Re-exported so this script's API surface (its tests + callers) keeps one import site.
export type { MergeLedgerFile } from '../core/subject-merge-runner.js';

export interface Args { apply: boolean; json: boolean; dataDir: string | null; rollback: string | null; merge: string | null }

export function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, json: false, dataDir: null, rollback: null, merge: null };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a.startsWith('--data-dir=')) args.dataDir = a.slice('--data-dir='.length);
    else if (a.startsWith('--rollback=')) args.rollback = a.slice('--rollback='.length);
    else if (a.startsWith('--merge=')) args.merge = a.slice('--merge='.length);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { process.stderr.write(`unknown arg: ${a}\n`); printHelp(); process.exit(2); }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    'Subject garbage-sweep — archive junk (slice 1) + dedup person subsets (slice 2).\n' +
    '  (no flag)             dry-run: report junk candidates + person subset-merge pairs\n' +
    '  --apply               archive junk + write a rollback ledger\n' +
    '  --merge=DUP:CANON     merge a confirmed subset pair (dup → canonical) + write a ledger\n' +
    '  --json                machine-readable output\n' +
    '  --rollback=PATH       restore from an archive OR merge ledger (phase-aware)\n' +
    '  --data-dir=PATH       override the .lynox data dir (else LYNOX_DATA_DIR / ~/.lynox)\n',
  );
}

interface SubjectRow { id: string; kind: string; name: string; parent_id: string | null; is_self: number }
export interface ArchiveAction { id: string; kind: string; name: string; parentId: string | null; links: number; primaries: number }
export interface BlockedRow { id: string; name: string; kind: string; reason: string }
export interface SlashRow { id: string; name: string; kind: string }
export interface PrimaryNull { memoryId: string; oldSubjectId: string }
export interface ArchivePlan { archive: ArchiveAction[]; blocked: BlockedRow[]; escapedSlash: SlashRow[] }
export interface Ledger {
  version: 1; phase: 'archive'; createdAt: string;
  archived: Array<{ id: string; archived_at_was: null }>;
  primaryNulled: PrimaryNull[];
}

/** A CONFIRM-class candidate: the subset person (dup) folds into the superset person (canonical). */
export interface SubsetPair { dupId: string; dupName: string; canonicalId: string; canonicalName: string }

type Db = Database.Database;

/**
 * Slice-2 CONFIRM report (NEVER auto-applied): existing person pairs where one is an
 * unambiguous token-subset of exactly one other ("Ada" ⊂ "Dr. Ada Lovelace").
 * The retroactive twin of the write-time resolvePersonSubject. Scoped per owner_user_id
 * (a merge never crosses owners) and only reported when the superset is UNIQUE — the same
 * "never guess" rule as the resolver. The operator confirms each with --merge.
 */
export function planPersonSubsetPairs(engineDb: EngineDb): SubsetPair[] {
  const db = engineDb.getDb();
  const persons = db.prepare(
    "SELECT id, name, owner_user_id FROM subjects WHERE kind = 'person' AND archived_at IS NULL AND merged_into IS NULL AND is_self = 0",
  ).all() as Array<{ id: string; name: string; owner_user_id: string }>;
  const byOwner = new Map<string, Array<{ id: string; name: string; tokens: string[] }>>();
  for (const p of persons) {
    const list = byOwner.get(p.owner_user_id) ?? [];
    list.push({ id: p.id, name: p.name, tokens: personNameTokens(p.name) });
    byOwner.set(p.owner_user_id, list);
  }
  const pairs: SubsetPair[] = [];
  for (const list of byOwner.values()) {
    for (const sub of list) {
      if (sub.tokens.length === 0) continue;
      const supersets = list.filter(other => other.id !== sub.id && isPersonSubsetSafe(sub.tokens, other.tokens));
      if (supersets.length === 1) {
        const canon = supersets[0]!;
        pairs.push({ dupId: sub.id, dupName: sub.name, canonicalId: canon.id, canonicalName: canon.name });
      }
    }
  }
  return pairs;
}

/**
 * Open a WRITABLE history.db ThreadStore for the merge's thread-anchor repoint — the LIVE
 * anchor store (engine.db's `threads` is an empty mirror). Returns nulls when history.db is
 * absent, so the merge simply repoints no anchors. busy_timeout so a repoint waits out a
 * live engine holding the handle rather than throwing SQLITE_BUSY.
 */
function openThreadStore(dataDir: string): { threadStore: ThreadStore | null; historyDb: Database.Database | null } {
  const historyPath = join(dataDir, 'history.db');
  if (!existsSync(historyPath)) return { threadStore: null, historyDb: null };
  const historyDb = new Database(historyPath);
  historyDb.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  historyDb.pragma('journal_mode = WAL'); // parity with the other opens (no-op on an already-WAL file)
  return { threadStore: new ThreadStore(historyDb), historyDb };
}

/**
 * Operator `--merge`: open the stores, delegate to the shared {@link runMerge} (crash-safe
 * ledger-first + three-store repoint), close the handles. The `subjects_merge` chat tool
 * shares the SAME runner, so there is ONE merge-ledger format and ONE `--rollback` path.
 */
export function doMerge(engineDb: EngineDb, dataDir: string, dupId: string, canonicalId: string): MergeRunResult {
  const store = new SubjectStore(engineDb);
  const dsPath = join(dataDir, 'datastore.db');
  // Open every handle INSIDE the try so a throw from the second open can't leak the first,
  // and close each independently so one close() throwing can't skip the other.
  let ds: DataStore | null = null;
  let historyDb: Database.Database | null = null;
  try {
    ds = existsSync(dsPath) ? new DataStore(dsPath) : null;
    const t = openThreadStore(dataDir);
    historyDb = t.historyDb;
    return runMerge(store, ds, t.threadStore, dataDir, dupId, canonicalId);
  } finally {
    try { ds?.close(); } catch { /* best-effort */ }
    try { historyDb?.close(); } catch { /* best-effort */ }
  }
}

/** Reverse a persisted merge across all three stores, the phase-'merge' half of --rollback. */
export function rollbackMergeFile(engineDb: EngineDb, dataDir: string, file: MergeLedgerFile): { ok: boolean; reason?: string } {
  const store = new SubjectStore(engineDb);
  const dsPath = join(dataDir, 'datastore.db');
  let ds: DataStore | null = null;
  let historyDb: Database.Database | null = null;
  try {
    // Only open a store when the merge actually touched it (else a no-op open/close).
    ds = (file.dataStore.length > 0 && existsSync(dsPath)) ? new DataStore(dsPath) : null;
    let threadStore: ThreadStore | null = null;
    if ((file.threadAnchors?.length ?? 0) > 0) {
      const t = openThreadStore(dataDir);
      threadStore = t.threadStore;
      historyDb = t.historyDb;
    }
    return rollbackMergeRun(store, ds, threadStore, file);
  } finally {
    try { ds?.close(); } catch { /* best-effort */ }
    try { historyDb?.close(); } catch { /* best-effort */ }
  }
}

/** Read the set of subject ids that are a thread anchor in history.db (read-only). */
export function readThreadAnchorIds(historyDbPath: string): Set<string> {
  if (!existsSync(historyDbPath)) return new Set();
  const hdb = new Database(historyDbPath, { readonly: true });
  try {
    const rows = hdb.prepare("SELECT DISTINCT primary_subject_id id FROM threads WHERE primary_subject_id IS NOT NULL").all() as Array<{ id: string }>;
    return new Set(rows.map(r => r.id));
  } catch { return new Set(); }   // pre-v46 history.db lacks the column
  finally { hdb.close(); }
}

/** Why (if at all) an isCleanupTarget subject must NOT be archived — human-review signal. */
function blockReason(db: Db, s: SubjectRow, threadAnchors: ReadonlySet<string>): string | null {
  if (s.is_self === 1) return 'is_self';
  if (threadAnchors.has(s.id)) return 'thread-anchor';
  if (db.prepare('SELECT 1 FROM subjects WHERE parent_id = ? AND archived_at IS NULL LIMIT 1').get(s.id)) return 'has-children';
  if (db.prepare('SELECT 1 FROM tasks WHERE subject_id = ? OR assignee_subject_id = ? LIMIT 1').get(s.id, s.id)) return 'referenced-by-task';
  if (db.prepare('SELECT 1 FROM engagements WHERE provider_subject_id = ? OR client_subject_id = ? LIMIT 1').get(s.id, s.id)) return 'referenced-by-engagement';
  if (db.prepare('SELECT 1 FROM triggers WHERE subject_id = ? LIMIT 1').get(s.id)) return 'referenced-by-trigger';
  if (db.prepare('SELECT 1 FROM connections WHERE subject_id = ? LIMIT 1').get(s.id)) return 'referenced-by-connection';
  if (db.prepare('SELECT 1 FROM artifacts WHERE subject_id = ? LIMIT 1').get(s.id)) return 'referenced-by-artifact';
  if (db.prepare('SELECT 1 FROM people WHERE subject_id = ? AND (email IS NOT NULL OR phone IS NOT NULL) LIMIT 1').get(s.id)) return 'has-contact-detail';
  if (db.prepare('SELECT 1 FROM organizations WHERE subject_id = ? AND (domain IS NOT NULL OR vat_id IS NOT NULL) LIMIT 1').get(s.id)) return 'has-org-detail';
  if (db.prepare('SELECT 1 FROM products WHERE subject_id = ? AND (sku IS NOT NULL OR price_cents IS NOT NULL) LIMIT 1').get(s.id)) return 'has-product-detail';
  if (db.prepare('SELECT 1 FROM services WHERE subject_id = ? AND hourly_rate_cents IS NOT NULL LIMIT 1').get(s.id)) return 'has-service-detail';
  return null;
}

/** Build the archive plan (side-effect-free): candidates, blocked rows, escaped slashes. */
export function planArchive(engineDb: EngineDb, threadAnchors: ReadonlySet<string>): ArchivePlan {
  const db = engineDb.getDb();
  const subjects = db.prepare('SELECT id, kind, name, parent_id, is_self FROM subjects WHERE archived_at IS NULL').all() as SubjectRow[];
  const linkCount = db.prepare('SELECT COUNT(*) c FROM memory_subjects WHERE subject_id = ?');
  const primCount = db.prepare('SELECT COUNT(*) c FROM memories WHERE subject_id = ?');
  const plan: ArchivePlan = { archive: [], blocked: [], escapedSlash: [] };
  for (const s of subjects) {
    // Candidate = the name-generic oracle OR a person with a junk shape (acronym /
    // digit / lowercase-initial) — the kind-conditional class the write-path gate
    // now blocks, swept from legacy data under the same single oracle.
    const isJunk = isCleanupTarget(s.name) || (s.kind === 'person' && isJunkPersonShape(s.name));
    if (!isJunk) {
      if (s.name.includes('/')) plan.escapedSlash.push({ id: s.id, name: s.name, kind: s.kind });
      continue;
    }
    const reason = blockReason(db, s, threadAnchors);
    if (reason) { plan.blocked.push({ id: s.id, name: s.name, kind: s.kind, reason }); continue; }
    plan.archive.push({
      id: s.id, kind: s.kind, name: s.name, parentId: s.parent_id,
      links: (linkCount.get(s.id) as { c: number }).c,
      primaries: (primCount.get(s.id) as { c: number }).c,
    });
  }
  return plan;
}

/**
 * Build the rollback ledger READ-ONLY (no mutation), so `main` can persist it to
 * disk BEFORE any write. The primary-NULL destroys `memories.subject_id` (stored
 * nowhere else), so a crash between mutating and writing the ledger would be
 * irreversible — hence the ledger must land first.
 */
export function buildLedger(engineDb: EngineDb, plan: ArchivePlan): Ledger {
  const db = engineDb.getDb();
  const primRows = db.prepare('SELECT id memoryId, subject_id oldSubjectId FROM memories WHERE subject_id = ?');
  const ledger: Ledger = { version: 1, phase: 'archive', createdAt: new Date().toISOString(), archived: [], primaryNulled: [] };
  for (const a of plan.archive) {
    ledger.archived.push({ id: a.id, archived_at_was: null });
    for (const p of primRows.all(a.id) as PrimaryNull[]) ledger.primaryNulled.push(p);
  }
  return ledger;
}

/** Execute the archive in one atomic transaction. The ledger must already be persisted. */
export function executeArchive(engineDb: EngineDb, plan: ArchivePlan): void {
  const db = engineDb.getDb();
  const archiveStmt = db.prepare("UPDATE subjects SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL");
  const nullStmt = db.prepare("UPDATE memories SET subject_id = NULL, updated_at = datetime('now') WHERE subject_id = ?");
  db.transaction(() => {
    for (const a of plan.archive) { archiveStmt.run(a.id); nullStmt.run(a.id); }
  })();
}

/** Convenience for tests: build the ledger then execute (no crash window between). */
export function applyArchive(engineDb: EngineDb, plan: ArchivePlan): Ledger {
  const ledger = buildLedger(engineDb, plan);
  executeArchive(engineDb, plan);
  return ledger;
}

/** Restore a ledger: un-archive subjects + restore nulled primaries. Reports UNIQUE collisions. */
export function rollback(engineDb: EngineDb, ledger: Ledger): { restored: number; collisions: string[] } {
  const db = engineDb.getDb();
  const collidedIds = new Set<string>();
  const collisions: string[] = [];
  const unarchive = db.prepare("UPDATE subjects SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?");
  const restorePrim = db.prepare("UPDATE memories SET subject_id = ?, updated_at = datetime('now') WHERE id = ?");
  db.transaction(() => {
    for (const a of ledger.archived) {
      // Un-archiving a name-deduped kind re-enters the partial UNIQUE index and can
      // collide if a same-name active row was minted meanwhile (near-impossible: the
      // write-time filter blocks new junk). A collision leaves the row archived +
      // flagged; the whole rollback does NOT abort.
      try { unarchive.run(a.id); }
      catch (err) { collidedIds.add(a.id); collisions.push(`${a.id}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    // Restore primaries only for subjects that actually un-archived — else a memory
    // would point back at a still-archived subject.
    for (const p of ledger.primaryNulled) {
      if (!collidedIds.has(p.oldSubjectId)) restorePrim.run(p.oldSubjectId, p.memoryId);
    }
  })();
  return { restored: ledger.archived.length - collidedIds.size, collisions };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.dataDir) setDataDir(args.dataDir);
  const dir = getLynoxDir();
  const engineDb = new EngineDb(join(dir, 'engine.db'));   // ctor migrates on open (no-op)
  try {
    if (args.rollback) {
      // Phase-aware: an archive ledger un-archives; a merge ledger un-merges (both stores).
      const parsed = JSON.parse(readFileSync(args.rollback, 'utf8')) as Ledger | MergeLedgerFile;
      if (parsed.phase === 'merge') {
        const r = rollbackMergeFile(engineDb, dir, parsed);
        process.stdout.write(args.json ? JSON.stringify({ mode: 'rollback-merge', ...r }) + '\n'
          : `[subject-sweep] ROLLBACK-MERGE — ${r.ok ? `un-merged ${parsed.entry.dupId} ← ${parsed.entry.canonicalId}` : `FAILED: ${r.reason}`}.\n`);
        return;
      }
      const r = rollback(engineDb, parsed);
      process.stdout.write(args.json ? JSON.stringify({ mode: 'rollback', ...r }) + '\n'
        : `[subject-sweep] ROLLBACK — restored ${r.restored} subjects, ${parsed.primaryNulled.length} primaries; ${r.collisions.length} collisions.\n`);
      return;
    }
    if (args.merge) {
      // Operator-confirmed CONFIRM-class merge: `--merge=<dupId>:<canonicalId>`.
      const sep = args.merge.indexOf(':');
      if (sep < 0) { process.stderr.write('--merge expects <dupId>:<canonicalId>\n'); process.exitCode = 2; return; }
      const dupId = args.merge.slice(0, sep);
      const canonicalId = args.merge.slice(sep + 1);
      const r = doMerge(engineDb, dir, dupId, canonicalId);
      if (!r.ok) { process.stderr.write(`[subject-sweep] MERGE refused: ${r.reason}\n`); process.exitCode = 1; return; }
      process.stdout.write(args.json ? JSON.stringify({ mode: 'merge', ...r }) + '\n'
        : `[subject-sweep] MERGED ${dupId} → ${canonicalId} (${r.dataStoreRows} datastore cells, ${r.threadRows} thread anchors repointed). Ledger: ${r.ledgerPath}\n`);
      return;
    }
    const threadAnchors = readThreadAnchorIds(join(dir, 'history.db'));
    const plan = planArchive(engineDb, threadAnchors);
    if (!args.apply) {
      // Slice-2 CONFIRM class: report person subset pairs (report-only, never auto-merged).
      const subsetPairs = planPersonSubsetPairs(engineDb);
      const out = { mode: 'dry-run', archiveCount: plan.archive.length, blocked: plan.blocked, escapedSlash: plan.escapedSlash, subsetPairs };
      process.stdout.write(args.json ? JSON.stringify(out) + '\n'
        : `[subject-sweep] DRY-RUN — would archive ${plan.archive.length} junk subjects ` +
          `(${plan.archive.reduce((n, a) => n + a.primaries, 0)} primary links NULLed). ` +
          `${plan.blocked.length} blocked (review), ${plan.escapedSlash.length} escaped-slash (review). Re-run with --apply.\n` +
          (plan.blocked.length ? `  blocked: ${plan.blocked.map(b => `${b.name}[${b.reason}]`).join(', ')}\n` : '') +
          (plan.escapedSlash.length ? `  escaped-slash: ${plan.escapedSlash.map(s => s.name).join(', ')}\n` : '') +
          (subsetPairs.length
            ? `  ${subsetPairs.length} person subset-merge candidate(s) (CONFIRM — apply with --merge=<dupId>:<canonicalId>):\n` +
              subsetPairs.map(p => `    "${p.dupName}" (${p.dupId}) → "${p.canonicalName}" (${p.canonicalId})\n`).join('')
            : ''));
      return;
    }
    // Persist the ledger BEFORE mutating — a crash after the DB write but before the
    // ledger lands would otherwise be irreversible (the old primary subject_id is gone).
    const ledger = buildLedger(engineDb, plan);
    const sweepDir = join(dir, 'sweeps');
    mkdirSync(sweepDir, { recursive: true });
    const ledgerPath = join(sweepDir, `sweep-${ledger.createdAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    executeArchive(engineDb, plan);
    const out = { mode: 'apply', archived: ledger.archived.length, primaryNulled: ledger.primaryNulled.length, ledger: ledgerPath };
    process.stdout.write(args.json ? JSON.stringify(out) + '\n'
      : `[subject-sweep] APPLIED — archived ${ledger.archived.length} junk subjects, NULLed ${ledger.primaryNulled.length} primaries. Ledger: ${ledgerPath}\n`);
  } finally {
    engineDb.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
