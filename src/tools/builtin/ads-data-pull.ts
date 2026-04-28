/**
 * Tool: ads_data_pull
 *
 * Pulls one cycle of GAS-exported CSVs from the customer's Google Drive,
 * parses them, and writes a full snapshot into ads-optimizer.db.
 *
 * Manual-only in V1 (no scheduler hookup yet). Beta-gated by feature flag
 * `ads-optimizer` (default off; the engine only wires this tool up when on).
 *
 * The engine never calls Google Ads / GA4 / GSC APIs directly. All data
 * arrives via Drive read of files written by the customer's Apps Scripts.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import type { GoogleAuth } from '../../integrations/google/google-auth.js';
import { getErrorMessage } from '../../core/utils.js';
import type { AdsDataStore } from '../../core/ads-data-store.js';
import {
  parseAdsCsv,
  ALL_ADS_CSV_KINDS,
  ADS_FILENAME,
  type AdsCsvKind,
} from '../../core/ads-csv-reader.js';

// ── Types ────────────────────────────────────────────────────────

interface AdsDataPullInput {
  ads_account_id: string;
  drive_folder_id: string;
  force?: boolean | undefined;
}

const FRESHNESS_LIMIT_DAYS = 14;
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

// ── Lightweight read-only Drive client (folder lookup + file text read) ──
// Behind an interface so tests can inject a fake without touching HTTP.

export interface IDriveReader {
  findSubfolder(parentId: string, name: string): Promise<DriveFile | null>;
  listFiles(folderId: string): Promise<DriveFile[]>;
  readText(fileId: string): Promise<string>;
}

export class DriveReader implements IDriveReader {
  constructor(private readonly auth: GoogleAuth) {}

  private async fetch(url: string): Promise<Response> {
    const token = await this.auth.getAccessToken();
    return fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
  }

  /** Find a single subfolder by name within a parent. Returns null if not found. */
  async findSubfolder(parentId: string, name: string): Promise<DriveFile | null> {
    const escapedParent = escapeDriveQueryString(parentId);
    const escapedName = escapeDriveQueryString(name);
    const q = `'${escapedParent}' in parents and name = '${escapedName}' and ` +
      `mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,mimeType,modifiedTime)',
      pageSize: '10',
    });
    const r = await this.fetch(`${DRIVE_BASE}/files?${params.toString()}`);
    if (!r.ok) throw new Error(`Drive search failed (${r.status})`);
    const data = await r.json() as { files?: DriveFile[] };
    return data.files?.[0] ?? null;
  }

  /** List all non-folder files in a folder (paginated). */
  async listFiles(folderId: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    const escapedFolder = escapeDriveQueryString(folderId);
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${escapedFolder}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name,mimeType,modifiedTime),nextPageToken',
        pageSize: '100',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const r = await this.fetch(`${DRIVE_BASE}/files?${params.toString()}`);
      if (!r.ok) throw new Error(`Drive list failed (${r.status})`);
      const data = await r.json() as { files?: DriveFile[]; nextPageToken?: string };
      if (data.files) out.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** Read a file's bytes as UTF-8 text. */
  async readText(fileId: string): Promise<string> {
    // encodeURIComponent on the path segment defends against any future
    // call-site that hands us an agent-controlled fileId — today the IDs
    // come straight back from listFiles, but the public method shape
    // doesn't enforce that.
    const r = await this.fetch(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media`);
    if (!r.ok) throw new Error(`Drive download failed (${r.status})`);
    return await r.text();
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Escape a value for safe interpolation inside a Drive `q` string literal
 * delimited by single quotes. Backslashes must be doubled before quotes
 * are escaped, otherwise an attacker-controlled value can break out of
 * the literal and inject additional clauses.
 *
 * Exported for unit-testing only.
 */
export function escapeDriveQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function parseLastrunIsoDate(text: string): Date | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Accepts ISO-8601 (e.g. "2026-04-27T10:00:00Z") or just date.
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function ageInDays(d: Date, now: Date = new Date()): number {
  return (now.getTime() - d.getTime()) / (24 * 60 * 60 * 1000);
}

function isMonthlyPrefix(filename: string, prefix: 'ga4' | 'gsc'): boolean {
  // Matches "ga4_2026-04.csv" or "gsc_2026-04.csv"
  return new RegExp(`^${prefix}_\\d{4}-\\d{2}\\.csv$`).test(filename);
}

// ── Pull Result ──────────────────────────────────────────────────

interface PerCsvSummary {
  kind: AdsCsvKind | 'ga4' | 'gsc';
  file: string;
  rows: number;
  warnings: number;
  status: 'inserted' | 'missing' | 'failed';
  error?: string | undefined;
}

export interface PullResult {
  runId: number;
  mode: 'BOOTSTRAP' | 'OPTIMIZE';
  totalRows: number;
  totalWarnings: number;
  perCsv: PerCsvSummary[];
  fatalErrors: string[];
}

// ── Insert Dispatch (kind → AdsDataStore method) ─────────────────

/** Maps an AdsCsvKind (or 'ga4'/'gsc') to the matching AdsDataStore bulk-insert call. */
function dispatchInsert(
  store: AdsDataStore,
  kind: AdsCsvKind | 'ga4' | 'gsc',
  runId: number,
  adsAccountId: string,
  rows: readonly unknown[],
  observedAt: string,
): number {
  const args = { runId, adsAccountId, observedAt };
  switch (kind) {
    case 'campaigns': return store.insertCampaignsBatch({ ...args, rows: rows as never });
    case 'campaign_performance': return store.insertCampaignPerformanceBatch({ ...args, rows: rows as never });
    case 'ad_groups': return store.insertAdGroupsBatch({ ...args, rows: rows as never });
    case 'keywords': return store.insertKeywordsBatch({ ...args, rows: rows as never });
    case 'ads_rsa': return store.insertRsaAdsBatch({ ...args, rows: rows as never });
    case 'asset_groups': return store.insertAssetGroupsBatch({ ...args, rows: rows as never });
    case 'asset_group_assets': return store.insertAssetGroupAssetsBatch({ ...args, rows: rows as never });
    case 'assets': return store.insertAssetsBatch({ ...args, rows: rows as never });
    case 'listing_groups': return store.insertListingGroupsBatch({ ...args, rows: rows as never });
    case 'shopping_products': return store.insertShoppingProductsBatch({ ...args, rows: rows as never });
    case 'conversions': return store.insertConversionActionsBatch({ ...args, rows: rows as never });
    case 'campaign_targeting': return store.insertCampaignTargetingBatch({ ...args, rows: rows as never });
    case 'search_terms': return store.insertSearchTermsBatch({ ...args, rows: rows as never });
    case 'pmax_search_terms': return store.insertPmaxSearchTermsBatch({ ...args, rows: rows as never });
    case 'pmax_placements': return store.insertPmaxPlacementsBatch({ ...args, rows: rows as never });
    case 'landing_pages': return store.insertLandingPagesBatch({ ...args, rows: rows as never });
    case 'ad_asset_ratings': return store.insertAdAssetRatingsBatch({ ...args, rows: rows as never });
    case 'audience_signals': return store.insertAudienceSignalsBatch({ ...args, rows: rows as never });
    case 'device_performance': return store.insertDevicePerformanceBatch({ ...args, rows: rows as never });
    case 'geo_performance': return store.insertGeoPerformanceBatch({ ...args, rows: rows as never });
    case 'change_history': return store.insertChangeHistoryBatch({ ...args, rows: rows as never });
    case 'ga4': return store.insertGa4ObservationsBatch({ ...args, rows: rows as never });
    case 'gsc': return store.insertGscObservationsBatch({ ...args, rows: rows as never });
  }
}

// ── Orchestration ────────────────────────────────────────────────

export interface PullDeps {
  store: AdsDataStore;
  reader: IDriveReader;
  /** Override clock for tests. */
  now?: (() => Date) | undefined;
}

export async function runAdsDataPull(deps: PullDeps, input: AdsDataPullInput): Promise<PullResult> {
  const { store, reader } = deps;
  const now = deps.now?.() ?? new Date();
  const observedAt = now.toISOString();
  const fatalErrors: string[] = [];
  const perCsv: PerCsvSummary[] = [];

  // 1. Locate ads / ga4 / gsc subfolders.
  const adsFolder = await reader.findSubfolder(input.drive_folder_id, 'ads');
  if (!adsFolder) {
    throw new Error(`Drive folder ${input.drive_folder_id} has no "ads" subfolder. ` +
      `Expected layout: <root>/ads, <root>/ga4, <root>/gsc.`);
  }
  const ga4Folder = await reader.findSubfolder(input.drive_folder_id, 'ga4');
  const gscFolder = await reader.findSubfolder(input.drive_folder_id, 'gsc');

  // 2. Freshness check via LASTRUN.txt in ads/.
  const adsFiles = await reader.listFiles(adsFolder.id);
  const lastrunFile = adsFiles.find(f => f.name === 'LASTRUN.txt');
  let lastrunIso: string | undefined;
  if (lastrunFile) {
    const lastrunText = await reader.readText(lastrunFile.id);
    const lastrunDate = parseLastrunIsoDate(lastrunText);
    if (lastrunDate) {
      lastrunIso = lastrunDate.toISOString();
      const age = ageInDays(lastrunDate, now);
      if (age > FRESHNESS_LIMIT_DAYS && !input.force) {
        throw new Error(
          `GAS export is stale: LASTRUN.txt is ${age.toFixed(1)} days old (limit ${FRESHNESS_LIMIT_DAYS}). ` +
          `Re-run the Apps Scripts on the customer's account, or pass force=true to override.`,
        );
      }
    } else {
      // Couldn't parse — note as warning but continue (matches intentional lenience for non-fatal drift).
      perCsv.push({ kind: 'campaigns', file: 'LASTRUN.txt', rows: 0, warnings: 1,
        status: 'failed', error: 'unparseable timestamp, freshness check skipped' });
    }
  } else if (!input.force) {
    throw new Error(
      `Drive folder ${adsFolder.id} (ads/) has no LASTRUN.txt. ` +
      `Re-run the Apps Scripts (which write LASTRUN), or pass force=true to skip the freshness check.`,
    );
  }

  // 3. Decide mode based on prior runs.
  const previousRun = store.getLatestSuccessfulAuditRun(input.ads_account_id);
  const mode: 'BOOTSTRAP' | 'OPTIMIZE' = previousRun === null ? 'BOOTSTRAP' : 'OPTIMIZE';

  // 4. Open audit run (creates concurrency lock; throws if one already RUNNING).
  const run = store.createAuditRun({
    adsAccountId: input.ads_account_id,
    mode,
    gasExportLastrun: lastrunIso,
    previousRunId: previousRun?.run_id,
  });

  let totalRows = 0;
  let totalWarnings = 0;

  try {
    // 5. Process the 21 ads CSVs (skip change_history if absent — historical archive exports left it empty).
    for (const kind of ALL_ADS_CSV_KINDS) {
      const expectedName = ADS_FILENAME[kind];
      const file = adsFiles.find(f => f.name === expectedName);
      if (!file) {
        perCsv.push({ kind, file: expectedName, rows: 0, warnings: 0, status: 'missing' });
        continue;
      }
      try {
        const text = await reader.readText(file.id);
        const parsed = parseAdsCsv(kind, expectedName, text);
        const inserted = dispatchInsert(store, kind, run.run_id, input.ads_account_id, parsed.rows, observedAt);
        totalRows += inserted;
        totalWarnings += parsed.warnings.length;
        perCsv.push({ kind, file: expectedName, rows: inserted, warnings: parsed.warnings.length, status: 'inserted' });
      } catch (err) {
        const msg = getErrorMessage(err);
        perCsv.push({ kind, file: expectedName, rows: 0, warnings: 0, status: 'failed', error: msg });
        fatalErrors.push(`${expectedName}: ${msg}`);
      }
    }

    // 6. GA4 monthly CSVs (one or many in ga4/).
    if (ga4Folder) {
      const ga4Files = (await reader.listFiles(ga4Folder.id)).filter(f => isMonthlyPrefix(f.name, 'ga4'));
      for (const file of ga4Files) {
        try {
          const text = await reader.readText(file.id);
          const parsed = parseAdsCsv('ga4', file.name, text);
          const inserted = dispatchInsert(store, 'ga4', run.run_id, input.ads_account_id, parsed.rows, observedAt);
          totalRows += inserted;
          totalWarnings += parsed.warnings.length;
          perCsv.push({ kind: 'ga4', file: file.name, rows: inserted, warnings: parsed.warnings.length, status: 'inserted' });
        } catch (err) {
          const msg = getErrorMessage(err);
          perCsv.push({ kind: 'ga4', file: file.name, rows: 0, warnings: 0, status: 'failed', error: msg });
          fatalErrors.push(`${file.name}: ${msg}`);
        }
      }
    }

    // 7. GSC monthly CSVs.
    if (gscFolder) {
      const gscFiles = (await reader.listFiles(gscFolder.id)).filter(f => isMonthlyPrefix(f.name, 'gsc'));
      for (const file of gscFiles) {
        try {
          const text = await reader.readText(file.id);
          const parsed = parseAdsCsv('gsc', file.name, text);
          const inserted = dispatchInsert(store, 'gsc', run.run_id, input.ads_account_id, parsed.rows, observedAt);
          totalRows += inserted;
          totalWarnings += parsed.warnings.length;
          perCsv.push({ kind: 'gsc', file: file.name, rows: inserted, warnings: parsed.warnings.length, status: 'inserted' });
        } catch (err) {
          const msg = getErrorMessage(err);
          perCsv.push({ kind: 'gsc', file: file.name, rows: 0, warnings: 0, status: 'failed', error: msg });
          fatalErrors.push(`${file.name}: ${msg}`);
        }
      }
    }

    // 8. Finalize the run.
    if (fatalErrors.length === 0) {
      store.completeAuditRun(run.run_id);
    } else {
      store.failAuditRun(run.run_id, fatalErrors.join('; ').slice(0, 500));
    }
  } catch (err) {
    // Defensive catch — anything we didn't anticipate fails the run cleanly.
    const msg = getErrorMessage(err);
    fatalErrors.push(`unexpected: ${msg}`);
    store.failAuditRun(run.run_id, msg.slice(0, 500));
    throw err;
  }

  return { runId: run.run_id, mode, totalRows, totalWarnings, perCsv, fatalErrors };
}

// ── Tool factory ─────────────────────────────────────────────────

function summariseResult(result: PullResult): string {
  const lines: string[] = [];
  lines.push(`Run ${result.runId} (${result.mode}) — ${result.totalRows} rows, ${result.totalWarnings} warnings`);
  const inserted = result.perCsv.filter(s => s.status === 'inserted');
  const missing = result.perCsv.filter(s => s.status === 'missing');
  const failed = result.perCsv.filter(s => s.status === 'failed');
  if (inserted.length > 0) {
    lines.push('');
    lines.push(`Inserted (${inserted.length}):`);
    for (const s of inserted) lines.push(`  - ${s.file}: ${s.rows} rows${s.warnings > 0 ? ` (${s.warnings} warnings)` : ''}`);
  }
  if (missing.length > 0) {
    lines.push('');
    lines.push(`Missing in Drive (${missing.length}):`);
    for (const s of missing) lines.push(`  - ${s.file}`);
  }
  if (failed.length > 0) {
    lines.push('');
    lines.push(`Failed (${failed.length}):`);
    for (const s of failed) lines.push(`  - ${s.file}: ${s.error ?? ''}`);
  }
  return lines.join('\n');
}

export function createAdsDataPullTool(auth: GoogleAuth, store: AdsDataStore): ToolEntry<AdsDataPullInput> {
  const reader = new DriveReader(auth);
  return {
    definition: {
      name: 'ads_data_pull',
      description:
        'Pull one cycle of Google Ads + GA4 + GSC data from the customer\'s Google Drive folder ' +
        '(written there by the customer-deployed Apps Scripts) and store it as a snapshot in the ' +
        'Ads Optimizer database. Validates LASTRUN freshness (max 14 days). Returns a summary of ' +
        'inserted/missing/failed CSVs. Use action: ' +
        'set ads_account_id (Google Customer ID, e.g. "123-456-7890") and drive_folder_id (the ' +
        'customer-root Drive folder ID containing ads/, ga4/, gsc/ subfolders). Set force=true to ' +
        'override the freshness check.',
      input_schema: {
        type: 'object' as const,
        properties: {
          ads_account_id: { type: 'string', description: 'Google Ads Customer ID (e.g. "123-456-7890")' },
          drive_folder_id: { type: 'string', description: 'Drive folder ID containing ads/, ga4/, gsc/ subfolders' },
          force: { type: 'boolean', description: 'Override the 14-day freshness check (default false)' },
        },
        required: ['ads_account_id', 'drive_folder_id'],
      },
    },
    handler: async (input: AdsDataPullInput, _agent: IAgent): Promise<string> => {
      try {
        const result = await runAdsDataPull({ store, reader }, input);
        return summariseResult(result);
      } catch (err) {
        return `ads_data_pull failed: ${getErrorMessage(err)}`;
      }
    },
  };
}
