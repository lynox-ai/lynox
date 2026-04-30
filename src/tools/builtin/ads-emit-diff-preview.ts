/**
 * Tool: ads_emit_diff_preview
 *
 * Production-safety preview. Operator wants to see what
 * `ads_emit_csv` WOULD do before it actually writes the CSV pack.
 * The tool reads the persisted blueprint entities + the current
 * snapshot, groups them by (entity_type, kind), and renders a
 * concise Markdown delta — "would create N campaigns, rename M
 * ad-groups, pause X keywords".
 *
 * Pure read — no side-effects on workspace files, no LLM. Cheap to
 * call repeatedly. Operator-driven.
 *
 * Gated by feature flag 'ads-optimizer'.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import type {
  AdsDataStore, AdsBlueprintEntityRow, AdsBlueprintEntityKind,
} from '../../core/ads-data-store.js';
import { getErrorMessage } from '../../core/utils.js';

interface AdsEmitDiffPreviewInput {
  ads_account_id: string;
  /** Explicit run id. Omit for the latest run with blueprint entities. */
  run_id?: number | undefined;
  /** Sample size per (entity_type, kind) bucket (default 5, max 20). */
  sample_size?: number | undefined;
}

const DESCRIPTION = [
  'Preview what ads_emit_csv WOULD do, without writing any files.',
  '',
  'Reads the persisted blueprint for the run + groups entities by',
  '(entity_type, kind). Renders Markdown sections per entity_type with',
  'counts (NEW / RENAME / PAUSE / KEEP) plus a sample of each.',
  '',
  'Use BEFORE ads_emit_csv when you want to verify the blueprint matches',
  'expectation — e.g. confirm the right account, the right number of',
  'changes, no surprise PAUSE actions.',
  '',
  'Pure read — no workspace writes, no LLM calls. Safe to call repeatedly.',
].join('\n');

const DEFAULT_SAMPLE = 5;
const MAX_SAMPLE = 20;

export function createAdsEmitDiffPreviewTool(
  store: AdsDataStore,
): ToolEntry<AdsEmitDiffPreviewInput> {
  return {
    definition: {
      name: 'ads_emit_diff_preview',
      description: DESCRIPTION,
      input_schema: {
        type: 'object' as const,
        properties: {
          ads_account_id: {
            type: 'string',
            description: 'Google Ads Customer ID, e.g. "123-456-7890".',
          },
          run_id: {
            type: 'integer',
            description: 'Explicit run id. Omit to use the latest run with blueprint entities.',
          },
          sample_size: {
            type: 'integer',
            description: 'How many sample entities to render per (entity_type, kind) bucket (default 5, max 20).',
          },
        },
        required: ['ads_account_id'],
      },
    },
    handler: async (input: AdsEmitDiffPreviewInput, _agent: IAgent): Promise<string> => {
      try {
        const account = store.getAdsAccount(input.ads_account_id);
        if (!account) {
          return `ads_emit_diff_preview failed: unknown ads_account_id "${input.ads_account_id}".`;
        }
        const customer = store.getCustomerProfile(account.customer_id);
        const runId = input.run_id ?? resolveLatestBlueprintRunId(store, input.ads_account_id);
        if (runId === null) {
          return `ads_emit_diff_preview: keine Blueprint-Runs für ${input.ads_account_id}. ` +
            `Erst ads_blueprint_run aufrufen.`;
        }
        const entities = store.listBlueprintEntities(runId);
        if (entities.length === 0) {
          return `ads_emit_diff_preview: Run #${runId} hat keine Blueprint-Entities — nichts zu emittieren.`;
        }
        const sampleSize = clampSample(input.sample_size);
        return renderDiffMarkdown(
          entities, runId, sampleSize,
          input.ads_account_id, customer?.client_name ?? account.customer_id,
        );
      } catch (err) {
        return `ads_emit_diff_preview failed: ${getErrorMessage(err)}`;
      }
    },
  };
}

function resolveLatestBlueprintRunId(store: AdsDataStore, adsAccountId: string): number | null {
  const runs = store.listAuditRuns(adsAccountId, 20);
  for (const r of runs) {
    if (r.status !== 'SUCCESS') continue;
    if (store.listBlueprintEntities(r.run_id).length > 0) return r.run_id;
  }
  return null;
}

function clampSample(s: number | undefined): number {
  if (typeof s !== 'number' || !Number.isFinite(s)) return DEFAULT_SAMPLE;
  return Math.max(1, Math.min(MAX_SAMPLE, Math.floor(s)));
}

const KIND_ORDER: ReadonlyArray<AdsBlueprintEntityKind> = ['NEW', 'RENAME', 'PAUSE', 'SPLIT', 'MERGE', 'KEEP'];

function renderDiffMarkdown(
  entities: ReadonlyArray<AdsBlueprintEntityRow>,
  runId: number, sampleSize: number,
  accountId: string, clientName: string,
): string {
  // Group: entity_type → kind → entity[]
  const grouped = new Map<string, Map<AdsBlueprintEntityKind, AdsBlueprintEntityRow[]>>();
  for (const e of entities) {
    const byKind = grouped.get(e.entity_type) ?? new Map<AdsBlueprintEntityKind, AdsBlueprintEntityRow[]>();
    const bucket = byKind.get(e.kind) ?? [];
    bucket.push(e);
    byKind.set(e.kind, bucket);
    grouped.set(e.entity_type, byKind);
  }

  const lines: string[] = [];
  lines.push(`# Emit Diff Preview — ${clientName} (${accountId})`);
  lines.push('');
  lines.push(`**Run:** #${runId}`);
  lines.push(`**Total entities:** ${entities.length}`);
  lines.push('');
  lines.push('> Read-only preview. \`ads_emit_csv\` will perform these actions when executed.');
  lines.push('');

  // Top-level summary table.
  lines.push('## Summary by entity type');
  lines.push('');
  lines.push('| Entity type | NEW | RENAME | PAUSE | SPLIT | MERGE | KEEP |');
  lines.push('|---|---|---|---|---|---|---|');
  const sortedTypes = [...grouped.keys()].sort();
  for (const entityType of sortedTypes) {
    const byKind = grouped.get(entityType)!;
    const cells = KIND_ORDER.map(k => byKind.get(k)?.length ?? 0);
    if (cells.every(c => c === 0)) continue;
    lines.push(`| ${entityType} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  // Per-type sections — focus on action kinds (skip KEEP for the
  // detail sections; KEEP is just "no change" and would clutter).
  for (const entityType of sortedTypes) {
    const byKind = grouped.get(entityType)!;
    const hasAction = KIND_ORDER.slice(0, -1).some(k => (byKind.get(k)?.length ?? 0) > 0);
    if (!hasAction) continue;
    lines.push(`## ${entityType}`);
    lines.push('');
    for (const kind of KIND_ORDER) {
      if (kind === 'KEEP') continue;
      const bucket = byKind.get(kind);
      if (!bucket || bucket.length === 0) continue;
      lines.push(`### ${kind} — ${bucket.length}`);
      lines.push('');
      const sample = bucket.slice(0, sampleSize);
      for (const e of sample) {
        const summary = entitySummary(e, kind);
        lines.push(`- ${summary}`);
      }
      if (bucket.length > sampleSize) {
        lines.push(`- _… +${bucket.length - sampleSize} weitere_`);
      }
      lines.push('');
    }
  }

  if (sortedTypes.length === 0) {
    lines.push('_Keine Entities im Blueprint._');
  }

  return lines.join('\n');
}

function entitySummary(e: AdsBlueprintEntityRow, kind: AdsBlueprintEntityKind): string {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(e.payload_json);
    payload = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as Record<string, unknown> : {};
  } catch { /* ignore */ }
  // Prefer the entity-type-specific name field over campaign_name for
  // sub-entities so a RENAME on an ad_group reads "ag-old-name → AG-New",
  // not "ag-old-name → ParentCampaignName".
  const entityTypeFieldOrder: Record<string, ReadonlyArray<string>> = {
    campaign: ['campaign_name'],
    ad_group: ['ad_group_name', 'campaign_name'],
    keyword: ['keyword', 'keyword_text'],
    asset_group: ['asset_group_name', 'campaign_name'],
    rsa_ad: ['ad_group_name', 'campaign_name'],
    asset: ['field_type', 'asset_group_name'],
    audience_signal: ['signal_label', 'asset_group_name'],
    negative: ['keyword_text', 'keyword'],
  };
  const fields = entityTypeFieldOrder[e.entity_type] ?? ['campaign_name', 'ad_group_name'];
  let name = '';
  for (const f of fields) {
    const v = stringField(payload, f);
    if (v) { name = v; break; }
  }
  if (!name) name = e.external_id;

  if (kind === 'RENAME' && e.previous_external_id) {
    return `\`${e.previous_external_id}\` → \`${name}\``;
  }
  return `\`${name}\``;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
