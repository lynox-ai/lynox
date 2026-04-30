/**
 * Ads Optimizer — deterministic audit engine.
 *
 * Pure read/compute over the SQLite snapshot written by ads_data_pull.
 * The engine NEVER calls external APIs (DataForSEO, LP-crawl, GA4 OAuth).
 * Qualitative findings discovered via DataForSEO/LP-crawl/tracking-audit
 * are added by the agent loop via ads_finding_add.
 *
 * Outputs:
 *  - Structured AuditResult (consumed by the markdown report renderer
 *    and by P3 Blueprint via SQLite reads — never serialised back into
 *    the agent context as JSON).
 *  - Findings persisted to the ads_findings SQLite table AND mirrored
 *    to KG via knowledgeLayer.store() at the tool layer (hybrid storage).
 */
import type {
  AdsDataStore,
  AdsAuditRunRow,
  AdsAccountRow,
  CustomerProfileRow,
  AdsFindingSeverity,
  InsertFindingInput,
} from './ads-data-store.js';
import {
  wilsonScoreInterval,
  classifyWilsonDelta,
  type WilsonClassification,
  type WilsonInterval,
} from './ads-wilson-score.js';

// Mode-detection: a snapshot needs at least this many distinct
// performance-days to count as OPTIMIZE-eligible. Below the threshold
// we recommend BOOTSTRAP (additive-only) regardless of prior-run state.
const MIN_OPTIMIZE_DAYS = 30;

// Performance verification window length (in days). Comparison is
// post-import (current run) vs pre-import (previous run, the equivalent
// number of days immediately before its emission). Shrinks toward
// MIN_VERIFY_WINDOW_DAYS if either side has insufficient data.
const DEFAULT_VERIFY_WINDOW_DAYS = 28;
const MIN_VERIFY_WINDOW_DAYS = 7;

// Stale-data warning threshold above the freshness limit enforced by
// data-pull. Issued as a deterministic finding when crossed.
const STALE_DATA_WARN_DAYS = 7;

// Disagreement threshold between Ads-reported and GA4-reported conversions
// at which we emit a tracking-trust finding.
const GA4_CONVERSION_DELTA_HIGH = 0.2;

type Goal = 'roas' | 'cpa' | 'leads' | 'traffic' | 'awareness' | 'unknown';

export type VerificationKind = 'roas' | 'cpa' | 'volume';

/**
 * Audit modes:
 * - BOOTSTRAP: first run for the account, OR <30 days of performance data.
 *   Output is additive-only (negatives, sitelinks, callouts, missing assets).
 *   No restructure, no performance-verification.
 * - FIRST_IMPORT: prior run exists with >=30 days data BUT no editor-import
 *   has happened yet, OR import is <14 days old (smart-bidding still learning).
 *   Output covers history-preservation + restructure proposals, but skips
 *   performance-verification because there is no import to compare against.
 * - OPTIMIZE: prior run exists, last_major_import_at >=14 days ago.
 *   Full pipeline: history-preservation + restructure + Wilson-score
 *   performance-verification on the post-import window.
 */
export type AuditMode = 'BOOTSTRAP' | 'FIRST_IMPORT' | 'OPTIMIZE';

const SMART_BIDDING_LEARNING_DAYS = 14;

/** Mode ranking for the mode_mismatch detector: BOOTSTRAP is most
 *  restrictive (rank 0), OPTIMIZE is least (rank 2). Mismatch only fires
 *  when detected < recorded — i.e. the run was tagged optimistically but
 *  audit found less to work with than expected. */
const MODE_RANK: Record<AuditMode, number> = {
  BOOTSTRAP: 0,
  FIRST_IMPORT: 1,
  OPTIMIZE: 2,
};

export interface AuditKpis {
  spend: number;
  conversions: number;
  convValue: number;
  roas: number | null;
  cpa: number | null;
  ctr: number | null;
  clicks: number;
  impressions: number;
}

export interface ModeDetection {
  detected: AuditMode;
  recordedRunMode: AuditMode;
  recordedAccountMode: AuditMode;
  detectedReason: string;
  performanceDays: number;
}

export interface ManualChangeSummary {
  totalChanges: number;
  byOperation: Array<{ operation: string; count: number }>;
  byResourceType: Array<{ resourceType: string; count: number }>;
  driftAgainstEmittedEntities: number;
  firstChange: string | null;
  lastChange: string | null;
}

export interface PerformanceVerificationItem {
  entityType: string;
  entityExternalId: string;
  classification: WilsonClassification;
  prevWindow: WilsonInterval;
  currWindow: WilsonInterval;
  windowDays: number;
  prevDirection: number | null;
  currDirection: number | null;
  goalDelta: number | null;
  notes?: string | undefined;
}

export interface PerformanceVerificationSummary {
  kind: VerificationKind;
  goal: Goal;
  windowDays: number;
  cutoff: string | null;
  counts: Record<WilsonClassification, number>;
  items: PerformanceVerificationItem[];
  skipped: boolean;
  skippedReason?: string | undefined;
}

export interface AuditFindingDraft {
  area: string;
  severity: AdsFindingSeverity;
  text: string;
  confidence: number;
  evidence?: Record<string, unknown> | undefined;
}

export interface AuditResult {
  account: AdsAccountRow;
  customer: CustomerProfileRow | null;
  run: AdsAuditRunRow;
  previousRun: AdsAuditRunRow | null;
  kpis: AuditKpis;
  /** P4: KPIs of the previous run (when one exists). Used by the
   *  cycle-anomaly detector and the strategist brief's last-cycle
   *  impact narrative. Null on cycle 1 / when there is no previous
   *  successful run. */
  previousKpis: AuditKpis | null;
  mode: ModeDetection;
  manualChanges: ManualChangeSummary | null;
  verification: PerformanceVerificationSummary | null;
  findings: AuditFindingDraft[];
}

export interface RunAuditOptions {
  /** Override the verification window (default 28d, min 7d). */
  verifyWindowDays?: number | undefined;
  /** Inject "now" for deterministic tests. */
  now?: Date | undefined;
}

export class AuditPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditPreconditionError';
  }
}

// ── Public entry point ────────────────────────────────────────────────

export function runAudit(store: AdsDataStore, adsAccountId: string, opts?: RunAuditOptions): AuditResult {
  const account = store.getAdsAccount(adsAccountId);
  if (!account) {
    throw new AuditPreconditionError(`Unknown ads_account_id "${adsAccountId}". Run ads_data_pull first.`);
  }
  const run = store.getLatestSuccessfulAuditRun(adsAccountId);
  if (!run) {
    throw new AuditPreconditionError(
      `No successful audit run for "${adsAccountId}". Run ads_data_pull and ensure it completes.`,
    );
  }
  const customer = store.getCustomerProfile(account.customer_id);
  const previousRun = run.previous_run_id !== null
    ? store.getAuditRun(run.previous_run_id)
    : null;

  const kpis = computeKpis(store, run);
  const previousKpis = previousRun !== null ? computeKpis(store, previousRun) : null;
  const mode = detectMode(store, account, run);
  const manualChanges = run.previous_run_id !== null
    ? summariseManualChanges(store, run, previousRun)
    : null;
  const verifyWindowDays = clampWindow(opts?.verifyWindowDays);
  // Performance-verification only meaningful in OPTIMIZE mode: prior run +
  // editor-import + smart-bidding-window elapsed. In BOOTSTRAP/FIRST_IMPORT
  // there is nothing meaningful to verify.
  const verification = (previousRun !== null && mode.detected === 'OPTIMIZE')
    ? verifyPerformance(store, account, run, previousRun, customer, verifyWindowDays)
    : null;

  const findings = generateDeterministicFindings({
    store, account, customer, run, previousRun,
    kpis, previousKpis, mode, manualChanges, verification,
    now: opts?.now ?? new Date(),
    snapshotCache: new Map<string, unknown[]>(),
  });

  return {
    account, customer, run, previousRun, kpis, previousKpis, mode,
    manualChanges, verification, findings,
  };
}

/**
 * Convenience wrapper that runs the audit and persists all
 * deterministic findings to ads_findings (and back into AuditResult
 * with the assigned finding_ids exposed via evidence.finding_id).
 *
 * KG mirroring is performed at the tool layer because the
 * KnowledgeLayer is not a dependency of this pure module.
 */
export function runAuditAndPersist(
  store: AdsDataStore,
  adsAccountId: string,
  opts?: RunAuditOptions,
): AuditResult & { persistedFindingIds: number[] } {
  const result = runAudit(store, adsAccountId, opts);
  const ids: number[] = [];
  for (const f of result.findings) {
    const input: InsertFindingInput = {
      runId: result.run.run_id,
      adsAccountId,
      area: f.area,
      severity: f.severity,
      source: 'deterministic',
      text: f.text,
      confidence: f.confidence,
      evidence: f.evidence,
    };
    const row = store.insertFinding(input);
    ids.push(row.finding_id);
  }
  return { ...result, persistedFindingIds: ids };
}

// ── Internals: KPIs ───────────────────────────────────────────────────

function computeKpis(store: AdsDataStore, run: AdsAuditRunRow): AuditKpis {
  const rows = store.queryView('view_audit_kpis', run.ads_account_id, { runId: run.run_id });
  const r = rows[0] ?? {};
  const spend = numberOrZero(r['spend']);
  const conversions = numberOrZero(r['conversions']);
  const convValue = numberOrZero(r['conv_value']);
  const roas = nonNullableNumber(r['roas']);
  const cpa = nonNullableNumber(r['cpa']);
  const ctr = nonNullableNumber(r['ctr']);
  // clicks/impressions are not in the view; fold an extra read.
  const clickRow = store.getSnapshotRows<{ clicks: number | null; impressions: number | null }>(
    'ads_campaigns', run.ads_account_id, { runId: run.run_id },
  );
  let clicks = 0, impressions = 0;
  for (const c of clickRow) {
    clicks += c.clicks ?? 0;
    impressions += c.impressions ?? 0;
  }
  return { spend, conversions, convValue, roas, cpa, ctr, clicks, impressions };
}

// ── Internals: Mode detection ─────────────────────────────────────────

function detectMode(store: AdsDataStore, account: AdsAccountRow, run: AdsAuditRunRow): ModeDetection {
  const performanceDays = countPerformanceDays(store, run);
  const hasPrevSuccess = store.listAuditRuns(account.ads_account_id, 50)
    .filter(r => r.status === 'SUCCESS' && r.run_id !== run.run_id).length > 0;
  let detected: AuditMode;
  let detectedReason: string;
  if (!hasPrevSuccess) {
    detected = 'BOOTSTRAP';
    detectedReason = 'Erstrun (kein Vorgänger-Erfolgsrun) — additive Empfehlungen.';
  } else if (performanceDays < MIN_OPTIMIZE_DAYS) {
    detected = 'BOOTSTRAP';
    detectedReason = `Nur ${performanceDays} Tage Performance-Daten (min. ${MIN_OPTIMIZE_DAYS} für OPTIMIZE).`;
  } else {
    // Prior run + enough data. Distinguish OPTIMIZE from FIRST_IMPORT by
    // whether the customer has actually imported the previous blueprint
    // and the smart-bidding learning window has elapsed.
    const importIso = account.last_major_import_at;
    const importAgeDays = importIso === null
      ? null
      : (Date.now() - new Date(importIso).getTime()) / (24 * 60 * 60 * 1000);
    if (importIso === null) {
      detected = 'FIRST_IMPORT';
      detectedReason = `Vorgänger-Run vorhanden, aber noch kein Editor-Import (last_major_import_at=null). ` +
        `Restructure-Output erlaubt; Performance-Verification skipped (nichts zu verifizieren).`;
    } else if (importAgeDays !== null && importAgeDays < SMART_BIDDING_LEARNING_DAYS) {
      detected = 'FIRST_IMPORT';
      detectedReason = `Letzter Import war ${importAgeDays.toFixed(1)} Tage her ` +
        `(< ${SMART_BIDDING_LEARNING_DAYS}d Smart-Bidding-Lernfenster). ` +
        `Restructure-Output erlaubt; Performance-Verification skipped (zu früh).`;
    } else {
      detected = 'OPTIMIZE';
      detectedReason = `${performanceDays} Tage Performance-Daten + Import vor ${(importAgeDays ?? 0).toFixed(0)} Tagen — ` +
        `voller Restructure + Performance-Verification.`;
    }
  }
  return {
    detected,
    recordedRunMode: run.mode,
    recordedAccountMode: account.mode,
    detectedReason,
    performanceDays,
  };
}

function countPerformanceDays(store: AdsDataStore, run: AdsAuditRunRow): number {
  const rows = store.getSnapshotRows<{ date: string }>(
    'ads_campaign_performance', run.ads_account_id, { runId: run.run_id },
  );
  const set = new Set<string>();
  for (const r of rows) if (r.date) set.add(r.date);
  return set.size;
}

/** Lower-case + dedupe brand tokens from own_brands + sold_brands.
 *  Filters out very short tokens (<=2 chars) which would over-match. */
function collectBrandTokens(customer: CustomerProfileRow): string[] {
  const fromOwn = parseBrandJsonArray(customer.own_brands);
  const fromSold = parseBrandJsonArray(customer.sold_brands);
  const all = [...fromOwn, ...fromSold]
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 2);
  return Array.from(new Set(all));
}

function parseBrandJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

interface ThemeCluster {
  token: string;
  clusters: number;
  sample: string[];
}

interface BrandSearchDefaults {
  dailyBudgetChf: number;
  targetCpaChf: number;
  reasoning: string;
}

interface BrandSearchTermRow {
  search_term: string | null;
  clicks: number | null;
  cost_micros: number | null;
}

/** Conservative-but-data-driven defaults for the brand-search-campaign that
 *  the brand-inflation finding recommends. Three formulas in priority order;
 *  the first one with usable data wins:
 *
 *  1. Real brand-search history (preferred): sum clicks × cost across the
 *     last 30 days for search_terms containing any brand token. This is the
 *     existing brand demand (some via Search ad_groups, some via PMax) and
 *     gives a direct daily-budget anchor. CPA target = real brand-CPA.
 *  2. PMax-cluster volume: when no Search rows exist (brand demand absorbed
 *     entirely by PMax), use cluster-count × 0.5 click/day × 2 CHF avg-brand
 *     CPC × 1.2 headroom. CPA target = account-wide CPA × 0.5.
 *  3. Fallback when neither branch produced data: cluster-count × 1.5 CHF
 *     per cluster floor. Floor at CHF 5/day total.
 *
 *  The earlier formula (clusters × 1 click/day × 3 CHF × 1.5) over-shot by
 *  ~3× because it (a) treated each cluster as an independent click, ignoring
 *  query-overlap, and (b) used the account-wide CPC instead of brand-CPC,
 *  which on most CH accounts runs 30-50% lower than blended.
 */
function brandSearchDefaults(
  brandedClusters: number, kpis: AuditKpis,
  brandSearchRows: readonly BrandSearchTermRow[],
  brandTokens: readonly string[],
): BrandSearchDefaults {
  const accountCpa = (kpis.cpa !== null && kpis.cpa > 0) ? kpis.cpa : 30;
  const targetCpa = Math.max(5, Math.round(accountCpa * 0.5));

  // Path 1: real Search history for brand terms.
  const lcTokens = brandTokens.map(t => t.toLowerCase()).filter(t => t.length > 0);
  const branded = brandSearchRows.filter(r => {
    const term = (r.search_term ?? '').toLowerCase();
    return term.length > 0 && lcTokens.some(t => term.includes(t));
  });
  if (branded.length > 0) {
    const totalCost = branded.reduce((s, r) => s + (Number(r.cost_micros) || 0), 0) / 1_000_000;
    const totalClicks = branded.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
    if (totalCost > 0) {
      // Snapshot covers the last 30 days. Cost-per-day × 1.2 headroom.
      const dailyBudget = Math.max(5, Math.round((totalCost / 30) * 1.2));
      return {
        dailyBudgetChf: dailyBudget,
        targetCpaChf: targetCpa,
        reasoning:
          `dailyBudget = sum(brand_search_term_cost_30d=${totalCost.toFixed(2)} CHF, ` +
          `clicks=${totalClicks}) / 30 × 1.2; ` +
          `targetCpa = round(account_cpa(${accountCpa.toFixed(2)}) × 0.5).`,
      };
    }
  }

  // Path 2: PMax-cluster proxy.
  if (brandedClusters > 0) {
    // 0.5 click/day per cluster (overlapping queries), CHF 2 brand-CPC,
    // 1.2 headroom. Floor at CHF 5/day so a 1-cluster account still has
    // budget.
    const dailyBudget = Math.max(5, Math.round(brandedClusters * 0.5 * 2 * 1.2));
    return {
      dailyBudgetChf: dailyBudget,
      targetCpaChf: targetCpa,
      reasoning:
        `dailyBudget = brandedClusters(${brandedClusters}) × 0.5 click/day × 2 CHF brand-CPC × 1.2 ` +
        `(no Search-side brand history; PMax absorbs all brand traffic); ` +
        `targetCpa = round(account_cpa(${accountCpa.toFixed(2)}) × 0.5).`,
    };
  }

  // Path 3: nothing observable; minimal launch budget.
  return {
    dailyBudgetChf: 5,
    targetCpaChf: targetCpa,
    reasoning: `no brand-search history and no PMax brand-clusters detected; minimum launch budget.`,
  };
}

/** Cluster untargeted PMax search-term labels by their dominant token.
 *  Stop-words and 1-2-char tokens are dropped. Each label can contribute to
 *  multiple themes (a label "wasserfilter küche" lifts both "wasserfilter"
 *  and "küche"), but the engine returns themes sorted by cluster-count
 *  descending so the agent always sees the highest-volume themes first. */
function clusterUntargetedThemes(
  rows: ReadonlyArray<{ search_category: string | null }>,
  brandTokens: ReadonlyArray<string>,
  existingGroups: ReadonlyArray<string>,
): ThemeCluster[] {
  const themeCount = new Map<string, { count: number; sample: Set<string> }>();
  for (const r of rows) {
    const label = (r.search_category ?? '').toLowerCase().trim();
    if (!label) continue;
    if (brandTokens.some(t => label.includes(t))) continue;
    if (existingGroups.some(g => label.includes(g))) continue;
    for (const token of tokenize(label)) {
      let bucket = themeCount.get(token);
      if (!bucket) {
        bucket = { count: 0, sample: new Set() };
        themeCount.set(token, bucket);
      }
      bucket.count += 1;
      if (bucket.sample.size < 5) bucket.sample.add(label);
    }
  }
  return Array.from(themeCount.entries())
    .map(([token, b]) => ({ token, clusters: b.count, sample: Array.from(b.sample) }))
    .sort((a, b) => b.clusters - a.clusters);
}

/** Articles, prepositions, conjunctions (DE + EN). True linguistic
 *  noise — these can never be a theme, regardless of customer context.
 *
 *  Funnel words ("kaufen", "online", "günstig", …), country / language
 *  names ("schweiz", "water", …) and other context-dependent tokens
 *  used to live here as a hardcoded list. Phase B replaces that with
 *  an LLM classifier (`ads-theme-classifier`) that judges every
 *  surviving token against the customer profile (country, languages,
 *  top_products, brands). Drop the static list, let the model decide.
 */
const LINGUISTIC_STOPWORDS = new Set([
  // German articles, prepositions, conjunctions.
  'der', 'die', 'das', 'und', 'oder', 'mit', 'für', 'fuer', 'auf', 'aus',
  'ein', 'eine', 'einen', 'eines', 'einem', 'einer', 'den', 'dem', 'des',
  'im', 'in', 'an', 'zu', 'zum', 'zur', 'von', 'vom', 'bei',
  // English equivalents.
  'the', 'and', 'for', 'with', 'from', 'into',
]);

function tokenize(label: string): string[] {
  return label
    .split(/[^\p{L}\p{N}]+/u)
    .map(t => t.trim())
    .filter(t => t.length >= 4 && !LINGUISTIC_STOPWORDS.has(t));
}

interface PerfOutlier {
  segment: string;
  spend_chf: number;
  conv_rate: number;
  account_mean: number;
  delta_pct: number;
}

/** Per-device aggregation across the snapshot. Flags devices where:
 *   - conv-rate is < 50% of account mean,
 *   - and spend ≥ 5% of total account spend (non-trivial),
 *   - and clicks ≥ 50 (sample-size floor).
 *  Returns sorted by spend descending. */
function detectDevicePerformanceOutliers(store: AdsDataStore, run: AdsAuditRunRow): PerfOutlier[] {
  const rows = store.getSnapshotRows<{ device: string; clicks: number | null; cost_micros: number | null; conversions: number | null }>(
    'ads_device_performance', run.ads_account_id, { runId: run.run_id },
  );
  return aggregatePerfOutliers(rows.map(r => ({
    segment: r.device, clicks: r.clicks, cost_micros: r.cost_micros, conversions: r.conversions,
  })));
}

function detectGeoPerformanceOutliers(store: AdsDataStore, run: AdsAuditRunRow): PerfOutlier[] {
  const rows = store.getSnapshotRows<{ geo_target_region: string | null; clicks: number | null; cost_micros: number | null; conversions: number | null }>(
    'ads_geo_performance', run.ads_account_id, { runId: run.run_id },
  );
  return aggregatePerfOutliers(rows.map(r => ({
    segment: r.geo_target_region ?? 'unknown',
    clicks: r.clicks, cost_micros: r.cost_micros, conversions: r.conversions,
  })));
}

function aggregatePerfOutliers(
  rows: ReadonlyArray<{ segment: string; clicks: number | null; cost_micros: number | null; conversions: number | null }>,
): PerfOutlier[] {
  if (rows.length === 0) return [];
  const agg = new Map<string, { clicks: number; spend_micros: number; conv: number }>();
  let totalClicks = 0, totalSpendMicros = 0, totalConv = 0;
  for (const r of rows) {
    const seg = r.segment || 'unknown';
    const clicks = r.clicks ?? 0;
    const spend = r.cost_micros ?? 0;
    const conv = r.conversions ?? 0;
    let bucket = agg.get(seg);
    if (!bucket) { bucket = { clicks: 0, spend_micros: 0, conv: 0 }; agg.set(seg, bucket); }
    bucket.clicks += clicks;
    bucket.spend_micros += spend;
    bucket.conv += conv;
    totalClicks += clicks;
    totalSpendMicros += spend;
    totalConv += conv;
  }
  if (totalClicks < 100 || totalSpendMicros === 0) return [];
  const accountConvRate = totalConv / totalClicks;
  if (accountConvRate <= 0) return [];
  const out: PerfOutlier[] = [];
  for (const [segment, b] of agg.entries()) {
    if (b.clicks < 50) continue;                                  // sample-size floor
    const segSpendShare = b.spend_micros / totalSpendMicros;
    if (segSpendShare < 0.05) continue;                           // <5% spend share — skip
    const segConvRate = b.clicks > 0 ? b.conv / b.clicks : 0;
    const deltaPct = (segConvRate - accountConvRate) / accountConvRate;
    if (deltaPct >= -0.5) continue;                               // need ≥50% worse
    out.push({
      segment,
      spend_chf: round2(b.spend_micros / 1_000_000),
      conv_rate: round2(segConvRate),
      account_mean: round2(accountConvRate),
      delta_pct: Math.round(deltaPct * 100),
    });
  }
  return out.sort((a, b) => b.spend_chf - a.spend_chf);
}

// ── Internals: Manual change summary ──────────────────────────────────

function summariseManualChanges(
  store: AdsDataStore, run: AdsAuditRunRow, previousRun: AdsAuditRunRow | null,
): ManualChangeSummary {
  const changes = store.getSnapshotRows<{
    change_date: string; resource_type: string | null; operation: string | null;
    campaign_name: string | null;
  }>('ads_change_history', run.ads_account_id, { runId: run.run_id });

  const cutoff = previousRun?.finished_at ?? previousRun?.started_at ?? null;
  const filtered = cutoff
    ? changes.filter(c => c.change_date >= cutoff.slice(0, 10))
    : changes;

  const byOpMap = new Map<string, number>();
  const byResMap = new Map<string, number>();
  let firstChange: string | null = null;
  let lastChange: string | null = null;
  for (const c of filtered) {
    const op = c.operation ?? 'UNKNOWN';
    const res = c.resource_type ?? 'UNKNOWN';
    byOpMap.set(op, (byOpMap.get(op) ?? 0) + 1);
    byResMap.set(res, (byResMap.get(res) ?? 0) + 1);
    if (!firstChange || c.change_date < firstChange) firstChange = c.change_date;
    if (!lastChange || c.change_date > lastChange) lastChange = c.change_date;
  }

  // Drift: changes touching campaign names that we emitted (KEEP/NEW/RENAME)
  // in the previous run. campaign-name match is a heuristic — change-history
  // rarely carries entity IDs reliably, and ads_run_decisions external_ids
  // are entity-IDs rather than names. We still flag the count separately.
  let drift = 0;
  if (previousRun) {
    const decisions = store.getRunDecisions(previousRun.run_id);
    const emittedExternalIds = new Set(decisions.map(d => d.entity_external_id));
    for (const c of filtered) {
      // best-effort — change_history's campaign_name matches snapshot names,
      // not raw IDs. We compare anyway, conservatively counting hits.
      if (c.campaign_name && emittedExternalIds.has(c.campaign_name)) drift++;
    }
  }

  return {
    totalChanges: filtered.length,
    byOperation: [...byOpMap.entries()].map(([operation, count]) => ({ operation, count }))
      .sort((a, b) => b.count - a.count),
    byResourceType: [...byResMap.entries()].map(([resourceType, count]) => ({ resourceType, count }))
      .sort((a, b) => b.count - a.count),
    driftAgainstEmittedEntities: drift,
    firstChange,
    lastChange,
  };
}

// ── Internals: Performance verification ───────────────────────────────

function clampWindow(input: number | undefined): number {
  if (input === undefined) return DEFAULT_VERIFY_WINDOW_DAYS;
  if (input < MIN_VERIFY_WINDOW_DAYS) return MIN_VERIFY_WINDOW_DAYS;
  if (input > 90) return 90;
  return Math.floor(input);
}

function verifyPerformance(
  store: AdsDataStore,
  account: AdsAccountRow,
  run: AdsAuditRunRow,
  previousRun: AdsAuditRunRow,
  customer: CustomerProfileRow | null,
  windowDays: number,
): PerformanceVerificationSummary {
  const goal = parseGoal(customer?.primary_goal);
  const kind = goalToVerificationKind(goal);
  const cutoffIso = account.last_major_import_at ?? previousRun.finished_at ?? previousRun.started_at;
  if (!cutoffIso) {
    return makeSkippedVerification(kind, goal, windowDays, null, 'Kein last_major_import_at — Window unbestimmt.');
  }

  const decisions = store.getRunDecisions(previousRun.run_id);
  const trackable = decisions.filter(d => d.decision === 'KEEP' || d.decision === 'NEW' || d.decision === 'RENAME');
  if (trackable.length === 0) {
    return makeSkippedVerification(kind, goal, windowDays, cutoffIso,
      'Keine KEEP/NEW/RENAME-Entscheidungen aus dem Vorgänger-Run.');
  }

  // Resolve campaign-id-by-name once for both windows.
  const currCampaignIds = buildCampaignIdMap(store, run);
  const prevCampaignIds = buildCampaignIdMap(store, previousRun);

  const cutoffDate = cutoffIso.slice(0, 10);
  const currWindow = computeWindowRange(cutoffDate, +1, windowDays);
  const prevWindow = computeWindowRange(cutoffDate, -1, windowDays);

  // Both windows are read from the current run's perf snapshot. With
  // GAS export DATE_RANGE = LAST_90_DAYS the snapshot reaches back
  // far enough to cover a 28d pre-cutoff window even when the
  // customer imported a few weeks after the previous run — falling
  // back to previousRun's snapshot was the original design but its
  // own date range may end BEFORE the cutoff (the import is by
  // definition after the prev run finished), silently producing
  // stale or empty pre-window stats. One read + bucket also avoids
  // the O(decisions × perf_rows) re-scan the per-campaign loop did.
  const perfByCampaign = bucketPerformanceByCampaign(store, run);

  const items: PerformanceVerificationItem[] = [];
  const counts: Record<WilsonClassification, number> = {
    ERFOLG: 0, VERSCHLECHTERUNG: 0, NEUTRAL: 0, NICHT_VERGLEICHBAR: 0,
  };

  for (const d of trackable) {
    if (d.entity_type !== 'campaign') {
      // V1: only campaign-level verification (campaign_performance is the
      // only daily time-series we have). Sub-entity verification is V2.
      continue;
    }
    const currId = currCampaignIds.get(d.entity_external_id);
    const prevId = prevCampaignIds.get(d.entity_external_id) ?? prevCampaignIds.get(d.previous_external_id ?? '');
    // Use the current run's perf snapshot for BOTH windows. Match
    // each window to the resolved campaign id; if the campaign was
    // renamed across runs we look it up under the previous id too,
    // because the perf rows are keyed on the GAS-export id which is
    // stable across renames.
    const lookupId = currId ?? prevId ?? d.entity_external_id;
    const rows = perfByCampaign.get(lookupId) ?? [];

    const currStats = aggregateBucket(rows, currWindow);
    const prevStats = aggregateBucket(rows, prevWindow);

    const prevWilson = wilsonScoreInterval(roundConv(prevStats.conversions, prevStats.clicks), prevStats.clicks);
    const currWilson = wilsonScoreInterval(roundConv(currStats.conversions, currStats.clicks), currStats.clicks);
    const classification = classifyWilsonDelta(prevWilson, currWilson);
    counts[classification]++;

    items.push({
      entityType: d.entity_type,
      entityExternalId: d.entity_external_id,
      classification,
      prevWindow: prevWilson,
      currWindow: currWilson,
      windowDays,
      prevDirection: directionKpi(kind, prevStats),
      currDirection: directionKpi(kind, currStats),
      goalDelta: directionDelta(kind, prevStats, currStats),
      ...(currId === undefined ? { notes: 'Entity im aktuellen Snapshot nicht gefunden — paused/removed?' } : {}),
    });
  }

  return {
    kind, goal, windowDays, cutoff: cutoffIso,
    counts, items, skipped: false,
  };
}

function makeSkippedVerification(
  kind: VerificationKind, goal: Goal, windowDays: number, cutoff: string | null, reason: string,
): PerformanceVerificationSummary {
  return {
    kind, goal, windowDays, cutoff,
    counts: { ERFOLG: 0, VERSCHLECHTERUNG: 0, NEUTRAL: 0, NICHT_VERGLEICHBAR: 0 },
    items: [], skipped: true, skippedReason: reason,
  };
}

interface WindowStats {
  clicks: number;
  conversions: number;
  costMicros: number;
  convValue: number;
  impressions: number;
}

function zeroStats(): WindowStats {
  return { clicks: 0, conversions: 0, costMicros: 0, convValue: 0, impressions: 0 };
}

interface PerfRow {
  date: string;
  campaign_id: string;
  clicks: number | null;
  conversions: number | null;
  cost_micros: number | null;
  conv_value: number | null;
  impressions: number | null;
}

/** Read campaign_performance once per run, bucket by campaign_id so the
 *  per-decision verification loop is O(rows + decisions × window) instead
 *  of O(rows × decisions). */
function bucketPerformanceByCampaign(store: AdsDataStore, run: AdsAuditRunRow): Map<string, PerfRow[]> {
  const rows = store.getSnapshotRows<PerfRow>(
    'ads_campaign_performance', run.ads_account_id, { runId: run.run_id },
  );
  const map = new Map<string, PerfRow[]>();
  for (const r of rows) {
    if (!r.campaign_id) continue;
    let bucket = map.get(r.campaign_id);
    if (!bucket) {
      bucket = [];
      map.set(r.campaign_id, bucket);
    }
    bucket.push(r);
  }
  return map;
}

function aggregateBucket(rows: readonly PerfRow[], range: { start: string; end: string }): WindowStats {
  const stats = zeroStats();
  for (const r of rows) {
    if (r.date < range.start || r.date > range.end) continue;
    stats.clicks += r.clicks ?? 0;
    stats.conversions += r.conversions ?? 0;
    stats.costMicros += r.cost_micros ?? 0;
    stats.convValue += r.conv_value ?? 0;
    stats.impressions += r.impressions ?? 0;
  }
  return stats;
}

function buildCampaignIdMap(store: AdsDataStore, run: AdsAuditRunRow): Map<string, string> {
  const rows = store.getSnapshotRows<{ campaign_id: string; campaign_name: string }>(
    'ads_campaigns', run.ads_account_id, { runId: run.run_id },
  );
  const m = new Map<string, string>();
  // ID-keyed entries first; name-keyed entries only when the name is a
  // non-empty string that isn't already a known campaign id (otherwise a
  // customer who names a campaign as a digit string matching another
  // campaign's stable id would overwrite the id-keyed lookup).
  for (const r of rows) {
    if (r.campaign_id) m.set(r.campaign_id, r.campaign_id);
  }
  for (const r of rows) {
    if (r.campaign_id && typeof r.campaign_name === 'string' && r.campaign_name.length > 0
        && !m.has(r.campaign_name)) {
      m.set(r.campaign_name, r.campaign_id);
    }
  }
  return m;
}

function computeWindowRange(centreDate: string, direction: 1 | -1, days: number): { start: string; end: string } {
  const centre = new Date(centreDate + 'T00:00:00Z');
  if (Number.isNaN(centre.getTime())) {
    return { start: centreDate, end: centreDate };
  }
  if (direction === +1) {
    const start = new Date(centre.getTime() + 24 * 60 * 60 * 1000);
    const end = new Date(centre.getTime() + days * 24 * 60 * 60 * 1000);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  const end = new Date(centre.getTime());
  const start = new Date(centre.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function parseGoal(value: string | null | undefined): Goal {
  if (!value) return 'unknown';
  const v = value.toLowerCase();
  if (v === 'roas' || v === 'cpa' || v === 'leads' || v === 'traffic' || v === 'awareness') return v;
  return 'unknown';
}

function goalToVerificationKind(goal: Goal): VerificationKind {
  if (goal === 'cpa' || goal === 'leads') return 'cpa';
  if (goal === 'traffic' || goal === 'awareness') return 'volume';
  return 'roas';
}

function directionKpi(kind: VerificationKind, s: WindowStats): number | null {
  const spend = s.costMicros / 1_000_000;
  if (kind === 'roas') {
    return spend > 0 ? s.convValue / spend : null;
  }
  if (kind === 'cpa') {
    return s.conversions > 0 ? spend / s.conversions : null;
  }
  // volume
  return s.conversions > 0 ? s.conversions : null;
}

function directionDelta(kind: VerificationKind, prev: WindowStats, curr: WindowStats): number | null {
  const p = directionKpi(kind, prev);
  const c = directionKpi(kind, curr);
  if (p === null || c === null) return null;
  if (p === 0) return null;
  return (c - p) / p;
}

function roundConv(c: number, clicks: number): number {
  // Conversions in Ads are floats (fractional attribution) and can exceed
  // clicks (view-through, cross-device). Wilson needs integer successes
  // ≤ trials, so round half-up and cap at clicks.
  return Math.min(clicks, Math.max(0, Math.round(c)));
}

// ── Internals: Deterministic finding generator ────────────────────────

interface FindingContext {
  store: AdsDataStore;
  account: AdsAccountRow;
  customer: CustomerProfileRow | null;
  run: AdsAuditRunRow;
  previousRun: AdsAuditRunRow | null;
  kpis: AuditKpis;
  previousKpis: AuditKpis | null;
  mode: ModeDetection;
  manualChanges: ManualChangeSummary | null;
  verification: PerformanceVerificationSummary | null;
  now: Date;
  /** Per-audit memoization for `getSnapshotRows` reads. ~22
   *  detectors read the same six snapshot tables 2-3× each per
   *  audit; the cache collapses those to one read per table. */
  snapshotCache: Map<string, unknown[]>;
}

/** Memoized read of a snapshot table for the current audit run.
 *  Use this whenever a detector reads a table that may be re-read by
 *  another detector in the same audit. */
function readSnapshotCached<T>(ctx: FindingContext, table: string): T[] {
  const cached = ctx.snapshotCache.get(table);
  if (cached) return cached as T[];
  const rows = ctx.store.getSnapshotRows<T>(
    table, ctx.account.ads_account_id, { runId: ctx.run.run_id },
  );
  ctx.snapshotCache.set(table, rows as unknown[]);
  return rows;
}

function generateDeterministicFindings(ctx: FindingContext): AuditFindingDraft[] {
  const findings: AuditFindingDraft[] = [];

  // 1. Mode mismatch — only meaningful when the detected mode is MORE
  // restrictive than what data_pull recorded (i.e. data_pull was
  // optimistic but audit found insufficient data). The reverse case —
  // recorded=OPTIMIZE detected=FIRST_IMPORT — is structural noise:
  // data_pull only checks "prior run exists" while audit additionally
  // gates on last_major_import_at. Auto-correction handles it silently.
  const recordedRank = MODE_RANK[ctx.mode.recordedRunMode];
  const detectedRank = MODE_RANK[ctx.mode.detected];
  if (recordedRank !== undefined && detectedRank !== undefined && detectedRank < recordedRank) {
    findings.push({
      area: 'mode_mismatch',
      severity: 'MEDIUM',
      text: `Modus-Mismatch: Run ist als ${ctx.mode.recordedRunMode} aufgenommen, ` +
        `aber Daten-Lage zeigt ${ctx.mode.detected} (${ctx.mode.detectedReason}). ` +
        `Account-Mode wird auf ${ctx.mode.detected} korrigiert für nächsten Cycle.`,
      confidence: 0.95,
      evidence: {
        recorded_run_mode: ctx.mode.recordedRunMode,
        recorded_account_mode: ctx.mode.recordedAccountMode,
        detected: ctx.mode.detected,
        performance_days: ctx.mode.performanceDays,
      },
    });
  }

  // 2. Stale data
  if (ctx.run.gas_export_lastrun) {
    const ageDays = (ctx.now.getTime() - new Date(ctx.run.gas_export_lastrun).getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays > STALE_DATA_WARN_DAYS) {
      findings.push({
        area: 'stale_data',
        severity: ageDays > 14 ? 'HIGH' : 'MEDIUM',
        text: `GAS-Export ist ${ageDays.toFixed(1)} Tage alt. ` +
          `Re-deploy der Apps Scripts beim Customer einplanen.`,
        confidence: 1.0,
        evidence: { lastrun: ctx.run.gas_export_lastrun, age_days: round1(ageDays) },
      });
    }
  }

  // 3. No conversion tracking at all
  if (ctx.kpis.conversions === 0 && ctx.kpis.clicks > 100) {
    findings.push({
      area: 'no_conversion_tracking',
      severity: 'HIGH',
      text: `Account hat ${ctx.kpis.clicks} Clicks aber 0 Conversions im Snapshot. ` +
        `Conversion-Tracking ist vermutlich kaputt oder nicht eingerichtet — ` +
        `vor jedem Restructure dringend prüfen.`,
      confidence: 0.85,
      evidence: { clicks: ctx.kpis.clicks, conversions: 0, impressions: ctx.kpis.impressions },
    });
  }

  // 4. Disapproved products
  const disapproved = ctx.store.queryView('view_audit_disapproved_products', ctx.account.ads_account_id, { runId: ctx.run.run_id });
  if (disapproved.length > 0) {
    findings.push({
      area: 'disapproved_products',
      severity: disapproved.length > 50 ? 'HIGH' : 'MEDIUM',
      text: `${disapproved.length} Shopping-Produkte mit Disapprovals/Issues. ` +
        `Merchant Center Pflege priorisieren — Performance Max liefert sonst ` +
        `nicht das volle Inventory aus.`,
      confidence: 1.0,
      evidence: { count: disapproved.length, sample: disapproved.slice(0, 5) },
    });
  }

  // 5. Low ad-strength performers
  const lowPerf = ctx.store.queryView('view_audit_low_performers', ctx.account.ads_account_id, { runId: ctx.run.run_id });
  if (lowPerf.length > 0) {
    findings.push({
      area: 'low_ad_strength',
      severity: 'LOW',
      text: `${lowPerf.length} RSA-Ads bzw. Asset-Ratings mit POOR/AVERAGE/LOW. ` +
        `Headline-/Description-/Asset-Refresh kann Auction-Eligibility verbessern.`,
      confidence: 0.9,
      evidence: { count: lowPerf.length, sample: lowPerf.slice(0, 5) },
    });
  }

  // 6. Wasted search terms (account-aggregate)
  const wastedTerms = ctx.store.queryView('view_audit_top_search_terms', ctx.account.ads_account_id, { runId: ctx.run.run_id })
    .filter(r => r['classification'] === 'WASTE');
  if (wastedTerms.length > 0) {
    const totalSpend = wastedTerms.reduce((sum, r) => sum + numberOrZero(r['spend']), 0);
    findings.push({
      area: 'wasted_search_terms',
      severity: totalSpend > 1000 ? 'HIGH' : 'MEDIUM',
      text: `${wastedTerms.length} Suchbegriffe haben Spend ohne Conversions — ` +
        `${totalSpend.toFixed(2)} CHF verbrannt. Negative-Liste muss erweitert werden.`,
      confidence: 0.95,
      evidence: { count: wastedTerms.length, total_spend: round2(totalSpend), sample: wastedTerms.slice(0, 10) },
    });
  }

  // 6b. Per-term irrelevance candidates (Tier 1 of the hybrid harness).
  // The aggregate `wasted_search_terms` finding tells the operator HOW
  // MUCH was wasted; this finding lists the individual terms that are
  // worst-offenders so the LLM relevance classifier (Tier 2 in the
  // audit-tool layer) can label each as relevant / irrelevant /
  // uncertain against the customer profile. Irrelevant ones become
  // negative-keyword candidates; uncertain ones get a Phase-A review
  // marker. Relevant ones with spend = real customer interest with a
  // bad LP/copy/setup, NOT waste — those need a different fix.
  const irrelevantCandidates = collectIrrelevantSearchTermCandidates(ctx);
  if (irrelevantCandidates.length > 0) {
    findings.push({
      area: 'irrelevant_search_term_spend',
      severity: irrelevantCandidates[0]!.spend_chf > 100 ? 'HIGH' : 'MEDIUM',
      text: `${irrelevantCandidates.length} einzelne Suchbegriffe mit hohem Spend ohne Conversions — ` +
        `LLM-Relevance-Klassifikation läuft danach (Operator-Review für unsichere Treffer).`,
      confidence: 0.7,
      evidence: { candidates: irrelevantCandidates },
    });
  }

  // 6d. Audience-signal thin / missing on PMax asset_groups (pure Tier-1).
  // PMax asset_groups without audience_signals start cold — Smart-Bidding
  // takes weeks longer to converge and overspends during the warm-up.
  // Detector: count signals per asset_group; flag groups with 0 (or, for
  // very-thin warning tier, < 3 mixed signal types).
  const signalGaps = collectAudienceSignalGaps(ctx);
  if (signalGaps.length > 0) {
    const missingCount = signalGaps.filter(g => g.signal_count === 0).length;
    findings.push({
      area: 'audience_signal_thin',
      severity: missingCount > 0 ? 'HIGH' : 'MEDIUM',
      text: `${signalGaps.length} PMax-Asset-Group(s) ohne ausreichende Audience-Signals ` +
        `(davon ${missingCount} komplett ohne Signal). Smart-Bidding lernt deutlich langsamer; ` +
        `Operator soll vor Re-Optimierung mind. 3 Signal-Typen pro AG hinterlegen ` +
        `(Custom-Segment, Customer-List, Demographics).`,
      confidence: 0.9,
      evidence: { count: signalGaps.length, missing: missingCount, candidates: signalGaps },
    });
  }

  // 6f. Disabled keywords with historical conversions (pure Tier-1).
  // PAUSED / REMOVED keywords that previously converted are dropped revenue
  // potential — either reactivate them, or leave a documented reason. Pure
  // structural signal, no LLM judgment needed (a converted keyword is a
  // converted keyword, regardless of customer intent).
  const disabledConverting = collectDisabledConvertingKeywords(ctx);
  if (disabledConverting.length > 0) {
    const totalConv = disabledConverting.reduce((s, k) => s + k.conversions, 0);
    findings.push({
      area: 'disabled_converting_keyword',
      severity: totalConv > 5 ? 'HIGH' : 'MEDIUM',
      text: `${disabledConverting.length} pausierte / entfernte Keyword(s) haben historisch konvertiert ` +
        `(${totalConv.toFixed(1)} Conv gesamt). Reaktivieren oder Grund dokumentieren — sonst entgeht ` +
        `dem Account jede Cycle Conversion-Volumen.`,
      confidence: 0.95,
      evidence: { count: disabledConverting.length, total_conversions: round2(totalConv), candidates: disabledConverting },
    });
  }

  // 6g. Competitor-term bidding candidates (Tier-1 of the hybrid harness).
  // Pure SQL-Pre-Pass: search terms matching any tokens from
  // customer.competitors. Tier-2 LLM later judges whether the bidding is
  // intentional (some customers run competitor-conquest campaigns) or an
  // unintentional broad-match leak. Cycle 2 negative-keyword candidates
  // come from the unintentional bucket.
  const competitorCandidates = collectCompetitorTermCandidates(ctx);
  if (competitorCandidates.length > 0) {
    findings.push({
      area: 'competitor_term_bidding',
      severity: 'MEDIUM',
      text: `${competitorCandidates.length} Suchbegriff(e) treffen auf Customer-Profile-Wettbewerber ` +
        `— LLM-Intent-Klassifikation läuft danach (intentional vs. unintentional vs. uncertain).`,
      confidence: 0.7,
      evidence: { candidates: competitorCandidates },
    });
  }

  // 6h. Placeholder text in shipped assets (pure Tier-1).
  // Auto-pipelines emit "Auto-Placeholder" / "TODO" / "REPLACE_ME"
  // copy when the operator is meant to refine before publish. If
  // the operator skips the refinement and emits anyway, the live
  // ads carry the placeholder copy. Detector scans every text-bearing
  // asset table for the standard placeholder markers.
  const placeholders = collectPlaceholderAssets(ctx);
  if (placeholders.length > 0) {
    findings.push({
      area: 'placeholder_text_in_assets',
      severity: 'HIGH',
      text: `${placeholders.length} Asset(s) tragen Placeholder-Text (Auto-Placeholder / TODO / REPLACE_ME). ` +
        `Diese Assets dürfen NICHT live gehen — Operator muss sie verfeinern bevor emit_csv läuft.`,
      confidence: 1.0,
      evidence: { count: placeholders.length, candidates: placeholders },
    });
  }

  // 6i. Duplicate RSA copy across ad-groups (pure Tier-1).
  // Same headline / description used in multiple ad-groups dilutes
  // smart-bidding signal — Google can't tell which ad-group the
  // user is responding to if the copy is identical. Operator
  // typically pastes one good RSA into many AGs as a starting
  // template but forgets to specialize.
  const duplicates = collectDuplicateRsaCopy(ctx);
  if (duplicates.length > 0) {
    findings.push({
      area: 'duplicate_rsa_headlines',
      severity: 'MEDIUM',
      text: `${duplicates.length} Headline(s) / Description(s) werden in mehreren Ad-Groups identisch verwendet. ` +
        `Smart-Bidding kann nicht unterscheiden welche AG funktioniert — pro AG mind. 1-2 unique Lines empfohlen.`,
      confidence: 0.9,
      evidence: { count: duplicates.length, candidates: duplicates },
    });
  }

  // 6k. Cycle KPI anomaly (pure Tier-1).
  // Compare current run KPIs to the previous run. ROAS / conv-rate /
  // CTR drops over the configured threshold trigger the finding so
  // the strategist can lead the cycle with "stop the bleeding" vs
  // "incremental tweaks". Only fires when previousKpis exists AND
  // both runs have meaningful spend (>= 100 CHF).
  const anomalies = collectCycleKpiAnomalies(ctx);
  if (anomalies.length > 0) {
    const worst = anomalies[0]!;
    const severity: 'HIGH' | 'MEDIUM' = anomalies.some(a => a.drop_pct >= 25) ? 'HIGH' : 'MEDIUM';
    findings.push({
      area: 'cycle_kpi_anomaly',
      severity,
      text: `${anomalies.length} KPI(s) sind seit dem letzten Run signifikant gefallen — ` +
        `worst: ${worst.kpi} ${worst.previous.toFixed(2)} → ${worst.current.toFixed(2)} (${worst.drop_pct.toFixed(0)}% Abfall). ` +
        `Strategist soll vor Restructure die Ursache identifizieren (Saisonalität? Asset-Drift? Bid-Strategy-Change?).`,
      confidence: 0.9,
      evidence: { anomalies },
    });
  }

  // 6j. Brand-voice drift candidates (Tier-1 of hybrid).
  // Tier-1 collects RSA copy when customer.brand_voice has do_not_use
  // entries; Tier-2 LLM (audit-tool layer) judges actual drift against
  // tone + signature_phrases. Without a brand_voice profile this
  // detector is a no-op (graceful degradation).
  const brandVoiceCandidates = collectBrandVoiceDriftCandidates(ctx);
  if (brandVoiceCandidates.length > 0) {
    findings.push({
      area: 'brand_voice_drift',
      severity: 'MEDIUM',
      text: `${brandVoiceCandidates.length} RSA-Texte werden gegen Customer-Brand-Voice geprüft — ` +
        `LLM-Drift-Klassifikation läuft danach.`,
      confidence: 0.7,
      evidence: { candidates: brandVoiceCandidates },
    });
  }

  // 6e. PMax asset_count below Google's published minimums (pure Tier-1).
  // Editor + Google Ads UI hard-block PMax AGs below: 3 short headlines,
  // 1 long headline, 2 descriptions, 1×1 image, 1×1.91 image. The
  // existing `low_ad_strength` finding uses Google's pre-computed
  // ad_strength enum which lags asset edits by a day; this finding is
  // directly actionable ("AG-X has 1 HEADLINE, needs 3").
  const assetGaps = collectPmaxAssetCountGaps(ctx);
  if (assetGaps.length > 0) {
    findings.push({
      area: 'pmax_asset_count_below_minimum',
      severity: 'HIGH',
      text: `${assetGaps.length} PMax-Asset-Group(s) unter Google's hartem Asset-Minimum. ` +
        `Bei Re-Emit blockiert Editor diese AGs als unvollständig. ` +
        `Pro AG fehlende Asset-Typen sind in der Evidence aufgelistet.`,
      confidence: 1.0,
      evidence: { count: assetGaps.length, candidates: assetGaps },
    });
  }

  // 6c. Quality-Score collapse on high-spend keywords (pure Tier-1).
  // QS-Drop ist immer ein hartes Signal für Anzeigen-Relevanz oder
  // Landing-Page-Quality — keine LLM-Verifikation nötig. Detector
  // gruppiert nach ad_group damit der Operator nicht 50 einzelne
  // QS-3-Keywords sieht, sondern "Brand-Hamoni-AG: 8 KW unter QS 4
  // mit 120 CHF Spend".
  const qsCollapse = collectQualityScoreCollapse(ctx);
  if (qsCollapse.length > 0) {
    const totalSpend = qsCollapse.reduce((s, c) => s + c.spend_chf, 0);
    findings.push({
      area: 'quality_score_collapse',
      severity: totalSpend > 50 ? 'HIGH' : 'MEDIUM',
      text: `${qsCollapse.length} Ad-Groups mit Quality-Score < 4 auf high-spend Keywords ` +
        `(${totalSpend.toFixed(2)} CHF gesamt). Anzeigen-Relevanz oder Landing-Page-Qualität ` +
        `nachschauen — niedriger QS verteuert jeden Klick spürbar.`,
      confidence: 0.95,
      evidence: { count: qsCollapse.length, total_spend_chf: round2(totalSpend), candidates: qsCollapse },
    });
  }

  // 7. PMAX cannibalisation
  const cannibalisation = ctx.store.queryView('view_blueprint_negative_candidates', ctx.account.ads_account_id, { runId: ctx.run.run_id })
    .filter(r => r['pmax_disjunct'] === 0 && numberOrZero(r['spend']) > 0);
  if (cannibalisation.length > 0) {
    findings.push({
      area: 'pmax_search_cannibalisation',
      severity: 'HIGH',
      text: `${cannibalisation.length} Suchbegriffe laufen sowohl in Search als auch in PMAX-Search-Themes. ` +
        `Cross-Campaign-Negatives auf Search-Seite einziehen, sonst überbietet PMAX die manuell ausgesteuerten Search-Kampagnen.`,
      confidence: 0.9,
      evidence: { count: cannibalisation.length, sample: cannibalisation.slice(0, 5) },
    });
  }

  // 7b. PMAX brand-inflation: PMax bedient Brand-Queries via Search-Theme-
  // Insights. Eine dedizierte Search-Brand-Kampagne wäre fast immer billiger
  // (und isoliert Brand- vs. Non-Brand-ROAS). Detector: scan
  // pmax_search_terms.category_label for tokens that match the customer's
  // own_brands or sold_brands.
  if (ctx.customer) {
    const brandTokens = collectBrandTokens(ctx.customer);
    if (brandTokens.length > 0) {
      const pmaxRows = readSnapshotCached<{ campaign_name: string | null; search_category: string | null }>(
        ctx, 'ads_pmax_search_terms',
      );
      const branded = pmaxRows.filter(r => {
        const label = (r.search_category ?? '').toLowerCase();
        if (!label) return false;
        return brandTokens.some(t => label.includes(t));
      });
      if (branded.length > 0) {
        const totalClusters = pmaxRows.length;
        const sampleLabels = Array.from(new Set(branded.map(r => r.search_category!).filter(Boolean))).slice(0, 8);
        const sharePct = totalClusters > 0 ? Math.round((branded.length / totalClusters) * 100) : 0;
        // Data-driven sizing for the recommended brand-search campaign,
        // computed from real brand-search history (clicks + cost over last
        // 30 days) when available, otherwise from PMax cluster volume.
        const brandSearchRows = ctx.store.getSnapshotRows<BrandSearchTermRow>(
          'ads_search_terms', ctx.run.ads_account_id, { runId: ctx.run.run_id },
        );
        const defaults = brandSearchDefaults(branded.length, ctx.kpis, brandSearchRows, brandTokens);
        findings.push({
          area: 'pmax_brand_inflation',
          severity: 'HIGH',
          text: `PMax bedient ${branded.length} Brand-Search-Cluster (${sharePct}% aller PMax-Search-Themen). ` +
            `Brand-Klicks via PMax sind 60-80% teurer als via dedizierte Search-Brand-Kampagne; zudem ` +
            `inflationiert PMax-ROAS sich durch Brand-Conversions die organisch zustande gekommen wären. ` +
            `Empfehlung: Search-Brand-Kampagne aufsetzen (Match-Type Exact/Phrase auf Brand-Terms; ` +
            `Vorschlag: tägl. Budget ~${defaults.dailyBudgetChf} CHF, Target CPA ${defaults.targetCpaChf} CHF), ` +
            `Brand-Terms als Negative auf alle Non-Brand-Kampagnen, PMax-Account-Negatives für Brand-Terms ` +
            `erst nach Brand-Search-Launch.`,
          confidence: 0.9,
          evidence: {
            branded_clusters: branded.length,
            total_pmax_clusters: totalClusters,
            share_pct: sharePct,
            brand_tokens: brandTokens,
            sample_labels: sampleLabels,
            suggested_defaults: defaults,
          },
        });
      }
    }
  }

  // 7c. PMAX theme-coverage gap: cluster untargeted PMax search-term labels
  // by token, surface the dominant themes (not the raw cluster count which
  // is dominated by long-tail noise). This produces actionable seeds for
  // asset-group expansion proposals instead of a useless aggregate number.
  if (ctx.customer) {
    const pmaxRows = readSnapshotCached<{ campaign_name: string | null; search_category: string | null }>(
      ctx, 'ads_pmax_search_terms',
    );
    const brandTokens = collectBrandTokens(ctx.customer);
    const existingGroups = ctx.store.getSnapshotRows<{ asset_group_name: string | null }>(
      'ads_asset_groups', ctx.run.ads_account_id, { runId: ctx.run.run_id },
    ).map(r => (r.asset_group_name ?? '').toLowerCase()).filter(Boolean);

    const themes = clusterUntargetedThemes(pmaxRows, brandTokens, existingGroups);
    // Trigger only when there are at least 3 strong themes (each ≥ 5
    // clusters). Below that the signal is too weak to act on.
    const strongThemes = themes.filter(t => t.clusters >= 5);
    if (strongThemes.length >= 3) {
      const totalCovered = strongThemes.reduce((s, t) => s + t.clusters, 0);
      const topLine = strongThemes.slice(0, 5)
        .map(t => `${t.token} (${t.clusters} Cluster)`).join(', ');
      findings.push({
        area: 'pmax_theme_coverage_gap',
        severity: 'MEDIUM',
        text: `${strongThemes.length} dominante Themen in PMax-Search-Terms ohne passende Asset-Group: ${topLine}. ` +
          `Insgesamt ${totalCovered} Cluster auf diese Themen — Kandidaten für Asset-Group-Expansion. ` +
          `Conv-Volume-Schutz: Quell-Gruppe muss nach Split noch ≥30 conv/30d halten.`,
        confidence: 0.75,
        evidence: {
          themes: strongThemes.slice(0, 10).map(t => ({ token: t.token, clusters: t.clusters, sample: t.sample })),
          existing_asset_groups: existingGroups,
        },
      });
    }
  }

  // 7d. Device-performance bid-modifier candidates: aggregate per-device
  // metrics across the snapshot, flag devices where conv-rate is
  // significantly worse than the account mean AND spend is non-trivial.
  // Output: candidates for negative bid-modifier or exclusion. The agent
  // picks the actual modifier values; the detector just surfaces "device
  // X has ${spend} CHF spend at half the conv-rate of mobile/desktop".
  const deviceCandidates = detectDevicePerformanceOutliers(ctx.store, ctx.run);
  if (deviceCandidates.length > 0) {
    findings.push({
      area: 'device_performance_outlier',
      severity: 'MEDIUM',
      text: `${deviceCandidates.length} Geräte-Segmente liefern signifikant schwächere Conv-Rate als Account-Schnitt ` +
        `bei nicht-trivialem Spend. Bid-Modifier (-20% bis -50%) oder Exclusion prüfen.`,
      confidence: 0.8,
      evidence: { candidates: deviceCandidates },
    });
  }

  // 7e. Geo-performance bid-modifier candidates: same logic but per
  // geo_target_region. Floor on impressions/clicks so the long tail
  // doesn't drown the signal — only regions with ≥100 clicks are evaluated.
  const geoCandidates = detectGeoPerformanceOutliers(ctx.store, ctx.run);
  if (geoCandidates.length > 0) {
    findings.push({
      area: 'geo_performance_outlier',
      severity: 'MEDIUM',
      text: `${geoCandidates.length} Geo-Regionen mit auffällig schwacher Conv-Rate bei relevantem Spend. ` +
        `Negative Bid-Modifier oder Exclusion auf Kampagnen-Ebene erwägen.`,
      confidence: 0.75,
      evidence: { candidates: geoCandidates },
    });
  }

  // 8. GA4 vs Ads conversion divergence
  const ga4Delta = ctx.store.queryView('view_blueprint_ga4_conversion_delta', ctx.account.ads_account_id, { runId: ctx.run.run_id });
  for (const row of ga4Delta) {
    const ga = numberOrZero(row['ga4_conversions']);
    const ads = numberOrZero(row['ads_conversions']);
    if (ga > 10 && ads > 0) {
      const delta = Math.abs(ga - ads) / Math.max(ga, ads);
      if (delta > GA4_CONVERSION_DELTA_HIGH) {
        findings.push({
          area: 'tracking_trust_ga4_vs_ads',
          severity: 'HIGH',
          text: `GA4-Conversions (${ga.toFixed(0)}) vs Ads-Conversions (${ads.toFixed(0)}) ` +
            `weichen um ${(delta * 100).toFixed(0)}% ab (Source ${row['session_source']}/${row['session_medium']}). ` +
            `Tracking-Audit nötig: cross-domain, gtag/measurement-protocol, attribution-window.`,
          confidence: 0.85,
          evidence: { ga4: ga, ads, delta: round2(delta), source: row['session_source'], medium: row['session_medium'] },
        });
        break; // one high-severity finding is enough — agent can drill deeper
      }
    }
  }

  // 9. Manual-change drift
  if (ctx.manualChanges && ctx.manualChanges.driftAgainstEmittedEntities > 0) {
    findings.push({
      area: 'manual_change_drift',
      severity: 'MEDIUM',
      text: `${ctx.manualChanges.driftAgainstEmittedEntities} manuelle Änderungen seit letztem Run ` +
        `betreffen Entities aus unserem letzten Blueprint. Vor Restructure mit Customer abklären, ` +
        `welche Änderungen behalten werden sollen.`,
      confidence: 0.8,
      evidence: {
        drift_count: ctx.manualChanges.driftAgainstEmittedEntities,
        total_changes: ctx.manualChanges.totalChanges,
        by_operation: ctx.manualChanges.byOperation.slice(0, 5),
      },
    });
  }

  // 10. Verification: regressions
  if (ctx.verification && !ctx.verification.skipped) {
    const regressions = ctx.verification.counts.VERSCHLECHTERUNG;
    if (regressions > 0) {
      findings.push({
        area: 'performance_regression',
        severity: regressions >= 3 ? 'HIGH' : 'MEDIUM',
        text: `${regressions} Kampagne(n) zeigen statistisch signifikante Verschlechterung ` +
          `seit letztem Import. Vor weiterer Optimierung Ursachen identifizieren ` +
          `(Saisonalität? Asset-Drift? Bid-Strategy-Change?).`,
        confidence: 0.9,
        evidence: {
          regressions,
          total_verified: ctx.verification.items.length,
          kind: ctx.verification.kind,
          window_days: ctx.verification.windowDays,
        },
      });
    }
  }

  // 11. Customer profile missing — block downstream tools
  if (!ctx.customer) {
    findings.push({
      area: 'customer_profile_missing',
      severity: 'HIGH',
      text: `Kein Customer-Profile für ${ctx.account.customer_id} — ` +
        `Blueprint-Tool braucht Brands, Wettbewerber, Targets, Naming-Convention. ` +
        `Conversational-Onboarding via ads_customer_profile_set zuerst durchlaufen.`,
      confidence: 1.0,
      evidence: { customer_id: ctx.account.customer_id },
    });
  }

  // 12. Per-campaign target underperformance (uses campaign-level
  // target_roas / target_cpa_micros captured by the GAS export).
  // Skipped for campaigns without a recorded target.
  appendCampaignTargetFindings(findings, ctx);

  return findings;
}

interface CampaignTargetRow {
  campaign_id: string; campaign_name: string;
  target_roas: number | null; target_cpa_micros: number | null;
  bidding_strategy_type: string | null;
  cost_micros: number | null; conv_value: number | null; conversions: number | null;
}

function appendCampaignTargetFindings(findings: AuditFindingDraft[], ctx: FindingContext): void {
  const rows = ctx.store.getSnapshotRows<CampaignTargetRow>(
    'ads_campaigns', ctx.account.ads_account_id, { runId: ctx.run.run_id },
  );
  for (const r of rows) {
    const spendChf = (r.cost_micros ?? 0) / 1_000_000;
    if (spendChf < 5) continue; // ignore micro-spend campaigns; signal is too noisy

    if (r.target_roas !== null && r.target_roas > 0) {
      const actualRoas = spendChf > 0 ? (r.conv_value ?? 0) / spendChf : 0;
      if (actualRoas > 0) {
        const ratio = actualRoas / r.target_roas;
        if (ratio < 0.8) {
          findings.push({
            area: 'campaign_target_underperformance_roas',
            severity: ratio < 0.5 ? 'HIGH' : 'MEDIUM',
            text: `Campaign "${r.campaign_name}" liefert ROAS ${actualRoas.toFixed(2)}x ` +
              `gegen Target ${r.target_roas.toFixed(2)}x (${((ratio - 1) * 100).toFixed(0)} %). ` +
              `Spend ${spendChf.toFixed(2)} CHF — Optimierung priorisieren.`,
            confidence: 0.9,
            evidence: {
              campaign_id: r.campaign_id, campaign_name: r.campaign_name,
              actual_roas: round2(actualRoas), target_roas: r.target_roas,
              ratio: round2(ratio), spend_chf: round2(spendChf),
              bidding_strategy_type: r.bidding_strategy_type,
            },
          });
        }
      }
    }

    if (r.target_cpa_micros !== null && r.target_cpa_micros > 0 && (r.conversions ?? 0) > 0) {
      const targetCpaChf = r.target_cpa_micros / 1_000_000;
      const actualCpa = spendChf / (r.conversions ?? 1);
      const ratio = actualCpa / targetCpaChf;
      if (ratio > 1.2) {
        findings.push({
          area: 'campaign_target_underperformance_cpa',
          severity: ratio > 1.5 ? 'HIGH' : 'MEDIUM',
          text: `Campaign "${r.campaign_name}" liefert CPA CHF ${actualCpa.toFixed(2)} ` +
            `gegen Target CHF ${targetCpaChf.toFixed(2)} (+${((ratio - 1) * 100).toFixed(0)} %). ` +
            `Conv ${(r.conversions ?? 0).toFixed(1)}, Spend ${spendChf.toFixed(2)} CHF.`,
          confidence: 0.9,
          evidence: {
            campaign_id: r.campaign_id, campaign_name: r.campaign_name,
            actual_cpa: round2(actualCpa), target_cpa: round2(targetCpaChf),
            ratio: round2(ratio), spend_chf: round2(spendChf),
            conversions: r.conversions ?? 0,
            bidding_strategy_type: r.bidding_strategy_type,
          },
        });
      }
    }
  }
}

// ── Detector helpers (P1 / hybrid harness) ────────────────────────────

interface IrrelevantSearchTermCandidate {
  term: string;
  campaign_name: string;
  ad_group_name: string | null;
  spend_chf: number;
  clicks: number;
  conversions: number;
  /** Filled by the audit-tool's Tier-2 LLM classifier; absent until then. */
  classification?: 'relevant' | 'irrelevant' | 'uncertain';
  classification_reason?: string;
}

const IRRELEVANT_TERM_MIN_SPEND_CHF = 5;
const IRRELEVANT_TERM_MIN_CLICKS = 5;
const IRRELEVANT_TERM_TOP_N = 25;

/** Collect raw candidates for the Tier-2 LLM relevance classifier:
 *  search terms with spend ≥ threshold AND zero conversions AND
 *  enough clicks to rule out volume noise. Returns top-N by spend
 *  so the LLM call stays bounded — long-tail terms are addressed
 *  by the existing aggregate `wasted_search_terms` finding. */
function collectIrrelevantSearchTermCandidates(ctx: FindingContext): IrrelevantSearchTermCandidate[] {
  const rows = readSnapshotCached<{
    search_term: string | null; campaign_name: string | null; ad_group_name: string | null;
    cost_micros: number | null; clicks: number | null; conversions: number | null;
  }>(ctx, 'ads_search_terms');

  // Aggregate per (term, campaign) so a term split across days/ad-groups
  // shows as one candidate the LLM judges once.
  type Bucket = {
    term: string; campaign: string; adGroup: string | null;
    spend: number; clicks: number; conversions: number;
  };
  const agg = new Map<string, Bucket>();
  for (const r of rows) {
    const term = (r.search_term ?? '').trim();
    const campaign = (r.campaign_name ?? '').trim();
    if (term.length === 0 || campaign.length === 0) continue;
    const spend = (r.cost_micros ?? 0) / 1_000_000;
    const clicks = r.clicks ?? 0;
    const conversions = r.conversions ?? 0;
    const key = `${campaign}\x00${term.toLowerCase()}`;
    const prior = agg.get(key);
    if (prior) {
      prior.spend += spend; prior.clicks += clicks; prior.conversions += conversions;
    } else {
      agg.set(key, { term, campaign, adGroup: r.ad_group_name, spend, clicks, conversions });
    }
  }

  const out: IrrelevantSearchTermCandidate[] = [];
  for (const b of agg.values()) {
    if (b.conversions > 0) continue;
    if (b.spend < IRRELEVANT_TERM_MIN_SPEND_CHF) continue;
    if (b.clicks < IRRELEVANT_TERM_MIN_CLICKS) continue;
    out.push({
      term: b.term, campaign_name: b.campaign, ad_group_name: b.adGroup,
      spend_chf: round2(b.spend), clicks: b.clicks,
      conversions: round2(b.conversions),
    });
  }
  out.sort((a, b) => b.spend_chf - a.spend_chf);
  return out.slice(0, IRRELEVANT_TERM_TOP_N);
}

interface QualityScoreCollapseGroup {
  campaign_name: string;
  ad_group_name: string;
  keyword_count: number;
  avg_quality_score: number;
  spend_chf: number;
  /** Sample of the worst keywords for the operator's drill-in. */
  sample: ReadonlyArray<{ keyword: string; quality_score: number; spend_chf: number }>;
}

const QS_COLLAPSE_MAX_QS = 4; // QS < 4 considered collapsed
const QS_COLLAPSE_MIN_AD_GROUP_SPEND_CHF = 10;
const QS_COLLAPSE_TOP_N = 15;

/** Pure Tier-1: group keywords with QS < threshold per ad-group, only
 *  surface ad-groups whose collapsed-QS keywords have meaningful spend.
 *  No LLM needed — QS is a structural Google Ads signal that always
 *  costs money regardless of context. */
function collectQualityScoreCollapse(ctx: FindingContext): QualityScoreCollapseGroup[] {
  const rows = readSnapshotCached<{
    campaign_name: string | null; ad_group_name: string | null;
    keyword: string | null; quality_score: number | null; cost_micros: number | null;
  }>(ctx, 'ads_keywords');

  type AgBucket = {
    campaign: string; adGroup: string;
    keywords: Array<{ keyword: string; qs: number; spend: number }>;
    spend: number; qsSum: number;
  };
  const agg = new Map<string, AgBucket>();
  for (const r of rows) {
    if (r.quality_score === null || r.quality_score >= QS_COLLAPSE_MAX_QS) continue;
    const campaign = (r.campaign_name ?? '').trim();
    const adGroup = (r.ad_group_name ?? '').trim();
    const keyword = (r.keyword ?? '').trim();
    if (!campaign || !adGroup || !keyword) continue;
    const spend = (r.cost_micros ?? 0) / 1_000_000;
    const key = `${campaign}\x00${adGroup}`;
    const bucket = agg.get(key) ?? {
      campaign, adGroup, keywords: [], spend: 0, qsSum: 0,
    };
    bucket.keywords.push({ keyword, qs: r.quality_score, spend });
    bucket.spend += spend;
    bucket.qsSum += r.quality_score;
    agg.set(key, bucket);
  }

  const out: QualityScoreCollapseGroup[] = [];
  for (const b of agg.values()) {
    if (b.spend < QS_COLLAPSE_MIN_AD_GROUP_SPEND_CHF) continue;
    const avgQs = b.keywords.length > 0 ? b.qsSum / b.keywords.length : 0;
    const sample = [...b.keywords]
      .sort((x, y) => (x.qs - y.qs) || (y.spend - x.spend))
      .slice(0, 5)
      .map(k => ({ keyword: k.keyword, quality_score: k.qs, spend_chf: round2(k.spend) }));
    out.push({
      campaign_name: b.campaign, ad_group_name: b.adGroup,
      keyword_count: b.keywords.length,
      avg_quality_score: round2(avgQs),
      spend_chf: round2(b.spend),
      sample,
    });
  }
  out.sort((a, b) => b.spend_chf - a.spend_chf);
  return out.slice(0, QS_COLLAPSE_TOP_N);
}

interface AudienceSignalGap {
  campaign_name: string;
  asset_group_name: string;
  signal_count: number;
  signal_types: string[];
}

const AUDIENCE_SIGNAL_MIN_TYPES = 3;
const AUDIENCE_SIGNAL_TOP_N = 30;

/** Pure Tier-1: per asset_group count distinct audience_signal_types.
 *  Flag asset_groups with fewer than the recommended minimum (Google
 *  guidance: at least 3 mixed signal types so Smart-Bidding has
 *  multi-axis learning seed). Asset-groups with 0 signals are the
 *  highest-severity sub-bucket inside the same finding. */
function collectAudienceSignalGaps(ctx: FindingContext): AudienceSignalGap[] {
  // First pull the universe of NON-empty asset_groups for the run so
  // we can list groups with ZERO signals (left anti-join semantics).
  const groups = readSnapshotCached<{ campaign_name: string | null; asset_group_name: string | null }>(
    ctx, 'ads_asset_groups',
  ).filter(g => (g.asset_group_name ?? '').trim().length > 0)
    .map(g => ({ campaign: (g.campaign_name ?? '?').trim(), ag: (g.asset_group_name ?? '').trim() }));

  const signalsByAg = new Map<string, Set<string>>();
  const signalRows = readSnapshotCached<{ asset_group_name: string | null; signal_type: string | null }>(
    ctx, 'ads_audience_signals',
  );
  for (const r of signalRows) {
    const ag = (r.asset_group_name ?? '').trim();
    const t = (r.signal_type ?? '').trim().toUpperCase();
    if (!ag || !t) continue;
    const set = signalsByAg.get(ag) ?? new Set();
    set.add(t);
    signalsByAg.set(ag, set);
  }

  const out: AudienceSignalGap[] = [];
  for (const g of groups) {
    const types = signalsByAg.get(g.ag);
    const count = types?.size ?? 0;
    if (count >= AUDIENCE_SIGNAL_MIN_TYPES) continue;
    out.push({
      campaign_name: g.campaign,
      asset_group_name: g.ag,
      signal_count: count,
      signal_types: types ? Array.from(types).sort() : [],
    });
  }
  // Surface zero-signal groups first, then sort by AG name for stability.
  out.sort((a, b) => (a.signal_count - b.signal_count) || a.asset_group_name.localeCompare(b.asset_group_name));
  return out.slice(0, AUDIENCE_SIGNAL_TOP_N);
}

interface PmaxAssetCountGap {
  campaign_name: string;
  asset_group_name: string;
  /** Field-type → count of currently-attached assets. */
  counts: Record<string, number>;
  /** field_type → required minimum (only the ones below their minimum). */
  missing: Array<{ field_type: string; have: number; need: number }>;
}

const PMAX_ASSET_MIN_BY_TYPE: Record<string, number> = {
  HEADLINE: 3,
  LONG_HEADLINE: 1,
  DESCRIPTION: 2,
  MARKETING_IMAGE: 1,           // 1.91:1
  SQUARE_MARKETING_IMAGE: 1,    // 1:1
  // Google also wants a logo + business-name but those are account-level;
  // skipped here to avoid false positives on per-AG check.
};
const PMAX_ASSET_TOP_N = 30;

/** Pure Tier-1: per asset_group count assets by field_type. Flag groups
 *  whose attached counts fall below Google's hard minimums for any
 *  required field_type. Editor blocks these AGs from publishing. */
function collectPmaxAssetCountGaps(ctx: FindingContext): PmaxAssetCountGap[] {
  // Need to scope to PMax asset_groups; ads_asset_group_assets carries
  // the campaign_name on each row already.
  const rows = readSnapshotCached<{
    campaign_name: string | null; asset_group_name: string | null;
    field_type: string | null; asset_status: string | null;
  }>(ctx, 'ads_asset_group_assets');

  type Bucket = { campaign: string; ag: string; counts: Map<string, number> };
  const agg = new Map<string, Bucket>();
  for (const r of rows) {
    const campaign = (r.campaign_name ?? '').trim();
    const ag = (r.asset_group_name ?? '').trim();
    const ft = (r.field_type ?? '').trim().toUpperCase();
    if (!campaign || !ag || !ft) continue;
    // REMOVED / paused assets do not satisfy Google's minimums.
    const status = (r.asset_status ?? '').trim().toUpperCase();
    if (status && status !== 'ENABLED' && status !== 'ACTIVE') continue;
    const key = `${campaign}\x00${ag}`;
    const bucket = agg.get(key) ?? { campaign, ag, counts: new Map() };
    bucket.counts.set(ft, (bucket.counts.get(ft) ?? 0) + 1);
    agg.set(key, bucket);
  }

  // Also include asset_groups that have ZERO assets recorded — anti-join
  // against ads_asset_groups so brand-new (empty) AGs surface too.
  const groups = readSnapshotCached<{ campaign_name: string | null; asset_group_name: string | null }>(
    ctx, 'ads_asset_groups',
  ).filter(g => (g.asset_group_name ?? '').trim().length > 0);
  for (const g of groups) {
    const campaign = (g.campaign_name ?? '?').trim();
    const ag = (g.asset_group_name ?? '').trim();
    const key = `${campaign}\x00${ag}`;
    if (!agg.has(key)) agg.set(key, { campaign, ag, counts: new Map() });
  }

  const out: PmaxAssetCountGap[] = [];
  for (const b of agg.values()) {
    const missing: PmaxAssetCountGap['missing'] = [];
    const countsObj: Record<string, number> = {};
    for (const [ft, need] of Object.entries(PMAX_ASSET_MIN_BY_TYPE)) {
      const have = b.counts.get(ft) ?? 0;
      countsObj[ft] = have;
      if (have < need) missing.push({ field_type: ft, have, need });
    }
    if (missing.length === 0) continue;
    out.push({
      campaign_name: b.campaign,
      asset_group_name: b.ag,
      counts: countsObj,
      missing,
    });
  }
  out.sort((a, b) => (b.missing.length - a.missing.length) || a.asset_group_name.localeCompare(b.asset_group_name));
  return out.slice(0, PMAX_ASSET_TOP_N);
}

interface DisabledConvertingKeyword {
  campaign_name: string;
  ad_group_name: string;
  keyword: string;
  match_type: string | null;
  status: string;
  conversions: number;
  conv_value: number;
}

const DISABLED_CONVERTING_TOP_N = 25;

/** Pure Tier-1: keywords whose status is NOT ENABLED but who carry
 *  historical conversions. Sort by conv-value desc so the operator
 *  drills into the highest-revenue paused keywords first. Surfaces
 *  both PAUSED and REMOVED — REMOVED keywords need a different fix
 *  (re-create vs unpause) but the audit just flags them. */
function collectDisabledConvertingKeywords(ctx: FindingContext): DisabledConvertingKeyword[] {
  const rows = readSnapshotCached<{
    campaign_name: string | null; ad_group_name: string | null;
    keyword: string | null; match_type: string | null; status: string | null;
    conversions: number | null; conv_value: number | null;
  }>(ctx, 'ads_keywords');

  const out: DisabledConvertingKeyword[] = [];
  for (const r of rows) {
    const status = (r.status ?? '').trim().toUpperCase();
    if (status === '' || status === 'ENABLED' || status === 'ACTIVE') continue;
    const conversions = r.conversions ?? 0;
    if (conversions <= 0) continue;
    const campaign = (r.campaign_name ?? '').trim();
    const adGroup = (r.ad_group_name ?? '').trim();
    const keyword = (r.keyword ?? '').trim();
    if (!campaign || !adGroup || !keyword) continue;
    out.push({
      campaign_name: campaign, ad_group_name: adGroup,
      keyword, match_type: r.match_type, status,
      conversions: round2(conversions),
      conv_value: round2(r.conv_value ?? 0),
    });
  }
  out.sort((a, b) => (b.conv_value - a.conv_value) || (b.conversions - a.conversions));
  return out.slice(0, DISABLED_CONVERTING_TOP_N);
}

interface CompetitorTermCandidate {
  term: string;
  campaign_name: string;
  ad_group_name: string | null;
  matched_competitor: string;
  spend_chf: number;
  clicks: number;
  conversions: number;
  /** Filled by Tier-2 LLM classifier; absent until then. */
  classification?: 'intentional_competitive' | 'unintentional_leak' | 'uncertain';
  classification_reason?: string;
}

const COMPETITOR_TERM_MIN_CLICKS = 3;
const COMPETITOR_TERM_TOP_N = 25;

/** Pure Tier-1: scan ads_search_terms for any term whose lowercased
 *  form contains a token from customer.competitors. Returns top-N by
 *  spend, deduplicated per (term, campaign), so the LLM call stays
 *  bounded. Skips low-traffic terms (< MIN_CLICKS) to filter long-tail
 *  noise — the operator only cares about competitor terms with real
 *  budget impact. */
function collectCompetitorTermCandidates(ctx: FindingContext): CompetitorTermCandidate[] {
  if (!ctx.customer) return [];
  const competitors = parseBrandJsonArray(ctx.customer.competitors)
    .map(c => c.trim().toLowerCase())
    .filter(c => c.length >= 3);
  if (competitors.length === 0) return [];

  const rows = readSnapshotCached<{
    search_term: string | null; campaign_name: string | null; ad_group_name: string | null;
    cost_micros: number | null; clicks: number | null; conversions: number | null;
  }>(ctx, 'ads_search_terms');

  type Bucket = {
    term: string; campaign: string; adGroup: string | null; competitor: string;
    spend: number; clicks: number; conversions: number;
  };
  const agg = new Map<string, Bucket>();
  for (const r of rows) {
    const term = (r.search_term ?? '').trim();
    const campaign = (r.campaign_name ?? '').trim();
    if (term.length === 0 || campaign.length === 0) continue;
    const lower = term.toLowerCase();
    const matched = competitors.find(c => lower.includes(c));
    if (!matched) continue;
    const spend = (r.cost_micros ?? 0) / 1_000_000;
    const clicks = r.clicks ?? 0;
    const conversions = r.conversions ?? 0;
    const key = `${campaign}\x00${term.toLowerCase()}`;
    const prior = agg.get(key);
    if (prior) {
      prior.spend += spend; prior.clicks += clicks; prior.conversions += conversions;
    } else {
      agg.set(key, {
        term, campaign, adGroup: r.ad_group_name, competitor: matched,
        spend, clicks, conversions,
      });
    }
  }

  const out: CompetitorTermCandidate[] = [];
  for (const b of agg.values()) {
    if (b.clicks < COMPETITOR_TERM_MIN_CLICKS) continue;
    out.push({
      term: b.term, campaign_name: b.campaign, ad_group_name: b.adGroup,
      matched_competitor: b.competitor,
      spend_chf: round2(b.spend),
      clicks: b.clicks,
      conversions: round2(b.conversions),
    });
  }
  out.sort((a, b) => b.spend_chf - a.spend_chf);
  return out.slice(0, COMPETITOR_TERM_TOP_N);
}

interface CycleKpiAnomaly {
  kpi: 'roas' | 'conversion_rate' | 'ctr';
  previous: number;
  current: number;
  drop_pct: number;
}

const CYCLE_ANOMALY_MIN_DROP_PCT = 15;
const CYCLE_ANOMALY_MIN_SPEND_CHF = 100;

/** Pure Tier-1: compare current run KPIs vs previous run KPIs.
 *  Flag drops above the threshold when both runs have meaningful
 *  spend so single-day blips don't trigger false positives. */
function collectCycleKpiAnomalies(ctx: FindingContext): CycleKpiAnomaly[] {
  if (!ctx.previousKpis) return [];
  const cur = ctx.kpis;
  const prev = ctx.previousKpis;
  if (cur.spend < CYCLE_ANOMALY_MIN_SPEND_CHF || prev.spend < CYCLE_ANOMALY_MIN_SPEND_CHF) return [];

  const out: CycleKpiAnomaly[] = [];
  const compare = (kpi: CycleKpiAnomaly['kpi'], curVal: number | null, prevVal: number | null): void => {
    if (curVal === null || prevVal === null || prevVal <= 0) return;
    const dropPct = ((prevVal - curVal) / prevVal) * 100;
    if (dropPct >= CYCLE_ANOMALY_MIN_DROP_PCT) {
      out.push({ kpi, previous: prevVal, current: curVal, drop_pct: round1(dropPct) });
    }
  };

  compare('roas', cur.roas, prev.roas);
  // Conversion rate isn't directly in AuditKpis — derive from
  // conversions / clicks for both runs.
  const curConvRate = cur.clicks > 0 ? cur.conversions / cur.clicks : null;
  const prevConvRate = prev.clicks > 0 ? prev.conversions / prev.clicks : null;
  compare('conversion_rate', curConvRate, prevConvRate);
  compare('ctr', cur.ctr, prev.ctr);

  out.sort((a, b) => b.drop_pct - a.drop_pct);
  return out;
}

interface PlaceholderAssetCandidate {
  table: string;
  campaign_name: string | null;
  ad_group_or_asset_group_name: string | null;
  field_type: string | null;
  text: string;
  match: string;
}

const PLACEHOLDER_PATTERNS: ReadonlyArray<RegExp> = [
  /auto[\s-]?placeholder/i,
  /\bplaceholder\b/i,
  /\bTODO\b/,
  /REPLACE[_\s-]?ME/i,
  /\bTBD\b/,
  /\bTBC\b/,
  /\bXXX\b/,
  /lorem ipsum/i,
];
const PLACEHOLDER_TOP_N = 50;

function findPlaceholderMatch(text: string): string | null {
  for (const re of PLACEHOLDER_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** Pure Tier-1: scan ads_rsa_ads + ads_asset_group_assets for
 *  text matching standard placeholder markers. Surfaces ads that
 *  must NOT go live before the operator refines them. */
function collectPlaceholderAssets(ctx: FindingContext): PlaceholderAssetCandidate[] {
  const out: PlaceholderAssetCandidate[] = [];

  const rsas = readSnapshotCached<{
    campaign_name: string; ad_group_name: string; headlines: string; descriptions: string;
  }>(ctx, 'ads_rsa_ads');
  for (const r of rsas) {
    for (const [field, json] of [['HEADLINE', r.headlines], ['DESCRIPTION', r.descriptions]] as const) {
      try {
        const arr = JSON.parse(json);
        if (!Array.isArray(arr)) continue;
        for (const t of arr) {
          if (typeof t !== 'string') continue;
          const m = findPlaceholderMatch(t);
          if (m) {
            out.push({
              table: 'ads_rsa_ads',
              campaign_name: r.campaign_name,
              ad_group_or_asset_group_name: r.ad_group_name,
              field_type: field, text: t, match: m,
            });
          }
        }
      } catch { /* ignore malformed */ }
    }
  }

  const aga = readSnapshotCached<{
    campaign_name: string | null; asset_group_name: string;
    field_type: string; text_content: string | null;
  }>(ctx, 'ads_asset_group_assets');
  for (const r of aga) {
    if (!r.text_content) continue;
    const m = findPlaceholderMatch(r.text_content);
    if (m) {
      out.push({
        table: 'ads_asset_group_assets',
        campaign_name: r.campaign_name,
        ad_group_or_asset_group_name: r.asset_group_name,
        field_type: r.field_type, text: r.text_content, match: m,
      });
    }
  }

  return out.slice(0, PLACEHOLDER_TOP_N);
}

interface DuplicateRsaCandidate {
  text: string;
  field_type: 'HEADLINE' | 'DESCRIPTION';
  occurrences: ReadonlyArray<{ campaign_name: string; ad_group_name: string }>;
}

const DUPLICATE_RSA_TOP_N = 20;
const DUPLICATE_RSA_MIN_OCCURRENCES = 2;

/** Pure Tier-1: find RSA headlines / descriptions used identically
 *  across multiple ad-groups. Account-wide dedupe. */
function collectDuplicateRsaCopy(ctx: FindingContext): DuplicateRsaCandidate[] {
  const rsas = readSnapshotCached<{
    campaign_name: string; ad_group_name: string;
    headlines: string; descriptions: string;
  }>(ctx, 'ads_rsa_ads');

  const headlineMap = new Map<string, Set<string>>();
  const descriptionMap = new Map<string, Set<string>>();

  for (const r of rsas) {
    if (!r.campaign_name || !r.ad_group_name) continue;
    const key = `${r.campaign_name}\x00${r.ad_group_name}`;
    pushUnique(headlineMap, r.headlines, key);
    pushUnique(descriptionMap, r.descriptions, key);
  }

  const out: DuplicateRsaCandidate[] = [];
  for (const [text, keys] of headlineMap) {
    if (keys.size < DUPLICATE_RSA_MIN_OCCURRENCES) continue;
    out.push({
      text, field_type: 'HEADLINE',
      occurrences: Array.from(keys).map(k => {
        const [c, ag] = k.split('\x00');
        return { campaign_name: c ?? '?', ad_group_name: ag ?? '?' };
      }),
    });
  }
  for (const [text, keys] of descriptionMap) {
    if (keys.size < DUPLICATE_RSA_MIN_OCCURRENCES) continue;
    out.push({
      text, field_type: 'DESCRIPTION',
      occurrences: Array.from(keys).map(k => {
        const [c, ag] = k.split('\x00');
        return { campaign_name: c ?? '?', ad_group_name: ag ?? '?' };
      }),
    });
  }
  out.sort((a, b) => b.occurrences.length - a.occurrences.length);
  return out.slice(0, DUPLICATE_RSA_TOP_N);
}

function pushUnique(map: Map<string, Set<string>>, json: string, agKey: string): void {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return;
    for (const t of arr) {
      if (typeof t !== 'string') continue;
      const trimmed = t.trim();
      if (trimmed.length === 0) continue;
      const set = map.get(trimmed) ?? new Set();
      set.add(agKey);
      map.set(trimmed, set);
    }
  } catch { /* ignore */ }
}

interface BrandVoiceDriftCandidate {
  campaign_name: string;
  ad_group_name: string;
  field_type: 'HEADLINE' | 'DESCRIPTION';
  text: string;
  classification?: 'on_brand' | 'drift' | 'uncertain';
  classification_reason?: string;
}

const BRAND_VOICE_DRIFT_TOP_N = 30;

/** Pure Tier-1: collect a sample of RSA copy ONLY when
 *  customer.brand_voice has do_not_use / signature_phrases / tone
 *  configured. Without that depth, the LLM has nothing to measure
 *  drift against — graceful no-op. */
function collectBrandVoiceDriftCandidates(ctx: FindingContext): BrandVoiceDriftCandidate[] {
  if (!ctx.customer) return [];
  let bv: { tone?: string; do_not_use?: string[]; signature_phrases?: string[] } = {};
  try {
    const parsed = JSON.parse(ctx.customer.brand_voice_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      bv = parsed as typeof bv;
    }
  } catch { /* fall through */ }
  const hasContent = Boolean(bv.tone)
    || (bv.do_not_use && bv.do_not_use.length > 0)
    || (bv.signature_phrases && bv.signature_phrases.length > 0);
  if (!hasContent) return [];

  const rsas = readSnapshotCached<{
    campaign_name: string; ad_group_name: string;
    headlines: string; descriptions: string;
  }>(ctx, 'ads_rsa_ads');

  const out: BrandVoiceDriftCandidate[] = [];
  for (const r of rsas) {
    if (!r.campaign_name || !r.ad_group_name) continue;
    for (const [field, json] of [['HEADLINE', r.headlines], ['DESCRIPTION', r.descriptions]] as const) {
      try {
        const arr = JSON.parse(json);
        if (!Array.isArray(arr)) continue;
        for (const t of arr) {
          if (typeof t !== 'string' || t.length < 3) continue;
          out.push({
            campaign_name: r.campaign_name,
            ad_group_name: r.ad_group_name,
            field_type: field, text: t,
          });
          if (out.length >= BRAND_VOICE_DRIFT_TOP_N) return out;
        }
      } catch { /* ignore */ }
    }
  }
  return out;
}

// ── Number helpers ────────────────────────────────────────────────────

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function nonNullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
