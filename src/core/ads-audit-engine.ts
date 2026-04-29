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
    kpis, mode, manualChanges, verification,
    now: opts?.now ?? new Date(),
  });

  return {
    account, customer, run, previousRun, kpis, mode,
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
  mode: ModeDetection;
  manualChanges: ManualChangeSummary | null;
  verification: PerformanceVerificationSummary | null;
  now: Date;
}

function generateDeterministicFindings(ctx: FindingContext): AuditFindingDraft[] {
  const findings: AuditFindingDraft[] = [];

  // 1. Mode mismatch
  if (ctx.mode.detected !== ctx.mode.recordedRunMode) {
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

  // 6. Wasted search terms
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
      const pmaxRows = ctx.store.getSnapshotRows<{ campaign_name: string | null; search_category: string | null }>(
        'ads_pmax_search_terms', ctx.run.ads_account_id, { runId: ctx.run.run_id },
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
        findings.push({
          area: 'pmax_brand_inflation',
          severity: 'HIGH',
          text: `PMax bedient ${branded.length} Brand-Search-Cluster (${sharePct}% aller PMax-Search-Themen). ` +
            `Brand-Klicks via PMax sind 60-80% teurer als via dedizierte Search-Brand-Kampagne; zudem ` +
            `inflationiert PMax-ROAS sich durch Brand-Conversions die organisch zustande gekommen wären. ` +
            `Empfehlung: Search-Brand-Kampagne aufsetzen (Match-Type Exact/Phrase auf Brand-Terms), ` +
            `Brand-Terms als Negative auf alle Non-Brand-Search-Kampagnen, PMax-Account-Negatives für Brand-Terms erst nach Brand-Search-Launch.`,
          confidence: 0.9,
          evidence: {
            branded_clusters: branded.length,
            total_pmax_clusters: totalClusters,
            share_pct: sharePct,
            brand_tokens: brandTokens,
            sample_labels: sampleLabels,
          },
        });
      }
    }
  }

  // 7c. PMAX theme-coverage gap: untargeted thematic clusters in PMax
  // search-terms that don't match an existing asset_group_name. Surfaces
  // where new asset-groups would expand coverage without diluting the
  // existing groups' learning. Uses the same pmax_search_terms snapshot.
  if (ctx.customer) {
    const pmaxRows = ctx.store.getSnapshotRows<{ campaign_name: string | null; search_category: string | null }>(
      'ads_pmax_search_terms', ctx.run.ads_account_id, { runId: ctx.run.run_id },
    );
    const brandTokens = collectBrandTokens(ctx.customer);
    const existingGroups = ctx.store.getSnapshotRows<{ asset_group_name: string | null }>(
      'ads_asset_groups', ctx.run.ads_account_id, { runId: ctx.run.run_id },
    ).map(r => (r.asset_group_name ?? '').toLowerCase()).filter(Boolean);

    const themeCount = new Map<string, number>();
    for (const r of pmaxRows) {
      const label = (r.search_category ?? '').toLowerCase().trim();
      if (!label) continue;
      if (brandTokens.some(t => label.includes(t))) continue;          // skip branded — handled in 7b
      if (existingGroups.some(g => label.includes(g))) continue;        // skip already-covered
      themeCount.set(label, (themeCount.get(label) ?? 0) + 1);
    }
    if (themeCount.size >= 5) {
      const topThemes = Array.from(themeCount.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([t]) => t);
      findings.push({
        area: 'pmax_theme_coverage_gap',
        severity: 'MEDIUM',
        text: `${themeCount.size} thematische Cluster in PMax-Search-Terms decken sich nicht mit bestehenden Asset-Group-Namen. ` +
          `Asset-Group-Expansion könnte hier Lerndaten neuer Gruppen aufbauen — Conv-Volume der bestehenden Gruppen ` +
          `prüfen, neue Gruppen nur splitten wenn Quell-Gruppe danach noch ≥30 conv/30d hält.`,
        confidence: 0.7,
        evidence: {
          untargeted_cluster_count: themeCount.size,
          existing_asset_groups: existingGroups,
          sample_themes: topThemes,
        },
      });
    }
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

// ── Number helpers ────────────────────────────────────────────────────

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function nonNullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
