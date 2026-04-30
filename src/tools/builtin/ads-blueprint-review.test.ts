import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { createAdsBlueprintReviewTool } from './ads-blueprint-review.js';
import { runEmit, EmitPreconditionError } from '../../core/ads-emit-engine.js';
import type { IAgent } from '../../types/index.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';
const fakeAgent = { toolContext: { knowledgeLayer: null } } as unknown as IAgent;

describe('ads_blueprint_review tool', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let tool: ReturnType<typeof createAdsBlueprintReviewTool>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-pre-emit-tool-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    tool = createAdsBlueprintReviewTool(store);
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function seedDuplicateUrlBlueprint(): number {
    store.upsertCustomerProfile({
      customerId: CUSTOMER, clientName: 'Acme', languages: ['DE'],
      ownBrands: ['acme'], soldBrands: ['hamoni', 'maunawai'],
      monthlyBudgetChf: 3000, topProducts: ['kefir'],
    });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    // Two RSAs sharing the same final_url → BLOCK.
    store.insertBlueprintEntity({
      runId: r.run_id, adsAccountId: ACCOUNT, entityType: 'rsa_ad', kind: 'NEW',
      externalId: 'rsa-1', confidence: 0.7,
      payload: { campaign_name: 'Search-Brand', ad_group_name: 'Brand-Hamoni',
        headlines: ['Hamoni'], descriptions: ['x'], final_url: 'https://acme.example/' },
    });
    store.insertBlueprintEntity({
      runId: r.run_id, adsAccountId: ACCOUNT, entityType: 'rsa_ad', kind: 'NEW',
      externalId: 'rsa-2', confidence: 0.7,
      payload: { campaign_name: 'Search-Brand', ad_group_name: 'Brand-Maunawai',
        headlines: ['Maunawai'], descriptions: ['x'], final_url: 'https://acme.example/' },
    });
    return r.run_id;
  }

  it('persists BLOCK + warning findings and produces a Markdown report', async () => {
    const runId = seedDuplicateUrlBlueprint();
    const out = await tool.handler({ ads_account_id: ACCOUNT }, fakeAgent);
    expect(out).toMatch(/# Pre-Emit Review/);
    expect(out).toMatch(/BLOCK-Finding/);
    expect(out).toMatch(/duplicate_final_url/);

    const blocks = store.listFindings(runId, { severity: 'BLOCK' });
    expect(blocks.find(f => f.area === 'pre_emit_review:duplicate_final_url')).toBeDefined();
  });

  it('blocks ads_emit_csv until BLOCK findings are resolved', async () => {
    seedDuplicateUrlBlueprint();
    await tool.handler({ ads_account_id: ACCOUNT }, fakeAgent);
    expect(() => runEmit(store, ACCOUNT)).toThrow(EmitPreconditionError);
    expect(() => runEmit(store, ACCOUNT)).toThrow(/Pre-Emit-Review BLOCK/);
  });

  it('is idempotent — re-running clears prior findings and re-evaluates', async () => {
    const runId = seedDuplicateUrlBlueprint();
    await tool.handler({ ads_account_id: ACCOUNT }, fakeAgent);
    expect(store.listFindings(runId, { severity: 'BLOCK' }))
      .toHaveLength(1);

    // Operator "fixes" one of the duplicates by clearing all blueprint
    // entities and reseeding with distinct URLs (simulates a successful
    // ads_blueprint_entity_propose round-trip). clearBlueprintEntities
    // wipes deterministic-source rows; reseeding with distinct final_url
    // means duplicate-detection should not fire on the second run.
    store.clearBlueprintEntities(runId, 'deterministic');
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'rsa_ad', kind: 'NEW',
      externalId: 'rsa-1', confidence: 0.7,
      payload: { campaign_name: 'Search-Brand', ad_group_name: 'Brand-Hamoni',
        headlines: ['Hamoni'], descriptions: ['x'],
        final_url: 'https://acme.example/hamoni' },
    });
    store.insertBlueprintEntity({
      runId, adsAccountId: ACCOUNT, entityType: 'rsa_ad', kind: 'NEW',
      externalId: 'rsa-2', confidence: 0.7,
      payload: { campaign_name: 'Search-Brand', ad_group_name: 'Brand-Maunawai',
        headlines: ['Maunawai'], descriptions: ['x'],
        final_url: 'https://acme.example/maunawai' },
    });

    await tool.handler({ ads_account_id: ACCOUNT }, fakeAgent);
    expect(store.listFindings(runId, { severity: 'BLOCK' }).filter(f => f.area.startsWith('pre_emit_review:')))
      .toHaveLength(0);
  });

  it('downgrades BLOCK findings to HIGH when override=true with reason', async () => {
    const runId = seedDuplicateUrlBlueprint();
    const out = await tool.handler({
      ads_account_id: ACCOUNT,
      override: true,
      override_reason: 'Beide AGs zeigen bewusst auf Homepage — dies ist ein Test-Setup ohne dedizierte Brand-LPs.',
    }, fakeAgent);
    expect(out).toMatch(/auf HIGH downgrade-t/);

    expect(store.listFindings(runId, { severity: 'BLOCK' }).filter(f => f.area.startsWith('pre_emit_review:')))
      .toHaveLength(0);
    const overrideFinding = store.listFindings(runId).find(f => f.area === 'pre_emit_review:override');
    expect(overrideFinding).toBeDefined();
    expect(overrideFinding!.source).toBe('agent');
    expect(JSON.parse(overrideFinding!.evidence_json).reason).toMatch(/Test-Setup/);
  });

  it('rejects override=true without a long-enough reason', async () => {
    seedDuplicateUrlBlueprint();
    const out = await tool.handler({
      ads_account_id: ACCOUNT, override: true, override_reason: 'too short',
    }, fakeAgent);
    expect(out).toMatch(/override_reason/);
  });

  it('emit proceeds when override=true', async () => {
    seedDuplicateUrlBlueprint();
    await tool.handler({
      ads_account_id: ACCOUNT, override: true,
      override_reason: 'Dies ist ein expliziter Override für den Cycle 12 Test-Setup-Fall.',
    }, fakeAgent);
    // The duplicate-URL gate is now downgraded; emit will fail for
    // OTHER reasons (validation) but NOT for pre_emit_review block.
    // Use vitest's negative-toThrow so a no-throw fails fast — the
    // earlier try/catch silently passed when runEmit didn't throw.
    expect(() => runEmit(store, ACCOUNT)).not.toThrow(/Pre-Emit-Review BLOCK/);
  });
});
