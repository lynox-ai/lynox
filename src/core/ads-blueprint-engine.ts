/**
 * Ads Optimizer — P3 Blueprint orchestrator.
 *
 * Composes the four P3 sub-modules over the latest successful audit
 * run:
 *
 *   - History-Preservation matcher   (ads-history-match)
 *   - Three-fold negative generator  (ads-negative-generator)
 *   - Naming-convention enforcer     (ads-naming-convention)
 *   - PMAX low-strength surface      (ads-pmax-restructure)
 *
 * Mode-gate:
 *   - BOOTSTRAP — every current snapshot entity becomes a KEEP decision
 *     (no rename/pause logic), additive negatives are still produced,
 *     and PMAX restructure proposals are skipped entirely.
 *   - OPTIMIZE — full history-preservation per entity type plus
 *     negative generation; restructure SAFEGUARD evaluation is
 *     available for the agent-driven path (V2) but the orchestrator
 *     does not auto-generate splits/merges in V1.
 *
 * Pure read/compute over the SQLite snapshot. No KG / HTTP / LLM
 * calls. The tool wrapper handles the markdown report and KG mirror.
 */
import type {
  AdsDataStore,
  AdsAccountRow,
  AdsAuditRunRow,
  AdsBlueprintEntityKind,
  CustomerProfileRow,
  InsertBlueprintEntityInput,
  AdsDecision,
  AdsDecisionEntityType,
} from './ads-data-store.js';
import { matchHistory, type MatchableEntity, type HistoryMatchDecision } from './ads-history-match.js';
import { generateNegatives, type NegativeProposal } from './ads-negative-generator.js';
import {
  parseTemplate, validateName,
  type NamingValidationContext, type ParsedTemplate, type NamingValidationResult,
} from './ads-naming-convention.js';
import { findLowStrengthAssetGroups, type LowStrengthAssetGroup } from './ads-pmax-restructure.js';

// Entity types we run history-preservation against. RSA ads + asset-groups
// + keywords cover the entities P4 emits to per-campaign Editor-CSVs.
const HISTORY_TRACKED_ENTITY_TYPES = ['campaign', 'ad_group', 'keyword', 'asset_group'] as const;

export interface BlueprintResult {
  account: AdsAccountRow;
  customer: CustomerProfileRow | null;
  run: AdsAuditRunRow;
  previousRun: AdsAuditRunRow | null;
  mode: 'BOOTSTRAP' | 'OPTIMIZE';
  /** Per entity type: history-match summary (empty for additive-only modes). */
  historyByType: Map<string, HistoryMatchDecision[]>;
  /** Negative-keyword proposals from all three sources. */
  negatives: NegativeProposal[];
  /** Asset-groups flagged for additive attention (low ad strength). */
  lowStrengthAssetGroups: LowStrengthAssetGroup[];
  /** Persisted blueprint_id values, in insertion order. */
  persistedEntityIds: number[];
  /** Counts of persisted entities by kind. */
  counts: Record<AdsBlueprintEntityKind, number> & { total: number };
  /** Names that fail the customer's naming-convention template. */
  namingViolations: Array<{ entityType: string; externalId: string; name: string; errors: string[] }>;
}

export interface RunBlueprintOptions {
  /** Inject "now" for deterministic tests. */
  now?: Date | undefined;
  /** Override waste-spend threshold for cross_campaign negatives (CHF). */
  wasteSpendThreshold?: number | undefined;
}

export class BlueprintPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlueprintPreconditionError';
  }
}

/** Raised when the previous run still has unimported blueprint entities and
 *  the smart-bidding learning window has not elapsed since the last import.
 *  Running a fresh blueprint here would just pile new proposals on top of
 *  ones the customer hasn't acted on. The tool layer catches this and
 *  renders an "import-pending" status report instead of failing. */
export class BlueprintPendingImportNotice extends Error {
  constructor(
    message: string,
    public readonly previousRunId: number,
    public readonly previousRunFinishedAt: string,
    public readonly pendingEntityCount: number,
    public readonly lastImportAt: string | null,
  ) {
    super(message);
    this.name = 'BlueprintPendingImportNotice';
  }
}

// ── Public entry point ────────────────────────────────────────────────

export function runBlueprint(
  store: AdsDataStore,
  adsAccountId: string,
  opts?: RunBlueprintOptions | undefined,
): BlueprintResult {
  const account = store.getAdsAccount(adsAccountId);
  if (!account) {
    throw new BlueprintPreconditionError(
      `Unknown ads_account_id "${adsAccountId}". Run ads_data_pull and ads_audit_run first.`,
    );
  }
  const run = store.getLatestSuccessfulAuditRun(adsAccountId);
  if (!run) {
    throw new BlueprintPreconditionError(
      `No successful audit run for "${adsAccountId}". Run ads_audit_run first.`,
    );
  }
  const customer = store.getCustomerProfile(account.customer_id);
  if (!customer) {
    throw new BlueprintPreconditionError(
      `Customer profile missing for "${account.customer_id}". Run ads_customer_profile_set first — ` +
      `Blueprint depends on naming convention, brands, competitors, pmax-owned head terms.`,
    );
  }
  const previousRun = run.previous_run_id !== null
    ? store.getAuditRun(run.previous_run_id)
    : null;

  // Idempotency guard: if the previous run already produced blueprint
  // entities and the customer hasn't imported them yet (or the import is
  // still inside the smart-bidding learning window), we do not generate a
  // fresh blueprint — that would just pile new proposals on top of pending
  // ones. The agent should re-emit the previous run's CSVs and wait.
  if (previousRun && previousRun.finished_at) {
    // Pending = anything that produces an Editor change. KEEP rows are
    // structural confirmations and don't need a re-import.
    const counts = store.countBlueprintEntities(previousRun.run_id);
    const pendingCount = counts.NEW + counts.RENAME + counts.PAUSE + counts.SPLIT + counts.MERGE;
    if (pendingCount > 0) {
      const lastImport = account.last_major_import_at;
      const importBeforeLastBlueprint = lastImport === null
        || new Date(lastImport).getTime() < new Date(previousRun.finished_at).getTime();
      if (importBeforeLastBlueprint) {
        throw new BlueprintPendingImportNotice(
          `Run ${previousRun.run_id} hat ${pendingCount} Blueprint-Vorschläge, die der Customer noch nicht ` +
          `via Editor importiert hat. Kein neuer Blueprint, bis import passiert ist + ads_mark_imported aufgerufen wurde.`,
          previousRun.run_id,
          previousRun.finished_at,
          pendingCount,
          lastImport,
        );
      }
    }
  }

  const mode = pickMode(store, run, previousRun);
  const namingTemplate = customer.naming_convention_pattern
    ? parseTemplate(customer.naming_convention_pattern)
    : null;
  const namingContext: NamingValidationContext = {
    languages: parseJsonArray(customer.languages),
    ownBrands: parseJsonArray(customer.own_brands),
  };

  // History-preservation per tracked entity type ─────────────────────
  const historyByType = new Map<string, HistoryMatchDecision[]>();
  for (const entityType of HISTORY_TRACKED_ENTITY_TYPES) {
    if (mode === 'BOOTSTRAP') {
      historyByType.set(entityType, allKeepFromCurrent(store, run, entityType));
    } else {
      historyByType.set(entityType, fullHistoryMatch(store, run, previousRun, entityType));
    }
  }

  // Negatives — additive in all modes ─────────────────────────────────
  const negatives = generateNegatives(store, adsAccountId, run.run_id, customer, {
    ...(opts?.wasteSpendThreshold !== undefined ? { wasteSpendThreshold: opts.wasteSpendThreshold } : {}),
  });

  // Low-strength asset groups — surfaced in markdown ──────────────────
  const lowStrengthAssetGroups = findLowStrengthAssetGroups(store, run);

  // Theme-coverage expansion — read the audit's theme finding and convert
  // each strong theme into a NEW asset_group proposal scoped to the top-
  // spending PMax campaign. Idempotent under re-runs because deterministic
  // entities get cleared before persist below.
  const themeExpansions = generateThemeExpansionProposals(store, run, customer);

  // Re-run safety: clear our own deterministic output (and the matching
  // ads_run_decisions rows) before writing fresh ones. Agent-source
  // additions (asset proposals, audience signals, validated PMAX
  // SPLIT/MERGE) are preserved.
  store.clearBlueprintEntities(run.run_id, 'deterministic');

  // Persist decisions + blueprint entities + record naming violations ─
  const persistedEntityIds: number[] = [];
  const namingViolations: BlueprintResult['namingViolations'] = [];

  for (const [entityType, decisions] of historyByType) {
    for (const d of decisions) {
      const naming = checkNamingForDecision(d, entityType, namingTemplate, namingContext);
      if (!naming.valid) {
        namingViolations.push({
          entityType,
          externalId: d.externalId,
          name: extractName(d) ?? d.externalId,
          errors: naming.errors,
        });
      }
      const blueprintInput: InsertBlueprintEntityInput = {
        runId: run.run_id,
        adsAccountId,
        entityType,
        kind: d.kind,
        externalId: d.externalId,
        previousExternalId: d.previousExternalId ?? undefined,
        confidence: d.confidence,
        rationale: d.rationale,
        payload: d.payload ?? {},
        namingValid: naming.valid,
        namingErrors: naming.errors,
      };
      const row = store.insertBlueprintEntity(blueprintInput);
      persistedEntityIds.push(row.blueprint_id);
      // Mirror to ads_run_decisions (canonical history-preservation log).
      store.insertRunDecision({
        runId: run.run_id,
        entityType: toDecisionEntityType(entityType),
        entityExternalId: d.externalId,
        decision: toDecisionKind(d.kind),
        previousExternalId: d.previousExternalId ?? undefined,
        confidence: d.confidence,
        rationale: d.rationale,
      });
    }
  }

  // Theme-expansion proposals → NEW entities, type='asset_group'.
  for (const exp of themeExpansions) {
    const externalId = `bp.assetgroup.${slug(exp.campaignName)}.${slug(exp.assetGroupName)}`;
    const blueprintInput: InsertBlueprintEntityInput = {
      runId: run.run_id,
      adsAccountId,
      entityType: 'asset_group',
      kind: 'NEW',
      externalId,
      confidence: 0.7,
      rationale: exp.rationale,
      payload: {
        campaign_name: exp.campaignName,
        asset_group_name: exp.assetGroupName,
        theme_token: exp.theme,
        cluster_count: exp.clusters,
        sample_search_terms: exp.sampleClusters,
        status: 'PAUSED',
      },
      namingValid: true,
      namingErrors: [],
    };
    const row = store.insertBlueprintEntity(blueprintInput);
    persistedEntityIds.push(row.blueprint_id);
    store.insertRunDecision({
      runId: run.run_id,
      entityType: 'asset_group',
      entityExternalId: externalId,
      decision: 'NEW',
      confidence: 0.7,
      rationale: exp.rationale,
    });
  }

  // Negatives → NEW entities, type='negative'.
  for (const n of negatives) {
    const blueprintInput: InsertBlueprintEntityInput = {
      runId: run.run_id,
      adsAccountId,
      entityType: 'negative',
      kind: 'NEW',
      externalId: n.externalId,
      confidence: n.confidence,
      rationale: n.rationale,
      payload: {
        keyword_text: n.keywordText,
        match_type: n.matchType,
        scope: n.scope,
        scope_target: n.scopeTarget,
        source: n.source,
        ...(n.evidence ? { evidence: n.evidence } : {}),
      },
      // Negatives are not subject to the customer's naming convention.
      namingValid: true,
      namingErrors: [],
    };
    const row = store.insertBlueprintEntity(blueprintInput);
    persistedEntityIds.push(row.blueprint_id);
    store.insertRunDecision({
      runId: run.run_id,
      entityType: 'negative',
      entityExternalId: n.externalId,
      decision: 'NEW',
      confidence: n.confidence,
      rationale: n.rationale,
    });
  }

  const counts = store.countBlueprintEntities(run.run_id);

  return {
    account, customer, run, previousRun, mode,
    historyByType, negatives, lowStrengthAssetGroups,
    persistedEntityIds, counts, namingViolations,
  };
}

// ── Mode picking ──────────────────────────────────────────────────────

const MIN_OPTIMIZE_DAYS = 30;

function pickMode(
  store: AdsDataStore, run: AdsAuditRunRow, previousRun: AdsAuditRunRow | null,
): 'BOOTSTRAP' | 'OPTIMIZE' {
  // Recompute mode from the data instead of trusting run.mode. Data_pull
  // tags a new run with a mode based purely on whether a previous run
  // exists; the audit then checks performance-day coverage and may
  // disagree. Blueprint must follow the data, not the recorded tag, or
  // an account with insufficient days slips into OPTIMIZE and skips the
  // additive-only safeguards (no rename, no PMAX restructure).
  if (!previousRun) return 'BOOTSTRAP';
  const performanceDays = countPerformanceDaysForRun(store, run);
  return performanceDays < MIN_OPTIMIZE_DAYS ? 'BOOTSTRAP' : 'OPTIMIZE';
}

function countPerformanceDaysForRun(store: AdsDataStore, run: AdsAuditRunRow): number {
  const rows = store.getSnapshotRows<{ date: string }>(
    'ads_campaign_performance', run.ads_account_id, { runId: run.run_id },
  );
  const set = new Set<string>();
  for (const r of rows) if (r.date) set.add(r.date);
  return set.size;
}

// ── Snapshot loading per entity type ──────────────────────────────────

function loadEntities(
  store: AdsDataStore, run: AdsAuditRunRow, entityType: string,
): MatchableEntity[] {
  switch (entityType) {
    case 'campaign': {
      const rows = store.getSnapshotRows<{
        campaign_id: string; campaign_name: string; status: string | null;
        budget_micros: number | null; channel_type: string | null;
        bidding_strategy_type: string | null;
        target_roas: number | null; target_cpa_micros: number | null;
      }>('ads_campaigns', run.ads_account_id, { runId: run.run_id });
      return rows.map(r => ({
        externalId: r.campaign_id,
        name: r.campaign_name,
        ...(r.status !== null ? { status: r.status } : {}),
        payload: {
          campaign_name: r.campaign_name,
          ...(r.budget_micros !== null ? { budget_micros: r.budget_micros } : {}),
          ...(r.channel_type !== null ? { channel_type: r.channel_type } : {}),
          ...(r.bidding_strategy_type !== null ? { bidding_strategy_type: r.bidding_strategy_type } : {}),
          ...(r.target_roas !== null ? { target_roas: r.target_roas } : {}),
          ...(r.target_cpa_micros !== null ? { target_cpa_micros: r.target_cpa_micros } : {}),
        },
      }));
    }
    case 'ad_group': {
      const validCampaigns = collectCampaignNames(store, run);
      const rows = store.getSnapshotRows<{
        ad_group_id: string | null; ad_group_name: string; campaign_name: string | null;
        status: string | null;
      }>('ads_ad_groups', run.ads_account_id, { runId: run.run_id });
      return rows
        .filter(r => r.campaign_name !== null && validCampaigns.has(r.campaign_name))
        .map(r => ({
          externalId: r.ad_group_id ?? `${r.campaign_name ?? ''}::${r.ad_group_name}`,
          name: r.ad_group_name,
          ...(r.status !== null ? { status: r.status } : {}),
          payload: {
            ad_group_name: r.ad_group_name,
            ...(r.campaign_name !== null ? { campaign_name: r.campaign_name } : {}),
          },
        }));
    }
    case 'keyword': {
      const validCampaigns = collectCampaignNames(store, run);
      const rows = store.getSnapshotRows<{
        keyword: string; match_type: string | null; campaign_name: string | null;
        ad_group_name: string | null; status: string | null;
      }>('ads_keywords', run.ads_account_id, { runId: run.run_id });
      return rows
        .filter(r => r.campaign_name !== null && validCampaigns.has(r.campaign_name))
        .map(r => {
          // Keywords have no stable Google ID in the export — synthesise from
          // (campaign, ad_group, keyword, match_type) which is unique within
          // an account.
          const id = `${r.campaign_name ?? ''}::${r.ad_group_name ?? ''}::${r.keyword}::${r.match_type ?? ''}`;
          return {
            externalId: id,
            name: r.keyword,
            ...(r.status !== null ? { status: r.status } : {}),
            payload: {
              keyword: r.keyword,
              ...(r.match_type !== null ? { match_type: r.match_type } : {}),
              ...(r.campaign_name !== null ? { campaign_name: r.campaign_name } : {}),
              ...(r.ad_group_name !== null ? { ad_group_name: r.ad_group_name } : {}),
            },
          };
        });
    }
    case 'asset_group': {
      const validCampaigns = collectCampaignNames(store, run);
      const rows = store.getSnapshotRows<{
        asset_group_id: string; asset_group_name: string;
        campaign_name: string | null; status: string | null;
      }>('ads_asset_groups', run.ads_account_id, { runId: run.run_id });
      return rows
        .filter(r => r.campaign_name !== null && validCampaigns.has(r.campaign_name))
        .map(r => ({
          externalId: r.asset_group_id,
          name: r.asset_group_name,
          ...(r.status !== null ? { status: r.status } : {}),
          payload: {
            asset_group_name: r.asset_group_name,
            ...(r.campaign_name !== null ? { campaign_name: r.campaign_name } : {}),
          },
        }));
    }
    default:
      return [];
  }
}

// Memoize collectCampaignNames per run inside one orchestrator pass so
// the three sub-entity branches don't each fan out to their own DB read.
// Keyed by (account, run_id) — the orchestrator clears the cache between
// invocations because the dataset can change between runBlueprint calls
// (re-pull of the same run, or fresh test fixture).
const _campaignNameCache = new WeakMap<AdsAuditRunRow, Set<string>>();

// Drop sub-entities (ad_group / keyword / asset_group) whose parent
// campaign is not in the current snapshot. Belt-and-braces against GAS
// exports that filter the parent by `campaign.status != REMOVED` but
// leave the children un-joined (a real-world archive snapshot exposed
// 8 ad-groups referencing REMOVED campaigns, tripping the emit
// cross-reference validator).
//
// Cached per AdsAuditRunRow object so the three sub-entity branches in
// loadEntities share one DB read instead of three. The WeakMap entry
// dies with the row object, so a re-run of the orchestrator (which
// re-fetches the row) starts fresh.
function collectCampaignNames(store: AdsDataStore, run: AdsAuditRunRow): Set<string> {
  const cached = _campaignNameCache.get(run);
  if (cached) return cached;
  const rows = store.getSnapshotRows<{ campaign_name: string }>(
    'ads_campaigns', run.ads_account_id, { runId: run.run_id },
  );
  const set = new Set(rows.map(r => r.campaign_name).filter((n): n is string => typeof n === 'string'));
  _campaignNameCache.set(run, set);
  return set;
}

function fullHistoryMatch(
  store: AdsDataStore, run: AdsAuditRunRow, previousRun: AdsAuditRunRow | null, entityType: string,
): HistoryMatchDecision[] {
  const current = loadEntities(store, run, entityType);
  if (!previousRun) return current.map(toKeepDecision);
  const previous = loadEntities(store, previousRun, entityType);
  return matchHistory(previous, current).decisions;
}

function allKeepFromCurrent(
  store: AdsDataStore, run: AdsAuditRunRow, entityType: string,
): HistoryMatchDecision[] {
  return loadEntities(store, run, entityType).map(toKeepDecision);
}

function toKeepDecision(e: MatchableEntity): HistoryMatchDecision {
  return {
    kind: 'KEEP',
    externalId: e.externalId,
    previousExternalId: null,
    confidence: 1,
    rationale: 'BOOTSTRAP-Mode: alle aktuellen Entities werden ohne Restructure übernommen.',
    ...(e.payload !== undefined ? { payload: e.payload } : {}),
  };
}

// ── Naming-convention check ──────────────────────────────────────────

function checkNamingForDecision(
  d: HistoryMatchDecision, entityType: string,
  template: ParsedTemplate | null, context: NamingValidationContext,
): NamingValidationResult {
  if (template === null) return { valid: true, errors: [] };
  // Naming convention applies primarily to campaigns/ad_groups/asset_groups.
  // Keywords have their own structure (the keyword text itself), so we skip.
  if (entityType === 'keyword') return { valid: true, errors: [] };
  const name = extractName(d);
  if (!name) return { valid: true, errors: [] };
  return validateName(name, template, context);
}

function extractName(d: HistoryMatchDecision): string | undefined {
  const p = d.payload as Record<string, unknown> | undefined;
  if (!p) return undefined;
  for (const key of ['campaign_name', 'ad_group_name', 'asset_group_name', 'keyword']) {
    const v = p[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

// ── Decision/blueprint kind translations ──────────────────────────────

function toDecisionKind(kind: AdsBlueprintEntityKind): AdsDecision {
  // The two enums are intentionally aligned; the cast surfaces drift if
  // either side ever extends.
  return kind as AdsDecision;
}

function toDecisionEntityType(entityType: string): AdsDecisionEntityType {
  // ads_run_decisions enum is closed; map cleanly or fall back to the
  // closest sibling. Kept defensive even though all callers here pass
  // values from HISTORY_TRACKED_ENTITY_TYPES.
  switch (entityType) {
    case 'campaign':
    case 'ad_group':
    case 'keyword':
    case 'rsa_ad':
    case 'asset_group':
    case 'asset':
    case 'listing_group':
    case 'sitelink':
    case 'callout':
    case 'snippet':
    case 'negative':
      return entityType;
    default:
      return 'campaign';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Local slug for blueprint external_ids — matches the propose-tool style. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60);
}

interface ThemeExpansionProposal {
  theme: string;
  clusters: number;
  campaignName: string;
  assetGroupName: string;
  sampleClusters: string[];
  rationale: string;
}

/** Read the theme-coverage finding produced by the audit, pick the
 *  top-spending PMax campaign as the host, and emit one NEW asset_group
 *  proposal per strong theme. The asset-group is paused-by-default; the
 *  customer activates it after editor-import.
 *
 *  Guard: limit to MAX_THEME_EXPANSIONS so a single cycle does not flood
 *  the proposal queue. The agent can still add more via propose. */
const MAX_THEME_EXPANSIONS = 5;

function generateThemeExpansionProposals(
  store: AdsDataStore,
  run: AdsAuditRunRow,
  customer: CustomerProfileRow,
): ThemeExpansionProposal[] {
  const findings = store.listFindings(run.run_id, { area: 'pmax_theme_coverage_gap' });
  if (findings.length === 0) return [];
  const finding = findings[0]!;
  let evidence: { themes?: Array<{ token: string; clusters: number; sample?: string[] }> } = {};
  try {
    evidence = JSON.parse(finding.evidence_json);
  } catch {
    return [];
  }
  const themes = evidence.themes ?? [];
  if (themes.length === 0) return [];

  // Pick host PMax campaign by highest spend in the snapshot.
  const pmaxCampaigns = store.getSnapshotRows<{ campaign_name: string | null; channel_type: string | null; cost_micros: number | null }>(
    'ads_campaigns', run.ads_account_id, { runId: run.run_id },
  ).filter(r => r.channel_type === 'PERFORMANCE_MAX' && r.campaign_name);
  if (pmaxCampaigns.length === 0) return [];
  const host = pmaxCampaigns.reduce((acc, r) => (r.cost_micros ?? 0) > (acc.cost_micros ?? 0) ? r : acc);

  const customerSlug = customer.customer_id;
  return themes.slice(0, MAX_THEME_EXPANSIONS).map(t => ({
    theme: t.token,
    clusters: t.clusters,
    campaignName: host.campaign_name!,
    assetGroupName: `Theme-${capitalize(t.token)}`,
    sampleClusters: t.sample ?? [],
    rationale: `Theme-Coverage-Gap: "${t.token}" hat ${t.clusters} PMax-Search-Cluster ohne passende Asset-Group. ` +
      `Neuer Asset-Group-Vorschlag (Status PAUSED) für ${customerSlug}; nach Import + 14d Lernfenster Performance prüfen.`,
  }));
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

function parseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
