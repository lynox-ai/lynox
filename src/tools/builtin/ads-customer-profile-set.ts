/**
 * Tool: ads_customer_profile_set
 *
 * Writes (or updates) a customer profile in the Ads Optimizer database.
 * The profile drives downstream audit/blueprint logic — naming convention
 * is enforced on emitted Editor-CSVs, pmax_owned_head_terms become
 * cross-campaign negatives, target_roas / target_cpa anchor performance
 * thresholds, brands/competitors flow into trademark and negative checks.
 *
 * Idiomatic lynox: this tool is intentionally a thin writer. Profile
 * research (brand, languages, top products, competitors) happens in the
 * agent loop using the existing web_search and http tools. The agent does
 * the work and the reasoning; this tool just persists the verified
 * profile fields. There is no separate "auto-fill from website" tool by
 * design — the agent decides what to research, when to ask the user, and
 * what to record.
 *
 * Gated by feature flag 'ads-optimizer' (default off). Engine registers
 * this tool whenever the flag is on; no Drive/OAuth dependency, so the
 * profile can be created before any Apps Scripts have run.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import type { AdsDataStore } from '../../core/ads-data-store.js';
import { getErrorMessage } from '../../core/utils.js';

interface AdsCustomerProfileSetInput {
  customer_id: string;
  client_name: string;
  business_model?: string | undefined;
  offer_summary?: string | undefined;
  primary_goal?: string | undefined;
  target_roas?: number | undefined;
  target_cpa_chf?: number | undefined;
  monthly_budget_chf?: number | undefined;
  typical_cpc_chf?: number | undefined;
  country?: string | undefined;
  timezone?: string | undefined;
  languages?: string[] | undefined;
  top_products?: string[] | undefined;
  own_brands?: string[] | undefined;
  sold_brands?: string[] | undefined;
  competitors?: string[] | undefined;
  pmax_owned_head_terms?: string[] | undefined;
  naming_convention_pattern?: string | undefined;
  tracking_notes?: Record<string, unknown> | undefined;
  // P3 depth fields — all optional. Pass undefined to leave existing
  // values untouched on update. Strategist Brief + Blueprint Critique
  // read these when present and produce sharper recommendations.
  personas?: Array<{
    name: string;
    age_range?: string | undefined;
    motivation?: string | undefined;
    pain_points?: string[] | undefined;
    buying_triggers?: string[] | undefined;
  }> | undefined;
  brand_voice?: {
    tone?: string | undefined;
    voice_examples?: string[] | undefined;
    do_not_use?: string[] | undefined;
    signature_phrases?: string[] | undefined;
  } | undefined;
  usp?: string[] | undefined;
  compliance_constraints?: string | undefined;
  pricing_strategy?: string | undefined;
  seasonal_patterns?: string | undefined;
}

const DESCRIPTION = [
  'Save (or update) a customer profile for the Ads Optimizer pipeline.',
  '',
  'Workflow expectation — call this tool AFTER you have:',
  '1. Researched the customer using web_search and http to gather their brand,',
  '   primary languages, top products/services, and a short list of direct',
  '   competitors. Read their public website at minimum.',
  '2. Confirmed the load-bearing fields with the user via ask_user — especially',
  '   target_roas (or target_cpa), monthly_budget_chf, naming_convention_pattern,',
  '   and pmax_owned_head_terms. Auto-detected values must be user-confirmed.',
  '3. Identified pmax_owned_head_terms — broad category search terms the',
  '   customer\'s PMAX campaigns already dominate (e.g. for a hardware shop:',
  '   "drills", "sanders", "grinders"). These become cross-campaign negative',
  '   exact-match keywords on Search campaigns to prevent PMAX/Search',
  '   cannibalisation. 8–20 terms is typical.',
  '',
  'Calling this tool again with the same customer_id updates the existing',
  'profile (preserves created_at, refreshes updated_at, replaces all other',
  'fields with the new values).',
  '',
  'customer_id is a stable slug (lowercase, snake_case-friendly), e.g.',
  '"acme-shop". Keep it stable — the Ads Optimizer cycle pipeline keys all',
  'snapshots and audit runs against this id.',
].join('\n');

export function createAdsCustomerProfileSetTool(store: AdsDataStore): ToolEntry<AdsCustomerProfileSetInput> {
  return {
    definition: {
      name: 'ads_customer_profile_set',
      description: DESCRIPTION,
      input_schema: {
        type: 'object' as const,
        properties: {
          customer_id: {
            type: 'string',
            description: 'Stable slug for this customer (lowercase, snake-case-friendly, e.g. "acme-shop"). Calling with the same id later updates the same row.',
          },
          client_name: {
            type: 'string',
            description: 'Human-readable customer name as it appears in their branding (e.g. "Acme Shop Ltd").',
          },
          business_model: {
            type: 'string',
            description: 'One of: "ecommerce", "lead_gen", "subscription", "marketplace", "saas", "local_service", or a custom short tag if none fit.',
          },
          offer_summary: {
            type: 'string',
            description: 'One-sentence description of what the customer sells or offers, in their primary marketing language.',
          },
          primary_goal: {
            type: 'string',
            description: 'Primary optimisation goal: "roas", "cpa", "leads", "traffic", "awareness".',
          },
          target_roas: {
            type: 'number',
            description: 'Target return on ad spend as a multiplier (e.g. 5.0 = 5x). Use this for ecommerce; null otherwise.',
          },
          target_cpa_chf: {
            type: 'number',
            description: 'Target cost per acquisition in account currency (CHF/EUR/USD/etc.). Use this for lead-gen.',
          },
          monthly_budget_chf: {
            type: 'number',
            description: 'Approximate total monthly Google Ads budget in account currency.',
          },
          typical_cpc_chf: {
            type: 'number',
            description: 'Typical CPC the customer expects in their vertical — informs bid-strategy choice.',
          },
          country: {
            type: 'string',
            description: 'Primary geo (ISO 3166-1 alpha-2, e.g. "CH", "DE", "US").',
          },
          timezone: {
            type: 'string',
            description: 'IANA timezone (e.g. "Europe/Zurich"). Used for dayparting and report time-windows.',
          },
          languages: {
            type: 'array',
            items: { type: 'string' },
            description: 'Primary ad-copy languages (ISO 639-1, e.g. ["de", "fr"]).',
          },
          top_products: {
            type: 'array',
            items: { type: 'string' },
            description: 'Top product or service categories — used to seed campaign theming and to validate restructure proposals.',
          },
          own_brands: {
            type: 'array',
            items: { type: 'string' },
            description: 'Brands the customer owns (their own house brands).',
          },
          sold_brands: {
            type: 'array',
            items: { type: 'string' },
            description: 'Third-party brands the customer resells (relevant for trademark guidelines on ad copy).',
          },
          competitors: {
            type: 'array',
            items: { type: 'string' },
            description: 'Direct competitor brand names — fed into competitor-negatives and competitive-research views.',
          },
          pmax_owned_head_terms: {
            type: 'array',
            items: { type: 'string' },
            description: 'Broad category search terms PMAX already dominates for this customer. Become cross-campaign negative exact-match keywords on Search campaigns to prevent PMAX/Search cannibalisation. 8-20 terms is typical.',
          },
          naming_convention_pattern: {
            type: 'string',
            description: 'Campaign-name token template using {TOKEN} placeholders, e.g. "{LANG}-{CHANNEL}-{THEME}-{MATCHTYPE}" or "{LANG}-{BRAND}-{REGION}-{THEME}". Standard tokens (validated against vocabularies / customer profile): LANG (2-letter ISO, must match customer languages), CHANNEL (Search|Display|Shopping|PMAX|Video|Demand|App), MATCHTYPE (Exact|Phrase|Broad), BRAND (must match own_brands), REGION, THEME (free-form). Token names must be ALL_CAPS. The Blueprint engine validates every campaign / ad-group / asset-group name against this pattern; mismatches block emit until corrected.',
          },
          tracking_notes: {
            type: 'object',
            description: 'Free-form key-value pairs for tracking-related context (e.g. {"ga4_linked": true, "enhanced_conversions": false, "primary_conversion_action": "Purchase"}).',
            additionalProperties: true,
          },
          personas: {
            type: 'array',
            description: 'Optional buyer personas (1-4 typical). Strategist Brief + Critique reference these to tailor copy and channel mix recommendations.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Short label (e.g. "tech-affine Selbstständige").' },
                age_range: { type: 'string', description: 'Optional age band (e.g. "30-45").' },
                motivation: { type: 'string', description: 'Why this persona buys.' },
                pain_points: { type: 'array', items: { type: 'string' }, description: 'Top frustrations the offer solves.' },
                buying_triggers: { type: 'array', items: { type: 'string' }, description: 'Concrete events that trigger purchase.' },
              },
              required: ['name'],
            },
          },
          brand_voice: {
            type: 'object',
            description: 'Optional brand-voice descriptor. Critique uses do_not_use to flag drifting RSA copy.',
            properties: {
              tone: { type: 'string', description: 'e.g. "direkt, technisch, no-marketing-fluff".' },
              voice_examples: { type: 'array', items: { type: 'string' }, description: 'Real lines that capture the brand voice.' },
              do_not_use: { type: 'array', items: { type: 'string' }, description: 'Phrases / tones to avoid.' },
              signature_phrases: { type: 'array', items: { type: 'string' }, description: 'Brand-signature wording the customer wants in copy.' },
            },
          },
          usp: {
            type: 'array',
            items: { type: 'string' },
            description: 'Unique selling points — concrete reasons customers buy. Strategist references these when building Brand-Search RSA copy direction.',
          },
          compliance_constraints: {
            type: 'string',
            description: 'Free-form note on regulatory / legal copy constraints (e.g. "Healthcare claims must avoid \'cure\', \'guarantee\'; food: avoid health-effect promises that need EU approval"). Critique uses this to flag risky copy.',
          },
          pricing_strategy: {
            type: 'string',
            description: 'Free-form note on pricing posture (e.g. "Premium positioning, never discount; free shipping over CHF 100"). Critique uses this to flag mispriced copy or wrong audience signals.',
          },
          seasonal_patterns: {
            type: 'string',
            description: 'Free-form note on seasonality (e.g. "Peak Mar-May for kefir, Oct-Dec for water filters; B2B contract season Sep-Nov"). Strategist Brief uses this to time the priorities recommended in the cycle.',
          },
        },
        required: ['customer_id', 'client_name'],
      },
    },
    handler: async (input: AdsCustomerProfileSetInput, _agent: IAgent): Promise<string> => {
      try {
        const customerId = String(input.customer_id ?? '').trim();
        const clientName = String(input.client_name ?? '').trim();
        if (!customerId) return 'Error: customer_id is required (and must not be blank).';
        if (!clientName) return 'Error: client_name is required (and must not be blank).';
        if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(customerId)) {
          return `Error: customer_id "${customerId}" is invalid. Use 1-63 lowercase characters, digits, hyphens or underscores; must start with a letter or digit.`;
        }

        const existed = store.getCustomerProfile(customerId) !== null;
        const profile = store.upsertCustomerProfile({
          customerId,
          clientName,
          businessModel: input.business_model,
          offerSummary: input.offer_summary,
          primaryGoal: input.primary_goal,
          targetRoas: input.target_roas,
          targetCpaChf: input.target_cpa_chf,
          monthlyBudgetChf: input.monthly_budget_chf,
          typicalCpcChf: input.typical_cpc_chf,
          country: input.country,
          timezone: input.timezone,
          languages: input.languages,
          topProducts: input.top_products,
          ownBrands: input.own_brands,
          soldBrands: input.sold_brands,
          competitors: input.competitors,
          pmaxOwnedHeadTerms: input.pmax_owned_head_terms,
          namingConventionPattern: input.naming_convention_pattern,
          trackingNotes: input.tracking_notes,
          // P3 depth fields — pass through so partial updates can refine
          // the profile incrementally without wiping prior values.
          personas: input.personas,
          brandVoice: input.brand_voice,
          usp: input.usp,
          complianceConstraints: input.compliance_constraints,
          pricingStrategy: input.pricing_strategy,
          seasonalPatterns: input.seasonal_patterns,
        });
        return summariseProfile(profile, existed);
      } catch (err) {
        return `ads_customer_profile_set failed: ${getErrorMessage(err)}`;
      }
    },
  };
}

function summariseProfile(profile: {
  customer_id: string;
  client_name: string;
  business_model: string | null;
  primary_goal: string | null;
  target_roas: number | null;
  target_cpa_chf: number | null;
  monthly_budget_chf: number | null;
  country: string | null;
  languages: string;
  own_brands: string;
  competitors: string;
  pmax_owned_head_terms: string;
  naming_convention_pattern: string | null;
}, existed: boolean): string {
  const verb = existed ? 'Updated' : 'Created';
  const pmaxTerms = JSON.parse(profile.pmax_owned_head_terms) as string[];
  const competitors = JSON.parse(profile.competitors) as string[];
  const ownBrands = JSON.parse(profile.own_brands) as string[];
  const languages = JSON.parse(profile.languages) as string[];

  const lines: string[] = [
    `${verb} customer profile "${profile.client_name}" (${profile.customer_id}).`,
    '',
  ];
  if (profile.business_model) lines.push(`  business: ${profile.business_model}`);
  if (profile.primary_goal) lines.push(`  primary goal: ${profile.primary_goal}`);
  if (profile.target_roas !== null) lines.push(`  target ROAS: ${profile.target_roas}x`);
  if (profile.target_cpa_chf !== null) lines.push(`  target CPA: ${profile.target_cpa_chf}`);
  if (profile.monthly_budget_chf !== null) lines.push(`  monthly budget: ${profile.monthly_budget_chf}`);
  if (profile.country) lines.push(`  country: ${profile.country}${languages.length > 0 ? ` (${languages.join(', ')})` : ''}`);
  if (ownBrands.length > 0) lines.push(`  own brands: ${ownBrands.join(', ')}`);
  if (competitors.length > 0) lines.push(`  competitors: ${competitors.join(', ')}`);
  if (pmaxTerms.length > 0) lines.push(`  PMAX-owned head terms: ${pmaxTerms.length} (${pmaxTerms.slice(0, 5).join(', ')}${pmaxTerms.length > 5 ? '…' : ''})`);
  if (profile.naming_convention_pattern) lines.push(`  naming: ${profile.naming_convention_pattern}`);

  if (pmaxTerms.length === 0 || competitors.length === 0 || profile.naming_convention_pattern === null) {
    lines.push('');
    lines.push('Reminder: the Ads Optimizer downstream pipeline relies on');
    lines.push('competitors, pmax_owned_head_terms, and naming_convention_pattern.');
    lines.push('Consider revisiting the profile to fill these in before the first cycle.');
  }

  return lines.join('\n');
}
