/**
 * Tool: ads_finding_inspect
 *
 * Conversational drill-in. Operator asks the agent "warum ist
 * pmax_brand_inflation HIGH?", agent calls this tool with the area,
 * gets back the finding's full evidence + a sample of raw snapshot
 * rows that triggered the detector. Agent can then explain in
 * natural language without another LLM round-trip for data-fetching.
 *
 * No LLM in this tool — pure data exposure. The agent (Lynox) reasons
 * over the data; this tool just hands it the right slice cheaply.
 *
 * Gated by feature flag 'ads-optimizer'.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import type { AdsDataStore, AdsFindingRow } from '../../core/ads-data-store.js';
import { getErrorMessage } from '../../core/utils.js';

interface AdsFindingInspectInput {
  ads_account_id: string;
  /** Finding area to drill into (e.g. "pmax_brand_inflation"). */
  area: string;
  /** Explicit run_id. Omit to use the latest run with findings. */
  run_id?: number | undefined;
  /** How many raw snapshot rows to sample (default 10, max 50). */
  sample_size?: number | undefined;
}

const DESCRIPTION = [
  'Drill into a specific audit finding without a second LLM round-trip.',
  '',
  'Returns the finding\'s pretty-printed evidence plus a sample of the underlying',
  'snapshot rows (e.g. the actual PMax search terms that triggered',
  'pmax_brand_inflation, the actual keywords behind quality_score_collapse).',
  '',
  'Use when the operator asks "why is X flagged?" — the response gives the agent',
  'the specific raw data so it can explain in plain language without re-querying.',
  '',
  'Returns Markdown with: finding text, severity, confidence, parsed evidence,',
  'and 10-50 raw rows from the most-relevant snapshot table for that area.',
].join('\n');

type SamplerKey =
  | 'pmax_brand_inflation' | 'pmax_theme_coverage_gap' | 'pmax_search_cannibalisation'
  | 'wasted_search_terms' | 'irrelevant_search_term_spend' | 'competitor_term_bidding'
  | 'quality_score_collapse' | 'disabled_converting_keyword'
  | 'audience_signal_thin' | 'pmax_asset_count_below_minimum'
  | 'low_ad_strength'
  | 'device_performance_outlier' | 'geo_performance_outlier'
  | 'campaign_target_underperformance_roas' | 'campaign_target_underperformance_cpa'
  | 'manual_change_drift' | 'performance_regression';

interface Sampler {
  table: string;
  pickColumns: readonly string[];
  /** Optional WHERE filter on top of (source_run_id, ads_account_id). */
  whereFragment?: string;
}

const SAMPLERS: Record<SamplerKey, Sampler> = {
  pmax_brand_inflation: {
    table: 'ads_pmax_search_terms',
    pickColumns: ['campaign_name', 'search_category'],
  },
  pmax_theme_coverage_gap: {
    table: 'ads_pmax_search_terms',
    pickColumns: ['campaign_name', 'search_category'],
  },
  pmax_search_cannibalisation: {
    table: 'ads_search_terms',
    pickColumns: ['campaign_name', 'ad_group_name', 'search_term', 'clicks', 'cost_micros', 'conversions'],
  },
  wasted_search_terms: {
    table: 'ads_search_terms',
    pickColumns: ['campaign_name', 'search_term', 'clicks', 'cost_micros', 'conversions'],
    whereFragment: `(conversions IS NULL OR conversions = 0) AND cost_micros > 1000000`,
  },
  irrelevant_search_term_spend: {
    table: 'ads_search_terms',
    pickColumns: ['campaign_name', 'search_term', 'clicks', 'cost_micros', 'conversions'],
    whereFragment: `(conversions IS NULL OR conversions = 0) AND clicks >= 5`,
  },
  competitor_term_bidding: {
    table: 'ads_search_terms',
    pickColumns: ['campaign_name', 'search_term', 'clicks', 'cost_micros', 'conversions'],
  },
  quality_score_collapse: {
    table: 'ads_keywords',
    pickColumns: ['campaign_name', 'ad_group_name', 'keyword', 'match_type', 'quality_score', 'cost_micros', 'clicks'],
    whereFragment: `quality_score IS NOT NULL AND quality_score < 4`,
  },
  disabled_converting_keyword: {
    table: 'ads_keywords',
    pickColumns: ['campaign_name', 'ad_group_name', 'keyword', 'match_type', 'status', 'conversions', 'conv_value'],
    whereFragment: `status NOT IN ('ENABLED', 'ACTIVE') AND conversions > 0`,
  },
  audience_signal_thin: {
    table: 'ads_audience_signals',
    pickColumns: ['campaign_name', 'asset_group_name', 'signal_type', 'signal_label'],
  },
  pmax_asset_count_below_minimum: {
    table: 'ads_asset_group_assets',
    pickColumns: ['campaign_name', 'asset_group_name', 'field_type', 'asset_status', 'text_content'],
  },
  low_ad_strength: {
    table: 'ads_asset_groups',
    pickColumns: ['campaign_name', 'asset_group_name', 'ad_strength', 'cost_micros', 'conversions'],
    whereFragment: `ad_strength IN ('POOR', 'AVERAGE')`,
  },
  device_performance_outlier: {
    table: 'ads_device_performance',
    pickColumns: ['campaign_name', 'device', 'clicks', 'cost_micros', 'conversions'],
  },
  geo_performance_outlier: {
    table: 'ads_geo_performance',
    pickColumns: ['campaign_name', 'geo_target_region', 'clicks', 'cost_micros', 'conversions'],
  },
  campaign_target_underperformance_roas: {
    table: 'ads_campaigns',
    pickColumns: ['campaign_name', 'channel_type', 'cost_micros', 'conversions', 'conv_value', 'target_roas'],
  },
  campaign_target_underperformance_cpa: {
    table: 'ads_campaigns',
    pickColumns: ['campaign_name', 'channel_type', 'cost_micros', 'conversions', 'target_cpa_micros'],
  },
  manual_change_drift: {
    table: 'ads_change_history',
    pickColumns: ['change_date', 'resource_type', 'operation', 'user_email', 'resource_name'],
  },
  performance_regression: {
    table: 'ads_campaigns',
    pickColumns: ['campaign_name', 'channel_type', 'cost_micros', 'conversions', 'conv_value'],
  },
};

const SAMPLE_DEFAULT = 10;
const SAMPLE_MAX = 50;

export function createAdsFindingInspectTool(
  store: AdsDataStore,
): ToolEntry<AdsFindingInspectInput> {
  return {
    definition: {
      name: 'ads_finding_inspect',
      description: DESCRIPTION,
      input_schema: {
        type: 'object' as const,
        properties: {
          ads_account_id: {
            type: 'string',
            description: 'Google Ads Customer ID, e.g. "123-456-7890".',
          },
          area: {
            type: 'string',
            description: 'Finding area to inspect (e.g. "pmax_brand_inflation", "quality_score_collapse").',
          },
          run_id: {
            type: 'integer',
            description: 'Explicit run id. Omit to use the latest run with findings.',
          },
          sample_size: {
            type: 'integer',
            description: 'How many raw snapshot rows to sample (default 10, max 50).',
          },
        },
        required: ['ads_account_id', 'area'],
      },
    },
    handler: async (input: AdsFindingInspectInput, _agent: IAgent): Promise<string> => {
      try {
        const account = store.getAdsAccount(input.ads_account_id);
        if (!account) {
          return `ads_finding_inspect failed: unknown ads_account_id "${input.ads_account_id}".`;
        }
        const runId = input.run_id ?? resolveLatestRunIdWithFindings(store, input.ads_account_id);
        if (runId === null) {
          return `ads_finding_inspect: keine Audit-Runs mit Findings für ${input.ads_account_id}.`;
        }
        const findings = store.listFindings(runId, { area: input.area });
        if (findings.length === 0) {
          return `ads_finding_inspect: kein Finding "${input.area}" auf Run #${runId}. ` +
            `Verfügbare Areas: ${listAreas(store, runId).join(', ')}.`;
        }
        const finding = findings[0]!;
        const sampleSize = clampSampleSize(input.sample_size);
        const rawRows = sampleRawRows(store, finding, input.ads_account_id, runId, sampleSize);

        return renderInspectMarkdown(finding, rawRows, sampleSize);
      } catch (err) {
        return `ads_finding_inspect failed: ${getErrorMessage(err)}`;
      }
    },
  };
}

function resolveLatestRunIdWithFindings(store: AdsDataStore, adsAccountId: string): number | null {
  const runs = store.listAuditRuns(adsAccountId, 20);
  for (const r of runs) {
    if (r.status !== 'SUCCESS') continue;
    if (store.listFindings(r.run_id).length > 0) return r.run_id;
  }
  return null;
}

function listAreas(store: AdsDataStore, runId: number): string[] {
  const areas = new Set<string>();
  for (const f of store.listFindings(runId)) areas.add(f.area);
  return Array.from(areas).sort();
}

function clampSampleSize(s: number | undefined): number {
  if (typeof s !== 'number' || !Number.isFinite(s)) return SAMPLE_DEFAULT;
  return Math.max(1, Math.min(SAMPLE_MAX, Math.floor(s)));
}

function sampleRawRows(
  store: AdsDataStore, finding: AdsFindingRow, adsAccountId: string, runId: number, sampleSize: number,
): { table: string; rows: Record<string, unknown>[] } | null {
  const sampler = (SAMPLERS as Record<string, Sampler>)[finding.area];
  if (!sampler) return null;
  const cols = sampler.pickColumns.join(', ');
  const where = sampler.whereFragment ? `AND ${sampler.whereFragment}` : '';
  // Use the unsafeQuery escape via direct prepare since AdsDataStore
  // doesn't expose a generic SELECT helper. The columns + table are
  // hardcoded per-area so user input never reaches the SQL.
  const raw = store as unknown as { db?: { prepare(sql: string): { all(...args: unknown[]): unknown[] } } };
  if (!raw.db) return null;
  try {
    const rows = raw.db.prepare(
      `SELECT ${cols} FROM ${sampler.table}
       WHERE source_run_id = ? AND ads_account_id = ? ${where}
       LIMIT ?`,
    ).all(runId, adsAccountId, sampleSize) as Record<string, unknown>[];
    return { table: sampler.table, rows };
  } catch {
    return null;
  }
}

function renderInspectMarkdown(
  finding: AdsFindingRow,
  raw: { table: string; rows: Record<string, unknown>[] } | null,
  sampleSize: number,
): string {
  const lines: string[] = [];
  lines.push(`# Finding inspect — ${finding.area}`);
  lines.push('');
  lines.push(`**Severity:** ${finding.severity}`);
  lines.push(`**Source:** ${finding.source}`);
  lines.push(`**Confidence:** ${finding.confidence.toFixed(2)}`);
  lines.push('');
  lines.push('## Beschreibung');
  lines.push('');
  lines.push(finding.text);
  lines.push('');
  lines.push('## Evidence (parsed)');
  lines.push('');
  lines.push('```json');
  try {
    const parsed = JSON.parse(finding.evidence_json);
    lines.push(JSON.stringify(parsed, null, 2));
  } catch {
    lines.push(finding.evidence_json);
  }
  lines.push('```');
  lines.push('');

  if (raw === null) {
    lines.push('## Raw rows');
    lines.push('');
    lines.push(`_Kein Sampler konfiguriert für area "${finding.area}". Nur Evidence verfügbar._`);
    return lines.join('\n');
  }
  if (raw.rows.length === 0) {
    lines.push(`## Raw rows from \`${raw.table}\``);
    lines.push('');
    lines.push('_Keine Zeilen gefunden — Filter zu eng oder Tabelle leer._');
    return lines.join('\n');
  }
  lines.push(`## Raw rows from \`${raw.table}\` (sample ${raw.rows.length}/${sampleSize})`);
  lines.push('');
  // Render as Markdown table with the keys from the first row.
  const cols = Object.keys(raw.rows[0]!);
  lines.push(`| ${cols.join(' | ')} |`);
  lines.push(`|${cols.map(() => '---').join('|')}|`);
  for (const row of raw.rows) {
    const cells = cols.map(c => formatCell(row[c]));
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v).replace(/\|/g, '\\|').slice(0, 120);
}
