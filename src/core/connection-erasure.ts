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
import { scrubFreedPages } from './sqlite-constants.js';
import { EPOCH_START_REASONS } from './grant-ledger.js';
import type { AuditLog } from './audit-log.js';
import { MANDATE_TAG_PREFIX, type RequestPrincipal } from './request-principal.js';

/** The state of one store of a record. Nothing but `done` is ever shown as erased. */
export type ErasureStoreState = 'done' | 'pending' | 'not reached' | 'failed' | 'late' | 'cancelled';

/** Which record a removal writes: `erasure` from the `api_setup` delete, `closing` from every other. */
export type ConnectionRecordKind = 'erasure' | 'closing';

/**
 * What started a record: the owner's removal of the connection, or the provider's refusal of the
 * stored grant as revoked (a token exchange answered `grant-revoked`).
 */
export type ConnectionRecordCause = 'owner_delete' | 'provider_revoked';

/** A record as stored in engine.db. */
export interface StoredConnectionRecord {
  readonly id: number;
  readonly kind: ConnectionRecordKind;
  readonly connectionId: string;
  readonly cause: ConnectionRecordCause;
  /** A provider's erasure is not swept before this ISO time; `null` for every other record. */
  readonly holdUntil: string | null;
  /** The grant whose refusal started a provider's record; `null` for an owner's. */
  readonly revokedGrant: string | null;
  /** The grant ids it covers, fixed in the delete's transaction; empty when it covers nothing. */
  readonly coveredGrants: readonly string[];
  /** The state of the run-history store. */
  readonly historyState: ErasureStoreState;
  /** ISO time after which a store that is not done is `late`. */
  readonly deadline: string;
}

/** How long a record's store may stay `pending` before it is `late` (premise 6 of revision 8). */
export const ERASURE_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a provider's erasure waits before its first pass: the owner is told on its start and
 * can say the connection did not end. Chosen, not measured; it must leave the sweep time inside
 * the deadline.
 */
export const PROVIDER_HOLD_MS = 14 * 24 * 60 * 60 * 1000;
if (PROVIDER_HOLD_MS >= ERASURE_DEADLINE_MS) throw new Error('PROVIDER_HOLD_MS must be shorter than ERASURE_DEADLINE_MS');

/**
 * Whether a provider's refusal of a grant writes an erasure. Off until the owner is told on the
 * record's start, with the text the owner reads: until then the refusal is no
 * instruction to erase, so it writes a closing record. A switch of its own, not the delete's: the
 * delete asks the person, this one does not.
 */
let providerErasure = false;

export function providerErasureEnabled(): boolean {
  return providerErasure;
}

/** Test seam: sets the switch and returns the restore. */
export function setProviderErasureForTests(on: boolean): () => void {
  const before = providerErasure;
  providerErasure = on;
  return () => { providerErasure = before; };
}

/**
 * How often the engine sweeps the records (`Engine.init`). The owner's notice of a provider's
 * erasure promises that a run still active at its pass is erased once it ends: a longer interval
 * makes that promise late, so a change here means reviewing that notice's text.
 */
export const ERASURE_SWEEP_INTERVAL_MS = 5 * 60_000;

/** The mint reasons that begin a connection (`EPOCH_START_REASONS`). */
const EPOCH_START: ReadonlySet<string> = new Set(EPOCH_START_REASONS);

/**
 * The grants of the connection now stored under `connectionId`, from the one its row was created
 * with (`connections.first_grant_id`) on, ordered by rowid — the ledger is insert-only, and "a
 * clock can step back; the rowid does not". `null` when the row is missing, does not say where
 * its epoch starts, or starts at a grant this ledger did not mint as a beginning.
 */
function connectionEpoch(engineDb: Database.Database, connectionId: string): { readonly epoch: readonly string[]; readonly current: string | null } | null {
  const row = engineDb.prepare("SELECT config_json, first_grant_id FROM connections WHERE id = ? AND kind = 'api'")
    .get(connectionId) as { config_json: string; first_grant_id: string | null } | undefined;
  if (!row || row.first_grant_id === null) return null;
  const first = engineDb.prepare("SELECT rowid AS r, reason FROM connection_grants WHERE grant_id IN (?) AND connection_id = ? AND kind = 'api'")
    .get(row.first_grant_id, connectionId) as { r: number; reason: string } | undefined;
  if (!first || !EPOCH_START.has(first.reason)) return null;
  const epoch = (engineDb.prepare("SELECT grant_id AS g FROM connection_grants WHERE connection_id = ? AND kind = 'api' AND rowid >= ? ORDER BY rowid")
    .all(connectionId, first.r) as Array<{ g: string }>).map((r) => r.g);
  return { epoch, current: currentGrantOf(row.config_json) };
}

/**
 * Every grant an earlier removal of `connectionId` ended, closing or erasure alike. A provider's
 * record stores none (`writeProviderRecord`): the profile stays after a refusal, so a later
 * removal by the owner covers its grants again.
 */
function endedGrants(engineDb: Database.Database, connectionId: string): ReadonlySet<string> {
  const rows = engineDb.prepare('SELECT ended_grants_json FROM connection_records WHERE connection_id = ?').all(connectionId) as Array<{ ended_grants_json: string }>;
  return new Set(rows.flatMap((r) => parseIds(r.ended_grants_json)));
}

/**
 * The grants a record for `connectionId` covers, or `null` when it covers nothing (the store is
 * then `not reached`). Read from engine.db inside the delete's transaction, before the row goes.
 *
 * The set is the connection's epoch ({@link connectionEpoch}). It fails closed: when the row does
 * not say where its epoch starts, when that start was not minted as a beginning (an import that
 * carried an earlier connection's later grant), when the profile's current grant is outside the
 * epoch, or when the epoch holds a grant an earlier removal of the same id ended (an import that
 * carried that connection's grant back), it covers nothing. Only grants in scope stay (R8-2): one
 * with a host snapshot, none of which is a Shopify Admin host.
 */
export function coveredGrantSet(engineDb: Database.Database, connectionId: string): readonly string[] | null {
  const found = connectionEpoch(engineDb, connectionId);
  if (found === null || found.current === null || !found.epoch.includes(found.current)) return null;
  const ended = endedGrants(engineDb, connectionId);
  if (found.epoch.some((g) => ended.has(g))) return null;
  return found.epoch.filter((grantId) => grantInScope(engineDb, grantId));
}

function currentGrantOf(configJson: string): string | null {
  try {
    // Read, never assigned: the store is the grant's one writer (grant-funnel-source.test.ts).
    const grantId: unknown = (JSON.parse(configJson) as { oauth_grant?: Readonly<Record<string, unknown>> }).oauth_grant?.['grant_id'];
    return typeof grantId === 'string' && grantId !== '' ? grantId : null;
  } catch {
    return null;
  }
}

/** A grant with at least one host snapshot, none of which names a Shopify Admin host. */
function grantInScope(engineDb: Database.Database, grantId: string): boolean {
  const snapshots = engineDb.prepare('SELECT hosts_json FROM connection_grant_hosts WHERE grant_id IN (?)').all(grantId) as Array<{ hosts_json: string }>;
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
 * while the connection row still exists. Every record keeps the grants the removal ended, so a
 * connection brought back with one of them covers nothing. An erasure record whose set is empty
 * or `null` covers nothing and starts `not reached`; a closing record covers nothing and keeps no
 * label.
 */
export function writeConnectionRecord(engineDb: Database.Database, connectionId: string, kind: ConnectionRecordKind, now: Date): void;
export function writeConnectionRecord(engineDb: Database.Database, connectionId: string, kind: ConnectionRecordKind, now: Date, provider: ProviderRefusal): ConnectionRecordKind | 'none';
export function writeConnectionRecord(engineDb: Database.Database, connectionId: string, kind: ConnectionRecordKind, now: Date, provider?: ProviderRefusal): ConnectionRecordKind | 'none' | void {
  if (provider !== undefined) return writeProviderRecord(engineDb, connectionId, provider, now);
  const label = kind === 'erasure'
    ? (engineDb.prepare('SELECT name FROM connections WHERE id = ?').get(connectionId) as { name: string } | undefined)?.name ?? null
    : null;
  const covered = kind === 'erasure' ? coveredGrantSet(engineDb, connectionId) ?? [] : [];
  // The current grant and the one the row was created with count as ended even when the epoch
  // cannot be told: a connection brought back with either must not be covered.
  const row = engineDb.prepare("SELECT config_json, first_grant_id FROM connections WHERE id = ? AND kind = 'api'")
    .get(connectionId) as { config_json: string; first_grant_id: string | null } | undefined;
  const ended = [...new Set([
    ...(connectionEpoch(engineDb, connectionId)?.epoch ?? []),
    ...(row ? [currentGrantOf(row.config_json), row.first_grant_id] : []),
  ].filter((g): g is string => g !== null))];
  engineDb.prepare(`INSERT INTO connection_records (kind, connection_id, label, covered_grants_json, ended_grants_json, history_state, created_at, deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    kind, connectionId, label, JSON.stringify(covered), JSON.stringify(ended), covered.length > 0 ? 'pending' : 'not reached',
    now.toISOString(), new Date(now.getTime() + ERASURE_DEADLINE_MS).toISOString(),
  );
}

/**
 * The grants a provider's record covers: the connection's epoch from its newest `credentials` mint
 * on (every such mint cuts, also one that only renames a slot, so the set errs toward less), only
 * when the refused grant is the current one, never one an earlier removal ended, and only grants
 * in scope. The cut keeps a profile whose token endpoint was changed to one that refuses from
 * reaching the grants minted under the endpoint before.
 */
function providerCoveredSet(engineDb: Database.Database, connectionId: string, revokedGrant: string): readonly string[] {
  const found = connectionEpoch(engineDb, connectionId);
  if (found === null || found.current !== revokedGrant || !found.epoch.includes(revokedGrant)) return [];
  const reasons = new Map((engineDb.prepare("SELECT grant_id AS g, reason FROM connection_grants WHERE connection_id = ? AND kind = 'api'")
    .all(connectionId) as Array<{ g: string; reason: string }>).map((r) => [r.g, r.reason]));
  let from = 0;
  found.epoch.forEach((g, i) => { if (reasons.get(g) === 'credentials') from = i; });
  const since = found.epoch.slice(from);
  const ended = endedGrants(engineDb, connectionId);
  if (since.some((g) => ended.has(g))) return [];
  return since.filter((grantId) => grantInScope(engineDb, grantId));
}

/** Whether a snapshot of `grantId` names a Shopify Admin host: a Shopify grant's erasure is not this record's. */
function shopifyGrant(engineDb: Database.Database, grantId: string): boolean {
  const snapshots = engineDb.prepare('SELECT hosts_json FROM connection_grant_hosts WHERE grant_id IN (?)').all(grantId) as Array<{ hosts_json: string }>;
  return snapshots.some(({ hosts_json }) => {
    try {
      const hosts: unknown = JSON.parse(hosts_json);
      return Array.isArray(hosts) && hosts.some((h) => typeof h === 'string' && isShopifyAdminHost(h));
    } catch {
      return false;
    }
  });
}

/**
 * A provider's refusal as the exchange saw it: the grant it refused, and whether the refused
 * refresh token is the one the grant's stamp names (`minted_for`). A token stored since the stamp
 * (by hand, or found changed at boot) says nothing about the grant's earlier tokens.
 */
export interface ProviderRefusal {
  readonly revokedGrant: string;
  readonly stamped: boolean;
}

/**
 * The one place a provider's record becomes an erasure: the switch on, the refused token the
 * stamped one, something covered, not Shopify.
 */
function providerRecordKind(covered: readonly string[], shopify: boolean, stamped: boolean): ConnectionRecordKind {
  return providerErasureEnabled() && stamped && covered.length > 0 && !shopify ? 'erasure' : 'closing';
}

/**
 * Writes the record of a provider's refusal of `revokedGrant`, inside the transaction that stores
 * the refusal. An erasure is held for {@link PROVIDER_HOLD_MS} and counts its deadline from the
 * refusal; a closing record covers nothing. A second refusal of the same grant writes nothing while
 * a record for it stands that is not cancelled; a closing one does not stop a later erasure.
 */
function writeProviderRecord(engineDb: Database.Database, connectionId: string, { revokedGrant, stamped }: ProviderRefusal, now: Date): ConnectionRecordKind | 'none' {
  const covered = providerCoveredSet(engineDb, connectionId, revokedGrant);
  const kind = providerRecordKind(covered, shopifyGrant(engineDb, revokedGrant), stamped);
  const open = (engineDb.prepare(`SELECT kind FROM connection_records WHERE connection_id = ? AND revoked_grant IN (?)
    AND cause = 'provider_revoked' AND history_state <> 'cancelled'`).all(connectionId, revokedGrant) as Array<{ kind: ConnectionRecordKind }>).map((r) => r.kind);
  if (open.includes('erasure') || (kind === 'closing' && open.length > 0)) return 'none';
  const label = kind === 'erasure'
    ? (engineDb.prepare('SELECT name FROM connections WHERE id = ?').get(connectionId) as { name: string } | undefined)?.name ?? null
    : null;
  const result = engineDb.prepare(`INSERT INTO connection_records (kind, connection_id, label, covered_grants_json, ended_grants_json, history_state, created_at, deadline, cause, hold_until, revoked_grant)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provider_revoked', ?, ?)
    ON CONFLICT (connection_id, revoked_grant) WHERE kind = 'erasure' AND cause = 'provider_revoked' AND history_state <> 'cancelled' DO NOTHING`).run(
    kind, connectionId, label, JSON.stringify(kind === 'erasure' ? covered : []), '[]',
    kind === 'erasure' ? 'pending' : 'not reached', now.toISOString(), new Date(now.getTime() + ERASURE_DEADLINE_MS).toISOString(),
    kind === 'erasure' ? new Date(now.getTime() + PROVIDER_HOLD_MS).toISOString() : null, revokedGrant,
  );
  return result.changes > 0 ? kind : 'none';
}

/**
 * Cancels the provider's erasures of `connectionId` that are still held at `now`: the owner
 * reconnected, the revocation was lifted on the same grant (`onlyGrant`), or the owner removed the
 * connection, whose own record then covers the epoch. It writes no record; it only ends a held one.
 */
export function cancelHeldProviderRecords(engineDb: Database.Database, connectionId: string, now: Date, onlyGrant?: string): number[] {
  return (engineDb.prepare(`UPDATE connection_records SET history_state = 'cancelled', cancelled_at = ?
    WHERE connection_id = ? AND cause = 'provider_revoked' AND kind = 'erasure' AND history_state = 'pending' AND hold_until > ?
    ${onlyGrant === undefined ? '' : 'AND revoked_grant IN (?)'} RETURNING id`)
    .all(now.toISOString(), connectionId, now.toISOString(), ...(onlyGrant === undefined ? [] : [onlyGrant])) as Array<{ id: number }>).map((r) => r.id);
}

/** The owner's "the connection did not end" on one held provider erasure. */
export function cancelProviderRecord(engineDb: Database.Database, recordId: number, now: Date): 'cancelled' | 'not_held' | 'not_found' {
  const row = engineDb.prepare('SELECT connection_id, revoked_grant FROM connection_records WHERE id = ?').get(recordId) as { connection_id: string; revoked_grant: string | null } | undefined;
  if (!row) return 'not_found';
  const changed = engineDb.prepare(`UPDATE connection_records SET history_state = 'cancelled', cancelled_at = ?
    WHERE id = ? AND cause = 'provider_revoked' AND kind = 'erasure' AND history_state = 'pending' AND hold_until > ?`)
    .run(now.toISOString(), recordId, now.toISOString()).changes;
  return changed > 0 ? 'cancelled' : 'not_held';
}

/** Why a held provider erasure was cancelled, as its audit row says. */
export type ProviderCancelReason = 'consent' | 'exchange' | 'lift' | 'owner_delete' | 'owner';

/**
 * Whether `actor` may cancel the held provider erasure of the refused grant `refused` by a new
 * consent or a working exchange: the owner always; a mandate only on a grant it connected itself,
 * the same address and the same mandate (a later mandate for the same address is another one).
 * A grant that names no connecter is the owner's. Anyone else, or no actor: no.
 */
export function mayCancelProviderErasure(
  actor: RequestPrincipal | undefined,
  refused: { readonly connected_by?: string | undefined; readonly connected_mandate_id?: string | undefined } | undefined,
): actor is RequestPrincipal {
  if (actor === undefined) return false;
  if (actor.kind === 'owner') return true;
  if (actor.kind !== 'mandate' || actor.mandateId === undefined) return false;
  return refused?.connected_by === `${MANDATE_TAG_PREFIX}${actor.email}` && refused.connected_mandate_id === actor.mandateId;
}

/**
 * The audit row of each cancelled provider erasure: who cancelled it and why. Written in the
 * cancel's transaction by its caller, so a cancel whose row cannot be written does not happen,
 * and neither does one without an audit log to write it to: that throws too. Ids and the reason
 * only.
 */
export function auditProviderCancels(audit: AuditLog | null, actor: RequestPrincipal, connectionId: string, recordIds: readonly number[], reason: ProviderCancelReason): void {
  if (recordIds.length === 0) return;
  if (audit === null) throw new Error('A provider erasure is not cancelled without an audit log to record it.');
  for (const id of recordIds) {
    audit.record({
      principal: actor, action: 'connection.erasure.cancel', target: `${connectionId} ${id} ${reason}`,
      phase: 'done', correlationId: `connection-erasure-${id}`,
    });
  }
}

/** A provider's erasure the owner is told about on the profile it concerns. */
export interface ProviderNotice {
  readonly recordId: number;
  readonly connectionId: string;
  /** When the provider refused the grant: the record is written in the refusal's transaction. */
  readonly revokedAt: string;
  /**
   * Whether the connection was connected again by a new consent since the refusal: the ledger
   * holds a `consent` grant after the refused one. A profile that works again without one (a
   * later grant's refusal lifted, an exchange on a new credential) is not; the other fields of its
   * grant, `connected_by` among them, are carried over from the grant that was refused.
   */
  readonly reconnected: boolean;
  readonly holdUntil: string;
  readonly deadline: string;
}

/**
 * The provider erasures to tell the owner about, at `now`: every erasure that is still to run (not
 * cancelled, not done) and whose deadline has not passed, of a grant of the connection stored now
 * under its id. Every such record, whether the profile is revoked or connected again: a mandate's
 * consent cancels only the erasure of the grant it replaced, a credentials change mints a grant
 * that stays revoked, and a reconnect past the hold cancels nothing, so in each case an erasure can
 * still be to run. A record of a grant outside the stored connection's epoch (a profile deleted and
 * stored again under the same id) is not that profile's, and is not told on it. An import that
 * brings back the grant an earlier connection's epoch started with brings that epoch back, and its
 * records still to run are told: they run either way.
 */
export function providerNotices(engineDb: Database.Database, now: Date): readonly ProviderNotice[] {
  const rows = engineDb.prepare(`SELECT id, connection_id, revoked_grant, created_at, hold_until, deadline FROM connection_records
    WHERE cause = 'provider_revoked' AND kind = 'erasure' AND history_state NOT IN ('cancelled', 'done') AND deadline > ?
    ORDER BY id`).all(now.toISOString()) as Array<{ id: number; connection_id: string; revoked_grant: string; created_at: string; hold_until: string; deadline: string }>;
  const epochs = new Map<string, readonly string[]>();
  const epochOf = (id: string): readonly string[] => {
    let epoch = epochs.get(id);
    if (epoch === undefined) { epoch = connectionEpoch(engineDb, id)?.epoch ?? []; epochs.set(id, epoch); }
    return epoch;
  };
  const consentAfter = engineDb.prepare(`SELECT 1 FROM connection_grants c, connection_grants r
    WHERE r.grant_id IN (?) AND r.connection_id = ? AND c.connection_id = r.connection_id AND c.kind = 'api' AND c.reason = 'consent' AND c.rowid > r.rowid LIMIT 1`);
  return rows.filter((r) => epochOf(r.connection_id).includes(r.revoked_grant))
    .map((r) => ({
      recordId: r.id, connectionId: r.connection_id, revokedAt: r.created_at, holdUntil: r.hold_until, deadline: r.deadline,
      reconnected: consentAfter.get(r.revoked_grant, r.connection_id) !== undefined,
    }));
}

interface RecordRow {
  id: number;
  kind: ConnectionRecordKind;
  connection_id: string;
  covered_grants_json: string;
  runs_active_json: string | null;
  history_state: ErasureStoreState;
  deadline: string;
  cause: ConnectionRecordCause;
  hold_until: string | null;
  revoked_grant: string | null;
}

const toRecord = (r: RecordRow): StoredConnectionRecord => ({
  id: r.id, kind: r.kind, connectionId: r.connection_id, coveredGrants: parseIds(r.covered_grants_json),
  historyState: r.history_state, deadline: r.deadline, cause: r.cause, holdUntil: r.hold_until, revokedGrant: r.revoked_grant,
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
 * Whether the connection now stored under `connectionId` holds one of `grants`: as its current
 * grant, as the grant its row was created with, or anywhere in its epoch. Read straight from the
 * row, so a row whose epoch cannot be told still counts.
 */
function liveRowHolds(engineDb: Database.Database, connectionId: string, grants: readonly string[]): boolean {
  const row = engineDb.prepare("SELECT config_json, first_grant_id FROM connections WHERE id = ? AND kind = 'api'")
    .get(connectionId) as { config_json: string; first_grant_id: string | null } | undefined;
  if (!row) return false;
  const held = [currentGrantOf(row.config_json), row.first_grant_id, ...(connectionEpoch(engineDb, connectionId)?.epoch ?? [])];
  return held.some((g) => g !== null && grants.includes(g));
}

/** Told each time a store's state is first set or changes: the audit row of R8-3. */
export type ErasureStateHook = (record: StoredConnectionRecord, state: ErasureStoreState) => void;

/**
 * One sweep pass over every erasure record that covers a grant. Each pass erases the record's
 * rows again, a `done` record's too until its deadline, a `late` one's also after it: a call its
 * run abandoned lands on the session's next run (`session.ts`, `call.runId ?? this.currentRunId`),
 * after the runs active at the delete ended. A record is skipped while a connection stored under
 * its id holds one of its grants again, so it does not reach that connection's rows while it is
 * stored; once that copy is removed, the record reaches the rows it left under the record's
 * grants: a `late` record also after its deadline, a `done` one only until it.
 *
 * The store becomes `done` once none of the runs that were active at the record's first sweep
 * still runs, checked before that pass erases, so every row those runs wrote is already in; it
 * becomes `late` when the deadline passes first, skipped or not. A pass that throws marks a
 * pending store `failed` and is retried by the next.
 *
 * `onState` is told the first pass (`pending`, also for a store that is done in that same pass)
 * and every change after it, and a record that covers nothing is told `not reached` once. It runs
 * in the same engine.db transaction as the state it reports: if it throws, the state stays as it
 * was and the next pass tells it again.
 *
 * Once a store is done the WAL is emptied, so the erased rows' old pages do not outlive them
 * there; a checkpoint another connection blocks is tried again by the next pass.
 */
export function runConnectionErasureSweeps(engineDb: Database.Database, historyDb: Database.Database, now: Date, onState?: ErasureStateHook): void {
  const setState = (record: RecordRow, states: readonly ErasureStoreState[], active: readonly string[] | null): void => {
    const next = states[states.length - 1]!;
    engineDb.transaction(() => {
      engineDb.prepare(`UPDATE connection_records SET runs_active_json = COALESCE(runs_active_json, ?), history_state = ?,
          done_at = CASE WHEN ? = 'done' THEN COALESCE(done_at, ?) ELSE done_at END,
          label = CASE WHEN ? = 'done' THEN NULL ELSE label END,
          wal_scrub_pending = CASE WHEN ? = 'done' AND history_state <> 'done' THEN 1 ELSE wal_scrub_pending END
        WHERE id = ?`).run(active === null ? null : JSON.stringify(active), next, next, now.toISOString(), next, next, record.id);
      for (const state of states) onState?.(toRecord({ ...record, history_state: state }), state);
    })();
  };

  // A record that covers nothing is reported once; `runs_active_json` marks it reported.
  // A held or cancelled record is not read at all: it neither erases nor turns late before its hold ends.
  const due = "history_state <> 'cancelled' AND (hold_until IS NULL OR hold_until <= ?)";
  const unreached = engineDb.prepare(`SELECT * FROM connection_records WHERE kind = 'erasure' AND covered_grants_json = '[]' AND runs_active_json IS NULL AND ${due} ORDER BY id`).all(now.toISOString()) as RecordRow[];
  for (const record of unreached) {
    try { setState(record, ['not reached'], []); } catch { /* reported by the next pass */ }
  }

  const records = engineDb.prepare(`SELECT * FROM connection_records WHERE kind = 'erasure' AND covered_grants_json <> '[]' AND ${due} ORDER BY id`).all(now.toISOString()) as RecordRow[];
  for (const record of records) {
    try {
      const grants = parseIds(record.covered_grants_json);
      const pastDeadline = now.getTime() > Date.parse(record.deadline);
      const open = record.history_state === 'pending' || record.history_state === 'failed';
      // Only a `done` record stops at its deadline: a `late` one may not have reached its rows yet
      // (a live copy held them), so it keeps its passes.
      if (grants.length === 0 || (pastDeadline && record.history_state === 'done')) continue;
      // The profile stays after a provider's refusal, so the live-row rule does not apply to its
      // record: what bounds it is time (only runs created up to `hold_until`, below).
      if (record.cause !== 'provider_revoked' && liveRowHolds(engineDb, record.connection_id, grants)) {
        // A record that turns late here never had a pass: `[]` marks its first report as made.
        if (open && pastDeadline) setState(record, record.runs_active_json === null ? ['pending', 'late'] : ['late'], record.runs_active_json === null ? [] : null);
        continue;
      }
      let active: string[];
      let stillRunning: number;
      let kept: number | null;
      try {
        ({ active, stillRunning, kept } = historyDb.transaction(() => {
          const runs = record.runs_active_json !== null
            ? parseIds(record.runs_active_json)
            : (historyDb.prepare("SELECT id FROM runs WHERE status = 'running'").all() as Array<{ id: string }>).map((r) => r.id);
          const running = runs.length === 0 ? 0 : (historyDb.prepare(
            `SELECT COUNT(*) AS n FROM runs WHERE status = 'running' AND id IN (${runs.map(() => '?').join(',')})`,
          ).get(...runs) as { n: number }).n;
          // A provider's erasure reaches the calls of runs created up to day X (`hold_until`), never
          // those of a run created after it: a call is judged by the run it belongs to. Calls of
          // later runs that still carry the refused grant stay until the owner removes the
          // connection with an erasure; `kept_after_hold` counts them, without content, for the
          // operator, on every pass until the record is done and past its deadline.
          const until = record.cause === 'provider_revoked' && record.hold_until !== null ? record.hold_until : null;
          const inGrants = `connection_id = ? AND grant_id IN (${grants.map(() => '?').join(',')})`;
          historyDb.prepare(`DELETE FROM run_tool_calls WHERE ${inGrants}
            ${until === null ? '' : 'AND run_id IN (SELECT id FROM runs WHERE julianday(created_at) <= julianday(?))'}`)
            .run(record.connection_id, ...grants, ...(until === null ? [] : [until]));
          const left = until === null ? null : (historyDb.prepare(`SELECT COUNT(*) AS n FROM run_tool_calls WHERE ${inGrants}
            AND run_id IN (SELECT id FROM runs WHERE julianday(created_at) > julianday(?))`)
            .get(record.connection_id, ...grants, until) as { n: number }).n;
          return { active: runs, stillRunning: running, kept: left };
        }).immediate());
      } catch {
        if (record.history_state === 'pending') setState(record, ['failed'], null);
        continue;
      }
      if (kept !== null) engineDb.prepare('UPDATE connection_records SET kept_after_hold = ? WHERE id = ?').run(kept, record.id);
      const next: ErasureStoreState = record.history_state === 'done' || record.history_state === 'late' ? record.history_state
        : stillRunning === 0 ? 'done'
        : pastDeadline ? 'late'
        : 'pending';
      const first = record.runs_active_json === null;
      const told: ErasureStoreState[] = first && next !== 'pending' ? ['pending', next] : first || next !== record.history_state ? [next] : [];
      if (told.length > 0) setState(record, told, active);
    } catch {
      // One record's failure does not keep the others from their pass; the next pass retries it.
    }
  }

  try {
    const waiting = (engineDb.prepare('SELECT COUNT(*) AS n FROM connection_records WHERE wal_scrub_pending = 1').get() as { n: number }).n;
    if (waiting > 0) {
      const result = historyDb.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
      if ((result[0]?.busy ?? 1) === 0) engineDb.prepare('UPDATE connection_records SET wal_scrub_pending = 0 WHERE wal_scrub_pending = 1').run();
    }
  } catch {
    // Tried again by the next pass: the records keep `wal_scrub_pending`.
  }
}

/**
 * The content columns the runbook's fallback blanks, per history.db table. A test holds every
 * text column of these tables to one of this map
 * and {@link FALLBACK_KEPT_COLUMNS}, and every table of history.db to these or a named reason.
 */
export const FALLBACK_CONTENT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  advisor_suggestions: ['title', 'detail', 'estimated_impact_json'],
  pending_prompts: ['question', 'options_json', 'answer', 'questions_json', 'partial_answers_json', 'answer_error', 'payload_json', 'segments_json', 'origin_json'],
  pipeline_runs: ['manifest_json', 'error'],
  pipeline_step_results: ['result', 'error'],
  pre_approval_events: ['match_string', 'pattern'],
  pre_approval_sets: ['task_summary', 'patterns_json'],
  processes: ['description', 'steps_json', 'parameters_json'],
  run_tool_calls: ['input_json', 'output_json'],
  runs: ['task_hash', 'task_text', 'response_text', 'prompt_hash', 'error_text'],
  security_events: ['input_preview', 'detail'],
  wire_snapshots: ['user_message'],
};

/**
 * The text columns of the same tables the fallback keeps: ids, names the customer chose, status
 * and type fields, model and provider, the connection and grant columns, and `composition_json`
 * (byte counts and tool names). `context_id` stays; where a context id the
 * customer configured names a person from the request, the runbook replaces it by hand.
 */
export const FALLBACK_KEPT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  advisor_suggestions: ['run_id', 'type', 'priority', 'context_id', 'created_at', 'dismissed_at'],
  pending_prompts: ['id', 'session_id', 'prompt_type', 'secret_name', 'secret_key_type', 'status', 'created_at', 'answered_at', 'expires_at', 'trigger_id', 'created_by', 'closed_reason', 'mandate_id', 'answered_by', 'answered_mandate_id'],
  pipeline_runs: ['id', 'manifest_name', 'status', 'parent_run_id', 'started_at', 'completed_at', 'workflow_id', 'workflow_grant_id', 'started_via', 'origin_thread_id'],
  pipeline_step_results: ['pipeline_run_id', 'step_id', 'status', 'model_tier'],
  pre_approval_events: ['set_id', 'tool_name', 'decision', 'autonomy_level', 'run_id', 'created_at'],
  pre_approval_sets: ['id', 'approved_by', 'run_id', 'created_at'],
  processes: ['id', 'name', 'source_run_id', 'promoted_to_pipeline_id', 'created_at'],
  // v69's text columns are enumerated values and ids, never free text: kept (held
  // to their value sets by a test). `is_error` is an INTEGER and outside this list.
  run_tool_calls: ['id', 'run_id', 'tool_name', 'connection_id', 'connection_created_at', 'grant_id', 'tool_use_id', 'contract_state', 'contract_grant_id', 'lift_grant_id', 'lift_entry', 'filing', 'approval_id'],
  runs: ['id', 'session_id', 'model_tier', 'model_id', 'stop_reason', 'status', 'run_type', 'batch_parent_id', 'spawn_parent_id', 'context_id', 'created_at', 'tenant_id', 'archetype_id', 'kind', 'provider', 'composition_json', 'trigger_origin'],
  security_events: ['event_type', 'tool_name', 'decision', 'autonomy_level', 'agent_name', 'run_id', 'source', 'created_at'],
  wire_snapshots: ['run_id', 'model', 'provider', 'system_prompt_hash', 'tool_names', 'tool_choice'],
};

/**
 * What a blanked column holds: fixed and never empty, because readers count an empty result or
 * error as something (analytics, the replay, the deferred marker of a step result). A NULL, `''`
 * and `'{}'` stay as they are, so "had an error" is kept. It is written in clear in encrypted
 * columns too: it is no secret, and the reader passes a value without the prefix through.
 */
export const FALLBACK_MARKER = '[erased on request]';

/** Which runs the fallback reaches: the runs of these threads, or of this period. */
export type FallbackScope =
  | { readonly threadIds: readonly string[] }
  | { readonly from: string; readonly to: string };

/** How each table's rows are reached from the scoped runs (temp table `erase_runs`). */
const ROWS_OF: Readonly<Record<string, string>> = {
  advisor_suggestions: 'run_id IN (SELECT id FROM erase_runs)',
  pipeline_step_results: 'pipeline_run_id IN (SELECT id FROM erase_pipelines)',
  pre_approval_events: 'run_id IN (SELECT id FROM erase_runs) OR set_id IN (SELECT id FROM pre_approval_sets WHERE run_id IN (SELECT id FROM erase_runs))',
  pre_approval_sets: 'run_id IN (SELECT id FROM erase_runs)',
  processes: 'source_run_id IN (SELECT id FROM erase_runs)',
  run_tool_calls: 'run_id IN (SELECT id FROM erase_runs)',
  runs: 'id IN (SELECT id FROM erase_runs)',
  security_events: 'run_id IN (SELECT id FROM erase_runs)',
  wire_snapshots: 'run_id IN (SELECT id FROM erase_runs)',
};

/**
 * Blanks the content of the runs in `scope` and of everything they spawned, keeping every row
 * with its costs and counts (R8-7), then drops the freed pages and empties the WAL so the old
 * values are gone from the file too. `scrub` is `failed` when another connection blocked the
 * checkpoint: the blanking holds, but old values may remain in the file until the next scrub.
 */
export function blankRunHistoryContent(historyDb: Database.Database, scope: FallbackScope): { readonly rows: number; readonly scrub: 'done' | 'failed' } {
  const byThread = 'threadIds' in scope;
  // A bound that does not read as a time would compare as text and reach nothing, which would
  // then be reported as a clean run.
  if (!byThread && !(Number.isFinite(Date.parse(scope.from)) && Number.isFinite(Date.parse(scope.to)) && Date.parse(scope.from) < Date.parse(scope.to))) {
    throw new Error('blankRunHistoryContent: the period must be two readable times, the first before the second');
  }
  const threads = byThread ? [...scope.threadIds] : [];
  const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',');
  const rows = historyDb.transaction(() => {
    historyDb.exec('CREATE TEMP TABLE IF NOT EXISTS erase_runs (id TEXT PRIMARY KEY); DELETE FROM erase_runs;'
      + ' CREATE TEMP TABLE IF NOT EXISTS erase_pipelines (id TEXT PRIMARY KEY); DELETE FROM erase_pipelines;');
    // The scope's own runs and workflows, then everything they reach until nothing new is found:
    // a run spawned or batched by a scoped run, a step run of a scoped workflow (the runner stores
    // the workflow's id as the step run's spawn parent), and a workflow nested in a
    // scoped run or workflow (its parent is the outer workflow's id). Period bounds go through
    // `datetime()`, the form every scoped table stores its times in, so an ISO bound means what it
    // says.
    const scopeParams = byThread ? threads : [scope.from, scope.to];
    historyDb.prepare(byThread
      ? (threads.length === 0 ? 'SELECT 1 WHERE 0' : `INSERT OR IGNORE INTO erase_runs (id) SELECT id FROM runs WHERE session_id IN (${marks(threads.length)})`)
      : 'INSERT OR IGNORE INTO erase_runs (id) SELECT id FROM runs WHERE created_at >= datetime(?) AND created_at < datetime(?)').run(...scopeParams);
    historyDb.prepare(byThread
      ? (threads.length === 0 ? 'SELECT 1 WHERE 0' : `INSERT OR IGNORE INTO erase_pipelines (id) SELECT id FROM pipeline_runs WHERE origin_thread_id IN (${marks(threads.length)})`)
      : 'INSERT OR IGNORE INTO erase_pipelines (id) SELECT id FROM pipeline_runs WHERE started_at >= datetime(?) AND started_at < datetime(?)').run(...scopeParams);
    const reachRuns = historyDb.prepare(`INSERT OR IGNORE INTO erase_runs (id) SELECT id FROM runs
      WHERE spawn_parent_id IN (SELECT id FROM erase_runs UNION SELECT id FROM erase_pipelines)
         OR batch_parent_id IN (SELECT id FROM erase_runs)`);
    const reachPipelines = historyDb.prepare(`INSERT OR IGNORE INTO erase_pipelines (id) SELECT id FROM pipeline_runs
      WHERE parent_run_id IN (SELECT id FROM erase_runs UNION SELECT id FROM erase_pipelines)`);
    while (reachRuns.run().changes + reachPipelines.run().changes > 0) { /* until nothing new is reached */ }
    let changed = 0;
    for (const [table, columns] of Object.entries(FALLBACK_CONTENT_COLUMNS)) {
      // What holds no content stays as it is: readers count `''` and `'{}'` as "no error" or
      // "deferred", so a marker there would turn a successful call into a failed one.
      const set = columns.map((c) => `"${c}" = CASE WHEN "${c}" IS NULL OR "${c}" IN ('', '{}') THEN "${c}" ELSE @marker END`).join(', ');
      let where: string;
      let params: Record<string, string> = {};
      if (table === 'pipeline_runs') {
        where = 'id IN (SELECT id FROM erase_pipelines)';
      } else if (table === 'pending_prompts') {
        where = byThread
          ? `session_id IN (SELECT id FROM erase_pipelines)${threads.length === 0 ? '' : ` OR session_id IN (${threads.map((_t, i) => `@t${i}`).join(',')})`}`
          : 'created_at >= datetime(@from) AND created_at < datetime(@to)';
        params = byThread ? Object.fromEntries(threads.map((t, i) => [`t${i}`, t])) : { from: scope.from, to: scope.to };
      } else {
        where = ROWS_OF[table]!;
      }
      changed += historyDb.prepare(`UPDATE "${table}" SET ${set} WHERE ${where}`).run({ marker: FALLBACK_MARKER, ...params }).changes;
    }
    historyDb.exec('DELETE FROM erase_runs; DELETE FROM erase_pipelines;');
    return changed;
  })();
  try {
    scrubFreedPages(historyDb);
    return { rows, scrub: 'done' };
  } catch {
    return { rows, scrub: 'failed' };
  }
}

/**
 * Whether the `api_setup` delete erases. Off until the question the person answers names the
 * erasure (E5): until then the delete is not an instruction to erase (premise 5 of revision 8),
 * so it writes a closing record like the settings route. E5 turns it on with its text.
 */
let erasureOnDelete = false;

export function erasureOnDeleteEnabled(): boolean {
  return erasureOnDelete;
}

/** Test seam: sets the gate and returns the restore. */
export function setErasureOnDeleteForTests(on: boolean): () => void {
  const before = erasureOnDelete;
  erasureOnDelete = on;
  return () => { erasureOnDelete = before; };
}
