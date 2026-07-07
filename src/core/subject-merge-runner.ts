import { join } from 'node:path';
import { writeFileAtomicSync } from './atomic-write.js';
import type { SubjectStore, MergeLedgerEntry } from './subject-store.js';
import type { DataStore, SubjectRepointRecord } from './data-store.js';
import type { ThreadStore } from './thread-store.js';

/**
 * Shared runner for a single subject merge — used by BOTH the operator garbage-sweep
 * (`subject-sweep.ts --merge`) and the `subjects_merge` chat tool, so there is exactly
 * ONE reversal path (a merge ledger under `~/.lynox/sweeps/`, undone via the sweep's
 * phase-aware `--rollback`). The subject spine spans THREE SQLite files — engine.db
 * (SubjectStore), datastore.db (DataStore cells) and history.db (ThreadStore anchors) —
 * and a merge must repoint all three or a thread stays anchored to the archived dup. The
 * caller OWNS every store handle's lifecycle (this never opens or closes them).
 */

/** A persisted merge — same `~/.lynox/sweeps/` home + `version` shape as the archive ledger. */
export interface MergeLedgerFile {
  version: 1; phase: 'merge'; createdAt: string;
  entry: MergeLedgerEntry;              // engine.db before-image (SubjectStore.planMerge)
  dataStore: SubjectRepointRecord[];    // datastore.db before-image (DataStore.repointSubjectId)
  // history.db thread ids repointed from the dup onto the canonical (reversed by
  // ThreadStore.restorePrimarySubject(threadAnchors, dupId)). Optional for backward
  // compatibility: a pre-fix ledger has none, so its rollback repoints no anchors.
  threadAnchors?: string[];
  // True once ALL stores have been mutated. A crash mid-run leaves it false so rollback
  // refuses the ledger rather than half-reversing a partially-applied merge (which would
  // mis-attribute the stores it did reach). Optional: a pre-fix ledger — always fully
  // applied by construction — is absent here and treated as applied.
  applied?: boolean;
}

export type MergeRunResult =
  | { ok: true; ledgerPath: string; dataStoreRows: number; threadRows: number; dupName: string; canonicalName: string }
  | { ok: false; reason: string };

/**
 * Execute ONE merge, crash-safe across the three-store spine: plan (read-only) → persist
 * the before-image ledger (applied:false) BEFORE any mutation → executeMerge (engine.db)
 * → repoint datastore.db cells → repoint history.db thread anchors → rewrite the ledger
 * with every before-image + applied:true. The stores can't share a transaction; a crash
 * between mutations leaves the ledger applied:false, so a later `--rollback` REFUSES it
 * (never half-reverses) — the state is fully-forward (the merge applied as far as it got)
 * and `resolveActiveSubject` forwards any dangling id. Reversible via {@link rollbackMergeRun}.
 */
export function runMerge(
  store: SubjectStore, dataStore: DataStore | null, threadStore: ThreadStore | null, dataDir: string,
  dupId: string, canonicalId: string,
): MergeRunResult {
  const plan = store.planMerge(dupId, canonicalId);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const dupName = store.getSubject(dupId)?.name ?? dupId;
  const canonicalName = store.getSubject(canonicalId)?.name ?? canonicalId;

  const createdAt = new Date().toISOString();
  // A short random suffix so two merges in the same millisecond (both the interactive
  // tool and the operator sweep share this runner) can't overwrite each other's ledger —
  // an overwrite would silently lose the first merge's rollback record.
  const suffix = Math.random().toString(36).slice(2, 8);
  const ledgerPath = join(dataDir, 'sweeps', `merge-${createdAt.replace(/[:.]/g, '-')}-${suffix}.json`);
  const file: MergeLedgerFile = {
    version: 1, phase: 'merge', createdAt, entry: plan.entry,
    dataStore: [], threadAnchors: [], applied: false,
  };
  // Persist the reversal record BEFORE mutating, atomically (temp+fsync+rename) so a torn
  // write can't corrupt the sole record that makes the merge reversible.
  writeFileAtomicSync(ledgerPath, JSON.stringify(file, null, 2));

  // Mutate all three stores + stamp applied inside ONE guard so any store throw folds into
  // the Result contract instead of escaping runMerge and crashing the operator CLI: an
  // executeMerge re-assertion throws BEFORE its txn (engine untouched); a satellite throw
  // (e.g. a post-commit SQLITE_BUSY) after executeMerge committed leaves the ledger
  // applied:false — rollback then REFUSES it and the state stays forward-consistent
  // (resolveActiveSubject forwards any not-yet-repointed id).
  try {
    store.executeMerge(plan.entry);
    if (dataStore) file.dataStore = dataStore.repointSubjectId(dupId, canonicalId);
    if (threadStore) file.threadAnchors = threadStore.repointPrimarySubject(dupId, canonicalId);
    // Every store mutated → stamp applied + rewrite atomically. Only now is it reversible.
    file.applied = true;
    writeFileAtomicSync(ledgerPath, JSON.stringify(file, null, 2));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  return {
    ok: true, ledgerPath,
    dataStoreRows: file.dataStore.reduce((n, r) => n + r.ids.length, 0),
    threadRows: file.threadAnchors?.length ?? 0,
    dupName, canonicalName,
  };
}

/** Reverse a persisted merge across ALL three stores. Caller owns every store handle. */
export function rollbackMergeRun(
  store: SubjectStore, dataStore: DataStore | null, threadStore: ThreadStore | null, file: MergeLedgerFile,
): { ok: boolean; reason?: string } {
  // Refuse a ledger whose merge never fully applied (a crash mid-run): reversing a
  // partial merge would mis-attribute the stores it did reach. Absent on a pre-fix
  // ledger — always fully applied by construction — so only an explicit false blocks.
  if (file.applied === false) {
    return { ok: false, reason: 'merge ledger is not marked applied (incomplete/crashed merge) — nothing to reverse' };
  }
  // Reverse the ENGINE side FIRST — it is the one that can legitimately fail (a
  // memory_subjects UNIQUE collision → {ok:false}). On failure, leave the other stores
  // untouched rather than un-repointing them under a still-merged engine.
  const engine = store.rollbackMerge(file.entry);
  if (!engine.ok) return engine;
  // Engine reversed; reverse the satellites. A throw here (e.g. transient BUSY) leaves a
  // split state (engine un-merged, cells/anchors still on canonical) that is non-destructive
  // — report it rather than crash the caller uncaught.
  try {
    if (dataStore && file.dataStore.length > 0) {
      dataStore.rollbackRepoint(file.entry.dupId, file.entry.canonicalId, file.dataStore);
    }
    if (threadStore && file.threadAnchors && file.threadAnchors.length > 0) {
      threadStore.restorePrimarySubject(file.threadAnchors, file.entry.dupId);
    }
  } catch (err) {
    return { ok: false, reason: `engine un-merged but a datastore/thread reversal failed (partial rollback): ${err instanceof Error ? err.message : String(err)}` };
  }
  return engine;
}
