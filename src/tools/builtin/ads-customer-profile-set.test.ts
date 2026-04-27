import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { createAdsCustomerProfileSetTool } from './ads-customer-profile-set.js';
import type { IAgent } from '../../types/index.js';

const fakeAgent = {} as unknown as IAgent;

describe('ads_customer_profile_set tool', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let tool: ReturnType<typeof createAdsCustomerProfileSetTool>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-ads-profile-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    tool = createAdsCustomerProfileSetTool(store);
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('input validation', () => {
    it('rejects missing customer_id', async () => {
      const result = await tool.handler({ customer_id: '', client_name: 'X' }, fakeAgent);
      expect(result).toMatch(/customer_id is required/);
    });

    it('rejects missing client_name', async () => {
      const result = await tool.handler({ customer_id: 'acme-shop', client_name: '   ' }, fakeAgent);
      expect(result).toMatch(/client_name is required/);
    });

    it('rejects malformed customer_id', async () => {
      const result = await tool.handler({ customer_id: 'NOT VALID', client_name: 'X' }, fakeAgent);
      expect(result).toMatch(/invalid/);
    });

    it('accepts a hyphenated lowercase slug', async () => {
      const result = await tool.handler({ customer_id: 'acme-shop', client_name: 'Acme Shop' }, fakeAgent);
      expect(result).toMatch(/^Created customer profile/);
    });

    it('accepts an underscored slug', async () => {
      const result = await tool.handler({ customer_id: 'acme_shop', client_name: 'Acme Shop' }, fakeAgent);
      expect(result).toMatch(/^Created customer profile/);
    });
  });

  describe('happy path: full profile', () => {
    it('persists a complete profile and reads back via the store', async () => {
      const result = await tool.handler({
        customer_id: 'acme-shop',
        client_name: 'Acme Shop Ltd',
        business_model: 'ecommerce',
        offer_summary: 'Widgets and gizmos for the modern household.',
        primary_goal: 'roas',
        target_roas: 5.0,
        monthly_budget_chf: 2700,
        typical_cpc_chf: 1.2,
        country: 'CH',
        timezone: 'Europe/Zurich',
        languages: ['de'],
        top_products: ['widgets', 'gizmos', 'tools'],
        own_brands: ['acme-shop', 'acme-house'],
        sold_brands: ['third-party-1', 'third-party-2'],
        competitors: ['competitor-co', 'competitor-x'],
        pmax_owned_head_terms: ['widget', 'gizmo', 'household-tool'],
        naming_convention_pattern: 'CH | <Channel> | <Intent> | <Theme> | <Lang> | v1',
        tracking_notes: { ga4_linked: true, enhanced_conversions: false },
      }, fakeAgent);

      expect(result).toMatch(/^Created customer profile "Acme Shop Ltd" \(acme-shop\)/);
      expect(result).toMatch(/business: ecommerce/);
      expect(result).toMatch(/target ROAS: 5x/);
      expect(result).toMatch(/PMAX-owned head terms: 3 \(widget, gizmo, household-tool\)/);
      expect(result).toMatch(/naming: CH \| <Channel>/);
      // No "reminder" footer when all key fields are populated
      expect(result).not.toMatch(/Reminder:/);

      const stored = store.getCustomerProfile('acme-shop');
      expect(stored).not.toBeNull();
      expect(stored!.client_name).toBe('Acme Shop Ltd');
      expect(stored!.target_roas).toBe(5);
      expect(JSON.parse(stored!.pmax_owned_head_terms)).toEqual(['widget', 'gizmo', 'household-tool']);
      expect(JSON.parse(stored!.tracking_notes)).toEqual({ ga4_linked: true, enhanced_conversions: false });
    });
  });

  describe('warning when key fields are missing', () => {
    it('flags missing competitors / pmax_owned / naming_convention with a Reminder footer', async () => {
      const result = await tool.handler({
        customer_id: 'minimal',
        client_name: 'Minimal Shop',
      }, fakeAgent);
      expect(result).toMatch(/Reminder:/);
      expect(result).toMatch(/competitors, pmax_owned_head_terms, and naming_convention_pattern/);
    });
  });

  describe('upsert behaviour', () => {
    it('"Created" on first call, "Updated" on subsequent calls', async () => {
      const first = await tool.handler({ customer_id: 'acme-shop', client_name: 'First' }, fakeAgent);
      expect(first).toMatch(/^Created/);
      const second = await tool.handler({ customer_id: 'acme-shop', client_name: 'Second' }, fakeAgent);
      expect(second).toMatch(/^Updated customer profile "Second"/);
    });

    it('preserves created_at across updates', async () => {
      await tool.handler({ customer_id: 'acme-shop', client_name: 'X' }, fakeAgent);
      const initialCreatedAt = store.getCustomerProfile('acme-shop')!.created_at;
      await tool.handler({ customer_id: 'acme-shop', client_name: 'Y' }, fakeAgent);
      const afterCreatedAt = store.getCustomerProfile('acme-shop')!.created_at;
      expect(afterCreatedAt).toBe(initialCreatedAt);
    });

    it('overwrites array fields completely on update (no merge)', async () => {
      await tool.handler({
        customer_id: 'acme-shop', client_name: 'X',
        competitors: ['competitor-co', 'competitor-x'],
      }, fakeAgent);
      await tool.handler({
        customer_id: 'acme-shop', client_name: 'X',
        competitors: ['competitor-z'],
      }, fakeAgent);
      const stored = store.getCustomerProfile('acme-shop')!;
      expect(JSON.parse(stored.competitors)).toEqual(['competitor-z']);
    });
  });

  describe('summary truncation', () => {
    it('truncates pmax_owned_head_terms preview to 5 with ellipsis', async () => {
      const result = await tool.handler({
        customer_id: 'acme-shop',
        client_name: 'X',
        competitors: ['c1'],
        naming_convention_pattern: 'p',
        pmax_owned_head_terms: ['t1', 't2', 't3', 't4', 't5', 't6', 't7'],
      }, fakeAgent);
      expect(result).toMatch(/PMAX-owned head terms: 7 \(t1, t2, t3, t4, t5…\)/);
    });
  });
});
