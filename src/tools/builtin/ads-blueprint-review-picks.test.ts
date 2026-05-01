import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { runBlueprint } from '../../core/ads-blueprint-engine.js';
import { createAdsBlueprintReviewPicksTool } from './ads-blueprint-review-picks.js';
import type { IAgent, TabQuestion } from '../../types/index.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';

describe('ads_blueprint_review_picks tool', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let tool: ReturnType<typeof createAdsBlueprintReviewPicksTool>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-bp-review-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    tool = createAdsBlueprintReviewPicksTool(store);
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function seedRunWithBrandReviews(): number {
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme Shop',
      languages: ['DE'], pmaxOwnedHeadTerms: ['hamoni', 'maunawai'],
    });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    store.insertCampaignsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'pmax1', campaignName: 'PMax | Gesamt', status: 'ENABLED', channelType: 'PERFORMANCE_MAX' }],
    });
    store.insertLandingPagesBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { landingPageUrl: 'https://acme-shop.example/wasser', clicks: 200, conversions: 6 },
        { landingPageUrl: 'https://acme-shop.example/luft',   clicks: 150, conversions: 4 },
        { landingPageUrl: 'https://acme-shop.example/',       clicks: 300, conversions: 9 },
      ],
    });
    store.insertFinding({
      runId: r.run_id, adsAccountId: ACCOUNT,
      area: 'pmax_brand_inflation', severity: 'HIGH', source: 'deterministic',
      text: 'PMax bedient Brand-Cluster …', confidence: 0.9,
      evidence: { brand_tokens: ['hamoni', 'maunawai'] },
    });
    runBlueprint(store, ACCOUNT);
    return r.run_id;
  }

  it('returns no-op summary when no reviews are pending', async () => {
    store.upsertCustomerProfile({ customerId: CUSTOMER, clientName: 'Acme', languages: ['DE'] });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    store.insertCampaignsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'c1', campaignName: 'Search-A', status: 'ENABLED' }],
    });
    runBlueprint(store, ACCOUNT);

    const agent = makeAgent(vi.fn());
    const out = await tool.handler({ ads_account_id: ACCOUNT }, agent);
    expect(out).toMatch(/keine offenen Reviews/);
  });

  it('drains the queue via a single batched promptTabs call', async () => {
    seedRunWithBrandReviews();
    const promptTabs = vi.fn(async (questions: TabQuestion[]) => {
      // Operator picks the first option of each tab.
      return questions.map(q => q.options?.[0] ?? '');
    });
    const agent = makeAgent(vi.fn(), promptTabs);

    const out = await tool.handler({ ads_account_id: ACCOUNT }, agent);
    // Must be a single call carrying both reviews.
    expect(promptTabs).toHaveBeenCalledTimes(1);
    expect(promptTabs.mock.calls[0]![0]).toHaveLength(2);
    expect(out).toMatch(/2 Picks angewendet/);
    expect(out).toMatch(/Review-Queue leer/);

    // After draining, no entity has a pending review.
    const runs = store.listAuditRuns(ACCOUNT, 5);
    const runId = runs[0]!.run_id;
    expect(store.listEntitiesNeedingReview(runId)).toHaveLength(0);
  });

  it('writes the chosen final_url back into payload_json', async () => {
    seedRunWithBrandReviews();
    const chosen = 'https://acme-shop.example/wasser';
    const promptTabs = vi.fn(async (questions: TabQuestion[]) => {
      // Find the option whose label starts with the chosen URL.
      return questions.map(q => q.options?.find(o => o.startsWith(chosen)) ?? '');
    });
    const agent = makeAgent(vi.fn(), promptTabs);

    await tool.handler({ ads_account_id: ACCOUNT }, agent);

    const runId = store.listAuditRuns(ACCOUNT, 5)[0]!.run_id;
    const rsas = store.listBlueprintEntities(runId, { entityType: 'rsa_ad' });
    expect(rsas).toHaveLength(2);
    for (const rsa of rsas) {
      expect(JSON.parse(rsa.payload_json).final_url).toBe(chosen);
    }
  });

  it('falls back to sequential promptUser when promptTabs is missing', async () => {
    seedRunWithBrandReviews();
    const promptUser = vi.fn(async (_q: string, options?: string[]) => options?.[0] ?? '');
    const agent = makeAgent(promptUser);

    const out = await tool.handler({ ads_account_id: ACCOUNT }, agent);
    // Two reviews → two sequential prompts.
    expect(promptUser).toHaveBeenCalledTimes(2);
    expect(out).toMatch(/2 Picks angewendet/);
  });

  it('uncertain themes never reach the picks queue (suppressed at blueprint time)', async () => {
    // Counterpart to the uncertain-theme suppression in runBlueprint:
    // the picks engine should never even see an uncertain theme-AG because
    // the blueprint default-denies them now. The agent must validate intent
    // and propose explicitly via ads_blueprint_entity_propose; that propose
    // call goes through upsertAgentBlueprintEntity which is exercised by
    // the entity-propose test suite, not here.
    store.upsertCustomerProfile({ customerId: CUSTOMER, clientName: 'Acme', languages: ['DE'] });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    store.insertCampaignsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'pmax1', campaignName: 'PMax | Gesamt', status: 'ENABLED', channelType: 'PERFORMANCE_MAX' }],
    });
    store.insertFinding({
      runId: r.run_id, adsAccountId: ACCOUNT,
      area: 'pmax_theme_coverage_gap', severity: 'MEDIUM', source: 'deterministic',
      text: '…', confidence: 0.75,
      evidence: {
        themes: [{ token: 'fermenten', clusters: 6, sample: [], category: 'uncertain', classification_reason: 'unclear' }],
        existing_asset_groups: [],
      },
    });
    runBlueprint(store, ACCOUNT);

    expect(store.listBlueprintEntities(r.run_id, { entityType: 'asset_group' })).toHaveLength(0);
    expect(store.listEntitiesNeedingReview(r.run_id)).toHaveLength(0);
    // The pending-finding is what the agent acts on instead.
    expect(store.listFindings(r.run_id, { area: 'theme_uncertain_intent_pending' })).toHaveLength(1);
  });

  it('keeps the queue intact when the operator cancels promptTabs (empty result)', async () => {
    const runId = seedRunWithBrandReviews();
    const promptTabs = vi.fn(async () => [] as string[]);
    const agent = makeAgent(vi.fn(), promptTabs);

    const out = await tool.handler({ ads_account_id: ACCOUNT }, agent);
    expect(out).toMatch(/abgebrochen/);
    // Queue is still populated.
    expect(store.listEntitiesNeedingReview(runId)).toHaveLength(2);
  });
});

function makeAgent(
  promptUser: (q: string, options?: string[]) => Promise<string>,
  promptTabs?: (questions: TabQuestion[]) => Promise<string[]>,
): IAgent {
  return {
    toolContext: { knowledgeLayer: null },
    promptUser,
    ...(promptTabs ? { promptTabs } : {}),
  } as unknown as IAgent;
}
