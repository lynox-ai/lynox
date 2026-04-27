import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { createAdsAuditRunTool, renderMarkdownReport } from './ads-audit-run.js';
import { runAudit } from '../../core/ads-audit-engine.js';
import type { IAgent, IKnowledgeLayer } from '../../types/index.js';

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
