/**
 * Pure CSV-parsing layer for the Ads Optimizer pipeline.
 *
 * Reads the 22-CSV pack (Ads) + GA4 monthly + GSC monthly outputs produced
 * by the customer-deployed Apps Scripts in their own Google Drive.
 *
 * Design contract:
 *   - INPUT: raw CSV text (UTF-8) read from Drive — never SQL.
 *   - OUTPUT: typed Snapshot objects ready for AdsDataStore bulk inserts.
 *   - VALIDATION:
 *       * missing required header → ParseError (run fails)
 *       * extra unknown headers → ParseWarning (run continues)
 *       * malformed numeric value → ParseWarning, field becomes undefined
 *       * 'undefined' / '' → null/undefined (Apps Scripts emit these for
 *         missing metrics; treat as absence, not value 0)
 */
import { parse } from 'csv-parse/sync';
import type {
  CampaignSnapshot,
  CampaignPerformanceSnapshot,
  AdGroupSnapshot,
  KeywordSnapshot,
  RsaAdSnapshot,
  AssetGroupSnapshot,
  AssetGroupAssetSnapshot,
  AssetSnapshot,
  ListingGroupSnapshot,
  ShoppingProductSnapshot,
  ConversionActionSnapshot,
  CampaignTargetingSnapshot,
  SearchTermSnapshot,
  PmaxSearchTermSnapshot,
  PmaxPlacementSnapshot,
  LandingPageSnapshot,
  AdAssetRatingSnapshot,
  AudienceSignalSnapshot,
  DevicePerformanceSnapshot,
  GeoPerformanceSnapshot,
  ChangeHistorySnapshot,
  Ga4ObservationSnapshot,
  GscObservationSnapshot,
} from './ads-snapshot-types.js';

// ── Public Types ────────────────────────────────────────────────

export interface ParseWarning {
  file: string;
  message: string;
  line?: number | undefined;
}

export class ParseError extends Error {
  readonly file: string;
  readonly line: number | undefined;
  constructor(file: string, message: string, line?: number | undefined) {
    super(`[${file}${line !== undefined ? `:${line}` : ''}] ${message}`);
    this.name = 'ParseError';
    this.file = file;
    this.line = line;
  }
}

export interface ParseResult<T> {
  rows: T[];
  warnings: ParseWarning[];
}

interface CsvSchema {
  required: readonly string[];
  optional: readonly string[];
}

// ── Schemas (22 ads + GA4 + GSC) ────────────────────────────────
// Required columns must be present. Extras get a warning, do not fail.

const SCHEMAS = {
  campaigns: {
    required: ['campaign_id', 'campaign_name'],
    optional: ['status', 'channel_type', 'opt_score', 'budget_micros',
      'impressions', 'clicks', 'cost_micros', 'conversions', 'conv_value',
      'ctr', 'avg_cpc', 'search_is', 'search_top_is', 'search_abs_top_is',
      'budget_lost_is', 'rank_lost_is'],
  },
  campaign_performance: {
    required: ['date', 'campaign_id'],
    optional: ['campaign_name', 'channel_type', 'impressions', 'clicks',
      'cost_micros', 'conversions', 'conv_value'],
  },
  ad_groups: {
    required: ['campaign_name', 'ad_group_name'],
    optional: ['campaign_id', 'ad_group_id', 'status', 'impressions', 'clicks',
      'cost_micros', 'conversions', 'conv_value', 'ctr', 'avg_cpc'],
  },
  keywords: {
    required: ['campaign_name', 'ad_group_name', 'keyword'],
    optional: ['match_type', 'status', 'quality_score', 'impressions', 'clicks',
      'cost_micros', 'conversions', 'conv_value', 'ctr', 'avg_cpc', 'search_is'],
  },
  ads_rsa: {
    required: ['campaign_name', 'ad_group_name', 'ad_id'],
    optional: ['headlines', 'descriptions', 'final_url', 'status', 'ad_strength',
      'impressions', 'clicks', 'cost_micros', 'conversions', 'ctr'],
  },
  asset_groups: {
    required: ['asset_group_id', 'asset_group_name'],
    optional: ['campaign_id', 'campaign_name', 'status', 'ad_strength',
      'impressions', 'clicks', 'cost_micros', 'conversions', 'conv_value'],
  },
  asset_group_assets: {
    required: ['asset_group_name', 'field_type'],
    optional: ['campaign_name', 'asset_status', 'asset_id', 'asset_name',
      'asset_type', 'text_content', 'image_url'],
  },
  assets: {
    required: ['asset_id', 'type'],
    optional: ['name', 'sitelink_text', 'sitelink_desc1', 'sitelink_desc2',
      'callout_text', 'snippet_header', 'snippet_values'],
  },
  listing_groups: {
    required: [] as readonly string[],
    optional: ['campaign_name', 'asset_group_name', 'filter_id', 'filter_type',
      'brand', 'category_id', 'product_type', 'custom_attribute'],
  },
  shopping_products: {
    required: [] as readonly string[],
    optional: ['campaign_name', 'item_id', 'title', 'brand', 'status', 'channel',
      'language', 'issues', 'impressions', 'clicks', 'cost_micros'],
  },
  conversions: {
    required: ['conv_action_id'],
    optional: ['name', 'type', 'category', 'status', 'primary_for_goal',
      'counting_type', 'attribution_model', 'default_value', 'in_conversions_metric'],
  },
  campaign_targeting: {
    required: ['criterion_type'],
    optional: ['campaign_id', 'campaign_name', 'is_negative', 'status',
      'bid_modifier', 'geo_target', 'language', 'keyword_text', 'match_type'],
  },
  search_terms: {
    required: ['search_term'],
    optional: ['campaign_name', 'channel_type', 'ad_group_name', 'term_status',
      'impressions', 'clicks', 'cost_micros', 'conversions', 'conv_value', 'ctr'],
  },
  pmax_search_terms: {
    required: [] as readonly string[],
    optional: ['campaign_id', 'campaign_name', 'search_category', 'insight_id'],
  },
  pmax_placements: {
    required: [] as readonly string[],
    optional: ['campaign_id', 'campaign_name', 'placement', 'placement_type', 'target_url'],
  },
  landing_pages: {
    required: ['landing_page_url'],
    optional: ['campaign_name', 'impressions', 'clicks', 'cost_micros',
      'conversions', 'conv_value', 'avg_cpc'],
  },
  ad_asset_ratings: {
    required: ['field_type'],
    optional: ['campaign_name', 'ad_group_name', 'performance_label', 'enabled',
      'text_content', 'impressions', 'clicks', 'cost_micros', 'conversions'],
  },
  audience_signals: {
    required: [] as readonly string[],
    optional: ['campaign_name', 'asset_group_name', 'signal_type', 'signal_label'],
  },
  device_performance: {
    required: ['device'],
    optional: ['campaign_id', 'campaign_name', 'channel_type', 'impressions',
      'clicks', 'cost_micros', 'conversions', 'conv_value', 'ctr'],
  },
  geo_performance: {
    required: [] as readonly string[],
    optional: ['campaign_id', 'campaign_name', 'country_id', 'location_type',
      'geo_target_region', 'impressions', 'clicks', 'cost_micros',
      'conversions', 'conv_value'],
  },
  change_history: {
    required: ['change_date'],
    optional: ['resource_type', 'operation', 'changed_fields', 'user_email',
      'client_type', 'campaign_name'],
  },
  ga4: {
    required: ['date'],
    optional: ['session_source', 'session_medium', 'sessions', 'total_users',
      'new_users', 'bounce_rate', 'avg_session_duration', 'conversions', 'event_count'],
  },
  gsc: {
    required: ['date_month'],
    optional: ['query', 'page', 'country', 'device', 'clicks', 'impressions',
      'ctr', 'position'],
  },
} as const satisfies Record<string, CsvSchema>;

export type AdsCsvKind = keyof typeof SCHEMAS;

export const ALL_ADS_CSV_KINDS: readonly AdsCsvKind[] = [
  'campaigns', 'campaign_performance', 'ad_groups', 'keywords', 'ads_rsa',
  'asset_groups', 'asset_group_assets', 'assets', 'listing_groups',
  'shopping_products', 'conversions', 'campaign_targeting', 'search_terms',
  'pmax_search_terms', 'pmax_placements', 'landing_pages', 'ad_asset_ratings',
  'audience_signals', 'device_performance', 'geo_performance', 'change_history',
];

// Filename convention: <kind>.csv for ads pack (no monthly prefix).
export const ADS_FILENAME: Record<AdsCsvKind, string> = {
  campaigns: 'campaigns.csv',
  campaign_performance: 'campaign_performance.csv',
  ad_groups: 'ad_groups.csv',
  keywords: 'keywords.csv',
  ads_rsa: 'ads_rsa.csv',
  asset_groups: 'asset_groups.csv',
  asset_group_assets: 'asset_group_assets.csv',
  assets: 'assets.csv',
  listing_groups: 'listing_groups.csv',
  shopping_products: 'shopping_products.csv',
  conversions: 'conversions.csv',
  campaign_targeting: 'campaign_targeting.csv',
  search_terms: 'search_terms.csv',
  pmax_search_terms: 'pmax_search_terms.csv',
  pmax_placements: 'pmax_placements.csv',
  landing_pages: 'landing_pages.csv',
  ad_asset_ratings: 'ad_asset_ratings.csv',
  audience_signals: 'audience_signals.csv',
  device_performance: 'device_performance.csv',
  geo_performance: 'geo_performance.csv',
  change_history: 'change_history.csv',
  ga4: 'ga4_*.csv',
  gsc: 'gsc_*.csv',
};

// ── Value Coercion Helpers ──────────────────────────────────────

/** "undefined", "", null → undefined. Otherwise string. */
function strVal(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const trimmed = s.trim();
  if (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') return undefined;
  return trimmed;
}

/** Returns number or undefined; pushes warning if value is non-numeric and non-empty. */
function numVal(s: string | undefined, file: string, line: number, field: string, warnings: ParseWarning[]): number | undefined {
  const trimmed = strVal(s);
  if (trimmed === undefined) return undefined;
  const n = Number(trimmed);
  if (Number.isNaN(n)) {
    warnings.push({ file, line, message: `Non-numeric value "${trimmed}" in column "${field}", treated as null` });
    return undefined;
  }
  return n;
}

function intVal(s: string | undefined, file: string, line: number, field: string, warnings: ParseWarning[]): number | undefined {
  const n = numVal(s, file, line, field, warnings);
  if (n === undefined) return undefined;
  return Math.trunc(n);
}

function boolVal(s: string | undefined): boolean | undefined {
  const trimmed = strVal(s);
  if (trimmed === undefined) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return undefined;
}

/** Parses pipe- or comma-separated values into a list (RSA headlines/descriptions
 *  arrive as a single quoted CSV cell joined by ' | '). */
function listVal(s: string | undefined): string[] | undefined {
  const trimmed = strVal(s);
  if (trimmed === undefined) return undefined;
  // Common GAS conventions: " | " separator OR newline. Comma is ambiguous
  // (ad copy contains commas), so we don't split on it.
  return trimmed.split(/\s*\|\s*|\n/).map(p => p.trim()).filter(p => p.length > 0);
}

// ── Header Validation ───────────────────────────────────────────

interface HeaderResult {
  warnings: ParseWarning[];
}

function validateHeaders(file: string, kind: AdsCsvKind, headers: readonly string[]): HeaderResult {
  const schema = SCHEMAS[kind];
  const warnings: ParseWarning[] = [];
  const headerSet = new Set(headers.map(h => h.trim()));
  // Missing required → throw.
  for (const req of schema.required) {
    if (!headerSet.has(req)) {
      throw new ParseError(file, `Missing required column "${req}" (have: ${headers.join(', ')})`);
    }
  }
  // Extra unknown → warn.
  const known = new Set([...schema.required, ...schema.optional]);
  for (const h of headers) {
    if (!known.has(h.trim())) {
      warnings.push({ file, message: `Unknown column "${h}" — ignored` });
    }
  }
  return { warnings };
}

// ── Generic CSV Parser ──────────────────────────────────────────

/** Parses CSV text into row objects (snake_case keyed). Skips empty rows. */
function parseCsvText(file: string, text: string): { rows: Record<string, string>[]; headers: readonly string[] } {
  // Strip UTF-8 BOM if present (Apps Scripts sometimes emit it).
  const cleaned = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const records = parse(cleaned, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
  }) as Record<string, string>[];
  // csv-parse exposes the column list via the first record's keys (since
  // columns:true); recover from records[0] or empty when no rows.
  const headers = records.length > 0 ? Object.keys(records[0]!) : [];
  if (records.length === 0 && cleaned.trim().length > 0) {
    // File has content but no rows after parsing — try to recover the header line.
    const firstLine = cleaned.split('\n', 1)[0]!;
    if (firstLine.length > 0) {
      const guessed = firstLine.split(',').map(s => s.trim().replace(/^"(.*)"$/, '$1'));
      return { rows: [], headers: guessed };
    }
  }
  if (records.length === 0) {
    throw new ParseError(file, 'CSV is empty (no header row)');
  }
  return { rows: records, headers };
}

// ── Per-CSV Mapper Functions ────────────────────────────────────

type Mapper<T> = (row: Record<string, string>, file: string, line: number, warnings: ParseWarning[]) => T;

const MAPPERS = {
  campaigns: (r, f, l, w): CampaignSnapshot => ({
    campaignId: strVal(r['campaign_id']) ?? '',
    campaignName: strVal(r['campaign_name']) ?? '',
    status: strVal(r['status']),
    channelType: strVal(r['channel_type']),
    optScore: numVal(r['opt_score'], f, l, 'opt_score', w),
    budgetMicros: intVal(r['budget_micros'], f, l, 'budget_micros', w),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    costMicros: intVal(r['cost_micros'], f, l, 'cost_micros', w),
    conversions: numVal(r['conversions'], f, l, 'conversions', w),
    convValue: numVal(r['conv_value'], f, l, 'conv_value', w),
    ctr: numVal(r['ctr'], f, l, 'ctr', w),
    avgCpc: numVal(r['avg_cpc'], f, l, 'avg_cpc', w),
    searchIs: numVal(r['search_is'], f, l, 'search_is', w),
    searchTopIs: numVal(r['search_top_is'], f, l, 'search_top_is', w),
    searchAbsTopIs: numVal(r['search_abs_top_is'], f, l, 'search_abs_top_is', w),
    budgetLostIs: numVal(r['budget_lost_is'], f, l, 'budget_lost_is', w),
    rankLostIs: numVal(r['rank_lost_is'], f, l, 'rank_lost_is', w),
  }),
  campaign_performance: (r, f, l, w): CampaignPerformanceSnapshot => ({
    date: strVal(r['date']) ?? '',
    campaignId: strVal(r['campaign_id']) ?? '',
    campaignName: strVal(r['campaign_name']),
    channelType: strVal(r['channel_type']),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    costMicros: intVal(r['cost_micros'], f, l, 'cost_micros', w),
    conversions: numVal(r['conversions'], f, l, 'conversions', w),
    convValue: numVal(r['conv_value'], f, l, 'conv_value', w),
  }),
  ad_groups: (r, f, l, w): AdGroupSnapshot => ({
    campaignName: strVal(r['campaign_name']) ?? '',
    adGroupName: strVal(r['ad_group_name']) ?? '',
    campaignId: strVal(r['campaign_id']),
    adGroupId: strVal(r['ad_group_id']),
    status: strVal(r['status']),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    costMicros: intVal(r['cost_micros'], f, l, 'cost_micros', w),
    conversions: numVal(r['conversions'], f, l, 'conversions', w),
    convValue: numVal(r['conv_value'], f, l, 'conv_value', w),
    ctr: numVal(r['ctr'], f, l, 'ctr', w),
    avgCpc: numVal(r['avg_cpc'], f, l, 'avg_cpc', w),
  }),
  keywords: (r, f, l, w): KeywordSnapshot => ({
    campaignName: strVal(r['campaign_name']) ?? '',
    adGroupName: strVal(r['ad_group_name']) ?? '',
    keyword: strVal(r['keyword']) ?? '',
    matchType: strVal(r['match_type']),
    status: strVal(r['status']),
    qualityScore: intVal(r['quality_score'], f, l, 'quality_score', w),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    costMicros: intVal(r['cost_micros'], f, l, 'cost_micros', w),
    conversions: numVal(r['conversions'], f, l, 'conversions', w),
    convValue: numVal(r['conv_value'], f, l, 'conv_value', w),
    ctr: numVal(r['ctr'], f, l, 'ctr', w),
    avgCpc: numVal(r['avg_cpc'], f, l, 'avg_cpc', w),
    searchIs: numVal(r['search_is'], f, l, 'search_is', w),
  }),
  ads_rsa: (r, f, l, w): RsaAdSnapshot => ({
    campaignName: strVal(r['campaign_name']) ?? '',
    adGroupName: strVal(r['ad_group_name']) ?? '',
    adId: strVal(r['ad_id']) ?? '',
    headlines: listVal(r['headlines']),
    descriptions: listVal(r['descriptions']),
    finalUrl: strVal(r['final_url']),
    status: strVal(r['status']),
    adStrength: strVal(r['ad_strength']),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    costMicros: intVal(r['cost_micros'], f, l, 'cost_micros', w),
    conversions: numVal(r['conversions'], f, l, 'conversions', w),
    ctr: numVal(r['ctr'], f, l, 'ctr', w),
  }),
  asset_groups: (r, f, l, w): AssetGroupSnapshot => ({
    assetGroupId: strVal(r['asset_group_id']) ?? '',
    assetGroupName: strVal(r['asset_group_name']) ?? '',
    campaignId: strVal(r['campaign_id']),
    campaignName: strVal(r['campaign_name']),
    status: strVal(r['status']),
    adStrength: strVal(r['ad_strength']),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    costMicros: intVal(r['cost_micros'], f, l, 'cost_micros', w),
    conversions: numVal(r['conversions'], f, l, 'conversions', w),
    convValue: numVal(r['conv_value'], f, l, 'conv_value', w),
  }),
  asset_group_assets: (r): AssetGroupAssetSnapshot => ({
    assetGroupName: strVal(r['asset_group_name']) ?? '',
    fieldType: strVal(r['field_type']) ?? '',
    campaignName: strVal(r['campaign_name']),
    assetStatus: strVal(r['asset_status']),
    assetId: strVal(r['asset_id']),
    assetName: strVal(r['asset_name']),
    assetType: strVal(r['asset_type']),
    textContent: strVal(r['text_content']),
    imageUrl: strVal(r['image_url']),
  }),
  assets: (r): AssetSnapshot => ({
    assetId: strVal(r['asset_id']) ?? '',
    type: strVal(r['type']) ?? '',
    name: strVal(r['name']),
    sitelinkText: strVal(r['sitelink_text']),
    sitelinkDesc1: strVal(r['sitelink_desc1']),
    sitelinkDesc2: strVal(r['sitelink_desc2']),
    calloutText: strVal(r['callout_text']),
    snippetHeader: strVal(r['snippet_header']),
    snippetValues: strVal(r['snippet_values']),
  }),
  listing_groups: (r): ListingGroupSnapshot => ({
    campaignName: strVal(r['campaign_name']),
    assetGroupName: strVal(r['asset_group_name']),
    filterId: strVal(r['filter_id']),
    filterType: strVal(r['filter_type']),
    brand: strVal(r['brand']),
    categoryId: strVal(r['category_id']),
    productType: strVal(r['product_type']),
    customAttribute: strVal(r['custom_attribute']),
  }),
  shopping_products: (r, f, l, w): ShoppingProductSnapshot => ({
    campaignName: strVal(r['campaign_name']),
    itemId: strVal(r['item_id']),
    title: strVal(r['title']),
    brand: strVal(r['brand']),
    status: strVal(r['status']),
    channel: strVal(r['channel']),
    language: strVal(r['language']),
    issues: strVal(r['issues']),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    costMicros: intVal(r['cost_micros'], f, l, 'cost_micros', w),
  }),
  conversions: (r, f, l, w): ConversionActionSnapshot => ({
    convActionId: strVal(r['conv_action_id']) ?? '',
    name: strVal(r['name']),
    type: strVal(r['type']),
    category: strVal(r['category']),
    status: strVal(r['status']),
    primaryForGoal: boolVal(r['primary_for_goal']),
    countingType: strVal(r['counting_type']),
    attributionModel: strVal(r['attribution_model']),
    defaultValue: numVal(r['default_value'], f, l, 'default_value', w),
    inConversionsMetric: boolVal(r['in_conversions_metric']),
  }),
  campaign_targeting: (r, f, l, w): CampaignTargetingSnapshot => ({
    criterionType: strVal(r['criterion_type']) ?? '',
    campaignId: strVal(r['campaign_id']),
    campaignName: strVal(r['campaign_name']),
    isNegative: boolVal(r['is_negative']),
    status: strVal(r['status']),
    bidModifier: numVal(r['bid_modifier'], f, l, 'bid_modifier', w),
    geoTarget: strVal(r['geo_target']),
    language: strVal(r['language']),
    keywordText: strVal(r['keyword_text']),
    matchType: strVal(r['match_type']),
  }),
  search_terms: (r, f, l, w): SearchTermSnapshot => ({
    searchTerm: strVal(r['search_term']) ?? '',
    campaignName: strVal(r['campaign_name']),
    channelType: strVal(r['channel_type']),
    adGroupName: strVal(r['ad_group_name']),
    termStatus: strVal(r['term_status']),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    costMicros: intVal(r['cost_micros'], f, l, 'cost_micros', w),
    conversions: numVal(r['conversions'], f, l, 'conversions', w),
    convValue: numVal(r['conv_value'], f, l, 'conv_value', w),
    ctr: numVal(r['ctr'], f, l, 'ctr', w),
  }),
  pmax_search_terms: (r): PmaxSearchTermSnapshot => ({
    campaignId: strVal(r['campaign_id']),
    campaignName: strVal(r['campaign_name']),
    searchCategory: strVal(r['search_category']),
    insightId: strVal(r['insight_id']),
  }),
  pmax_placements: (r): PmaxPlacementSnapshot => ({
    campaignId: strVal(r['campaign_id']),
    campaignName: strVal(r['campaign_name']),
    placement: strVal(r['placement']),
    placementType: strVal(r['placement_type']),
    targetUrl: strVal(r['target_url']),
  }),
  landing_pages: (r, f, l, w): LandingPageSnapshot => ({
    landingPageUrl: strVal(r['landing_page_url']) ?? '',
    campaignName: strVal(r['campaign_name']),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    costMicros: intVal(r['cost_micros'], f, l, 'cost_micros', w),
    conversions: numVal(r['conversions'], f, l, 'conversions', w),
    convValue: numVal(r['conv_value'], f, l, 'conv_value', w),
    avgCpc: numVal(r['avg_cpc'], f, l, 'avg_cpc', w),
  }),
  ad_asset_ratings: (r, f, l, w): AdAssetRatingSnapshot => ({
    fieldType: strVal(r['field_type']) ?? '',
    campaignName: strVal(r['campaign_name']),
    adGroupName: strVal(r['ad_group_name']),
    performanceLabel: strVal(r['performance_label']),
    enabled: boolVal(r['enabled']),
    textContent: strVal(r['text_content']),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    costMicros: intVal(r['cost_micros'], f, l, 'cost_micros', w),
    conversions: numVal(r['conversions'], f, l, 'conversions', w),
  }),
  audience_signals: (r): AudienceSignalSnapshot => ({
    campaignName: strVal(r['campaign_name']),
    assetGroupName: strVal(r['asset_group_name']),
    signalType: strVal(r['signal_type']),
    signalLabel: strVal(r['signal_label']),
  }),
  device_performance: (r, f, l, w): DevicePerformanceSnapshot => ({
    device: strVal(r['device']) ?? '',
    campaignId: strVal(r['campaign_id']),
    campaignName: strVal(r['campaign_name']),
    channelType: strVal(r['channel_type']),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    costMicros: intVal(r['cost_micros'], f, l, 'cost_micros', w),
    conversions: numVal(r['conversions'], f, l, 'conversions', w),
    convValue: numVal(r['conv_value'], f, l, 'conv_value', w),
    ctr: numVal(r['ctr'], f, l, 'ctr', w),
  }),
  geo_performance: (r, f, l, w): GeoPerformanceSnapshot => ({
    campaignId: strVal(r['campaign_id']),
    campaignName: strVal(r['campaign_name']),
    countryId: strVal(r['country_id']),
    locationType: strVal(r['location_type']),
    geoTargetRegion: strVal(r['geo_target_region']),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    costMicros: intVal(r['cost_micros'], f, l, 'cost_micros', w),
    conversions: numVal(r['conversions'], f, l, 'conversions', w),
    convValue: numVal(r['conv_value'], f, l, 'conv_value', w),
  }),
  change_history: (r): ChangeHistorySnapshot => ({
    changeDate: strVal(r['change_date']) ?? '',
    resourceType: strVal(r['resource_type']),
    operation: strVal(r['operation']),
    changedFields: strVal(r['changed_fields']),
    userEmail: strVal(r['user_email']),
    clientType: strVal(r['client_type']),
    campaignName: strVal(r['campaign_name']),
  }),
  ga4: (r, f, l, w): Ga4ObservationSnapshot => ({
    date: strVal(r['date']) ?? '',
    sessionSource: strVal(r['session_source']),
    sessionMedium: strVal(r['session_medium']),
    sessions: intVal(r['sessions'], f, l, 'sessions', w),
    totalUsers: intVal(r['total_users'], f, l, 'total_users', w),
    newUsers: intVal(r['new_users'], f, l, 'new_users', w),
    bounceRate: numVal(r['bounce_rate'], f, l, 'bounce_rate', w),
    avgSessionDuration: numVal(r['avg_session_duration'], f, l, 'avg_session_duration', w),
    conversions: numVal(r['conversions'], f, l, 'conversions', w),
    eventCount: intVal(r['event_count'], f, l, 'event_count', w),
  }),
  gsc: (r, f, l, w): GscObservationSnapshot => ({
    dateMonth: strVal(r['date_month']) ?? '',
    query: strVal(r['query']),
    page: strVal(r['page']),
    country: strVal(r['country']),
    device: strVal(r['device']),
    clicks: intVal(r['clicks'], f, l, 'clicks', w),
    impressions: intVal(r['impressions'], f, l, 'impressions', w),
    ctr: numVal(r['ctr'], f, l, 'ctr', w),
    position: numVal(r['position'], f, l, 'position', w),
  }),
} as const satisfies Record<AdsCsvKind, Mapper<unknown>>;

// ── Public API: parse a single CSV (text → snapshots) ───────────

// Maps each kind to its snapshot type (for typed return).
export type SnapshotForKind<K extends AdsCsvKind> =
    K extends 'campaigns' ? CampaignSnapshot
  : K extends 'campaign_performance' ? CampaignPerformanceSnapshot
  : K extends 'ad_groups' ? AdGroupSnapshot
  : K extends 'keywords' ? KeywordSnapshot
  : K extends 'ads_rsa' ? RsaAdSnapshot
  : K extends 'asset_groups' ? AssetGroupSnapshot
  : K extends 'asset_group_assets' ? AssetGroupAssetSnapshot
  : K extends 'assets' ? AssetSnapshot
  : K extends 'listing_groups' ? ListingGroupSnapshot
  : K extends 'shopping_products' ? ShoppingProductSnapshot
  : K extends 'conversions' ? ConversionActionSnapshot
  : K extends 'campaign_targeting' ? CampaignTargetingSnapshot
  : K extends 'search_terms' ? SearchTermSnapshot
  : K extends 'pmax_search_terms' ? PmaxSearchTermSnapshot
  : K extends 'pmax_placements' ? PmaxPlacementSnapshot
  : K extends 'landing_pages' ? LandingPageSnapshot
  : K extends 'ad_asset_ratings' ? AdAssetRatingSnapshot
  : K extends 'audience_signals' ? AudienceSignalSnapshot
  : K extends 'device_performance' ? DevicePerformanceSnapshot
  : K extends 'geo_performance' ? GeoPerformanceSnapshot
  : K extends 'change_history' ? ChangeHistorySnapshot
  : K extends 'ga4' ? Ga4ObservationSnapshot
  : K extends 'gsc' ? GscObservationSnapshot
  : never;

export function parseAdsCsv<K extends AdsCsvKind>(
  kind: K,
  fileLabel: string,
  text: string,
): ParseResult<SnapshotForKind<K>> {
  const { rows, headers } = parseCsvText(fileLabel, text);
  const headerCheck = validateHeaders(fileLabel, kind, headers);
  const warnings: ParseWarning[] = [...headerCheck.warnings];
  const mapper = MAPPERS[kind] as Mapper<SnapshotForKind<K>>;
  const out: SnapshotForKind<K>[] = [];
  // line numbers are 1-based (header is line 1, first data row is line 2)
  let line = 2;
  for (const row of rows) {
    out.push(mapper(row, fileLabel, line, warnings));
    line++;
  }
  return { rows: out, warnings };
}
