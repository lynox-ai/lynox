/**
 * PMAX Restructure Safeguards.
 *
 * Performance Max smart-bidding learns from each asset-group over a
 * rolling window. Splitting or merging an asset-group with substantial
 * conversion volume throws away weeks of learning, so the V1 contract
 * is: any SPLIT or MERGE proposal must clear three safeguards before
 * it can be emitted on the blueprint.
 *
 *  1. Confidence ≥ 0.9 — ambiguous proposals are deferred.
 *  2. Conversion-volume floor — asset-groups with ≥ 30 conversions
 *     in the last 30 days require BOTH the high confidence AND an
 *     explicit rationale (≥ 30 chars). Below the floor, the
 *     learning-data risk is low enough to permit splits more freely.
 *  3. Smart-bidding guard — no major restructure within 14 days of the
 *     last major Editor import (`ads_accounts.last_major_import_at`).
 *
 * The function never mutates state — it returns an evaluation that
 * the orchestrator inspects to decide whether the proposal lands as a
 * SPLIT/MERGE blueprint entity or as a `pmax_safeguard_blocked`
 * finding instead.
 *
 * Plus a helper to list asset-groups that should be flagged for
 * additive attention (low ad strength) without triggering
 * restructure logic.
 */
import type {
  AdsAccountRow,
  AdsDataStore,
  AdsAuditRunRow,
} from './ads-data-store.js';

export type RestructureKind = 'SPLIT' | 'MERGE';

export interface RestructureProposal {
  kind: RestructureKind;
  /** Source asset-groups: 1 entry for SPLIT, ≥ 2 for MERGE. */
  sourceExternalIds: readonly string[];
  /** New asset-group external ids the operation would create. */
  proposedExternalIds: readonly string[];
  confidence: number;
  rationale: string;
}

export interface AssetGroupVolumeInput {
  externalId: string;
  /** Conversions accumulated in the relevant 30-day window. */
  conversions30d: number;
  name?: string | undefined;
}

export interface RestructureSafeguardEvaluation {
  allowed: boolean;
  blockedReasons: string[];
  checks: {
    confidenceOk: boolean;
    convFloorOk: boolean;
    smartBiddingGuardOk: boolean;
    explicitRationaleOk: boolean;
    sourceShapeOk: boolean;
  };
}

export interface EvaluateRestructureOptions {
  now?: Date | undefined;
  /** Conversion-floor under which lower confidence is accepted. Default 30. */
  convFloor?: number | undefined;
  /** Min days since last_major_import_at to allow restructure. Default 14. */
  smartBiddingGuardDays?: number | undefined;
}

const DEFAULT_CONV_FLOOR = 30;
const DEFAULT_GUARD_DAYS = 14;
const HIGH_CONFIDENCE = 0.9;
const MIN_RATIONALE_CHARS = 30;

/**
 * Evaluate a restructure proposal against the three safeguards.
 *
 * `sourceVolumes` should contain at least one entry per externalId in
 * `proposal.sourceExternalIds`; missing entries are treated as zero
 * (which is the safest default — a SPLIT on an unknown asset-group
 * still trips the rationale and confidence checks).
 */
export function evaluateRestructureSafeguards(
  proposal: RestructureProposal,
  sourceVolumes: readonly AssetGroupVolumeInput[],
  account: AdsAccountRow,
  options?: EvaluateRestructureOptions | undefined,
): RestructureSafeguardEvaluation {
  const now = options?.now ?? new Date();
  const convFloor = options?.convFloor ?? DEFAULT_CONV_FLOOR;
  const guardDays = options?.smartBiddingGuardDays ?? DEFAULT_GUARD_DAYS;

  const blockedReasons: string[] = [];

  // Source shape ─────────────────────────────────────────────────────
  const sourceShapeOk = (() => {
    if (proposal.kind === 'SPLIT') {
      if (proposal.sourceExternalIds.length !== 1) {
        blockedReasons.push('SPLIT erwartet genau 1 Quell-Asset-Group.');
        return false;
      }
      if (proposal.proposedExternalIds.length < 2) {
        blockedReasons.push('SPLIT erwartet ≥ 2 neue Asset-Group-IDs.');
        return false;
      }
    } else {
      if (proposal.sourceExternalIds.length < 2) {
        blockedReasons.push('MERGE erwartet ≥ 2 Quell-Asset-Groups.');
        return false;
      }
      if (proposal.proposedExternalIds.length !== 1) {
        blockedReasons.push('MERGE erwartet genau 1 neue Asset-Group-ID.');
        return false;
      }
    }
    return true;
  })();

  // Confidence ───────────────────────────────────────────────────────
  const confidenceOk = proposal.confidence >= HIGH_CONFIDENCE;
  if (!confidenceOk) {
    blockedReasons.push(
      `Confidence ${proposal.confidence.toFixed(2)} < ${HIGH_CONFIDENCE} — ` +
      `Restructure nur mit hoher Sicherheit.`,
    );
  }

  // Explicit rationale ───────────────────────────────────────────────
  const explicitRationaleOk = (proposal.rationale ?? '').trim().length >= MIN_RATIONALE_CHARS;
  if (!explicitRationaleOk) {
    blockedReasons.push(
      `Begründung zu kurz (< ${MIN_RATIONALE_CHARS} Zeichen) — ` +
      `Restructure braucht klar dokumentierten Grund.`,
    );
  }

  // Conv-floor ───────────────────────────────────────────────────────
  const volumeMap = new Map<string, number>();
  for (const v of sourceVolumes) volumeMap.set(v.externalId, v.conversions30d);
  const aboveFloor = proposal.sourceExternalIds.some(id => (volumeMap.get(id) ?? 0) >= convFloor);
  // Above floor → both confidence and rationale required (already checked).
  // Below floor → allowed without high confidence requirement on conv-floor itself.
  // We model this by saying "convFloorOk" is true when either side of the disjunct is met.
  const convFloorOk = !aboveFloor || (confidenceOk && explicitRationaleOk);
  if (aboveFloor && !convFloorOk) {
    const offending = proposal.sourceExternalIds
      .filter(id => (volumeMap.get(id) ?? 0) >= convFloor)
      .map(id => `${id} (${volumeMap.get(id) ?? 0} conv/30d)`);
    blockedReasons.push(
      `Asset-Group(s) ≥ ${convFloor} conv/30d — Lerndaten-Risiko, ` +
      `Restructure nur mit confidence ≥ ${HIGH_CONFIDENCE} + ausführlicher Begründung: ${offending.join(', ')}.`,
    );
  }

  // Smart-bidding guard ──────────────────────────────────────────────
  const smartBiddingGuardOk = (() => {
    if (!account.last_major_import_at) return true; // no prior import → no guard
    const lastImport = new Date(account.last_major_import_at);
    if (Number.isNaN(lastImport.getTime())) return true;
    const ageDays = (now.getTime() - lastImport.getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays < guardDays) {
      blockedReasons.push(
        `Letzter Import war vor ${ageDays.toFixed(1)} Tagen — Smart-Bidding-Lernfenster ` +
        `(${guardDays}d) noch aktiv, kein Major-Restructure.`,
      );
      return false;
    }
    return true;
  })();

  return {
    allowed: blockedReasons.length === 0,
    blockedReasons,
    checks: {
      confidenceOk, convFloorOk, smartBiddingGuardOk,
      explicitRationaleOk, sourceShapeOk,
    },
  };
}

/**
 * Identify asset-groups with low ad strength so the orchestrator can
 * surface them as additive-attention recommendations. Pure read.
 */
export interface LowStrengthAssetGroup {
  externalId: string;
  name: string;
  campaignName: string | null;
  adStrength: string;
  conversions: number;
  spendChf: number;
}

export function findLowStrengthAssetGroups(
  store: AdsDataStore, run: AdsAuditRunRow,
): LowStrengthAssetGroup[] {
  const rows = store.getSnapshotRows<{
    asset_group_id: string; asset_group_name: string;
    campaign_name: string | null; ad_strength: string | null;
    conversions: number | null; cost_micros: number | null;
  }>('ads_asset_groups', run.ads_account_id, { runId: run.run_id });

  const flagged: LowStrengthAssetGroup[] = [];
  for (const r of rows) {
    const strength = (r.ad_strength ?? '').toUpperCase();
    if (strength !== 'POOR' && strength !== 'AVERAGE') continue;
    flagged.push({
      externalId: r.asset_group_id,
      name: r.asset_group_name,
      campaignName: r.campaign_name,
      adStrength: strength,
      conversions: r.conversions ?? 0,
      spendChf: (r.cost_micros ?? 0) / 1_000_000,
    });
  }
  flagged.sort((a, b) => b.spendChf - a.spendChf);
  return flagged;
}
