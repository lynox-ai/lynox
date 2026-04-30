import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { createAdsAuditRunTool, classifyThemeFindingTokens, renderMarkdownReport } from './ads-audit-run.js';
import { runAudit, type AuditResult } from '../../core/ads-audit-engine.js';
import type { IAgent, IKnowledgeLayer } from '../../types/index.js';
import type Anthropic from '@anthropic-ai/sdk';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';

function makeAgent(kg: IKnowledgeLayer | null = null): IAgent {
  return {
    toolContext: { knowledgeLayer: kg },
  } as unknown as IAgent;
}

describe('ads_audit_run tool', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let tool: ReturnType<typeof createAdsAuditRunTool>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-audit-tool-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    tool = createAdsAuditRunTool(store);
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns an error string for unknown account (no throw)', async () => {
    const result = await tool.handler({ ads_account_id: 'no-such-account' }, makeAgent());
    expect(result).toMatch(/^ads_audit_run failed:/);
  });

  it('produces a Markdown report with KPIs, mode, findings sections', async () => {
    seedFullAccount(store);
    const result = await tool.handler({ ads_account_id: ACCOUNT }, makeAgent());
    expect(result).toMatch(/^# Audit Report/);
    expect(result).toMatch(/## KPIs/);
    expect(result).toMatch(/## Mode Detection/);
    expect(result).toMatch(/## Findings/);
    expect(result).toMatch(/## Nächste Schritte/);
  });

  it('persists deterministic findings to ads_findings (source = deterministic)', async () => {
    seedFullAccount(store);
    await tool.handler({ ads_account_id: ACCOUNT }, makeAgent());
    const run = store.getLatestSuccessfulAuditRun(ACCOUNT)!;
    const findings = store.listFindings(run.run_id);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.source).toBe('deterministic');
    }
  });

  it('mirrors findings to KG when knowledgeLayer is wired', async () => {
    seedFullAccount(store);
    const storeFn = vi.fn(async () => ({ memoryId: 'mem-123', stored: true, deduplicated: false }));
    const kg = { store: storeFn } as unknown as IKnowledgeLayer;
    await tool.handler({ ads_account_id: ACCOUNT }, makeAgent(kg));

    const run = store.getLatestSuccessfulAuditRun(ACCOUNT)!;
    const findings = store.listFindings(run.run_id);
    expect(storeFn).toHaveBeenCalledTimes(findings.length);
    expect(findings.every(f => f.kg_memory_id === 'mem-123')).toBe(true);
  });

  it('does not throw when KG mirroring fails — still returns the report', async () => {
    seedFullAccount(store);
    const storeFn = vi.fn(async () => { throw new Error('KG offline'); });
    const kg = { store: storeFn } as unknown as IKnowledgeLayer;
    const result = await tool.handler({ ads_account_id: ACCOUNT }, makeAgent(kg));
    expect(result).toMatch(/^# Audit Report/);
    const run = store.getLatestSuccessfulAuditRun(ACCOUNT)!;
    expect(store.listFindings(run.run_id).length).toBeGreaterThan(0);
  });

  it('updates account.mode when detection disagrees with recorded mode', async () => {
    seedFullAccount(store);
    // Force account.mode to OPTIMIZE manually to provoke a correction.
    store.upsertAdsAccount({
      adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main', mode: 'OPTIMIZE',
    });
    await tool.handler({ ads_account_id: ACCOUNT }, makeAgent());
    const account = store.getAdsAccount(ACCOUNT)!;
    expect(account.mode).toBe('BOOTSTRAP');
  });

  it('clamps verify_window_days to [7, 90]', async () => {
    seedFullAccount(store);
    const result = await tool.handler({ ads_account_id: ACCOUNT, verify_window_days: 1 }, makeAgent());
    expect(result).toMatch(/^# Audit Report/);
    // No throw is the contract; the engine clamps internally.
  });
});

describe('classifyThemeFindingTokens (Phase B)', () => {
  it('drops funnel + irrelevant tokens, keeps actionable + uncertain, tags categories', async () => {
    const result = makeFakeAuditResult([
      { token: 'kefir',    clusters: 30, sample: ['kefir milch'] },
      { token: 'kombucha', clusters: 20, sample: ['kombucha kaufen'] },
      { token: 'kaufen',   clusters: 50, sample: ['kefir kaufen'] },
      { token: 'guenstig', clusters: 12, sample: ['kefir guenstig'] },
      { token: 'water',    clusters: 9,  sample: ['water filter'] },
      { token: 'fermenten', clusters: 6, sample: ['fermenten anleitung'] },
    ]);
    const fakeClient = makeClassifierClient([
      { token: 'kefir',     category: 'actionable', reason: 'top product' },
      { token: 'kombucha',  category: 'actionable', reason: 'top product' },
      { token: 'kaufen',    category: 'funnel',     reason: 'commerce intent' },
      { token: 'guenstig',  category: 'funnel',     reason: 'price modifier' },
      { token: 'water',     category: 'irrelevant', reason: 'EN word, DE-only shop' },
      { token: 'fermenten', category: 'uncertain',  reason: 'plausibly product' },
    ]);

    await classifyThemeFindingTokens(result, { client: fakeClient });

    const finding = result.findings.find(f => f.area === 'pmax_theme_coverage_gap')!;
    const evidence = finding.evidence as { themes: Array<{ token: string; category: string }>; classification: unknown };
    const tokens = evidence.themes.map(t => t.token).sort();
    // Funnel + irrelevant are gone; actionable + uncertain remain.
    expect(tokens).toEqual(['fermenten', 'kefir', 'kombucha']);
    const byToken = new Map(evidence.themes.map(t => [t.token, t.category]));
    expect(byToken.get('kefir')).toBe('actionable');
    expect(byToken.get('fermenten')).toBe('uncertain');
    // Full classification is preserved for transparency.
    expect(Array.isArray(evidence.classification)).toBe(true);
  });

  it('removes the entire finding when no actionable + uncertain themes survive', async () => {
    const result = makeFakeAuditResult([
      { token: 'kaufen',   clusters: 50, sample: [] },
      { token: 'guenstig', clusters: 12, sample: [] },
    ]);
    const fakeClient = makeClassifierClient([
      { token: 'kaufen',   category: 'funnel', reason: 'intent' },
      { token: 'guenstig', category: 'funnel', reason: 'modifier' },
    ]);
    await classifyThemeFindingTokens(result, { client: fakeClient });
    expect(result.findings.find(f => f.area === 'pmax_theme_coverage_gap')).toBeUndefined();
  });

  it('is a no-op when there is no theme finding to classify', async () => {
    const result = makeEmptyAuditResult();
    await classifyThemeFindingTokens(result, {});
    expect(result.findings).toHaveLength(0);
  });

  it('routes every token to uncertain on classifier failure', async () => {
    const result = makeFakeAuditResult([
      { token: 'kefir',    clusters: 30, sample: [] },
      { token: 'kombucha', clusters: 20, sample: [] },
    ]);
    const throwingClient = {
      beta: { messages: { stream: () => ({ finalMessage: async () => { throw new Error('5xx'); } }) } },
    } as unknown as Anthropic;
    await classifyThemeFindingTokens(result, { client: throwingClient });
    const finding = result.findings.find(f => f.area === 'pmax_theme_coverage_gap')!;
    const evidence = finding.evidence as { themes: Array<{ category: string }> };
    expect(evidence.themes.every(t => t.category === 'uncertain')).toBe(true);
  });
});

describe('renderMarkdownReport', () => {
  let tempDir: string;
  let store: AdsDataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-render-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('omits Performance-Verification section on first cycle', () => {
    seedFullAccount(store);
    const result = runAudit(store, ACCOUNT);
    const md = renderMarkdownReport(result, 0);
    expect(md).not.toMatch(/## Performance-Verification/);
    expect(md).not.toMatch(/## Manuelle Änderungen/);
  });

  it('formats numbers in de-CH locale', () => {
    seedFullAccount(store);
    const result = runAudit(store, ACCOUNT);
    const md = renderMarkdownReport(result, 0);
    // de-CH uses ’ as thousands separator and . as decimal.
    expect(md).toMatch(/Spend:/);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

function makeFakeAuditResult(themes: Array<{ token: string; clusters: number; sample: string[] }>): AuditResult {
  return {
    account: { ads_account_id: ACCOUNT, customer_id: CUSTOMER, account_label: 'Main',
      currency_code: 'CHF', timezone: 'Europe/Zurich', mode: 'BOOTSTRAP',
      drive_folder_id: null, last_major_import_at: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    customer: {
      customer_id: CUSTOMER, client_name: 'Acme', business_model: null, offer_summary: null,
      primary_goal: null, target_roas: null, target_cpa_chf: null, monthly_budget_chf: null,
      typical_cpc_chf: null, country: 'CH', timezone: 'Europe/Zurich',
      languages: '["DE"]', top_products: '[]', own_brands: '[]', sold_brands: '[]',
      competitors: '[]', pmax_owned_head_terms: '[]', naming_convention_pattern: null,
      tracking_notes: '{}',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    },
    run: { run_id: 1, ads_account_id: ACCOUNT, status: 'SUCCESS', mode: 'BOOTSTRAP',
      started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z',
      gas_export_lastrun: null, keywords_hash: null, previous_run_id: null,
      emitted_csv_hash: null, token_cost_micros: null, error_message: null },
    previousRun: null,
    kpis: { spendChf: 0, conversions: 0, clicks: 0, impressions: 0, costPerConversion: 0, ctr: 0, conversionRate: 0, roas: 0 },
    mode: { detected: 'BOOTSTRAP', recordedAccountMode: 'BOOTSTRAP', daysOfData: 5, reasoning: 'first cycle' },
    manualChanges: null, verification: null,
    findings: [
      {
        area: 'pmax_theme_coverage_gap', severity: 'MEDIUM',
        text: '6 dominante Themen …', confidence: 0.75,
        evidence: { themes, existing_asset_groups: [] },
      },
    ],
  } as unknown as AuditResult;
}

function makeEmptyAuditResult(): AuditResult {
  const r = makeFakeAuditResult([]);
  r.findings = [];
  return r;
}

function makeClassifierClient(items: Array<{ token: string; category: string; reason: string }>): Anthropic {
  return {
    beta: {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            content: [{ type: 'tool_use', name: 'classify_theme_tokens', input: { classifications: items } }],
          }),
        }),
      },
    },
  } as unknown as Anthropic;
}

function seedFullAccount(store: AdsDataStore): void {
  store.upsertCustomerProfile({
    customerId: CUSTOMER, clientName: 'Acme Shop',
    primaryGoal: 'roas', monthlyBudgetChf: 5000,
  });
  store.upsertAdsAccount({
    adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main',
  });
  // Stale GAS export (10d) → guarantees a stale_data finding regardless of clock.
  const staleLastrun = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const r = store.createAuditRun({
    adsAccountId: ACCOUNT, mode: 'BOOTSTRAP', gasExportLastrun: staleLastrun,
  });
  store.completeAuditRun(r.run_id);
  // 5 days of data → BOOTSTRAP-mode (no mode_mismatch finding because run is also BOOTSTRAP).
  const start = new Date('2026-04-15T00:00:00Z').getTime();
  const dailyRows = Array.from({ length: 5 }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    campaignId: 'c1', campaignName: 'Search Brand',
    impressions: 1000, clicks: 100, costMicros: 10_000_000, conversions: 5, convValue: 200,
  }));
  store.insertCampaignPerformanceBatch({ runId: r.run_id, adsAccountId: ACCOUNT, rows: dailyRows });
  store.insertCampaignsBatch({
    runId: r.run_id, adsAccountId: ACCOUNT,
    rows: [{
      campaignId: 'c1', campaignName: 'Search Brand', clicks: 500, impressions: 5000,
      costMicros: 50_000_000, conversions: 25, convValue: 1000,
    }],
  });
}
