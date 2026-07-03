import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';

/**
 * ConnectionStore — the S4b write/read layer over the engine.db `connections`
 * table (Foundation Rework v2, NOUN cluster-3). A Connection is a
 * credential-bearing OUTBOUND capability binding to an external system: the
 * non-secret shape lives in `config_json`, the secret material stays in
 * `vault.db` (this store only records the vault key NAMES in `vault_keys`).
 *
 * The store is deliberately KIND-GENERIC: `config_json` is an opaque TEXT blob
 * at this layer, so no per-kind type leaks in as `any`. The typed
 * `ApiProfile ⟺ config_json` (de)serialization lives with the caller (the api
 * layer, `api-store.ts`). Only `kind='api'` is wired in S4b; `mail`/`google`/
 * `push` remain deferred to later slices (the DDL comment reserves them, but no
 * unwired enum value is minted here).
 *
 * Single-authority (not an additive mirror): unlike the S3/S4a verb stores, the
 * `connections` table is the SOLE source of truth for the kinds it holds — the
 * legacy flat-JSON api profiles are imported once then retired (see
 * {@link import('./api-store.js').ApiStore.importFromDirectoryIfNeeded}).
 */

/** A `connections` row as this store reads/writes it. `configJson` is opaque
 *  TEXT (the caller owns its typed schema); `vaultKeys` is a name-array (never
 *  secret material). Timestamps are DB-assigned on insert and present on reads. */
export interface ConnectionRow {
  id: string;
  /** `api` wired in S4b; `mail`/`google`/`push` reserved for later slices. */
  kind: string;
  name: string;
  subjectId: string | null;
  direction: string | null;
  configJson: string;
  vaultKeys: string[];
  status: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

interface ConnectionDbRow {
  id: string;
  kind: string;
  name: string;
  subject_id: string | null;
  direction: string | null;
  config_json: string;
  vault_keys: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/** Parse a stored `vault_keys` JSON array defensively — a malformed or
 *  non-array value degrades to `[]` rather than throwing on read-back. */
function parseVaultKeys(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export class ConnectionStore {
  private readonly db: Database.Database;

  constructor(engine: EngineDb) {
    this.db = engine.getDb();
  }

  /**
   * Upsert a connection (INSERT-or-update by id). Uses `ON CONFLICT DO UPDATE`
   * (not `INSERT OR REPLACE`) so `created_at` survives an update and the
   * inbound `triggers.source_connection_id` FK (ON DELETE SET NULL) is never
   * tripped by a delete+reinsert. `updated_at` is refreshed on every write.
   *
   * `subject_id` FK-guards implicitly: engine.db runs `foreign_keys = ON`, so a
   * non-null `subjectId` pointing at an absent subject throws — but the api
   * kind always passes `null` (no org binding yet), so that path isn't hit.
   */
  upsert(row: ConnectionRow): void {
    this.db.prepare(`
      INSERT INTO connections (id, kind, name, subject_id, direction, config_json, vault_keys, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        subject_id = excluded.subject_id,
        direction = excluded.direction,
        config_json = excluded.config_json,
        vault_keys = excluded.vault_keys,
        status = excluded.status,
        updated_at = datetime('now')
    `).run(
      row.id,
      row.kind,
      row.name,
      row.subjectId,
      row.direction,
      row.configJson,
      JSON.stringify(row.vaultKeys),
      row.status,
    );
  }

  /**
   * Upsert many rows ATOMICALLY (one transaction). Either every row lands or
   * none does — so a transient failure (lock, disk-full) mid-batch rolls the
   * whole batch back rather than leaving a partial import the caller would then
   * mistake for "done". Used by the one-shot flat-JSON → connections cutover.
   */
  upsertMany(rows: readonly ConnectionRow[]): void {
    const tx = this.db.transaction((batch: readonly ConnectionRow[]) => {
      for (const row of batch) this.upsert(row);
    });
    tx(rows);
  }

  /** Read one connection by exact id. */
  get(id: string): ConnectionRow | undefined {
    const row = this.db.prepare(
      `SELECT id, kind, name, subject_id, direction, config_json, vault_keys, status, created_at, updated_at
       FROM connections WHERE id = ?`,
    ).get(id) as ConnectionDbRow | undefined;
    return row ? this._map(row) : undefined;
  }

  /** All connections of a kind, oldest first (the `id` tiebreaker makes the order
   *  deterministic when a bulk import shares a second-resolution created_at). */
  getByKind(kind: string): ConnectionRow[] {
    const rows = this.db.prepare(
      `SELECT id, kind, name, subject_id, direction, config_json, vault_keys, status, created_at, updated_at
       FROM connections WHERE kind = ? ORDER BY created_at ASC, id ASC`,
    ).all(kind) as ConnectionDbRow[];
    return rows.map(r => this._map(r));
  }

  /** All connections, oldest first (deterministic `id` tiebreaker). */
  list(): ConnectionRow[] {
    const rows = this.db.prepare(
      `SELECT id, kind, name, subject_id, direction, config_json, vault_keys, status, created_at, updated_at
       FROM connections ORDER BY created_at ASC, id ASC`,
    ).all() as ConnectionDbRow[];
    return rows.map(r => this._map(r));
  }

  /** How many connections of a kind exist (the import one-shot guard). */
  count(kind: string): number {
    const { c } = this.db.prepare('SELECT COUNT(*) AS c FROM connections WHERE kind = ?').get(kind) as { c: number };
    return c;
  }

  /**
   * Delete a connection by id. Returns whether a row was removed. The inbound
   * `triggers.source_connection_id` FK nulls out automatically (ON DELETE SET NULL).
   *
   * `kind` scopes the delete: since `id` is a global PK but ids are agent-slugged
   * per kind, a caller owning one kind (e.g. the api layer) passes its `kind` so a
   * cross-kind id collision can never delete a neighbour's connection once
   * mail/google/push land. Omit `kind` for an unscoped delete-by-PK.
   */
  remove(id: string, kind?: string): boolean {
    const stmt = kind === undefined
      ? this.db.prepare('DELETE FROM connections WHERE id = ?')
      : this.db.prepare('DELETE FROM connections WHERE id = ? AND kind = ?');
    const result = kind === undefined ? stmt.run(id) : stmt.run(id, kind);
    return result.changes > 0;
  }

  private _map(row: ConnectionDbRow): ConnectionRow {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      subjectId: row.subject_id,
      direction: row.direction,
      configJson: row.config_json,
      vaultKeys: parseVaultKeys(row.vault_keys),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
