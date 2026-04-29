/**
 * Google Ads Editor CSV builder — full 183-column schema.
 *
 * TypeScript port of the canonical row-emit logic with native
 * TypeScript row builders for every entity type the Blueprint phase
 * produces. Output matches what Editor's "File → Export → Selected
 * campaigns" produces, so an "Account → Import → From file" round-trip
 * lands rows on the right entities.
 *
 * Encoding: UTF-16 LE with leading BOM (0xFF 0xFE), TAB separators,
 * CRLF line endings. Editor refuses CSVs without the BOM on Windows
 * and silently mis-parses non-ASCII when fed UTF-8.
 *
 * Coverage:
 *   - Search:  Campaign, AdGroup, Keyword, RSA, Sitelink, Callout,
 *              Negative keyword, Location.
 *   - PMAX:    Campaign (Performance Max), Asset Group, Asset
 *              (text/image/video), Audience Signal, Listing Group.
 *
 * NEW entities default to Status=Paused so nothing goes live until
 * the customer reviews + posts in Editor.
 */

// ── 183-column ordered schema ─────────────────────────────────────────
// Editor matches columns by header name AND order. Reordering requires
// a coordinated update on the consuming Editor side.

export const EDITOR_COLUMNS = [
  'Campaign', 'Labels', 'Campaign Type', 'Networks', 'Budget', 'Budget type',
  'EU political ads', 'Standard conversion goals', 'Customer acquisition',
  'Languages', 'Bid Strategy Type', 'Bid Strategy Name', 'Target CPA',
  'Target ROAS', 'Start Date', 'End Date', 'Broad match keywords',
  'Ad Schedule', 'Ad rotation', 'Content exclusions', 'Targeting method',
  'Exclusion method', 'Google Merchant Center feed', 'Merchant Identifier',
  'Country of Sale', 'Feed label', 'Campaign Priority', 'Local Inventory Ads',
  'Shopping ads on excluded brands', 'Inventory filter', 'Audience targeting',
  'Flexible Reach', 'AI Max', 'Text customization', 'Final URL expansion',
  'Image enhancement', 'Image generation', 'Landing page images',
  'Video enhancement', 'Brand guidelines', 'Brand business name',
  'Ad Group', 'Max CPC', 'Max CPM', 'Max CPV', 'Target CPV', 'Percent CPC',
  'Target CPM', 'Target CPC', 'Desktop Bid Modifier', 'Mobile Bid Modifier',
  'Tablet Bid Modifier', 'TV Screen Bid Modifier',
  'Display Network Custom Bid Type', 'Optimized targeting',
  'Strict age and gender targeting', 'Search term matching', 'Ad Group Type',
  'Channels', 'Audience name', 'Age demographic', 'Gender demographic',
  'Income demographic', 'Parental status demographic',
  'Remarketing audience segments', 'Interest categories', 'Life events',
  'Custom audience segments', 'Detailed demographics',
  'Remarketing audience exclusions', 'Tracking template', 'Final URL suffix',
  'Custom parameters', 'Asset Group',
  'Headline 1', 'Headline 2', 'Headline 3', 'Headline 4', 'Headline 5',
  'Headline 6', 'Headline 7', 'Headline 8', 'Headline 9', 'Headline 10',
  'Headline 11', 'Headline 12', 'Headline 13', 'Headline 14', 'Headline 15',
  'Long headline 1', 'Long headline 2', 'Long headline 3',
  'Long headline 4', 'Long headline 5',
  'Description 1', 'Description 2', 'Description 3', 'Description 4',
  'Description 5', 'Call to action', 'Business name',
  'Video ID 1', 'Video ID 2', 'Video ID 3', 'Video ID 4', 'Video ID 5',
  'Path 1', 'Path 2', 'Final URL', 'Final mobile URL', 'Audience signal',
  'ID', 'Location', 'Reach', 'Location groups', 'Radius', 'Unit',
  'Bid Modifier', 'Criterion Type', 'Asset name', 'Folder', 'Source',
  'Image Size', 'File size', 'Account keyword type', 'Keyword',
  'First page bid', 'Top of page bid', 'First position bid',
  'Quality score', 'Landing page experience', 'Expected CTR', 'Ad relevance',
  'Product Group', 'Product Group Type', 'Label', 'Color', 'Description',
  'Video ID', 'Video title', 'Search theme', 'Incremental', 'Ad type',
  'Headline 1 position', 'Headline 2 position', 'Headline 3 position',
  'Headline 4 position', 'Headline 5 position', 'Headline 6 position',
  'Headline 7 position', 'Headline 8 position', 'Headline 9 position',
  'Headline 10 position', 'Headline 11 position', 'Headline 12 position',
  'Headline 13 position', 'Headline 14 position', 'Headline 15 position',
  'Description 1 position', 'Description 2 position',
  'Description 3 position', 'Description 4 position',
  'Shared set name', 'Shared set type', 'Keyword count', 'Campaigns',
  'Link Text', 'Description Line 1', 'Description Line 2',
  'Upgraded extension', 'Link source', 'Header', 'Snippet Values',
  'Callout text', 'Account settings', 'Inventory type',
  'Campaign Status', 'Ad Group Status', 'Asset Group Status', 'Status',
  'Approval Status', 'Ad strength', 'Comment',
] as const;

if (EDITOR_COLUMNS.length !== 183) {
  // Compile-time assertion as a runtime guard (cheap, runs at module init).
  throw new Error(`EDITOR_COLUMNS must have 183 entries, got ${EDITOR_COLUMNS.length}`);
}

const COL_INDEX: Record<string, number> = Object.fromEntries(
  EDITOR_COLUMNS.map((name, i) => [name, i]),
);

const TAB = '\t';
const CRLF = '\r\n';
const UTF16_LE_BOM = Uint8Array.from([0xff, 0xfe]);

// ── Row representation ────────────────────────────────────────────────

export type CsvRow = readonly string[];

function emptyRow(): string[] {
  return new Array<string>(EDITOR_COLUMNS.length).fill('');
}

function setCol(row: string[], colName: string, value: string | number | undefined | null): void {
  const idx = COL_INDEX[colName];
  if (idx === undefined) {
    throw new Error(`Unknown column "${colName}"`);
  }
  if (value === undefined || value === null) {
    row[idx] = '';
    return;
  }
  row[idx] = sanitiseField(String(value));
}

function sanitiseField(s: string): string {
  // Editor splits on TAB and CRLF; replace any in-field instances with
  // spaces so the column count stays correct. Editor does not implement
  // RFC-4180 quoting for TSV imports.
  return s.replace(/[\t\r\n]+/gu, ' ').trim();
}

// ── Row encoding ──────────────────────────────────────────────────────

export function renderHeader(): string {
  return EDITOR_COLUMNS.join(TAB);
}

export function renderRow(row: CsvRow): string {
  return row.join(TAB);
}

export function renderCsvBody(rows: readonly CsvRow[]): string {
  const lines = [renderHeader(), ...rows.map(renderRow)];
  return lines.join(CRLF) + CRLF;
}

export function encodeUtf16LeWithBom(body: string): Uint8Array {
  const bytes = new Uint8Array(2 + body.length * 2);
  bytes.set(UTF16_LE_BOM, 0);
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[2 + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return bytes;
}

// ── Search row builders (ported from Python archive) ─────────────────

export interface CampaignRowInput {
  campaignName: string;
  campaignType?: 'Search' | 'Display' | 'Shopping' | 'Performance Max' | 'Video' | undefined;
  budget?: number | string | undefined;
  budgetType?: 'Daily' | 'Total' | undefined;
  networks?: string | undefined;
  languages?: string | undefined;
  bidStrategy?: string | undefined;
  targetRoas?: number | undefined;
  targetCpa?: number | undefined;
  labels?: string | undefined;
  status?: 'Paused' | 'Enabled' | 'Removed' | undefined;
  finalUrlSuffix?: string | undefined;
}

export function buildCampaignRow(input: CampaignRowInput): CsvRow {
  const row = emptyRow();
  setCol(row, 'Campaign', input.campaignName);
  setCol(row, 'Campaign Type', input.campaignType ?? 'Search');
  if (input.budget !== undefined) setCol(row, 'Budget', input.budget);
  setCol(row, 'Budget type', input.budgetType ?? 'Daily');
  setCol(row, 'Networks', input.networks ?? 'Google search;Search Partners');
  setCol(row, 'Languages', input.languages ?? 'de');
  setCol(row, 'Bid Strategy Type', input.bidStrategy ?? 'Maximize conversions');
  if (input.targetRoas !== undefined) setCol(row, 'Target ROAS', input.targetRoas);
  if (input.targetCpa !== undefined) setCol(row, 'Target CPA', input.targetCpa);
  if (input.labels) setCol(row, 'Labels', input.labels);
  if (input.finalUrlSuffix) setCol(row, 'Final URL suffix', input.finalUrlSuffix);
  setCol(row, 'EU political ads', "Doesn't have EU political ads");
  // Status only when the caller explicitly sets it. Empty cell = Editor
  // leaves the existing campaign status alone (critical for KEEP rows
  // that anchor child changes — defaulting to Paused would freeze the
  // production campaign on import).
  if (input.status !== undefined) setCol(row, 'Campaign Status', input.status);
  return row;
}

export interface LocationRowInput {
  campaignName: string;
  location: string;
  locationId?: string | number | undefined;
}

export function buildLocationRow(input: LocationRowInput): CsvRow {
  const row = emptyRow();
  setCol(row, 'Campaign', input.campaignName);
  setCol(row, 'Location', input.location);
  if (input.locationId !== undefined) setCol(row, 'ID', input.locationId);
  return row;
}

export interface AdGroupRowInput {
  campaignName: string;
  adGroupName: string;
  status?: 'Paused' | 'Enabled' | undefined;
  maxCpc?: number | undefined;
}

export function buildAdGroupRow(input: AdGroupRowInput): CsvRow {
  const row = emptyRow();
  setCol(row, 'Campaign', input.campaignName);
  setCol(row, 'Ad Group', input.adGroupName);
  setCol(row, 'Ad Group Status', input.status ?? 'Enabled');
  if (input.maxCpc !== undefined) setCol(row, 'Max CPC', input.maxCpc);
  return row;
}

export interface KeywordRowInput {
  campaignName: string;
  adGroupName: string;
  keyword: string;
  matchType: 'Exact' | 'Phrase' | 'Broad';
  finalUrl?: string | undefined;
  status?: 'Paused' | 'Enabled' | undefined;
}

export function buildKeywordRow(input: KeywordRowInput): CsvRow {
  const row = emptyRow();
  setCol(row, 'Campaign', input.campaignName);
  setCol(row, 'Ad Group', input.adGroupName);
  setCol(row, 'Keyword', input.keyword);
  setCol(row, 'Criterion Type', input.matchType);
  if (input.finalUrl) setCol(row, 'Final URL', input.finalUrl);
  setCol(row, 'Status', input.status ?? 'Enabled');
  return row;
}

export interface RsaRowInput {
  campaignName: string;
  adGroupName: string;
  headlines: readonly string[];   // up to 15
  descriptions: readonly string[]; // up to 5
  path1?: string | undefined;
  path2?: string | undefined;
  finalUrl: string;
  status?: 'Paused' | 'Enabled' | undefined;
}

export function buildRsaRow(input: RsaRowInput): CsvRow {
  const row = emptyRow();
  setCol(row, 'Campaign', input.campaignName);
  setCol(row, 'Ad Group', input.adGroupName);
  for (let i = 0; i < Math.min(15, input.headlines.length); i++) {
    setCol(row, `Headline ${i + 1}`, input.headlines[i]!);
  }
  for (let i = 0; i < Math.min(5, input.descriptions.length); i++) {
    setCol(row, `Description ${i + 1}`, input.descriptions[i]!);
  }
  if (input.path1) setCol(row, 'Path 1', input.path1);
  if (input.path2) setCol(row, 'Path 2', input.path2);
  setCol(row, 'Final URL', input.finalUrl);
  setCol(row, 'Status', input.status ?? 'Enabled');
  return row;
}

export interface SitelinkRowInput {
  campaignName: string;
  text: string;
  desc1?: string | undefined;
  desc2?: string | undefined;
  url: string;
  status?: 'Paused' | 'Enabled' | undefined;
}

export function buildSitelinkRow(input: SitelinkRowInput): CsvRow {
  const row = emptyRow();
  setCol(row, 'Campaign', input.campaignName);
  setCol(row, 'Link Text', input.text);
  if (input.desc1) setCol(row, 'Description Line 1', input.desc1);
  if (input.desc2) setCol(row, 'Description Line 2', input.desc2);
  setCol(row, 'Final URL', input.url);
  setCol(row, 'Status', input.status ?? 'Enabled');
  return row;
}

export interface CalloutRowInput {
  campaignName: string;
  text: string;
  status?: 'Paused' | 'Enabled' | undefined;
}

export function buildCalloutRow(input: CalloutRowInput): CsvRow {
  const row = emptyRow();
  setCol(row, 'Campaign', input.campaignName);
  setCol(row, 'Callout text', input.text);
  setCol(row, 'Status', input.status ?? 'Enabled');
  return row;
}

export type NegativeMatchType =
  | 'Campaign Negative Broad'
  | 'Campaign Negative Phrase'
  | 'Campaign Negative Exact'
  | 'Exact' | 'Phrase' | 'Broad';

export interface NegativeRowInput {
  campaignName?: string | undefined; // omit for account-level (use sharedSetName instead)
  adGroupName?: string | undefined;
  /** Shared-set name for account-level negatives. Required when campaignName
   *  is omitted — Editor refuses orphaned campaign-negatives without an
   *  anchor (no campaign + no shared set = silently dropped on import). */
  sharedSetName?: string | undefined;
  keyword: string;
  matchType: NegativeMatchType;
  status?: 'Paused' | 'Enabled' | undefined;
}

export function buildNegativeRow(input: NegativeRowInput): CsvRow {
  const row = emptyRow();
  if (input.campaignName) {
    setCol(row, 'Campaign', input.campaignName);
  } else if (input.sharedSetName) {
    setCol(row, 'Shared set name', input.sharedSetName);
    setCol(row, 'Shared set type', 'Negative keyword');
  }
  if (input.adGroupName) setCol(row, 'Ad Group', input.adGroupName);
  setCol(row, 'Keyword', input.keyword);
  setCol(row, 'Criterion Type', normaliseNegMatchType(input.matchType));
  setCol(row, 'Status', input.status ?? 'Enabled');
  return row;
}

function normaliseNegMatchType(m: NegativeMatchType): string {
  // Editor accepts both bare and "Campaign Negative …" forms; the Python
  // archive validator demands the prefixed form for campaign-level.
  // We default to the prefixed form when caller didn't already use it.
  if (m === 'Exact' || m === 'Phrase' || m === 'Broad') return `Campaign Negative ${m}`;
  return m;
}

// ── PMAX row builders (NET-NEW — not in Python archive) ──────────────

export interface AssetGroupRowInput {
  campaignName: string;
  assetGroupName: string;
  finalUrl?: string | undefined;
  finalMobileUrl?: string | undefined;
  path1?: string | undefined;
  path2?: string | undefined;
  status?: 'Paused' | 'Enabled' | undefined;
}

export function buildAssetGroupRow(input: AssetGroupRowInput): CsvRow {
  const row = emptyRow();
  setCol(row, 'Campaign', input.campaignName);
  setCol(row, 'Asset Group', input.assetGroupName);
  if (input.finalUrl) setCol(row, 'Final URL', input.finalUrl);
  if (input.finalMobileUrl) setCol(row, 'Final mobile URL', input.finalMobileUrl);
  if (input.path1) setCol(row, 'Path 1', input.path1);
  if (input.path2) setCol(row, 'Path 2', input.path2);
  // Same safety as buildCampaignRow: only emit Status when the caller
  // sets it. Empty cell preserves existing asset-group state.
  if (input.status !== undefined) setCol(row, 'Asset Group Status', input.status);
  return row;
}

export type AssetFieldType =
  | 'HEADLINE' | 'LONG_HEADLINE' | 'DESCRIPTION'
  | 'BUSINESS_NAME' | 'CALL_TO_ACTION'
  | 'IMAGE' | 'LOGO' | 'VIDEO';

export interface AssetRowInput {
  campaignName: string;
  assetGroupName: string;
  fieldType: AssetFieldType;
  /** Index 1-based. Required for HEADLINE (1-15), LONG_HEADLINE (1-5), DESCRIPTION (1-5), VIDEO_ID (1-5). */
  index?: number | undefined;
  text?: string | undefined;        // HEADLINE/LONG_HEADLINE/DESCRIPTION/BUSINESS_NAME/CALL_TO_ACTION
  videoId?: string | undefined;     // VIDEO
  /** For IMAGE/LOGO assets. The image URL or asset ID known to the customer's account. */
  assetName?: string | undefined;
  status?: 'Paused' | 'Enabled' | undefined;
}

export function buildAssetRow(input: AssetRowInput): CsvRow {
  const row = emptyRow();
  setCol(row, 'Campaign', input.campaignName);
  setCol(row, 'Asset Group', input.assetGroupName);

  switch (input.fieldType) {
    case 'HEADLINE': {
      const i = clampIndex(input.index, 1, 15);
      setCol(row, `Headline ${i}`, input.text ?? '');
      break;
    }
    case 'LONG_HEADLINE': {
      const i = clampIndex(input.index, 1, 5);
      setCol(row, `Long headline ${i}`, input.text ?? '');
      break;
    }
    case 'DESCRIPTION': {
      const i = clampIndex(input.index, 1, 5);
      setCol(row, `Description ${i}`, input.text ?? '');
      break;
    }
    case 'BUSINESS_NAME':
      setCol(row, 'Business name', input.text ?? '');
      break;
    case 'CALL_TO_ACTION':
      setCol(row, 'Call to action', input.text ?? '');
      break;
    case 'IMAGE':
    case 'LOGO':
      if (input.assetName) setCol(row, 'Asset name', input.assetName);
      break;
    case 'VIDEO': {
      const i = clampIndex(input.index, 1, 5);
      setCol(row, `Video ID ${i}`, input.videoId ?? '');
      break;
    }
  }

  setCol(row, 'Status', input.status ?? 'Enabled');
  return row;
}

function clampIndex(value: number | undefined, min: number, max: number): number {
  if (value === undefined) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export interface AudienceSignalRowInput {
  campaignName: string;
  assetGroupName: string;
  audienceName: string;
  /** Optional comma-separated list per Editor's column conventions. */
  interestCategories?: string | undefined;
  customAudienceSegments?: string | undefined;
  remarketingSegments?: string | undefined;
  detailedDemographics?: string | undefined;
  lifeEvents?: string | undefined;
  ageDemographic?: string | undefined;
  genderDemographic?: string | undefined;
  status?: 'Paused' | 'Enabled' | undefined;
}

export function buildAudienceSignalRow(input: AudienceSignalRowInput): CsvRow {
  const row = emptyRow();
  setCol(row, 'Campaign', input.campaignName);
  setCol(row, 'Asset Group', input.assetGroupName);
  setCol(row, 'Audience name', input.audienceName);
  setCol(row, 'Audience signal', input.audienceName);
  if (input.interestCategories) setCol(row, 'Interest categories', input.interestCategories);
  if (input.customAudienceSegments) setCol(row, 'Custom audience segments', input.customAudienceSegments);
  if (input.remarketingSegments) setCol(row, 'Remarketing audience segments', input.remarketingSegments);
  if (input.detailedDemographics) setCol(row, 'Detailed demographics', input.detailedDemographics);
  if (input.lifeEvents) setCol(row, 'Life events', input.lifeEvents);
  if (input.ageDemographic) setCol(row, 'Age demographic', input.ageDemographic);
  if (input.genderDemographic) setCol(row, 'Gender demographic', input.genderDemographic);
  setCol(row, 'Status', input.status ?? 'Enabled');
  return row;
}

export interface ListingGroupRowInput {
  campaignName: string;
  assetGroupName?: string | undefined; // PMAX listing group lives under asset group
  productGroup: string;     // e.g. "All products" or a path "Brand=X / Type=Y"
  productGroupType?: string | undefined; // "UNIT" | "SUBDIVISION"
  bidModifier?: number | undefined;
  status?: 'Paused' | 'Enabled' | undefined;
}

export function buildListingGroupRow(input: ListingGroupRowInput): CsvRow {
  const row = emptyRow();
  setCol(row, 'Campaign', input.campaignName);
  if (input.assetGroupName) setCol(row, 'Asset Group', input.assetGroupName);
  setCol(row, 'Product Group', input.productGroup);
  if (input.productGroupType) setCol(row, 'Product Group Type', input.productGroupType);
  if (input.bidModifier !== undefined) setCol(row, 'Bid Modifier', input.bidModifier);
  setCol(row, 'Status', input.status ?? 'Enabled');
  return row;
}

// ── File-name slugging ───────────────────────────────────────────────

export function slugifyCampaignName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return slug.slice(0, 80) || 'unnamed';
}
