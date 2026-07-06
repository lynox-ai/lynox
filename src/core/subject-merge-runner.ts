import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { SubjectStore, MergeLedgerEntry } from './subject-store.js';
import type { DataStore, SubjectRepointRecord } from './data-store.js';

/**
 * Shared runner for a single subject merge — used by BOTH the operator garbage-sweep
 * (`subject-sweep.ts --merge`) and the `subjects_merge` chat tool, so there is exactly
 * ONE reversal path (a merge ledger under `~/.lynox/sweeps/`, undone via the sweep's
 * phase-aware `--rollback`). The caller OWNS the store + dataStore handle lifecycle
 * (this never opens or closes them).
 */

/** A persisted merge — same `~/.lynox/sweeps/` home + `version` shape as the archive ledger. */
export interface MergeLedgerFile {
  version: 1; phase: 'merge'; createdAt: string;
  entry: MergeLedgerEntry;              // engine.db before-image (SubjectStore.planMerge)
  dataStore: SubjectRepointRecord[];    // datastore.db before-image (DataStore.repointSubjectId)
}

export type MergeRunResult =
  | { ok: true; ledgerPath: string; dataStoreRows: number; dupName: string; canonicalName: string }
  | { ok: false; reason: string };

/**
 * Execute ONE merge, crash-safe: plan (read-only) → persist the engine.db before-image
 * ledger BEFORE any mutation → executeMerge (engine.db) → repoint datastore.db cells →
 * rewrite the ledger with the datastore before-image. The two DBs can't share a
 * transaction, so a crash after executeMerge but before the datastore repoint leaves those
 * cells pointing at the (now archived) dup — NOT lost (each store's write is its own atomic
 * txn), but temporarily unattributed under the canonical until recovered by `--rollback`
 * (un-merges engine.db) + a re-run. Reversible via {@link rollbackMergeRun}.
 */
export function runMerge(
  store: SubjectStore, dataStore: DataStore | null, dataDir: string,
  dupId: string, canonicalId: string,
): MergeRunResult {
  const plan = store.planMerge(dupId, canonicalId);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const dupName = store.getSubject(dupId)?.name ?? dupId;
  const canonicalName = store.getSubject(canonicalId)?.name ?? canonicalId;

  const sweepDir = join(dataDir, 'sweeps');
  mkdirSync(sweepDir, { recursive: true });
  const createdAt = new Date().toISOString();
  // A short random suffix so two merges in the same millisecond (now that BOTH the
  // interactive tool and the operator sweep share this runner) can't overwrite each
  // other's ledger — an overwrite would silently lose the first merge's rollback record.
  const suffix = Math.random().toString(36).slice(2, 8);
  const ledgerPath = join(sweepDir, `merge-${createdAt.replace(/[:.]/g, '-')}-${suffix}.json`);
  const file: MergeLedgerFile = { version: 1, phase: 'merge', createdAt, entry: plan.entry, dataStore: [] };
  writeFileSync(ledgerPath, JSON.stringify(file, null, 2));   // persist BEFORE mutating

  store.executeMerge(plan.entry);

  if (dataStore) {
    file.dataStore = dataStore.repointSubjectId(dupId, canonicalId);
    if (file.dataStore.length > 0) writeFileSync(ledgerPath, JSON.stringify(file, null, 2));
  }
  return { ok: true, ledgerPath, dataStoreRows: file.dataStore.reduce((n, r) => n + r.ids.length, 0), dupName, canonicalName };
}

/** Reverse a persisted merge across BOTH stores. Caller owns the store + dataStore handles. */
export function rollbackMergeRun(store: SubjectStore, dataStore: DataStore | null, file: MergeLedgerFile): { ok: boolean; reason?: string } {
  if (dataStore && file.dataStore.length > 0) {
    dataStore.rollbackRepoint(file.entry.dupId, file.entry.canonicalId, file.dataStore);
  }
  return store.rollbackMerge(file.entry);
}
