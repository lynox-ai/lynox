import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { createAdsFindingInspectTool } from './ads-finding-inspect.js';
import type { IAgent } from '../../types/index.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'aquanatura';
const fakeAgent = { toolContext: { knowledgeLayer: null } } as unknown as IAgent;

describe('ads_finding_inspect tool', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let tool: ReturnType<typeof createAdsFindingInspectTool>;
  let runId: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-finding-inspect-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    tool = createAdsFindingInspectTool(store);
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Aquanatura',
      languages: ['DE'],
    });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    runId = r.run_id;
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects unknown account', async () => {
    const out = await tool.handler({ ads_account_id: 'no-such', area: 'pmax_brand_inflation' }, fakeAgent);
    expect(out).toMatch(/unknown ads_account_id/);
  });

  it('returns helpful message when no findings exist for the area', async () => {
    store.insertFinding({
      runId, adsAccountId: ACCOUNT, area: 'mode_mismatch',
      severity: 'MEDIUM', source: 'deterministic', text: 'mode',
      confidence: 0.95, evidence: {},
    });
    const out = await tool.handler({ ads_account_id: ACCOUNT, area: 'pmax_brand_inflation' }, fakeAgent);
    expect(out).toMatch(/kein Finding "pmax_brand_inflation"/);
    expect(out).toMatch(/Verfügbare Areas: mode_mismatch/);
  });

  it('renders evidence + sample raw rows for pmax_brand_inflation', async () => {
    store.insertFinding({
      runId, adsAccountId: ACCOUNT, area: 'pmax_brand_inflation',
      severity: 'HIGH', source: 'deterministic',
      text: 'PMax bedient 15 Brand-Cluster …', confidence: 0.9,
      evidence: { brand_tokens: ['hamoni'], branded_clusters: 15, total_pmax_clusters: 600 },
    });
    store.insertCampaignsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'p1', campaignName: 'PMax', status: 'ENABLED', channelType: 'PERFORMANCE_MAX' }],
    });
    // Seed pmax_search_terms via raw insert because no public batch helper.
    type RawDb = { db?: { prepare(sql: string): { run(...args: unknown[]): unknown } } };
    const raw = store as unknown as RawDb;
    raw.db?.prepare(`
      INSERT INTO ads_pmax_search_terms (source_run_id, ads_account_id, campaign_name, search_category, observed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, ACCOUNT, 'PMax', 'hamoni filter', '2026-01-01T00:00:00Z');
    raw.db?.prepare(`
      INSERT INTO ads_pmax_search_terms (source_run_id, ads_account_id, campaign_name, search_category, observed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, ACCOUNT, 'PMax', 'hamoni harmoniser', '2026-01-01T00:00:00Z');

    const out = await tool.handler({ ads_account_id: ACCOUNT, area: 'pmax_brand_inflation' }, fakeAgent);
    expect(out).toMatch(/# Finding inspect — pmax_brand_inflation/);
    expect(out).toMatch(/\*\*Severity:\*\* HIGH/);
    expect(out).toMatch(/Evidence \(parsed\)/);
    expect(out).toMatch(/"brand_tokens"/);
    expect(out).toMatch(/Raw rows from `ads_pmax_search_terms`/);
    expect(out).toMatch(/hamoni filter/);
  });

  it('falls back gracefully for areas without a sampler', async () => {
    store.insertFinding({
      runId, adsAccountId: ACCOUNT, area: 'no_sampler_for_this_area',
      severity: 'LOW', source: 'agent', text: 'custom finding',
      confidence: 0.5, evidence: { custom: 'data' },
    });
    const out = await tool.handler({ ads_account_id: ACCOUNT, area: 'no_sampler_for_this_area' }, fakeAgent);
    expect(out).toMatch(/Kein Sampler konfiguriert/);
    expect(out).toMatch(/Evidence \(parsed\)/);
  });

  it('clamps sample_size into [1, 50]', async () => {
    store.insertFinding({
      runId, adsAccountId: ACCOUNT, area: 'wasted_search_terms',
      severity: 'MEDIUM', source: 'deterministic', text: 'wasted',
      confidence: 0.95, evidence: {},
    });
    // Both extremes should resolve without throwing.
    const tooBig = await tool.handler({
      ads_account_id: ACCOUNT, area: 'wasted_search_terms', sample_size: 9999,
    }, fakeAgent);
    expect(tooBig).toMatch(/# Finding inspect/);
    const tooSmall = await tool.handler({
      ads_account_id: ACCOUNT, area: 'wasted_search_terms', sample_size: -5,
    }, fakeAgent);
    expect(tooSmall).toMatch(/# Finding inspect/);
  });
});
