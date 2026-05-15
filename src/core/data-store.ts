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

const TYPE_MAP: Record<DataStoreSchemaType, string> = {
  string: 'TEXT',
  number: 'REAL',
  date: 'TEXT',
  boolean: 'INTEGER',
  json: 'TEXT',
};

const VALID_OPERATORS = new Set([
  '$eq', '$neq', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$like', '$is_null',
]);

const VALID_AGG_FNS = new Set<DataStoreAggFn>([
  'sum', 'avg', 'min', 'max', 'count', 'count_distinct',
]);

// === DataStore ===

export class DataStore {
  private db: Database.Database;

  constructor(dbPath?: string | undefined) {
    const path = dbPath ?? join(getLynoxDir(), 'datastore.db');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._initMeta();
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
    const colTypeMap = new Map(columns.map(c => [c.name, c.type]));
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
            const colType = colTypeMap.get(col)!;
            values.push(this._coerceValue(val, colType, col));
          }

          // Warn about unknown fields (but don't error)
          for (const key of Object.keys(record)) {
            if (!colNames.has(key)) {
              errors.push(`Record ${i}: unknown field "${key}" ignored.`);
            }
          }

          stmt.run(...values);
        } catch (err) {
          errors.push(`Record ${i}: ${getErrorMessage(err)}`);
        }
      }

      // Update record count + timestamp in meta
      const countAfter = (this.db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`).get() as { cnt: number }).cnt;
      inserted = countAfter - countBefore;
      // For upsert: successful ops minus new rows = updates
      const totalOps = records.length - errors.length;
      updated = uniqueKey ? totalOps - inserted : 0;

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

    // Build WHERE clause
    const { whereClause, whereParams } = this._buildWhere(filter, validColumns);

    if (aggregate) {
      return this._queryAggregate(tableName, aggregate, whereClause, whereParams, validColumns, sort, limit, offset);
    }

    // Count total
    const countSql = `SELECT COUNT(*) as cnt FROM "${tableName}"${whereClause}`;
    const countResult = this.db.prepare(countSql).get(...whereParams) as { cnt: number };

    // Build ORDER BY
    const orderClause = this._buildOrderBy(sort, validColumns);

    // Select
    const selectSql = `SELECT * FROM "${tableName}"${whereClause}${orderClause} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(selectSql).all(...whereParams, limit, offset) as Record<string, unknown>[];

    return { rows, total: countResult.cnt };
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

  private _coerceValue(val: unknown, type: DataStoreSchemaType, colName: string): unknown {
    switch (type) {
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
      if (metric.fn !== 'count' && !validColumns.has(metric.field)) {
        throw new Error(`Cannot compute metric on "${metric.field}" — no such column in this table.`);
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

    // For aggregation, count total groups
    const countSql = groupBy.length > 0
      ? `SELECT COUNT(*) as cnt FROM (SELECT 1 FROM "${tableName}"${whereClause}${groupClause})`
      : `SELECT 1 as cnt`;
    const countResult = this.db.prepare(countSql).get(...whereParams) as { cnt: number };

    // Build valid columns for sort (includes aliases)
    const aggValidCols = new Set(validColumns);
    for (const metric of aggregate.metrics) {
      const alias = metric.alias ?? `${metric.fn}_${metric.field}`;
      aggValidCols.add(alias);
    }
    const orderClause = this._buildOrderBy(sort, aggValidCols);

    const sql = `SELECT ${selectParts.join(', ')} FROM "${tableName}"${whereClause}${groupClause}${orderClause} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...whereParams, limit, offset) as Record<string, unknown>[];

    return { rows, total: countResult.cnt };
  }
}
