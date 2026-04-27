/**
 * Tool: ads_audit_run
 *
 * Runs the deterministic audit phase of the Ads Optimizer pipeline against
 * the latest successful snapshot for an ads account. Computes account KPIs,
 * detects mode (BOOTSTRAP vs OPTIMIZE), summarises manual changes since the
 * previous run, runs Wilson-score performance verification on the previous
 * run's emitted entities, and persists deterministic findings to ads_findings
 * (mirrored to KG when a KnowledgeLayer is wired into the tool context).
 *
 * Returns a Markdown report intended for thread rendering.
 *
 * QUALITATIVE FINDINGS DISCOVERED VIA DataForSEO/LP-CRAWL/TRACKING-AUDIT
 * are NOT generated here. The agent calls ads_finding_add after qualitative
 * research to record those.
 *
 * Gated by feature flag 'ads-optimizer'.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import type {
  AdsDataStore,
  CustomerProfileRow,
  AdsFindingSeverity,
} from '../../core/ads-data-store.js';
import {
  runAudit,
  AuditPreconditionError,
  type AuditResult,
  type AuditFindingDraft,
  type ManualChangeSummary,
  type ModeDetection,
  type PerformanceVerificationSummary,
  type AuditKpis,
} from '../../core/ads-audit-engine.js';
import { getErrorMessage } from '../../core/utils.js';

interface AdsAuditRunInput {
  ads_account_id: string;
  /** Override the verification window in days (default 28, min 7, max 90). */
  verify_window_days?: number | undefined;
}

const DESCRIPTION = [
  'Run the deterministic audit phase against the latest successful Ads Optimizer snapshot.',
  '',
  'Workflow position — call AFTER `ads_data_pull` has succeeded for the account.',
  'The tool produces a structured Markdown audit report and persists deterministic',
  'findings into ads_findings + KG. After reading the report you should:',
  '  1. Run DataForSEO keyword-research via http_request (DataForSEO API profile)',
  '     for the customer\'s top product/service themes.',
  '  2. Crawl the top 5 landing pages (sorted by paid_spend) via http_request and',
  '     read their content for relevance + tracking instrumentation.',
  '  3. Inspect the GA4 conversion-delta finding if present and probe the GA4-Ads',
  '     link in the customer\'s account.',
  '  4. Record any qualitative finding from steps 1-3 via `ads_finding_add` so it',
  '     joins the deterministic findings as input for `ads_blueprint`.',
  '',
  'For Cycle 2+ (when `previous_run_id` is set), a Wilson-score performance',
  'verification compares the previously emitted entities pre/post import. Use',
  'the verification table to argue whether last run\'s decisions paid off before',
  'making new restructure recommendations.',
].join('\n');

export function createAdsAuditRunTool(store: AdsDataStore): ToolEntry<AdsAuditRunInput> {
  return {
    definition: {
      name: 'ads_audit_run',
      description: DESCRIPTION,
      input_schema: {
        type: 'object' as const,
        properties: {
          ads_account_id: {
            type: 'string',
            description: 'Google Ads Customer ID (e.g. "123-456-7890") to audit.',
          },
          verify_window_days: {
            type: 'integer',
            description: 'Override the post/pre-import verification window length. Default 28, min 7, max 90.',
          },
        },
        required: ['ads_account_id'],
      },
    },
    handler: async (input: AdsAuditRunInput, agent: IAgent): Promise<string> => {
      try {
        const result = runAudit(store, input.ads_account_id, {
          ...(input.verify_window_days !== undefined ? { verifyWindowDays: input.verify_window_days } : {}),
        });
        const persistedIds = persistFindings(store, result);

        // Mirror to KG (best-effort, async). Failure must not break the audit.
        const kg = agent.toolContext.knowledgeLayer;
        if (kg) {
          await mirrorFindingsToKg(store, kg, result, persistedIds);
        }

        // Update account.mode if detection disagrees.
        if (result.mode.detected !== result.mode.recordedAccountMode) {
          updateAccountMode(store, result.account.ads_account_id, result.mode.detected);
        }

        return renderMarkdownReport(result, persistedIds.length);
      } catch (err) {
        if (err instanceof AuditPreconditionError) {
          return `ads_audit_run failed: ${err.message}`;
        }
        return `ads_audit_run failed: ${getErrorMessage(err)}`;
      }
    },
  };
}

// ── Persistence ───────────────────────────────────────────────────────

function persistFindings(store: AdsDataStore, result: AuditResult): number[] {
  const ids: number[] = [];
  for (const f of result.findings) {
    const row = store.insertFinding({
      runId: result.run.run_id,
      adsAccountId: result.account.ads_account_id,
      area: f.area,
      severity: f.severity,
      source: 'deterministic',
      text: f.text,
      confidence: f.confidence,
      evidence: f.evidence,
    });
    ids.push(row.finding_id);
  }
  return ids;
}

interface KnowledgeLayerLite {
  store(
    text: string,
    namespace: 'knowledge' | 'methods' | 'status' | 'learnings',
    scope: { type: 'global' | 'context' | 'user'; id: string },
    options?: { sourceRunId?: string | undefined; skipContradictionCheck?: boolean | undefined } | undefined,
  ): Promise<{ memoryId: string; stored: boolean; deduplicated: boolean }>;
}

async function mirrorFindingsToKg(
  store: AdsDataStore,
  kg: KnowledgeLayerLite,
  result: AuditResult,
  findingIds: readonly number[],
): Promise<void> {
  const accountId = result.account.ads_account_id;
  const runId = result.run.run_id;
  for (let i = 0; i < result.findings.length; i++) {
    const f = result.findings[i]!;
    const findingId = findingIds[i]!;
    const text = `[ads-audit ${runId} • ${f.severity} • ${f.area}] ${f.text}`;
    try {
      const stored = await kg.store(
        text,
        'knowledge',
        { type: 'context', id: accountId },
        { sourceRunId: String(runId), skipContradictionCheck: true },
      );
      if (stored.memoryId) {
        store.setFindingKgMemoryId(findingId, stored.memoryId);
      }
    } catch {
      // KG mirroring is best-effort; never block the audit on a KG failure.
    }
  }
}

function updateAccountMode(store: AdsDataStore, adsAccountId: string, mode: 'BOOTSTRAP' | 'OPTIMIZE'): void {
  // The store's upsertAdsAccount is idempotent and re-writes all columns;
  // we only want to nudge `mode` so we go through it with the existing row.
  const row = store.getAdsAccount(adsAccountId);
  if (!row) return;
  store.upsertAdsAccount({
    adsAccountId: row.ads_account_id,
    customerId: row.customer_id,
    accountLabel: row.account_label,
    mode,
    ...(row.currency_code !== null ? { currencyCode: row.currency_code } : {}),
    ...(row.timezone !== null ? { timezone: row.timezone } : {}),
    ...(row.drive_folder_id !== null ? { driveFolderId: row.drive_folder_id } : {}),
  });
}

// ── Markdown rendering ────────────────────────────────────────────────

export function renderMarkdownReport(result: AuditResult, persistedFindingCount: number): string {
  const lines: string[] = [];
  const { account, customer, run, previousRun, kpis, mode, manualChanges, verification, findings } = result;

  lines.push(`# Audit Report — ${customer?.client_name ?? account.customer_id} (${account.ads_account_id})`);
  lines.push('');
  lines.push(`**Run:** #${run.run_id} (${run.mode}) · ${run.started_at} → ${run.finished_at ?? '?'}`);
  if (previousRun) {
    lines.push(`**Vorgänger:** #${previousRun.run_id} (${previousRun.mode}) · finished ${previousRun.finished_at ?? '?'}`);
  } else {
    lines.push(`**Vorgänger:** keiner — Erstrun.`);
  }
  if (run.gas_export_lastrun) lines.push(`**GAS-Export-LASTRUN:** ${run.gas_export_lastrun}`);
  lines.push('');

  appendKpis(lines, kpis);
  appendMode(lines, mode);
  appendManualChanges(lines, manualChanges);
  appendVerification(lines, verification, customer);
  appendFindings(lines, findings, persistedFindingCount);
  appendNextSteps(lines, mode, customer, findings);

  return lines.join('\n');
}

function appendKpis(lines: string[], kpis: AuditKpis): void {
  lines.push('## KPIs');
  lines.push('');
  lines.push(`- Spend: **${fmtCurrency(kpis.spend)} CHF**`);
  lines.push(`- Conversions: **${fmtNumber(kpis.conversions, 1)}**`);
  lines.push(`- Conv. Value: **${fmtCurrency(kpis.convValue)} CHF**`);
  lines.push(`- ROAS: **${kpis.roas !== null ? kpis.roas.toFixed(2) + 'x' : '–'}**`);
  lines.push(`- CPA: **${kpis.cpa !== null ? fmtCurrency(kpis.cpa) + ' CHF' : '–'}**`);
  lines.push(`- CTR: **${kpis.ctr !== null ? (kpis.ctr * 100).toFixed(2) + '%' : '–'}**`);
  lines.push(`- Clicks / Impr.: ${fmtNumber(kpis.clicks, 0)} / ${fmtNumber(kpis.impressions, 0)}`);
  lines.push('');
}

function appendMode(lines: string[], mode: ModeDetection): void {
  lines.push('## Mode Detection');
  lines.push('');
  lines.push(`- Detected: **${mode.detected}** (${mode.detectedReason})`);
  lines.push(`- Run aufgezeichnet als: ${mode.recordedRunMode}`);
  lines.push(`- Account-Default vor Audit: ${mode.recordedAccountMode}`);
  lines.push(`- Performance-Tage in Snapshot: ${mode.performanceDays}`);
  if (mode.detected !== mode.recordedAccountMode) {
    lines.push(`- ⚠️ Account-Default wird auf **${mode.detected}** korrigiert für nächsten Cycle.`);
  }
  lines.push('');
}

function appendManualChanges(lines: string[], mc: ManualChangeSummary | null): void {
  if (mc === null) return; // first cycle — skip
  lines.push('## Manuelle Änderungen seit letztem Run');
  lines.push('');
  if (mc.totalChanges === 0) {
    lines.push('Keine. Customer hat zwischen Runs nicht manuell ins Konto eingegriffen.');
    lines.push('');
    return;
  }
  lines.push(`Gesamt: **${mc.totalChanges} Änderungen** (${mc.firstChange} → ${mc.lastChange})`);
  if (mc.driftAgainstEmittedEntities > 0) {
    lines.push(`⚠️ **${mc.driftAgainstEmittedEntities} davon betreffen Entities aus unserem Vorgänger-Blueprint.**`);
  }
  lines.push('');
  if (mc.byOperation.length > 0) {
    lines.push('Top-Operationen:');
    for (const op of mc.byOperation.slice(0, 5)) {
      lines.push(`- ${op.operation}: ${op.count}`);
    }
  }
  if (mc.byResourceType.length > 0) {
    lines.push('');
    lines.push('Nach Resource-Typ:');
    for (const r of mc.byResourceType.slice(0, 5)) {
      lines.push(`- ${r.resourceType}: ${r.count}`);
    }
  }
  lines.push('');
}

function appendVerification(
  lines: string[], v: PerformanceVerificationSummary | null, customer: CustomerProfileRow | null,
): void {
  if (v === null) return; // first cycle
  lines.push('## Performance-Verification');
  lines.push('');
  if (v.skipped) {
    lines.push(`Übersprungen: ${v.skippedReason ?? 'kein Window berechenbar'}.`);
    lines.push('');
    return;
  }
  const goal = customer?.primary_goal ?? 'unknown';
  lines.push(`Goal-KPI: \`${goal}\` → Vergleichsmetrik **${v.kind.toUpperCase()}**`);
  lines.push(`Window: ${v.windowDays} Tage post-import vs ${v.windowDays} Tage pre-import (Pivot ${v.cutoff ?? '–'})`);
  lines.push('');
  lines.push(`Klassifikation (Wilson 95%-CI auf Conv-Rate):`);
  lines.push(`- ERFOLG: ${v.counts.ERFOLG}`);
  lines.push(`- VERSCHLECHTERUNG: ${v.counts.VERSCHLECHTERUNG}`);
  lines.push(`- NEUTRAL: ${v.counts.NEUTRAL}`);
  lines.push(`- NICHT_VERGLEICHBAR: ${v.counts.NICHT_VERGLEICHBAR}`);
  lines.push('');
  if (v.items.length > 0) {
    lines.push('| Entity | Klasse | Prev-CR | Curr-CR | Δ-Goal |');
    lines.push('|---|---|---|---|---|');
    for (const item of v.items.slice(0, 30)) {
      const prevCR = formatCR(item.prevWindow);
      const currCR = formatCR(item.currWindow);
      const goalDelta = item.goalDelta !== null ? `${(item.goalDelta * 100).toFixed(1)}%` : '–';
      lines.push(`| \`${item.entityExternalId}\` | ${item.classification} | ${prevCR} | ${currCR} | ${goalDelta} |`);
    }
    if (v.items.length > 30) {
      lines.push(`| _… ${v.items.length - 30} weitere Entities ausgelassen_ |  |  |  |  |`);
    }
  }
  lines.push('');
}

function formatCR(w: { successes: number; trials: number; lower: number; upper: number }): string {
  if (w.trials === 0) return '0/0';
  return `${(w.lower * 100).toFixed(1)}–${(w.upper * 100).toFixed(1)}% (${w.successes}/${w.trials})`;
}

function appendFindings(lines: string[], findings: AuditFindingDraft[], persistedCount: number): void {
  lines.push(`## Findings (${findings.length} deterministisch, ${persistedCount} persistiert)`);
  lines.push('');
  if (findings.length === 0) {
    lines.push('Keine deterministischen Probleme erkannt. Das ist verdächtig — qualitative Prüfung via DataForSEO/LP-Crawl trotzdem durchführen.');
    lines.push('');
    return;
  }
  for (const severity of ['HIGH', 'MEDIUM', 'LOW'] as AdsFindingSeverity[]) {
    const subset = findings.filter(f => f.severity === severity);
    if (subset.length === 0) continue;
    lines.push(`### ${severity} (${subset.length})`);
    lines.push('');
    for (const f of subset) {
      lines.push(`- **${f.area}** (Konfidenz ${f.confidence.toFixed(2)})`);
      lines.push(`  ${f.text}`);
    }
    lines.push('');
  }
}

function appendNextSteps(
  lines: string[], mode: ModeDetection, customer: CustomerProfileRow | null,
  findings: AuditFindingDraft[],
): void {
  lines.push('## Nächste Schritte');
  lines.push('');
  if (!customer) {
    lines.push('1. **Erst** Customer-Profile via `ads_customer_profile_set` aufnehmen — Blueprint-Tool blockiert ohne.');
    return;
  }
  const hasTrackingFinding = findings.some(f => f.area === 'tracking_trust_ga4_vs_ads');
  lines.push('1. DataForSEO-Keyword-Research für Top-Themes des Customers (Brands, Top-Produkte aus Profile) — `http_request` mit DataForSEO-API-Profil.');
  lines.push('2. LP-Crawl der Top-5-Landing-Pages nach Spend (View `view_blueprint_landing_page_perf` lesen).');
  lines.push(hasTrackingFinding
    ? '3. Tracking-Audit: Probe der GA4-Ads-Verknüpfung gemäß `tracking_trust_ga4_vs_ads`-Finding.'
    : '3. Tracking-Audit der GA4-Ads-Verknüpfung — auch wenn keine Conversion-Discrepancy: Conversion-Aktion-Setup via `view_audit_change_history_summary` nachvollziehen.');
  lines.push('4. Qualitative Findings via `ads_finding_add` zurückschreiben.');
  lines.push(mode.detected === 'BOOTSTRAP'
    ? '5. Bei BOOTSTRAP-Mode: `ads_blueprint` produziert nur additive Empfehlungen (Negatives, Sitelinks, Callouts) — kein Restructure.'
    : '5. `ads_blueprint` aufrufen, sobald qualitative Findings vorliegen — er liest Audit + Findings über `run_id`.');
}

// ── Number formatting ─────────────────────────────────────────────────

function fmtCurrency(v: number): string {
  return v.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNumber(v: number, digits: number): string {
  return v.toLocaleString('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
