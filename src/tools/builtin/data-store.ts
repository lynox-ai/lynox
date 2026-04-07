import type { ToolEntry, DataStoreColumnDef, DataStoreSort, DataStoreMetric } from '../../types/index.js';
import { parseScopeString } from '../../core/scope-resolver.js';
import { getErrorMessage } from '../../core/utils.js';
import { channels } from '../../core/observability.js';

// DataStore accessed via agent.toolContext.dataStore

// === data_store_create ===

interface CreateInput {
  name: string;
  columns: Array<{ name: string; type: string; unique?: boolean | undefined }>;
  unique_key?: string[] | undefined;
  scope?: string | undefined;
  description?: string | undefined;
}

export const dataStoreCreateTool: ToolEntry<CreateInput> = {
  definition: {
    name: 'data_store_create',
    description: 'Set up a table for structured, quantitative data — metrics, KPIs, records with typed columns. Data persists across sessions. NOT for qualitative knowledge or preferences (use memory_store).',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Table name (lowercase, a-z0-9_, max 63 chars). E.g. "google_ads_kpis"' },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Column name (lowercase, a-z0-9_)' },
              type: { type: 'string', enum: ['string', 'number', 'date', 'boolean', 'json'], description: 'Column data type' },
              unique: { type: 'boolean', description: 'Enforce unique values for this column' },
            },
            required: ['name', 'type'],
          },
          description: 'Column definitions',
        },
        unique_key: {
          type: 'array',
          items: { type: 'string' },
          description: 'Composite unique key for upsert. E.g. ["campaign", "date"] — inserts with matching key update instead.',
        },
        scope: { type: 'string', description: 'Scope as "type:id" (e.g. "client:acme"). Default: project scope.' },
        description: { type: 'string', description: 'Human-readable description of the table' },
      },
      required: ['name', 'columns'],
    },
  },
  handler: async (input: CreateInput, agent): Promise<string> => {
    const storeRef = agent.toolContext.dataStore;
    if (!storeRef) return 'DataStore not available.';

    try {
      const scope = (input.scope ? parseScopeString(input.scope) : undefined) ?? { type: 'context' as const, id: '' };
      const columns: DataStoreColumnDef[] = input.columns.map(c => ({
        name: c.name,
        type: c.type as DataStoreColumnDef['type'],
        unique: c.unique,
      }));

      const info = storeRef.createCollection({
        name: input.name,
        scope,
        columns,
        uniqueKey: input.unique_key,
      });

      // Publish for Knowledge Graph bridge (collection registration)
      channels.dataStoreInsert.publish({
        event: 'collection_created',
        collection: input.name,
        columns,
        scopeType: scope.type,
        scopeId: scope.id,
      });

      const colDesc = info.columns.map(c => `${c.name} (${c.type}${c.unique ? ', unique' : ''})`).join(', ');
      const ukDesc = info.uniqueKey ? ` | Unique key: [${info.uniqueKey.join(', ')}]` : '';
      return `Created collection "${info.name}" with columns: ${colDesc}${ukDesc}. Scope: ${info.scopeType}${info.scopeId ? ':' + info.scopeId : ''}. Entities will be automatically linked for cross-referencing.`;
    } catch (err) {
      return `Error working with data table: ${getErrorMessage(err)}`;
    }
  },
};

// === data_store_insert ===

interface InsertInput {
  collection: string;
  records: Record<string, unknown>[];
}

export const dataStoreInsertTool: ToolEntry<InsertInput> = {
  definition: {
    name: 'data_store_insert',
    description: 'Add or update rows in a data table. Cleans up duplicates automatically when a unique key is set. Max 1000 rows per call.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string', description: 'Table name' },
        records: {
          type: 'array',
          items: { type: 'object' },
          description: 'Records to insert. Fields must match table schema.',
        },
      },
      required: ['collection', 'records'],
    },
  },
  handler: async (input: InsertInput, agent): Promise<string> => {
    const storeRef = agent.toolContext.dataStore;
    if (!storeRef) return 'DataStore not available.';

    try {
      const result = storeRef.insertRecords({
        collection: input.collection,
        records: input.records,
      });

      // Publish for Knowledge Graph bridge (entity extraction from records)
      if (result.inserted > 0 || result.updated > 0) {
        channels.dataStoreInsert.publish({
          event: 'records_inserted',
          collection: input.collection,
          records: input.records,
        });
      }

      const parts: string[] = [];
      if (result.inserted > 0) parts.push(`Inserted ${result.inserted}`);
      if (result.updated > 0) parts.push(`updated ${result.updated}`);
      const summary = parts.length > 0
        ? `${parts.join(', ')} record(s) into ${input.collection}.`
        : `No records changed in ${input.collection}.`;

      if (result.errors.length > 0) {
        return `${summary}\nWarnings:\n${result.errors.join('\n')}`;
      }
      return summary;
    } catch (err) {
      return `Error working with data table: ${getErrorMessage(err)}`;
    }
  },
};

// === data_store_query ===

interface QueryInput {
  collection: string;
  filter?: Record<string, unknown> | undefined;
  sort?: Array<{ field: string; order: 'asc' | 'desc' }> | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  aggregate?: {
    group_by?: string[] | undefined;
    metrics: Array<{ field: string; fn: string; alias?: string | undefined }>;
  } | undefined;
}

export const dataStoreQueryTool: ToolEntry<QueryInput> = {
  definition: {
    name: 'data_store_query',
    description: 'Search and analyze data in your tables — filter rows, sort results, count items, calculate sums and averages.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string', description: 'Table name' },
        filter: {
          type: 'object',
          description: 'Filter conditions as JSON. Examples: { status: "active" }, { revenue: { "$gt": 1000 } }, { "$or": [{ a: 1 }, { b: 2 }] }.',
        },
        sort: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              order: { type: 'string', enum: ['asc', 'desc'] },
            },
            required: ['field', 'order'],
          },
          description: 'Sort order',
        },
        limit: { type: 'number', description: 'Max rows to return (default: 50, max: 500)' },
        offset: { type: 'number', description: 'Skip N rows (for pagination)' },
        aggregate: {
          type: 'object',
          properties: {
            group_by: {
              type: 'array',
              items: { type: 'string' },
              description: 'Columns to group by',
            },
            metrics: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string', description: 'Column to aggregate (use "*" for count)' },
                  fn: { type: 'string', enum: ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'] },
                  alias: { type: 'string', description: 'Output column name' },
                },
                required: ['field', 'fn'],
              },
            },
          },
          required: ['metrics'],
          description: 'Aggregation: group_by + metrics',
        },
      },
      required: ['collection'],
    },
  },
  handler: async (input: QueryInput, agent): Promise<string> => {
    const storeRef = agent.toolContext.dataStore;
    if (!storeRef) return 'DataStore not available.';

    try {
      const sort: DataStoreSort[] | undefined = input.sort;
      const aggregate = input.aggregate
        ? {
            groupBy: input.aggregate.group_by,
            metrics: input.aggregate.metrics.map(m => ({
              field: m.field,
              fn: m.fn as DataStoreMetric['fn'],
              alias: m.alias,
            })),
          }
        : undefined;

      const { rows, total } = storeRef.queryRecords({
        collection: input.collection,
        filter: input.filter,
        sort,
        limit: input.limit,
        offset: input.offset,
        aggregate,
      });

      if (rows.length === 0) {
        return `No results found in "${input.collection}"${input.filter ? ' matching filter' : ''}.`;
      }

      // Format as markdown table
      const allKeys = Object.keys(rows[0]!).filter(k => k !== '_id');
      const header = `| ${allKeys.join(' | ')} |`;
      const separator = `| ${allKeys.map(() => '---').join(' | ')} |`;
      const body = rows.map(row => {
        const cells = allKeys.map(k => {
          const v = row[k];
          if (v === null || v === undefined) return '';
          return String(v);
        });
        return `| ${cells.join(' | ')} |`;
      });

      const table = [header, separator, ...body].join('\n');
      const meta = `Showing ${rows.length} of ${total} result(s).`;

      // Append raw JSON for precision
      const rawJson = JSON.stringify(rows);
      return `${meta}\n\n${table}\n\n<raw_json>${rawJson}</raw_json>`;
    } catch (err) {
      return `Error working with data table: ${getErrorMessage(err)}`;
    }
  },
};

// === data_store_list ===

interface ListInput {
  scope?: string | undefined;
  include_schema?: boolean | undefined;
}

export const dataStoreListTool: ToolEntry<ListInput> = {
  definition: {
    name: 'data_store_list',
    description: 'Browse your data tables and see what columns each one has.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', description: 'Filter by scope "type:id"' },
        include_schema: { type: 'boolean', description: 'Include full column definitions (default: false)' },
      },
      required: [],
    },
  },
  handler: async (input: ListInput, agent): Promise<string> => {
    const storeRef = agent.toolContext.dataStore;
    if (!storeRef) return 'DataStore not available.';

    try {
      let collections = storeRef.listCollections();

      if (input.scope) {
        const scopeRef = parseScopeString(input.scope);
        if (scopeRef) {
          collections = collections.filter(c =>
            c.scopeType === scopeRef.type && (scopeRef.id === '' || c.scopeId === scopeRef.id)
          );
        }
      }

      if (collections.length === 0) {
        return 'No data tables found.';
      }

      const lines = collections.map(c => {
        const scope = `${c.scopeType}${c.scopeId ? ':' + c.scopeId : ''}`;
        const cols = c.columns.map(col => `${col.name}:${col.type}`).join(', ');
        const uk = c.uniqueKey ? ` | UK: [${c.uniqueKey.join(', ')}]` : '';
        const base = `**${c.name}** — ${c.recordCount} records (${scope})${uk}`;

        if (input.include_schema) {
          const schema = c.columns.map(col =>
            `  - ${col.name}: ${col.type}${col.unique ? ' (unique)' : ''}`
          ).join('\n');
          return `${base}\n  Updated: ${c.updatedAt.slice(0, 10)}\n${schema}`;
        }
        return `${base} — [${cols}]`;
      });

      return lines.join('\n\n');
    } catch (err) {
      return `Error working with data table: ${getErrorMessage(err)}`;
    }
  },
};

// === data_store_delete ===

interface DeleteInput {
  collection: string;
  filter: Record<string, unknown>;
}

export const dataStoreDeleteTool: ToolEntry<DeleteInput> = {
  definition: {
    name: 'data_store_delete',
    description: 'Remove records from a data table that match a filter. Cannot delete all records without a filter — use this for cleanup of specific entries.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string', description: 'Table name' },
        filter: {
          type: 'object',
          description: 'Filter to match records for deletion. Same syntax as data_store_query filter. E.g. {"status": "cancelled"} or {"_id": {"$in": [1, 2, 3]}}',
        },
      },
      required: ['collection', 'filter'],
    },
  },
  handler: async (input: DeleteInput, agent): Promise<string> => {
    const storeRef = agent.toolContext.dataStore;
    if (!storeRef) return 'DataStore not available.';

    try {
      const deleted = storeRef.deleteRecords({
        collection: input.collection,
        filter: input.filter,
      });

      if (deleted > 0) {
        channels.dataStoreInsert.publish({
          event: 'records_deleted',
          collection: input.collection,
          deletedCount: deleted,
        });
      }

      return deleted > 0
        ? `Deleted ${deleted} record(s) from ${input.collection}.`
        : `No records matched the filter in ${input.collection}.`;
    } catch (err) {
      return `Error working with data table: ${getErrorMessage(err)}`;
    }
  },
};

// === data_store_drop ===

interface DropInput {
  collection: string;
}

export const dataStoreDropTool: ToolEntry<DropInput> = {
  definition: {
    name: 'data_store_drop',
    description: 'Permanently remove an entire data table including all records and its schema. Use with caution — this cannot be undone.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string', description: 'Table name to drop' },
      },
      required: ['collection'],
    },
  },
  handler: async (input: DropInput, agent): Promise<string> => {
    const storeRef = agent.toolContext.dataStore;
    if (!storeRef) return 'DataStore not available.';

    try {
      const dropped = storeRef.dropCollection(input.collection);
      if (dropped) {
        channels.dataStoreInsert.publish({
          event: 'collection_dropped',
          collection: input.collection,
        });
        return `Dropped collection "${input.collection}" and all its records.`;
      }
      return `Collection "${input.collection}" not found.`;
    } catch (err) {
      return `Error dropping collection: ${getErrorMessage(err)}`;
    }
  },
};
