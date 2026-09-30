import type { ToolEntry, IAgent } from '../../types/index.js';
import type { BulkRunStatus, BulkTargetSystem, PlannedTarget } from '../../core/bulk-ledger.js';
import { BULK_WRITE_METHODS, canonicalHost, mintBulkContract, planExternal } from '../../core/bulk-external.js';
import { detectSecretInContent } from './http.js';
import {
  BULK_MAX_SOURCE_BYTES, BULK_MAX_TARGET_BYTES, BULK_MAX_TARGETS, BULK_QUERY_PAGE, BulkSourceError,
  parseSourceText, planDataStore, planWorkspace, readBulkImage, resolveBulkFilePath, rowsToSource,
} from '../../core/bulk-plan.js';

/**
 * The model-facing half of a bulk run's dry run (PRD bulk-changes-reversible §3.2,
 * §3.8). `bulk_plan` reads targets and their before-images into the ledger — for an
 * external target system it records the plan and leaves the reads to the engine's
 * preview effect; `bulk_status` reads counters back. Neither writes to a target, and neither returns
 * a target's key, value or diff: before-images are customer data, and a source file
 * may be externally authored — echoing its strings would put them into the model's
 * context. What the model gets is counts and a fixed vocabulary of reasons.
 */

interface BulkPlanInput {
  target_system: BulkTargetSystem | 'http';
  target_collection?: string | undefined;
  target_host?: string | undefined;
  write_method?: 'PATCH' | 'PUT' | 'POST' | undefined;
  source_file?: string | undefined;
  source_format?: 'json' | 'csv' | undefined;
  source_collection?: string | undefined;
  source_filter?: Record<string, unknown> | undefined;
  atomic?: boolean | undefined;
}

interface BulkStatusInput {
  run_id?: string | undefined;
}

function formatStatus(s: BulkRunStatus): string {
  const invalid = Object.entries(s.invalidReasons).map(([r, n]) => `${r} ${String(n)}`).join(', ');
  const lines = [
    `Bulk ${s.kind === 'undo' ? `undo run ${s.id} of run ${s.sourceRunId ?? '(deleted)'}` : `run ${s.id}`} ` +
      `(${s.targetSystem}${s.atomic ? ', atomic' : ''}, phase ${s.phase}, created ${s.createdAt}).`,
    `Targets: ${String(s.total)} — update ${String(s.changes.update)}, create ${String(s.changes.create)}, ` +
      `${s.changes.delete > 0 ? `delete ${String(s.changes.delete)}, ` : ''}` +
      `unchanged ${String(s.changes.unchanged)}, invalid ${String(s.changes.invalid)}${invalid ? ` (${invalid})` : ''}.`,
    `Undo class if applied: ${s.undo}.`,
  ];
  if (s.writeMethod !== null) {
    lines.push(`Writes with ${s.writeMethod}.${s.probeConfirmed ? '' : ' It can be applied to one target first; more only after the user has checked that one.'}`);
  }
  if (s.phase === 'planned') {
    lines.push(`Reading targets: ${String(s.unread)} of ${String(s.total - s.changes.invalid)} not read yet — ` +
      'the counts above are final once the phase is previewed.');
  }
  if (s.applied > 0 || s.failed > 0 || s.conflicts > 0 || s.undone > 0) {
    lines.push(`Applied ${String(s.applied)}, failed ${String(s.failed)}, conflicts ${String(s.conflicts)}, undone ${String(s.undone)}.`);
  }
  if (s.haltReason) lines.push(`Halted: ${s.haltReason}.`);
  if (s.checksumBinding === 'unkeyed') {
    lines.push('Approval checksum: unkeyed — this instance has no vault key, so the checksum does not bind the approval to the run.');
  }
  return lines.join('\n');
}

/** All rows of a data-store query, paged at the store's own page size, stopping one
 *  past the target limit so an oversized source is reported rather than truncated, and
 *  held to the same byte cap as a source file — a collection has no size of its own
 *  that would bound what the plan reads into memory. */
function queryAllRows(agent: IAgent, collection: string, filter: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const store = agent.toolContext.dataStore;
  if (!store) throw new BulkSourceError('The data store is not available.');
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  for (let offset = 0; ; offset += BULK_QUERY_PAGE) {
    const page = store.queryRecords({ collection, filter, limit: BULK_QUERY_PAGE, offset });
    for (const r of page.rows) bytes += Buffer.byteLength(JSON.stringify(r), 'utf8');
    if (bytes > BULK_MAX_SOURCE_BYTES) {
      throw new BulkSourceError(`The source is larger than ${String(BULK_MAX_SOURCE_BYTES / 1024 / 1024)} MB.`);
    }
    rows.push(...page.rows);
    if (page.rows.length < BULK_QUERY_PAGE || rows.length > BULK_MAX_TARGETS || offset + BULK_QUERY_PAGE >= page.total) return rows;
  }
}

export const bulkPlanTool: ToolEntry<BulkPlanInput> = {
  // Writes only the ledger — but recording a run also drops the oldest unapproved
  // previews beyond the cap, and nothing keeps what was dropped.
  undo: 'none',
  definition: {
    name: 'bulk_plan',
    description:
      'Dry-run a change to many targets at once: record, per target, its current state and the state the change would produce — without writing anything. ' +
      'Targets and new states come from a source you prepared: a JSON or CSV file in the workspace (rows with a "target" field and either an "after" field or the new column values), or a data-store collection holding such rows. ' +
      'target_system "workspace": each target is a file path, "after" its full new text. target_system "data_store": each target is a key value of target_collection\'s unique key, the other fields the new column values. ' +
      'target_system "http": each target is the https URL of one JSON resource on target_host, "after" a JSON object of the fields to set (text, number, true/false or null — no lists or nested objects); once the user starts it, the engine reads every target in the background with the host\'s stored API credential, so the counts are final only once bulk_status shows phase previewed. Only one external dry run reads at a time. ' +
      'You get back counts only. The user reviews the per-target before/after and approves the run outside this chat — you cannot apply it, and there is no screen or button for it you could point them to. ' +
      'atomic: true when the targets only make sense together — the run is then written whole or rolled back, and can only be undone whole.',
    input_schema: {
      type: 'object' as const,
      properties: {
        target_system: { type: 'string', enum: ['workspace', 'data_store', 'http'], description: 'What the targets are: workspace files, rows of one data-store collection, or JSON resources on one web API host.' },
        target_host: { type: 'string', description: 'For target_system "http": the API host name, e.g. api.example.com — every target URL must be on it.' },
        write_method: { type: 'string', enum: ['PATCH', 'PUT', 'POST'], description: 'For target_system "http": the verb the API edits an existing resource with at its own URL. Default PATCH. Some APIs edit with PUT, or with POST to the resource URL — use what the API documents for an edit, never a create endpoint.' },
        target_collection: { type: 'string', description: 'For target_system "data_store": the collection whose rows change. It needs a single-column unique key.' },
        source_file: { type: 'string', description: 'Workspace path of the JSON or CSV source. Give this or source_collection.' },
        source_format: { type: 'string', enum: ['json', 'csv'], description: 'Format of source_file. Default: csv for a .csv path, json otherwise.' },
        source_collection: { type: 'string', description: 'Data-store collection holding the source rows. Give this or source_file.' },
        source_filter: { type: 'object', description: 'Optional filter for source_collection, same syntax as data_store_query.' },
        atomic: { type: 'boolean', description: 'Write all targets or none (default false: targets are independent).' },
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
        if (image === 'not_text') throw new BulkSourceError('The source file is not UTF-8 text.');
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
      } else if (input.target_system === 'http') {
        const host = input.target_host === undefined ? null : canonicalHost(input.target_host);
        if (host === null) throw new BulkSourceError('target_system "http" needs target_host: a plain host name such as api.example.com.');
        // An external host has no transaction to roll back into (PRD §3.4).
        if (input.atomic === true) throw new BulkSourceError('target_system "http" cannot be atomic: an external host has no rollback.');
        const external = planExternal(source, host, detectSecretInContent);
        const keys = external.filter((t) => !('invalid' in t)).map((t) => t.key);
        const method = input.write_method ?? 'PATCH';
        if (!(BULK_WRITE_METHODS as readonly string[]).includes(method)) throw new BulkSourceError('write_method must be PATCH, PUT or POST.');
        const out = ledger.recordExternalPlan({
          createdBy: agent.currentThreadId, host, targets: external, contract: mintBulkContract(host, keys, method),
        });
        if (!out.ok) {
          return 'Error: another external dry run is still reading its targets. Wait until bulk_status shows it previewed, then plan again.';
        }
        return [
          out.status.phase === 'planned'
            ? 'External dry run recorded — nothing was sent or written. Nothing is read either until the user starts it outside this chat.'
            : 'Dry run recorded — nothing was written, and no target was valid, so there is nothing to read.',
          formatStatus(out.status),
          'Once the user has started it, the engine reads each target in the background and bulk_status shows phase previewed when it is done. ' +
            'The before- and after-state of each target is then in the run\'s ledger for the user to review; it is not shown to you. ' +
            'Only the user can start and approve it, outside this chat.',
        ].join('\n');
      } else {
        throw new BulkSourceError('target_system must be "workspace", "data_store" or "http".');
      }

      const status = ledger.recordDryRun({
        createdBy: agent.currentThreadId, targetSystem: input.target_system, scope, targets,
        targetCollection: input.target_system === 'data_store' ? input.target_collection ?? null : null,
        atomic: input.atomic === true,
      });
      return [
        'Dry run recorded — nothing was written to any target.',
        formatStatus(status),
        'The before- and after-state of each target is in the run\'s ledger for the user to review; it is not shown to you. ' +
          'Only the user can approve and apply it, outside this chat; bulk_status shows how far it got.',
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
