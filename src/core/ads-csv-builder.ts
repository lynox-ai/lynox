/**
 * Google Ads Editor CSV builder.
 *
 * V1 emits a narrower-than-full Editor schema covering the entity
 * types the Blueprint phase produces:
 *   - Campaign (settings)
 *   - Ad group
 *   - Keyword (positive)
 *   - Negative keyword (campaign- or account-level)
 *
 * Output format follows Google Ads Editor's CSV import expectations:
 *   - UTF-16 LE encoding with a leading BOM (0xFF 0xFE)
 *   - TAB-separated columns
 *   - CRLF line endings
 *   - First row is the header
 *
 * Editor accepts CSVs with any subset of the documented columns; the
 * V1 schema below is the safe minimum that round-trips for our entity
 * types. NEW entities are emitted with Status=Paused (PRD safeguard
 * — no entity goes live without operator review in Editor).
 *
 * The file is split into one CSV per campaign plus one
 * account-level negatives file. The split mirrors the Editor workflow
 * where each campaign is reviewed separately before posting.
 *
 * NOTE: The full 183-column port (incl. PMAX AssetGroup / Asset /
 * ListingGroup / AudienceSignal rows) is V2; it depends on access to
 * the upstream `build_import_tsv.py` archive which is not in the
 * worktree at the time of writing. V1 emits the entity types we
 * actually generate and is sufficient for the brandfusion Beta.
 */

// Header column order is locked: do not reorder or insert columns
// without a migration on the consuming Editor's side. Editor matches
// columns by header name, but a stable order keeps git-diffs of the
// emitted CSVs readable across cycles.
export const EDITOR_COLUMNS = [
  'Action',
  'Campaign',
  'Ad group',
  'Type',
  'Status',
  'Keyword',
  'Match type',
  'Final URL',
] as const;

type EditorColumn = typeof EDITOR_COLUMNS[number];

const TAB = '\t';
const CRLF = '\r\n';
const UTF16_LE_BOM = Uint8Array.from([0xff, 0xfe]);

export interface CsvRowInput {
  Action: 'Add' | 'Edit' | 'Pause' | 'Remove';
  Campaign?: string | undefined;
  AdGroup?: string | undefined;
  Type?: string | undefined;
  Status?: string | undefined;
  Keyword?: string | undefined;
  MatchType?: string | undefined;
  FinalUrl?: string | undefined;
}

export interface CampaignCsv {
  campaignName: string;
  fileBaseName: string;   // safe-for-fs filename (no extension)
  rows: readonly CsvRowInput[];
  /** Number of rows by Action (rendered in markdown summary). */
  counts: Record<CsvRowInput['Action'], number>;
}

export interface CsvBundle {
  perCampaign: CampaignCsv[];
  accountNegatives: CampaignCsv | null;
  /** Total entity rows across all files (excluding header). */
  totalRows: number;
}

// ── Header / row rendering ────────────────────────────────────────────

function renderHeader(): string {
  return EDITOR_COLUMNS.join(TAB);
}

function renderRow(row: CsvRowInput): string {
  const map: Record<EditorColumn, string> = {
    'Action': row.Action,
    'Campaign': row.Campaign ?? '',
    'Ad group': row.AdGroup ?? '',
    'Type': row.Type ?? '',
    'Status': row.Status ?? '',
    'Keyword': row.Keyword ?? '',
    'Match type': row.MatchType ?? '',
    'Final URL': row.FinalUrl ?? '',
  };
  return EDITOR_COLUMNS.map(col => sanitiseField(map[col])).join(TAB);
}

/**
 * Editor splits on TAB and CRLF. Replace any in-field instances with
 * spaces so the column count stays correct. We do NOT URL-encode or
 * quote — Editor does not implement RFC-4180 quoting for TSV imports.
 */
function sanitiseField(s: string): string {
  return s.replace(/[\t\r\n]+/gu, ' ').trim();
}

// ── CSV body assembly ────────────────────────────────────────────────

export function renderCsvBody(rows: readonly CsvRowInput[]): string {
  const lines: string[] = [renderHeader()];
  for (const r of rows) lines.push(renderRow(r));
  // Editor expects a trailing CRLF on the last line too.
  return lines.join(CRLF) + CRLF;
}

/**
 * Encode a string body into UTF-16 LE bytes preceded by a BOM.
 * Editor refuses CSVs without the BOM on Windows and silently mis-parses
 * non-ASCII characters when fed UTF-8 — UTF-16 LE is the documented
 * import encoding.
 */
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

// ── Per-entity row builders ──────────────────────────────────────────

interface KeepCampaignSettings {
  campaignName: string;
  status?: string | undefined;
}

interface KeepOrNewAdGroup {
  campaignName: string;
  adGroupName: string;
  status: 'Paused' | 'Enabled';
  action: 'Add' | 'Edit';
}

interface KeepOrNewKeyword {
  campaignName: string;
  adGroupName: string;
  keyword: string;
  matchType: 'Exact' | 'Phrase' | 'Broad';
  finalUrl?: string | undefined;
  status: 'Paused' | 'Enabled';
  action: 'Add' | 'Edit';
}

interface NegativeKeyword {
  /** Empty when account-level negative. */
  campaignName?: string | undefined;
  adGroupName?: string | undefined;
  keyword: string;
  matchType: 'Exact' | 'Phrase' | 'Broad';
}

export function buildCampaignSettingsRow(input: KeepCampaignSettings): CsvRowInput {
  return {
    Action: 'Edit',
    Campaign: input.campaignName,
    Type: 'Campaign',
    Status: input.status ?? 'Paused',
  };
}

export function buildAdGroupRow(input: KeepOrNewAdGroup): CsvRowInput {
  return {
    Action: input.action,
    Campaign: input.campaignName,
    AdGroup: input.adGroupName,
    Type: 'Ad group',
    Status: input.status,
  };
}

export function buildKeywordRow(input: KeepOrNewKeyword): CsvRowInput {
  return {
    Action: input.action,
    Campaign: input.campaignName,
    AdGroup: input.adGroupName,
    Type: 'Keyword',
    Status: input.status,
    Keyword: input.keyword,
    MatchType: input.matchType,
    ...(input.finalUrl !== undefined ? { FinalUrl: input.finalUrl } : {}),
  };
}

export function buildNegativeKeywordRow(input: NegativeKeyword): CsvRowInput {
  return {
    Action: 'Add',
    Campaign: input.campaignName ?? '',
    AdGroup: input.adGroupName ?? '',
    Type: 'Negative keyword',
    Keyword: input.keyword,
    MatchType: input.matchType,
  };
}

// ── File-name slugging ───────────────────────────────────────────────

/**
 * Derive a filesystem-safe slug from a campaign name. Lowercased,
 * non-alphanumerics replaced with hyphens, collapsed/leading-trailing
 * trimmed, and capped at 80 chars.
 */
export function slugifyCampaignName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return slug.slice(0, 80) || 'unnamed';
}
