import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { createAdsBlueprintRunTool, renderBlueprintReport } from './ads-blueprint-run.js';
import { runBlueprint } from '../../core/ads-blueprint-engine.js';
import type { IAgent } from '../../types/index.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';

const fakeAgent = { toolContext: { knowledgeLayer: null } } as unknown as IAgent;

describe('ads_blueprint_run tool', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let tool: ReturnType<typeof createAdsBlueprintRunTool>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-blueprint-tool-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    tool = createAdsBlueprintRunTool(store);
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns an error string for unknown account', async () => {
    const result = await tool.handler({ ads_account_id: 'nope' }, fakeAgent);
    expect(result).toMatch(/^ads_blueprint_run failed:/);
  });

  it('returns error when audit not yet run', async () => {
    store.upsertCustomerProfile({ customerId: CUSTOMER, clientName: 'Acme' });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const result = await tool.handler({ ads_account_id: ACCOUNT }, fakeAgent);
    expect(result).toMatch(/No successful audit run/);
  });

  it('returns error when customer profile missing', async () => {
    store.upsertCustomerProfile({ customerId: CUSTOMER, clientName: 'Acme' });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    type RawDb = { db?: { prepare(sql: string): { run(...args: unknown[]): unknown }; pragma(s: string): unknown } };
    const raw = store as unknown as RawDb;
    raw.db?.pragma('foreign_keys = OFF');
    raw.db?.prepare('DELETE FROM customer_profiles WHERE customer_id = ?').run(CUSTOMER);
    raw.db?.pragma('foreign_keys = ON');

    const result = await tool.handler({ ads_account_id: ACCOUNT }, fakeAgent);
    expect(result).toMatch(/Customer profile missing/);
  });

  it('produces a Markdown report with all section headers', async () => {
    seedFullScenario(store);
    const result = await tool.handler({ ads_account_id: ACCOUNT }, fakeAgent);
    expect(result).toMatch(/^# Blueprint Report/);
    expect(result).toMatch(/## Mode-Gate/);
    expect(result).toMatch(/## History-Preservation/);
    expect(result).toMatch(/## Negative-Keyword-Proposals/);
    expect(result).toMatch(/## Nächste Schritte/);
  });

  it('persists entities to ads_blueprint_entities + ads_run_decisions', async () => {
    seedFullScenario(store);
    await tool.handler({ ads_account_id: ACCOUNT }, fakeAgent);
    const run = store.getLatestSuccessfulAuditRun(ACCOUNT)!;
    expect(store.listBlueprintEntities(run.run_id).length).toBeGreaterThan(0);
    expect(store.getRunDecisions(run.run_id).length).toBeGreaterThan(0);
  });

  it('passes waste_spend_threshold_chf through to engine', async () => {
    // Seed a wasted term at 3 CHF spend — included at threshold=1, excluded at default(5).
    seedFullScenario(store);
    store.insertSearchTermsBatch({
      runId: store.getLatestSuccessfulAuditRun(ACCOUNT)!.run_id,
      adsAccountId: ACCOUNT,
      rows: [{ searchTerm: 'gizmo', campaignName: 'DE-Search-Brand-Exact', costMicros: 3_000_000, conversions: 0 }],
    });
    await tool.handler({ ads_account_id: ACCOUNT, waste_spend_threshold_chf: 1 }, fakeAgent);
    const run = store.getLatestSuccessfulAuditRun(ACCOUNT)!;
    const negs = store.listBlueprintEntities(run.run_id, { entityType: 'negative' });
    expect(negs.some(n => JSON.parse(n.payload_json).source === 'cross_campaign')).toBe(true);
  });
});

describe('renderBlueprintReport', () => {
  let tempDir: string;
  let store: AdsDataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-blueprint-render-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('shows BOOTSTRAP banner on first cycle', () => {
    seedFullScenario(store);
    const r = runBlueprint(store, ACCOUNT);
    const md = renderBlueprintReport(r);
    expect(md).toMatch(/🟡 \*\*BOOTSTRAP\*\*/);
  });

  it('renders naming-violations section when present', () => {
    seedFullScenario(store, { naming: '{LANG}-{CHANNEL}-{THEME}-{MATCHTYPE}', extraBadCampaign: true });
    const r = runBlueprint(store, ACCOUNT);
    const md = renderBlueprintReport(r);
    expect(md).toMatch(/Naming-Konventions-Verstösse/);
  });

  it('omits naming-violations section when none', () => {
    seedFullScenario(store);
    const r = runBlueprint(store, ACCOUNT);
    const md = renderBlueprintReport(r);
    expect(md).not.toMatch(/Naming-Konventions-Verstösse/);
  });

  it('shows cross_campaign top-10 table when those negatives exist', () => {
    seedFullScenario(store, { withWastedTerm: true });
    const r = runBlueprint(store, ACCOUNT);
    const md = renderBlueprintReport(r);
    expect(md).toMatch(/cross_campaign Top 10/);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

function seedFullScenario(
  store: AdsDataStore,
  opts?: {
    naming?: string | undefined;
    extraBadCampaign?: boolean | undefined;
    withWastedTerm?: boolean | undefined;
  } | undefined,
): void {
  store.upsertCustomerProfile({
    customerId: CUSTOMER, clientName: 'Acme Shop',
    languages: ['DE'],
    pmaxOwnedHeadTerms: ['drills'],
    competitors: ['BoschTools'],
    primaryGoal: 'roas',
    ...(opts?.naming !== undefined ? { namingConventionPattern: opts.naming } : {}),
  });
  store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
  const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
  store.completeAuditRun(r.run_id);
  store.insertCampaignsBatch({
    runId: r.run_id, adsAccountId: ACCOUNT,
    rows: [{ campaignId: 'c1', campaignName: 'DE-Search-Brand-Exact', status: 'ENABLED' }],
  });
  if (opts?.extraBadCampaign) {
    store.insertCampaignsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{ campaignId: 'c2', campaignName: 'wrong_naming_format', status: 'ENABLED' }],
    });
  }
  if (opts?.withWastedTerm) {
    store.insertSearchTermsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { searchTerm: 'gizmo kaufen', campaignName: 'DE-Search-Brand-Exact', costMicros: 10_000_000, conversions: 0 },
      ],
    });
  }
}
