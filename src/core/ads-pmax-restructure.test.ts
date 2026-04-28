import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from './ads-data-store.js';
import {
  evaluateRestructureSafeguards,
  findLowStrengthAssetGroups,
} from './ads-pmax-restructure.js';
import type { RestructureProposal } from './ads-pmax-restructure.js';
import type { AdsAccountRow } from './ads-data-store.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';

const baseAccount = (lastImportIso: string | null = null): AdsAccountRow => ({
  ads_account_id: ACCOUNT,
  customer_id: CUSTOMER,
  account_label: 'Main',
  currency_code: 'CHF',
  timezone: 'Europe/Zurich',
  mode: 'OPTIMIZE',
  drive_folder_id: null,
  last_major_import_at: lastImportIso,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const splitProposal = (overrides?: Partial<RestructureProposal>): RestructureProposal => ({
  kind: 'SPLIT',
  sourceExternalIds: ['ag-1'],
  proposedExternalIds: ['ag-1a', 'ag-1b'],
  confidence: 0.92,
  rationale: 'GA4 zeigt zwei distinkte Conversion-Pfade auf separat thematisierten LP-Gruppen — sauberer Split.',
  ...overrides,
});

const mergeProposal = (overrides?: Partial<RestructureProposal>): RestructureProposal => ({
  kind: 'MERGE',
  sourceExternalIds: ['ag-2', 'ag-3'],
  proposedExternalIds: ['ag-merged'],
  confidence: 0.93,
  rationale: 'Beide Gruppen teilen >80% Asset-Overlap und identisches Audience-Profil — Merge konsolidiert.',
  ...overrides,
});

describe('evaluateRestructureSafeguards', () => {
  it('allows SPLIT below conv-floor with all checks passing', () => {
    const r = evaluateRestructureSafeguards(
      splitProposal(),
      [{ externalId: 'ag-1', conversions30d: 12 }],
      baseAccount(),
    );
    expect(r.allowed).toBe(true);
    expect(r.blockedReasons).toEqual([]);
    expect(r.checks.confidenceOk).toBe(true);
    expect(r.checks.convFloorOk).toBe(true);
    expect(r.checks.smartBiddingGuardOk).toBe(true);
  });

  it('allows SPLIT above conv-floor when high confidence + rationale', () => {
    const r = evaluateRestructureSafeguards(
      splitProposal({ confidence: 0.95 }),
      [{ externalId: 'ag-1', conversions30d: 50 }],
      baseAccount(),
    );
    expect(r.allowed).toBe(true);
  });

  it('blocks SPLIT above conv-floor when confidence < 0.9', () => {
    // Above-floor proposals inherit the strict confidence gate;
    // below-floor proposals do NOT (see test below).
    const r = evaluateRestructureSafeguards(
      splitProposal({ confidence: 0.85 }),
      [{ externalId: 'ag-1', conversions30d: 50 }],
      baseAccount(),
    );
    expect(r.allowed).toBe(false);
    expect(r.checks.confidenceOk).toBe(false);
    expect(r.blockedReasons.join('\n')).toMatch(/Confidence/);
  });

  it('allows SPLIT below conv-floor even with low confidence and short rationale', () => {
    // The Sprint plan permits below-floor splits without the strict
    // confidence/rationale gates; learning data at risk is minimal,
    // and the source-shape + smart-bidding-guard checks still apply.
    const r = evaluateRestructureSafeguards(
      splitProposal({ confidence: 0.5, rationale: 'try it' }),
      [{ externalId: 'ag-1', conversions30d: 5 }],
      baseAccount(),
    );
    expect(r.allowed).toBe(true);
    expect(r.checks.confidenceOk).toBe(true);
    expect(r.checks.explicitRationaleOk).toBe(true);
    expect(r.checks.convFloorOk).toBe(true);
  });

  it('blocks SPLIT above conv-floor with too-short rationale', () => {
    const r = evaluateRestructureSafeguards(
      splitProposal({ rationale: 'split it' }),
      [{ externalId: 'ag-1', conversions30d: 50 }],
      baseAccount(),
    );
    expect(r.allowed).toBe(false);
    expect(r.checks.explicitRationaleOk).toBe(false);
  });

  it('blocks SPLIT when last import < 14 days ago', () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const r = evaluateRestructureSafeguards(
      splitProposal(),
      [{ externalId: 'ag-1', conversions30d: 5 }],
      baseAccount(recent),
    );
    expect(r.allowed).toBe(false);
    expect(r.checks.smartBiddingGuardOk).toBe(false);
    expect(r.blockedReasons.join('\n')).toMatch(/Smart-Bidding-Lernfenster/);
  });

  it('allows SPLIT after 14 days since last import', () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const r = evaluateRestructureSafeguards(
      splitProposal(),
      [{ externalId: 'ag-1', conversions30d: 5 }],
      baseAccount(old),
    );
    expect(r.allowed).toBe(true);
  });

  it('rejects malformed SPLIT shape (≥1 source / 1 proposed)', () => {
    const r = evaluateRestructureSafeguards(
      splitProposal({ sourceExternalIds: ['ag-1', 'ag-2'] }),
      [],
      baseAccount(),
    );
    expect(r.allowed).toBe(false);
    expect(r.checks.sourceShapeOk).toBe(false);
  });

  it('allows MERGE with proper shape', () => {
    const r = evaluateRestructureSafeguards(
      mergeProposal(),
      [
        { externalId: 'ag-2', conversions30d: 5 },
        { externalId: 'ag-3', conversions30d: 8 },
      ],
      baseAccount(),
    );
    expect(r.allowed).toBe(true);
  });

  it('rejects MERGE with only 1 source', () => {
    const r = evaluateRestructureSafeguards(
      mergeProposal({ sourceExternalIds: ['ag-2'] }),
      [],
      baseAccount(),
    );
    expect(r.allowed).toBe(false);
    expect(r.checks.sourceShapeOk).toBe(false);
  });

  it('treats unknown source ids as zero conversions (safe default)', () => {
    const r = evaluateRestructureSafeguards(
      splitProposal({ sourceExternalIds: ['ag-unknown'] }),
      [], // no volume info at all
      baseAccount(),
    );
    expect(r.checks.convFloorOk).toBe(true); // 0 conv ≤ floor → permitted
  });

  it('honors custom convFloor / smartBiddingGuardDays overrides', () => {
    // Setting a tighter conv-floor of 3 — proposal source has 5 conv → above floor.
    const tight = evaluateRestructureSafeguards(
      splitProposal({ confidence: 0.85 }),
      [{ externalId: 'ag-1', conversions30d: 5 }],
      baseAccount(),
      { convFloor: 3 },
    );
    expect(tight.checks.convFloorOk).toBe(false);
    expect(tight.allowed).toBe(false);
  });
});

describe('findLowStrengthAssetGroups', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let runId: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-pmax-test-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    store.upsertCustomerProfile({ customerId: CUSTOMER, clientName: 'Acme' });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'OPTIMIZE' });
    store.completeAuditRun(r.run_id);
    runId = r.run_id;
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns POOR/AVERAGE asset-groups sorted by spend desc', () => {
    store.insertAssetGroupsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [
        { assetGroupId: 'ag1', assetGroupName: 'Strong Group', campaignName: 'PMAX-A', adStrength: 'EXCELLENT', costMicros: 100_000_000 },
        { assetGroupId: 'ag2', assetGroupName: 'Average Group', campaignName: 'PMAX-A', adStrength: 'AVERAGE', costMicros: 50_000_000, conversions: 12 },
        { assetGroupId: 'ag3', assetGroupName: 'Poor Group', campaignName: 'PMAX-B', adStrength: 'POOR', costMicros: 80_000_000, conversions: 3 },
      ],
    });
    const run = store.getAuditRun(runId)!;
    const lows = findLowStrengthAssetGroups(store, run);
    expect(lows).toHaveLength(2);
    expect(lows[0]?.externalId).toBe('ag3'); // higher spend first
    expect(lows[0]?.adStrength).toBe('POOR');
    expect(lows[1]?.externalId).toBe('ag2');
    expect(lows[1]?.adStrength).toBe('AVERAGE');
  });

  it('returns empty array when all asset-groups are healthy', () => {
    store.insertAssetGroupsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [
        { assetGroupId: 'ag1', assetGroupName: 'Excellent Group', adStrength: 'EXCELLENT' },
        { assetGroupId: 'ag2', assetGroupName: 'Good Group', adStrength: 'GOOD' },
      ],
    });
    const run = store.getAuditRun(runId)!;
    expect(findLowStrengthAssetGroups(store, run)).toEqual([]);
  });

  it('handles missing ad_strength gracefully', () => {
    store.insertAssetGroupsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [{ assetGroupId: 'ag1', assetGroupName: 'No Strength' }],
    });
    const run = store.getAuditRun(runId)!;
    expect(findLowStrengthAssetGroups(store, run)).toEqual([]);
  });
});
