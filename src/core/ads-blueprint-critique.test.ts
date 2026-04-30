import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import { AdsDataStore } from './ads-data-store.js';
import { generateBlueprintCritique, parseCritique } from './ads-blueprint-critique.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'aquanatura';

function fakeClient(toolInput: unknown): Anthropic {
  return {
    beta: {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            content: [
              { type: 'tool_use', name: 'emit_blueprint_critique', input: toolInput },
            ],
          }),
        }),
      },
    },
  } as unknown as Anthropic;
}

describe('generateBlueprintCritique', () => {
  let tempDir: string;
  let store: AdsDataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-critique-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Aquanatura',
      languages: ['DE'], topProducts: ['wasserfilter'],
      ownBrands: ['aquanatura'], soldBrands: ['hamoni'],
      monthlyBudgetChf: 3000, targetRoas: 4.0,
    });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function seedRunWithBlueprint(): number {
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    store.insertBlueprintEntity({
      runId: r.run_id, adsAccountId: ACCOUNT, entityType: 'campaign', kind: 'NEW',
      externalId: 'bp.campaign.search-brand', confidence: 0.85,
      payload: { campaign_name: 'Search-Brand', budget_chf: 18, target_cpa_chf: 9 },
    });
    store.insertBlueprintEntity({
      runId: r.run_id, adsAccountId: ACCOUNT, entityType: 'asset_group', kind: 'NEW',
      externalId: 'bp.assetgroup.glas', confidence: 0.7,
      payload: { campaign_name: 'PMax', asset_group_name: 'Theme-Glas', theme_token: 'glas' },
    });
    return r.run_id;
  }

  it('returns no-op when blueprint is empty', async () => {
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const result = await generateBlueprintCritique(store, r.run_id, customer);
    expect(result.challenges).toHaveLength(0);
    expect(result.llmFailed).toBe(false);
  });

  it('parses 3-5 challenges from the model', async () => {
    const runId = seedRunWithBlueprint();
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const client = fakeClient({
      challenges: [
        { title: 'Brand-Search budget', challenge: '18 CHF/day is 18% of budget',
          ref: 'Search-Brand campaign' },
        { title: 'Theme-Glas mismatch', challenge: 'glas not in top_products',
          ref: 'Theme-Glas' },
        { title: 'Smart-Bidding learning', challenge: 'too many AGs at once' },
      ],
    });
    const result = await generateBlueprintCritique(store, runId, customer, { client });
    expect(result.llmFailed).toBe(false);
    expect(result.challenges).toHaveLength(3);
    expect(result.challenges[0]!.title).toMatch(/Brand-Search/);
    expect(result.challenges[0]!.ref).toBe('Search-Brand campaign');
  });

  it('returns failed result when the LLM throws', async () => {
    const runId = seedRunWithBlueprint();
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const throwing = {
      beta: { messages: { stream: () => ({ finalMessage: async () => { throw new Error('rate limit'); } }) } },
    } as unknown as Anthropic;
    const result = await generateBlueprintCritique(store, runId, customer, { client: throwing });
    expect(result.llmFailed).toBe(true);
    expect(result.failureReason).toMatch(/rate limit/);
    expect(result.challenges).toHaveLength(0);
  });

  it('returns failed result when no tool_use block is in response', async () => {
    const runId = seedRunWithBlueprint();
    const customer = store.getCustomerProfile(CUSTOMER)!;
    const empty = {
      beta: { messages: { stream: () => ({ finalMessage: async () => ({ content: [] }) }) } },
    } as unknown as Anthropic;
    const result = await generateBlueprintCritique(store, runId, customer, { client: empty });
    expect(result.llmFailed).toBe(true);
  });
});

describe('parseCritique', () => {
  it('rejects empty challenges as failed', () => {
    expect(parseCritique({ challenges: [] }).llmFailed).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(parseCritique('not an object').llmFailed).toBe(true);
  });

  it('skips items without title or challenge', () => {
    const result = parseCritique({
      challenges: [
        { title: '', challenge: 'has no title' },
        { title: 'No challenge', challenge: '' },
        { title: 'Valid', challenge: 'real challenge text', ref: 'X' },
      ],
    });
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]!.title).toBe('Valid');
  });

  it('keeps challenges without ref', () => {
    const result = parseCritique({
      challenges: [{ title: 'X', challenge: 'Y' }],
    });
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]!.ref).toBeUndefined();
  });
});
