import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from './atomic-write.js';
import type { SubjectStore, MergeLedgerEntry } from './subject-store.js';
import { FOREIGN_REPOINT_RECORD_REASON, type DataStore, type SubjectRepointRecord } from './data-store.js';
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

/**
 * The one name shape a merge ledger has, as {@link runMerge} writes it below:
 * `merge-<ISO with : and . replaced by ->-<suffix>.json`. Exported here so backup,
 * migration-export and migration-import all decide "is this a merge ledger?" from the
 * writer's own definition instead of three drifting copies — and because it doubles as
 * the importer's path-traversal guard: it admits a BASENAME only, so no separator, no
 * `..`, no absolute path can survive it.
 */
export function isMergeLedgerFileName(name: string): boolean {
  return /^merge-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]{1,16}\.json$/.test(name);
}

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
/**
 * How long a merge stays undoable. Ledgers older than this are removed on the next merge.
 *
 * The directory grew forever before this: nothing in the tree deleted a ledger, and since
 * core#1243 `sweeps` is declared `{ backup: true, migrate: true }`, so every entry also
 * travels into every backup and every tenant migration. Each one embeds the full detail row
 * of both subjects — for `people` that is email and phone, for `organizations` domain and
 * vat_id. Personal data with no deletion path is the Art-17 problem, and an unbounded one is
 * the same problem multiplied by time.
 *
 * 90 days is the trade: long enough that a merge noticed weeks later is still reversible,
 * short enough that the data does not accumulate indefinitely. It is a constant rather than
 * a setting on purpose — a per-instance knob here would be an env-ABI change, and the value
 * only matters as a bound, not as a tuning parameter.
 */
export const LEDGER_RETENTION_DAYS = 90;

/**
 * Delete merge ledgers older than the retention window. Best-effort by design.
 *
 * ⚠ Ages by the ledger's OWN `createdAt`, not by mtime. The first version used mtime with the
 * stated reason that "a rollback rewrites the file" — which is simply false: `rollbackMergeRun`
 * never writes, the `applied` flip happens inside `runMerge` before anyone can roll back. Worse,
 * the premise pointed the wrong way. Copies do NOT preserve mtime, so a backup restore and a
 * migration import both hand every ledger a fresh full window — the one bound that exists for
 * this personal data would have been reset by the very operations that spread it. `pruneBackups`
 * already ages by `manifest.created_at` for the same reason; this follows it.
 *
 * Two safety rails, both from that same neighbour:
 *   · the newest ledger is NEVER deleted, whatever the clock says — one forward clock jump
 *     would otherwise unlink every reversal record in a single pass, irreversibly;
 *   · a ledger whose `createdAt` cannot be read or parsed is KEPT. Unreadable is not expired,
 *     and this function's failure mode must be "kept too long", never "deleted too early".
 *
 * A merge must never fail because a cleanup could not run, so every error is swallowed.
 *
 * The name filter is `isMergeLedgerFileName` — the writer's own definition, shared with
 * migration export and import. The first version rolled its own `startsWith('merge-') &&
 * endsWith('.json')`, a fourth and looser copy, and it would have deleted `merge-plan-notes.json`
 * — a file runMerge never wrote — while its comment claimed it touched nothing it did not write.
 * A delete path does not get its own definition of what it owns.
 */
export function pruneExpiredLedgers(sweepsDir: string, nowIso: string): void {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return;
  const cutoff = now - LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let names: string[];
  try {
    names = readdirSync(sweepsDir);
  } catch {
    return;
  }

  const aged: Array<{ full: string; createdMs: number }> = [];
  for (const name of names) {
    if (!isMergeLedgerFileName(name)) continue;
    const full = join(sweepsDir, name);
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as { createdAt?: unknown };
      const createdMs = typeof parsed.createdAt === 'string' ? Date.parse(parsed.createdAt) : NaN;
      if (!Number.isFinite(createdMs)) continue;   // unreadable age ⇒ keep
      aged.push({ full, createdMs });
    } catch {
      continue;                                     // unreadable file ⇒ keep
    }
  }
  if (aged.length === 0) return;

  // Never the newest, even if the clock claims it is ancient.
  const newest = aged.reduce((a, b) => (b.createdMs > a.createdMs ? b : a));
  for (const { full, createdMs } of aged) {
    if (full === newest.full) continue;
    if (createdMs >= cutoff) continue;
    try {
      unlinkSync(full);
    } catch {
      // Someone else's concurrent delete, or a file we may not remove. Neither is our problem.
    }
  }
}

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

  // Retention runs HERE, coupled to writing, because that is the only thing that makes the
  // directory grow — no scheduler to forget, and an instance that never merges never needs it.
  pruneExpiredLedgers(join(dataDir, 'sweeps'), createdAt);

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
  // The data-store half would refuse a ledger record that names no subject column, but only
  // after the engine side is already reversed. Ask first, so such a ledger changes nothing.
  if (dataStore && file.dataStore.some(rec => dataStore.repointRecordState(rec) === 'foreign')) {
    return { ok: false, reason: FOREIGN_REPOINT_RECORD_REASON };
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

/**
 * A merge as an owner's surface shows it: who was merged into whom, when, what else it
 * repointed, and whether it can still be taken back. **Deliberately not the ledger entry.**
 * The entry carries both subjects' full detail rows (for `people` email and phone, for
 * `organizations` domain and `vat_id`) and the canonical's aliases verbatim, because the
 * rollback needs them. Whether those are ciphertext depends on a vault key being set, and
 * `domain` never is — so nothing here passes them on, whatever the storage looks like.
 * The duplicate's name does come back, although the merge took it out of the contact
 * views: a merge cannot be named for taking back without it.
 */
export interface MergeRunView {
  /** The ledger's file name without `.json`, which is also what a rollback names. */
  id: string;
  createdAt: string;
  kind: string;
  dupName: string;
  canonicalName: string;
  /** False for a merge that crashed half way: it is not reversible. */
  applied: boolean;
  /** The merge holds and this ledger is the one that can take it back: the duplicate still
   *  redirects onto the canonical, both rows exist, and no newer ledger names the same pair. */
  inEffect: boolean;
  /** A newer ledger names the same two entries (merged, taken back, merged again). This one's
   *  before-image is stale, and replaying it would write old values over the newer merge. */
  superseded: boolean;
  dataStoreRows: number;
  threadRows: number;
}

/** Read one ledger by its id, or null — an id that is not a ledger's name reads nothing,
 *  so no path can be built from it. A file whose shape the views and the rollback rely on
 *  is not there reads as null too, rather than throwing later. */
export function readMergeLedger(sweepsDir: string, id: string): MergeLedgerFile | null {
  const name = `${id}.json`;
  if (!isMergeLedgerFileName(name)) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(sweepsDir, name), 'utf8')) as Partial<MergeLedgerFile>;
    const entry = parsed.entry as Partial<MergeLedgerEntry> | undefined;
    if (parsed.phase !== 'merge' || typeof parsed.createdAt !== 'string' || !entry) return null;
    if (typeof entry.dupId !== 'string' || typeof entry.canonicalId !== 'string' || typeof entry.kind !== 'string') return null;
    if (!Array.isArray(parsed.dataStore) || !parsed.dataStore.every((r) => Array.isArray((r as { ids?: unknown }).ids))) return null;
    if (parsed.threadAnchors !== undefined && !Array.isArray(parsed.threadAnchors)) return null;
    return parsed as MergeLedgerFile;
  } catch {
    return null;
  }
}

interface MergeRunRecord { view: MergeRunView; file: MergeLedgerFile }

function readAll(store: SubjectStore, sweepsDir: string): MergeRunRecord[] {
  let names: string[];
  try {
    names = readdirSync(sweepsDir);
  } catch {
    return [];
  }
  const records: MergeRunRecord[] = [];
  for (const name of names) {
    if (!isMergeLedgerFileName(name)) continue;
    const id = name.slice(0, -'.json'.length);
    const file = readMergeLedger(sweepsDir, id);
    if (!file) continue;
    const { dupId, canonicalId, kind } = file.entry;
    const dup = store.getSubject(dupId);
    const canonical = store.getSubject(canonicalId);
    records.push({
      file,
      view: {
        id, createdAt: file.createdAt, kind,
        dupName: dup?.name ?? '', canonicalName: canonical?.name ?? '',
        applied: file.applied !== false,
        // In effect only while the canonical still stands on its own. After a chain A→B, then
        // B→C, the canonical of the older ledger is itself merged away: its aliases and A's rows
        // sit on C now, so reversing A→B from here would un-archive A while C keeps what that
        // merge moved — data split, reported as success. The newer merge is reversed first; the
        // store refuses such a ledger on its own too (`rollbackMerge`).
        inEffect: dup?.merged_into === canonicalId && canonical !== null && canonical.merged_into === null,
        superseded: false,
        dataStoreRows: file.dataStore.reduce((n, r) => n + r.ids.length, 0),
        threadRows: file.threadAnchors?.length ?? 0,
      },
    });
  }
  // Newest first, by the id: the file name, which carries the writer's clock in the fixed
  // format `isMergeLedgerFileName` enforces, so its text order is its time order. "Newest"
  // decides which ledger may take a merge back. A file name can be edited too; this orders by
  // the name the writer chose, nothing more.
  records.sort((a, b) => (a.view.id < b.view.id ? 1 : a.view.id > b.view.id ? -1 : 0));
  // Only the newest ledger of a pair can take the merge back.
  const seen = new Set<string>();
  for (const r of records) {
    const pair = `${r.file.entry.dupId}\u0000${r.file.entry.canonicalId}`;
    if (seen.has(pair)) {
      r.view.superseded = true;
      r.view.inEffect = false;
    }
    seen.add(pair);
  }
  return records;
}

/** The merges an owner can see, newest first. Unreadable ledgers are left out, not shown half. */
export function listMergeRuns(store: SubjectStore, sweepsDir: string): MergeRunView[] {
  return readAll(store, sweepsDir).map((r) => r.view);
}

/** Why a rollback did not happen, in a fixed vocabulary — the store's own reasons name ids. */
export type MergeRollbackRefusal =
  | 'not_found' | 'not_applied' | 'missing' | 'superseded' | 'not_in_effect' | 'chained'
  | 'unavailable' | 'partial' | 'failed';

/**
 * The newer merge that has to be taken back before a `chained` one can be.
 *
 * `not_in_effect` used to carry this case, and the owner-facing sentence for it
 * says the merge «was taken back already, or the entry was merged elsewhere
 * since». In a chain BOTH halves are wrong — nothing was taken back, and the
 * entry was not merged *elsewhere*: the entry this merge LED TO was merged
 * onward. The one thing the owner needs, which merge to take back first, was
 * not in the sentence at all, because the refusal is a category and the store's
 * own message («…has since been merged into C. Reverse that newer merge first»)
 * stops at this boundary by design.
 */
export interface MergeRollbackBlocker {
  /**
   * The newer merge's run id — what the owner can actually act on, and now the
   * ONLY field. It used to carry the blocking merge's canonical name too, for a
   * clause reading «the entry this merge led to has since been merged onward to
   * <name>». That clause was FALSE from three links on: the blocking merge is
   * the chain's LAST link, so its canonical is where the data ended up, not what
   * the entry this merge led to was merged into — the merge that moved that
   * entry is the middle one, which the refusal deliberately does not name.
   * True at length 2, false at every length ≥3, i.e. wrong exactly in the case
   * the walk was built for. The name went rather than the sentence growing a
   * second one: `GET /api/merges` already returns both ends of every merge, so
   * an owner holding the id can read the names from the row it belongs to.
   */
  readonly id: string;
}

/**
 * Take one merge back for its owner. Refuses up front what the store would refuse, or get
 * wrong, so the answer is a category and not the store's wording:
 *   · a merge that never fully applied, or whose entries are no longer in this graph;
 *   · an older ledger of a pair merged again since — the store's own check would let it
 *     through and write a stale before-image over the newer merge;
 *   · a merge no longer in effect;
 *   · a ledger that moved data rows or conversation links while those stores are not
 *     available — reversing only the contact graph would report success with the rows
 *     still pointing at the merged entry.
 * A split result — engine reversed, a satellite store not — is `partial`.
 */
export function rollbackMergeById(
  store: SubjectStore, dataStore: DataStore | null, threadStore: ThreadStore | null, sweepsDir: string, id: string,
):
  | { ok: true; view: MergeRunView }
  | { ok: false; reason: Exclude<MergeRollbackRefusal, 'chained'> }
  // ⚠ `blocking` is NULLABLE on purpose, and the reason first given for it was
  // WRONG: «the 90-day retention removes it». `pruneExpiredLedgers` keeps the
  // newest ledger in the directory and deletes older ones, and in a chain the
  // blocking ledger is normally the newer — so a prune that removed it removed
  // this one first. Retention is an unlikely route, not an impossible one: the
  // prune ages by the ledger's own `createdAt`, written from `new Date()` at
  // merge time, and nothing enforces that those stamps increase. If the clock
  // steps backwards between two merges of a chain, the blocking ledger is the
  // older one by `createdAt` and the «keep the newest» rail protects the wrong
  // file.
  //
  // Plainly reachable: a `createdAt` the prune cannot parse (it keeps what
  // `Date.parse` rejects, while `readMergeLedger` only wants a string), a
  // hand-deleted file, an import whose source had already pruned, and a blocking
  // merge left `applied:false` by the crash window below. The type is right; the
  // story was not. ⚠ What the unnamed states have in common is only that the
  // blocking merge CANNOT BE TAKEN BACK — not that it is absent: the
  // `applied:false` one is on disk and `GET /api/merges` lists it. The wording
  // may therefore say the dead end, and may not say «no longer on record».
  | { ok: false; reason: 'chained'; blocking: MergeRollbackBlocker | null } {
  // ⚠ READ THE DIRECTORY ONCE. `readAll` is `readdirSync` plus a `readFileSync`,
  // a `JSON.parse` and two subject lookups per ledger, and the `chained` branch
  // below needs the same set to find the blocking merge. Calling it twice made
  // one refusal cost 2 × O(ledgers in the sweeps directory) — bounded by the
  // 90-day retention but by nothing else, and a request an owner can repeat.
  // Hoisting is equivalence, not a shortcut: nothing between here and that
  // filter writes to the store or the directory, so a second read would return
  // the same rows.
  const records = readAll(store, sweepsDir);
  const record = records.find((r) => r.view.id === id);
  if (!record) return { ok: false, reason: 'not_found' };
  const { view, file } = record;
  if (!view.applied) return { ok: false, reason: 'not_applied' };
  if (store.getSubject(file.entry.dupId) === null || store.getSubject(file.entry.canonicalId) === null) {
    return { ok: false, reason: 'missing' };
  }
  if (view.superseded) return { ok: false, reason: 'superseded' };
  if (!view.inEffect) {
    // WHY is it not in effect? `inEffect` is a conjunction and collapsing it to
    // one category threw that away. The canonical having been merged onward is
    // the chain case, and it is the only one with a next step the owner can take.
    // ⚠ ONE term decides it, and working out WHICH took two corrections.
    //
    // First I read only «the canonical moved on», which answered `chained` for a
    // merge that was ALREADY taken back and whose canonical merged onward
    // afterwards — «take that newer merge back first» is plainly wrong advice
    // there, since this one is already undone.
    //
    // Then I added the other term as a disjunct and called both load-bearing.
    // They are not: here `dup` and `canonical` are non-null, so `!inEffect` means
    // `dup.merged_into !== canonicalId ∨ canonical.merged_into !== null`. If the
    // merge still stands, the left side is false, so the right side holds — the
    // canonical HAS moved on. `stillStands` alone is exact, and a mutation that
    // dropped the second disjunct survived every test, which is what a condition
    // that cannot change an answer looks like.
    const stillStands = store.getSubject(file.entry.dupId)?.merged_into === file.entry.canonicalId;
    if (!stillStands) return { ok: false, reason: 'not_in_effect' };
    // ⚠ WALK TO THE END OF THE CHAIN — do not look one step ahead. Looking one
    // step ahead is what the first version of this block did, and it is the THIRD
    // time this refusal promised a step the owner cannot take, so the reasoning
    // is written out rather than summarised.
    //
    // With `A→B, B→C` the blocking merge is `B→C` and the owner can take it back.
    // Add `C→D` and `B→C` is not takeable either: its own canonical moved on, so
    // it answers `chained` in turn. The one-step filter asked for `inEffect` of
    // that next link, found none and fell through to the no-id wording — the
    // owner read the dead-end sentence while a perfectly reversible merge (`C→D`)
    // sat on record. Measured on this tree before this walk existed.
    //
    // The LAST link is the one that is always takeable: it is the only merge in
    // the chain whose canonical still stands on its own. Taking it back shortens
    // the chain by one and the next attempt names the new last link, so an owner
    // is walked down a chain of any length by steps that each work.
    //
    // `merged_into` is single-valued, so there is exactly one path to follow.
    //
    // ⚠ The FIRST step cannot be absent, and that is a consequence, not an
    // assumption: control reaches here with `stillStands` true, both rows
    // non-null (the `missing` guard above) and `inEffect` false — and `inEffect`
    // is `dup.merged_into === canonicalId && canonical !== null &&
    // canonical.merged_into === null`, so the third term is the one that failed.
    // The early return is therefore for the TYPE, and that is the point: an
    // earlier version carried a nullable `edge` and a `tip === null ? [] :`
    // guard instead, which no test could defend — a mutation deleting it
    // survived the whole suite. ⚠ The first version of THIS note then misstated
    // what was wrong with the old one: it said the old comment named a cause
    // that cannot produce null. It can — the old loop broke on iteration 1 and
    // left `edge` null. What the old comment got wrong is that the cause it
    // named cannot OCCUR (it said so itself, «which contradicts reaching here»)
    // while the cause that can was missing: a ledger with
    // `canonicalId === dupId` and a `merged_into` self-loop also left `edge`
    // null, so the guard was load-bearing for exactly one corrupt state and
    // undefended there. Measured on the new code: that state answers `chained`
    // with no blocking id and does not crash. A branch the compiler forbids
    // beats a branch nothing exercises.
    const firstOnward = store.getSubject(file.entry.canonicalId)?.merged_into ?? null;
    if (firstOnward === null) return { ok: false, reason: 'not_in_effect' };
    let edge = { dup: file.entry.canonicalId, canonical: firstOnward };
    // `seen` is not decoration: the column is a self-referencing FK with no check
    // against a cycle, and a corrupt one would hang the request, not refuse it.
    // It also makes the walk finite without a hop cap — every iteration either
    // breaks or adds an id to a set drawn from a finite table.
    //
    // ⚠ Seeded with the DUP only. A version seeded `edge.dup` as well, and that
    // term could not change an answer: the loop tests `edge.canonical`, and in
    // any cycle every node has `merged_into !== null`, so no ledger whose dup
    // lies on it can be `inEffect` and the answer is «no blocking id» either
    // way. A mutation removing it survived the suite — which is the same
    // standard this block applies to the canonical match a few lines down, so
    // the term is gone rather than kept for symmetry.
    const seen = new Set<string>([file.entry.dupId]);
    while (!seen.has(edge.canonical)) {
      seen.add(edge.canonical);
      const onward = store.getSubject(edge.canonical)?.merged_into ?? null;
      if (onward === null) break;
      edge = { dup: edge.canonical, canonical: onward };
    }
    const tip = edge;
    // ⚠ Matching the tip's DUP is the whole graph half of the filter; also
    // matching its canonical would be a condition that cannot change an answer,
    // and such a condition is one no test can defend. `merged_into` is
    // single-valued and `tip.dup` points at `tip.canonical` by construction of
    // the walk, so an in-effect ledger with that dup has that canonical.
    //
    // ⚠ EVERY OTHER TERM EXISTS TO MAKE THE NAMED STEP ONE THE OWNER CAN TAKE,
    // because that is the single thing this refusal is for. Each has its own
    // refusal on the other side, and naming a merge that answers one of them
    // would be two API answers pointing at each other with no way out:
    //   · `applied` — `inEffect` is a pure GRAPH predicate and never looks at
    //     whether the ledger finished. `runMerge` has a documented crash window
    //     leaving exactly this state (ledger `applied:false`, graph change
    //     committed, a satellite store throwing before the applied stamp), and
    //     that merge answers `not_applied`.
    //   · the store check — a ledger that moved data rows or thread anchors
    //     answers `unavailable` when the store that holds them is absent, which
    //     is the same precondition this function applies to its own subject a
    //     few lines down. Degraded instances are the reachable case.
    // ⚠ `partial` and `failed` are NOT covered, and the first version of this
    // note gave a false reason — that they are outcomes of attempting rather
    // than preconditions that can be read beforehand. True of `partial`. FALSE
    // of `failed`, which has at least three causes that are pure predicates
    // over the ledger and the store: `entry.repoints` failing `isRepointTarget`
    // (an exported pure function), a `dataStore` record reading `'foreign'` —
    // whose own site a few lines up in this file says «Ask first, so such a
    // ledger changes nothing», i.e. it IS a pre-check — and a dup row whose
    // `kind` no longer matches the ledger's.
    //
    // So a named step can still answer «The merge could not be taken back»:
    // narrow (it needs a ledger from a version whose `REPOINT_TARGETS` has since
    // changed, a dropped-and-retyped collection, or a record the reader admits
    // because it validates only `ids`) but reachable without touching SQLite by
    // hand, and measured on this tree. It is the shape this refusal exists to
    // remove, one step further out.
    //
    // Left out on DUPLICATION RISK, not on impossibility, and that is the honest
    // reason: those three predicates live inside `rollbackMergeRun`'s own
    // prologue, and re-stating them here would make a second copy with nothing
    // keeping the two in step — the next person to add a precondition would have
    // to know this filter exists. Closing it properly means one shared
    // «would this refuse before changing anything?» predicate that both sides
    // call, which is a change to the rollback's own shape and not to this
    // sentence. Registered rather than bolted on here.
    // «Then try this one again» is the clause that carries the rest.
    //
    // ⚠ AND REQUIRE EXACTLY ONE. Its value is second-order and worth stating
    // plainly: the set is provably of size ≤ 1 (the dedupe in `readAll` clears
    // `inEffect` on all but the newest ledger of a pair, and `merged_into` is
    // single-valued, so there is no fork), and a mutation of the count ALONE
    // therefore survives the suite. What it buys is that dropping `inEffect`
    // becomes observable: that mutation admits both ledgers of a
    // pair-merged-twice, the count turns them into «no id», and a test sees it —
    // whereas a plain pick would take the newest match, which happens to be the
    // right one, and pass unnoticed. It is a discriminator for a neighbouring
    // mutation, not a guard against an ambiguous match the schema forbids.
    const candidates = records.filter(
      (r) => r.file.entry.dupId === tip.dup
        && r.view.inEffect && r.view.applied
        && !(r.file.dataStore.length > 0 && !dataStore)
        && !((r.file.threadAnchors?.length ?? 0) > 0 && !threadStore),
    );
    const blocking = candidates.length === 1 ? candidates[0]! : null;
    return { ok: false, reason: 'chained', blocking: blocking ? { id: blocking.view.id } : null };
  }
  if ((file.dataStore.length > 0 && !dataStore) || ((file.threadAnchors?.length ?? 0) > 0 && !threadStore)) {
    return { ok: false, reason: 'unavailable' };
  }
  const out = rollbackMergeRun(store, dataStore, threadStore, file);
  if (!out.ok) return { ok: false, reason: out.reason?.startsWith('engine un-merged') ? 'partial' : 'failed' };
  return { ok: true, view: { ...view, inEffect: false } };
}
