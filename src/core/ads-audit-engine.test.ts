import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from './ads-data-store.js';
import { runAudit, runAuditAndPersist, AuditPreconditionError } from './ads-audit-engine.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';

describe('runAudit', () => {
  let tempDir: string;
  let store: AdsDataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-audit-test-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('throws AuditPreconditionError when account is unknown', () => {
    expect(() => runAudit(store, 'unknown-account')).toThrow(AuditPreconditionError);
  });

  it('throws AuditPreconditionError when no successful run exists', () => {
    seedAccount(store);
    store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    expect(() => runAudit(store, ACCOUNT)).toThrow(AuditPreconditionError);
  });

  it('detects BOOTSTRAP mode for first successful run', () => {
    seedAccount(store);
    const run = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, run.run_id, 5);

    const result = runAudit(store, ACCOUNT);
    expect(result.mode.detected).toBe('BOOTSTRAP');
    expect(result.mode.recordedRunMode).toBe('BOOTSTRAP');
    expect(result.previousRun).toBeNull();
    const mismatch = result.findings.find(f => f.area === 'mode_mismatch');
    expect(mismatch).toBeUndefined();
  });

  it('flags mode mismatch when run is OPTIMIZE but data is too thin', () => {
    seedAccount(store);
    const r1 = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r1.run_id, 5);

    const r2 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id });
    store.completeAuditRun(r2.run_id);
    seedThinSnapshot(store, r2.run_id, 10);

    const result = runAudit(store, ACCOUNT);
    expect(result.mode.recordedRunMode).toBe('OPTIMIZE');
    expect(result.mode.detected).toBe('BOOTSTRAP');
    const mismatch = result.findings.find(f => f.area === 'mode_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch?.severity).toBe('MEDIUM');
  });

  it('detects OPTIMIZE mode when previous run + ≥30 days data + import ≥14d ago', () => {
    seedAccount(store);
    const r1 = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r1.run_id, 30);

    const r2 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id });
    store.completeAuditRun(r2.run_id);
    seedThinSnapshot(store, r2.run_id, 35);

    // Mark a major import 20 days ago — clears the smart-bidding window.
    const importIso = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    store.recordMajorImport(ACCOUNT, importIso);

    const result = runAudit(store, ACCOUNT);
    expect(result.mode.detected).toBe('OPTIMIZE');
    expect(result.mode.performanceDays).toBe(35);
  });

  it('detects FIRST_IMPORT mode when prior run exists but no import yet', () => {
    seedAccount(store);
    const r1 = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r1.run_id, 30);

    const r2 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id });
    store.completeAuditRun(r2.run_id);
    seedThinSnapshot(store, r2.run_id, 35);

    const result = runAudit(store, ACCOUNT);
    expect(result.mode.detected).toBe('FIRST_IMPORT');
    expect(result.verification).toBeNull();
  });

  it('detects FIRST_IMPORT mode when import is younger than the smart-bidding window', () => {
    seedAccount(store);
    const r1 = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r1.run_id, 30);
    const r2 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id });
    store.completeAuditRun(r2.run_id);
    seedThinSnapshot(store, r2.run_id, 35);

    // Import 5 days ago — still in smart-bidding learning window.
    const importIso = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    store.recordMajorImport(ACCOUNT, importIso);

    const result = runAudit(store, ACCOUNT);
    expect(result.mode.detected).toBe('FIRST_IMPORT');
    expect(result.verification).toBeNull();
  });

  it('flags stale data when GAS export is older than 7 days', () => {
    seedAccount(store);
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP', gasExportLastrun: oldDate });
    store.completeAuditRun(r.run_id);
    seedThinSnapshot(store, r.run_id, 5);

    const result = runAudit(store, ACCOUNT);
    const stale = result.findings.find(f => f.area === 'stale_data');
    expect(stale).toBeDefined();
    expect(stale?.severity).toBe('MEDIUM');
  });

  it('flags missing customer profile as HIGH', () => {
    seedAccount(store, { withProfile: false });
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);

    const result = runAudit(store, ACCOUNT);
    const missing = result.findings.find(f => f.area === 'customer_profile_missing');
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe('HIGH');
  });

  it('flags no-conversion-tracking when clicks > 100 and 0 conversions', () => {
    seedAccount(store);
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    store.insertCampaignsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{
        campaignId: 'c1', campaignName: 'Search Brand',
        clicks: 500, impressions: 5000, conversions: 0, costMicros: 50_000_000,
        convValue: 0,
      }],
    });

    const result = runAudit(store, ACCOUNT);
    const noTracking = result.findings.find(f => f.area === 'no_conversion_tracking');
    expect(noTracking).toBeDefined();
    expect(noTracking?.severity).toBe('HIGH');
  });

  it('returns null verification for first cycle (no previous run)', () => {
    seedAccount(store);
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 30);

    const result = runAudit(store, ACCOUNT);
    expect(result.verification).toBeNull();
    expect(result.manualChanges).toBeNull();
  });

  it('runs Wilson-score verification for cycle 2 with goal-aware KPI', () => {
    seedAccount(store, { primaryGoal: 'roas' });
    const r1 = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    store.insertCampaignsBatch({
      runId: r1.run_id, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'c1', campaignName: 'Search Brand', clicks: 1500, conversions: 150 }],
    });
    store.insertRunDecision({
      runId: r1.run_id, entityType: 'campaign', entityExternalId: 'c1',
      decision: 'KEEP', confidence: 0.9, rationale: 'Stable performer',
    });

    setLastImport(store, '2026-02-15T00:00:00Z');

    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    // Seed both pre and post windows on r2 — verifyPerformance reads
    // both from the current run's snapshot (GAS DATE_RANGE=LAST_90_DAYS
    // gives the runway). 0.10 conv-rate before (5 conv per 50 clicks)
    // → 0.50 after (25 conv per 50 clicks) ⇒ ERFOLG.
    seedDailyPerformance(store, r2.run_id, 'c1', '2026-01-18', 28, { dailyClicks: 50, dailyConv: 5 });
    seedDailyPerformance(store, r2.run_id, 'c1', '2026-02-16', 28, { dailyClicks: 50, dailyConv: 25 });
    store.insertCampaignsBatch({
      runId: r2.run_id, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'c1', campaignName: 'Search Brand', clicks: 1400, conversions: 700 }],
    });

    const result = runAudit(store, ACCOUNT);
    expect(result.verification).not.toBeNull();
    expect(result.verification?.skipped).toBe(false);
    expect(result.verification?.kind).toBe('roas');
    expect(result.verification?.items.length).toBe(1);
    expect(result.verification?.items[0]?.classification).toBe('ERFOLG');
  });

  it('uses CPA-direction for cpa-goal customer', () => {
    seedAccount(store, { primaryGoal: 'cpa' });
    const r1 = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    setLastImport(store, '2026-02-15T00:00:00Z');
    store.insertRunDecision({
      runId: r1.run_id, entityType: 'campaign', entityExternalId: 'c1',
      decision: 'NEW', confidence: 0.8, rationale: 'New campaign',
    });
    store.insertCampaignsBatch({
      runId: r1.run_id, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'c1', campaignName: 'Lead Gen', clicks: 500, conversions: 30 }],
    });

    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    store.insertCampaignsBatch({
      runId: r2.run_id, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'c1', campaignName: 'Lead Gen', clicks: 500, conversions: 30 }],
    });
    // Both windows live on the current run's snapshot.
    seedDailyPerformance(store, r2.run_id, 'c1', '2026-01-19', 28, { dailyClicks: 20, dailyConv: 1 });
    seedDailyPerformance(store, r2.run_id, 'c1', '2026-02-16', 28, { dailyClicks: 20, dailyConv: 1 });

    const result = runAudit(store, ACCOUNT);
    expect(result.verification?.kind).toBe('cpa');
  });

  it('flags campaign that misses its ROAS target by >20%', () => {
    seedAccount(store, { primaryGoal: 'roas' });
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    store.insertCampaignsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{
        campaignId: 'c1', campaignName: 'PMAX-Underperformer',
        channelType: 'PERFORMANCE_MAX',
        biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE',
        targetRoas: 4.0,
        clicks: 1000, costMicros: 100_000_000, conversions: 30, convValue: 150, // 1.5x vs 4x → 0.375 ratio
      }],
    });
    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'campaign_target_underperformance_roas');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('HIGH'); // 200 / 100 = 2x vs target 4x = 0.5 ratio
    expect(finding?.text).toMatch(/Underperformer/);
  });

  it('flags campaign that exceeds its CPA target by >20%', () => {
    seedAccount(store, { primaryGoal: 'cpa' });
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    store.insertCampaignsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{
        campaignId: 'c2', campaignName: 'Search-Leads-Overpaying',
        channelType: 'SEARCH',
        biddingStrategyType: 'TARGET_CPA',
        targetCpaMicros: 50_000_000, // 50 CHF target
        clicks: 500, costMicros: 100_000_000, conversions: 1, // 100 CHF / conv → 2x target
      }],
    });
    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'campaign_target_underperformance_cpa');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('HIGH');
    expect(finding?.text).toMatch(/Overpaying/);
  });

  it('does not flag a campaign that is meeting its target', () => {
    seedAccount(store);
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    store.insertCampaignsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{
        campaignId: 'c3', campaignName: 'On-Target-PMAX',
        channelType: 'PERFORMANCE_MAX',
        biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE',
        targetRoas: 3.0,
        clicks: 1000, costMicros: 100_000_000, conversions: 50, convValue: 320, // 3.2x ROAS
      }],
    });
    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'campaign_target_underperformance_roas');
    expect(finding).toBeUndefined();
  });

  it('caps view-through conversions at clicks before Wilson — does not throw on conv > clicks', () => {
    // Google Ads conversions can exceed clicks (view-through, cross-device).
    // wilsonScoreInterval throws on `successes > trials`, so the audit must
    // cap at clicks before scoring.
    seedAccount(store, { primaryGoal: 'roas' });
    const r1 = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    store.insertCampaignsBatch({
      runId: r1.run_id, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'c1', campaignName: 'View-Through-Heavy', clicks: 500, conversions: 600 }],
    });
    store.insertRunDecision({
      runId: r1.run_id, entityType: 'campaign', entityExternalId: 'c1',
      decision: 'KEEP', confidence: 0.9, rationale: 'Stable view-through performer',
    });
    setLastImport(store, '2026-02-15T00:00:00Z');

    const r2 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id });
    store.completeAuditRun(r2.run_id);
    store.insertCampaignsBatch({
      runId: r2.run_id, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'c1', campaignName: 'View-Through-Heavy', clicks: 500, conversions: 700 }],
    });
    // Pre and post window with conversions > clicks (50 clicks / day, 60 conv / day).
    seedDailyPerformance(store, r2.run_id, 'c1', '2026-01-18', 28, { dailyClicks: 50, dailyConv: 60 });
    seedDailyPerformance(store, r2.run_id, 'c1', '2026-02-16', 28, { dailyClicks: 50, dailyConv: 70 });

    expect(() => runAudit(store, ACCOUNT)).not.toThrow();
    const result = runAudit(store, ACCOUNT);
    const item = result.verification?.items[0];
    expect(item).toBeDefined();
    // After capping, both windows have successes = clicks = 1400, so the CIs
    // overlap and the classification is NEUTRAL — the important assertion is
    // that the audit did not throw.
    expect(item?.prevWindow.successes).toBeLessThanOrEqual(item?.prevWindow.trials ?? Infinity);
    expect(item?.currWindow.successes).toBeLessThanOrEqual(item?.currWindow.trials ?? Infinity);
  });

  it('persists deterministic findings to ads_findings', () => {
    seedAccount(store, { withProfile: false });
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);

    const result = runAuditAndPersist(store, ACCOUNT);
    expect(result.persistedFindingIds.length).toBe(result.findings.length);
    expect(result.findings.length).toBeGreaterThan(0);

    const stored = store.listFindings(r.run_id);
    expect(stored.length).toBe(result.persistedFindingIds.length);
    for (const row of stored) {
      expect(row.source).toBe('deterministic');
      expect(row.run_id).toBe(r.run_id);
    }
  });
});

describe('runAudit — P1 hybrid detectors', () => {
  let tempDir: string;
  let store: AdsDataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-audit-p1-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('Tier-1: irrelevant_search_term_spend collects per-term wasted candidates ordered by spend', () => {
    seedAccount(store);
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    // Three search terms: one wastes a lot (top candidate), one a little
    // (still over threshold), one too small to surface.
    store.insertSearchTermsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { searchTerm: 'kaffeemaschine entkalken', campaignName: 'Search Brand',
          adGroupName: 'AG-A', clicks: 30, costMicros: 80_000_000, conversions: 0 },
        { searchTerm: 'duschkopf reinigen', campaignName: 'Search Brand',
          adGroupName: 'AG-A', clicks: 12, costMicros: 25_000_000, conversions: 0 },
        { searchTerm: 'wasserhahn', campaignName: 'Search Brand',
          adGroupName: 'AG-A', clicks: 2, costMicros: 1_000_000, conversions: 0 },
      ],
    });

    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'irrelevant_search_term_spend');
    expect(finding).toBeDefined();
    const candidates = (finding!.evidence as { candidates: Array<{ term: string; spend_chf: number }> }).candidates;
    // Two surviving (above min spend + min clicks); ordered by spend desc.
    expect(candidates.map(c => c.term)).toEqual(['kaffeemaschine entkalken', 'duschkopf reinigen']);
    expect(candidates[0]!.spend_chf).toBeCloseTo(80, 1);
    // Tier-1 candidates ship without classification; Tier-2 fills it in.
    expect((candidates[0] as { classification?: string }).classification).toBeUndefined();
  });

  it('Tier-1: irrelevant_search_term_spend skips terms that already converted', () => {
    seedAccount(store);
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    store.insertSearchTermsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        // Spend 50 CHF but produced 2 conversions — not waste.
        { searchTerm: 'wasserfilter test', campaignName: 'Search Brand',
          adGroupName: 'AG-A', clicks: 20, costMicros: 50_000_000, conversions: 2 },
      ],
    });
    const result = runAudit(store, ACCOUNT);
    expect(result.findings.find(f => f.area === 'irrelevant_search_term_spend')).toBeUndefined();
  });

  it('Tier-1: quality_score_collapse groups < QS-4 keywords by ad-group with sample', () => {
    seedAccount(store);
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    store.insertKeywordsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { keyword: 'bad-kw-1', campaignName: 'Search Brand', adGroupName: 'AG-Bad',
          matchType: 'EXACT', qualityScore: 2, costMicros: 8_000_000, clicks: 30 },
        { keyword: 'bad-kw-2', campaignName: 'Search Brand', adGroupName: 'AG-Bad',
          matchType: 'EXACT', qualityScore: 3, costMicros: 7_000_000, clicks: 20 },
        // Healthy QS keyword — must NOT contribute to the collapse group.
        { keyword: 'good-kw', campaignName: 'Search Brand', adGroupName: 'AG-Bad',
          matchType: 'EXACT', qualityScore: 8, costMicros: 50_000_000, clicks: 100 },
        // Different ad-group with low spend — filtered by spend threshold.
        { keyword: 'low-spend-kw', campaignName: 'Search Brand', adGroupName: 'AG-Cheap',
          matchType: 'EXACT', qualityScore: 2, costMicros: 1_000_000, clicks: 1 },
      ],
    });

    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'quality_score_collapse');
    expect(finding).toBeDefined();
    const candidates = (finding!.evidence as {
      candidates: Array<{ ad_group_name: string; keyword_count: number; spend_chf: number; sample: unknown[] }>;
    }).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.ad_group_name).toBe('AG-Bad');
    expect(candidates[0]!.keyword_count).toBe(2);
    expect(candidates[0]!.spend_chf).toBeCloseTo(15, 1);
  });

  it('Tier-1: audience_signal_thin flags asset_groups with < 3 signal types', () => {
    seedAccount(store);
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    store.insertAssetGroupsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { assetGroupId: 'ag-zero', assetGroupName: 'AG-Zero', campaignName: 'PMax-Brand' },
        { assetGroupId: 'ag-one',  assetGroupName: 'AG-One',  campaignName: 'PMax-Brand' },
        { assetGroupId: 'ag-full', assetGroupName: 'AG-Full', campaignName: 'PMax-Brand' },
      ],
    });
    store.insertAudienceSignalsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        // AG-Zero: no signals at all (left anti-join must surface it).
        // AG-One: a single signal type.
        { assetGroupName: 'AG-One', signalType: 'CUSTOM_SEGMENT', campaignName: 'PMax-Brand' },
        // AG-Full: three distinct types — passes the minimum.
        { assetGroupName: 'AG-Full', signalType: 'CUSTOM_SEGMENT', campaignName: 'PMax-Brand' },
        { assetGroupName: 'AG-Full', signalType: 'USER_LIST',      campaignName: 'PMax-Brand' },
        { assetGroupName: 'AG-Full', signalType: 'DEMOGRAPHICS',   campaignName: 'PMax-Brand' },
      ],
    });

    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'audience_signal_thin');
    expect(finding).toBeDefined();
    const candidates = (finding!.evidence as { candidates: Array<{ asset_group_name: string; signal_count: number }> }).candidates;
    // Two flagged: AG-Zero (0 signals, sorted first) + AG-One (1 signal).
    // AG-Full with 3 types must NOT appear.
    expect(candidates.map(c => c.asset_group_name)).toEqual(['AG-Zero', 'AG-One']);
    expect(candidates[0]!.signal_count).toBe(0);
    // Severity is HIGH because at least one AG has zero signals.
    expect(finding!.severity).toBe('HIGH');
  });

  it('Tier-1: disabled_converting_keyword surfaces paused/removed keywords with conversions', () => {
    seedAccount(store);
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    store.insertKeywordsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        // Paused keyword that converted: must surface, sorted first by conv_value.
        { keyword: 'wasserfilter test', campaignName: 'Search', adGroupName: 'AG-A',
          matchType: 'EXACT', status: 'PAUSED', conversions: 8, convValue: 320, costMicros: 50_000_000 },
        // Removed keyword that converted: also surfaces.
        { keyword: 'kefir set', campaignName: 'Search', adGroupName: 'AG-A',
          matchType: 'EXACT', status: 'REMOVED', conversions: 3, convValue: 90, costMicros: 20_000_000 },
        // Paused but never converted: NOT a finding (no lost opportunity).
        { keyword: 'random kw', campaignName: 'Search', adGroupName: 'AG-A',
          matchType: 'EXACT', status: 'PAUSED', conversions: 0, convValue: 0, costMicros: 5_000_000 },
        // Enabled with conversions: NOT a finding (currently working).
        { keyword: 'kombucha', campaignName: 'Search', adGroupName: 'AG-A',
          matchType: 'EXACT', status: 'ENABLED', conversions: 4, convValue: 160, costMicros: 30_000_000 },
      ],
    });

    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'disabled_converting_keyword');
    expect(finding).toBeDefined();
    const candidates = (finding!.evidence as { candidates: Array<{ keyword: string; status: string; conversions: number }> }).candidates;
    expect(candidates.map(c => c.keyword)).toEqual(['wasserfilter test', 'kefir set']);
    expect(candidates[0]!.status).toBe('PAUSED');
    expect(candidates[0]!.conversions).toBeCloseTo(8, 1);
    // Total conversions > 5 → severity HIGH.
    expect(finding!.severity).toBe('HIGH');
  });

  it('Tier-1: competitor_term_bidding surfaces search terms matching customer.competitors', () => {
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme Shop',
      competitors: ['brita', 'soulbottle'],
    });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    store.insertSearchTermsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        // Matches "brita" — surfaces.
        { searchTerm: 'brita filter test', campaignName: 'PMax', adGroupName: null,
          clicks: 18, costMicros: 25_000_000, conversions: 0 },
        // Matches "soulbottle" — surfaces.
        { searchTerm: 'soulbottle alternative', campaignName: 'PMax', adGroupName: null,
          clicks: 8, costMicros: 12_000_000, conversions: 1 },
        // No competitor match — does NOT surface.
        { searchTerm: 'wasserfilter', campaignName: 'PMax', adGroupName: null,
          clicks: 50, costMicros: 100_000_000, conversions: 5 },
        // Below click threshold — filtered out.
        { searchTerm: 'brita junior', campaignName: 'PMax', adGroupName: null,
          clicks: 1, costMicros: 1_000_000, conversions: 0 },
      ],
    });

    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'competitor_term_bidding');
    expect(finding).toBeDefined();
    const candidates = (finding!.evidence as { candidates: Array<{ term: string; matched_competitor: string; classification?: string }> }).candidates;
    expect(candidates.map(c => c.term).sort()).toEqual(['brita filter test', 'soulbottle alternative']);
    expect(candidates[0]!.matched_competitor).toBe('brita'); // sorted by spend desc
    // Tier-1 candidates ship without classification — Tier-2 fills it in.
    expect(candidates[0]!.classification).toBeUndefined();
  });

  it('Tier-1: placeholder_text_in_assets surfaces RSA + asset-group placeholders', () => {
    seedAccount(store);
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    store.insertRsaAdsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{
        adId: 'ad1', campaignName: 'Search', adGroupName: 'AG-Brand',
        headlines: ['Auto-Placeholder Headline 1', 'Real Brand Wasserfilter'],
        descriptions: ['TODO: write real description', 'Echte description'],
      }],
    });
    store.insertAssetGroupAssetsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{
        assetGroupName: 'AG-Theme', fieldType: 'HEADLINE', assetStatus: 'ENABLED',
        textContent: 'REPLACE_ME with real copy', campaignName: 'PMax',
      }],
    });

    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'placeholder_text_in_assets');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('HIGH');
    const candidates = (finding!.evidence as { candidates: Array<{ match: string; table: string }> }).candidates;
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    const matches = candidates.map(c => c.match.toLowerCase());
    expect(matches.some(m => m.includes('auto-placeholder'))).toBe(true);
    expect(matches.some(m => m.includes('todo'))).toBe(true);
    expect(matches.some(m => m.includes('replace_me'))).toBe(true);
  });

  it('Tier-1: duplicate_rsa_headlines flags identical copy across multiple ad-groups', () => {
    seedAccount(store);
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    store.insertRsaAdsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { adId: 'a1', campaignName: 'C1', adGroupName: 'AG-A',
          headlines: ['Same Headline', 'Unique A1'], descriptions: ['Same Description'] },
        { adId: 'a2', campaignName: 'C1', adGroupName: 'AG-B',
          headlines: ['Same Headline', 'Unique B1'], descriptions: ['Same Description'] },
        { adId: 'a3', campaignName: 'C2', adGroupName: 'AG-C',
          headlines: ['Different Headline', 'Different B'], descriptions: ['Different desc'] },
      ],
    });
    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'duplicate_rsa_headlines');
    expect(finding).toBeDefined();
    const candidates = (finding!.evidence as { candidates: Array<{ text: string; field_type: string; occurrences: unknown[] }> }).candidates;
    const headline = candidates.find(c => c.text === 'Same Headline');
    const description = candidates.find(c => c.text === 'Same Description');
    expect(headline).toBeDefined();
    expect(headline!.field_type).toBe('HEADLINE');
    expect(headline!.occurrences).toHaveLength(2);
    expect(description).toBeDefined();
    expect(description!.field_type).toBe('DESCRIPTION');
  });

  it('Tier-1: brand_voice_drift collects RSA copy only when customer.brand_voice is populated', () => {
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme',
      brandVoice: { tone: 'direkt, technisch', do_not_use: ['game-changer'] },
    });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    store.insertRsaAdsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{
        adId: 'ad1', campaignName: 'C', adGroupName: 'AG',
        headlines: ['Headline 1', 'Headline 2'],
        descriptions: ['Desc 1', 'Desc 2'],
      }],
    });
    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'brand_voice_drift');
    expect(finding).toBeDefined();
    const candidates = (finding!.evidence as { candidates: Array<{ text: string }> }).candidates;
    expect(candidates.length).toBe(4);
  });

  it('Tier-1: cycle_kpi_anomaly fires when ROAS dropped > 15% vs previous run', () => {
    seedAccount(store);
    // Previous run: solid ROAS — campaign with 500 CHF spend, 6.0 ROAS.
    const r1 = createSuccessRun(store, { mode: 'OPTIMIZE' });
    seedDailyPerformance(store, r1.run_id, 'c1', '2026-01-01', 30, { dailyClicks: 50, dailyConv: 2 });
    store.insertCampaignsBatch({
      runId: r1.run_id, adsAccountId: ACCOUNT,
      rows: [{
        campaignId: 'c1', campaignName: 'Search',
        clicks: 1500, impressions: 50000,
        costMicros: 500_000_000, conversions: 50, convValue: 3000, // ROAS 6.0
      }],
    });
    // Current run: ROAS dropped to 4.0 — 33% drop.
    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    seedDailyPerformance(store, r2.run_id, 'c1', '2026-02-01', 30, { dailyClicks: 50, dailyConv: 2 });
    store.insertCampaignsBatch({
      runId: r2.run_id, adsAccountId: ACCOUNT,
      rows: [{
        campaignId: 'c1', campaignName: 'Search',
        clicks: 1500, impressions: 50000,
        costMicros: 500_000_000, conversions: 50, convValue: 2000, // ROAS 4.0
      }],
    });
    store.recordMajorImport(ACCOUNT, new Date(Date.now() + 1000).toISOString());

    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'cycle_kpi_anomaly');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('HIGH'); // 33% drop > 25% threshold
    const anomalies = (finding!.evidence as { anomalies: Array<{ kpi: string; drop_pct: number }> }).anomalies;
    expect(anomalies[0]!.kpi).toBe('roas');
    expect(anomalies[0]!.drop_pct).toBeGreaterThan(25);
  });

  it('Tier-1: cycle_kpi_anomaly skips when both runs have low spend (single-day blips filtered)', () => {
    seedAccount(store);
    const r1 = createSuccessRun(store, { mode: 'OPTIMIZE' });
    seedDailyPerformance(store, r1.run_id, 'c1', '2026-01-01', 30, { dailyClicks: 5, dailyConv: 1 });
    store.insertCampaignsBatch({
      runId: r1.run_id, adsAccountId: ACCOUNT,
      rows: [{
        campaignId: 'c1', campaignName: 'X',
        clicks: 150, impressions: 3000, costMicros: 50_000_000, // 50 CHF — under threshold
        conversions: 30, convValue: 300,
      }],
    });
    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    seedDailyPerformance(store, r2.run_id, 'c1', '2026-02-01', 30, { dailyClicks: 5, dailyConv: 1 });
    store.insertCampaignsBatch({
      runId: r2.run_id, adsAccountId: ACCOUNT,
      rows: [{
        campaignId: 'c1', campaignName: 'X',
        clicks: 150, impressions: 3000, costMicros: 50_000_000,
        conversions: 30, convValue: 100, // big drop but low spend
      }],
    });
    store.recordMajorImport(ACCOUNT, new Date(Date.now() + 1000).toISOString());

    const result = runAudit(store, ACCOUNT);
    expect(result.findings.find(f => f.area === 'cycle_kpi_anomaly')).toBeUndefined();
  });

  it('Tier-1: brand_voice_drift skips when customer.brand_voice is empty', () => {
    seedAccount(store); // no brand voice
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    store.insertRsaAdsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{
        adId: 'ad1', campaignName: 'C', adGroupName: 'AG',
        headlines: ['x'], descriptions: ['y'],
      }],
    });
    const result = runAudit(store, ACCOUNT);
    expect(result.findings.find(f => f.area === 'brand_voice_drift')).toBeUndefined();
  });

  it('Tier-1: competitor_term_bidding skips when customer has no competitors', () => {
    seedAccount(store); // no competitors in profile
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    store.insertSearchTermsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { searchTerm: 'brita filter test', campaignName: 'PMax', adGroupName: null,
          clicks: 18, costMicros: 25_000_000, conversions: 0 },
      ],
    });
    const result = runAudit(store, ACCOUNT);
    expect(result.findings.find(f => f.area === 'competitor_term_bidding')).toBeUndefined();
  });

  it('Tier-1: pmax_asset_count_below_minimum lists missing field_types per AG', () => {
    seedAccount(store);
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    store.insertAssetGroupsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { assetGroupId: 'ag-thin',  assetGroupName: 'AG-Thin',  campaignName: 'PMax-Brand' },
        { assetGroupId: 'ag-full',  assetGroupName: 'AG-Full',  campaignName: 'PMax-Brand' },
        { assetGroupId: 'ag-empty', assetGroupName: 'AG-Empty', campaignName: 'PMax-Brand' },
      ],
    });
    store.insertAssetGroupAssetsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        // AG-Thin: only 1 HEADLINE — needs 3 — also missing every other type.
        { assetGroupName: 'AG-Thin', fieldType: 'HEADLINE', assetStatus: 'ENABLED',
          campaignName: 'PMax-Brand', textContent: 'one' },
        // AG-Full: meets every minimum.
        ...['HEADLINE', 'HEADLINE', 'HEADLINE'].map(ft => ({
          assetGroupName: 'AG-Full', fieldType: ft, assetStatus: 'ENABLED',
          campaignName: 'PMax-Brand', textContent: 'h',
        })),
        { assetGroupName: 'AG-Full', fieldType: 'LONG_HEADLINE', assetStatus: 'ENABLED',
          campaignName: 'PMax-Brand', textContent: 'long' },
        { assetGroupName: 'AG-Full', fieldType: 'DESCRIPTION', assetStatus: 'ENABLED',
          campaignName: 'PMax-Brand', textContent: 'd1' },
        { assetGroupName: 'AG-Full', fieldType: 'DESCRIPTION', assetStatus: 'ENABLED',
          campaignName: 'PMax-Brand', textContent: 'd2' },
        { assetGroupName: 'AG-Full', fieldType: 'MARKETING_IMAGE', assetStatus: 'ENABLED',
          campaignName: 'PMax-Brand', imageUrl: 'https://x' },
        { assetGroupName: 'AG-Full', fieldType: 'SQUARE_MARKETING_IMAGE', assetStatus: 'ENABLED',
          campaignName: 'PMax-Brand', imageUrl: 'https://x' },
        // AG-Empty: zero asset rows — must still surface via the anti-join.
      ],
    });

    const result = runAudit(store, ACCOUNT);
    const finding = result.findings.find(f => f.area === 'pmax_asset_count_below_minimum');
    expect(finding).toBeDefined();
    const candidates = (finding!.evidence as { candidates: Array<{ asset_group_name: string; missing: Array<{ field_type: string; have: number; need: number }> }> }).candidates;
    const names = candidates.map(c => c.asset_group_name).sort();
    expect(names).toEqual(['AG-Empty', 'AG-Thin']);
    const thin = candidates.find(c => c.asset_group_name === 'AG-Thin')!;
    const headlineGap = thin.missing.find(m => m.field_type === 'HEADLINE')!;
    expect(headlineGap).toEqual({ field_type: 'HEADLINE', have: 1, need: 3 });
  });

  it('Tier-1: quality_score_collapse skips when total ad-group spend is below threshold', () => {
    seedAccount(store);
    const r = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r.run_id, 5);
    store.insertKeywordsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{
        keyword: 'tiny-kw', campaignName: 'Search Brand', adGroupName: 'AG-Tiny',
        matchType: 'EXACT', qualityScore: 2, costMicros: 1_000_000, clicks: 5,
      }],
    });
    const result = runAudit(store, ACCOUNT);
    expect(result.findings.find(f => f.area === 'quality_score_collapse')).toBeUndefined();
  });
});

// ── Fixture helpers ───────────────────────────────────────────────────

function seedAccount(
  store: AdsDataStore,
  opts?: { withProfile?: boolean | undefined; primaryGoal?: string | undefined } | undefined,
): void {
  const withProfile = opts?.withProfile ?? true;
  store.upsertCustomerProfile({
    customerId: CUSTOMER, clientName: 'Acme Shop',
    ...(opts?.primaryGoal !== undefined ? { primaryGoal: opts.primaryGoal } : {}),
  });
  store.upsertAdsAccount({
    adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main',
  });
  if (!withProfile) {
    forceClearProfile(store, CUSTOMER);
  }
}

interface RawDbHandle {
  db?: {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): unknown };
    pragma(s: string): unknown;
  };
}

function forceClearProfile(store: AdsDataStore, customerId: string): void {
  const raw = store as unknown as RawDbHandle;
  if (!raw.db) return;
  raw.db.pragma('foreign_keys = OFF');
  raw.db.prepare('DELETE FROM customer_profiles WHERE customer_id = ?').run(customerId);
  raw.db.pragma('foreign_keys = ON');
}

function createSuccessRun(
  store: AdsDataStore,
  opts: { mode: 'BOOTSTRAP' | 'OPTIMIZE' },
): { run_id: number } {
  const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: opts.mode });
  store.completeAuditRun(r.run_id);
  return r;
}

function setLastImport(store: AdsDataStore, iso: string): void {
  const raw = store as unknown as RawDbHandle;
  if (!raw.db) return;
  raw.db.prepare('UPDATE ads_accounts SET last_major_import_at = ? WHERE ads_account_id = ?')
    .run(iso, ACCOUNT);
}

function seedThinSnapshot(store: AdsDataStore, runId: number, days: number): void {
  const start = new Date('2026-01-01T00:00:00Z').getTime();
  const rows = Array.from({ length: days }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    campaignId: 'c1', campaignName: 'Search Brand',
    impressions: 100, clicks: 10, costMicros: 1_000_000, conversions: 1,
  }));
  store.insertCampaignPerformanceBatch({ runId, adsAccountId: ACCOUNT, rows });
  store.insertCampaignsBatch({
    runId, adsAccountId: ACCOUNT,
    rows: [{ campaignId: 'c1', campaignName: 'Search Brand', clicks: 10 * days, impressions: 100 * days,
      costMicros: 1_000_000 * days, conversions: days, convValue: days * 10 }],
  });
}

function seedDailyPerformance(
  store: AdsDataStore, runId: number, campaignId: string,
  startIso: string, days: number,
  perDay: { dailyClicks: number; dailyConv: number },
): void {
  const start = new Date(startIso + 'T00:00:00Z').getTime();
  const rows = Array.from({ length: days }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    campaignId, campaignName: 'Search Brand',
    impressions: perDay.dailyClicks * 10,
    clicks: perDay.dailyClicks,
    costMicros: perDay.dailyClicks * 100_000,
    conversions: perDay.dailyConv,
    convValue: perDay.dailyConv * 50,
  }));
  store.insertCampaignPerformanceBatch({ runId, adsAccountId: ACCOUNT, rows });
}
