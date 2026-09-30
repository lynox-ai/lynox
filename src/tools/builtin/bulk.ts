import type { ToolEntry, IAgent } from '../../types/index.js';
import type { BulkRunStatus, BulkTargetSystem, PlannedTarget } from '../../core/bulk-ledger.js';
import {
  BULK_MAX_SOURCE_BYTES, BULK_MAX_TARGET_BYTES, BULK_MAX_TARGETS, BulkSourceError,
  parseSourceText, planDataStore, planWorkspace, readBulkImage, resolveBulkFilePath, rowsToSource,
} from '../../core/bulk-plan.js';

/**
 * The model-facing half of a bulk run's dry run (PRD bulk-changes-reversible §3.2,
 * §3.8). `bulk_plan` reads targets and their before-images into the ledger;
 * `bulk_status` reads counters back. Neither writes to a target, and neither returns
 * a target's key, value or diff: before-images are customer data, and a source file
 * may be externally authored — echoing its strings would put them into the model's
 * context. What the model gets is counts and a fixed vocabulary of reasons.
 */

interface BulkPlanInput {
  target_system: BulkTargetSystem;
  target_collection?: string | undefined;
  source_file?: string | undefined;
  source_format?: 'json' | 'csv' | undefined;
  source_collection?: string | undefined;
  source_filter?: Record<string, unknown> | undefined;
}

interface BulkStatusInput {
  run_id?: string | undefined;
}

function formatStatus(s: BulkRunStatus): string {
  const invalid = Object.entries(s.invalidReasons).map(([r, n]) => `${r} ${String(n)}`).join(', ');
  const lines = [
    `Bulk run ${s.id} (${s.targetSystem}, phase ${s.phase}, created ${s.createdAt}).`,
    `Targets: ${String(s.total)} — update ${String(s.changes.update)}, create ${String(s.changes.create)}, ` +
      `unchanged ${String(s.changes.unchanged)}, invalid ${String(s.changes.invalid)}${invalid ? ` (${invalid})` : ''}.`,
    `Undo class if applied: ${s.undo}.`,
  ];
  if (s.applied > 0 || s.failed > 0) lines.push(`Applied ${String(s.applied)}, failed ${String(s.failed)}.`);
  if (s.haltReason) lines.push(`Halted: ${s.haltReason}.`);
  return lines.join('\n');
}

/** All rows of a data-store query, paged at the store's own page size, stopping one
 *  past the target limit so an oversized source is reported rather than truncated. */
function queryAllRows(agent: IAgent, collection: string, filter: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const store = agent.toolContext.dataStore;
  if (!store) throw new BulkSourceError('The data store is not available.');
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = store.queryRecords({ collection, filter, limit: 500, offset });
    rows.push(...page.rows);
    if (page.rows.length < 500 || rows.length > BULK_MAX_TARGETS || offset + 500 >= page.total) return rows;
  }
}

export const bulkPlanTool: ToolEntry<BulkPlanInput> = {
  // Writes a planned run into the ledger, nothing else: deleting that row reverses it.
  undo: 'compensatable',
  definition: {
    name: 'bulk_plan',
    description:
      'Dry-run a change to many targets at once: record, per target, its current state and the state the change would produce — without writing anything. ' +
      'Targets and new states come from a source you prepared: a JSON or CSV file in the workspace (rows with a "target" field and either an "after" field or the new column values), or a data-store collection holding such rows. ' +
      'target_system "workspace": each target is a file path, "after" its full new text. target_system "data_store": each target is a key value of target_collection\'s unique key, the other fields the new column values. ' +
      'You get back counts only; the user reviews the per-target before/after. Nothing is applied.',
    input_schema: {
      type: 'object' as const,
      properties: {
        target_system: { type: 'string', enum: ['workspace', 'data_store'], description: 'What the targets are: workspace files or rows of one data-store collection.' },
        target_collection: { type: 'string', description: 'For target_system "data_store": the collection whose rows change. It needs a single-column unique key.' },
        source_file: { type: 'string', description: 'Workspace path of the JSON or CSV source. Give this or source_collection.' },
        source_format: { type: 'string', enum: ['json', 'csv'], description: 'Format of source_file. Default: csv for a .csv path, json otherwise.' },
        source_collection: { type: 'string', description: 'Data-store collection holding the source rows. Give this or source_file.' },
        source_filter: { type: 'object', description: 'Optional filter for source_collection, same syntax as data_store_query.' },
      },
      required: ['target_system'],
    },
  },
  handler: async (input: BulkPlanInput, agent: IAgent): Promise<string> => {
    const ledger = agent.toolContext.bulkLedger;
    if (!ledger) return 'Bulk runs are not available on this instance.';
    try {
      if ((input.source_file === undefined) === (input.source_collection === undefined)) {
        throw new BulkSourceError('Give exactly one of source_file or source_collection.');
      }
      let rows: Record<string, unknown>[];
      if (input.source_file !== undefined) {
        const path = resolveBulkFilePath(input.source_file);
        if (path === null) throw new BulkSourceError('The source file must be inside the workspace.');
        let image: ReturnType<typeof readBulkImage>;
        try {
          image = readBulkImage(path, BULK_MAX_SOURCE_BYTES);
        } catch {
          throw new BulkSourceError('The source file is not a readable file.');
        }
        if (image === 'too_large') throw new BulkSourceError(`The source file is larger than ${String(BULK_MAX_SOURCE_BYTES / 1024 / 1024)} MB.`);
        if (image.absent) throw new BulkSourceError('The source file does not exist.');
        const format = input.source_format ?? (path.toLowerCase().endsWith('.csv') ? 'csv' : 'json');
        rows = parseSourceText(image.value, format);
      } else {
        rows = queryAllRows(agent, input.source_collection!, input.source_filter);
      }
      const source = rowsToSource(rows);

      let targets: PlannedTarget[];
      let scope: string;
      if (input.target_system === 'workspace') {
        targets = planWorkspace(source, {
          resolve: resolveBulkFilePath,
          read: (p) => readBulkImage(p, BULK_MAX_TARGET_BYTES),
        });
        scope = 'workspace';
      } else if (input.target_system === 'data_store') {
        const store = agent.toolContext.dataStore;
        if (!store) throw new BulkSourceError('The data store is not available.');
        if (!input.target_collection) throw new BulkSourceError('target_system "data_store" needs target_collection.');
        targets = planDataStore(source, store, input.target_collection);
        scope = `data_store:${input.target_collection}`;
      } else {
        throw new BulkSourceError('target_system must be "workspace" or "data_store".');
      }

      const status = ledger.recordDryRun({ createdBy: agent.currentThreadId, targetSystem: input.target_system, scope, targets });
      return [
        'Dry run recorded — nothing was written to any target.',
        formatStatus(status),
        'The before- and after-state of each target is in the run\'s ledger for the user to review; it is not shown to you. Applying a run is not available yet.',
      ].join('\n');
    } catch (err: unknown) {
      if (err instanceof BulkSourceError) return `Error: ${err.message}`;
      // Data-store errors name the collection or filter column the caller passed —
      // the caller's own strings, not a target's content.
      return `Error: the dry run failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const bulkStatusTool: ToolEntry<BulkStatusInput> = {
  definition: {
    name: 'bulk_status',
    description: 'Show the phase and counts of a bulk run recorded by bulk_plan, or of the most recent runs when no run_id is given. Counts only — never target contents.',
    input_schema: {
      type: 'object' as const,
      properties: {
        run_id: { type: 'string', description: 'The bulk run id. Omit to list the most recent runs.' },
      },
    },
  },
  handler: async (input: BulkStatusInput, agent: IAgent): Promise<string> => {
    const ledger = agent.toolContext.bulkLedger;
    if (!ledger) return 'Bulk runs are not available on this instance.';
    if (input.run_id !== undefined) {
      const s = ledger.getStatus(input.run_id);
      return s ? formatStatus(s) : 'No bulk run with that id.';
    }
    const runs = ledger.listRuns(10);
    return runs.length === 0 ? 'No bulk runs recorded.' : runs.map(formatStatus).join('\n\n');
  },
};
