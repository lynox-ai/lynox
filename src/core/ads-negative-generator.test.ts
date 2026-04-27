import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from './ads-data-store.js';
import { generateNegatives } from './ads-negative-generator.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';

describe('generateNegatives', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let runId: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-neg-gen-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme Shop',
      pmaxOwnedHeadTerms: ['drills', 'sanders', 'grinders'],
      competitors: ['BoschTools', 'MakitaShop'],
      primaryGoal: 'roas',
    });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'OPTIMIZE' });
    store.completeAuditRun(r.run_id);
    runId = r.run_id;
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('emits exact-match account-level negatives for pmax_owned_head_terms', () => {
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    const owned = out.filter(n => n.source === 'pmax_owned');
    expect(owned).toHaveLength(3);
    for (const n of owned) {
      expect(n.matchType).toBe('Exact');
      expect(n.scope).toBe('account');
      expect(n.scopeTarget).toBeNull();
    }
    expect(owned.map(n => n.keywordText).sort()).toEqual(['drills', 'grinders', 'sanders']);
  });

  it('emits broad-match account-level negatives for competitors', () => {
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    const comp = out.filter(n => n.source === 'competitor');
    expect(comp).toHaveLength(2);
    for (const n of comp) {
      expect(n.matchType).toBe('Broad');
      expect(n.scope).toBe('account');
    }
  });

  it('skips competitor negatives for awareness/traffic goals', () => {
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme Shop',
      pmaxOwnedHeadTerms: [], competitors: ['Bosch'], primaryGoal: 'awareness',
    });
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    expect(out.filter(n => n.source === 'competitor')).toHaveLength(0);
  });

  it('skips competitor negatives when explicit override is set', () => {
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer, { skipCompetitorNegatives: true });
    expect(out.filter(n => n.source === 'competitor')).toHaveLength(0);
  });

  it('emits cross_campaign exact-match negatives for PMAX-overlapping waste', () => {
    // Search term appears with cost > threshold, 0 conversions, AND in pmax_search_terms.
    store.insertSearchTermsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [
        { searchTerm: 'drills', campaignName: 'Search Generic', costMicros: 10_000_000, conversions: 0 },
      ],
    });
    store.insertPmaxSearchTermsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [{ searchCategory: 'drills' }],
    });
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    const cc = out.filter(n => n.source === 'cross_campaign');
    expect(cc).toHaveLength(1);
    expect(cc[0]?.matchType).toBe('Exact'); // PMAX overlap → exact
    expect(cc[0]?.scope).toBe('campaign');
    expect(cc[0]?.scopeTarget).toBe('Search Generic');
    expect(cc[0]?.rationale).toMatch(/PMAX/);
  });

  it('emits cross_campaign broad-match negatives for non-overlapping waste', () => {
    store.insertSearchTermsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [
        { searchTerm: 'gizmos kaufen', campaignName: 'Search Generic', costMicros: 10_000_000, conversions: 0 },
      ],
    });
    // No matching PMAX search term → pmax_disjunct = 1
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    const cc = out.filter(n => n.source === 'cross_campaign');
    expect(cc).toHaveLength(1);
    expect(cc[0]?.matchType).toBe('Broad');
    expect(cc[0]?.rationale).toMatch(/verbrannte/);
  });

  it('does NOT emit cross_campaign negatives when search term had conversions', () => {
    store.insertSearchTermsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [
        { searchTerm: 'drills', campaignName: 'Search Brand', costMicros: 50_000_000, conversions: 5 },
      ],
    });
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    expect(out.filter(n => n.source === 'cross_campaign')).toHaveLength(0);
  });

  it('respects waste-spend threshold (skips low-spend wasted terms)', () => {
    store.insertSearchTermsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [
        { searchTerm: 'tiny', campaignName: 'Search', costMicros: 1_000_000, conversions: 0 }, // 1 CHF
      ],
    });
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer, { wasteSpendThreshold: 5 });
    expect(out.filter(n => n.source === 'cross_campaign')).toHaveLength(0);
  });

  it('aggregates multi-row search-term occurrences into a single proposal', () => {
    store.insertSearchTermsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [
        { searchTerm: 'drills', campaignName: 'Search Generic', costMicros: 6_000_000, conversions: 0, adGroupName: 'AG-A' },
        { searchTerm: 'drills', campaignName: 'Search Generic', costMicros: 7_000_000, conversions: 0, adGroupName: 'AG-B' },
      ],
    });
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    const cc = out.filter(n => n.source === 'cross_campaign');
    expect(cc).toHaveLength(1);
    expect(cc[0]?.evidence?.['spend_chf']).toBeCloseTo(13, 2);
  });

  it('emits stable, deterministic externalIds across runs', () => {
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const a = generateNegatives(store, ACCOUNT, runId, customer);
    const b = generateNegatives(store, ACCOUNT, runId, customer);
    expect(a.map(n => n.externalId).sort()).toEqual(b.map(n => n.externalId).sort());
    // Ensure the id format is what we expect.
    const drills = a.find(n => n.source === 'pmax_owned' && n.keywordText === 'drills');
    expect(drills?.externalId).toBe('neg.pmax_owned.account.drills.exact');
  });

  it('returns empty array when customer profile is null', () => {
    const out = generateNegatives(store, ACCOUNT, runId, null);
    expect(out).toEqual([]);
  });
});
