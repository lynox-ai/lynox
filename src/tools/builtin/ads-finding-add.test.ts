import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { createAdsFindingAddTool } from './ads-finding-add.js';
import type { IAgent, IKnowledgeLayer } from '../../types/index.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';

function makeAgent(kg: IKnowledgeLayer | null = null): IAgent {
  return { toolContext: { knowledgeLayer: kg } } as unknown as IAgent;
}

describe('ads_finding_add tool', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let tool: ReturnType<typeof createAdsFindingAddTool>;
  let runId: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-finding-add-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    tool = createAdsFindingAddTool(store);

    store.upsertCustomerProfile({ customerId: CUSTOMER, clientName: 'Acme' });
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
    const out = await tool.handler({
      ads_account_id: 'no-such', area: 'keyword_gap', severity: 'MEDIUM',
      text: 'irrelevant', confidence: 0.7,
    }, makeAgent());
    expect(out).toMatch(/unknown ads_account_id/);
  });

  it('rejects invalid severity', async () => {
    const out = await tool.handler({
      ads_account_id: ACCOUNT, area: 'x', text: 'this is a finding',
      confidence: 0.5,
      // @ts-expect-error — invalid severity on purpose
      severity: 'CRITICAL',
    }, makeAgent());
    expect(out).toMatch(/severity must be/);
  });

  it('rejects out-of-range confidence', async () => {
    const out = await tool.handler({
      ads_account_id: ACCOUNT, area: 'x', severity: 'LOW',
      text: 'finding text', confidence: 1.5,
    }, makeAgent());
    expect(out).toMatch(/confidence must be/);
  });

  it('rejects too-long text', async () => {
    const out = await tool.handler({
      ads_account_id: ACCOUNT, area: 'x', severity: 'LOW',
      text: 'x'.repeat(5000), confidence: 0.5,
    }, makeAgent());
    expect(out).toMatch(/text too long/);
  });

  it('rejects oversized evidence', async () => {
    const evidence = { dump: 'y'.repeat(5000) };
    const out = await tool.handler({
      ads_account_id: ACCOUNT, area: 'x', severity: 'LOW',
      text: 'short text', confidence: 0.5, evidence,
    }, makeAgent());
    expect(out).toMatch(/evidence too large/);
  });

  it('persists a valid finding (source = agent) on the latest successful run', async () => {
    const out = await tool.handler({
      ads_account_id: ACCOUNT, area: 'keyword_gap', severity: 'MEDIUM',
      text: 'DataForSEO shows we miss "long tail X" with 1200 monthly searches',
      confidence: 0.78,
      evidence: { dataforseo_query: 'long tail X', monthly_search: 1200 },
    }, makeAgent());

    expect(out).toMatch(/^Finding aufgenommen/);
    const findings = store.listFindings(runId);
    expect(findings.length).toBe(1);
    expect(findings[0]?.source).toBe('agent');
    expect(findings[0]?.severity).toBe('MEDIUM');
    expect(findings[0]?.area).toBe('keyword_gap');
  });

  it('mirrors to KG when knowledgeLayer is wired and stores the memoryId back', async () => {
    const storeFn = vi.fn(async () => ({ memoryId: 'mem-xyz', stored: true, deduplicated: false }));
    const kg = { store: storeFn } as unknown as IKnowledgeLayer;
    await tool.handler({
      ads_account_id: ACCOUNT, area: 'x', severity: 'LOW',
      text: 'enough text here', confidence: 0.5,
    }, makeAgent(kg));
    expect(storeFn).toHaveBeenCalledOnce();
    const findings = store.listFindings(runId);
    expect(findings[0]?.kg_memory_id).toBe('mem-xyz');
  });

  it('targets explicit run_id when provided', async () => {
    const out = await tool.handler({
      ads_account_id: ACCOUNT, area: 'x', severity: 'LOW',
      text: 'enough text here', confidence: 0.5, run_id: runId,
    }, makeAgent());
    expect(out).toMatch(new RegExp(`Run ${runId}`));
  });

  it('rejects run_id from a different account', async () => {
    store.upsertCustomerProfile({ customerId: 'other', clientName: 'Other' });
    store.upsertAdsAccount({ adsAccountId: 'other-acc', customerId: 'other', accountLabel: 'Other' });
    const otherRun = store.createAuditRun({ adsAccountId: 'other-acc', mode: 'BOOTSTRAP' });
    store.completeAuditRun(otherRun.run_id);

    const out = await tool.handler({
      ads_account_id: ACCOUNT, area: 'x', severity: 'LOW',
      text: 'enough text here', confidence: 0.5, run_id: otherRun.run_id,
    }, makeAgent());
    expect(out).toMatch(/not found for account/);
  });
});
