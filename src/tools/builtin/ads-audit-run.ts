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
  type AuditMode,
} from '../../core/ads-audit-engine.js';
import {
  classifyThemeTokens,
  type ClassifyOptions, type ClassifiedToken, type ThemeCategory,
} from '../../core/ads-theme-classifier.js';
import {
  classifySearchTermRelevance,
  type ClassifySearchTermOptions, type ClassifiedSearchTerm, type RelevanceCategory,
} from '../../core/ads-search-term-relevance-classifier.js';
import {
  classifyCompetitorTermIntent,
  type ClassifyCompetitorOptions, type ClassifiedCompetitorTerm, type CompetitorIntentCategory,
} from '../../core/ads-competitor-term-classifier.js';
import { getErrorMessage } from '../../core/utils.js';

interface AdsAuditRunInput {
  /** Either ads_account_id or customer_id (the tool resolves the other from the
   *  ads_accounts row when only one is given). */
  ads_account_id?: string | undefined;
  customer_id?: string | undefined;
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
            description: 'Google Ads Customer ID (e.g. "123-456-7890") to audit. Optional if customer_id has exactly one linked ads account.',
          },
          customer_id: {
            type: 'string',
            description: 'Customer slug (e.g. "aquanatura"). Used to auto-resolve ads_account_id when only one is linked. Optional when ads_account_id is given.',
          },
          verify_window_days: {
            type: 'integer',
            description: 'Override the post/pre-import verification window length. Default 28, min 7, max 90.',
          },
        },
      },
    },
    handler: async (input: AdsAuditRunInput, agent: IAgent): Promise<string> => {
      try {
        const adsAccountId = resolveAccountId(store, input);
        const result = runAudit(store, adsAccountId, {
          ...(input.verify_window_days !== undefined ? { verifyWindowDays: input.verify_window_days } : {}),
        });
        // Phase B: classify theme-coverage candidates against the customer
        // profile before persisting. Funnel + irrelevant tokens are dropped;
        // uncertain tokens stay in but the blueprint stage adds an operator
        // review marker so the call doesn't silently pollute asset_groups.
        await classifyThemeFindingTokens(result);
        // P1 Tier-2: same harness, different question — classify the
        // top per-term wasted spend candidates as relevant/irrelevant/
        // uncertain against the customer offer. Relevant terms drop
        // out of the negative-candidate pool (they're a fix-needed
        // signal, not waste); irrelevant ones stay; uncertain ones
        // get tagged for Phase-A operator review at blueprint time.
        await classifyIrrelevantSearchTermFinding(result);
        // P1/D3 Tier-2: same harness for competitor-term bidding —
        // classify each search term that matched a customer competitor
        // as intentional_competitive, unintentional_leak, or uncertain.
        // The blueprint stage drops "intentional_competitive" from the
        // negative-candidate pool, ships "unintentional_leak" as a
        // negative proposal, and tags "uncertain" for operator review.
        await classifyCompetitorTermFinding(result);
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

// ── Account resolution ────────────────────────────────────────────────

/** Same auto-resolve pattern as ads_data_pull: lets the agent pass either
 *  ads_account_id or customer_id (or both). When only customer_id is given
 *  and the customer has exactly one linked ads_account, we use that. */
function resolveAccountId(store: AdsDataStore, input: AdsAuditRunInput): string {
  if (input.ads_account_id) return input.ads_account_id;
  if (!input.customer_id) {
    throw new Error('ads_audit_run requires either ads_account_id or customer_id.');
  }
  const linked = store.listAdsAccountsForCustomer(input.customer_id);
  if (linked.length === 0) {
    throw new Error(
      `No ads_accounts linked to customer "${input.customer_id}". ` +
      `Run ads_data_pull first or pass ads_account_id explicitly.`,
    );
  }
  if (linked.length > 1) {
    const ids = linked.map(r => `"${r.ads_account_id}" (${r.account_label})`).join(', ');
    throw new Error(
      `Customer "${input.customer_id}" has ${linked.length} linked ads_accounts: ${ids}. ` +
      `Pass ads_account_id explicitly to disambiguate.`,
    );
  }
  return linked[0]!.ads_account_id;
}

// ── Theme classification (Phase B) ─────────────────────────────────────

/** Mutates the audit result in place: takes the deterministic
 *  `pmax_theme_coverage_gap` finding, runs every candidate token
 *  through `classifyThemeTokens`, and rewrites evidence so:
 *    - dropped (funnel + irrelevant) tokens disappear,
 *    - surviving tokens carry their `category` so the blueprint
 *      can decide whether to attach a Phase-A review marker,
 *    - the full classification is preserved for transparency.
 *  Drops the entire finding when no actionable+uncertain themes
 *  remain after classification. Cost-bound: a single Haiku call. */
export async function classifyThemeFindingTokens(
  result: AuditResult,
  classifyOpts?: ClassifyOptions,
): Promise<void> {
  if (!result.customer) return;
  const idx = result.findings.findIndex(f => f.area === 'pmax_theme_coverage_gap');
  if (idx < 0) return;
  const finding = result.findings[idx]!;
  const evidence = (finding.evidence ?? {}) as Record<string, unknown>;
  const themesRaw = evidence['themes'];
  if (!Array.isArray(themesRaw) || themesRaw.length === 0) return;
  type RawTheme = { token?: unknown; clusters?: unknown; sample?: unknown };
  const themes = themesRaw.filter((t): t is RawTheme => t !== null && typeof t === 'object');
  const tokens = themes
    .map(t => (typeof t.token === 'string' ? t.token : ''))
    .filter(t => t.length > 0);
  if (tokens.length === 0) return;

  const classification = await classifyThemeTokens(tokens, result.customer, classifyOpts ?? {});
  const byToken = new Map<string, ClassifiedToken>();
  for (const c of classification.classifications) {
    byToken.set(c.token.toLowerCase(), c);
  }

  const surviving: Array<Record<string, unknown>> = [];
  for (const t of themes) {
    const tok = typeof t.token === 'string' ? t.token : '';
    const cls = byToken.get(tok.toLowerCase());
    const category: ThemeCategory = cls?.category ?? 'uncertain';
    if (category === 'funnel' || category === 'irrelevant') continue;
    surviving.push({
      token: tok,
      clusters: typeof t.clusters === 'number' ? t.clusters : 0,
      sample: Array.isArray(t.sample) ? t.sample : [],
      category,
      ...(cls?.reason ? { classification_reason: cls.reason } : {}),
    });
  }

  if (surviving.length === 0) {
    // No theme survives — strip the finding so blueprint doesn't surface
    // an empty gap and the audit Markdown report stays accurate.
    result.findings.splice(idx, 1);
    return;
  }

  evidence['themes'] = surviving;
  evidence['classification'] = classification.classifications;
  finding.evidence = evidence;
  // Refresh the user-facing text so the audit Markdown report reflects
  // post-classification truth. Keep total cluster count over surviving
  // themes only — that's the volume the operator actually has to act on.
  const totalCovered = surviving.reduce((s, t) => s + (typeof t['clusters'] === 'number' ? (t['clusters'] as number) : 0), 0);
  const topLine = surviving.slice(0, 5)
    .map(t => `${String(t['token'])} (${Number(t['clusters'] ?? 0)} Cluster${t['category'] === 'uncertain' ? ', unsicher' : ''})`)
    .join(', ');
  finding.text = `${surviving.length} klassifizierte Themen in PMax-Search-Terms ohne passende Asset-Group: ${topLine}. ` +
    `Insgesamt ${totalCovered} Cluster — Kandidaten für Asset-Group-Expansion. ` +
    `Conv-Volume-Schutz: Quell-Gruppe muss nach Split noch ≥30 conv/30d halten.`;
}

/** Tier-2 of the per-term wasted-spend detector. Reads the
 *  Tier-1 candidates from the `irrelevant_search_term_spend` finding
 *  evidence, runs them through the LLM relevance classifier, and
 *  rewrites the evidence so each candidate carries its
 *  `classification` + `classification_reason`. Drops the entire
 *  finding if no irrelevant + uncertain candidates remain.
 *
 *  Cost-bound: a single Haiku call. Falls back to all-uncertain on
 *  any classifier error. */
export async function classifyIrrelevantSearchTermFinding(
  result: AuditResult,
  classifyOpts?: ClassifySearchTermOptions,
): Promise<void> {
  if (!result.customer) return;
  const idx = result.findings.findIndex(f => f.area === 'irrelevant_search_term_spend');
  if (idx < 0) return;
  const finding = result.findings[idx]!;
  const evidence = (finding.evidence ?? {}) as Record<string, unknown>;
  const candidatesRaw = evidence['candidates'];
  if (!Array.isArray(candidatesRaw) || candidatesRaw.length === 0) return;

  type RawCandidate = Record<string, unknown>;
  const candidates = candidatesRaw.filter((c): c is RawCandidate =>
    c !== null && typeof c === 'object');
  const terms = candidates
    .map(c => (typeof c['term'] === 'string' ? c['term'] : ''))
    .filter(t => t.length > 0);
  if (terms.length === 0) return;

  const classification = await classifySearchTermRelevance(terms, result.customer, classifyOpts ?? {});
  const byTerm = new Map<string, ClassifiedSearchTerm>();
  for (const c of classification.classifications) {
    byTerm.set(c.term.toLowerCase(), c);
  }

  const surviving: Array<Record<string, unknown>> = [];
  let irrelevantCount = 0;
  let uncertainCount = 0;
  for (const c of candidates) {
    const term = typeof c['term'] === 'string' ? c['term'] : '';
    const cls = byTerm.get(term.toLowerCase());
    const category: RelevanceCategory = cls?.category ?? 'uncertain';
    if (category === 'relevant') continue; // not waste; needs LP/copy fix, not a negative
    surviving.push({
      ...c,
      classification: category,
      ...(cls?.reason ? { classification_reason: cls.reason } : {}),
    });
    if (category === 'irrelevant') irrelevantCount++;
    else uncertainCount++;
  }

  if (surviving.length === 0) {
    result.findings.splice(idx, 1);
    return;
  }

  evidence['candidates'] = surviving;
  evidence['classification'] = classification.classifications;
  evidence['summary'] = {
    irrelevant: irrelevantCount,
    uncertain: uncertainCount,
    relevant_filtered_out: candidates.length - surviving.length,
  };
  finding.evidence = evidence;
  // Refresh the finding text now that we know the post-classification
  // breakdown. Spend total of surviving items only — relevant terms
  // (filtered out) are NOT waste.
  const totalSpend = surviving.reduce(
    (s, c) => s + (typeof c['spend_chf'] === 'number' ? (c['spend_chf'] as number) : 0), 0);
  finding.text = `${irrelevantCount} klar irrelevante + ${uncertainCount} unsichere Suchbegriffe ` +
    `mit ${totalSpend.toFixed(2)} CHF Spend ohne Conversions. ` +
    `Irrelevante → Negativ-Liste; unsichere → Operator-Review im Blueprint.`;
}

/** Tier-2 of the competitor-term-bidding detector. Reads the Tier-1
 *  candidates from the `competitor_term_bidding` finding evidence,
 *  runs them through the LLM intent classifier, and rewrites the
 *  evidence so each candidate carries its `classification` +
 *  `classification_reason`. Drops the entire finding when no
 *  unintentional + uncertain candidates remain (intentional-only
 *  signal isn't actionable as a finding — operator already chose to
 *  bid). Cost-bound: a single Haiku call. */
export async function classifyCompetitorTermFinding(
  result: AuditResult,
  classifyOpts?: ClassifyCompetitorOptions,
): Promise<void> {
  if (!result.customer) return;
  const idx = result.findings.findIndex(f => f.area === 'competitor_term_bidding');
  if (idx < 0) return;
  const finding = result.findings[idx]!;
  const evidence = (finding.evidence ?? {}) as Record<string, unknown>;
  const candidatesRaw = evidence['candidates'];
  if (!Array.isArray(candidatesRaw) || candidatesRaw.length === 0) return;

  type RawCandidate = Record<string, unknown>;
  const candidates = candidatesRaw.filter((c): c is RawCandidate =>
    c !== null && typeof c === 'object');
  const items = candidates
    .map(c => ({
      term: typeof c['term'] === 'string' ? c['term'] : '',
      matched_competitor: typeof c['matched_competitor'] === 'string' ? c['matched_competitor'] : '',
    }))
    .filter(it => it.term.length > 0 && it.matched_competitor.length > 0);
  if (items.length === 0) return;

  const classification = await classifyCompetitorTermIntent(items, result.customer, classifyOpts ?? {});
  const byKey = new Map<string, ClassifiedCompetitorTerm>();
  for (const c of classification.classifications) {
    byKey.set(`${c.term.toLowerCase()}\x00${c.matched_competitor.toLowerCase()}`, c);
  }

  const surviving: Array<Record<string, unknown>> = [];
  let leakCount = 0;
  let uncertainCount = 0;
  let intentionalCount = 0;
  for (const c of candidates) {
    const term = typeof c['term'] === 'string' ? c['term'] : '';
    const comp = typeof c['matched_competitor'] === 'string' ? c['matched_competitor'] : '';
    const cls = byKey.get(`${term.toLowerCase()}\x00${comp.toLowerCase()}`);
    const category: CompetitorIntentCategory = cls?.category ?? 'uncertain';
    if (category === 'intentional_competitive') {
      intentionalCount++;
      continue; // operator has chosen to bid here — drop from finding
    }
    surviving.push({
      ...c,
      classification: category,
      ...(cls?.reason ? { classification_reason: cls.reason } : {}),
    });
    if (category === 'unintentional_leak') leakCount++;
    else uncertainCount++;
  }

  if (surviving.length === 0) {
    result.findings.splice(idx, 1);
    return;
  }

  evidence['candidates'] = surviving;
  evidence['classification'] = classification.classifications;
  evidence['summary'] = {
    unintentional_leak: leakCount,
    uncertain: uncertainCount,
    intentional_filtered_out: intentionalCount,
  };
  finding.evidence = evidence;
  const totalSpend = surviving.reduce(
    (s, c) => s + (typeof c['spend_chf'] === 'number' ? (c['spend_chf'] as number) : 0), 0);
  finding.text = `${leakCount} unintentional Leak(s) + ${uncertainCount} unsichere Treffer ` +
    `auf Customer-Wettbewerber, ${totalSpend.toFixed(2)} CHF Spend. ` +
    `Leaks → Negativ-Liste; unsichere → Operator-Review im Blueprint.`;
}

// ── Persistence ───────────────────────────────────────────────────────

function persistFindings(store: AdsDataStore, result: AuditResult): number[] {
  // Replace, don't accumulate. ads_audit_run re-computes the full
  // deterministic finding set on every call against the latest
  // snapshot; without this clear the same run row would carry
  // duplicate `pmax_theme_coverage_gap` (or any other) findings on
  // re-runs and downstream tools (e.g. blueprint-engine reading
  // `findings[0]!`) would deterministically pick the oldest. Phase-C
  // findings live under source='agent' and survive.
  store.deleteFindingsBySource(result.run.run_id, 'deterministic');
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

function updateAccountMode(store: AdsDataStore, adsAccountId: string, mode: AuditMode): void {
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
  for (const severity of ['BLOCK', 'HIGH', 'MEDIUM', 'LOW'] as AdsFindingSeverity[]) {
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
