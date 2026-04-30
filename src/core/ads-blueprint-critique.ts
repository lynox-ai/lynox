/**
 * Tier-2 LLM critique that auto-runs after `ads_blueprint_run`.
 *
 * Reads the persisted blueprint entities + the audit-tool findings +
 * the strategist brief + the customer profile, asks Sonnet to find
 * 3-5 SPECIFIC challenges to the auto-Blueprint's decisions. The
 * goal is operator-as-sparring-partner: the auto-pipeline produces
 * proposals, the critique surfaces what the deterministic logic
 * MIGHT have missed, the operator decides.
 *
 * Output is intentionally not a hard block — it's a list of
 * "consider this" prompts. Hard blocks are the Phase-C engine's
 * job (ads_blueprint_review). The critique is gentler: it raises
 * questions about strategy, not validation.
 *
 * Examples of good critiques (what the model is briefed for):
 *   - "You're proposing to negative-block 'wasserkocher entkalken'
 *      but the LP /produkte/wasserkocher exists — re-check before
 *      blocking"
 *   - "Brand-Search budget 18 CHF/day is 1.8% of monthly customer
 *      budget — fine, but consider scaling to 5% during launch
 *      window"
 *   - "Theme-AG 'glas' has only 3 placeholder headlines — the
 *      operator must add 5+ themed headlines before publish"
 *
 * Cache-aware: customer profile + critique rules in cached system
 * prompt, blueprint summary in user message.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaTextBlockParam, BetaCacheControlEphemeral,
} from '@anthropic-ai/sdk/resources/beta/messages.js';
import type {
  AdsDataStore, CustomerProfileRow, AdsBlueprintEntityRow, AdsFindingRow,
  BlueprintCritiqueChallenge, StrategistBriefRow,
} from './ads-data-store.js';
import { createLLMClient, getActiveProvider, isCustomProvider } from './llm-client.js';
import { getBetasForProvider, getModelId } from '../types/index.js';
import { buildCustomerContextWithDepth } from './ads-customer-profile-context.js';

export interface BlueprintCritiqueResult {
  challenges: BlueprintCritiqueChallenge[];
  llmFailed: boolean;
  failureReason?: string;
}

export interface BlueprintCritiqueOptions {
  apiKey?: string | undefined;
  apiBaseURL?: string | undefined;
  /** Inject for tests; bypasses the real API call. */
  client?: Anthropic | undefined;
}

const TOOL_NAME = 'emit_blueprint_critique';

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description: 'Emit 3 to 5 specific challenges to the auto-Blueprint that the operator should consider before emit.',
  input_schema: {
    type: 'object' as const,
    properties: {
      challenges: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            title: { type: 'string' as const, description: 'Short headline of the challenge.' },
            challenge: { type: 'string' as const, description: 'The actual question / concern, 1-3 sentences. Must reference a specific entity or decision.' },
            ref: { type: 'string' as const, description: 'Optional pointer to the blueprint entity / finding the challenge concerns (e.g. "Brand-Hamoni RSA", "pmax_brand_inflation").' },
          },
          required: ['title', 'challenge'],
        },
        description: '3 to 5 challenges. Specific. Not generic SEO advice.',
      },
    },
    required: ['challenges'],
  },
};

const SYSTEM_PROMPT = `You are a senior Google Ads strategist reviewing an auto-generated Blueprint that proposes campaign / asset-group / keyword / negative changes for the next cycle.

Your job: find 3-5 SPECIFIC challenges to the auto-decisions. The operator already has the Phase-C deterministic validators (duplicate URLs, naming drift, budget anomalies) — your job is the SOFT layer those don't catch. Strategic mismatches, missed context, premature decisions.

Hard rules:
- Each challenge must reference a SPECIFIC entity (campaign name, asset group name, finding area). No generic advice like "review your bidding strategy".
- Be specific about what the auto-pipeline did and why it might be wrong.
- Frame as questions / concerns the operator should think about, not commands.
- Lean on customer profile context — does the proposal match their stated goal? business model? country/language?
- Reference the strategist brief — does the blueprint actually execute what the brief recommends, or did the auto-pipeline drift?
- 3 to 5 challenges. Not less, not more.

Examples of GOOD challenges:
- title: "Brand-Aquanatura RSA may underdeliver vs PMax"
  challenge: "The auto-pipeline proposes a Brand-Search at 18 CHF/day. Customer's monthly budget is 3000 CHF (~100 CHF/day). 18 CHF/day is 18% of budget for one campaign — verify this matches the strategist's 'protect ROAS' priority before launching."
  ref: "Search-Brand campaign"

- title: "Theme-AG 'glas' may not match top_products"
  challenge: "Blueprint emits NEW asset_group 'Theme-Glas' but customer.top_products lists 'wasserfilter, kefir' — 'glas' is adjacent at best. Reconsider whether this AG is worth the smart-bidding warm-up cost."
  ref: "Theme-Glas asset_group"

Examples of BAD challenges (do NOT emit these):
- "Review your bidding strategy" (no specificity)
- "Make sure your ads convert" (generic)
- "Check Google Ads best practices" (no actionable insight)

Use customer profile depth fields when present (P3):
- "Brand voice" do_not_use list → flag any RSA / Asset-Group copy that drifts toward forbidden tone or words.
- "Compliance constraints" → flag any copy or claim that risks violating them. This is high-priority — compliance failures are expensive.
- "Pricing strategy" → flag mismatches (e.g. discount-tone copy on a premium-positioning customer).
- "Personas" → flag missing persona alignment in Brand-RSAs.
- "Seasonality" → flag launch timing conflicts (e.g. ramping a kefir AG in November when peak is Mar-May).
- "Unique selling points" → flag RSA copy that buries USPs in description position 2.

When a depth field is missing, just challenge from base profile + findings.`;


function buildBlueprintContext(
  entities: readonly AdsBlueprintEntityRow[],
  findings: readonly AdsFindingRow[],
  brief: StrategistBriefRow | null,
): string {
  const lines: string[] = [];
  if (brief) {
    lines.push('# Strategist Brief (this cycle)');
    lines.push(`- Account state: ${brief.account_state}`);
    lines.push(`- Headline: ${brief.headline || '(none)'}`);
    try {
      const priorities = JSON.parse(brief.priorities_json) as Array<{ title: string }>;
      if (Array.isArray(priorities) && priorities.length > 0) {
        lines.push('- Priorities:');
        for (const p of priorities) lines.push(`  - ${p.title}`);
      }
    } catch { /* ignore */ }
    try {
      const risks = JSON.parse(brief.risks_json) as string[];
      if (Array.isArray(risks) && risks.length > 0) {
        lines.push(`- Risks: ${risks.join('; ')}`);
      }
    } catch { /* ignore */ }
    lines.push('');
  }

  lines.push('# Audit findings (post-classification)');
  if (findings.length === 0) {
    lines.push('- (none)');
  } else {
    for (const f of findings) {
      lines.push(`- [${f.severity}] ${f.area}: ${truncate(f.text, 220)}`);
    }
  }
  lines.push('');

  lines.push('# Blueprint summary');
  // Group by entity_type + kind for compact summary, then sample 3 per bucket
  type Bucket = { kind: string; entities: AdsBlueprintEntityRow[] };
  const grouped = new Map<string, Map<string, Bucket>>();
  for (const e of entities) {
    const byKind = grouped.get(e.entity_type) ?? new Map<string, Bucket>();
    const bucket = byKind.get(e.kind) ?? { kind: e.kind, entities: [] };
    bucket.entities.push(e);
    byKind.set(e.kind, bucket);
    grouped.set(e.entity_type, byKind);
  }
  for (const [entityType, byKind] of grouped) {
    for (const [kind, bucket] of byKind) {
      lines.push(`- ${entityType} ${kind}: ${bucket.entities.length}`);
      for (const e of bucket.entities.slice(0, 3)) {
        const summary = entitySummary(e);
        lines.push(`  - ${summary}`);
      }
      if (bucket.entities.length > 3) {
        lines.push(`  - … +${bucket.entities.length - 3} more`);
      }
    }
  }
  return lines.join('\n');
}

function entitySummary(e: AdsBlueprintEntityRow): string {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(e.payload_json);
    payload = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as Record<string, unknown> : {};
  } catch { /* ignore */ }
  const name = stringField(payload, 'asset_group_name')
    ?? stringField(payload, 'ad_group_name')
    ?? stringField(payload, 'campaign_name')
    ?? stringField(payload, 'keyword')
    ?? stringField(payload, 'keyword_text')
    ?? e.external_id;
  const url = stringField(payload, 'final_url');
  const budget = numberField(payload, 'budget_chf');
  const tags: string[] = [];
  if (url) tags.push(`url=${truncate(url, 60)}`);
  if (budget !== null) tags.push(`budget=${budget} CHF/day`);
  return tags.length > 0 ? `${name} [${tags.join(', ')}]` : name;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numberField(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export async function generateBlueprintCritique(
  store: AdsDataStore, runId: number, customer: CustomerProfileRow,
  opts: BlueprintCritiqueOptions = {},
): Promise<BlueprintCritiqueResult> {
  const entities = store.listBlueprintEntities(runId);
  if (entities.length === 0) {
    return { challenges: [], llmFailed: false };
  }
  const findings = store.listFindings(runId);
  const brief = store.getStrategistBrief(runId);

  const client = opts.client ?? safeCreateClient(opts);
  if (!client) {
    return {
      challenges: [],
      llmFailed: true,
      failureReason: 'no LLM client available',
    };
  }

  const provider = getActiveProvider();
  const cacheControl: BetaCacheControlEphemeral | undefined = isCustomProvider()
    ? undefined
    : ({ type: 'ephemeral', ttl: '1h' } as unknown as BetaCacheControlEphemeral);

  const systemBlocks: BetaTextBlockParam[] = [
    {
      type: 'text',
      text: `${SYSTEM_PROMPT}\n\n${buildCustomerContextWithDepth(customer)}`,
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    },
  ];

  const userMessage = buildBlueprintContext(entities, findings, brief);

  try {
    const stream = client.beta.messages.stream({
      model: getModelId('sonnet', provider),
      max_tokens: 1536,
      temperature: 0.2,
      ...(isCustomProvider() ? {} : { betas: getBetasForProvider(provider) }),
      system: systemBlocks,
      tools: [TOOL_DEFINITION],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: userMessage }],
    });

    const response = await stream.finalMessage();
    const toolUse = response.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> =>
        b.type === 'tool_use' && b.name === TOOL_NAME,
    );
    if (!toolUse) {
      return { challenges: [], llmFailed: true, failureReason: 'model returned no tool_use block' };
    }

    return parseCritique(toolUse.input);
  } catch (err) {
    return {
      challenges: [],
      llmFailed: true,
      failureReason: `LLM error: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }
}

function safeCreateClient(opts: BlueprintCritiqueOptions): Anthropic | null {
  try {
    return createLLMClient({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.apiBaseURL ? { apiBaseURL: opts.apiBaseURL } : {}),
    });
  } catch {
    return null;
  }
}

export function parseCritique(rawInput: unknown): BlueprintCritiqueResult {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return { challenges: [], llmFailed: true, failureReason: 'malformed critique input' };
  }
  const obj = rawInput as Record<string, unknown>;
  const challenges: BlueprintCritiqueChallenge[] = [];
  if (Array.isArray(obj['challenges'])) {
    for (const c of obj['challenges']) {
      if (!c || typeof c !== 'object') continue;
      const cc = c as Record<string, unknown>;
      const title = typeof cc['title'] === 'string' ? cc['title'].trim() : '';
      const challenge = typeof cc['challenge'] === 'string' ? cc['challenge'].trim() : '';
      const ref = typeof cc['ref'] === 'string' ? cc['ref'].trim() : undefined;
      if (!title || !challenge) continue;
      challenges.push({
        title, challenge,
        ...(ref ? { ref } : {}),
      });
    }
  }
  if (challenges.length === 0) {
    return { challenges: [], llmFailed: true, failureReason: 'empty critique from model' };
  }
  return { challenges, llmFailed: false };
}
