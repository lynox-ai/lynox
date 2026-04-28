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

  it('detects OPTIMIZE mode when previous run + ≥30 days data', () => {
    seedAccount(store);
    const r1 = createSuccessRun(store, { mode: 'BOOTSTRAP' });
    seedThinSnapshot(store, r1.run_id, 30);

    const r2 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id });
    store.completeAuditRun(r2.run_id);
    seedThinSnapshot(store, r2.run_id, 35);

    const result = runAudit(store, ACCOUNT);
    expect(result.mode.detected).toBe('OPTIMIZE');
    expect(result.mode.performanceDays).toBe(35);
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
    seedDailyPerformance(store, r1.run_id, 'c1', '2026-01-15', 30, { dailyClicks: 50, dailyConv: 5 });
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
    seedDailyPerformance(store, r1.run_id, 'c1', '2026-01-19', 28, { dailyClicks: 20, dailyConv: 1 });

    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    store.insertCampaignsBatch({
      runId: r2.run_id, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'c1', campaignName: 'Lead Gen', clicks: 500, conversions: 30 }],
    });
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
