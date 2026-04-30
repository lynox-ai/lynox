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
  BlueprintReviewItem,
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

  // Brand-search auto-proposal — read the brand-inflation finding and emit
  // a Brand-Search campaign + per-brand ad_groups + Phrase/Exact keywords
  // + cross-channel negatives that block the same brand terms in every
  // existing PMax campaign. The user must activate the PMax-negatives
  // *after* the brand-search campaign is live (otherwise brand traffic
  // disappears for the gap window) — that's documented in the rationale
  // and the manual-todos summary.
  const brandSearch = generateBrandSearchProposals(store, run, customer);

  // Bid-modifier auto-proposal — read device/geo outlier findings and
  // patch the modifier fields onto the corresponding campaign KEEP
  // payloads. Skipped for PMax campaigns (bid modifiers do not apply).
  applyBidModifierProposals(store, run, historyByType);

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
  // Each theme-AG also gets 5 templated headlines + 2 descriptions (Status
  // Paused) so the Editor-import is content-complete out of the box. The
  // agent can refine the templates via propose; the templates use the
  // theme-token + customer slug so they are at least topically relevant.
  for (const exp of themeExpansions) {
    const externalId = `bp.assetgroup.${slug(exp.campaignName)}.${slug(exp.assetGroupName)}`;
    persistedEntityIds.push(store.insertBlueprintEntity({
      runId: run.run_id, adsAccountId, entityType: 'asset_group', kind: 'NEW',
      externalId, confidence: 0.7, rationale: exp.rationale,
      payload: {
        campaign_name: exp.campaignName,
        asset_group_name: exp.assetGroupName,
        theme_token: exp.theme,
        cluster_count: exp.clusters,
        sample_search_terms: exp.sampleClusters,
        status: 'PAUSED',
        ...(exp.finalUrl !== null ? { final_url: exp.finalUrl } : {}),
      },
      namingValid: true, namingErrors: [],
      ...(exp.urlReview ? { needsReview: [exp.urlReview] } : {}),
    }).blueprint_id);
    store.insertRunDecision({
      runId: run.run_id, entityType: 'asset_group', entityExternalId: externalId,
      decision: 'NEW', confidence: 0.7, rationale: exp.rationale,
    });

    // Auto-generate 5 headlines + 2 descriptions per theme-AG so the
    // emit-validator's content-completeness check passes. Templates picked
    // for short tokens (≤30 chars after substitution).
    for (const [idx, asset] of generatePlaceholderAssets(exp.theme).entries()) {
      const assetExt = `bp.asset.${slug(exp.campaignName)}.${slug(exp.assetGroupName)}.${asset.fieldType.toLowerCase()}.${idx + 1}`;
      persistedEntityIds.push(store.insertBlueprintEntity({
        runId: run.run_id, adsAccountId, entityType: 'asset', kind: 'NEW',
        externalId: assetExt, confidence: 0.5,
        rationale:
          `Auto-Placeholder für Theme-AG "${exp.assetGroupName}" — Agent soll mit propose ` +
          `verfeinern (LP-Crawl + Brand-Voice).`,
        payload: {
          campaign_name: exp.campaignName,
          asset_group_name: exp.assetGroupName,
          field_type: asset.fieldType,
          index: asset.index,
          text: asset.text,
        },
        namingValid: true, namingErrors: [],
      }).blueprint_id);
      store.insertRunDecision({
        runId: run.run_id, entityType: 'asset', entityExternalId: assetExt,
        decision: 'NEW', confidence: 0.5,
        rationale: `Auto-Placeholder ${asset.fieldType} ${asset.index} für "${exp.assetGroupName}".`,
      });
    }
  }

  // Brand-Search proposals → NEW campaign + ad_groups + keywords.
  if (brandSearch) {
    const campExt = `bp.campaign.${slug(brandSearch.campaign.name)}`;
    persistedEntityIds.push(store.insertBlueprintEntity({
      runId: run.run_id, adsAccountId, entityType: 'campaign', kind: 'NEW',
      externalId: campExt, confidence: 0.85, rationale: brandSearch.rationale,
      payload: {
        campaign_name: brandSearch.campaign.name,
        channel_type: 'SEARCH',
        // Google deprecated standalone TARGET_CPA for new Search campaigns
        // (Editor blocks it: "Die Gebotsstrategie 'Ziel-CPA' kann nicht
        // mehr in Suchkampagnen verwendet werden. Nutzen Sie stattdessen
        // die Gebotsstrategie 'Conversions maximieren'."). MAXIMIZE_CONVERSIONS
        // accepts a Target-CPA portfolio constraint as a soft cap.
        bidding_strategy_type: 'MAXIMIZE_CONVERSIONS',
        target_cpa_chf: brandSearch.campaign.targetCpa,
        budget_chf: brandSearch.campaign.budget,
      },
      namingValid: true, namingErrors: [],
    }).blueprint_id);
    store.insertRunDecision({
      runId: run.run_id, entityType: 'campaign', entityExternalId: campExt,
      decision: 'NEW', confidence: 0.85, rationale: brandSearch.rationale,
    });
    for (const ag of brandSearch.adGroups) {
      const agExt = `bp.adgroup.${slug(brandSearch.campaign.name)}.${slug(ag.name)}`;
      persistedEntityIds.push(store.insertBlueprintEntity({
        runId: run.run_id, adsAccountId, entityType: 'ad_group', kind: 'NEW',
        externalId: agExt, confidence: 0.85,
        rationale: `Brand-Search-Ad-Group für Token "${ag.brandToken}".`,
        payload: { campaign_name: brandSearch.campaign.name, ad_group_name: ag.name },
        namingValid: true, namingErrors: [],
      }).blueprint_id);
      store.insertRunDecision({
        runId: run.run_id, entityType: 'ad_group', entityExternalId: agExt,
        decision: 'NEW', confidence: 0.85,
        rationale: `Brand-Search-Ad-Group für Token "${ag.brandToken}".`,
      });
    }
    for (const k of brandSearch.keywords) {
      const kExt = `bp.kw.${slug(brandSearch.campaign.name)}.${slug(k.adGroupName)}.${slug(k.keyword)}.${k.matchType.toLowerCase()}`;
      persistedEntityIds.push(store.insertBlueprintEntity({
        runId: run.run_id, adsAccountId, entityType: 'keyword', kind: 'NEW',
        externalId: kExt, confidence: 0.85,
        rationale: `Brand-Keyword "${k.keyword}" (${k.matchType}) in Ad-Group "${k.adGroupName}".`,
        payload: {
          campaign_name: brandSearch.campaign.name,
          ad_group_name: k.adGroupName,
          keyword: k.keyword,
          match_type: k.matchType,
        },
        namingValid: true, namingErrors: [],
      }).blueprint_id);
      store.insertRunDecision({
        runId: run.run_id, entityType: 'keyword', entityExternalId: kExt,
        decision: 'NEW', confidence: 0.85,
        rationale: `Brand-Keyword "${k.keyword}" (${k.matchType}).`,
      });
    }
    // RSA per ad-group — Editor blocks publish for an ad-group without
    // any active ad. Status defaults to Paused via the standard NEW
    // path; operator activates after image/asset review.
    for (const rsa of brandSearch.rsas) {
      const rsaExt = `bp.rsa.${slug(brandSearch.campaign.name)}.${slug(rsa.adGroupName)}`;
      persistedEntityIds.push(store.insertBlueprintEntity({
        runId: run.run_id, adsAccountId, entityType: 'rsa_ad', kind: 'NEW',
        externalId: rsaExt, confidence: 0.7,
        rationale: `Brand-RSA für Ad-Group "${rsa.adGroupName}" — Auto-Headlines/Descriptions, ` +
          `final_url aus Top-LP. Agent soll mit ads_blueprint_entity_propose verfeinern.` +
          (rsa.urlReview ? ' — Operator-Review nötig (Brand-URL mehrdeutig).' : ''),
        payload: {
          campaign_name: brandSearch.campaign.name,
          ad_group_name: rsa.adGroupName,
          headlines: rsa.headlines,
          descriptions: rsa.descriptions,
          final_url: rsa.finalUrl,
        },
        namingValid: true, namingErrors: [],
        ...(rsa.urlReview ? { needsReview: [rsa.urlReview] } : {}),
      }).blueprint_id);
      store.insertRunDecision({
        runId: run.run_id, entityType: 'rsa_ad', entityExternalId: rsaExt,
        decision: 'NEW', confidence: 0.7,
        rationale: `Brand-RSA Auto-Placeholder für "${rsa.adGroupName}".`,
      });
    }
    // Cross-channel negatives — append into the negatives bucket so the
    // existing persist loop below picks them up.
    for (const n of brandSearch.crossChannelNegatives) {
      negatives.push({
        externalId: `bp.neg.${slug(n.scopeTarget ?? 'account')}.${slug(n.keywordText)}.${n.matchType.toLowerCase()}`,
        keywordText: n.keywordText, matchType: n.matchType,
        scope: n.scope, scopeTarget: n.scopeTarget,
        source: 'brand_inflation_block',
        confidence: 0.85,
        rationale:
          `Cross-Channel-Negative: blockt Brand-Token "${n.keywordText}" auf PMax-Kampagne ` +
          `"${n.scopeTarget}". WICHTIG: Erst aktivieren NACH Brand-Search-Launch.`,
      });
    }
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
  /** Final URL picked from existing landing-page snapshot rows. The proposer
   *  scores each LP URL by token-overlap with the theme + click volume; ties
   *  break on conversion volume. Falls back to the customer's most-clicked
   *  LP when no themed match exists, and to the highest-spend campaign's LP
   *  as a last resort. */
  finalUrl: string | null;
  /** Non-null when the URL pick is ambiguous (no slug match or near-tied
   *  scores). The orchestrator persists this onto the asset_group entity's
   *  needs_review_json column; ads_blueprint_review_picks resolves it
   *  before emit can proceed. */
  urlReview: BlueprintReviewItem | null;
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

  // Pull existing LP performance to pick theme-relevant URLs. URL-pattern
  // matching beats the previous "always use root domain" approach because
  // PMax learns much faster when the AG ships with a topical LP — Editor
  // accepts the URL pattern as the asset_group's Final URL field.
  const lpRows = store.getSnapshotRows<{
    landing_page_url: string | null; clicks: number | null; conversions: number | null;
  }>('ads_landing_pages', run.ads_account_id, { runId: run.run_id });
  const lpSummary = aggregateLpPerformance(lpRows);

  const customerSlug = customer.customer_id;
  return themes.slice(0, MAX_THEME_EXPANSIONS).map(t => {
    const { url: finalUrl, review: urlReview } = pickFinalUrlForTheme(t.token, lpSummary);
    return {
      theme: t.token,
      clusters: t.clusters,
      campaignName: host.campaign_name!,
      assetGroupName: `Theme-${capitalize(t.token)}`,
      sampleClusters: t.sample ?? [],
      finalUrl,
      urlReview,
      rationale: `Theme-Coverage-Gap: "${t.token}" hat ${t.clusters} PMax-Search-Cluster ohne passende Asset-Group. ` +
        `Neuer Asset-Group-Vorschlag (Status PAUSED) für ${customerSlug}` +
        (finalUrl ? ` mit themen-spezifischer LP "${finalUrl}"` : ' (LP-Mapping fehlgeschlagen, manuell setzen)') +
        (urlReview ? ' — Operator-Review nötig (URL-Pick mehrdeutig).' : '') +
        `; nach Import + 14d Lernfenster Performance prüfen.`,
    };
  });
}

interface LpPerformance {
  url: string;
  clicks: number;
  conversions: number;
}

/** Aggregate clicks + conversions per landing-page URL across all snapshot
 *  rows. Multiple campaigns can drive the same LP — sum across them so the
 *  ranking reflects total customer traffic, not per-campaign noise. */
function aggregateLpPerformance(
  rows: ReadonlyArray<{ landing_page_url: string | null; clicks: number | null; conversions: number | null }>,
): LpPerformance[] {
  const agg = new Map<string, LpPerformance>();
  for (const r of rows) {
    const url = (r.landing_page_url ?? '').trim();
    if (!url) continue;
    let bucket = agg.get(url);
    if (!bucket) { bucket = { url, clicks: 0, conversions: 0 }; agg.set(url, bucket); }
    bucket.clicks += Number(r.clicks) || 0;
    bucket.conversions += Number(r.conversions) || 0;
  }
  return Array.from(agg.values());
}

/** Pick the LP whose URL best matches a token (theme or brand). Scoring:
 *   - +50 if the URL slug-form contains the token,
 *   - +20 if any URL path segment starts with the token,
 *   - + clicks ÷ 10 as tie-breaker on tied substring matches.
 *  Falls back to the LP with most conversions (proxy for customer-default).
 *  Returns null when there are no LP rows at all.
 *
 *  When the deterministic pick is ambiguous (zero positive score, or two
 *  candidates within 10% of each other), `review` carries a non-null
 *  marker that the orchestrator persists onto the entity row. The
 *  ads_blueprint_review_picks tool drains the queue with one batched
 *  ask_user dialog before emit can run. */
function pickFinalUrlForToken(
  token: string, lps: readonly LpPerformance[], context: 'theme' | 'brand',
): { url: string | null; review: BlueprintReviewItem | null } {
  if (lps.length === 0) return { url: null, review: null };
  const t = token.toLowerCase().trim();
  if (t.length === 0) return { url: null, review: null };

  const scored = lps.map(lp => {
    const slugForm = lp.url.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
    const segments = lp.url.toLowerCase().split('/').map(s => s.replace(/[^a-z0-9]+/gu, ''));
    let score = 0;
    if (slugForm.includes(t)) score += 50;
    if (segments.some(s => s.startsWith(t))) score += 20;
    if (score > 0) score += lp.clicks / 10;
    return { ...lp, score };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0]!;
  if (top.score > 0) {
    // Confident pick — but flag for review when the runner-up is within
    // 10% of the leader (true tie/near-tie). Customer should pick
    // explicitly; otherwise the deterministic tie-breaker is opaque.
    const second = scored[1];
    const tiedClose = second && second.score > 0 &&
      (top.score - second.score) / top.score <= 0.10;
    if (tiedClose) {
      return {
        url: top.url,
        review: buildUrlReview(token, scored.slice(0, 3), context, 'tied_url_score'),
      };
    }
    return { url: top.url, review: null };
  }

  // No slug match — surface the top three by traffic (clicks then conv)
  // and ask the operator to pick. Use the conversions-default as the
  // working URL until the review resolves so emit-validators that
  // require final_url still see a value.
  const fallbackOrdered = [...lps].sort((a, b) =>
    (b.conversions - a.conversions) || (b.clicks - a.clicks),
  );
  const candidates = fallbackOrdered.slice(0, Math.min(3, fallbackOrdered.length));
  return {
    url: fallbackOrdered[0]?.url ?? null,
    review: buildUrlReview(token, candidates, context, 'no_slug_match'),
  };
}

/** Wrap the legacy theme-only signature so existing callers keep working
 *  with a string return. The proposal type keeps the optional review
 *  marker which the orchestrator persists on the entity row. */
function pickFinalUrlForTheme(theme: string, lps: readonly LpPerformance[]):
  { url: string | null; review: BlueprintReviewItem | null } {
  return pickFinalUrlForToken(theme, lps, 'theme');
}

function buildUrlReview(
  token: string, candidates: readonly LpPerformance[],
  context: 'theme' | 'brand', reason: 'tied_url_score' | 'no_slug_match',
): BlueprintReviewItem {
  const promptHead = context === 'brand'
    ? `Brand-Search-Anzeige für "${token}": welche Landing-Page als Final URL?`
    : `Theme-Asset-Group "${token}": welche Landing-Page als Final URL?`;
  const promptTail = reason === 'no_slug_match'
    ? 'Keine LP-URL enthält den Token im Slug — bitte manuell zuweisen.'
    : 'Top-Kandidaten haben fast identischen Score — bitte zuordnen.';
  return {
    field: 'final_url',
    reason: `ambiguous_url_pick:${reason}`,
    prompt: `${promptHead} ${promptTail}`,
    candidates: candidates.map(c => ({
      value: c.url,
      label: c.url,
      hint: `${c.clicks} Klicks · ${c.conversions.toFixed(1)} Conv`,
    })),
  };
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

/** Map a conv-rate delta-pct (negative = under-performing) to a sane
 *  bid-modifier in percent. Floors at -50% (Editor refuses anything more
 *  aggressive); zero/positive deltas yield no modifier. The mapping is
 *  intentionally conservative: -50% conv-rate → -25% bid (half the
 *  conv-loss), -100% conv-rate → -50% bid. */
function deltaToBidModifierPct(deltaPct: number): number | null {
  if (deltaPct >= 0) return null;
  // deltaPct is negative; absolute value is conv-rate loss.
  const loss = Math.min(100, Math.abs(deltaPct));
  const modifier = -Math.round(loss / 2);
  // No-op below -10% (statistical noise).
  if (modifier > -10) return null;
  return Math.max(modifier, -50);
}

/** Read device/geo outlier findings and patch the corresponding bid-
 *  modifier fields onto the campaign KEEP payloads. Modifier types Editor
 *  understands: desktop/mobile/tablet/tv-screen for device; per-location
 *  modifier for geo. Geo modifiers live on Location rows so we surface them
 *  via a new `geo_modifiers` payload field which emit translates into
 *  Location rows.
 *
 *  PMax campaigns are skipped — Google's PMax does not honour traditional
 *  device/geo modifiers (they are routed through asset-signal-side targeting).
 */
function applyBidModifierProposals(
  store: AdsDataStore, run: AdsAuditRunRow,
  historyByType: Map<string, HistoryMatchDecision[]>,
): void {
  const deviceFindings = store.listFindings(run.run_id, { area: 'device_performance_outlier' });
  const geoFindings = store.listFindings(run.run_id, { area: 'geo_performance_outlier' });
  if (deviceFindings.length === 0 && geoFindings.length === 0) return;

  // Build a campaign → channel-type map so we can skip PMax.
  const campaignChannelType = new Map<string, string>();
  for (const r of store.getSnapshotRows<{ campaign_name: string | null; channel_type: string | null }>(
    'ads_campaigns', run.ads_account_id, { runId: run.run_id },
  )) {
    if (r.campaign_name) campaignChannelType.set(r.campaign_name, r.channel_type ?? '');
  }

  const deviceModifiers = collectDeviceModifiers(deviceFindings);
  // Geo modifiers live on Editor Location rows, not on the campaign row
  // — that needs a separate emit-side path. V1 records them in the
  // payload for downstream consumers (markdown report) but does not
  // attempt to translate them into Location rows yet.
  const geoModifiers = collectGeoModifiers(geoFindings);
  if (deviceModifiers.size === 0 && geoModifiers.size === 0) return;

  const campaignDecisions = historyByType.get('campaign') ?? [];
  for (const d of campaignDecisions) {
    if (d.kind !== 'KEEP' && d.kind !== 'RENAME') continue;
    const payload = d.payload ?? {};
    const camp = typeof payload['campaign_name'] === 'string'
      ? payload['campaign_name'] as string : '';
    if (!camp) continue;
    const ch = (campaignChannelType.get(camp) ?? '').toUpperCase();
    if (ch === 'PERFORMANCE_MAX' || ch === 'SHOPPING') continue;

    if (deviceModifiers.size > 0) {
      for (const [device, pct] of deviceModifiers) {
        const key = deviceModifierKey(device);
        if (key) payload[key] = pct;
      }
    }
    if (geoModifiers.size > 0) {
      payload['geo_bid_modifiers'] = Array.from(geoModifiers.entries())
        .map(([region, pct]) => ({ region, modifier_pct: pct }));
    }
    d.payload = payload;
  }
}

function collectDeviceModifiers(findings: readonly { evidence_json: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of findings) {
    let evidence: { candidates?: Array<{ segment: string; delta_pct: number }> } = {};
    try { evidence = JSON.parse(f.evidence_json); } catch { continue; }
    for (const c of evidence.candidates ?? []) {
      const mod = deltaToBidModifierPct(c.delta_pct);
      if (mod === null) continue;
      out.set((c.segment ?? '').toLowerCase(), mod);
    }
  }
  return out;
}

function collectGeoModifiers(findings: readonly { evidence_json: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of findings) {
    let evidence: { candidates?: Array<{ segment: string; delta_pct: number }> } = {};
    try { evidence = JSON.parse(f.evidence_json); } catch { continue; }
    for (const c of evidence.candidates ?? []) {
      const mod = deltaToBidModifierPct(c.delta_pct);
      if (mod === null) continue;
      const region = (c.segment ?? '').trim();
      if (region.length === 0 || region === 'unknown') continue;
      out.set(region, mod);
    }
  }
  return out;
}

function deviceModifierKey(device: string): string | null {
  switch (device) {
    case 'mobile': return 'mobile_bid_modifier_pct';
    case 'desktop': return 'desktop_bid_modifier_pct';
    case 'tablet': return 'tablet_bid_modifier_pct';
    case 'tv_screen':
    case 'connected_tv':
    case 'tv': return 'tv_bid_modifier_pct';
    default: return null;
  }
}

interface PlaceholderAsset {
  fieldType: 'HEADLINE' | 'LONG_HEADLINE' | 'DESCRIPTION';
  index: number;
  text: string;
}

const HEADLINE_TEMPLATES: ReadonlyArray<(theme: string) => string> = [
  t => capitalize(t),
  t => `${capitalize(t)} kaufen`,
  t => `${capitalize(t)} online`,
  t => `Schweizer ${capitalize(t)}`,
  t => `${capitalize(t)} entdecken`,
];

const LONG_HEADLINE_TEMPLATES: ReadonlyArray<(theme: string) => string> = [
  t => `Hochwertige ${capitalize(t)}-Produkte direkt aus der Schweiz bestellen`,
  t => `${capitalize(t)} entdecken — fair, nachhaltig, regional aus der Schweiz`,
  t => `Premium-${capitalize(t)} mit Schweizer Qualität: kuratierte Auswahl online`,
];

const DESCRIPTION_TEMPLATES: ReadonlyArray<(theme: string) => string> = [
  t => `Frische ${capitalize(t)}-Produkte direkt aus der Schweiz – fair und nachhaltig.`,
  t => `Hochwertig, nachhaltig, fair – ${capitalize(t)} online bestellen.`,
];

/** Build 5 headlines + 2 long headlines + 2 descriptions for a NEW
 *  theme-AG so the emit validator's content-completeness check passes
 *  and the Editor import is immediately usable. PMax requires:
 *    - ≥3 short headlines (≤30 chars)
 *    - ≥1 long headline   (≤90 chars)
 *    - ≥2 descriptions    (≤90 chars)
 *    - ≥1 1:1 image + ≥1 1.91:1 image (image assets are NOT generated
 *      by the optimizer — must be uploaded by the customer in the UI;
 *      that's why theme-AGs ship paused). Templates that exceed the
 *  caps after substitution are dropped; the validator catches the
 *  remaining gap if any. The agent is expected to refine these via
 *  ads_blueprint_entity_propose (LP-crawl + Brand-Voice) before final
 *  import. */
function generatePlaceholderAssets(themeToken: string): PlaceholderAsset[] {
  const t = (themeToken ?? '').trim();
  if (t.length === 0) return [];
  const out: PlaceholderAsset[] = [];
  let h = 1;
  for (const tpl of HEADLINE_TEMPLATES) {
    const text = tpl(t);
    if (text.length <= 30) {
      out.push({ fieldType: 'HEADLINE', index: h++, text });
      if (h > 5) break;
    }
  }
  let lh = 1;
  for (const tpl of LONG_HEADLINE_TEMPLATES) {
    const text = tpl(t);
    if (text.length <= 90) {
      out.push({ fieldType: 'LONG_HEADLINE', index: lh++, text });
      if (lh > 2) break;
    }
  }
  let d = 1;
  for (const tpl of DESCRIPTION_TEMPLATES) {
    const text = tpl(t);
    if (text.length <= 90) {
      out.push({ fieldType: 'DESCRIPTION', index: d++, text });
      if (d > 2) break;
    }
  }
  return out;
}

interface BrandSearchProposal {
  campaign: { name: string; targetCpa: number; budget: number };
  adGroups: ReadonlyArray<{ name: string; brandToken: string }>;
  keywords: ReadonlyArray<{ adGroupName: string; keyword: string; matchType: 'Phrase' | 'Exact' }>;
  /** RSA per ad-group — Editor blocks publish for an ad-group with zero
   *  ads ("Anzeigengruppe enthält keine aktivierten Anzeigen"). Final
   *  URL is picked per brand-token: a slug match wins, otherwise the
   *  top-clicks LP is used and a review marker fires so the operator
   *  can pin the correct brand-page before emit. */
  rsas: ReadonlyArray<{
    adGroupName: string; headlines: string[]; descriptions: string[];
    finalUrl: string;
    urlReview: BlueprintReviewItem | null;
  }>;
  crossChannelNegatives: ReadonlyArray<{
    keywordText: string; matchType: 'Phrase';
    scope: 'campaign'; scopeTarget: string;
  }>;
  rationale: string;
}

/** Read the brand-inflation finding produced by the audit and emit a
 *  Brand-Search campaign + per-brand ad_groups + Phrase/Exact keywords +
 *  cross-channel negatives that block the same brand tokens on every
 *  existing PMax campaign.
 *
 *  Output is paused-by-default through the standard NEW-entity path; the
 *  customer activates after editor-import. The rationale flags the launch
 *  ordering: PMax-block must go live AFTER Brand-Search to avoid a
 *  brand-traffic gap.
 */
function generateBrandSearchProposals(
  store: AdsDataStore, run: AdsAuditRunRow, customer: CustomerProfileRow,
): BrandSearchProposal | null {
  const findings = store.listFindings(run.run_id, { area: 'pmax_brand_inflation' });
  if (findings.length === 0) return null;
  const finding = findings[0]!;
  let evidence: {
    brand_tokens?: string[];
    suggested_defaults?: { dailyBudgetChf?: number; targetCpaChf?: number };
  } = {};
  try {
    evidence = JSON.parse(finding.evidence_json);
  } catch {
    return null;
  }
  const brandTokens = (evidence.brand_tokens ?? [])
    .map(t => (t ?? '').trim()).filter(t => t.length > 0);
  if (brandTokens.length === 0) return null;
  const defaults = evidence.suggested_defaults ?? {};
  const dailyBudget = typeof defaults.dailyBudgetChf === 'number' && defaults.dailyBudgetChf > 0
    ? defaults.dailyBudgetChf : 5;
  const targetCpa = typeof defaults.targetCpaChf === 'number' && defaults.targetCpaChf > 0
    ? defaults.targetCpaChf : 10;

  // Existing PMax campaigns to negative-block. Skip if no PMax exists
  // (no inflation source to neutralize).
  const pmaxCampaigns = store.getSnapshotRows<{ campaign_name: string | null; channel_type: string | null }>(
    'ads_campaigns', run.ads_account_id, { runId: run.run_id },
  )
    .filter(r => r.channel_type === 'PERFORMANCE_MAX' && r.campaign_name)
    .map(r => r.campaign_name!);

  // Mirror the customer's pipe-separator naming convention if their
  // existing campaigns use it. Aquanatura: "PMax | Wasserfilter" → match
  // with "Search | Brand". Falls back to "Search-Brand" otherwise.
  const usesPipeSeparator = pmaxCampaigns.some(n => / \| /.test(n));
  const campaignName = usesPipeSeparator ? 'Search | Brand' : 'Search-Brand';

  const adGroups = brandTokens.map(b => ({
    name: `Brand-${capitalize(b)}`,
    brandToken: b,
  }));

  const keywords = brandTokens.flatMap(b => {
    const ag = `Brand-${capitalize(b)}`;
    return [
      { adGroupName: ag, keyword: b, matchType: 'Phrase' as const },
      { adGroupName: ag, keyword: b, matchType: 'Exact' as const },
    ];
  });

  const crossChannelNegatives = pmaxCampaigns.flatMap(camp =>
    brandTokens.map(b => ({
      keywordText: b, matchType: 'Phrase' as const,
      scope: 'campaign' as const, scopeTarget: camp,
    })),
  );

  // Pick a per-brand final_url for the RSA: prefer an LP whose URL slug
  // contains the brand-token (Brand-Aquanatura → /aquanatura/* page); fall
  // back to the customer's top-clicked LP and emit a review marker so the
  // operator can confirm/replace the URL before emit. Falling back to the
  // company root for *every* Brand-AG silently buries the case where the
  // brand has its own LP — the review prompt forces an explicit decision.
  const lpRowsFull = store.getSnapshotRows<{
    landing_page_url: string | null; clicks: number | null; conversions: number | null;
  }>('ads_landing_pages', run.ads_account_id, { runId: run.run_id });
  const lpSummary = aggregateLpPerformance(lpRowsFull);
  const topLp = [...lpRowsFull]
    .filter(r => (r.landing_page_url ?? '').startsWith('http'))
    .sort((a, b) => (b.clicks ?? 0) - (a.clicks ?? 0))[0];
  const homepageFallback = topLp?.landing_page_url
    ?? `https://${(customer.client_name ?? '').toLowerCase().replace(/\s+/g, '')}.ch`;

  const rsas = adGroups.map(ag => {
    const brand = capitalize(ag.brandToken);
    const headlines = [
      brand,
      `${brand} kaufen`,
      `${brand} online`,
      `${brand} Schweiz`,
      `${brand} entdecken`,
      `Original ${brand}`,
    ].filter(h => h.length <= 30);
    const descriptions = [
      `Original ${brand} direkt vom Schweizer Anbieter — schnelle Lieferung, faire Preise.`,
      `Hochwertige ${brand}-Produkte: kuratierte Auswahl, persönlicher Kundenservice.`,
    ].filter(d => d.length <= 90);
    const { url, review } = pickFinalUrlForToken(ag.brandToken, lpSummary, 'brand');
    return {
      adGroupName: ag.name,
      headlines, descriptions,
      finalUrl: url ?? homepageFallback,
      urlReview: review,
    };
  });

  const customerSlug = customer.customer_id;
  const rationale =
    `Brand-Inflation-Auto-Propose (${customerSlug}): ${brandTokens.length} Brand(s) ` +
    `(${brandTokens.join(', ')}) bedient sich aktuell via PMax. ` +
    `Brand-Search-Campaign (Daily ${dailyBudget} CHF, Target CPA ${targetCpa} CHF) + ` +
    `${pmaxCampaigns.length} PMax-Brand-Block-Negatives. ` +
    `WICHTIG: PMax-Negatives erst NACH Brand-Search-Launch aktivieren — sonst gehen Brand-Klicks ` +
    `während dem Gap-Fenster verloren.`;

  return {
    campaign: { name: campaignName, targetCpa, budget: dailyBudget },
    adGroups, keywords, rsas, crossChannelNegatives, rationale,
  };
}

function parseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
