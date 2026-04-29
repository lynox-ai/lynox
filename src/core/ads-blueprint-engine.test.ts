import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from './ads-data-store.js';
import { runBlueprint, BlueprintPreconditionError } from './ads-blueprint-engine.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';

describe('runBlueprint', () => {
  let tempDir: string;
  let store: AdsDataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-blueprint-test-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('throws when account is unknown', () => {
    expect(() => runBlueprint(store, 'no-such')).toThrow(BlueprintPreconditionError);
  });

  it('throws when no successful audit run exists', () => {
    seedCustomerAndAccount(store);
    store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    // Run is RUNNING, not SUCCESS.
    expect(() => runBlueprint(store, ACCOUNT)).toThrow(BlueprintPreconditionError);
  });

  it('throws when customer profile is missing', () => {
    store.upsertCustomerProfile({ customerId: CUSTOMER, clientName: 'Acme' });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    // Drop profile to simulate missing-profile path. Disabling FKs is
    // intentional here for this fixture only.
    type RawDb = { db?: { prepare(sql: string): { run(...args: unknown[]): unknown }; pragma(s: string): unknown } };
    const raw = store as unknown as RawDb;
    raw.db?.pragma('foreign_keys = OFF');
    raw.db?.prepare('DELETE FROM customer_profiles WHERE customer_id = ?').run(CUSTOMER);
    raw.db?.pragma('foreign_keys = ON');

    expect(() => runBlueprint(store, ACCOUNT)).toThrow(/Customer profile missing/);
  });

  it('runs in BOOTSTRAP mode for first cycle: every snapshot entity becomes KEEP', () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'c1', 'DE-Search-Brand-Exact');
    seedCampaign(store, r.run_id, 'c2', 'DE-Search-Generic-Phrase');

    const result = runBlueprint(store, ACCOUNT);
    expect(result.mode).toBe('BOOTSTRAP');
    expect(result.previousRun).toBeNull();
    const campaigns = result.historyByType.get('campaign')!;
    expect(campaigns).toHaveLength(2);
    expect(campaigns.every(d => d.kind === 'KEEP')).toBe(true);
    // Persisted to ads_blueprint_entities + ads_run_decisions.
    expect(store.listBlueprintEntities(r.run_id, { entityType: 'campaign' })).toHaveLength(2);
    expect(store.getRunDecisions(r.run_id, { entityType: 'campaign' })).toHaveLength(2);
  });

  it('throws BlueprintPendingImportNotice when previous run has unimported entities', async () => {
    const { BlueprintPendingImportNotice } = await import('./ads-blueprint-engine.js');
    seedCustomerAndAccount(store, { competitors: ['Bosch', 'Dewalt'] });
    const r1 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r1.run_id);
    seedCampaign(store, r1.run_id, 'c1', 'DE-Search-Brand-Exact');
    // First blueprint inserts KEEP + 2 NEW competitor negatives — pending > 0.
    runBlueprint(store, ACCOUNT);

    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    seedCampaign(store, r2.run_id, 'c1', 'DE-Search-Brand-Exact');
    seedPerformanceDays(store, r2.run_id, 'c1', 30);

    // No import recorded → pending guard must trigger.
    expect(() => runBlueprint(store, ACCOUNT)).toThrow(BlueprintPendingImportNotice);
  });

  it('skips pending guard once a major import is recorded after the previous blueprint', () => {
    seedCustomerAndAccount(store, { competitors: ['Bosch', 'Dewalt'] });
    const r1 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r1.run_id);
    seedCampaign(store, r1.run_id, 'c1', 'DE-Search-Brand-Exact');
    runBlueprint(store, ACCOUNT);

    // Record import strictly after run #1's finished_at.
    store.recordMajorImport(ACCOUNT, new Date(Date.now() + 1000).toISOString());

    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    seedCampaign(store, r2.run_id, 'c1', 'DE-Search-Brand-Exact');
    seedPerformanceDays(store, r2.run_id, 'c1', 30);

    expect(() => runBlueprint(store, ACCOUNT)).not.toThrow();
  });

  it('runs in OPTIMIZE mode: history-match across runs', () => {
    seedCustomerAndAccount(store);
    const r1 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r1.run_id);
    seedCampaign(store, r1.run_id, 'c1', 'DE-Search-Brand-Exact');
    seedCampaign(store, r1.run_id, 'c2', 'DE-Search-Generic-Phrase');

    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    seedCampaign(store, r2.run_id, 'c1', 'DE-Search-Brand-Exact');           // KEEP
    seedCampaign(store, r2.run_id, 'c3', 'DE-Search-Awareness-Phrase');       // NEW
    // c2 absent → PAUSE
    // pickMode requires ≥ 30 perf-days on the current run to clear OPTIMIZE.
    seedPerformanceDays(store, r2.run_id, 'c1', 30);

    const result = runBlueprint(store, ACCOUNT);
    expect(result.mode).toBe('OPTIMIZE');
    const campaigns = result.historyByType.get('campaign')!;
    const kinds = campaigns.map(d => d.kind).sort();
    expect(kinds).toEqual(['KEEP', 'NEW', 'PAUSE']);
  });

  it('flags naming-convention violations on KEEP entities', () => {
    seedCustomerAndAccount(store, { naming: '{LANG}-{CHANNEL}-{THEME}-{MATCHTYPE}' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'c1', 'DE-Search-Brand-Exact');               // valid
    seedCampaign(store, r.run_id, 'c2', 'just_some_random_name');               // invalid

    const result = runBlueprint(store, ACCOUNT);
    expect(result.namingViolations).toHaveLength(1);
    expect(result.namingViolations[0]?.externalId).toBe('c2');
    // The naming-error column on the bad blueprint row reflects this.
    const stored = store.listBlueprintEntities(r.run_id, { entityType: 'campaign' });
    const c2Row = stored.find(s => s.external_id === 'c2');
    expect(c2Row?.naming_valid).toBe(0);
    expect(JSON.parse(c2Row!.naming_errors_json).length).toBeGreaterThan(0);
  });

  it('does not enforce naming convention on keywords', () => {
    seedCustomerAndAccount(store, { naming: '{LANG}-{CHANNEL}-{THEME}-{MATCHTYPE}' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    store.insertKeywordsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { keyword: 'beste schraubenzieher', matchType: 'PHRASE', campaignName: 'C', adGroupName: 'AG' },
      ],
    });
    const result = runBlueprint(store, ACCOUNT);
    expect(result.namingViolations.find(v => v.entityType === 'keyword')).toBeUndefined();
  });

  it('persists generated negatives as NEW entity_type=negative rows', () => {
    seedCustomerAndAccount(store, {
      pmaxOwned: ['drills', 'sanders'],
      competitors: ['BoschTools'],
      goal: 'roas',
    });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);

    const result = runBlueprint(store, ACCOUNT);
    expect(result.negatives.length).toBeGreaterThan(0);
    const negativeRows = store.listBlueprintEntities(r.run_id, { entityType: 'negative' });
    expect(negativeRows.length).toBe(result.negatives.length);
    expect(negativeRows.every(n => n.kind === 'NEW')).toBe(true);
  });

  it('counts KEEP/NEW/PAUSE/RENAME correctly via store.countBlueprintEntities', () => {
    seedCustomerAndAccount(store);
    const r1 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r1.run_id);
    seedCampaign(store, r1.run_id, 'c1', 'DE-Search-Brand-Exact');

    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    seedCampaign(store, r2.run_id, 'c1', 'DE-Search-Brand-Exact');            // KEEP
    seedCampaign(store, r2.run_id, 'c2', 'DE-Search-Generic-Exact');          // NEW
    seedPerformanceDays(store, r2.run_id, 'c1', 30);

    const result = runBlueprint(store, ACCOUNT);
    expect(result.counts.KEEP).toBe(1);
    expect(result.counts.NEW).toBe(1);
    // No others yet.
    expect(result.counts.PAUSE).toBe(0);
    expect(result.counts.RENAME).toBe(0);
  });

  it('surfaces low-strength asset groups in result', () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    store.insertAssetGroupsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { assetGroupId: 'ag1', assetGroupName: 'Strong', adStrength: 'EXCELLENT', costMicros: 50_000_000 },
        { assetGroupId: 'ag2', assetGroupName: 'Weak', adStrength: 'POOR', costMicros: 30_000_000 },
      ],
    });
    const result = runBlueprint(store, ACCOUNT);
    expect(result.lowStrengthAssetGroups.map(a => a.externalId)).toEqual(['ag2']);
  });

  it('writes ads_run_decisions parallel to ads_blueprint_entities', () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'c1', 'DE-Search-Brand-Exact');

    runBlueprint(store, ACCOUNT);
    const decisions = store.getRunDecisions(r.run_id);
    expect(decisions).toHaveLength(1); // 1 campaign, no negatives (no profile pmax_owned)
    expect(decisions[0]?.entity_external_id).toBe('c1');
    expect(decisions[0]?.decision).toBe('KEEP');
  });

  it('drops orphan ad_group / keyword / asset_group whose campaign is not in the snapshot', () => {
    // Real-world data exposes parents in REMOVED state filtered by GAS
    // while children remained ENABLED — the orphan filter must drop
    // these or emit's cross-reference HARD validator blocks the run.
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'c1', 'Real-Campaign');
    store.insertAdGroupsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { campaignName: 'Real-Campaign', adGroupName: 'AG-real', adGroupId: 'agR' },
        { campaignName: 'REMOVED-PARENT', adGroupName: 'AG-orphan', adGroupId: 'agO' },
      ],
    });
    store.insertKeywordsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { keyword: 'real-kw', matchType: 'EXACT', campaignName: 'Real-Campaign', adGroupName: 'AG-real' },
        { keyword: 'orphan-kw', matchType: 'EXACT', campaignName: 'REMOVED-PARENT', adGroupName: 'AG-orphan' },
      ],
    });
    store.insertAssetGroupsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { assetGroupId: 'agg-real', assetGroupName: 'AG-Real', campaignName: 'Real-Campaign' },
        { assetGroupId: 'agg-orphan', assetGroupName: 'AG-Orphan', campaignName: 'REMOVED-PARENT' },
      ],
    });

    const result = runBlueprint(store, ACCOUNT);
    const adGroupIds = result.historyByType.get('ad_group')!.map(d => d.externalId);
    const keywordRows = result.historyByType.get('keyword')!;
    const assetGroupIds = result.historyByType.get('asset_group')!.map(d => d.externalId);
    expect(adGroupIds).toEqual(['agR']);
    expect(keywordRows).toHaveLength(1);
    expect((keywordRows[0]?.payload as { keyword?: string } | undefined)?.keyword).toBe('real-kw');
    expect(assetGroupIds).toEqual(['agg-real']);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

function seedCustomerAndAccount(
  store: AdsDataStore,
  opts?: {
    naming?: string | undefined;
    pmaxOwned?: readonly string[] | undefined;
    competitors?: readonly string[] | undefined;
    goal?: string | undefined;
  } | undefined,
): void {
  store.upsertCustomerProfile({
    customerId: CUSTOMER, clientName: 'Acme Shop',
    languages: ['DE'],
    ...(opts?.naming !== undefined ? { namingConventionPattern: opts.naming } : {}),
    ...(opts?.pmaxOwned !== undefined ? { pmaxOwnedHeadTerms: opts.pmaxOwned } : {}),
    ...(opts?.competitors !== undefined ? { competitors: opts.competitors } : {}),
    ...(opts?.goal !== undefined ? { primaryGoal: opts.goal } : {}),
  });
  store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
}

function seedCampaign(store: AdsDataStore, runId: number, id: string, name: string): void {
  store.insertCampaignsBatch({
    runId, adsAccountId: ACCOUNT,
    rows: [{ campaignId: id, campaignName: name, status: 'ENABLED' }],
  });
}

/** Seed `days` distinct daily perf rows so pickMode evaluates OPTIMIZE
 *  (≥ 30 distinct dates needed). Day 0 = 2026-01-01. */
function seedPerformanceDays(store: AdsDataStore, runId: number, campaignId: string, days: number): void {
  const rows = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    rows.push({ date: d, campaignId, clicks: 10, conversions: 1 });
  }
  store.insertCampaignPerformanceBatch({ runId, adsAccountId: ACCOUNT, rows });
}
