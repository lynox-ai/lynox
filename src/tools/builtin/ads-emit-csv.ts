/**
 * Tool: ads_emit_csv
 *
 * Final phase of the Ads Optimizer cycle. Reads the persisted blueprint
 * entities for the latest successful audit run, validates them against
 * the pre-emit gate, and (when valid) writes a UTF-16 LE per-campaign
 * CSV pack into the workspace directory. The customer imports those
 * files via Google Ads Editor's bulk-import flow.
 *
 * Returns a Markdown emit-summary intended for direct thread display.
 *
 * Idempotency: when the SHA-256 over the planned emit output matches
 * the previous run's emitted_csv_hash, the tool reports "no changes"
 * and writes nothing — the customer does not need to re-import.
 *
 * Gated by feature flag 'ads-optimizer'.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import type { AdsDataStore, AdsAccountRow } from '../../core/ads-data-store.js';
import {
  runEmit, EmitPreconditionError, type EmitResult,
} from '../../core/ads-emit-engine.js';
import { getErrorMessage } from '../../core/utils.js';

interface AdsEmitCsvInput {
  ads_account_id: string;
  /** Override the workspace base directory. Defaults to LYNOX_WORKSPACE/ads. */
  workspace_dir?: string | undefined;
  /** Explicit run id to emit. When omitted, the engine picks the latest run
   *  that has blueprint entities (which may be older than the latest audit
   *  run if the latest blueprint was skipped due to pending import). */
  run_id?: number | undefined;
}

const DESCRIPTION = [
  'Write the per-campaign Editor CSV pack for the latest successful blueprint run.',
  '',
  'Workflow position — call AFTER `ads_blueprint_run` has populated',
  'ads_blueprint_entities for the run. The tool runs the full pre-emit validator',
  'gate (Final URL HTTPS, headline/description lengths, RSA min counts,',
  'competitor-trademark scan, cross-references) and only writes files when every',
  'HARD check passes.',
  '',
  'Output: one CSV per campaign + a separate `account-negatives.csv` for the',
  'pmax_owned + competitor account-level negatives, dropped into',
  '`{workspace}/ads/{ads_account_id}/blueprints/run-{run_id}/`. Files are UTF-16',
  'LE with a leading BOM and TAB separators — the format Google Ads Editor',
  'expects on import. Every NEW entity defaults to Status=Paused so nothing',
  'goes live until the customer reviews + posts in Editor.',
  '',
  'Idempotent re-runs (blueprint hash unchanged from previous cycle) report',
  '"no changes" and skip writes — the customer does not need to re-import.',
  '',
  'After the customer runs the Editor import, call `ads_mark_imported` with',
  'the same ads_account_id so the 14d Smart-Bidding-Guard is anchored to the',
  'right timestamp on the next cycle\'s restructure proposals.',
].join('\n');

export function createAdsEmitCsvTool(store: AdsDataStore): ToolEntry<AdsEmitCsvInput> {
  return {
    definition: {
      name: 'ads_emit_csv',
      description: DESCRIPTION,
      input_schema: {
        type: 'object' as const,
        properties: {
          ads_account_id: { type: 'string', description: 'Google Ads Customer ID, e.g. "123-456-7890".' },
          workspace_dir: {
            type: 'string',
            description: 'Override the workspace base directory. Defaults to LYNOX_WORKSPACE/ads.',
          },
          run_id: {
            type: 'integer',
            description: 'Explicit run id to emit. Omit to auto-pick the latest run with blueprint entities — useful when the latest audit run was skipped due to pending import.',
          },
        },
        required: ['ads_account_id'],
      },
    },
    handler: async (input: AdsEmitCsvInput, _agent: IAgent): Promise<string> => {
      try {
        const result = runEmit(store, input.ads_account_id, {
          ...(input.workspace_dir !== undefined ? { workspaceDir: input.workspace_dir } : {}),
          ...(input.run_id !== undefined ? { runId: input.run_id } : {}),
        });
        return renderEmitReport(result);
      } catch (err) {
        if (err instanceof EmitPreconditionError) {
          return `ads_emit_csv failed: ${err.message}`;
        }
        return `ads_emit_csv failed: ${getErrorMessage(err)}`;
      }
    },
  };
}

// ── Markdown rendering ────────────────────────────────────────────────

/** Workspace-relative path for an emitted CSV. Used to build the
 *  /api/files/download URL the chat UI can render as a clickable link. */
function workspaceRelativePath(absoluteFilePath: string, account: AdsAccountRow, runId: number): string {
  // Files always sit at <ws>/ads/<account>/blueprints/run-<id>/<basename>.
  // Build the relative form deterministically so the chat link doesn't
  // depend on the workspace root happening to be in scope here.
  const lastSep = absoluteFilePath.lastIndexOf('/');
  const filename = lastSep >= 0 ? absoluteFilePath.slice(lastSep + 1) : absoluteFilePath;
  return `ads/${account.ads_account_id}/blueprints/run-${runId}/${filename}`;
}

export function renderEmitReport(result: EmitResult): string {
  const { account, customer, run, validation, hash, idempotent,
    filesWritten, perFileRowCounts, totals, blockedReason } = result;

  const lines: string[] = [];
  lines.push(`# Emit Report — ${customer.client_name} (${account.ads_account_id})`);
  lines.push('');
  lines.push(`**Run:** #${run.run_id} (${run.mode}) → Emit-Hash \`${hash.slice(0, 12)}…\``);
  lines.push('');

  if (blockedReason) {
    lines.push(`> ${idempotent ? '🟢' : '🔴'} **${idempotent ? 'No-Op' : 'Blocked'}** — ${blockedReason}`);
    lines.push('');
  } else {
    lines.push('> 🟢 **Emit erfolgreich** — Files können vom Customer in Google Ads Editor importiert werden.');
    lines.push('');
  }

  // Validator summary always shown.
  lines.push('## Pre-Emit-Validators');
  lines.push('');
  if (validation.hard.length === 0) {
    lines.push(`- HARD-Checks: **${validation.hard.length === 0 ? 'alle bestanden ✅' : `${validation.hard.length} Errors ❌`}**`);
  } else {
    lines.push(`- HARD-Checks: **${validation.hard.length} Errors** — Emit ist blockiert bis behoben.`);
    lines.push('');
    lines.push('| Area | Entity Type | External ID | Problem |');
    lines.push('|---|---|---|---|');
    for (const issue of validation.hard.slice(0, 30)) {
      lines.push(`| ${issue.area} | ${issue.entityType} | \`${issue.externalId}\` | ${issue.message} |`);
    }
    if (validation.hard.length > 30) {
      lines.push(`| _… ${validation.hard.length - 30} weitere_ |  |  |`);
    }
  }
  lines.push('');
  if (validation.warn.length > 0) {
    lines.push(`- WARN: ${validation.warn.length} (z.B. Naming-Konvention) — blockieren Emit nicht, prüfen für nächsten Cycle.`);
    lines.push('');
  }

  if (filesWritten.length === 0) return lines.join('\n');

  lines.push('## Editor-CSV-Pack — Direkt herunterladen');
  lines.push('');
  lines.push(`Gesamt: ${filesWritten.length} CSVs (${totals.campaigns} Campaigns · ${totals.adGroups} Ad-Groups · ${totals.keywords} Keywords · ${totals.negatives} Negatives).`);
  lines.push('');
  lines.push('| File | Zeilen | Download |');
  lines.push('|---|---|---|');
  for (const f of perFileRowCounts) {
    const lastSep = f.file.lastIndexOf('/');
    const filename = lastSep >= 0 ? f.file.slice(lastSep + 1) : f.file;
    const rel = workspaceRelativePath(f.file, account, run.run_id);
    const url = `/api/files/download?path=${encodeURIComponent(rel)}`;
    lines.push(`| \`${filename}\` | ${f.rowCount} | [Download](${url}) |`);
  }
  lines.push('');
  lines.push(`Alle Files liegen auch im **Dateien**-Tab unter \`ads/${account.ads_account_id}/blueprints/run-${run.run_id}/\` falls die Download-Links nicht funktionieren.`);
  lines.push('');

  lines.push('## Nächste Schritte');
  lines.push('');
  lines.push('1. Klick auf jeden **Download**-Link oben → Browser speichert die `.csv` (UTF-16 LE mit BOM).');
  lines.push('2. Google Ads Editor → Account → Import → From file → die heruntergeladenen Dateien laden.');
  lines.push('3. Vorschau prüfen, posten.');
  lines.push('4. Bescheid geben → ich rufe `ads_mark_imported` auf damit der 14-Tage-Smart-Bidding-Guard greift.');

  return lines.join('\n');
}
