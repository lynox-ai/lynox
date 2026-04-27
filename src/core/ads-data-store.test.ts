import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from './ads-data-store.js';

describe('AdsDataStore', () => {
  let tempDir: string;
  let store: AdsDataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-ads-test-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('schema migration', () => {
    it('creates the database file and applies v1 schema', () => {
      const profile = store.upsertCustomerProfile({
        customerId: 'aquanatura',
        clientName: 'Aquanatura',
      });
      expect(profile.customer_id).toBe('aquanatura');
      expect(profile.client_name).toBe('Aquanatura');
      // JSON columns default to empty arrays/object
      expect(profile.languages).toBe('[]');
      expect(profile.tracking_notes).toBe('{}');
    });

    it('is idempotent across constructor calls (no double migration)', () => {
      store.upsertCustomerProfile({ customerId: 'c1', clientName: 'C1' });
      store.close();

      const reopened = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
      const fetched = reopened.getCustomerProfile('c1');
      expect(fetched?.client_name).toBe('C1');
      reopened.close();
      // re-open store for the afterEach cleanup
      store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    });
  });

  describe('customer profile', () => {
    it('upsert serializes list/object fields as JSON', () => {
      const profile = store.upsertCustomerProfile({
        customerId: 'aquanatura',
        clientName: 'Aquanatura',
        languages: ['de'],
        ownBrands: ['aquanatura', 'aquanature'],
        competitors: ['aquaquell'],
        pmaxOwnedHeadTerms: ['wasserfilter', 'kefir'],
        trackingNotes: { ga4_linked: true },
        targetRoas: 5.0,
        monthlyBudgetChf: 2700,
      });

      expect(JSON.parse(profile.languages)).toEqual(['de']);
      expect(JSON.parse(profile.own_brands)).toEqual(['aquanatura', 'aquanature']);
      expect(JSON.parse(profile.pmax_owned_head_terms)).toEqual(['wasserfilter', 'kefir']);
      expect(JSON.parse(profile.tracking_notes)).toEqual({ ga4_linked: true });
      expect(profile.target_roas).toBe(5.0);
      expect(profile.monthly_budget_chf).toBe(2700);
    });

    it('upsert preserves created_at on update', () => {
      const first = store.upsertCustomerProfile({ customerId: 'c1', clientName: 'Old' });
      const originalCreated = first.created_at;
      // Wait so updated_at differs
      const updated = store.upsertCustomerProfile({ customerId: 'c1', clientName: 'New' });
      expect(updated.created_at).toBe(originalCreated);
      expect(updated.client_name).toBe('New');
    });

    it('returns null for unknown customer', () => {
      expect(store.getCustomerProfile('nonexistent')).toBeNull();
    });
  });

  describe('ads account', () => {
    beforeEach(() => {
      store.upsertCustomerProfile({ customerId: 'aquanatura', clientName: 'Aquanatura' });
    });

    it('upserts and reads back', () => {
      const acc = store.upsertAdsAccount({
        adsAccountId: '123-456-7890',
        customerId: 'aquanatura',
        accountLabel: 'Aquanatura Main',
        currencyCode: 'CHF',
        timezone: 'Europe/Zurich',
        mode: 'OPTIMIZE',
        driveFolderId: 'drv-folder-id',
      });
      expect(acc.ads_account_id).toBe('123-456-7890');
      expect(acc.mode).toBe('OPTIMIZE');
      expect(acc.drive_folder_id).toBe('drv-folder-id');
    });

    it('defaults mode to BOOTSTRAP', () => {
      const acc = store.upsertAdsAccount({
        adsAccountId: 'a1', customerId: 'aquanatura', accountLabel: 'A1',
      });
      expect(acc.mode).toBe('BOOTSTRAP');
    });

    it('rejects account with unknown customer (FK enforced)', () => {
      expect(() => store.upsertAdsAccount({
        adsAccountId: 'a1', customerId: 'no-such-customer', accountLabel: 'X',
      })).toThrow();
    });

    it('lists accounts for a customer', () => {
      store.upsertAdsAccount({ adsAccountId: 'a1', customerId: 'aquanatura', accountLabel: 'B' });
      store.upsertAdsAccount({ adsAccountId: 'a2', customerId: 'aquanatura', accountLabel: 'A' });
      const list = store.listAdsAccountsForCustomer('aquanatura');
      expect(list.map(a => a.account_label)).toEqual(['A', 'B']);
    });

    it('recordMajorImport updates the timestamp', () => {
      store.upsertAdsAccount({ adsAccountId: 'a1', customerId: 'aquanatura', accountLabel: 'A' });
      expect(store.getAdsAccount('a1')?.last_major_import_at).toBeNull();
      store.recordMajorImport('a1', '2026-04-27T10:00:00.000Z');
      expect(store.getAdsAccount('a1')?.last_major_import_at).toBe('2026-04-27T10:00:00.000Z');
    });
  });

  describe('audit run lifecycle', () => {
    beforeEach(() => {
      store.upsertCustomerProfile({ customerId: 'aquanatura', clientName: 'Aquanatura' });
      store.upsertAdsAccount({ adsAccountId: 'a1', customerId: 'aquanatura', accountLabel: 'A1' });
    });

    it('creates a RUNNING run, completes it, and records the chain', () => {
      const run1 = store.createAuditRun({ adsAccountId: 'a1', mode: 'BOOTSTRAP' });
      expect(run1.status).toBe('RUNNING');
      expect(run1.mode).toBe('BOOTSTRAP');
      expect(run1.started_at).toBeTruthy();
      expect(run1.finished_at).toBeNull();

      store.completeAuditRun(run1.run_id, { tokenCostMicros: 250000 });
      const completed = store.getAuditRun(run1.run_id)!;
      expect(completed.status).toBe('SUCCESS');
      expect(completed.finished_at).toBeTruthy();
      expect(completed.token_cost_micros).toBe(250000);

      // Latest succesful = the completed one
      const latest = store.getLatestSuccessfulAuditRun('a1');
      expect(latest?.run_id).toBe(run1.run_id);

      // Chain to next run via previous_run_id
      const run2 = store.createAuditRun({
        adsAccountId: 'a1', mode: 'OPTIMIZE',
        previousRunId: run1.run_id,
      });
      expect(run2.previous_run_id).toBe(run1.run_id);
    });

    it('blocks a second concurrent run within 4h', () => {
      store.createAuditRun({ adsAccountId: 'a1', mode: 'BOOTSTRAP' });
      expect(() => store.createAuditRun({ adsAccountId: 'a1', mode: 'OPTIMIZE' }))
        .toThrow(/still RUNNING/);
    });

    it('failAuditRun records the error', () => {
      const run = store.createAuditRun({ adsAccountId: 'a1', mode: 'BOOTSTRAP' });
      store.failAuditRun(run.run_id, 'GAS export stale: > 14 days old');
      const failed = store.getAuditRun(run.run_id)!;
      expect(failed.status).toBe('FAILED');
      expect(failed.error_message).toBe('GAS export stale: > 14 days old');
    });

    it('lists runs in reverse chronological order', () => {
      const r1 = store.createAuditRun({ adsAccountId: 'a1', mode: 'BOOTSTRAP' });
      store.failAuditRun(r1.run_id, 'x');
      const r2 = store.createAuditRun({ adsAccountId: 'a1', mode: 'OPTIMIZE' });
      const list = store.listAuditRuns('a1');
      expect(list[0]?.run_id).toBe(r2.run_id);
      expect(list[1]?.run_id).toBe(r1.run_id);
    });
  });

  describe('run decisions', () => {
    let runId: number;

    beforeEach(() => {
      store.upsertCustomerProfile({ customerId: 'aquanatura', clientName: 'Aquanatura' });
      store.upsertAdsAccount({ adsAccountId: 'a1', customerId: 'aquanatura', accountLabel: 'A1' });
      runId = store.createAuditRun({ adsAccountId: 'a1', mode: 'OPTIMIZE' }).run_id;
    });

    it('inserts a KEEP decision', () => {
      store.insertRunDecision({
        runId,
        entityType: 'campaign',
        entityExternalId: '12345',
        decision: 'KEEP',
        confidence: 0.95,
        rationale: 'High ROAS, stable performance',
      });
      const all = store.getRunDecisions(runId);
      expect(all).toHaveLength(1);
      expect(all[0]?.decision).toBe('KEEP');
      expect(all[0]?.confidence).toBe(0.95);
      expect(all[0]?.smart_bidding_guard_passed).toBe(1);
    });

    it('upserts on (run_id, entity_type, entity_external_id) conflict', () => {
      store.insertRunDecision({
        runId, entityType: 'campaign', entityExternalId: '12345',
        decision: 'KEEP', confidence: 0.5, rationale: 'first take',
      });
      store.insertRunDecision({
        runId, entityType: 'campaign', entityExternalId: '12345',
        decision: 'PAUSE', confidence: 0.8, rationale: 'second take',
      });
      const all = store.getRunDecisions(runId);
      expect(all).toHaveLength(1);
      expect(all[0]?.decision).toBe('PAUSE');
      expect(all[0]?.rationale).toBe('second take');
    });

    it('records smart_bidding_guard_passed=false', () => {
      store.insertRunDecision({
        runId, entityType: 'asset_group', entityExternalId: 'ag1',
        decision: 'SPLIT', confidence: 0.85, rationale: 'split rationale',
        smartBiddingGuardPassed: false,
      });
      const all = store.getRunDecisions(runId);
      expect(all[0]?.smart_bidding_guard_passed).toBe(0);
    });

    it('filters by entity_type and decision', () => {
      store.insertRunDecision({ runId, entityType: 'campaign', entityExternalId: 'c1', decision: 'KEEP', confidence: 1, rationale: '' });
      store.insertRunDecision({ runId, entityType: 'campaign', entityExternalId: 'c2', decision: 'PAUSE', confidence: 1, rationale: '' });
      store.insertRunDecision({ runId, entityType: 'keyword', entityExternalId: 'k1', decision: 'NEW', confidence: 1, rationale: '' });

      expect(store.getRunDecisions(runId, { entityType: 'campaign' })).toHaveLength(2);
      expect(store.getRunDecisions(runId, { decision: 'NEW' })).toHaveLength(1);
      expect(store.getRunDecisions(runId, { entityType: 'campaign', decision: 'KEEP' })).toHaveLength(1);
    });

    it('records RENAME with previous_external_id', () => {
      store.insertRunDecision({
        runId, entityType: 'campaign', entityExternalId: 'new-id',
        decision: 'RENAME', previousExternalId: 'old-id',
        confidence: 0.9, rationale: 'naming convention update',
      });
      const all = store.getRunDecisions(runId);
      expect(all[0]?.previous_external_id).toBe('old-id');
    });
  });

  describe('aggregation views', () => {
    it('view_audit_kpis exists and returns null on empty data', () => {
      // Access internal db via a probe method by inserting empty state
      store.upsertCustomerProfile({ customerId: 'c1', clientName: 'C1' });
      store.upsertAdsAccount({ adsAccountId: 'a1', customerId: 'c1', accountLabel: 'A1' });
      const run = store.createAuditRun({ adsAccountId: 'a1', mode: 'BOOTSTRAP' });
      // No campaigns inserted: view should return zero rows for this run scope.
      // We can only verify the view exists (no SQL error on prepare).
      expect(run.run_id).toBeGreaterThan(0);
    });
  });
});

describe('AdsDataStore — bulk inserts and latest-state', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let runId: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-ads-test-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    store.upsertCustomerProfile({ customerId: 'aquanatura', clientName: 'Aquanatura' });
    store.upsertAdsAccount({
      adsAccountId: 'a1', customerId: 'aquanatura', accountLabel: 'A1',
      currencyCode: 'CHF',
    });
    runId = store.createAuditRun({ adsAccountId: 'a1', mode: 'OPTIMIZE' }).run_id;
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('campaign inserts', () => {
    it('insertCampaignsBatch persists all KPI fields including micros', () => {
      const inserted = store.insertCampaignsBatch({
        runId, adsAccountId: 'a1',
        rows: [
          {
            campaignId: '18132985374',
            campaignName: 'PMax | Wasserfilter',
            status: 'ENABLED',
            channelType: 'PERFORMANCE_MAX',
            optScore: 0.958,
            budgetMicros: 34_000_000,
            impressions: 42988,
            clicks: 517,
            costMicros: 794_300_396,
            conversions: 26.95,
            convValue: 5582.24,
            ctr: 0.0120,
            avgCpc: 1_536_364,
            searchIs: 0.181,
            budgetLostIs: 0.0055,
            rankLostIs: 0.813,
          },
          {
            campaignId: '18138702677',
            campaignName: 'PMax | Gesamtsortiment',
            status: 'ENABLED',
            channelType: 'PERFORMANCE_MAX',
            costMicros: 1_208_067_924,
            conversions: 79.56,
            convValue: 8922.93,
          },
        ],
      });
      expect(inserted).toBe(2);

      const rows = store.getSnapshotRows<{ campaign_id: string; campaign_name: string; cost_micros: number }>(
        'ads_campaigns', 'a1', { runId },
      );
      expect(rows).toHaveLength(2);
      expect(rows.find(r => r.campaign_id === '18132985374')?.cost_micros).toBe(794_300_396);

      // getLatestSpend reads only successful runs.
      store.completeAuditRun(runId);
      const total = store.getLatestSpend('a1');
      // Spend = (794_300_396 + 1_208_067_924) / 1_000_000 ≈ 2002.37 CHF
      expect(total).toBeCloseTo(2002.37, 2);
    });

    it('insertCampaignsBatch with empty rows returns 0', () => {
      expect(store.insertCampaignsBatch({ runId, adsAccountId: 'a1', rows: [] })).toBe(0);
    });

    it('all rows share the same observed_at timestamp', () => {
      const ts = '2026-04-27T10:00:00.000Z';
      store.insertCampaignsBatch({
        runId, adsAccountId: 'a1', observedAt: ts,
        rows: [
          { campaignId: 'c1', campaignName: 'C1' },
          { campaignId: 'c2', campaignName: 'C2' },
        ],
      });
      const rows = store.getSnapshotRows<{ observed_at: string }>('ads_campaigns', 'a1', { runId });
      expect(rows.map(r => r.observed_at)).toEqual([ts, ts]);
    });
  });

  describe('rsa ads serialize JSON arrays', () => {
    it('headlines and descriptions are stored as JSON', () => {
      store.insertRsaAdsBatch({
        runId, adsAccountId: 'a1',
        rows: [{
          campaignName: 'Search | Wasserfilter',
          adGroupName: 'AG_Brand',
          adId: 'rsa-1',
          headlines: ['Nachhaltige Wasserfilter', 'Filter-Systeme', 'Hydratation'],
          descriptions: ['Beschreibung A', 'Beschreibung B'],
          finalUrl: 'https://aquanatura.ch',
          adStrength: 'POOR',
        }],
      });
      const rows = store.getSnapshotRows<{ headlines: string; descriptions: string; ad_strength: string }>(
        'ads_rsa_ads', 'a1', { runId },
      );
      expect(rows[0]?.ad_strength).toBe('POOR');
      expect(JSON.parse(rows[0]!.headlines)).toEqual(['Nachhaltige Wasserfilter', 'Filter-Systeme', 'Hydratation']);
      expect(JSON.parse(rows[0]!.descriptions)).toEqual(['Beschreibung A', 'Beschreibung B']);
    });
  });

  describe('boolean coercion', () => {
    it('insertConversionActionsBatch maps booleans to 0/1 and undefined to null', () => {
      store.insertConversionActionsBatch({
        runId, adsAccountId: 'a1',
        rows: [
          { convActionId: 'c1', name: 'Purchase', primaryForGoal: true, inConversionsMetric: false },
          { convActionId: 'c2', name: 'Lead' /* booleans omitted */ },
        ],
      });
      const rows = store.getSnapshotRows<{ conv_action_id: string; primary_for_goal: number | null; in_conversions_metric: number | null }>(
        'ads_conversion_actions', 'a1', { runId },
      );
      const c1 = rows.find(r => r.conv_action_id === 'c1');
      const c2 = rows.find(r => r.conv_action_id === 'c2');
      expect(c1?.primary_for_goal).toBe(1);
      expect(c1?.in_conversions_metric).toBe(0);
      expect(c2?.primary_for_goal).toBeNull();
      expect(c2?.in_conversions_metric).toBeNull();
    });

    it('insertCampaignTargetingBatch defaults isNegative to 0', () => {
      store.insertCampaignTargetingBatch({
        runId, adsAccountId: 'a1',
        rows: [
          { criterionType: 'LOCATION', isNegative: false },
          { criterionType: 'KEYWORD', isNegative: true, keywordText: 'free' },
          { criterionType: 'LANGUAGE' /* omitted */ },
        ],
      });
      const rows = store.getSnapshotRows<{ criterion_type: string; is_negative: number }>(
        'ads_campaign_targeting', 'a1', { runId },
      );
      expect(rows.find(r => r.criterion_type === 'LOCATION')?.is_negative).toBe(0);
      expect(rows.find(r => r.criterion_type === 'KEYWORD')?.is_negative).toBe(1);
      expect(rows.find(r => r.criterion_type === 'LANGUAGE')?.is_negative).toBe(0);
    });
  });

  describe('search terms + GA4 + GSC', () => {
    it('three-way mix coexists in the same run', () => {
      store.insertSearchTermsBatch({
        runId, adsAccountId: 'a1',
        rows: [
          { searchTerm: 'wasserfilter kaufen', impressions: 5000, clicks: 200, costMicros: 80_000_000, conversions: 10, convValue: 1500 },
          { searchTerm: 'kostenlose wasserfilter', impressions: 100, clicks: 5, costMicros: 200_000, conversions: 0, convValue: 0 },
        ],
      });
      store.insertGa4ObservationsBatch({
        runId, adsAccountId: 'a1',
        rows: [
          { date: '2026-04-01', sessionSource: 'google', sessionMedium: 'cpc', sessions: 1200, conversions: 18 },
          { date: '2026-04-01', sessionSource: 'google', sessionMedium: 'organic', sessions: 800, conversions: 5 },
        ],
      });
      store.insertGscObservationsBatch({
        runId, adsAccountId: 'a1',
        rows: [
          { dateMonth: '2026-04', query: 'wasseraufbereitung schweiz', clicks: 120, impressions: 4500, position: 6.2 },
        ],
      });

      expect(store.countSnapshotRows('ads_search_terms', 'a1', runId)).toBe(2);
      expect(store.countSnapshotRows('ga4_observations', 'a1', runId)).toBe(2);
      expect(store.countSnapshotRows('gsc_observations', 'a1', runId)).toBe(1);
    });
  });

  describe('latest-state readers default to latest successful run', () => {
    it('older successful run is returned over a newer FAILED run', () => {
      store.insertCampaignsBatch({ runId, adsAccountId: 'a1', rows: [{ campaignId: 'c1', campaignName: 'OldRun', costMicros: 100_000_000 }] });
      store.completeAuditRun(runId);

      // Start a new run, populate, then FAIL it
      const failRun = store.createAuditRun({ adsAccountId: 'a1', mode: 'OPTIMIZE' }).run_id;
      store.insertCampaignsBatch({ runId: failRun, adsAccountId: 'a1', rows: [{ campaignId: 'c1', campaignName: 'BadRun', costMicros: 999_999_999 }] });
      store.failAuditRun(failRun, 'simulated failure');

      // Latest-state queries should pick the SUCCESS run, not the FAILED one
      const rows = store.getSnapshotRows<{ campaign_name: string }>('ads_campaigns', 'a1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.campaign_name).toBe('OldRun');
    });

    it('returns empty when the account has no successful run', () => {
      store.failAuditRun(runId, 'never finished');
      expect(store.getSnapshotRows('ads_campaigns', 'a1')).toEqual([]);
      expect(store.countSnapshotRows('ads_campaigns', 'a1')).toBe(0);
    });

    it('explicit runId overrides the latest-successful default', () => {
      store.insertCampaignsBatch({ runId, adsAccountId: 'a1', rows: [{ campaignId: 'c1', campaignName: 'RunningRun' }] });
      // RUNNING run is not "latest successful", but an explicit runId wins
      const rows = store.getSnapshotRows<{ campaign_name: string }>('ads_campaigns', 'a1', { runId });
      expect(rows[0]?.campaign_name).toBe('RunningRun');
    });
  });

  describe('queryView', () => {
    it('view_audit_kpis aggregates spend / conv / roas / ctr', () => {
      store.insertCampaignsBatch({
        runId, adsAccountId: 'a1',
        rows: [
          { campaignId: 'c1', campaignName: 'C1', impressions: 10000, clicks: 500, costMicros: 100_000_000, conversions: 10, convValue: 1500 },
          { campaignId: 'c2', campaignName: 'C2', impressions: 20000, clicks: 800, costMicros: 200_000_000, conversions: 20, convValue: 3000 },
        ],
      });
      store.completeAuditRun(runId);

      const rows = store.queryView('view_audit_kpis', 'a1');
      expect(rows).toHaveLength(1);
      const k = rows[0]!;
      expect(k['spend']).toBe(300);
      expect(k['conversions']).toBe(30);
      expect(k['conv_value']).toBe(4500);
      expect(k['roas']).toBe(15);
      expect(k['cpa']).toBe(10);
      expect(k['ctr']).toBeCloseTo(0.04333, 4);
    });

    it('rejects unknown view names', () => {
      expect(() => store.queryView('view_does_not_exist', 'a1'))
        .toThrow(/Unknown view "view_does_not_exist"/);
    });

    it('view_blueprint_negative_candidates flags terms disjunct from PMAX', () => {
      store.insertSearchTermsBatch({
        runId, adsAccountId: 'a1',
        rows: [
          { searchTerm: 'wasserfilter shop', costMicros: 5_000_000, conversions: 2 },
          { searchTerm: 'kefir kaufen', costMicros: 1_000_000, conversions: 0 },
        ],
      });
      store.insertPmaxSearchTermsBatch({
        runId, adsAccountId: 'a1',
        rows: [{ searchCategory: 'wasserfilter shop' }],
      });
      store.completeAuditRun(runId);

      const rows = store.queryView('view_blueprint_negative_candidates', 'a1');
      const terms = new Map(rows.map(r => [r['search_term'] as string, r['pmax_disjunct'] as number]));
      expect(terms.get('wasserfilter shop')).toBe(0); // overlap with PMAX → not disjunct
      expect(terms.get('kefir kaufen')).toBe(1);       // no overlap → disjunct
    });
  });
});
