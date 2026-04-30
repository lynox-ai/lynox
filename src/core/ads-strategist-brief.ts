/**
 * Tier-2 LLM strategist that synthesizes a 1-page brief on top of
 * the deterministic findings + customer profile + KPIs + account-
 * state classification.
 *
 * Output shape (always — fail-safe defaults on error):
 *   - headline:      one sentence summarizing the account this cycle
 *   - priorities:    3 ranked recommendations, each with rationale + actions
 *   - risks:         1-3 risk callouts (emit, change concentration, regression)
 *   - do_not_touch:  campaigns / asset-groups the operator should leave alone
 *
 * The brief is GROUNDED in the deterministic findings — it does not
 * invent numbers. Every priority must reference at least one finding
 * area or customer-profile field. The model is instructed to skip
 * fabrication; on parse error / network failure, the fallback brief
 * surfaces the deterministic state + a "LLM unavailable" notice
 * rather than silently returning generic advice.
 *
 * Cache-aware: customer profile + briefing rules sit in the cached
 * system prompt, the per-cycle context (state, findings summary, KPIs)
 * goes in the user message. Cycle 2+ for the same customer hits the
 * Anthropic prompt cache.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaTextBlockParam, BetaCacheControlEphemeral,
} from '@anthropic-ai/sdk/resources/beta/messages.js';
import type {
  CustomerProfileRow, AdsAccountState, StrategistPriority,
} from './ads-data-store.js';
import type { AuditResult, AuditFindingDraft } from './ads-audit-engine.js';
import { createLLMClient, getActiveProvider, isCustomProvider } from './llm-client.js';
import { getBetasForProvider, getModelId } from '../types/index.js';

export interface StrategistBriefResult {
  headline: string;
  priorities: StrategistPriority[];
  risks: string[];
  doNotTouch: string[];
  llmFailed: boolean;
  failureReason?: string;
}

export interface StrategistBriefOptions {
  apiKey?: string | undefined;
  apiBaseURL?: string | undefined;
  /** Inject for tests; bypasses the real API call. */
  client?: Anthropic | undefined;
}

const TOOL_NAME = 'emit_strategist_brief';

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description: 'Emit the strategist brief: headline, three prioritized recommendations, risk callouts, and a list of campaigns to leave alone.',
  input_schema: {
    type: 'object' as const,
    properties: {
      headline: { type: 'string' as const, description: 'One sentence summarizing the account this cycle.' },
      priorities: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            title: { type: 'string' as const },
            rationale: { type: 'string' as const, description: 'Why this matters; reference a finding area or profile field.' },
            actions: { type: 'array' as const, items: { type: 'string' as const } },
          },
          required: ['title', 'rationale', 'actions'],
        },
        description: 'Exactly 3 ranked recommendations.',
      },
      risks: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: '1-3 risk callouts the operator should be aware of before acting.',
      },
      do_not_touch: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Campaign or asset-group names to leave alone (high-performers, fragile setups).',
      },
    },
    required: ['headline', 'priorities', 'risks', 'do_not_touch'],
  },
};

function systemPromptForState(state: AdsAccountState): string {
  const base = `You are a senior Google Ads strategist briefing an experienced operator.
The operator has the full audit findings + blueprint in front of them — your job is SYNTHESIS, not repetition.

Hard rules:
- Ground every priority in at least one specific finding area or customer-profile field. Never invent numbers; reference what the findings already proved.
- Be specific. "Optimize ad copy" is useless. "Rewrite the Brand-Aquanatura RSA headlines to lead with the Hamoni unique-mechanism claim" is useful.
- Three priorities. Ranked. Top one is what the operator should do FIRST.
- Risks are warnings about side-effects of acting on the priorities (smart-bidding learning loss, cannibalization, brand-traffic gap).
- "do_not_touch" is the watch-list of campaigns / asset-groups that work — protect them.
- No marketing language. The operator is technical.`;

  switch (state) {
    case 'greenfield':
      return `${base}

The account is GREENFIELD — no spend, no clicks, no historical data.
Your priorities should be SETUP priorities: which campaigns to launch first, what budget split, which keywords are the safest seed list. Pull from customer.top_products + customer.own_brands + customer.competitors.
Risks: launching too broad, no conversion tracking, untested LP. "do_not_touch" should usually be empty in greenfield mode.`;
    case 'bootstrap':
      return `${base}

The account is in BOOTSTRAP / FIRST_IMPORT mode — under 14 days of post-import data, smart-bidding hasn't converged yet.
Your priorities should be SETUP-completion priorities: tracking gaps, asset minimums, audience signals, naming conventions. Avoid restructure proposals — too early. Wait for the smart-bidding window to close before recommending pause/rename actions.
Risks: judging performance too early, premature negatives.`;
    case 'messy_running':
      return `${base}

The account is RUNNING but MESSY — multiple HIGH findings or under-target ROAS.
Your priorities should be a PHASED restructure plan. Cycle 1 = highest-impact lowest-risk (negatives, brand-search, theme coverage). Cycle 2 = medium changes. Cycle 3 = cleanup.
Critical: do NOT propose all changes at once. Phasing limits smart-bidding learning loss.
Risks: change concentration, brand-traffic gap during PMAX-block transition, conv-volume drop after split.`;
    case 'structured_optimizing':
      return `${base}

The account is STRUCTURED + OPTIMIZING — ROAS near target, ≤ 2 HIGH findings, regular tweak cycle.
Your priorities should be INCREMENTAL: marginal optimizations, asset refresh, negative refinement, audience-signal tuning. Reference the verification result if there was one — call out which previous changes paid off.
Risks: over-optimization, breaking what works.`;
    case 'high_performance':
      return `${base}

The account is HIGH-PERFORMANCE — ROAS ≥ 1.3× target, minimal findings.
Your priorities should be PROTECTIVE. Top priority is usually "leave it alone — keep watching". Suggest only experiments that won't disturb the running campaigns (new asset_group, new geo, new audience signal).
"do_not_touch" should list every campaign with healthy ROAS — make this explicit.
Risks: any structural change risks regression; warn against broad-match expansion or bid-strategy switches.`;
  }
}

function buildCustomerContext(customer: CustomerProfileRow | null): string {
  if (!customer) return '# Customer profile\n- (missing)';
  const parsed = (json: string): string[] => {
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  };
  const lines: string[] = [];
  lines.push('# Customer profile');
  lines.push(`- Client: ${customer.client_name}`);
  if (customer.country) lines.push(`- Country: ${customer.country}`);
  const langs = parsed(customer.languages);
  if (langs.length) lines.push(`- Languages: ${langs.join(', ')}`);
  if (customer.business_model) lines.push(`- Business model: ${customer.business_model}`);
  if (customer.offer_summary) lines.push(`- Offer: ${customer.offer_summary}`);
  if (customer.primary_goal) lines.push(`- Primary goal: ${customer.primary_goal}`);
  if (customer.target_roas) lines.push(`- Target ROAS: ${customer.target_roas.toFixed(2)}x`);
  if (customer.target_cpa_chf) lines.push(`- Target CPA: ${customer.target_cpa_chf.toFixed(2)} CHF`);
  if (customer.monthly_budget_chf) lines.push(`- Monthly budget: ${customer.monthly_budget_chf.toFixed(0)} CHF`);
  const tops = parsed(customer.top_products);
  if (tops.length) lines.push(`- Top products / themes: ${tops.join(', ')}`);
  const own = parsed(customer.own_brands);
  if (own.length) lines.push(`- Own brands: ${own.join(', ')}`);
  const sold = parsed(customer.sold_brands);
  if (sold.length) lines.push(`- Sold brands: ${sold.join(', ')}`);
  const comp = parsed(customer.competitors);
  if (comp.length) lines.push(`- Competitors: ${comp.join(', ')}`);
  return lines.join('\n');
}

function buildCycleContext(result: AuditResult, state: AdsAccountState, stateReason: string): string {
  const lines: string[] = [];
  lines.push(`# Cycle context`);
  lines.push(`- Account state: **${state}** (${stateReason})`);
  lines.push(`- Audit run #${result.run.run_id} (${result.run.mode})`);
  lines.push(`- Mode detected: ${result.mode.detected} (recorded ${result.mode.recordedAccountMode})`);
  if (result.previousRun) {
    lines.push(`- Previous run #${result.previousRun.run_id} finished ${result.previousRun.finished_at ?? '?'}`);
  }
  lines.push('');
  lines.push('## KPIs');
  lines.push(`- Spend: ${result.kpis.spend.toFixed(2)} CHF`);
  lines.push(`- Conversions: ${result.kpis.conversions.toFixed(1)}`);
  lines.push(`- Conversion value: ${result.kpis.convValue.toFixed(2)} CHF`);
  if (result.kpis.roas !== null) lines.push(`- ROAS: ${result.kpis.roas.toFixed(2)}x`);
  if (result.kpis.cpa !== null && result.kpis.cpa > 0) lines.push(`- CPA: ${result.kpis.cpa.toFixed(2)} CHF`);
  if (result.kpis.ctr !== null) lines.push(`- CTR: ${(result.kpis.ctr * 100).toFixed(2)}%`);
  lines.push('');
  lines.push('## Findings (post-classification)');
  if (result.findings.length === 0) {
    lines.push('- (none)');
  } else {
    for (const f of result.findings) {
      lines.push(`- [${f.severity}] ${f.area}: ${truncate(f.text, 280)}`);
    }
  }
  if (result.verification && !result.verification.skipped) {
    lines.push('');
    lines.push('## Last-cycle verification');
    const v = result.verification;
    const counts = v.counts as Record<string, number>;
    lines.push(`- ${v.items.length} entities verified over ${v.windowDays} days`);
    if (counts['VERSCHLECHTERUNG']) lines.push(`- Regressions: ${counts['VERSCHLECHTERUNG']}`);
    if (counts['VERBESSERUNG']) lines.push(`- Improvements: ${counts['VERBESSERUNG']}`);
  }
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export async function generateStrategistBrief(
  result: AuditResult,
  state: AdsAccountState,
  stateReason: string,
  opts: StrategistBriefOptions = {},
): Promise<StrategistBriefResult> {
  const client = opts.client ?? safeCreateClient(opts);
  if (!client) return fallback(result, state, stateReason, 'no LLM client available');

  const provider = getActiveProvider();
  const cacheControl: BetaCacheControlEphemeral | undefined = isCustomProvider()
    ? undefined
    : ({ type: 'ephemeral', ttl: '1h' } as unknown as BetaCacheControlEphemeral);

  // System prompt is the cache prefix: state-specific briefing rules +
  // customer profile. Both change rarely for the same customer.
  const systemBlocks: BetaTextBlockParam[] = [
    {
      type: 'text',
      text: `${systemPromptForState(state)}\n\n${buildCustomerContext(result.customer)}`,
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    },
  ];

  // User message is the per-cycle volatile context.
  const userMessage = buildCycleContext(result, state, stateReason);

  try {
    // Sonnet for synthesis quality — Haiku tends to repeat findings
    // verbatim instead of synthesizing into priorities.
    const stream = client.beta.messages.stream({
      model: getModelId('sonnet', provider),
      max_tokens: 2048,
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
    if (!toolUse) return fallback(result, state, stateReason, 'model returned no tool_use block');

    return parseBrief(toolUse.input);
  } catch (err) {
    return fallback(result, state, stateReason, `LLM error: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

function safeCreateClient(opts: StrategistBriefOptions): Anthropic | null {
  try {
    return createLLMClient({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.apiBaseURL ? { apiBaseURL: opts.apiBaseURL } : {}),
    });
  } catch {
    return null;
  }
}

/** Parse the model's tool-use input into our typed result shape. */
export function parseBrief(rawInput: unknown): StrategistBriefResult {
  const empty: StrategistBriefResult = {
    headline: '', priorities: [], risks: [], doNotTouch: [], llmFailed: false,
  };
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return { ...empty, llmFailed: true, failureReason: 'malformed brief input' };
  }
  const obj = rawInput as Record<string, unknown>;
  const headline = typeof obj['headline'] === 'string' ? obj['headline'].trim() : '';

  const priorities: StrategistPriority[] = [];
  if (Array.isArray(obj['priorities'])) {
    for (const p of obj['priorities']) {
      if (!p || typeof p !== 'object') continue;
      const pp = p as Record<string, unknown>;
      const title = typeof pp['title'] === 'string' ? pp['title'].trim() : '';
      const rationale = typeof pp['rationale'] === 'string' ? pp['rationale'].trim() : '';
      const actions = Array.isArray(pp['actions'])
        ? pp['actions'].filter((a): a is string => typeof a === 'string').map(a => a.trim()).filter(a => a.length > 0)
        : [];
      if (!title) continue;
      priorities.push({ title, rationale, actions });
    }
  }
  const risks = Array.isArray(obj['risks'])
    ? obj['risks'].filter((r): r is string => typeof r === 'string').map(r => r.trim()).filter(r => r.length > 0)
    : [];
  const doNotTouch = Array.isArray(obj['do_not_touch'])
    ? obj['do_not_touch'].filter((r): r is string => typeof r === 'string').map(r => r.trim()).filter(r => r.length > 0)
    : [];

  if (headline.length === 0 && priorities.length === 0) {
    return { ...empty, llmFailed: true, failureReason: 'empty brief from model' };
  }
  return { headline, priorities, risks, doNotTouch, llmFailed: false };
}

/** Fail-safe brief — keeps the audit Markdown useful even when the
 *  LLM is unavailable. Surfaces the deterministic state + a heads-up
 *  to the operator that the LLM layer didn't run. */
function fallback(
  result: AuditResult, state: AdsAccountState, stateReason: string, reason: string,
): StrategistBriefResult {
  const highFindings = result.findings.filter(f => f.severity === 'HIGH').slice(0, 3);
  const priorities: StrategistPriority[] = highFindings.map(f => ({
    title: prettifyArea(f.area),
    rationale: truncate(f.text, 200),
    actions: ['Operator: review the deterministic finding and decide manually.'],
  }));
  return {
    headline: `[${state}] ${stateReason}`,
    priorities,
    risks: ['LLM strategist unavailable — operator must synthesize the priorities manually from the finding list below.'],
    doNotTouch: [],
    llmFailed: true,
    failureReason: reason,
  };
}

function prettifyArea(area: string): string {
  return area.replace(/[_:]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function fallbackUnused(_input: AuditFindingDraft): void {
  // Re-export keeps tree-shake from removing AuditFindingDraft import
  // when the type is only used in interface signatures.
}
void fallbackUnused;
