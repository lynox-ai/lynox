/**
 * Tier-2 LLM intent classifier for search terms that match a customer
 * profile competitor (`competitor_term_bidding` finding evidence).
 *
 * Each input gets one of:
 *   - "intentional_competitive" — customer is deliberately bidding on
 *                                 this competitor (defensive or offensive
 *                                 conquest play). Leave it. Operator
 *                                 should track conversion ROI separately.
 *   - "unintentional_leak"      — broad-match / PMax leak. The customer
 *                                 doesn't strategically bid on this
 *                                 competitor — should become a negative
 *                                 keyword.
 *   - "uncertain"               — model can't decide. Phase-A operator
 *                                 review marker rather than silent drop.
 *
 * Same caching pattern as `ads-theme-classifier` and
 * `ads-search-term-relevance-classifier`: customer profile + competitor
 * list in cached system prompt, terms in variable user message.
 *
 * Fail-safe: any error routes every input to "uncertain" so the
 * operator sees them rather than silently keeping or blocking them.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaTextBlockParam, BetaCacheControlEphemeral,
} from '@anthropic-ai/sdk/resources/beta/messages.js';
import type { CustomerProfileRow } from './ads-data-store.js';
import { createLLMClient, getActiveProvider, isCustomProvider } from './llm-client.js';
import { getBetasForProvider, getModelId } from '../types/index.js';

export type CompetitorIntentCategory = 'intentional_competitive' | 'unintentional_leak' | 'uncertain';

export interface ClassifiedCompetitorTerm {
  term: string;
  matched_competitor: string;
  category: CompetitorIntentCategory;
  reason: string;
}

export interface CompetitorTermClassification {
  classifications: ReadonlyArray<ClassifiedCompetitorTerm>;
  byCategory: Readonly<Record<CompetitorIntentCategory, ReadonlyArray<string>>>;
}

export interface ClassifyCompetitorOptions {
  apiKey?: string | undefined;
  apiBaseURL?: string | undefined;
  /** Inject for tests; bypasses the real API call. */
  client?: Anthropic | undefined;
}

const TOOL_NAME = 'classify_competitor_term_intent';

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description: 'Classify each search term that matched a customer competitor as intentional_competitive, unintentional_leak, or uncertain.',
  input_schema: {
    type: 'object' as const,
    properties: {
      classifications: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            term: { type: 'string' as const },
            matched_competitor: { type: 'string' as const },
            category: {
              type: 'string' as const,
              enum: ['intentional_competitive', 'unintentional_leak', 'uncertain'],
            },
            reason: { type: 'string' as const, description: 'One short sentence why.' },
          },
          required: ['term', 'matched_competitor', 'category', 'reason'],
        },
      },
    },
    required: ['classifications'],
  },
};

const SYSTEM_PROMPT_HEAD = `You are a Google Ads strategist judging whether each search term that matched a customer's competitor is INTENTIONAL conquest bidding or an UNINTENTIONAL match leak.

Each term spent budget on a query containing a known competitor name from the customer's profile. The operator wants to know whether to leave it (intentional play) or block it as a negative (unintentional leak).

Bucket every term into exactly one of:
- "intentional_competitive": the customer's strategy supports bidding on competitor terms (e.g. customer.primary_goal mentions awareness/growth, customer is in an aggressive market segment, the term is a competitor brand the customer explicitly targets). Leave it.
- "unintentional_leak": the customer is a small / defensive / non-conquest brand and the term most likely came in via PMax broad-match or default keyword expansion. Add as negative.
- "uncertain": the strategic intent is genuinely ambiguous from the profile alone — operator decides.

Defensive bias: when in doubt, mark "uncertain" so the operator decides. A wrong "intentional_competitive" wastes budget; a wrong "unintentional_leak" silently kills a paid acquisition channel the customer might actually want.

Each "reason" must be one short sentence.`;

function buildCustomerContext(customer: CustomerProfileRow): string {
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
  const tops = parsed(customer.top_products);
  if (tops.length) lines.push(`- Top products / themes: ${tops.join(', ')}`);
  const own = parsed(customer.own_brands);
  if (own.length) lines.push(`- Own brands: ${own.join(', ')}`);
  const sold = parsed(customer.sold_brands);
  if (sold.length) lines.push(`- Sold brands: ${sold.join(', ')}`);
  const comp = parsed(customer.competitors);
  if (comp.length) lines.push(`- Known competitors: ${comp.join(', ')}`);
  return lines.join('\n');
}

interface InputItem {
  term: string;
  matched_competitor: string;
}

/** Classify competitor-matched search terms for intent. Always returns
 *  one entry per input (errors → 'uncertain' fallback). */
export async function classifyCompetitorTermIntent(
  items: readonly InputItem[],
  customer: CustomerProfileRow,
  opts: ClassifyCompetitorOptions = {},
): Promise<CompetitorTermClassification> {
  const seen = new Set<string>();
  const unique: InputItem[] = [];
  for (const it of items) {
    const term = it.term.trim();
    const comp = it.matched_competitor.trim();
    if (!term || !comp) continue;
    const key = `${term.toLowerCase()}\x00${comp.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ term, matched_competitor: comp });
  }
  if (unique.length === 0) {
    return { classifications: [], byCategory: emptyByCategory() };
  }

  const client = opts.client ?? safeCreateClient(opts);
  if (!client) return fallbackUncertain(unique, 'no LLM client available');

  const provider = getActiveProvider();
  const cacheControl: BetaCacheControlEphemeral | undefined = isCustomProvider()
    ? undefined
    : ({ type: 'ephemeral', ttl: '1h' } as unknown as BetaCacheControlEphemeral);

  const systemBlocks: BetaTextBlockParam[] = [
    {
      type: 'text',
      text: `${SYSTEM_PROMPT_HEAD}\n\n${buildCustomerContext(customer)}`,
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    },
  ];

  const userMessage = `Search terms that matched a known competitor (one per line, "term | competitor"):\n` +
    unique.map(u => `${u.term} | ${u.matched_competitor}`).join('\n');

  try {
    const stream = client.beta.messages.stream({
      model: getModelId('haiku', provider),
      max_tokens: 4096,
      temperature: 0,
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
    if (!toolUse) return fallbackUncertain(unique, 'model returned no tool_use block');

    return parseClassification(unique, toolUse.input);
  } catch (err) {
    return fallbackUncertain(unique, `LLM error: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

function safeCreateClient(opts: ClassifyCompetitorOptions): Anthropic | null {
  try {
    return createLLMClient({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.apiBaseURL ? { apiBaseURL: opts.apiBaseURL } : {}),
    });
  } catch {
    return null;
  }
}

function emptyByCategory(): Record<CompetitorIntentCategory, ReadonlyArray<string>> {
  return { intentional_competitive: [], unintentional_leak: [], uncertain: [] };
}

function fallbackUncertain(items: readonly InputItem[], reason: string): CompetitorTermClassification {
  const classifications = items.map(it => ({
    term: it.term, matched_competitor: it.matched_competitor,
    category: 'uncertain' as const, reason,
  }));
  return {
    classifications,
    byCategory: { intentional_competitive: [], unintentional_leak: [], uncertain: items.map(i => i.term) },
  };
}

export function parseClassification(
  inputItems: readonly InputItem[], rawInput: unknown,
): CompetitorTermClassification {
  const seen = new Map<string, ClassifiedCompetitorTerm>();
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const arr = (rawInput as { classifications?: unknown }).classifications;
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const term = typeof r['term'] === 'string' ? r['term'].trim() : '';
        const competitor = typeof r['matched_competitor'] === 'string' ? r['matched_competitor'].trim() : '';
        const category = typeof r['category'] === 'string' ? r['category'] : '';
        const reason = typeof r['reason'] === 'string' ? r['reason'] : '';
        if (!term || !competitor) continue;
        if (!isCompetitorIntentCategory(category)) continue;
        const key = `${term.toLowerCase()}\x00${competitor.toLowerCase()}`;
        if (!seen.has(key)) seen.set(key, { term, matched_competitor: competitor, category, reason });
      }
    }
  }
  const classifications: ClassifiedCompetitorTerm[] = [];
  for (const it of inputItems) {
    const key = `${it.term.toLowerCase()}\x00${it.matched_competitor.toLowerCase()}`;
    const found = seen.get(key);
    classifications.push(found ?? {
      term: it.term, matched_competitor: it.matched_competitor,
      category: 'uncertain',
      reason: 'Model did not return a classification for this term.',
    });
  }
  const byCategory: Record<CompetitorIntentCategory, string[]> =
    { intentional_competitive: [], unintentional_leak: [], uncertain: [] };
  for (const c of classifications) byCategory[c.category].push(c.term);
  return { classifications, byCategory };
}

function isCompetitorIntentCategory(s: string): s is CompetitorIntentCategory {
  return s === 'intentional_competitive' || s === 'unintentional_leak' || s === 'uncertain';
}
