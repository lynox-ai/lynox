/**
 * Erasure by connection, cut 1 (PRD-SOURCE-CONNECTION, revision 8).
 *
 * Cut 1 erases the run-history record of the requests lynox sent through a removed `api`
 * connection: the `run_tool_calls` rows whose grant is in the record's covered set. The requests
 * themselves and the answers stay in the chat they were part of, and everything else is the
 * remainder the customer is told about.
 *
 * Three parts live here:
 *  - {@link coveredGrantSet}: the grants a record covers, fixed at the delete.
 *  - {@link runConnectionErasureSweeps}: erases the records' rows, and says when a store is done.
 *  - {@link blankRunHistoryContent}: the runbook's fallback, which blanks content and keeps rows.
 */
import type Database from 'better-sqlite3';
import { isShopifyAdminHost } from './shopify-host.js';

/** The state of one store of a record. Nothing but `done` is ever shown as erased. */
export type ErasureStoreState = 'done' | 'pending' | 'not reached' | 'failed' | 'late';

/** Which record a removal writes: `erasure` from the `api_setup` delete, `closing` from every other. */
export type ConnectionRecordKind = 'erasure' | 'closing';

/** A record as stored in engine.db. */
export interface StoredConnectionRecord {
  readonly id: number;
  readonly kind: ConnectionRecordKind;
  readonly connectionId: string;
  /** The grant ids it covers, fixed in the delete's transaction; empty when it covers nothing. */
  readonly coveredGrants: readonly string[];
  /** The state of the run-history store. */
  readonly historyState: ErasureStoreState;
  /** ISO time after which a store that is not done is `late`. */
  readonly deadline: string;
}

/** How long a record's store may stay `pending` before it is `late` (premise 6 of revision 8). */
export const ERASURE_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000;

/** The mint reasons that begin a connection: its creation, and the boot finding it without a grant. */
const EPOCH_START: ReadonlySet<string> = new Set(['new', 'backfill']);

/**
 * The grants a record for `connectionId` covers, or `null` when it covers nothing (the store is
 * then `not reached`). Read from engine.db inside the delete's transaction, before the row goes.
 *
 * The set is the connection's epoch: every grant of the id from the one its row was created
 * with (`connections.first_grant_id`) on, ordered by rowid — the ledger is insert-only, and "a
 * clock can step back; the rowid does not". A row without that column set starts at its latest
 * `new` or `backfill` grant, or takes every grant of the id when it has neither. It fails closed:
 * when the row's first grant was not minted as a beginning (an import that carried an earlier
 * connection's later grant), or the profile's current grant is not in the set, it covers nothing.
 * Only grants in scope stay (R8-2): one with a host snapshot, none of which is a Shopify Admin host.
 */
export function coveredGrantSet(engineDb: Database.Database, connectionId: string): readonly string[] | null {
  const row = engineDb.prepare("SELECT config_json, first_grant_id FROM connections WHERE id = ? AND kind = 'api'")
    .get(connectionId) as { config_json: string; first_grant_id: string | null } | undefined;
  if (!row) return null;
  const current = currentGrantOf(row.config_json);
  if (current === null) return null;
  let start: number;
  if (row.first_grant_id !== null) {
    const first = engineDb.prepare("SELECT rowid AS r, reason FROM connection_grants WHERE grant_id = ? AND connection_id = ? AND kind = 'api'")
      .get(row.first_grant_id, connectionId) as { r: number; reason: string } | undefined;
    if (!first || !EPOCH_START.has(first.reason)) return null;
    start = first.r;
  } else {
    const latest = engineDb.prepare("SELECT MAX(rowid) AS r FROM connection_grants WHERE connection_id = ? AND kind = 'api' AND reason IN ('new', 'backfill')")
      .get(connectionId) as { r: number | null };
    start = latest.r ?? 0;
  }
  const epoch = (engineDb.prepare("SELECT grant_id FROM connection_grants WHERE connection_id = ? AND kind = 'api' AND rowid >= ? ORDER BY rowid")
    .all(connectionId, start) as Array<{ grant_id: string }>).map((g) => g.grant_id);
  if (!epoch.includes(current)) return null;
  return epoch.filter((grantId) => grantInScope(engineDb, grantId));
}

function currentGrantOf(configJson: string): string | null {
  try {
    const grantId: unknown = (JSON.parse(configJson) as { oauth_grant?: { grant_id?: unknown } }).oauth_grant?.grant_id;
    return typeof grantId === 'string' && grantId !== '' ? grantId : null;
  } catch {
    return null;
  }
}

/** A grant with at least one host snapshot, none of which names a Shopify Admin host. */
function grantInScope(engineDb: Database.Database, grantId: string): boolean {
  const snapshots = engineDb.prepare('SELECT hosts_json FROM connection_grant_hosts WHERE grant_id = ?').all(grantId) as Array<{ hosts_json: string }>;
  if (snapshots.length === 0) return false;
  for (const { hosts_json } of snapshots) {
    let hosts: unknown;
    try { hosts = JSON.parse(hosts_json); } catch { return false; }
    if (!Array.isArray(hosts)) return false;
    if (hosts.some((h) => typeof h !== 'string' || isShopifyAdminHost(h))) return false;
  }
  return true;
}

/**
 * Writes the record of removing `connectionId`, to be called inside the delete's transaction
 * while the connection row still exists. An erasure record whose set is empty or `null` covers
 * nothing and starts `not reached`; a closing record covers nothing and keeps no label.
 */
export function writeConnectionRecord(engineDb: Database.Database, connectionId: string, kind: ConnectionRecordKind, now: Date): void {
  const label = kind === 'erasure'
    ? (engineDb.prepare('SELECT name FROM connections WHERE id = ?').get(connectionId) as { name: string } | undefined)?.name ?? null
    : null;
  const covered = kind === 'erasure' ? coveredGrantSet(engineDb, connectionId) ?? [] : [];
  engineDb.prepare(`INSERT INTO connection_records (kind, connection_id, label, covered_grants_json, history_state, created_at, deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    kind, connectionId, label, JSON.stringify(covered), covered.length > 0 ? 'pending' : 'not reached',
    now.toISOString(), new Date(now.getTime() + ERASURE_DEADLINE_MS).toISOString(),
  );
}

interface RecordRow {
  id: number;
  kind: ConnectionRecordKind;
  connection_id: string;
  covered_grants_json: string;
  runs_active_json: string | null;
  history_state: ErasureStoreState;
  deadline: string;
}

const toRecord = (r: RecordRow): StoredConnectionRecord => ({
  id: r.id, kind: r.kind, connectionId: r.connection_id, coveredGrants: parseIds(r.covered_grants_json),
  historyState: r.history_state, deadline: r.deadline,
});

function parseIds(json: string | null): string[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The records written for `connectionId`, oldest first. */
export function erasureRecords(engineDb: Database.Database, connectionId: string): readonly StoredConnectionRecord[] {
  return (engineDb.prepare('SELECT * FROM connection_records WHERE connection_id = ? ORDER BY id').all(connectionId) as RecordRow[]).map(toRecord);
}

/**
 * One sweep pass over every erasure record that covers a grant. Each pass erases the record's
 * rows again, a `done` record's too: a call its run abandoned lands on the session's next run
 * (`session.ts`, `call.runId ?? this.currentRunId`), after the runs active at the delete ended.
 * The fixed set keeps that safe: a later connection under the same id has grants no record holds.
 *
 * The store becomes `done` once none of the runs that were active at the record's first sweep
 * still runs, checked before that pass erases, so every row those runs wrote is already in; it
 * becomes `late` when the deadline passes first. A pass that throws marks a pending store
 * `failed` and is retried by the next.
 */
export function runConnectionErasureSweeps(engineDb: Database.Database, historyDb: Database.Database, now: Date): void {
  const records = engineDb.prepare("SELECT * FROM connection_records WHERE kind = 'erasure' AND covered_grants_json <> '[]' ORDER BY id").all() as RecordRow[];
  for (const record of records) {
    const grants = parseIds(record.covered_grants_json);
    if (grants.length === 0) continue;
    let active: string[];
    let stillRunning: number;
    try {
      ({ active, stillRunning } = historyDb.transaction(() => {
        const runs = record.runs_active_json !== null
          ? parseIds(record.runs_active_json)
          : (historyDb.prepare("SELECT id FROM runs WHERE status = 'running'").all() as Array<{ id: string }>).map((r) => r.id);
        const running = runs.length === 0 ? 0 : (historyDb.prepare(
          `SELECT COUNT(*) AS n FROM runs WHERE status = 'running' AND id IN (${runs.map(() => '?').join(',')})`,
        ).get(...runs) as { n: number }).n;
        historyDb.prepare(`DELETE FROM run_tool_calls WHERE connection_id = ? AND grant_id IN (${grants.map(() => '?').join(',')})`)
          .run(record.connection_id, ...grants);
        return { active: runs, stillRunning: running };
      }).immediate());
    } catch {
      if (record.history_state === 'pending') engineDb.prepare("UPDATE connection_records SET history_state = 'failed' WHERE id = ?").run(record.id);
      continue;
    }
    const next: ErasureStoreState = record.history_state === 'done' || record.history_state === 'late' ? record.history_state
      : stillRunning === 0 ? 'done'
      : now.getTime() > Date.parse(record.deadline) ? 'late'
      : 'pending';
    engineDb.prepare(`UPDATE connection_records SET runs_active_json = COALESCE(runs_active_json, ?), history_state = ?,
        done_at = CASE WHEN ? = 'done' THEN COALESCE(done_at, ?) ELSE done_at END,
        label = CASE WHEN ? = 'done' THEN NULL ELSE label END
      WHERE id = ?`).run(JSON.stringify(active), next, next, now.toISOString(), next, record.id);
  }
}

/**
 * The content columns the runbook's fallback blanks, per history.db table. Every other column
 * holds ids, counts, costs, status or names the customer chose (revision 8, R8-7).
 */
export const FALLBACK_CONTENT_COLUMNS: Readonly<Record<string, readonly string[]>> = {};

/** The text columns of the same tables the fallback keeps: ids, names, status and type fields. */
export const FALLBACK_KEPT_COLUMNS: Readonly<Record<string, readonly string[]>> = {};

/** Which runs the fallback reaches: the runs of these threads, or of this period. */
export type FallbackScope =
  | { readonly threadIds: readonly string[] }
  | { readonly from: string; readonly to: string };

/** Blanks the content of the runs in `scope`, keeping every row with its costs and counts. */
export function blankRunHistoryContent(_historyDb: Database.Database, _scope: FallbackScope): { readonly rows: number } {
  throw new Error('blankRunHistoryContent: not built yet');
}
