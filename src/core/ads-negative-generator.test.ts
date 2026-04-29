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

  // ── Auto-derived pmax_owned head terms ──────────────────────────────
  // The customer profile pmax_owned_head_terms field is operator-curated
  // and almost always empty in practice. The auto-derive pulls signal
  // from the live PMax snapshot so the optimizer Just Works.

  it('auto-derives pmax_owned head terms from PMax asset_group_name tokens', () => {
    // Reset profile to no explicit owned terms — derivation must fill the gap.
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme Shop',
      pmaxOwnedHeadTerms: [], competitors: [], primaryGoal: 'roas',
      ownBrands: [], soldBrands: [],
    });
    store.insertCampaignsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'pmax-1', campaignName: 'PMax | Werkzeug', channelType: 'PERFORMANCE_MAX' }],
    });
    store.insertAssetGroupsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [
        { assetGroupId: 'ag1', assetGroupName: 'Wasserfilter', campaignName: 'PMax | Werkzeug' },
        { assetGroupId: 'ag2', assetGroupName: 'Osmoseanlagen', campaignName: 'PMax | Werkzeug' },
      ],
    });
    // Cluster signal is thin (under no-AG threshold) but the AG match
    // alone is enough — these are categories the customer has explicitly
    // committed PMax to.
    store.insertPmaxSearchTermsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [
        ...Array.from({ length: 6 }, (_, i) => ({ searchCategory: `wasserfilter cluster ${i}` })),
        ...Array.from({ length: 5 }, (_, i) => ({ searchCategory: `osmoseanlagen cluster ${i}` })),
      ],
    });
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    const owned = out.filter(n => n.source === 'pmax_owned');
    const tokens = owned.map(n => n.keywordText).sort();
    expect(tokens).toContain('wasserfilter');
    expect(tokens).toContain('osmoseanlagen');
    for (const n of owned) {
      expect(n.matchType).toBe('Exact');
      expect(n.scope).toBe('account');
      expect(n.confidence).toBe(0.7); // auto-derived = 0.7 (vs explicit 0.95)
      expect(n.evidence?.['asset_group_match']).toBe(true);
    }
  });

  it('auto-derives pmax_owned head terms from high-volume cluster tokens (no AG)', () => {
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme Shop',
      pmaxOwnedHeadTerms: [], competitors: [], primaryGoal: 'roas',
      ownBrands: [], soldBrands: [],
    });
    // No asset_group named "kefir" — customer hasn't carved it out yet,
    // but PMax serves it heavily through Gesamtsortiment so 25 distinct
    // search-term clusters reference it. Above the 20-cluster floor.
    store.insertPmaxSearchTermsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: Array.from({ length: 25 }, (_, i) => ({ searchCategory: `kefir variant ${i}` })),
    });
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    const owned = out.filter(n => n.source === 'pmax_owned');
    const kefir = owned.find(n => n.keywordText === 'kefir');
    expect(kefir).toBeDefined();
    expect(kefir!.confidence).toBe(0.7);
    expect(kefir!.evidence?.['cluster_count']).toBe(25);
    expect(kefir!.evidence?.['asset_group_match']).toBe(false);
  });

  it('does NOT auto-derive low-volume cluster tokens without AG match', () => {
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme Shop',
      pmaxOwnedHeadTerms: [], competitors: [], primaryGoal: 'roas',
      ownBrands: [], soldBrands: [],
    });
    // 18 clusters — below the 20 floor when no AG match is present.
    store.insertPmaxSearchTermsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: Array.from({ length: 18 }, (_, i) => ({ searchCategory: `niche thing ${i}` })),
    });
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    expect(out.filter(n => n.source === 'pmax_owned' && n.keywordText === 'niche')).toHaveLength(0);
  });

  it('filters brand tokens out of auto-derived pmax_owned (those go via brand_inflation_block)', () => {
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme Shop',
      pmaxOwnedHeadTerms: [], competitors: [], primaryGoal: 'roas',
      ownBrands: ['acme'], soldBrands: ['maunawai'],
    });
    store.insertPmaxSearchTermsBatch({
      runId, adsAccountId: ACCOUNT,
      // 25 clusters mention the brand — would normally trigger derive,
      // but brand tokens are excluded.
      rows: Array.from({ length: 25 }, (_, i) => ({ searchCategory: `acme product ${i}` })),
    });
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    expect(out.filter(n => n.source === 'pmax_owned' && n.keywordText === 'acme')).toHaveLength(0);
  });

  it('filters generic funnel words from auto-derived pmax_owned', () => {
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme Shop',
      pmaxOwnedHeadTerms: [], competitors: [], primaryGoal: 'roas',
      ownBrands: [], soldBrands: [],
    });
    store.insertPmaxSearchTermsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: Array.from({ length: 25 }, (_, i) => ({ searchCategory: `wasserfilter kaufen schweiz ${i}` })),
    });
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    const tokens = out.filter(n => n.source === 'pmax_owned').map(n => n.keywordText);
    expect(tokens).not.toContain('kaufen');
    expect(tokens).not.toContain('schweiz');
    expect(tokens).toContain('wasserfilter'); // real category survives
  });

  it('explicit profile term wins over auto-derived (deduped, confidence 0.95)', () => {
    // Operator already curated "wasserfilter" — derivation must NOT
    // emit a duplicate at confidence 0.7. The 0.95 explicit entry wins.
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme Shop',
      pmaxOwnedHeadTerms: ['wasserfilter'], competitors: [], primaryGoal: 'roas',
      ownBrands: [], soldBrands: [],
    });
    store.insertCampaignsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'pmax-1', campaignName: 'PMax', channelType: 'PERFORMANCE_MAX' }],
    });
    store.insertAssetGroupsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [{ assetGroupId: 'ag1', assetGroupName: 'Wasserfilter', campaignName: 'PMax' }],
    });
    store.insertPmaxSearchTermsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: Array.from({ length: 10 }, (_, i) => ({ searchCategory: `wasserfilter ${i}` })),
    });
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const out = generateNegatives(store, ACCOUNT, runId, customer);
    const wasserfilter = out.filter(n => n.source === 'pmax_owned' && n.keywordText === 'wasserfilter');
    expect(wasserfilter).toHaveLength(1);
    expect(wasserfilter[0]!.confidence).toBe(0.95);
  });
});
