/**
 * Emit Orchestrator (P4).
 *
 * Composes the validators + CSV builder + workspace writer over the
 * persisted blueprint entities for one run. Returns a structured
 * EmitResult the tool wrapper renders to markdown.
 *
 * Responsibilities:
 *   1. Read blueprint entities for the latest SUCCESS audit run.
 *   2. Run pre-emit validators. Hard errors short-circuit emit.
 *   3. Compute idempotency hash (SHA-256 over canonical blueprint
 *      state). When equal to the previous run's emitted_csv_hash,
 *      the run is a no-op — no files are written and the hash is
 *      not re-stamped.
 *   4. Group entities by campaign + an account-level negatives
 *      bucket; build per-file CSVs.
 *   5. Write UTF-16 LE CSV files into the workspace directory.
 *   6. Stamp the new hash onto ads_audit_runs.emitted_csv_hash so
 *      the next cycle can detect no-op runs.
 *
 * No KG / HTTP / LLM calls. The tool wrapper handles markdown
 * rendering.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  AdsDataStore,
  AdsAccountRow,
  AdsAuditRunRow,
  AdsBlueprintEntityRow,
  CustomerProfileRow,
} from './ads-data-store.js';
import {
  buildAdGroupRow, buildAssetGroupRow, buildAssetRow, buildAudienceSignalRow,
  buildCampaignRow, buildCalloutRow, buildKeywordRow, buildListingGroupRow,
  buildNegativeRow, buildRsaRow, buildSitelinkRow,
  encodeUtf16LeWithBom, renderCsvBody, slugifyCampaignName,
  type CsvRow, type AssetFieldType,
} from './ads-csv-builder.js';
import { validateBlueprint, type ValidationSummary } from './ads-emit-validators.js';
import { getLynoxDir } from './config.js';
import { getWorkspaceDir } from './workspace.js';

export interface EmitResult {
  account: AdsAccountRow;
  customer: CustomerProfileRow;
  run: AdsAuditRunRow;
  validation: ValidationSummary;
  /** SHA-256 over the canonical blueprint state for this run. */
  hash: string;
  /** True when this hash matches the previous run's hash → no files written. */
  idempotent: boolean;
  /** Files written (absolute paths), empty when blocked or idempotent. */
  filesWritten: string[];
  /** Per-file row counts, useful for the markdown summary. */
  perFileRowCounts: Array<{ file: string; rowCount: number }>;
  /** Aggregated row totals across all files. */
  totals: {
    campaigns: number; adGroups: number; keywords: number; rsas: number;
    assetGroups: number; assets: number; audienceSignals: number;
    listingGroups: number; sitelinks: number; callouts: number; negatives: number;
  };
  /** Reason emit was blocked (hard validator errors), null when emit succeeded or was idempotent. */
  blockedReason: string | null;
}

export interface RunEmitOptions {
  /** Workspace base directory. Defaults to LYNOX_WORKSPACE/ads when omitted. */
  workspaceDir?: string | undefined;
  /** Inject "now" for deterministic tests. */
  now?: Date | undefined;
  /** Explicit run id to emit. When omitted, the engine picks the latest run
   *  with blueprint entities. Use this to re-emit a prior run after a fresh
   *  data_pull created a newer audit run that has no blueprint yet (the
   *  pending-import-skip case). */
  runId?: number | undefined;
}

export class EmitPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmitPreconditionError';
  }
}

// ── Public entry point ────────────────────────────────────────────────

export function runEmit(
  store: AdsDataStore, adsAccountId: string, opts?: RunEmitOptions | undefined,
): EmitResult {
  const account = store.getAdsAccount(adsAccountId);
  if (!account) {
    throw new EmitPreconditionError(`Unknown ads_account_id "${adsAccountId}".`);
  }
  const run = resolveTargetRun(store, adsAccountId, opts?.runId);
  if (!run) {
    throw new EmitPreconditionError(
      `No successful audit run with blueprint entities for "${adsAccountId}". ` +
      `Run ads_audit_run + ads_blueprint_run first.`,
    );
  }
  const customer = store.getCustomerProfile(account.customer_id);
  if (!customer) {
    throw new EmitPreconditionError(
      `Customer profile missing for "${account.customer_id}".`,
    );
  }
  const entities = store.listBlueprintEntities(run.run_id);
  if (entities.length === 0) {
    throw new EmitPreconditionError(
      `No blueprint entities for run ${run.run_id}. Run ads_blueprint_run first.`,
    );
  }

  // 1. Validate
  const validation = validateBlueprint(entities, { customer });

  // 2. Build CSVs in memory so we can hash the emit output (PRD:
  //    "hash(emitted-entities)" → use the actual bytes that would be
  //    written, not the structural blueprint, so previous_external_id
  //    differences from history-match do not invalidate idempotency).
  const grouped = groupByCampaign(entities);
  const planned = planCsvFiles(grouped);
  const hash = computeEmitHash(planned);
  const previousRun = run.previous_run_id !== null ? store.getAuditRun(run.previous_run_id) : null;
  // Idempotency must catch two cases: a same-run re-emit (current run
  // already stamped with this hash → no need to re-write the same files)
  // and a true cycle-2 no-op (previous run produced the same hash → no
  // diff to re-import). Without the same-run guard the hash gets
  // recomputed on every call, every file is rewritten, and a passive
  // poll of `runEmit` becomes destructive against a workspace the
  // customer may already be reviewing.
  const idempotent = run.emitted_csv_hash === hash || previousRun?.emitted_csv_hash === hash;

  if (!validation.canEmit) {
    return baseResult(account, customer, run, validation, hash, idempotent, [],
      'Pre-Emit-Validators haben HARD-Errors gemeldet — kein File geschrieben.');
  }

  if (idempotent) {
    return baseResult(account, customer, run, validation, hash, true, [],
      'Blueprint identisch — Hash-Match auf aktuellem oder Vorgänger-Run, kein Re-Emit nötig.');
  }

  // 3. Write files
  const baseDir = resolveWorkspaceDir(opts?.workspaceDir, adsAccountId, run.run_id);
  mkdirSync(baseDir, { recursive: true });

  const filesWritten: string[] = [];
  const perFileRowCounts: Array<{ file: string; rowCount: number }> = [];
  const totals = makeEmptyTotals();

  for (const f of planned) {
    const file = join(baseDir, f.fileName);
    writeFileSync(file, encodeUtf16LeWithBom(f.body));
    filesWritten.push(file);
    perFileRowCounts.push({ file, rowCount: f.rowCount });
    totals.campaigns += f.counts.campaignCount;
    totals.adGroups += f.counts.adGroupCount;
    totals.keywords += f.counts.keywordCount;
    totals.rsas += f.counts.rsaCount;
    totals.assetGroups += f.counts.assetGroupCount;
    totals.assets += f.counts.assetCount;
    totals.audienceSignals += f.counts.audienceSignalCount;
    totals.listingGroups += f.counts.listingGroupCount;
    totals.sitelinks += f.counts.sitelinkCount;
    totals.callouts += f.counts.calloutCount;
    totals.negatives += f.counts.negativeCount;
  }

  // 4. Stamp hash onto the run row.
  store.setEmittedCsvHash(run.run_id, hash);

  return baseResult(account, customer, run, validation, hash, false,
    filesWritten, null, perFileRowCounts, totals);
}

interface BucketCounts {
  campaignCount: number; adGroupCount: number; keywordCount: number;
  rsaCount: number; assetGroupCount: number; assetCount: number;
  audienceSignalCount: number; listingGroupCount: number;
  sitelinkCount: number; calloutCount: number; negativeCount: number;
}

interface PlannedFile {
  fileName: string;
  body: string;
  rowCount: number;
  counts: BucketCounts;
}

function planCsvFiles(grouped: GroupedEmit): PlannedFile[] {
  const files: PlannedFile[] = [];
  const campaignNames = [...grouped.perCampaign.keys()].sort();
  for (const name of campaignNames) {
    const bucket = grouped.perCampaign.get(name)!;
    files.push({
      fileName: `${slugifyCampaignName(name)}.csv`,
      body: renderCsvBody(bucket.rows),
      rowCount: bucket.rows.length,
      counts: {
        campaignCount: bucket.campaignCount, adGroupCount: bucket.adGroupCount,
        keywordCount: bucket.keywordCount, rsaCount: bucket.rsaCount,
        assetGroupCount: bucket.assetGroupCount, assetCount: bucket.assetCount,
        audienceSignalCount: bucket.audienceSignalCount,
        listingGroupCount: bucket.listingGroupCount,
        sitelinkCount: bucket.sitelinkCount, calloutCount: bucket.calloutCount,
        negativeCount: bucket.negativeCount,
      },
    });
  }
  if (grouped.accountNegatives.length > 0) {
    files.push({
      fileName: 'account-negatives.csv',
      body: renderCsvBody(grouped.accountNegatives),
      rowCount: grouped.accountNegatives.length,
      counts: { ...zeroBucketCounts(), negativeCount: grouped.accountNegatives.length },
    });
  }
  return files;
}

function zeroBucketCounts(): BucketCounts {
  return {
    campaignCount: 0, adGroupCount: 0, keywordCount: 0, rsaCount: 0,
    assetGroupCount: 0, assetCount: 0, audienceSignalCount: 0,
    listingGroupCount: 0, sitelinkCount: 0, calloutCount: 0, negativeCount: 0,
  };
}

function makeEmptyTotals(): EmitResult['totals'] {
  return {
    campaigns: 0, adGroups: 0, keywords: 0, rsas: 0,
    assetGroups: 0, assets: 0, audienceSignals: 0,
    listingGroups: 0, sitelinks: 0, callouts: 0, negatives: 0,
  };
}

function computeEmitHash(files: readonly PlannedFile[]): string {
  // Sort by filename for stable hashing across iteration orders, then
  // concatenate filename + body for each file with a separator that
  // cannot occur inside a TSV body.
  const sorted = [...files].sort((a, b) => a.fileName.localeCompare(b.fileName));
  const h = createHash('sha256');
  for (const f of sorted) {
    h.update(f.fileName);
    h.update('\n');
    h.update(f.body);
    h.update('\n');
  }
  return h.digest('hex');
}

// ── Helpers ───────────────────────────────────────────────────────────

function baseResult(
  account: AdsAccountRow, customer: CustomerProfileRow, run: AdsAuditRunRow,
  validation: ValidationSummary, hash: string, idempotent: boolean,
  filesWritten: string[], blockedReason: string | null,
  perFileRowCounts: Array<{ file: string; rowCount: number }> = [],
  totals: EmitResult['totals'] = makeEmptyTotals(),
): EmitResult {
  return {
    account, customer, run, validation, hash, idempotent,
    filesWritten, perFileRowCounts, totals, blockedReason,
  };
}

interface CampaignBucket {
  rows: CsvRow[];
  campaignCount: number;
  adGroupCount: number;
  keywordCount: number;
  rsaCount: number;
  assetGroupCount: number;
  assetCount: number;
  audienceSignalCount: number;
  listingGroupCount: number;
  sitelinkCount: number;
  calloutCount: number;
  negativeCount: number;
}

interface GroupedEmit {
  perCampaign: Map<string, CampaignBucket>;
  accountNegatives: CsvRow[];
}

function newBucket(): CampaignBucket {
  return {
    rows: [], campaignCount: 0, adGroupCount: 0, keywordCount: 0, rsaCount: 0,
    assetGroupCount: 0, assetCount: 0, audienceSignalCount: 0,
    listingGroupCount: 0, sitelinkCount: 0, calloutCount: 0, negativeCount: 0,
  };
}

function groupByCampaign(entities: readonly AdsBlueprintEntityRow[]): GroupedEmit {
  const perCampaign = new Map<string, CampaignBucket>();
  const accountNegatives: CsvRow[] = [];
  const ensureBucket = (name: string): CampaignBucket => {
    let b = perCampaign.get(name);
    if (b) return b;
    b = newBucket();
    perCampaign.set(name, b);
    return b;
  };

  // 1. Campaigns first so each bucket starts with the settings row.
  for (const e of entities) {
    if (e.entity_type !== 'campaign') continue;
    const payload = parsePayload(e.payload_json);
    const name = stringField(payload, 'campaign_name');
    if (!name) continue;
    const bucket = ensureBucket(name);
    const budget = budgetFromPayload(payload);
    const targetCpa = targetCpaFromPayload(payload);
    // KEEP campaigns are existing entities — emit only the name as bucket
    // anchor so child rows reference an existing parent. Status must stay
    // empty so Editor does not flip the live campaign to Paused. NEW/RENAME/
    // PAUSE rows propagate the appropriate status explicitly.
    const explicitStatus = stringField(payload, 'status');
    const status = explicitStatus !== null
      ? editorStatus(explicitStatus)
      : (e.kind === 'KEEP' ? undefined : 'Paused');
    bucket.rows.push(buildCampaignRow({
      campaignName: name,
      campaignType: campaignTypeFromPayload(payload),
      ...(budget !== null ? { budget } : {}),
      ...(stringField(payload, 'bidding_strategy_type') !== null
        ? { bidStrategy: editorBidStrategy(stringField(payload, 'bidding_strategy_type')!) } : {}),
      ...(numberField(payload, 'target_roas') !== null ? { targetRoas: numberField(payload, 'target_roas')! } : {}),
      ...(targetCpa !== null ? { targetCpa } : {}),
      ...(status !== undefined ? { status } : {}),
    }));
    bucket.campaignCount++;
  }

  // 2. Sub-entities.
  for (const e of entities) {
    if (e.entity_type === 'campaign') continue;
    const payload = parsePayload(e.payload_json);

    switch (e.entity_type) {
      case 'ad_group': {
        const campaign = stringField(payload, 'campaign_name');
        const adGroup = stringField(payload, 'ad_group_name');
        if (!campaign || !adGroup) continue;
        const bucket = ensureBucket(campaign);
        bucket.rows.push(buildAdGroupRow({
          campaignName: campaign, adGroupName: adGroup,
          status: e.kind === 'PAUSE' ? 'Paused' : 'Enabled',
        }));
        bucket.adGroupCount++;
        break;
      }
      case 'keyword': {
        const campaign = stringField(payload, 'campaign_name');
        const adGroup = stringField(payload, 'ad_group_name');
        const keyword = stringField(payload, 'keyword');
        if (!campaign || !adGroup || !keyword) continue;
        const bucket = ensureBucket(campaign);
        bucket.rows.push(buildKeywordRow({
          campaignName: campaign, adGroupName: adGroup,
          keyword, matchType: normaliseMatchType(stringField(payload, 'match_type')),
          ...(stringField(payload, 'final_url') !== null ? { finalUrl: stringField(payload, 'final_url')! } : {}),
          status: e.kind === 'PAUSE' ? 'Paused' : 'Enabled',
        }));
        bucket.keywordCount++;
        break;
      }
      case 'rsa_ad': {
        const campaign = stringField(payload, 'campaign_name');
        const adGroup = stringField(payload, 'ad_group_name');
        const headlines = stringArrayField(payload, 'headlines');
        const descriptions = stringArrayField(payload, 'descriptions');
        const finalUrl = stringField(payload, 'final_url');
        if (!campaign || !adGroup || !finalUrl || headlines.length === 0) continue;
        const bucket = ensureBucket(campaign);
        bucket.rows.push(buildRsaRow({
          campaignName: campaign, adGroupName: adGroup,
          headlines, descriptions,
          ...(stringField(payload, 'path1') !== null ? { path1: stringField(payload, 'path1')! } : {}),
          ...(stringField(payload, 'path2') !== null ? { path2: stringField(payload, 'path2')! } : {}),
          finalUrl,
          status: e.kind === 'PAUSE' ? 'Paused' : 'Enabled',
        }));
        bucket.rsaCount++;
        break;
      }
      case 'asset_group': {
        const campaign = stringField(payload, 'campaign_name');
        const groupName = stringField(payload, 'asset_group_name');
        if (!campaign || !groupName) continue;
        const bucket = ensureBucket(campaign);
        // KEEP asset-groups are existing — Status empty so Editor does
        // not pause the running PMax learning. NEW/PAUSE proposals emit
        // Paused so manual review controls go-live.
        const groupStatus = e.kind === 'KEEP' ? undefined : 'Paused';
        bucket.rows.push(buildAssetGroupRow({
          campaignName: campaign, assetGroupName: groupName,
          ...(stringField(payload, 'final_url') !== null ? { finalUrl: stringField(payload, 'final_url')! } : {}),
          ...(stringField(payload, 'final_mobile_url') !== null ? { finalMobileUrl: stringField(payload, 'final_mobile_url')! } : {}),
          ...(stringField(payload, 'path1') !== null ? { path1: stringField(payload, 'path1')! } : {}),
          ...(stringField(payload, 'path2') !== null ? { path2: stringField(payload, 'path2')! } : {}),
          ...(groupStatus !== undefined ? { status: groupStatus } : {}),
        }));
        bucket.assetGroupCount++;
        break;
      }
      case 'asset': {
        const campaign = stringField(payload, 'campaign_name');
        const groupName = stringField(payload, 'asset_group_name');
        const fieldType = parseAssetFieldType(stringField(payload, 'field_type'));
        if (!campaign || !groupName || !fieldType) continue;
        const bucket = ensureBucket(campaign);
        bucket.rows.push(buildAssetRow({
          campaignName: campaign, assetGroupName: groupName,
          fieldType,
          ...(numberField(payload, 'index') !== null ? { index: numberField(payload, 'index')! } : {}),
          ...(stringField(payload, 'text') !== null ? { text: stringField(payload, 'text')! } : {}),
          ...(stringField(payload, 'video_id') !== null ? { videoId: stringField(payload, 'video_id')! } : {}),
          ...(stringField(payload, 'asset_name') !== null ? { assetName: stringField(payload, 'asset_name')! } : {}),
          status: e.kind === 'PAUSE' ? 'Paused' : 'Enabled',
        }));
        bucket.assetCount++;
        break;
      }
      case 'audience_signal': {
        const campaign = stringField(payload, 'campaign_name');
        const groupName = stringField(payload, 'asset_group_name');
        const audienceName = stringField(payload, 'audience_name');
        if (!campaign || !groupName || !audienceName) continue;
        const bucket = ensureBucket(campaign);
        bucket.rows.push(buildAudienceSignalRow({
          campaignName: campaign, assetGroupName: groupName, audienceName,
          ...(stringField(payload, 'interest_categories') !== null ? { interestCategories: stringField(payload, 'interest_categories')! } : {}),
          ...(stringField(payload, 'custom_audience_segments') !== null ? { customAudienceSegments: stringField(payload, 'custom_audience_segments')! } : {}),
          ...(stringField(payload, 'remarketing_segments') !== null ? { remarketingSegments: stringField(payload, 'remarketing_segments')! } : {}),
          status: e.kind === 'PAUSE' ? 'Paused' : 'Enabled',
        }));
        bucket.audienceSignalCount++;
        break;
      }
      case 'listing_group': {
        const campaign = stringField(payload, 'campaign_name');
        const productGroup = stringField(payload, 'product_group');
        if (!campaign || !productGroup) continue;
        const bucket = ensureBucket(campaign);
        bucket.rows.push(buildListingGroupRow({
          campaignName: campaign, productGroup,
          ...(stringField(payload, 'asset_group_name') !== null ? { assetGroupName: stringField(payload, 'asset_group_name')! } : {}),
          ...(stringField(payload, 'product_group_type') !== null ? { productGroupType: stringField(payload, 'product_group_type')! } : {}),
          ...(numberField(payload, 'bid_modifier') !== null ? { bidModifier: numberField(payload, 'bid_modifier')! } : {}),
          status: e.kind === 'PAUSE' ? 'Paused' : 'Enabled',
        }));
        bucket.listingGroupCount++;
        break;
      }
      case 'sitelink': {
        const campaign = stringField(payload, 'campaign_name');
        const text = stringField(payload, 'text');
        const url = stringField(payload, 'final_url');
        if (!campaign || !text || !url) continue;
        const bucket = ensureBucket(campaign);
        bucket.rows.push(buildSitelinkRow({
          campaignName: campaign, text, url,
          ...(stringField(payload, 'desc1') !== null ? { desc1: stringField(payload, 'desc1')! } : {}),
          ...(stringField(payload, 'desc2') !== null ? { desc2: stringField(payload, 'desc2')! } : {}),
          status: e.kind === 'PAUSE' ? 'Paused' : 'Enabled',
        }));
        bucket.sitelinkCount++;
        break;
      }
      case 'callout': {
        const campaign = stringField(payload, 'campaign_name');
        const text = stringField(payload, 'text');
        if (!campaign || !text) continue;
        const bucket = ensureBucket(campaign);
        bucket.rows.push(buildCalloutRow({
          campaignName: campaign, text,
          status: e.kind === 'PAUSE' ? 'Paused' : 'Enabled',
        }));
        bucket.calloutCount++;
        break;
      }
      case 'negative': {
        const keyword = stringField(payload, 'keyword_text');
        const matchType = normaliseMatchType(stringField(payload, 'match_type'));
        const scope = stringField(payload, 'scope');
        const scopeTarget = stringField(payload, 'scope_target');
        if (!keyword) continue;
        if (scope === 'account' || scopeTarget === null) {
          // Account-level negatives go into a shared list. Without an anchor
          // (campaign or shared set) Editor silently drops the row, so the
          // pmax_owned + competitor brand-protection lists never reach the
          // account. Use a stable list name keyed off the source bucket so
          // re-imports update the same set.
          const sharedSetName = scope === 'account' && stringField(payload, 'source') === 'pmax_owned'
            ? 'PMax-Owned Negatives'
            : 'Account Competitor Negatives';
          accountNegatives.push(buildNegativeRow({ keyword, matchType, sharedSetName }));
        } else {
          const bucket = ensureBucket(scopeTarget);
          bucket.rows.push(buildNegativeRow({
            campaignName: scopeTarget, keyword, matchType,
          }));
          bucket.negativeCount++;
        }
        break;
      }
    }
  }

  return { perCampaign, accountNegatives };
}

function normaliseMatchType(s: string | null): 'Exact' | 'Phrase' | 'Broad' {
  const v = (s ?? '').toLowerCase();
  if (v === 'exact' || v === 'phrase' || v === 'broad') {
    return v[0]!.toUpperCase() + v.slice(1) as 'Exact' | 'Phrase' | 'Broad';
  }
  return 'Broad';
}

// Google Ads CIDs are always 10 digits formatted as `123-456-7890`. The
// FK to `ads_accounts` already gates this format at write time, but we
// re-assert it at the workspace boundary as defence in depth: a future
// path that lets the agent create accounts must not be able to escape
// the LYNOX_WORKSPACE root via `../` or absolute-path injection.
const VALID_ADS_ACCOUNT_ID = /^\d{3}-\d{3}-\d{4}$/u;

/** Target run resolution for emit:
 *  - explicit runId from caller (must be a SUCCESS run for the account)
 *  - latest SUCCESS run with at least one blueprint_entity
 *  - falls back to legacy "latest SUCCESS run" if no blueprint entities exist
 *    anywhere (lets the existing "no entities" error surface cleanly)
 *
 *  This unblocks the cycle-3 deadlock: data_pull creates run #N, blueprint
 *  for #N is skipped because run #N-1 has pending entities; emit on #N
 *  would fail. Falling back to #N-1 lets re-emit work without manual run-id
 *  juggling. */
function resolveTargetRun(store: AdsDataStore, adsAccountId: string, requestedId: number | undefined): AdsAuditRunRow | null {
  if (requestedId !== undefined) {
    const explicit = store.getAuditRun(requestedId);
    if (!explicit || explicit.ads_account_id !== adsAccountId) {
      throw new EmitPreconditionError(`Run ${requestedId} not found for ${adsAccountId}.`);
    }
    if (explicit.status !== 'SUCCESS') {
      throw new EmitPreconditionError(`Run ${requestedId} is not in SUCCESS state.`);
    }
    return explicit;
  }
  // Newest SUCCESS run that actually has entities to emit.
  const candidate = store.findLatestRunWithBlueprintEntities(adsAccountId);
  if (candidate) return candidate;
  // No entities anywhere — fall back to legacy "latest SUCCESS" so the
  // existing error path produces a familiar message.
  return store.getLatestSuccessfulAuditRun(adsAccountId);
}

function resolveWorkspaceDir(override: string | undefined, accountId: string, runId: number): string {
  if (!VALID_ADS_ACCOUNT_ID.test(accountId)) {
    throw new EmitPreconditionError(
      `Invalid ads_account_id "${accountId}" — expected Google Ads CID format 123-456-7890.`,
    );
  }
  // Resolve via the same chain the engine HTTP API and the chat file browser
  // use — getWorkspaceDir() respects tenant-scope overrides set during
  // engine init, so emit and the FileBrowserView read/write the same dir.
  // Without this the two diverge (emit -> ~/.lynox/workspace/, browser ->
  // ~/.lynox/workspace/<context>/) and customers cannot reach the CSVs.
  const base = override ?? getWorkspaceDir() ?? join(getLynoxDir(), 'workspace');
  return resolve(base, 'ads', accountId, 'blueprints', `run-${runId}`);
}

function parsePayload(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringField(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numberField(p: Record<string, unknown>, key: string): number | null {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function stringArrayField(p: Record<string, unknown>, key: string): string[] {
  const v = p[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function campaignTypeFromPayload(p: Record<string, unknown>): 'Search' | 'Display' | 'Shopping' | 'Performance Max' | 'Video' {
  const raw = stringField(p, 'channel_type') ?? stringField(p, 'campaign_type') ?? '';
  const v = raw.toUpperCase().replace(/[ _-]+/gu, '_');
  if (v === 'PERFORMANCE_MAX' || v === 'PMAX') return 'Performance Max';
  if (v === 'DISPLAY') return 'Display';
  if (v === 'SHOPPING') return 'Shopping';
  if (v === 'VIDEO') return 'Video';
  return 'Search';
}

function budgetFromPayload(p: Record<string, unknown>): number | null {
  // Snapshot stores micros (Google convention: 1 unit = 1_000_000). Some
  // blueprint payloads emit budget_chf directly. Accept either.
  const micros = numberField(p, 'budget_micros');
  if (micros !== null) return Math.round((micros / 1_000_000) * 100) / 100;
  return numberField(p, 'budget_chf');
}

function targetCpaFromPayload(p: Record<string, unknown>): number | null {
  // Same micros↔display-unit pattern as budget. Snapshot writes
  // target_cpa_micros; agent-proposed payloads may carry target_cpa_chf.
  const micros = numberField(p, 'target_cpa_micros');
  if (micros !== null) return Math.round((micros / 1_000_000) * 100) / 100;
  return numberField(p, 'target_cpa_chf') ?? numberField(p, 'target_cpa');
}

/**
 * Map the Google Ads enum value (TARGET_ROAS, MAXIMIZE_CONVERSION_VALUE,
 * MAXIMIZE_CONVERSIONS, TARGET_CPA, MANUAL_CPC, …) to the human-readable
 * Editor "Bid Strategy Type" value.
 */
function editorBidStrategy(s: string): string {
  const v = s.toUpperCase();
  switch (v) {
    case 'TARGET_ROAS': return 'Target ROAS';
    case 'MAXIMIZE_CONVERSION_VALUE': return 'Maximize conversion value';
    case 'TARGET_CPA': return 'Target CPA';
    case 'MAXIMIZE_CONVERSIONS': return 'Maximize conversions';
    case 'MANUAL_CPC': return 'Manual CPC';
    case 'MAXIMIZE_CLICKS': return 'Maximize clicks';
    case 'TARGET_IMPRESSION_SHARE': return 'Target impression share';
    case 'MANUAL_CPM': return 'Manual CPM';
    case 'MANUAL_CPV': return 'Manual CPV';
    default: return 'Maximize conversions';
  }
}

function editorStatus(s: string): 'Paused' | 'Enabled' | 'Removed' {
  const v = s.toLowerCase();
  if (v === 'enabled') return 'Enabled';
  if (v === 'removed' || v === 'disabled') return 'Removed';
  return 'Paused';
}

function parseAssetFieldType(s: string | null): AssetFieldType | null {
  if (!s) return null;
  const v = s.toUpperCase().replace(/[ -]+/gu, '_');
  const allowed: AssetFieldType[] = [
    'HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION',
    'BUSINESS_NAME', 'CALL_TO_ACTION',
    'IMAGE', 'LOGO', 'VIDEO',
  ];
  return (allowed as readonly string[]).includes(v) ? (v as AssetFieldType) : null;
}
