import { describe, it, expect } from 'vitest';
import { buildCustomerContextWithDepth } from './ads-customer-profile-context.js';
import type { CustomerProfileRow } from './ads-data-store.js';

function makeProfile(overrides: Partial<CustomerProfileRow> = {}): CustomerProfileRow {
  return {
    customer_id: 'aquanatura', client_name: 'Aquanatura',
    business_model: 'D2C', offer_summary: null, primary_goal: null,
    target_roas: null, target_cpa_chf: null, monthly_budget_chf: null, typical_cpc_chf: null,
    country: 'CH', timezone: 'Europe/Zurich',
    languages: '[]', top_products: '[]', own_brands: '[]', sold_brands: '[]',
    competitors: '[]', pmax_owned_head_terms: '[]',
    naming_convention_pattern: null, tracking_notes: '{}',
    personas_json: '[]', brand_voice_json: '{}', usp_json: '[]',
    compliance_constraints: '', pricing_strategy: '', seasonal_patterns: '',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildCustomerContextWithDepth', () => {
  it('emits only base fields when depth is empty', () => {
    const out = buildCustomerContextWithDepth(makeProfile());
    expect(out).toContain('# Customer profile');
    expect(out).toContain('- Client: Aquanatura');
    expect(out).not.toContain('## Personas');
    expect(out).not.toContain('## Brand voice');
    expect(out).not.toContain('## Compliance constraints');
  });

  it('emits Unique Selling Points section when usp_json non-empty', () => {
    const out = buildCustomerContextWithDepth(makeProfile({
      usp_json: JSON.stringify(['Patentiertes Filterverfahren', 'Lieferung 24h Schweiz']),
    }));
    expect(out).toContain('## Unique Selling Points');
    expect(out).toContain('- Patentiertes Filterverfahren');
    expect(out).toContain('- Lieferung 24h Schweiz');
  });

  it('emits Personas section with motivation + pain points', () => {
    const personas = [{
      name: 'Tech-affine Selbstständige',
      age_range: '30-45',
      motivation: 'Keine Zeit für Tool-Recherche',
      pain_points: ['Mehrere SaaS-Tools, viel Switch'],
      buying_triggers: ['Burnout-Nähe'],
    }];
    const out = buildCustomerContextWithDepth(makeProfile({
      personas_json: JSON.stringify(personas),
    }));
    expect(out).toContain('## Personas');
    expect(out).toContain('**Tech-affine Selbstständige**');
    expect(out).toContain('(30-45)');
    expect(out).toContain('Motivation: Keine Zeit');
    expect(out).toContain('Pain points: Mehrere SaaS-Tools');
    expect(out).toContain('Buying triggers: Burnout-Nähe');
  });

  it('emits Brand voice section with tone + do_not_use', () => {
    const brandVoice = {
      tone: 'direkt, technisch, no-fluff',
      voice_examples: ['Run your business. Not your tools.'],
      do_not_use: ['game-changer', 'revolutionary'],
      signature_phrases: ['Operating System für AI'],
    };
    const out = buildCustomerContextWithDepth(makeProfile({
      brand_voice_json: JSON.stringify(brandVoice),
    }));
    expect(out).toContain('## Brand voice');
    expect(out).toContain('- Tone: direkt');
    expect(out).toContain('Do NOT use: "game-changer", "revolutionary"');
    expect(out).toContain('Signature phrases: "Operating System für AI"');
    expect(out).toContain('"Run your business. Not your tools."');
  });

  it('emits compliance / pricing / seasonality sections when set', () => {
    const out = buildCustomerContextWithDepth(makeProfile({
      compliance_constraints: 'Avoid "guarantee" and unverifiable health claims.',
      pricing_strategy: 'Premium positioning. Never discount.',
      seasonal_patterns: 'Peak Mar-May for kefir; Oct-Dec for water filters.',
    }));
    expect(out).toContain('## Compliance constraints');
    expect(out).toContain('Avoid "guarantee"');
    expect(out).toContain('## Pricing strategy');
    expect(out).toContain('Never discount');
    expect(out).toContain('## Seasonality');
    expect(out).toContain('Peak Mar-May');
  });

  it('skips personas without name', () => {
    const out = buildCustomerContextWithDepth(makeProfile({
      personas_json: JSON.stringify([
        { name: '', motivation: 'no name' },
        { name: 'Real', motivation: 'kept' },
      ]),
    }));
    expect(out).not.toContain('no name');
    expect(out).toContain('**Real**');
  });

  it('handles malformed depth json gracefully (treats as empty)', () => {
    const out = buildCustomerContextWithDepth(makeProfile({
      personas_json: 'not json',
      brand_voice_json: '{malformed',
      usp_json: '[1, 2, 3]', // numbers — filtered by string-only filter
    }));
    expect(out).toContain('# Customer profile');
    expect(out).not.toContain('## Personas');
    expect(out).not.toContain('## Brand voice');
    expect(out).not.toContain('## Unique Selling Points');
  });
});
