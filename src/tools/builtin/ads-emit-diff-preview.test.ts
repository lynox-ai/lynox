import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { createAdsEmitDiffPreviewTool } from './ads-emit-diff-preview.js';
import type { IAgent } from '../../types/index.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'aquanatura';
const fakeAgent = { toolContext: { knowledgeLayer: null } } as unknown as IAgent;

describe('ads_emit_diff_preview tool', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let tool: ReturnType<typeof createAdsEmitDiffPreviewTool>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-diff-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    tool = createAdsEmitDiffPreviewTool(store);
    store.upsertCustomerProfile({ customerId: CUSTOMER, clientName: 'Aquanatura' });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function seedRunWithEntities(): number {
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    store.insertBlueprintEntity({
      runId: r.run_id, adsAccountId: ACCOUNT,
      entityType: 'campaign', kind: 'NEW',
      externalId: 'bp.campaign.search-brand', confidence: 0.85,
      payload: { campaign_name: 'Search-Brand' },
    });
    store.insertBlueprintEntity({
      runId: r.run_id, adsAccountId: ACCOUNT,
      entityType: 'ad_group', kind: 'KEEP',
      externalId: 'ag-existing', confidence: 0.9,
      payload: { campaign_name: 'PMax', ad_group_name: 'AG-Wasserfilter' },
    });
    store.insertBlueprintEntity({
      runId: r.run_id, adsAccountId: ACCOUNT,
      entityType: 'ad_group', kind: 'RENAME',
      externalId: 'ag-new-name', previousExternalId: 'ag-old-name',
      confidence: 0.85,
      payload: { campaign_name: 'PMax', ad_group_name: 'AG-Renamed' },
    });
    store.insertBlueprintEntity({
      runId: r.run_id, adsAccountId: ACCOUNT,
      entityType: 'keyword', kind: 'PAUSE',
      externalId: 'kw-paused', confidence: 0.7,
      payload: { keyword: 'old keyword', match_type: 'EXACT' },
    });
    return r.run_id;
  }

  it('rejects unknown account', async () => {
    const out = await tool.handler({ ads_account_id: 'nope' }, fakeAgent);
    expect(out).toMatch(/unknown ads_account_id/);
  });

  it('returns helpful message when no blueprint exists for the run', async () => {
    const out = await tool.handler({ ads_account_id: ACCOUNT }, fakeAgent);
    expect(out).toMatch(/keine Blueprint-Runs/);
  });

  it('renders summary table + per-type sections with samples', async () => {
    seedRunWithEntities();
    const out = await tool.handler({ ads_account_id: ACCOUNT }, fakeAgent);
    expect(out).toMatch(/# Emit Diff Preview/);
    expect(out).toMatch(/Aquanatura/);
    expect(out).toMatch(/## Summary by entity type/);
    expect(out).toMatch(/\| campaign \| 1 \| 0 \| 0 \|/);
    expect(out).toMatch(/\| ad_group \| 0 \| 1 \| 0 \|/);
    expect(out).toMatch(/\| keyword \| 0 \| 0 \| 1 \|/);
    expect(out).toMatch(/## campaign/);
    expect(out).toMatch(/### NEW — 1/);
    expect(out).toMatch(/### RENAME — 1/);
    expect(out).toMatch(/`ag-old-name` → `AG-Renamed`/);
    expect(out).toMatch(/### PAUSE — 1/);
    // KEEP shouldn't appear in detail sections (would be clutter)
    expect(out).not.toMatch(/### KEEP/);
  });

  it('clamps sample_size to [1, 20]', async () => {
    seedRunWithEntities();
    const out1 = await tool.handler({ ads_account_id: ACCOUNT, sample_size: 9999 }, fakeAgent);
    expect(out1).toMatch(/# Emit Diff Preview/);
    const out2 = await tool.handler({ ads_account_id: ACCOUNT, sample_size: -5 }, fakeAgent);
    expect(out2).toMatch(/# Emit Diff Preview/);
  });
});
