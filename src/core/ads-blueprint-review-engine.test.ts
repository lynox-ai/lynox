import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from './ads-data-store.js';
import { runBlueprintReview } from './ads-blueprint-review-engine.js';
import type { CustomerProfileRow } from './ads-data-store.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';

describe('runBlueprintReview', () => {
  let tempDir: string;
  let store: AdsDataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-pre-emit-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function seedRun(): number {
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme',
      languages: ['DE'], topProducts: ['kefir', 'kombucha', 'wasserfilter'],
      ownBrands: ['acme'], soldBrands: ['hamoni', 'maunawai'],
      monthlyBudgetChf: 3000,
    });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    return r.run_id;
  }

  function getCustomer(): CustomerProfileRow {
    return store.getCustomerProfile(CUSTOMER)!;
  }

  it('flags two NEW ad-groups pointing to the same Final URL as BLOCK', () => {
    const runId = seedRun();
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'rsa_ad', kind: 'NEW',
      externalId: 'rsa-1', confidence: 0.7,
      payload: { campaign_name: 'Search-Brand', ad_group_name: 'Brand-Hamoni',
        headlines: ['Hamoni'], descriptions: ['x'], final_url: 'https://acme.example/' },
    });
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'rsa_ad', kind: 'NEW',
      externalId: 'rsa-2', confidence: 0.7,
      payload: { campaign_name: 'Search-Brand', ad_group_name: 'Brand-Maunawai',
        headlines: ['Maunawai'], descriptions: ['x'], final_url: 'https://acme.example/' },
    });

    const result = runBlueprintReview(store, runId, getCustomer());

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.area).toBe('pre_emit_review:duplicate_final_url');
    expect((result.blocks[0]!.evidence['ad_groups'] as unknown[])).toHaveLength(2);
  });

  it('flags an all-generic-headline RSA on a Brand-* ad-group as a warning', () => {
    const runId = seedRun();
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'rsa_ad', kind: 'NEW',
      externalId: 'rsa-1', confidence: 0.7,
      payload: { campaign_name: 'Search-Brand', ad_group_name: 'Brand-Hamoni',
        headlines: ['Jetzt entdecken', 'Mehr erfahren', 'Online kaufen'],
        descriptions: ['x'], final_url: 'https://acme.example/hamoni' },
    });

    const result = runBlueprintReview(store, runId, getCustomer());
    expect(result.warnings.find(w => w.area === 'pre_emit_review:generic_copy_on_specialty')).toBeDefined();
    expect(result.blocks).toHaveLength(0);
  });

  it('flags Brand-Search ad-group whose brand is missing from the customer profile', () => {
    const runId = seedRun();
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'ad_group', kind: 'NEW',
      externalId: 'ag-1', confidence: 0.85,
      payload: { campaign_name: 'Search-Brand', ad_group_name: 'Brand-UnknownCo' },
    });

    const result = runBlueprintReview(store, runId, getCustomer());
    expect(result.warnings.find(w => w.area === 'pre_emit_review:brand_naming_drift')).toBeDefined();
  });

  it('does not flag Brand-Search drift when the brand is in own_brands or sold_brands', () => {
    const runId = seedRun();
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'ad_group', kind: 'NEW',
      externalId: 'ag-1', confidence: 0.85,
      payload: { campaign_name: 'Search-Brand', ad_group_name: 'Brand-Hamoni' },
    });
    const result = runBlueprintReview(store, runId, getCustomer());
    expect(result.warnings.find(w => w.area === 'pre_emit_review:brand_naming_drift')).toBeUndefined();
  });

  it('flags theme-AG that does not overlap with customer.top_products as warning', () => {
    const runId = seedRun();
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'asset_group', kind: 'NEW',
      externalId: 'ag-1', confidence: 0.7,
      payload: { campaign_name: 'PMax', asset_group_name: 'Theme-Beton', theme_token: 'beton' },
    });
    const result = runBlueprintReview(store, runId, getCustomer());
    expect(result.warnings.find(w => w.area === 'pre_emit_review:theme_mismatch_catalogue')).toBeDefined();
  });

  it('does not flag theme mismatch when token overlaps with top_products', () => {
    const runId = seedRun();
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'asset_group', kind: 'NEW',
      externalId: 'ag-1', confidence: 0.7,
      payload: { campaign_name: 'PMax', asset_group_name: 'Theme-Kefir', theme_token: 'kefir' },
    });
    const result = runBlueprintReview(store, runId, getCustomer());
    expect(result.warnings.find(w => w.area === 'pre_emit_review:theme_mismatch_catalogue')).toBeUndefined();
  });

  it('blocks daily budget that eats >80% of monthly customer budget', () => {
    const runId = seedRun();
    // monthly = 3000, dailyExpected = 100. Daily = 2500 → 25× → blocks.
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'campaign', kind: 'NEW',
      externalId: 'c-1', confidence: 0.85,
      payload: { campaign_name: 'Search-Brand', budget_chf: 2500 },
    });
    const result = runBlueprintReview(store, runId, getCustomer());
    expect(result.blocks.find(b => b.area === 'pre_emit_review:budget_anomaly_block')).toBeDefined();
  });

  it('warns daily budget between 30% and 80% of monthly', () => {
    const runId = seedRun();
    // monthly=3000, dailyExpected=100. Daily=1000 → 10× → 10×100=1000, 9×100=900 < 1000 ≤ 24×100=2400 → warning.
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'campaign', kind: 'NEW',
      externalId: 'c-1', confidence: 0.85,
      payload: { campaign_name: 'Search-Brand', budget_chf: 1000 },
    });
    const result = runBlueprintReview(store, runId, getCustomer());
    expect(result.warnings.find(w => w.area === 'pre_emit_review:budget_anomaly_warning')).toBeDefined();
    expect(result.blocks).toHaveLength(0);
  });

  it('returns no findings when blueprint is clean', () => {
    const runId = seedRun();
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'asset_group', kind: 'NEW',
      externalId: 'ag-1', confidence: 0.7,
      payload: { campaign_name: 'PMax', asset_group_name: 'Theme-Kefir', theme_token: 'kefir',
        final_url: 'https://acme.example/kefir' },
    });
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'campaign', kind: 'NEW',
      externalId: 'c-1', confidence: 0.85,
      payload: { campaign_name: 'Search-Brand', budget_chf: 50 },
    });
    const result = runBlueprintReview(store, runId, getCustomer());
    expect(result.findings).toHaveLength(0);
  });
});
