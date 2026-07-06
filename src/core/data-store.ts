import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getLynoxDir } from './config.js';
import { getErrorMessage } from './utils.js';
import type {
  DataStoreSchemaType,
  DataStoreColumnDef,
  DataStoreCollectionInfo,
  DataStoreAggFn,
  DataStoreAggregation,
  DataStoreSort,
  MemoryScopeRef,
} from '../types/index.js';
import type { SubjectColumnBridge } from './subject-store.js';

// === Constants ===

const COLLECTION_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED_NAMES = new Set(['meta', 'collections', 'schema_version', 'sqlite_master']);

/**
 * Collection names that conceptually overlap with the dedicated CRM subsystem
 * (people/companies/deals/interactions live in `crm.ts` with a typed schema).
 * The agent has historically created empty DataStore collections under these
 * names — they then show up in the UI alongside the real CRM tab and confuse
 * the user. Empty collections matching this set are dropped on engine startup
 * (see `dropEmptyCrmOverlaps`), and the web UI filters out any that survive a
 * mid-session re-creation (belt-and-suspenders). Non-empty collections are
 * preserved — a power user may have a legitimate "contacts" table.
 */
export const CRM_OVERLAP_NAMES: ReadonlySet<string> = new Set([
  'contacts', 'companies', 'people', 'deals', 'interactions',
]);
const MAX_COLLECTIONS = 100;
const MAX_COLUMNS = 50;
const MAX_RECORDS = 100_000;
const MAX_INSERT_BATCH = 1000;
const MAX_DB_SIZE_BYTES = 500 * 1024 * 1024;
const VALID_COLUMN_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const SYSTEM_COLUMNS = new Set(['_id', '_created_at', '_updated_at']);

/**
 * Bound in place of an unresolvable subject NAME when filtering a subject column
 * by name (R1.5). A `subject_id` is a UUID; this sentinel equals no id, so the
 * parameterized `= ?` / `IN (?)` clause matches 0 rows — a clean "no
 * such subject" instead of silently dropping the filter or matching everything.
 */
const UNRESOLVABLE_SUBJECT = '__lynox_no_such_subject__';

const TYPE_MAP: Record<DataStoreSchemaType, string> = {
  string: 'TEXT',
  number: 'REAL',
  date: 'TEXT',
  boolean: 'INTEGER',
  json: 'TEXT',
  // A `subject` column stores a subject_id (a UUID string) — a cross-DB soft
  // ref into engine.db, resolved from a name on insert (see `_coerceValue`).
  subject: 'TEXT',
};

const VALID_OPERATORS = new Set([
  '$eq', '$neq', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$like', '$is_null',
]);

const VALID_AGG_FNS = new Set<DataStoreAggFn>([
  'sum', 'avg', 'min', 'max', 'count', 'count_distinct',
]);

// === DataStore ===

/**
 * One row in a subject's cross-collection record footprint (Record-on-spine R2b).
 * `occurredAt` is the collection's `occurred_at`-marked date (the true event time)
 * when `occurredAtIsEventTime` is true, else the `_created_at` insert-time fallback.
 * `matchedColumns` names the subject column(s) that linked the row (e.g. `client`
 * vs `vendor` on an invoice). `row` is the raw stored row (subject cells stay ids —
 * display-name hydration is the caller's concern).
 */
export interface SubjectRecordOccurrence {
  collection: string;
  occurredAt: string | null;
  occurredAtIsEventTime: boolean;
  matchedColumns: string[];
  row: Record<string, unknown>;
}

/** The before-image of one subject-column repoint (per collection/column) — the reversal record for a merge. */
export interface SubjectRepointRecord {
  collection: string;
  column: string;
  ids: number[];
}

export class DataStore {
  private db: Database.Database;

  /**
   * Record-on-spine: the DataStore ⇄ subject-graph bridge (resolve on write, find
   * on name-filter, name on display). Injected by the engine ONLY when
   * `subject_graph_enabled` (see `Engine._init`). When null — the fleet default
   * today — `subject` columns degrade to storing/filtering/showing the raw string,
   * so DataStore stays fully usable without the subject graph.
   */
  private _subjectBridge: SubjectColumnBridge | null = null;

  constructor(dbPath?: string | undefined) {
    const path = dbPath ?? join(getLynoxDir(), 'datastore.db');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._initMeta();
  }

  /**
   * Inject (or clear) the subject-column bridge. Passing a bridge turns `subject`
   * columns into real subject links (name→id on write, name-filter + id→name
   * display on the agent-facing query path); passing null reverts them to
   * plain-string storage. Idempotent — safe to call once at engine init.
   */
  setSubjectBridge(bridge: SubjectColumnBridge | null): void {
    this._subjectBridge = bridge;
  }

  private _initMeta(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ds_collections (
        name TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL DEFAULT 'project',
        scope_id TEXT NOT NULL DEFAULT '',
        schema_json TEXT NOT NULL,
        unique_key TEXT,
        record_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  /** Throw if database disk size exceeds MAX_DB_SIZE_BYTES. */
  private _checkDbSize(): void {
    const pageInfo = this.db.prepare('PRAGMA page_count').get() as { page_count: number };
    const pageSizeInfo = this.db.prepare('PRAGMA page_size').get() as { page_size: number };
    const dbSize = pageInfo.page_count * pageSizeInfo.page_size;
    if (dbSize > MAX_DB_SIZE_BYTES) {
      throw new Error(`DataStore disk size (${Math.floor(dbSize / 1024 / 1024)}MB) exceeds limit (${Math.floor(MAX_DB_SIZE_BYTES / 1024 / 1024)}MB).`);
    }
  }

  // === Collection Management ===

  createCollection(params: {
    name: string;
    scope: MemoryScopeRef;
    columns: DataStoreColumnDef[];
    uniqueKey?: string[] | undefined;
  }): DataStoreCollectionInfo {
    const { name, scope, columns, uniqueKey } = params;

    // Validate name
    if (!COLLECTION_NAME_RE.test(name)) {
      throw new Error(`Table name "${name}" is not valid. Use lowercase letters, numbers, and underscores only (e.g., "sales_data", "monthly_kpis").`);
    }
    if (RESERVED_NAMES.has(name)) {
      throw new Error(`Table name "${name}" is reserved by the system. Choose a different name.`);
    }

    // Check limits
    this._checkDbSize();
    const existing = this.db.prepare('SELECT COUNT(*) as cnt FROM ds_collections').get() as { cnt: number };
    if (existing.cnt >= MAX_COLLECTIONS) {
      throw new Error(`Maximum of ${MAX_COLLECTIONS} tables reached. Delete unused tables first.`);
    }

    // Check if collection already exists
    const existingCol = this.db.prepare('SELECT name FROM ds_collections WHERE name = ?').get(name);
    if (existingCol) {
      throw new Error(`A table named "${name}" already exists.`);
    }

    // Validate columns
    if (columns.length === 0) {
      throw new Error('At least one column is required.');
    }
    if (columns.length > MAX_COLUMNS) {
      throw new Error(`Maximum ${MAX_COLUMNS} columns per collection.`);
    }

    const colNames = new Set<string>();
    for (const col of columns) {
      if (!VALID_COLUMN_NAME_RE.test(col.name)) {
        throw new Error(`Column name "${col.name}" is not valid. Use lowercase letters, numbers, and underscores only (e.g., "revenue", "created_at").`);
      }
      if (SYSTEM_COLUMNS.has(col.name)) {
        throw new Error(`Column name "${col.name}" is reserved by the system. Choose a different name.`);
      }
      if (colNames.has(col.name)) {
        throw new Error(`Duplicate column name "${col.name}".`);
      }
      if (!(col.type in TYPE_MAP)) {
        throw new Error(`Column type "${col.type}" is not supported. Use: ${Object.keys(TYPE_MAP).join(', ')}.`);
      }
      colNames.add(col.name);
    }

    this._validateOccurredAtRole(columns);

    // Validate unique key
    if (uniqueKey) {
      for (const key of uniqueKey) {
        if (!colNames.has(key)) {
          throw new Error(`Unique key references column "${key}" which is not defined in the table.`);
        }
      }
    }

    const now = new Date().toISOString();
    // SECURITY: tableName is safe because `name` is validated by COLLECTION_NAME_RE (/^[a-z][a-z0-9_]{0,62}$/).
    // Do NOT relax COLLECTION_NAME_RE without reviewing all SQL string interpolations below.
    const tableName = `ds_${name}`;

    // Build CREATE TABLE DDL
    const colDefs = [
      '_id INTEGER PRIMARY KEY AUTOINCREMENT',
      '_created_at TEXT NOT NULL',
      '_updated_at TEXT NOT NULL',
    ];
    for (const col of columns) {
      let def = `"${col.name}" ${TYPE_MAP[col.type]}`;
      if (col.unique === true) {
        def += ' UNIQUE';
      }
      colDefs.push(def);
    }

    // Build transaction
    const transaction = this.db.transaction(() => {
      this.db.exec(`CREATE TABLE "${tableName}" (${colDefs.join(', ')})`);

      // Create unique constraint for composite unique key
      if (uniqueKey && uniqueKey.length > 0) {
        const keyCols = uniqueKey.map(k => `"${k}"`).join(', ');
        this.db.exec(`CREATE UNIQUE INDEX "idx_${name}_ukey" ON "${tableName}" (${keyCols})`);
      }

      // Secondary index on every subject column so per-subject FILTER isn't a full scan.
      this._createSubjectIndexes(name, tableName, columns);

      this.db.prepare(`
        INSERT INTO ds_collections (name, scope_type, scope_id, schema_json, unique_key, record_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        name,
        scope.type,
        scope.id,
        JSON.stringify(columns),
        uniqueKey ? uniqueKey.join(',') : null,
        now,
        now,
      );
    });

    transaction();

    return {
      name,
      scopeType: scope.type,
      scopeId: scope.id,
      columns,
      uniqueKey: uniqueKey ?? null,
      recordCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  // === Record Operations ===

  insertRecords(params: {
    collection: string;
    records: Record<string, unknown>[];
  }): { inserted: number; updated: number; errors: string[] } {
    const { collection, records } = params;

    if (records.length === 0) {
      return { inserted: 0, updated: 0, errors: [] };
    }
    if (records.length > MAX_INSERT_BATCH) {
      throw new Error(`Maximum ${MAX_INSERT_BATCH} records per insert call.`);
    }

    const info = this._getCollectionMeta(collection);
    if (!info) {
      throw new Error(`Collection "${collection}" not found.`);
    }

    const columns = JSON.parse(info.schema_json) as DataStoreColumnDef[];
    const colNames = new Set(columns.map(c => c.name));
    const colDefMap = new Map(columns.map(c => [c.name, c]));
    const tableName = `ds_${collection}`;
    const uniqueKey = info.unique_key ? info.unique_key.split(',') : null;

    // Check record limit
    const currentCount = info.record_count;
    if (currentCount + records.length > MAX_RECORDS) {
      throw new Error(`Collection "${collection}" would exceed ${MAX_RECORDS} record limit (current: ${currentCount}).`);
    }

    // Check database disk size limit
    this._checkDbSize();

    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    const errors: string[] = [];

    const userCols = columns.map(c => c.name);
    const allCols = ['_created_at', '_updated_at', ...userCols];
    const placeholders = allCols.map(() => '?').join(', ');
    const colList = allCols.map(c => `"${c}"`).join(', ');

    let sql: string;
    if (uniqueKey && uniqueKey.length > 0) {
      const keyCols = uniqueKey.map(k => `"${k}"`).join(', ');
      const updateCols = userCols
        .filter(c => !uniqueKey.includes(c))
        .map(c => `"${c}" = excluded."${c}"`)
        .join(', ');
      const updateSet = updateCols
        ? `${updateCols}, "_updated_at" = excluded."_updated_at"`
        : '"_updated_at" = excluded."_updated_at"';
      sql = `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders}) ON CONFLICT(${keyCols}) DO UPDATE SET ${updateSet}`;
    } else {
      sql = `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders})`;
    }

    const stmt = this.db.prepare(sql);

    // Count rows before insert for accurate insert/update tracking
    const countBefore = (this.db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`).get() as { cnt: number }).cnt;

    let succeeded = 0;
    const transaction = this.db.transaction(() => {
      for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        try {
          // Validate and coerce values
          const values: unknown[] = [now, now];
          for (const col of userCols) {
            const val = record[col];
            if (val === undefined || val === null) {
              values.push(null);
              continue;
            }
            const colDef = colDefMap.get(col)!;
            values.push(this._coerceValue(val, colDef));
          }

          // Warn about unknown fields (but don't error)
          for (const key of Object.keys(record)) {
            if (!colNames.has(key)) {
              errors.push(`Record ${i}: unknown field "${key}" ignored.`);
            }
          }

          stmt.run(...values);
          succeeded++;
        } catch (err) {
          errors.push(`Record ${i}: ${getErrorMessage(err)}`);
        }
      }

      // Update record count + timestamp in meta
      const countAfter = (this.db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`).get() as { cnt: number }).cnt;
      inserted = countAfter - countBefore;
      // For upsert: successfully-run rows minus new rows = updates. Count only
      // rows whose stmt.run() actually succeeded — NOT `records.length -
      // errors.length`, because `errors` also holds NON-fatal "unknown field
      // ignored" warnings, so a successful upsert carrying an unknown field was
      // miscounted as a failure and `updated` could go NEGATIVE.
      updated = uniqueKey ? succeeded - inserted : 0;

      this.db.prepare(
        'UPDATE ds_collections SET record_count = ?, updated_at = ? WHERE name = ?'
      ).run(countAfter, now, collection);
    });

    transaction();

    return { inserted, updated, errors };
  }

  // === Query ===

  queryRecords(params: {
    collection: string;
    filter?: Record<string, unknown> | undefined;
    sort?: DataStoreSort[] | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    aggregate?: DataStoreAggregation | undefined;
    /**
     * The agent-facing path (data_store_query) sets this so `subject` columns are
     * NAME-facing: a name filter operand resolves name→id, and result cells
     * hydrate id→name. Default false → raw `subject_id`s (stable for programmatic
     * callers / joins). No-op when no bridge is wired (flag off — columns already
     * hold raw names, so plain string filter/display is correct).
     */
    subjectsByName?: boolean | undefined;
  }): { rows: Record<string, unknown>[]; total: number } {
    const { collection, filter, sort, aggregate } = params;
    const limit = Math.min(params.limit ?? 50, 500);
    const offset = params.offset ?? 0;

    const info = this._getCollectionMeta(collection);
    if (!info) {
      throw new Error(`Collection "${collection}" not found.`);
    }

    const columns = JSON.parse(info.schema_json) as DataStoreColumnDef[];
    const validColumns = new Set([...columns.map(c => c.name), '_id', '_created_at', '_updated_at']);
    const tableName = `ds_${collection}`;

    // Subject columns become name-facing ONLY in the agent path (subjectsByName)
    // AND only when a bridge is wired. Empty otherwise → the filter/display below
    // are pure pass-throughs (flag-off raw-name columns already behave correctly).
    const subjectCols = new Map<string, string>();
    if (params.subjectsByName && this._subjectBridge) {
      for (const c of columns) {
        if (c.type === 'subject') subjectCols.set(c.name, c.subjectKind ?? 'person');
      }
    }

    // A subject column stores UUIDs under the flag. SORTING by it can't be made
    // name-facing here: the name lives cross-DB in engine.db, so ordering would
    // need fetch-all-then-JS-sort and couldn't respect SQL LIMIT/OFFSET — reject
    // it (name-ordered sort is a later slice). GROUPING is fine: _queryAggregate
    // groups on the id, then hydrates the group-key cells id→name post-aggregate.
    if (subjectCols.size > 0) {
      const sortedSubject = sort?.find(s => subjectCols.has(s.field));
      if (sortedSubject) {
        throw new Error(`Cannot sort by subject column "${sortedSubject.field}" — its name lives in a separate store, so ordering can't respect the row limit. Filter or group by the subject name instead.`);
      }
    }

    // Build WHERE clause (resolving subject-column name operands → ids first)
    const effectiveFilter = filter && subjectCols.size > 0
      ? this._resolveSubjectFilterValues(filter, subjectCols)
      : filter;
    const { whereClause, whereParams } = this._buildWhere(effectiveFilter, validColumns);

    if (aggregate) {
      // Name-filter resolution flows into aggregates too. A subject group_by key
      // groups on the id, then its group-key cells hydrate id→name in _queryAggregate.
      return this._queryAggregate(tableName, aggregate, whereClause, whereParams, validColumns, sort, limit, offset, subjectCols);
    }

    // Count total
    const countSql = `SELECT COUNT(*) as cnt FROM "${tableName}"${whereClause}`;
    const countResult = this.db.prepare(countSql).get(...whereParams) as { cnt: number };

    // Build ORDER BY
    const orderClause = this._buildOrderBy(sort, validColumns);

    // Select
    const selectSql = `SELECT * FROM "${tableName}"${whereClause}${orderClause} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(selectSql).all(...whereParams, limit, offset) as Record<string, unknown>[];

    if (subjectCols.size > 0) this._hydrateSubjectNames(rows, subjectCols);

    return { rows, total: countResult.cnt };
  }

  /**
   * Record-on-spine R2b — the cross-DB read half of a subject's footprint. Gather
   * EVERY row, across every collection, that links `subjectId` through a
   * `subject`-typed column, each projected with its occurrence time: the
   * collection's `occurred_at`-marked date column (R2a), or `_created_at` as the
   * insert-time fallback when a collection declared none. Each collection's lookup
   * uses the R2a per-subject index (`idx_<len>_<coll>_<col>_subj`); results are
   * merge-sorted newest-first across collections and capped at `limit` (`truncated`
   * signals more exist — an honest partial, never a silent cut).
   *
   * id-keyed: the caller resolves a name → a subject_id ONCE (canonical + alias)
   * before calling. Rows written flag-OFF hold raw NAMES, not ids, so they simply
   * don't match a UUID — correct, not a bug. A single OR-query per collection folds
   * a row that links the subject through two columns into ONE occurrence (no dupes).
   */
  getRecordsForSubject(
    subjectId: string,
    opts?: { limit?: number | undefined },
  ): { occurrences: SubjectRecordOccurrence[]; truncated: boolean } {
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500));
    const collections = this.db
      .prepare('SELECT name, schema_json FROM ds_collections')
      .all() as Array<{ name: string; schema_json: string }>;

    const out: SubjectRecordOccurrence[] = [];
    let perCollectionCapped = false;

    for (const c of collections) {
      const columns = JSON.parse(c.schema_json) as DataStoreColumnDef[];
      const subjectCols = columns.filter(col => col.type === 'subject').map(col => col.name);
      if (subjectCols.length === 0) continue;

      const occurredAtCol = columns.find(col => col.role === 'occurred_at')?.name ?? null;
      // occurredAtCol / subjectCols / name all come from the stored schema — every
      // one has passed VALID_COLUMN_NAME_RE / COLLECTION_NAME_RE, so interpolating
      // them is SQL-safe (the same invariant the ukey + subject indexes rely on).
      // The subject id is a bound param. NULLIF(…, '') mirrors the JS projection
      // below (which treats an empty-string date as absent) so the ORDER BY + cap
      // rank a blank occurred_at by its `_created_at`, not as the oldest row.
      const timeExpr = occurredAtCol
        ? `COALESCE(NULLIF("${occurredAtCol}", ''), "_created_at")`
        : '"_created_at"';
      const whereOr = subjectCols.map(col => `"${col}" = ?`).join(' OR ');
      const tableName = `ds_${c.name}`;

      // Identifiers (tableName / column names in whereOr / timeExpr) are all
      // schema-validated; the subject id + limit are bound params. Built as a const
      // (not inlined into .prepare) to match the file's parameterized-query pattern.
      const selectSql = `SELECT * FROM "${tableName}" WHERE ${whereOr} ORDER BY ${timeExpr} DESC LIMIT ?`;
      const rows = this.db
        .prepare(selectSql)
        .all(...subjectCols.map(() => subjectId), limit + 1) as Record<string, unknown>[];

      if (rows.length > limit) {
        perCollectionCapped = true;
        rows.pop(); // drop the +1 probe row
      }

      for (const row of rows) {
        const matchedColumns = subjectCols.filter(col => row[col] === subjectId);
        const rawOccurred = occurredAtCol ? row[occurredAtCol] : null;
        const occurredAt = typeof rawOccurred === 'string' && rawOccurred !== '' ? rawOccurred : null;
        const createdAt = typeof row['_created_at'] === 'string' ? row['_created_at'] : null;
        out.push({
          collection: c.name,
          occurredAt: occurredAt ?? createdAt,
          occurredAtIsEventTime: occurredAt !== null,
          matchedColumns,
          row,
        });
      }
    }

    // Global merge-sort newest-first; a null occurrence time sorts last.
    out.sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''));
    const truncated = perCollectionCapped || out.length > limit;
    return { occurrences: out.slice(0, limit), truncated };
  }

  /**
   * Record-on-spine cross-DB repoint: when the subject graph MERGES a duplicate into a
   * canonical (SubjectStore.mergeSubjects, in engine.db), the subject_id cells this
   * store holds in `subject`-typed columns still point at the archived dup. Repoint them
   * all from `oldId` → `newId`, across every collection's every subject column, in one
   * transaction. Runs AFTER the engine.db merge commits (separate DBs, no shared txn);
   * a read that races the gap resolves forward via SubjectStore.resolveActiveSubject.
   *
   * Returns the before-image (per collection/column, the `_id`s changed) so the merge
   * rollback can reverse it via {@link rollbackRepoint}. Table + column names come from
   * the stored, name-validated schema (the getRecordsForSubject invariant); ids are bound.
   */
  repointSubjectId(oldId: string, newId: string): SubjectRepointRecord[] {
    const collections = this.db.prepare('SELECT name, schema_json FROM ds_collections').all() as Array<{ name: string; schema_json: string }>;
    const changed: SubjectRepointRecord[] = [];
    this.db.transaction(() => {
      for (const c of collections) {
        const columns = JSON.parse(c.schema_json) as DataStoreColumnDef[];
        const subjectCols = columns.filter(col => col.type === 'subject').map(col => col.name);
        if (subjectCols.length === 0) continue;
        const tableName = `ds_${c.name}`;
        for (const col of subjectCols) {
          // Identifiers (tableName / col) are schema-validated (the getRecordsForSubject
          // invariant); id values are bound params. Built as consts, like the rest of
          // this file, so the parameterized-query lint stays green.
          const selectIdsSql = `SELECT _id FROM "${tableName}" WHERE "${col}" = ?`;
          const ids = (this.db.prepare(selectIdsSql).all(oldId) as Array<{ _id: number }>).map(r => r._id);
          if (ids.length === 0) continue;
          const updateSql = `UPDATE "${tableName}" SET "${col}" = ? WHERE "${col}" = ?`;
          this.db.prepare(updateSql).run(newId, oldId);
          changed.push({ collection: c.name, column: col, ids });
        }
      }
    })();
    return changed;
  }

  /** Reverse a {@link repointSubjectId} (merge rollback): move each captured cell back to `oldId`. */
  rollbackRepoint(oldId: string, newId: string, records: readonly SubjectRepointRecord[]): void {
    this.db.transaction(() => {
      for (const rec of records) {
        const tableName = `ds_${rec.collection}`;
        // Same validated-identifier / bound-value split as repointSubjectId.
        const updateSql = `UPDATE "${tableName}" SET "${rec.column}" = ? WHERE _id = ? AND "${rec.column}" = ?`;
        const stmt = this.db.prepare(updateSql);
        for (const id of rec.ids) stmt.run(oldId, id, newId);
      }
    })();
  }

  // === Collection Info ===

  listCollections(): DataStoreCollectionInfo[] {
    const rows = this.db.prepare('SELECT * FROM ds_collections ORDER BY updated_at DESC').all() as Array<{
      name: string;
      scope_type: string;
      scope_id: string;
      schema_json: string;
      unique_key: string | null;
      record_count: number;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map(r => ({
      name: r.name,
      scopeType: r.scope_type,
      scopeId: r.scope_id,
      columns: JSON.parse(r.schema_json) as DataStoreColumnDef[],
      uniqueKey: r.unique_key ? r.unique_key.split(',') : null,
      recordCount: r.record_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  getCollectionInfo(name: string): DataStoreCollectionInfo | null {
    const meta = this._getCollectionMeta(name);
    if (!meta) return null;

    return {
      name: meta.name,
      scopeType: meta.scope_type,
      scopeId: meta.scope_id,
      columns: JSON.parse(meta.schema_json) as DataStoreColumnDef[],
      uniqueKey: meta.unique_key ? meta.unique_key.split(',') : null,
      recordCount: meta.record_count,
      createdAt: meta.created_at,
      updatedAt: meta.updated_at,
    };
  }

  alterCollection(params: {
    collection: string;
    addColumns: DataStoreColumnDef[];
  }): DataStoreCollectionInfo {
    const { collection, addColumns } = params;

    const info = this._getCollectionMeta(collection);
    if (!info) {
      throw new Error(`Collection "${collection}" not found.`);
    }
    this._checkDbSize();

    const existing = JSON.parse(info.schema_json) as DataStoreColumnDef[];
    const existingNames = new Set(existing.map(c => c.name));

    if (existing.length + addColumns.length > MAX_COLUMNS) {
      throw new Error(`Would exceed ${MAX_COLUMNS} column limit.`);
    }

    // The occurred_at cardinality is per-collection — validate the merged set so a
    // second occurrence column added later is rejected against the existing one.
    this._validateOccurredAtRole([...existing, ...addColumns]);

    const tableName = `ds_${collection}`;
    const now = new Date().toISOString();

    const transaction = this.db.transaction(() => {
      for (const col of addColumns) {
        if (!VALID_COLUMN_NAME_RE.test(col.name)) {
          throw new Error(`Column name "${col.name}" is not valid. Use lowercase letters, numbers, and underscores only.`);
        }
        if (SYSTEM_COLUMNS.has(col.name)) {
          throw new Error(`Column name "${col.name}" is reserved.`);
        }
        if (existingNames.has(col.name)) {
          throw new Error(`Column "${col.name}" already exists.`);
        }
        if (!(col.type in TYPE_MAP)) {
          throw new Error(`Invalid column type "${col.type}".`);
        }

        const sqlType = TYPE_MAP[col.type];
        this.db.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${col.name}" ${sqlType}`);
        existingNames.add(col.name);
      }

      // Index any newly-added subject column (mirrors createCollection).
      this._createSubjectIndexes(collection, tableName, addColumns);

      const updatedSchema = [...existing, ...addColumns];
      this.db.prepare(
        'UPDATE ds_collections SET schema_json = ?, updated_at = ? WHERE name = ?'
      ).run(JSON.stringify(updatedSchema), now, collection);
    });

    transaction();

    const updatedSchema = [...existing, ...addColumns];
    return {
      name: collection,
      scopeType: info.scope_type,
      scopeId: info.scope_id,
      columns: updatedSchema,
      uniqueKey: info.unique_key ? info.unique_key.split(',') : null,
      recordCount: info.record_count,
      createdAt: info.created_at,
      updatedAt: now,
    };
  }

  deleteRecords(params: {
    collection: string;
    filter: Record<string, unknown>;
  }): number {
    const { collection, filter } = params;

    const info = this._getCollectionMeta(collection);
    if (!info) {
      throw new Error(`Collection "${collection}" not found.`);
    }

    const columns = JSON.parse(info.schema_json) as DataStoreColumnDef[];
    const validColumns = new Set([...columns.map(c => c.name), '_id', '_created_at', '_updated_at']);
    const tableName = `ds_${collection}`;

    const { whereClause, whereParams } = this._buildWhere(filter, validColumns);
    if (!whereClause) {
      throw new Error('A filter is required for delete operations. Use dropCollection() to remove all records.');
    }

    const countBefore = (this.db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`).get() as { cnt: number }).cnt;

    this.db.prepare(`DELETE FROM "${tableName}"${whereClause}`).run(...whereParams);

    const countAfter = (this.db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`).get() as { cnt: number }).cnt;
    const deleted = countBefore - countAfter;

    // Update meta
    if (deleted > 0) {
      const now = new Date().toISOString();
      this.db.prepare(
        'UPDATE ds_collections SET record_count = ?, updated_at = ? WHERE name = ?',
      ).run(countAfter, now, collection);
    }

    return deleted;
  }

  dropCollection(name: string): boolean {
    const info = this._getCollectionMeta(name);
    if (!info) return false;

    const tableName = `ds_${name}`;
    const transaction = this.db.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
      this.db.prepare('DELETE FROM ds_collections WHERE name = ?').run(name);
    });

    transaction();
    return true;
  }

  /**
   * One-shot at engine startup: drop empty CRM-shaped collections (see
   * `CRM_OVERLAP_NAMES`) that the agent left behind in older sessions.
   * Returns the dropped names so callers can log. Non-empty collections are
   * preserved — they may hold legitimate user data.
   */
  dropEmptyCrmOverlaps(): string[] {
    const dropped: string[] = [];
    const rows = this.db.prepare('SELECT name, record_count FROM ds_collections').all() as Array<{ name: string; record_count: number }>;
    for (const r of rows) {
      if (CRM_OVERLAP_NAMES.has(r.name) && r.record_count === 0) {
        if (this.dropCollection(r.name)) dropped.push(r.name);
      }
    }
    return dropped;
  }

  close(): void {
    this.db.close();
  }

  // === Private Helpers ===

  private _getCollectionMeta(name: string): {
    name: string;
    scope_type: string;
    scope_id: string;
    schema_json: string;
    unique_key: string | null;
    record_count: number;
    created_at: string;
    updated_at: string;
  } | undefined {
    return this.db.prepare('SELECT * FROM ds_collections WHERE name = ?').get(name) as {
      name: string;
      scope_type: string;
      scope_id: string;
      schema_json: string;
      unique_key: string | null;
      record_count: number;
      created_at: string;
      updated_at: string;
    } | undefined;
  }

  private _coerceValue(val: unknown, col: DataStoreColumnDef): unknown {
    const colName = col.name;
    switch (col.type) {
      case 'string':
        return String(val);
      case 'number': {
        const n = Number(val);
        if (Number.isNaN(n)) {
          throw new Error(`Column "${colName}": cannot convert "${String(val)}" to number.`);
        }
        return n;
      }
      case 'date':
        if (typeof val === 'string') return val;
        throw new Error(`Column "${colName}": expected date string, got ${typeof val}.`);
      case 'boolean':
        if (typeof val === 'boolean') return val ? 1 : 0;
        if (val === 1 || val === 0) return val;
        if (val === 'true') return 1;
        if (val === 'false') return 0;
        throw new Error(`Column "${colName}": cannot convert "${String(val)}" to boolean.`);
      case 'json':
        return typeof val === 'string' ? val : JSON.stringify(val);
      case 'subject': {
        // Resolve the row's name → a real subject_id via the injected resolver.
        // No resolver at all (flag off) → degrade to storing the raw string, so
        // the column stays human-readable and DataStore works without the graph.
        // A resolver that's present but returns null (a resolve FAILURE, distinct
        // from flag-off) → store null (unlinked), NOT the raw name: keep the
        // column id-pure so it never mixes names and UUIDs. The kind is part of
        // dedup identity; `?? 'person'` is a defensive internal floor — the tool
        // contract already REQUIRES a valid subjectKind on any subject column.
        const raw = String(val).trim();
        if (raw === '') return null;
        if (!this._subjectBridge) return raw;
        const kind = col.subjectKind ?? 'person';
        return this._subjectBridge.resolve(raw, kind) ?? null;
      }
      default:
        return val;
    }
  }

  private _buildWhere(
    filter: Record<string, unknown> | undefined,
    validColumns: Set<string>,
  ): { whereClause: string; whereParams: unknown[] } {
    if (!filter || Object.keys(filter).length === 0) {
      return { whereClause: '', whereParams: [] };
    }

    const { clause, params } = this._parseFilter(filter, validColumns);
    return { whereClause: ` WHERE ${clause}`, whereParams: params };
  }

  private _parseFilter(
    filter: Record<string, unknown>,
    validColumns: Set<string>,
  ): { clause: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (key === '$or') {
        if (!Array.isArray(value)) {
          throw new Error('$or must be an array.');
        }
        const orClauses: string[] = [];
        for (const sub of value) {
          if (typeof sub !== 'object' || sub === null) {
            throw new Error('$or elements must be objects.');
          }
          const result = this._parseFilter(sub as Record<string, unknown>, validColumns);
          orClauses.push(result.clause);
          params.push(...result.params);
        }
        clauses.push(`(${orClauses.join(' OR ')})`);
        continue;
      }

      if (key === '$and') {
        if (!Array.isArray(value)) {
          throw new Error('$and must be an array.');
        }
        const andClauses: string[] = [];
        for (const sub of value) {
          if (typeof sub !== 'object' || sub === null) {
            throw new Error('$and elements must be objects.');
          }
          const result = this._parseFilter(sub as Record<string, unknown>, validColumns);
          andClauses.push(result.clause);
          params.push(...result.params);
        }
        clauses.push(`(${andClauses.join(' AND ')})`);
        continue;
      }

      // Regular field filter
      if (!validColumns.has(key)) {
        throw new Error(`No column named "${key}" in this table. Check the table schema with data_store_list.`);
      }

      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        // Simple equality
        if (value === null) {
          clauses.push(`"${key}" IS NULL`);
        } else {
          clauses.push(`"${key}" = ?`);
          params.push(value);
        }
      } else {
        // Operator object
        const ops = value as Record<string, unknown>;
        for (const [op, opVal] of Object.entries(ops)) {
          if (!VALID_OPERATORS.has(op)) {
            throw new Error(`Filter operator "${op}" is not recognized. Use: $eq (equals), $neq (not equals), $gt (greater), $lt (less), $gte, $lte, $in (in list), $nin, $like (contains), $is_null.`);
          }

          switch (op) {
            case '$eq':
              if (opVal === null) {
                clauses.push(`"${key}" IS NULL`);
              } else {
                clauses.push(`"${key}" = ?`);
                params.push(opVal);
              }
              break;
            case '$neq':
              if (opVal === null) {
                clauses.push(`"${key}" IS NOT NULL`);
              } else {
                clauses.push(`"${key}" != ?`);
                params.push(opVal);
              }
              break;
            case '$gt':
              clauses.push(`"${key}" > ?`);
              params.push(opVal);
              break;
            case '$gte':
              clauses.push(`"${key}" >= ?`);
              params.push(opVal);
              break;
            case '$lt':
              clauses.push(`"${key}" < ?`);
              params.push(opVal);
              break;
            case '$lte':
              clauses.push(`"${key}" <= ?`);
              params.push(opVal);
              break;
            case '$in':
              if (!Array.isArray(opVal) || opVal.length === 0) {
                throw new Error('$in requires a non-empty array.');
              }
              clauses.push(`"${key}" IN (${opVal.map(() => '?').join(', ')})`);
              params.push(...opVal);
              break;
            case '$nin':
              if (!Array.isArray(opVal) || opVal.length === 0) {
                throw new Error('$nin requires a non-empty array.');
              }
              clauses.push(`"${key}" NOT IN (${opVal.map(() => '?').join(', ')})`);
              params.push(...opVal);
              break;
            case '$like':
              clauses.push(`"${key}" LIKE ?`);
              params.push(opVal);
              break;
            case '$is_null':
              if (opVal === true) {
                clauses.push(`"${key}" IS NULL`);
              } else {
                clauses.push(`"${key}" IS NOT NULL`);
              }
              break;
          }
        }
      }
    }

    return { clause: clauses.join(' AND '), params };
  }

  /**
   * Translate name operands → subject_ids for the subject-typed columns of a
   * filter, recursively (mirrors `_parseFilter`'s $or/$and recursion). Only the
   * exact-identity operators make sense on a subject link: $eq / implicit-eq,
   * $neq, $in/$nin resolve each name via the bridge (an unresolvable name →
   * {@link UNRESOLVABLE_SUBJECT}, which matches no id → 0 rows, keeping the
   * parameterized clause). $is_null passes through (linked/unlinked is valid);
   * $like and the range operators are rejected (a UUID identity is not a
   * text/range match). Non-subject keys pass through untouched. Returns a NEW
   * filter object — never mutates the caller's.
   */
  private _resolveSubjectFilterValues(
    filter: Record<string, unknown>,
    subjectCols: Map<string, string>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filter)) {
      if (key === '$or' || key === '$and') {
        out[key] = Array.isArray(value)
          ? value.map(sub =>
              sub && typeof sub === 'object' && !Array.isArray(sub)
                ? this._resolveSubjectFilterValues(sub as Record<string, unknown>, subjectCols)
                : sub)
          : value; // malformed → let _parseFilter throw the canonical error
        continue;
      }
      const kind = subjectCols.get(key);
      out[key] = kind === undefined ? value : this._resolveSubjectOperand(key, value, kind);
    }
    return out;
  }

  private _resolveSubjectOperand(colName: string, value: unknown, kind: string): unknown {
    const bridge = this._subjectBridge;
    if (!bridge) return value;
    const toId = (name: unknown): unknown => {
      if (typeof name !== 'string') return name;
      const trimmed = name.trim();
      if (trimmed === '') return UNRESOLVABLE_SUBJECT;
      return bridge.find(trimmed, kind) ?? UNRESOLVABLE_SUBJECT;
    };
    // implicit-eq by name
    if (typeof value === 'string') return toId(value);
    // null (is-null) / arrays / non-operator scalars pass through unchanged
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    // operator object
    const out: Record<string, unknown> = {};
    for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
      switch (op) {
        case '$eq':
        case '$neq':
          out[op] = opVal === null ? opVal : toId(opVal);
          break;
        case '$in':
        case '$nin':
          out[op] = Array.isArray(opVal) ? opVal.map(toId) : opVal;
          break;
        case '$is_null':
          out[op] = opVal;
          break;
        case '$like':
        case '$gt':
        case '$gte':
        case '$lt':
        case '$lte':
          throw new Error(`Column "${colName}" links to a subject — filter it by the exact linked name (e.g. { "${colName}": "Anna Meier" }) or a name list ($in), not ${op}.`);
        default:
          out[op] = opVal; // unknown operator → _parseFilter throws the canonical error
      }
    }
    return out;
  }

  /**
   * Create a non-unique secondary index on every subject column so a per-subject
   * FILTER (`WHERE "<col>" = <id>`) uses the index instead of scanning the table.
   * The index is on the stored value (a UUID under the flag) — it speeds equality/
   * IN filters, NOT name-ordered sort (the name lives cross-DB in engine.db).
   *
   * SECURITY: `collectionName`/`tableName`/`col.name` are constrained to
   * `[a-z][a-z0-9_]{0,62}` (COLLECTION_NAME_RE / VALID_COLUMN_NAME_RE) before this
   * runs — the same SQL-safety invariant as the ukey index.
   *
   * NAME UNIQUENESS: SQLite index names are database-GLOBAL, and both the collection
   * and column parts can contain `_`, so a bare `<coll>_<col>` join is ambiguous —
   * collection `a_b`+col `c` and collection `a`+col `b_c` would both mint the same
   * name and the second create/alter would wrongly throw "index already exists".
   * Length-prefixing the collection makes the encoding injective; the leading digit
   * also keeps these disjoint from `idx_<coll>_ukey` (which starts with a letter).
   */
  private _createSubjectIndexes(
    collectionName: string,
    tableName: string,
    columns: DataStoreColumnDef[],
  ): void {
    for (const col of columns) {
      if (col.type === 'subject') {
        this.db.exec(
          `CREATE INDEX "idx_${String(collectionName.length)}_${collectionName}_${col.name}_subj" ON "${tableName}" ("${col.name}")`,
        );
      }
    }
  }

  /**
   * A collection may mark at most ONE `date` column as its occurrence time
   * (`role: 'occurred_at'`). Enforced over the full column set (create) or the
   * merged existing+added set (alter) so the cardinality is per-collection.
   */
  private _validateOccurredAtRole(columns: DataStoreColumnDef[]): void {
    let occurredAt = 0;
    for (const col of columns) {
      if (col.role === 'occurred_at') {
        if (col.type !== 'date') {
          throw new Error(`Column "${col.name}" has role "occurred_at" but type "${col.type}". Only a "date" column can mark when a record occurred.`);
        }
        occurredAt++;
      }
    }
    if (occurredAt > 1) {
      throw new Error('A collection may mark at most one "occurred_at" column (the single event time).');
    }
  }

  /**
   * Replace each subject-column cell (a `subject_id`) with its display name for
   * the agent-facing result. Distinct ids resolve once (cache). A stale/purged id
   * the bridge can't name falls back to the raw id — the value is never dropped.
   */
  private _hydrateSubjectNames(
    rows: Record<string, unknown>[],
    subjectCols: Map<string, string>,
  ): void {
    const bridge = this._subjectBridge;
    if (!bridge) return;
    const cache = new Map<string, string>();
    for (const colName of subjectCols.keys()) {
      for (const row of rows) {
        const id = row[colName];
        if (typeof id !== 'string' || id === '') continue;
        let display = cache.get(id);
        if (display === undefined) {
          display = bridge.name(id) ?? id;
          cache.set(id, display);
        }
        row[colName] = display;
      }
    }
  }

  private _buildOrderBy(
    sort: DataStoreSort[] | undefined,
    validColumns: Set<string>,
  ): string {
    if (!sort || sort.length === 0) return '';

    const parts: string[] = [];
    for (const s of sort) {
      if (!validColumns.has(s.field)) {
        throw new Error(`Cannot sort by "${s.field}" — no such column in this table.`);
      }
      const dir = s.order === 'desc' ? 'DESC' : 'ASC';
      parts.push(`"${s.field}" ${dir}`);
    }
    return ` ORDER BY ${parts.join(', ')}`;
  }

  private _queryAggregate(
    tableName: string,
    aggregate: DataStoreAggregation,
    whereClause: string,
    whereParams: unknown[],
    validColumns: Set<string>,
    sort: DataStoreSort[] | undefined,
    limit: number,
    offset: number,
    subjectCols: Map<string, string>,
  ): { rows: Record<string, unknown>[]; total: number } {
    const selectParts: string[] = [];
    const groupBy = aggregate.groupBy ?? [];

    // Validate groupBy columns
    for (const col of groupBy) {
      if (!validColumns.has(col)) {
        throw new Error(`Cannot group by "${col}" — no such column in this table.`);
      }
      selectParts.push(`"${col}"`);
    }

    // Build metric expressions
    for (const metric of aggregate.metrics) {
      if (!VALID_AGG_FNS.has(metric.fn)) {
        throw new Error(`Aggregation "${metric.fn}" is not supported. Use: ${[...VALID_AGG_FNS].join(', ')}.`);
      }
      // Validate the field for EVERY case where it is interpolated raw into the
      // SELECT — only `COUNT(*)` interpolates no field. This also closes the
      // `count` + non-`*` field gap the old `fn !== 'count'` guard skipped.
      const isCountStar = metric.fn === 'count' && metric.field === '*';
      if (!isCountStar && !validColumns.has(metric.field)) {
        throw new Error(`Cannot compute metric on "${metric.field}" — no such column in this table.`);
      }
      // A user-supplied alias is interpolated into `... as "${alias}"`; without
      // validation a `"`-bearing alias would break out of the quoted identifier.
      // Constrain it to the same identifier grammar as column names.
      if (metric.alias !== undefined && !VALID_COLUMN_NAME_RE.test(metric.alias)) {
        throw new Error(`Aggregation alias "${metric.alias}" is not valid. Use lowercase letters, numbers, and underscores only (e.g., "total_revenue").`);
      }
      const alias = metric.alias ?? `${metric.fn}_${metric.field}`;
      if (metric.fn === 'count' && metric.field === '*') {
        selectParts.push(`COUNT(*) as "${alias}"`);
      } else if (metric.fn === 'count_distinct') {
        selectParts.push(`COUNT(DISTINCT "${metric.field}") as "${alias}"`);
      } else {
        selectParts.push(`${metric.fn.toUpperCase()}("${metric.field}") as "${alias}"`);
      }
    }

    const groupClause = groupBy.length > 0
      ? ` GROUP BY ${groupBy.map(c => `"${c}"`).join(', ')}`
      : '';

    // For aggregation, count total groups. A NON-grouped aggregate always
    // collapses to exactly one row, so skip the count query: running the
    // paramless `SELECT 1 as cnt` with the WHERE-clause bind params (which it
    // has no placeholders for) throws `RangeError: Too many parameter values`.
    // Only the grouped case needs a real count-of-groups query.
    const total = groupBy.length > 0
      ? (this.db.prepare(
          `SELECT COUNT(*) as cnt FROM (SELECT 1 FROM "${tableName}"${whereClause}${groupClause})`,
        ).get(...whereParams) as { cnt: number }).cnt
      : 1;

    // Build valid columns for sort (includes aliases)
    const aggValidCols = new Set(validColumns);
    for (const metric of aggregate.metrics) {
      const alias = metric.alias ?? `${metric.fn}_${metric.field}`;
      aggValidCols.add(alias);
    }
    const orderClause = this._buildOrderBy(sort, aggValidCols);

    const sql = `SELECT ${selectParts.join(', ')} FROM "${tableName}"${whereClause}${groupClause}${orderClause} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...whereParams, limit, offset) as Record<string, unknown>[];

    // Grouping runs on the stored subject_id; hydrate the group-key cells id→name
    // so the agent sees `{ client: "Acme GmbH", n: 3 }`, not a UUID key. Pagination/
    // order stay on the id (name-ordered group sort is the fenced cross-DB case).
    if (subjectCols.size > 0) {
      const groupedSubjectCols = new Map(
        [...subjectCols].filter(([name]) => groupBy.includes(name)),
      );
      if (groupedSubjectCols.size > 0) this._hydrateSubjectNames(rows, groupedSubjectCols);
    }

    return { rows, total };
  }
}
