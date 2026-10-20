import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getLynoxDir } from './config.js';
import { getErrorMessage } from './utils.js';
import { SQLITE_BUSY_TIMEOUT_MS, scrubFreedPages, zeroDeletedContent } from './sqlite-constants.js';
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
import type { CollectionShape } from './crm-schema.js';
import { UNKNOWN_GRANT } from './conversation-grants.js';
import type { IAgent } from '../types/agent.js';

// === Constants ===

const COLLECTION_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED_NAMES = new Set(['meta', 'collections', 'schema_version', 'sqlite_master']);

/**
 * Collection names that conceptually overlap with the dedicated CRM subsystem
 * (people/companies/deals/interactions live in `crm.ts` with a typed schema).
 * The agent has historically created empty DataStore collections under these
 * names — they then show up in the UI alongside the real CRM tab and confuse
 * the user. Empty collections matching this set are dropped on every engine
 * boot unless they have the CRM's current shape (see `dropEmptyCrmOverlaps`),
 * and the web UI filters out any that survive (belt-and-suspenders). Non-empty
 * collections are preserved — a power user may have a legitimate "contacts" table.
 */
export const CRM_OVERLAP_NAMES: ReadonlySet<string> = new Set([
  'contacts', 'companies', 'people', 'deals', 'interactions',
]);
const MAX_COLLECTIONS = 100;
const MAX_COLUMNS = 50;
const MAX_RECORDS = 100_000;
/**
 * The largest page {@link DataStore.listRecordsForExport} returns. Exported for the
 * same reason as the thread store's `EXPORT_PAGE_MAX`: a walk stops on a SHORT page,
 * so a caller asking for more than this would stop after the first one.
 */
export const RECORD_EXPORT_PAGE_MAX = 500;
const MAX_INSERT_BATCH = 1000;
const MAX_DB_SIZE_BYTES = 500 * 1024 * 1024;
const VALID_COLUMN_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
/** The system columns a reader sees and a filter, sort or aggregate may name. */
const VISIBLE_META_COLUMNS = ['_id', '_created_at', '_updated_at'] as const;
/**
 * The two columns that say where a row's content came from (PRD connection-attribution
 * A5): `_source_grants`, a JSON array of the grant ids the writing conversation held
 * (`unknown` among them when it read something no grant names), and `_source_run_id`,
 * the run that wrote it last. NULL in both is a row from before the columns existed.
 * No read method but the export returns them, and no filter may name them.
 */
export const SOURCE_COLUMNS = ['_source_grants', '_source_run_id'] as const;
/** Every column the store writes itself. No user column may take one of these names. */
export const SYSTEM_COLUMNS: ReadonlySet<string> = new Set<string>([...VISIBLE_META_COLUMNS, ...SOURCE_COLUMNS]);

/**
 * What a write records about its own source. `grants` is the writing agent's
 * conversation grant set (`ConversationGrants.members()`); `null` means the writer holds
 * no set at all, which is stored as `["unknown"]`, not as the empty set: an empty set
 * says "nothing was resolved", a missing one says nothing. `runId` is the writing run.
 */
export interface RowStamp {
  grants: readonly string[] | null;
  runId: string | null;
}

/**
 * The stamp of a write an agent makes: its conversation grant set, which a pipeline step
 * and a sub-agent share with the conversation that started them, and its run.
 */
export function rowStampOf(agent: Pick<IAgent, 'conversationGrants' | 'currentRunId'>): RowStamp {
  return { grants: agent.conversationGrants?.members() ?? null, runId: agent.currentRunId ?? null };
}

/** The two bound values of a stamp. Read before any write starts, so a missing stamp throws. */
function stampValues(stamp: RowStamp): [string, string | null] {
  const grants = stamp.grants === null ? [UNKNOWN_GRANT] : [...new Set(stamp.grants)].sort();
  return [JSON.stringify(grants), stamp.runId];
}

/**
 * The upsert's SET term for `_source_grants`: the union of the stored set and the new
 * one, in one statement, so two writers cannot lose each other's members. NULL and `[]`
 * both read as unknown (A5), so each side becomes `["unknown"]` before the union.
 * Otherwise a row from before the columns, updated by a conversation that resolved A,
 * would read as A alone.
 */
function sourceGrantsUnion(tableName: string): string {
  const unknown = JSON.stringify([UNKNOWN_GRANT]);
  const norm = (ref: string): string => `CASE WHEN ${ref} IS NULL OR ${ref} = '[]' THEN '${unknown}' ELSE ${ref} END`;
  return `"_source_grants" = (SELECT json_group_array(value ORDER BY value) FROM (`
    + `SELECT value FROM json_each(${norm(`"${tableName}"."_source_grants"`)}) `
    + `UNION SELECT value FROM json_each(${norm('excluded."_source_grants"')})))`;
}

/** Why a merge rollback refused a data-store record: {@link DataStore.repointRecordState} said `foreign`. */
export const FOREIGN_REPOINT_RECORD_REASON = 'the merge ledger names a column that is not a subject column of this data store — nothing was changed';

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

/**
 * The value a column would store for `val`, for every column type that converts
 * without side effects — i.e. all but `subject`, whose conversion finds-or-creates a
 * subject and so WRITES. Shared by insert and by the bulk dry run, which must predict
 * the stored value without writing anything; a `subject` column is refused by the
 * caller rather than passed here.
 */
export function coercePlainColumnValue(val: unknown, col: DataStoreColumnDef): unknown {
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
    default:
      return val;
  }
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

  /** Collections whose table is known to carry both {@link SOURCE_COLUMNS}. */
  private readonly _sourceReady = new Set<string>();

  constructor(dbPath?: string | undefined) {
    const path = dbPath ?? join(getLynoxDir(), 'datastore.db');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // Absorb transient cross-process lock contention — the operator subject-sweep
    // repoints datastore.db cells while the live engine may hold the connection —
    // instead of throwing an instant SQLITE_BUSY.
    this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    this.db.pragma('journal_mode = WAL');
    zeroDeletedContent(this.db);
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

  /**
   * Adds {@link SOURCE_COLUMNS} to every collection table that lacks them; existing rows
   * keep NULL. Called once by the engine at boot, never by the constructor: the operator
   * scripts open a tenant's live store to report on it and must not change its schema.
   *
   * Each collection migrates in its own IMMEDIATE transaction and re-reads its columns
   * under that write lock, so a second process migrating the same file finds the columns
   * and adds nothing. A collection that cannot be migrated is reported, never thrown: the
   * other collections keep working, and a write into the failed one throws (see
   * {@link _assertSourceColumns}). A `ds_collections` row without its table is reported
   * as missing.
   */
  ensureSourceColumns(): { migrated: string[]; missing: string[]; failed: Array<{ collection: string; error: string }> } {
    const migrated: string[] = [];
    const missing: string[] = [];
    const failed: Array<{ collection: string; error: string }> = [];
    const names = (this.db.prepare('SELECT name FROM ds_collections').all() as Array<{ name: string }>).map(r => r.name);
    for (const name of names) {
      const tableName = `ds_${name}`;
      try {
        const outcome = this.db.transaction((): 'migrated' | 'present' | 'missing' => {
          const cols = this.db.prepare('SELECT name FROM pragma_table_info(?)').all(tableName) as Array<{ name: string }>;
          if (cols.length === 0) return 'missing';
          const have = new Set(cols.map(c => c.name));
          let added = false;
          for (const col of SOURCE_COLUMNS) {
            if (have.has(col)) continue;
            // Identifiers: `name` passed COLLECTION_NAME_RE when the collection was created,
            // and the column names are the constant above.
            this.db.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${col}" TEXT`);
            added = true;
          }
          return added ? 'migrated' : 'present';
        }).immediate();
        if (outcome === 'missing') { missing.push(name); continue; }
        this._sourceReady.add(name);
        if (outcome === 'migrated') migrated.push(name);
      } catch (err) {
        failed.push({ collection: name, error: getErrorMessage(err) });
      }
    }
    return { migrated, missing, failed };
  }

  /** Throws unless the collection's table carries both {@link SOURCE_COLUMNS}. */
  private _assertSourceColumns(collection: string): void {
    if (this._sourceReady.has(collection)) return;
    const cols = this.db.prepare('SELECT name FROM pragma_table_info(?)').all(`ds_${collection}`) as Array<{ name: string }>;
    if (cols.length === 0) throw new Error(`Table "${collection}" is listed but has no data.`);
    const have = new Set(cols.map(c => c.name));
    if (!SOURCE_COLUMNS.every(c => have.has(c))) {
      throw new Error(`Table "${collection}" has not been migrated to record where its rows come from, so nothing can be written to it. Restart lynox to migrate it.`);
    }
    this._sourceReady.add(collection);
  }

  /** The columns every row read returns: the visible system columns and the user columns, never {@link SOURCE_COLUMNS}. */
  private _visibleColumnList(columns: readonly DataStoreColumnDef[]): string {
    return [...VISIBLE_META_COLUMNS, ...columns.map(c => c.name)].map(c => `"${c}"`).join(', ');
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
      '_source_grants TEXT',
      '_source_run_id TEXT',
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
    this._sourceReady.add(name);

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
    /** Where these records come from. Every row gets it; an upsert unions the grants. */
    stamp: RowStamp;
  }): { inserted: number; updated: number; errors: string[] } {
    const { collection, records } = params;
    // Before anything else and outside the per-record catch below, so a caller that
    // passes no stamp gets an error rather than a warning per skipped record.
    const [sourceGrants, sourceRunId] = stampValues(params.stamp);

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
    this._assertSourceColumns(collection);

    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    const errors: string[] = [];

    const userCols = columns.map(c => c.name);
    const allCols = ['_created_at', '_updated_at', ...SOURCE_COLUMNS, ...userCols];
    const placeholders = allCols.map(() => '?').join(', ');
    const colList = allCols.map(c => `"${c}"`).join(', ');

    let sql: string;
    if (uniqueKey && uniqueKey.length > 0) {
      const keyCols = uniqueKey.map(k => `"${k}"`).join(', ');
      const updateCols = userCols
        .filter(c => !uniqueKey.includes(c))
        .map(c => `"${c}" = excluded."${c}"`);
      const updateSet = [...updateCols, '"_updated_at" = excluded."_updated_at"',
        sourceGrantsUnion(tableName), '"_source_run_id" = excluded."_source_run_id"'].join(', ');
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
          const values: unknown[] = [now, now, sourceGrants, sourceRunId];
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

  /**
   * Upsert ONE full row by the collection's single-column unique key — the bulk
   * apply/undo write (PRD bulk-changes-reversible §3.4). Every user column is written;
   * one the row does not name becomes NULL, so callers pass a full row. Plain columns
   * are coerced as {@link insertRecords} does. `subject` columns are written VERBATIM:
   * a bulk row is built on a row read raw (its before-image), so a subject cell already
   * holds a stored `subject_id`, and resolving that as a name — what `insertRecords`
   * does — would create a subject named after an id. Throws instead of collecting
   * per-record errors: one row, one outcome.
   */
  putRowVerbatim(collection: string, row: Record<string, unknown>, stamp: RowStamp): 'inserted' | 'updated' {
    const [sourceGrants, sourceRunId] = stampValues(stamp);
    const info = this._getCollectionMeta(collection);
    if (!info) throw new Error(`Collection "${collection}" not found.`);
    const uniqueKey = info.unique_key ? info.unique_key.split(',') : [];
    if (uniqueKey.length !== 1) throw new Error(`Collection "${collection}" has no single-column unique key.`);
    const keyCol = uniqueKey[0]!;
    const columns = JSON.parse(info.schema_json) as DataStoreColumnDef[];
    const colNames = new Set(columns.map(c => c.name));
    for (const k of Object.keys(row)) {
      if (!colNames.has(k)) throw new Error(`Unknown column "${k}".`);
    }
    const values: unknown[] = columns.map((c) => {
      const val = row[c.name];
      if (val === undefined || val === null) return null;
      return c.type === 'subject' ? String(val) : coercePlainColumnValue(val, c);
    });
    const keyIdx = columns.findIndex(c => c.name === keyCol);
    if (keyIdx < 0 || values[keyIdx] === null) throw new Error('The row has no value for the unique key.');
    this._checkDbSize();
    this._assertSourceColumns(collection);

    const tableName = `ds_${collection}`;
    const now = new Date().toISOString();
    const allCols = ['_created_at', '_updated_at', ...SOURCE_COLUMNS, ...columns.map(c => c.name)];
    const updateSet = [...columns.filter(c => c.name !== keyCol).map(c => `"${c.name}" = excluded."${c.name}"`),
      '"_updated_at" = excluded."_updated_at"', sourceGrantsUnion(tableName), '"_source_run_id" = excluded."_source_run_id"'].join(', ');
    const sql = `INSERT INTO "${tableName}" (${allCols.map(c => `"${c}"`).join(', ')}) VALUES (${allCols.map(() => '?').join(', ')})` +
      ` ON CONFLICT("${keyCol}") DO UPDATE SET ${updateSet}`;
    // Identifiers come from the collection's own metadata (an existing collection, a
    // column of its schema); the one value is bound.
    const existsSql = `SELECT COUNT(*) as cnt FROM "${tableName}" WHERE "${keyCol}" = ?`;
    let outcome: 'inserted' | 'updated' = 'updated';
    this.db.transaction(() => {
      const exists = (this.db.prepare(existsSql).get(values[keyIdx]) as { cnt: number }).cnt > 0;
      if (!exists) {
        if (info.record_count + 1 > MAX_RECORDS) {
          throw new Error(`Collection "${collection}" would exceed ${MAX_RECORDS} record limit (current: ${info.record_count}).`);
        }
        outcome = 'inserted';
      }
      this.db.prepare(sql).run(now, now, sourceGrants, sourceRunId, ...values);
      // One row in or none: the count moves by the probe's answer, no table scan per write.
      // Unlike insertRecords this does not re-derive the count, so drift left by another
      // path stays until the next insertRecords/deleteRecords recount.
      this.db.prepare('UPDATE ds_collections SET record_count = record_count + ?, updated_at = ? WHERE name = ?')
        .run(exists ? 0 : 1, now, collection);
    })();
    return outcome;
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
    const validColumns = new Set<string>([...columns.map(c => c.name), ...VISIBLE_META_COLUMNS]);
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
    const selectSql = `SELECT ${this._visibleColumnList(columns)} FROM "${tableName}"${whereClause}${orderClause} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(selectSql).all(...whereParams, limit, offset) as Record<string, unknown>[];

    if (subjectCols.size > 0) this._hydrateSubjectNames(rows, subjectCols);

    return { rows, total: countResult.cnt };
  }

  /**
   * One page of an EXHAUSTIVE read of a collection, for the data export — not a
   * listing. {@link queryRecords} caps every call at 500 rows, so the export, which
   * called it once per collection, returned the first 500 and said nothing about the
   * rest.
   *
   * Keyed on `_id`, not on an offset: `_id` is the `INTEGER PRIMARY KEY
   * AUTOINCREMENT`, so it is never NULL and never reused, and a walk over
   * `_id > last` neither repeats nor skips an existing row however the collection is
   * written during it. `OFFSET` over `_updated_at DESC` would — an update mid-walk
   * moves a row to the front and shifts the window. A row INSERTED mid-walk may or
   * may not appear, which is not a loss.
   *
   * Raw cells, like {@link queryRecords} without `subjectsByName`, and the only read that
   * returns {@link SOURCE_COLUMNS}: the export is the owner's own copy. Pass the previous
   * page's last `_id` as `afterId`; omit it for the first page.
   */
  listRecordsForExport(params: { collection: string; afterId?: number | undefined; limit: number }): Record<string, unknown>[] {
    const info = this._getCollectionMeta(params.collection);
    if (!info) {
      throw new Error(`Collection "${params.collection}" not found.`);
    }
    const limit = Math.max(1, Math.min(params.limit, RECORD_EXPORT_PAGE_MAX));
    const tableName = `ds_${params.collection}`;
    const selectSql = `SELECT * FROM "${tableName}" WHERE _id > ? ORDER BY _id ASC LIMIT ?`;
    return this.db.prepare(selectSql).all(params.afterId ?? 0, limit) as Record<string, unknown>[];
  }

  /**
   * Record-on-spine — the EXISTS form of {@link getRecordsForSubject}: does any row, in
   * any collection, link `subjectId` through a `subject`-typed column? One indexed probe
   * per collection (the R2a per-subject index), short-circuits on the first hit, never
   * projects a row. The orphan-subject reap asks this for every subject an
   * erased memory was linked to, so it stays O(collections), not O(rows). Same
   * schema-validated identifiers + bound subject id as the full read.
   */
  hasRecordsForSubject(subjectId: string): boolean {
    const collections = this.db
      .prepare('SELECT name, schema_json FROM ds_collections')
      .all() as Array<{ name: string; schema_json: string }>;
    for (const c of collections) {
      const columns = JSON.parse(c.schema_json) as DataStoreColumnDef[];
      const subjectCols = columns.filter(col => col.type === 'subject').map(col => col.name);
      if (subjectCols.length === 0) continue;
      const whereOr = subjectCols.map(col => `"${col}" = ?`).join(' OR ');
      // Identifiers are schema-validated (same invariant as getRecordsForSubject); the
      // subject id is bound. Built as a const, not inlined into .prepare — the file's
      // parameterized-query pattern, which the security suite's line guard pins.
      const existsSql = `SELECT 1 FROM "ds_${c.name}" WHERE ${whereOr} LIMIT 1`;
      const hit = this.db.prepare(existsSql).get(...subjectCols.map(() => subjectId));
      if (hit) return true;
    }
    return false;
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
      const selectSql = `SELECT ${this._visibleColumnList(columns)} FROM "${tableName}" WHERE ${whereOr} ORDER BY ${timeExpr} DESC LIMIT ?`;
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

  /**
   * Whether a record a merge ledger names can be moved back. `ok`: it names a `subject`
   * column of a collection this store holds. `gone`: no such collection, or no such column
   * in its schema — dropped (or dropped and re-created) since the merge, or never there;
   * either way there is nothing to move back, and the record is skipped, never written.
   * `foreign`: a column the schema holds that is not a subject column. The names are read
   * back from a ledger file, unlike in {@link repointSubjectId}, so this check is what holds
   * them to the stored schema.
   */
  repointRecordState(rec: { collection: unknown; column: unknown }): 'ok' | 'gone' | 'foreign' {
    if (typeof rec.collection !== 'string' || typeof rec.column !== 'string') return 'foreign';
    const meta = this._getCollectionMeta(rec.collection);
    if (!meta) return 'gone';
    const col = (JSON.parse(meta.schema_json) as DataStoreColumnDef[]).find(c => c.name === rec.column);
    if (!col) return 'gone';
    return col.type === 'subject' ? 'ok' : 'foreign';
  }

  /** Reverse a {@link repointSubjectId} (merge rollback): move each captured cell back to `oldId`. */
  rollbackRepoint(oldId: string, newId: string, records: readonly SubjectRepointRecord[]): void {
    const states = records.map(rec => this.repointRecordState(rec));
    if (states.includes('foreign')) {
      throw new Error(FOREIGN_REPOINT_RECORD_REASON);
    }
    this.db.transaction(() => {
      for (const [i, rec] of records.entries()) {
        if (states[i] === 'gone') continue;
        const tableName = `ds_${rec.collection}`;
        // Identifiers checked by repointRecordState above; values are bound.
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
    const validColumns = new Set<string>([...columns.map(c => c.name), ...VISIBLE_META_COLUMNS]);
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
    this._sourceReady.delete(name);
    return true;
  }

  /**
   * Runs on every engine boot. Drops each EMPTY collection with a CRM-overlap name (see
   * `CRM_OVERLAP_NAMES`) unless it matches one of the `current` shapes exactly: same name,
   * scope, columns and unique key, as `ds_collections` records them. A change to the DDL
   * that `createCollection` emits for an unchanged shape does not reach a kept table (see
   * `crm-schema.ts`). Returns the dropped names so callers can log.
   *
   * Two kinds are dropped: empty collections the agent created under these names in older
   * sessions, and an empty CRM collection created by an older build (an older unique key
   * on `contacts`, older columns), which `CRM.ensureSchema` then recreates in the current
   * shape — the free migration. The CRM's own empty collections in their current shape
   * are kept: dropping them only for the CRM to recreate them in the same boot logged a
   * drop on every boot of an instance with an empty CRM, which hid a real one.
   * Non-empty collections are always preserved — they may hold legitimate user data.
   */
  dropEmptyCrmOverlaps(current: readonly CollectionShape[]): string[] {
    const dropped: string[] = [];
    const rows = this.db.prepare('SELECT name, scope_type, scope_id, schema_json, unique_key, record_count FROM ds_collections').all() as Array<{
      name: string; scope_type: string; scope_id: string; schema_json: string; unique_key: string | null; record_count: number;
    }>;
    for (const r of rows) {
      if (!CRM_OVERLAP_NAMES.has(r.name) || r.record_count !== 0) continue;
      // Compared as `createCollection` stores them, so an unchanged shape matches byte for byte.
      const isCurrent = current.some(c => c.name === r.name
        && c.scope.type === r.scope_type && c.scope.id === r.scope_id
        && JSON.stringify(c.columns) === r.schema_json
        && (c.uniqueKey ? c.uniqueKey.join(',') : null) === r.unique_key);
      if (isCurrent) continue;
      if (this.dropCollection(r.name)) dropped.push(r.name);
    }
    return dropped;
  }

  /** Drop the free pages and empty the WAL; see `scrubFreedPages` in `sqlite-constants.ts`. */
  scrubFreedPages(): void {
    scrubFreedPages(this.db);
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
    switch (col.type) {
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
        return coercePlainColumnValue(val, col);
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
    /**
     * A name → its candidate ids. `null` means "not a name, pass through untouched".
     * An empty result keeps {@link UNRESOLVABLE_SUBJECT}, whose polarity behaviour is
     * CORRECT for a genuinely absent name: nothing equals it, and everything differs
     * from it. Only a SHARED name needed a better answer than one id could carry.
     */
    const idsFor = (name: unknown): string[] | null => {
      if (typeof name !== 'string') return null;
      const trimmed = name.trim();
      if (trimmed === '') return [UNRESOLVABLE_SUBJECT];
      const ids = bridge.findAll(trimmed, kind);
      return ids.length === 0 ? [UNRESOLVABLE_SUBJECT] : ids;
    };
    // implicit-eq by name → "is any of the subjects this name could mean"
    if (typeof value === 'string') {
      const ids = idsFor(value)!;
      return ids.length === 1 ? ids[0]! : { $in: ids };
    }
    // null (is-null) / arrays / non-operator scalars pass through unchanged
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    // operator object. Clauses inside ONE operator object are AND-joined, so a widened
    // `$eq` must INTERSECT with any sibling `$in`, and a widened `$neq` must UNION into
    // any sibling `$nin` — order-independent either way.
    const out: Record<string, unknown> = {};
    const narrowIn = (ids: unknown[]): void => {
      const prev = out['$in'];
      const next = Array.isArray(prev) ? prev.filter(p => ids.includes(p)) : ids;
      // An EMPTY intersection means "nothing can satisfy both clauses" — which is a
      // legitimate zero-row answer, not a malformed filter. Emitting `[]` would hand the
      // validator an empty `$in` and turn that answer into a thrown error, so the
      // unmatchable sentinel carries it instead.
      out['$in'] = next.length > 0 ? next : [UNRESOLVABLE_SUBJECT];
    };
    const widenNin = (ids: unknown[]): void => {
      const prev = out['$nin'];
      out['$nin'] = Array.isArray(prev) ? [...new Set([...(prev as unknown[]), ...ids])] : ids;
    };
    for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
      switch (op) {
        case '$eq':
        case '$neq': {
          if (opVal === null) { out[op] = opVal; break; }
          const ids = idsFor(opVal);
          if (ids === null) { out[op] = opVal; break; }
          // One candidate keeps the caller's operator verbatim; several become the
          // set form, which is the only faithful reading of a shared name.
          if (ids.length === 1) { out[op] = ids[0]!; break; }
          if (op === '$eq') narrowIn(ids); else widenNin(ids);
          break;
        }
        case '$in':
        case '$nin': {
          if (!Array.isArray(opVal)) { out[op] = opVal; break; }
          // `?? [v]` keeps a non-string element verbatim, as the previous per-element
          // mapping did — dropping it would silently shrink the caller's list.
          const ids: unknown[] = opVal.flatMap((v: unknown) => idsFor(v) ?? [v]);
          if (op === '$in') narrowIn(ids); else widenNin(ids);
          break;
        }
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
