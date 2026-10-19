import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Why a grant was minted. `new` — the connection was created. `consent` — a new
 * authorization arrived (the OAuth callback). `credentials` — a save changed the
 * credentials the connection is configured with (see `credentialTuple`).
 * `backfill` — the boot found a connection without a grant this ledger knows.
 * `split` — the boot found two connections sharing one grant and gave one a fresh one.
 * `baseline` — the boot found a grant with no stored credential fingerprints, minted before
 * they were recorded. `secret-write` — the user stored a credential the connection reads.
 * `secret-changed` — the boot found a credential the connection reads that is not the one its
 * grant recorded. `exchange` — a token exchange ran on a credential the grant never recorded.
 * `rekey` — the boot found the grant's fingerprints taken under another vault key.
 * `engine-write` — a token exchange of another connection wrote a name this one reads.
 */
export type GrantMintReason = 'new' | 'consent' | 'credentials' | 'backfill' | 'split'
  | 'baseline' | 'secret-write' | 'secret-changed' | 'exchange' | 'rekey' | 'engine-write';

export interface GrantLedgerRow {
  grant_id: string;
  connection_id: string;
  kind: string;
  reason: GrantMintReason;
  minted_at: string;
}

/**
 * The grant ledger over engine.db `connection_grants` (PRD connection-attribution A1).
 *
 * A grant is one epoch of a connection: what is stored under it came from the credentials
 * the connection had then. The ledger maps every grant ever minted to its connection, and
 * it keeps that row after the connection itself is deleted — the row is the only thing that
 * still says which connection a superseded grant belonged to.
 *
 * The ledger only records. Which save mints is decided in one place, `ApiStore`, and that is
 * the only caller of {@link mint}.
 */
export class GrantLedger {
  constructor(private readonly db: Database.Database) {}

  /** Mint a fresh grant id for `connectionId` and record it. Returns the id. */
  mint(connectionId: string, kind: string, reason: GrantMintReason): string {
    const grantId = randomUUID();
    this.db
      .prepare('INSERT INTO connection_grants (grant_id, connection_id, kind, reason) VALUES (?, ?, ?, ?)')
      .run(grantId, connectionId, kind, reason);
    return grantId;
  }

  get(grantId: string): GrantLedgerRow | undefined {
    return this.db
      .prepare('SELECT grant_id, connection_id, kind, reason, minted_at FROM connection_grants WHERE grant_id = ?')
      .get(grantId) as GrantLedgerRow | undefined;
  }

  /** Every grant the connection was ever given, oldest first. */
  forConnection(connectionId: string): GrantLedgerRow[] {
    return this.db
      .prepare('SELECT grant_id, connection_id, kind, reason, minted_at FROM connection_grants WHERE connection_id = ? ORDER BY minted_at, rowid')
      .all(connectionId) as GrantLedgerRow[];
  }

  /** The connection's newest grant, by insertion order (a clock can step back; the rowid does not). */
  latest(connectionId: string): GrantLedgerRow | undefined {
    return this.db
      .prepare('SELECT grant_id, connection_id, kind, reason, minted_at FROM connection_grants WHERE connection_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(connectionId) as GrantLedgerRow | undefined;
  }

  /**
   * Record `hosts` as the grant's host set (PRD connection-attribution A4), unless it is the set
   * the grant's newest snapshot already holds. A snapshot is the FULL set, sorted and without
   * duplicates, so two snapshots compare as strings; an empty set closes the grant's window (its
   * connection was removed). Returns whether it wrote one.
   */
  recordHosts(grantId: string, hosts: readonly string[]): boolean {
    const json = JSON.stringify([...new Set(hosts)].sort());
    if (this.latestHosts(grantId) === json) return false;
    this.db.prepare('INSERT INTO connection_grant_hosts (grant_id, hosts_json) VALUES (?, ?)').run(grantId, json);
    return true;
  }

  /** The grant's newest host snapshot as stored (a sorted JSON array), by insertion order (`id`). */
  latestHosts(grantId: string): string | undefined {
    const row = this.db
      .prepare('SELECT hosts_json FROM connection_grant_hosts WHERE grant_id = ? ORDER BY id DESC LIMIT 1')
      .get(grantId) as { hosts_json: string } | undefined;
    return row?.hosts_json;
  }

  /** Every host snapshot of the grant, oldest first. */
  hostsHistory(grantId: string): Array<{ hosts: string[]; from_at: string }> {
    const rows = this.db
      .prepare('SELECT hosts_json, from_at FROM connection_grant_hosts WHERE grant_id = ? ORDER BY id')
      .all(grantId) as Array<{ hosts_json: string; from_at: string }>;
    return rows.map((r) => ({ hosts: JSON.parse(r.hosts_json) as string[], from_at: r.from_at }));
  }

  /** Whether a transaction is open on the ledger's connection. */
  inTransaction(): boolean {
    return this.db.inTransaction;
  }

  /** Run `fn` in one transaction, so a mint and the save that carries it land together. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
