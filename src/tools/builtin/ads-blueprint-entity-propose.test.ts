import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { createAdsBlueprintEntityProposeTool } from './ads-blueprint-entity-propose.js';
import { runBlueprint } from '../../core/ads-blueprint-engine.js';
import type { IAgent } from '../../types/index.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';
const fakeAgent = { toolContext: { knowledgeLayer: null } } as unknown as IAgent;

describe('ads_blueprint_entity_propose tool', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let tool: ReturnType<typeof createAdsBlueprintEntityProposeTool>;
  let runId: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-bp-propose-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    tool = createAdsBlueprintEntityProposeTool(store);
    seedAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    runId = r.run_id;
    // Seed parent campaigns for the propose-side campaign-reference validator
    // — child rows whose campaign_name doesn't resolve to a snapshot or NEW
    // campaign are rejected so Editor "Zweideutiger Zeilentyp" cannot reach
    // import. Tests need at least one matching campaign per common payload.
    store.insertCampaignsBatch({
      runId, adsAccountId: ACCOUNT,
      rows: [
        { campaignId: 'cmp-c', campaignName: 'C', status: 'ENABLED', channelType: 'SEARCH' },
        { campaignId: 'cmp-pmax', campaignName: 'PMAX-Drills', status: 'ENABLED', channelType: 'PERFORMANCE_MAX' },
      ],
    });
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects unknown account', async () => {
    const out = await tool.handler({
      ads_account_id: 'no-such', entity_type: 'asset', kind: 'NEW',
      payload: { campaign_name: 'C', asset_group_name: 'AG', field_type: 'HEADLINE' },
      confidence: 0.8, rationale: 'enough rationale',
    }, fakeAgent);
    expect(out).toMatch(/unknown ads_account_id/);
  });

  it('rejects when customer profile missing', async () => {
    type RawDb = { db?: { prepare(sql: string): { run(...args: unknown[]): unknown }; pragma(s: string): unknown } };
    const raw = store as unknown as RawDb;
    raw.db?.pragma('foreign_keys = OFF');
    raw.db?.prepare('DELETE FROM customer_profiles WHERE customer_id = ?').run(CUSTOMER);
    raw.db?.pragma('foreign_keys = ON');
    const out = await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'asset', kind: 'NEW',
      payload: { campaign_name: 'C', asset_group_name: 'AG', field_type: 'HEADLINE' },
      confidence: 0.8, rationale: 'enough rationale',
    }, fakeAgent);
    expect(out).toMatch(/customer profile missing/);
  });

  it('rejects invalid confidence', async () => {
    const out = await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'rsa_ad', kind: 'NEW',
      payload: { campaign_name: 'C', ad_group_name: 'AG', final_url: 'https://x', headlines: [], descriptions: [] },
      confidence: 1.5, rationale: 'reasonable',
    }, fakeAgent);
    expect(out).toMatch(/confidence must be/);
  });

  it('rejects too-short rationale', async () => {
    const out = await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'asset', kind: 'NEW',
      payload: { campaign_name: 'C', asset_group_name: 'AG', field_type: 'HEADLINE' },
      confidence: 0.8, rationale: 'no',
    }, fakeAgent);
    expect(out).toMatch(/rationale must be/);
  });

  it('rejects RSA without enough headlines', async () => {
    const out = await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'rsa_ad', kind: 'NEW',
      payload: {
        campaign_name: 'C', ad_group_name: 'AG', final_url: 'https://example.com',
        headlines: ['only', 'two'], descriptions: ['d1', 'd2'],
      },
      confidence: 0.8, rationale: 'enough rationale here',
    }, fakeAgent);
    expect(out).toMatch(/headlines/);
  });

  it('persists a NEW asset proposal as source=agent', async () => {
    const out = await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'asset', kind: 'NEW',
      payload: {
        campaign_name: 'PMAX-Drills',
        asset_group_name: 'AG-Power',
        field_type: 'HEADLINE',
        index: 6,
        text: 'Profi Bohrhammer',
      },
      confidence: 0.85, rationale: 'DataForSEO zeigt long-tail Lücke für Profi-Bohrer',
    }, fakeAgent);
    expect(out).toMatch(/Blueprint-Vorschlag aufgenommen/);
    const stored = store.listBlueprintEntities(runId, { entityType: 'asset' });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.source).toBe('agent');
    expect(stored[0]?.kind).toBe('NEW');
    expect(JSON.parse(stored[0]!.payload_json)).toMatchObject({ field_type: 'HEADLINE', text: 'Profi Bohrhammer' });
  });

  it('rejects asset_group whose campaign_name does not exist in snapshot', async () => {
    // Reproduces the aquanatura cycle-5 bug: agent typed "PMax" instead of
    // "PMAX-Drills"; emit produced a row Editor classifies as "Zweideutiger
    // Zeilentyp". Propose-side check must catch the typo before persist.
    const out = await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'asset_group', kind: 'NEW',
      payload: { campaign_name: 'PMax', asset_group_name: 'Wasserkefir', final_url: 'https://example.com' },
      confidence: 0.9, rationale: 'theme expansion under the existing PMax campaign',
    }, fakeAgent);
    expect(out).toMatch(/not found in run/i);
    expect(out).toMatch(/Closest match: "PMAX-Drills"/);
    // Nothing persisted.
    expect(store.listBlueprintEntities(runId, { entityType: 'asset_group' })).toHaveLength(0);
  });

  it('accepts child entity referencing a NEW campaign proposed in the same run', async () => {
    // Propose a new campaign first, then a child asset_group referencing it.
    // Both must persist — the validator should consult both snapshot AND
    // pending NEW campaigns when resolving the parent.
    await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'campaign', kind: 'NEW',
      payload: { campaign_name: 'PMax-Refresh', channel_type: 'PERFORMANCE_MAX', budget_chf: 30 },
      confidence: 0.9, rationale: 'fresh PMax campaign for refresh-water vertical',
    }, fakeAgent);
    const out = await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'asset_group', kind: 'NEW',
      payload: { campaign_name: 'PMax-Refresh', asset_group_name: 'AG-Refresh', final_url: 'https://example.com' },
      confidence: 0.9, rationale: 'first asset_group of the new PMax campaign',
    }, fakeAgent);
    expect(out).toMatch(/Blueprint-Vorschlag aufgenommen/);
  });

  it('upserts when caller supplies an explicit external_id (idempotent revision)', async () => {
    const input = {
      ads_account_id: ACCOUNT, entity_type: 'asset' as const, kind: 'NEW' as const,
      external_id: 'agent.asset.ag.headline.1',
      payload: { campaign_name: 'PMAX-Drills', asset_group_name: 'AG', field_type: 'HEADLINE', index: 1, text: 'v1' },
      confidence: 0.7, rationale: 'first take of headline draft',
    };
    await tool.handler(input, fakeAgent);
    await tool.handler({
      ...input, payload: { ...input.payload, text: 'v2' },
      rationale: 'revised after LP-crawl review',
    }, fakeAgent);
    const rows = store.listBlueprintEntities(runId, { entityType: 'asset' });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload_json).text).toBe('v2');
  });

  it('auto-derived external_ids treat different text as different assets', async () => {
    const base = {
      ads_account_id: ACCOUNT, entity_type: 'asset' as const, kind: 'NEW' as const,
      payload: { campaign_name: 'PMAX-Drills', asset_group_name: 'AG', field_type: 'HEADLINE', index: 1, text: 'first' },
      confidence: 0.8, rationale: 'first variant',
    };
    await tool.handler(base, fakeAgent);
    await tool.handler({ ...base, payload: { ...base.payload, text: 'second' } }, fakeAgent);
    expect(store.listBlueprintEntities(runId, { entityType: 'asset' })).toHaveLength(2);
  });

  it('blocks PMAX SPLIT above conv-floor when confidence < 0.9', async () => {
    // 50 conv / 30d puts the asset-group above the strict floor; below-
    // floor splits intentionally bypass the confidence gate (see
    // ads-pmax-restructure tests for the permissive case).
    seedAssetGroup(store, runId, { conversions: 50 });
    setLastImport(store, '2026-04-01T00:00:00Z');
    const out = await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'asset_group', kind: 'SPLIT',
      payload: { campaign_name: 'PMAX-Drills', asset_group_name: 'AG-Mixed' },
      source_external_ids: ['ag1'], proposed_external_ids: ['ag1a', 'ag1b'],
      confidence: 0.85, rationale: 'Split mixed group into power + cordless because LP themes differ.',
    }, fakeAgent);
    expect(out).toMatch(/blocked/i);
    expect(out).toMatch(/Confidence/);
  });

  it('allows PMAX SPLIT when all safeguards pass', async () => {
    seedAssetGroup(store, runId, { conversions: 5 });
    setLastImport(store, '2026-04-01T00:00:00Z'); // > 14d ago vs 2026-04-28

    const out = await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'asset_group', kind: 'SPLIT',
      payload: { campaign_name: 'PMAX-Drills', asset_group_name: 'AG-Power' },
      source_external_ids: ['ag1'], proposed_external_ids: ['ag1a', 'ag1b'],
      confidence: 0.95,
      rationale: 'GA4 zeigt zwei distinkte Conversion-Pfade auf separaten LP-Themen — sauberer Split.',
    }, fakeAgent);
    expect(out).toMatch(/Blueprint-Vorschlag aufgenommen/);
    const rows = store.listBlueprintEntities(runId, { entityType: 'asset_group', kind: 'SPLIT' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confidence).toBe(0.95);
    expect(rows[0]?.previous_external_id).toBe('ag1');
  });

  it('blocks PMAX SPLIT for high-volume asset-group without explicit rationale', async () => {
    seedAssetGroup(store, runId, { conversions: 50 });
    setLastImport(store, '2026-04-01T00:00:00Z');
    const out = await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'asset_group', kind: 'SPLIT',
      payload: { campaign_name: 'PMAX-Drills', asset_group_name: 'AG' },
      source_external_ids: ['ag1'], proposed_external_ids: ['a', 'b'],
      confidence: 0.95, rationale: 'short',
    }, fakeAgent);
    expect(out).toMatch(/blocked/i);
    expect(out).toMatch(/Begründung/);
  });

  it('flags naming-violation on KEEP campaign even when persisted', async () => {
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme',
      languages: ['DE'],
      namingConventionPattern: '{LANG}-{CHANNEL}-{THEME}-{MATCHTYPE}',
    });
    const out = await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'campaign', kind: 'NEW',
      payload: { campaign_name: 'wrong_name_format' },
      confidence: 0.9, rationale: 'reasonable rationale here',
    }, fakeAgent);
    expect(out).toMatch(/Blueprint-Vorschlag aufgenommen/);
    const rows = store.listBlueprintEntities(runId, { entityType: 'campaign' });
    expect(rows[0]?.naming_valid).toBe(0);
  });

  it('writes companion ads_run_decisions row', async () => {
    await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'sitelink', kind: 'NEW',
      payload: { campaign_name: 'C', text: 'Shop now', final_url: 'https://example.com/shop' },
      confidence: 0.9, rationale: 'Adds missing CTA sitelink for traffic split',
    }, fakeAgent);
    const decisions = store.getRunDecisions(runId, { entityType: 'sitelink' });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe('NEW');
  });
});

describe('ads_blueprint_run preserves agent additions on re-run', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let tool: ReturnType<typeof createAdsBlueprintEntityProposeTool>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-bp-rerun-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    tool = createAdsBlueprintEntityProposeTool(store);
    seedAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    store.insertCampaignsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'c1', campaignName: 'C1', status: 'ENABLED' }],
    });
    runBlueprint(store, ACCOUNT);
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('a re-run wipes deterministic rows but keeps agent additions', async () => {
    // Add an agent proposal.
    await tool.handler({
      ads_account_id: ACCOUNT, entity_type: 'asset', kind: 'NEW',
      payload: { campaign_name: 'C1', asset_group_name: 'AG-A', field_type: 'HEADLINE', index: 1, text: 'h1' },
      confidence: 0.85, rationale: 'agent-proposed headline based on DataForSEO research',
    }, fakeAgent);

    const beforeRerun = store.listBlueprintEntities(
      store.getLatestSuccessfulAuditRun(ACCOUNT)!.run_id,
    );
    const detBefore = beforeRerun.filter(e => e.source === 'deterministic').length;
    const agentBefore = beforeRerun.filter(e => e.source === 'agent').length;
    expect(detBefore).toBeGreaterThan(0);
    expect(agentBefore).toBe(1);

    // Re-run blueprint.
    runBlueprint(store, ACCOUNT);

    const afterRerun = store.listBlueprintEntities(
      store.getLatestSuccessfulAuditRun(ACCOUNT)!.run_id,
    );
    const detAfter = afterRerun.filter(e => e.source === 'deterministic').length;
    const agentAfter = afterRerun.filter(e => e.source === 'agent').length;
    expect(detAfter).toBe(detBefore);   // re-written, not duplicated
    expect(agentAfter).toBe(1);          // preserved
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

function seedAccount(store: AdsDataStore): void {
  store.upsertCustomerProfile({
    customerId: CUSTOMER, clientName: 'Acme Shop',
    languages: ['DE'], pmaxOwnedHeadTerms: ['drills'], primaryGoal: 'roas',
  });
  store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
}

function seedAssetGroup(store: AdsDataStore, runId: number, opts?: { conversions?: number | undefined } | undefined): void {
  store.insertAssetGroupsBatch({
    runId, adsAccountId: ACCOUNT,
    rows: [{
      assetGroupId: 'ag1', assetGroupName: 'AG-Power',
      campaignName: 'PMAX-Drills', adStrength: 'GOOD',
      ...(opts?.conversions !== undefined ? { conversions: opts.conversions } : {}),
    }],
  });
}

function setLastImport(store: AdsDataStore, iso: string): void {
  store.setLastMajorImportAt(ACCOUNT, iso);
}
