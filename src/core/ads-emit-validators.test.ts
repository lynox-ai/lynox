import { describe, it, expect } from 'vitest';
import { validateBlueprint } from './ads-emit-validators.js';
import type { AdsBlueprintEntityRow, CustomerProfileRow } from './ads-data-store.js';

const baseCustomer = (overrides?: Partial<CustomerProfileRow>): CustomerProfileRow => ({
  customer_id: 'acme-shop',
  client_name: 'Acme',
  business_model: null,
  offer_summary: null,
  primary_goal: null,
  target_roas: null,
  target_cpa_chf: null,
  monthly_budget_chf: null,
  typical_cpc_chf: null,
  country: null,
  timezone: null,
  languages: '[]',
  top_products: '[]',
  own_brands: '[]',
  sold_brands: '[]',
  competitors: '[]',
  pmax_owned_head_terms: '[]',
  naming_convention_pattern: null,
  tracking_notes: '{}',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

let id = 0;
function bp(
  entityType: string, externalId: string, payload: Record<string, unknown>,
  opts?: { naming_valid?: 0 | 1 | undefined; naming_errors?: readonly string[] | undefined } | undefined,
): AdsBlueprintEntityRow {
  return {
    blueprint_id: ++id,
    run_id: 1,
    ads_account_id: 'a1',
    entity_type: entityType,
    kind: 'NEW',
    external_id: externalId,
    previous_external_id: null,
    payload_json: JSON.stringify(payload),
    confidence: 1,
    rationale: '',
    naming_valid: opts?.naming_valid ?? 1,
    naming_errors_json: JSON.stringify(opts?.naming_errors ?? []),
    created_at: new Date().toISOString(),
  };
}

describe('validateBlueprint', () => {
  it('emits canEmit=true on a healthy minimum blueprint', () => {
    const entities = [
      bp('campaign', 'c1', { campaign_name: 'C1' }),
      bp('ad_group', 'ag1', { campaign_name: 'C1', ad_group_name: 'AG1' }),
      bp('keyword', 'k1', { campaign_name: 'C1', ad_group_name: 'AG1', keyword: 'foo' }),
    ];
    const r = validateBlueprint(entities, { customer: baseCustomer() });
    expect(r.canEmit).toBe(true);
    expect(r.hard).toEqual([]);
  });

  it('blocks emit on broken ad_group → campaign reference', () => {
    const entities = [
      bp('ad_group', 'ag1', { campaign_name: 'NoSuchCampaign', ad_group_name: 'AG1' }),
    ];
    const r = validateBlueprint(entities, { customer: baseCustomer() });
    expect(r.canEmit).toBe(false);
    expect(r.hard[0]?.area).toBe('cross_reference');
  });

  it('blocks emit on broken keyword → ad_group reference', () => {
    const entities = [
      bp('campaign', 'c1', { campaign_name: 'C1' }),
      bp('keyword', 'k1', { campaign_name: 'C1', ad_group_name: 'NoSuchAG', keyword: 'foo' }),
    ];
    const r = validateBlueprint(entities, { customer: baseCustomer() });
    expect(r.canEmit).toBe(false);
    expect(r.hard[0]?.message).toMatch(/NoSuchAG/);
  });

  it('blocks emit on RSA with too few headlines', () => {
    const entities = [
      bp('rsa_ad', 'r1', {
        headlines: ['Only', 'Three', 'Items'],
        descriptions: ['One descr', 'Two descr'],
      }),
    ];
    const r = validateBlueprint(entities, { customer: baseCustomer() });
    expect(r.canEmit).toBe(false);
    expect(r.hard[0]?.area).toBe('rsa_min_count');
  });

  it('blocks emit on RSA with too few descriptions', () => {
    const entities = [
      bp('rsa_ad', 'r1', {
        headlines: ['1', '2', '3', '4', '5'],
        descriptions: ['only one'],
      }),
    ];
    const r = validateBlueprint(entities, { customer: baseCustomer() });
    expect(r.canEmit).toBe(false);
    expect(r.hard[0]?.message).toMatch(/Descriptions/);
  });

  it('blocks emit on overlong headline (>30 chars)', () => {
    const entities = [
      bp('rsa_ad', 'r1', {
        headlines: ['x'.repeat(31), 'h2', 'h3', 'h4', 'h5'],
        descriptions: ['d1', 'd2'],
      }),
    ];
    const r = validateBlueprint(entities, { customer: baseCustomer() });
    expect(r.canEmit).toBe(false);
    expect(r.hard[0]?.area).toBe('field_length');
  });

  it('blocks emit on overlong description (>90 chars)', () => {
    const entities = [
      bp('rsa_ad', 'r1', {
        headlines: ['h1', 'h2', 'h3', 'h4', 'h5'],
        descriptions: ['d1', 'x'.repeat(91)],
      }),
    ];
    const r = validateBlueprint(entities, { customer: baseCustomer() });
    expect(r.canEmit).toBe(false);
  });

  it('blocks emit when RSA contains a competitor trademark', () => {
    const entities = [
      bp('rsa_ad', 'r1', {
        headlines: ['Best Tools', 'Buy Bosch Now', 'h3', 'h4', 'h5'],
        descriptions: ['Premium quality', 'Free shipping'],
      }),
    ];
    const r = validateBlueprint(entities, {
      customer: baseCustomer({ competitors: JSON.stringify(['Bosch']) }),
    });
    expect(r.canEmit).toBe(false);
    expect(r.hard[0]?.area).toBe('competitor_trademark');
  });

  it('blocks emit on non-HTTPS final URL', () => {
    const entities = [
      bp('rsa_ad', 'r1', {
        headlines: ['h1', 'h2', 'h3', 'h4', 'h5'],
        descriptions: ['d1', 'd2'],
        finalUrl: 'http://example.com',
      }),
    ];
    const r = validateBlueprint(entities, { customer: baseCustomer() });
    expect(r.canEmit).toBe(false);
    expect(r.hard[0]?.message).toMatch(/HTTPS/);
  });

  it('accepts well-formed HTTPS URLs', () => {
    const entities = [
      bp('rsa_ad', 'r1', {
        headlines: ['h1', 'h2', 'h3', 'h4', 'h5'],
        descriptions: ['d1', 'd2'],
        finalUrl: 'https://example.com/landing',
      }),
    ];
    const r = validateBlueprint(entities, { customer: baseCustomer() });
    expect(r.canEmit).toBe(true);
  });

  it('blocks emit on overlong sitelink text (>25)', () => {
    const entities = [
      bp('sitelink', 's1', { text: 'this sitelink text is far too long to fit', final_url: 'https://example.com' }),
    ];
    const r = validateBlueprint(entities, { customer: baseCustomer() });
    expect(r.canEmit).toBe(false);
    expect(r.hard[0]?.area).toBe('field_length');
  });

  it('surfaces P3 naming violations as WARN (does not block)', () => {
    const entities = [
      bp('campaign', 'c1', { campaign_name: 'wrong_name' },
         { naming_valid: 0, naming_errors: ['LANG-token missing'] }),
    ];
    const r = validateBlueprint(entities, { customer: baseCustomer() });
    expect(r.canEmit).toBe(true);
    expect(r.warn).toHaveLength(1);
    expect(r.warn[0]?.area).toBe('naming_convention');
  });

  it('aggregates multiple hard issues without short-circuiting', () => {
    const entities = [
      bp('ad_group', 'ag1', { campaign_name: 'NoSuchA', ad_group_name: 'AG1' }),
      bp('keyword', 'k1', { campaign_name: 'NoSuchB', ad_group_name: 'NoSuchAG', keyword: 'foo' }),
    ];
    const r = validateBlueprint(entities, { customer: baseCustomer() });
    expect(r.hard.length).toBe(2);
    expect(r.canEmit).toBe(false);
  });
});
