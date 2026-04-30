/**
 * Shared helper that converts a CustomerProfileRow into the Markdown
 * block both Strategist Brief (D4) and Blueprint Critique (D5) put
 * into their cached LLM system prompt. Adding it here means the P3
 * depth fields (personas, brand voice, USPs, compliance, pricing,
 * seasonality) only need to be added to one builder — both Brief
 * and Critique pick them up automatically.
 *
 * Optional fields: only emitted when the operator has populated
 * them. A blank profile still produces a valid (terse) context
 * block — graceful degradation across cycle 1.
 */
import type {
  CustomerProfileRow, CustomerPersona, CustomerBrandVoice,
} from './ads-data-store.js';

export function buildCustomerContextWithDepth(customer: CustomerProfileRow): string {
  const lines: string[] = [];
  lines.push('# Customer profile');
  lines.push(`- Client: ${customer.client_name}`);
  if (customer.country) lines.push(`- Country: ${customer.country}`);
  const langs = parseStrings(customer.languages);
  if (langs.length) lines.push(`- Languages: ${langs.join(', ')}`);
  if (customer.business_model) lines.push(`- Business model: ${customer.business_model}`);
  if (customer.offer_summary) lines.push(`- Offer: ${customer.offer_summary}`);
  if (customer.primary_goal) lines.push(`- Primary goal: ${customer.primary_goal}`);
  if (customer.target_roas !== null && customer.target_roas !== undefined) {
    lines.push(`- Target ROAS: ${customer.target_roas.toFixed(2)}x`);
  }
  if (customer.target_cpa_chf !== null && customer.target_cpa_chf !== undefined) {
    lines.push(`- Target CPA: ${customer.target_cpa_chf.toFixed(2)} CHF`);
  }
  if (customer.monthly_budget_chf !== null && customer.monthly_budget_chf !== undefined) {
    lines.push(`- Monthly budget: ${customer.monthly_budget_chf.toFixed(0)} CHF`);
  }
  const tops = parseStrings(customer.top_products);
  if (tops.length) lines.push(`- Top products / themes: ${tops.join(', ')}`);
  const own = parseStrings(customer.own_brands);
  if (own.length) lines.push(`- Own brands: ${own.join(', ')}`);
  const sold = parseStrings(customer.sold_brands);
  if (sold.length) lines.push(`- Sold brands: ${sold.join(', ')}`);
  const comp = parseStrings(customer.competitors);
  if (comp.length) lines.push(`- Competitors: ${comp.join(', ')}`);

  // P3 depth fields — only emit when present. Each has a header so the
  // model can reference them by section.
  const usp = parseStrings(customer.usp_json);
  if (usp.length > 0) {
    lines.push('');
    lines.push('## Unique Selling Points');
    for (const u of usp) lines.push(`- ${u}`);
  }

  const personas = parsePersonas(customer.personas_json);
  if (personas.length > 0) {
    lines.push('');
    lines.push('## Personas');
    for (const p of personas) {
      const bits: string[] = [`**${p.name}**`];
      if (p.age_range) bits.push(`(${p.age_range})`);
      lines.push(`- ${bits.join(' ')}`);
      if (p.motivation) lines.push(`  - Motivation: ${p.motivation}`);
      if (p.pain_points && p.pain_points.length > 0) {
        lines.push(`  - Pain points: ${p.pain_points.join('; ')}`);
      }
      if (p.buying_triggers && p.buying_triggers.length > 0) {
        lines.push(`  - Buying triggers: ${p.buying_triggers.join('; ')}`);
      }
    }
  }

  const brandVoice = parseBrandVoice(customer.brand_voice_json);
  if (brandVoice && hasBrandVoiceContent(brandVoice)) {
    lines.push('');
    lines.push('## Brand voice');
    if (brandVoice.tone) lines.push(`- Tone: ${brandVoice.tone}`);
    if (brandVoice.signature_phrases && brandVoice.signature_phrases.length > 0) {
      lines.push(`- Signature phrases: ${brandVoice.signature_phrases.map(s => `"${s}"`).join(', ')}`);
    }
    if (brandVoice.voice_examples && brandVoice.voice_examples.length > 0) {
      lines.push('- Voice examples:');
      for (const ex of brandVoice.voice_examples) lines.push(`  - "${ex}"`);
    }
    if (brandVoice.do_not_use && brandVoice.do_not_use.length > 0) {
      lines.push(`- Do NOT use: ${brandVoice.do_not_use.map(s => `"${s}"`).join(', ')}`);
    }
  }

  if (customer.compliance_constraints) {
    lines.push('');
    lines.push('## Compliance constraints');
    lines.push(customer.compliance_constraints);
  }

  if (customer.pricing_strategy) {
    lines.push('');
    lines.push('## Pricing strategy');
    lines.push(customer.pricing_strategy);
  }

  if (customer.seasonal_patterns) {
    lines.push('');
    lines.push('## Seasonality');
    lines.push(customer.seasonal_patterns);
  }

  return lines.join('\n');
}

function parseStrings(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function parsePersonas(json: string): CustomerPersona[] {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x))
      .map(o => sanitizePersona(o))
      .filter((p): p is CustomerPersona => p !== null);
  } catch { return []; }
}

function sanitizePersona(o: Record<string, unknown>): CustomerPersona | null {
  const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
  if (!name) return null;
  return {
    name,
    ...(typeof o['age_range'] === 'string' ? { age_range: o['age_range'] } : {}),
    ...(typeof o['motivation'] === 'string' ? { motivation: o['motivation'] } : {}),
    ...(Array.isArray(o['pain_points'])
      ? { pain_points: (o['pain_points'] as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
    ...(Array.isArray(o['buying_triggers'])
      ? { buying_triggers: (o['buying_triggers'] as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
  };
}

function parseBrandVoice(json: string): CustomerBrandVoice | null {
  try {
    const v = JSON.parse(json);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    return {
      ...(typeof o['tone'] === 'string' ? { tone: o['tone'] } : {}),
      ...(Array.isArray(o['voice_examples'])
        ? { voice_examples: (o['voice_examples'] as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
      ...(Array.isArray(o['do_not_use'])
        ? { do_not_use: (o['do_not_use'] as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
      ...(Array.isArray(o['signature_phrases'])
        ? { signature_phrases: (o['signature_phrases'] as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
    };
  } catch { return null; }
}

function hasBrandVoiceContent(bv: CustomerBrandVoice): boolean {
  return Boolean(bv.tone)
    || (bv.voice_examples?.length ?? 0) > 0
    || (bv.do_not_use?.length ?? 0) > 0
    || (bv.signature_phrases?.length ?? 0) > 0;
}
