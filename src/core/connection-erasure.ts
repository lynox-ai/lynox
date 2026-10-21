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

/**
 * The grants a record for `connectionId` covers, or `null` when it covers nothing (the store is
 * then `not reached`). Read from engine.db inside the delete's transaction.
 */
export function coveredGrantSet(_engineDb: Database.Database, _connectionId: string): readonly string[] | null {
  throw new Error('coveredGrantSet: not built yet');
}

/** The records written for `connectionId`, oldest first. */
export function erasureRecords(_engineDb: Database.Database, _connectionId: string): readonly StoredConnectionRecord[] {
  throw new Error('erasureRecords: not built yet');
}

/** One sweep pass over every erasure record. */
export function runConnectionErasureSweeps(_engineDb: Database.Database, _historyDb: Database.Database, _now: Date): void {
  throw new Error('runConnectionErasureSweeps: not built yet');
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
