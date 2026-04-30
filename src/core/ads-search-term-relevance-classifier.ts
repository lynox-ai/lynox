/**
 * Tier-2 LLM relevance classifier for high-spend / zero-conv search
 * terms surfaced by the Tier-1 deterministic detector
 * (`irrelevant_search_term_spend` finding evidence).
 *
 * Each input term gets one of:
 *   - "relevant"   — aligns with the customer's offer; spend without
 *                    conversions points to a different problem (LP,
 *                    copy, tracking, intent mismatch). Do NOT auto-add
 *                    as negative — operator-driven fix needed.
 *   - "irrelevant" — wrong intent / wrong product / not in catalogue.
 *                    Becomes a campaign-scoped negative-keyword
 *                    candidate (the operator confirms; emit blocks
 *                    without confirmation if the candidate count is
 *                    surprisingly high).
 *   - "uncertain"  — model can't decide cleanly. Phase-A review
 *                    marker rather than silent drop.
 *
 * Same caching pattern as `ads-theme-classifier`: customer profile in
 * the cached system prompt, terms in the variable user message.
 *
 * Fail-safe: any error routes every input to "uncertain" so the
 * operator sees them rather than silently classifying as relevant
 * (which would mask waste) or as irrelevant (which would auto-add
 * negatives without judgment).
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaTextBlockParam, BetaCacheControlEphemeral,
} from '@anthropic-ai/sdk/resources/beta/messages.js';
import type { CustomerProfileRow } from './ads-data-store.js';
import { createLLMClient, getActiveProvider, isCustomProvider } from './llm-client.js';
import { getBetasForProvider, getModelId } from '../types/index.js';
import { buildCustomerContextWithDepth } from './ads-customer-profile-context.js';

export type RelevanceCategory = 'relevant' | 'irrelevant' | 'uncertain';

export interface ClassifiedSearchTerm {
  term: string;
  category: RelevanceCategory;
  reason: string;
}

export interface SearchTermRelevanceClassification {
  classifications: ReadonlyArray<ClassifiedSearchTerm>;
  byCategory: Readonly<Record<RelevanceCategory, ReadonlyArray<string>>>;
}

export interface ClassifySearchTermOptions {
  apiKey?: string | undefined;
  apiBaseURL?: string | undefined;
  /** Inject for tests; bypasses the real API call. */
  client?: Anthropic | undefined;
}

const TOOL_NAME = 'classify_search_term_relevance';

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description: 'Classify each high-spend zero-conversion search term as relevant, irrelevant, or uncertain against the customer profile.',
  input_schema: {
    type: 'object' as const,
    properties: {
      classifications: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            term: { type: 'string' as const },
            category: {
              type: 'string' as const,
              enum: ['relevant', 'irrelevant', 'uncertain'],
            },
            reason: { type: 'string' as const, description: 'One short sentence why.' },
          },
          required: ['term', 'category', 'reason'],
        },
      },
    },
    required: ['classifications'],
  },
};

const SYSTEM_PROMPT_HEAD = `You are a Google Ads strategist judging whether each search term that triggered an ad is RELEVANT to the customer's catalogue / offer.

Each term spent budget but produced zero conversions. The operator wants to know which to block and which to investigate.

Bucket every term into exactly one of:
- "irrelevant": the term is for a product, service, or intent the customer does NOT sell. Examples for a Swiss water-filter shop: "kaffeemaschine entkalken", "duschkopf reparieren", "spülmaschinensalz". These should become negative keywords.
- "relevant": the term IS aligned with what the customer sells, BUT the click did not convert. The fix is NOT a negative — it's an LP/copy/tracking/intent investigation. Do not block these.
- "uncertain": the term is plausibly relevant in some interpretations and irrelevant in others, OR you do not have enough context to decide. Operator picks.

Lean toward "uncertain" rather than guessing — operators correct uncertain calls, but they cannot recover an "irrelevant" silent-drop, and a wrong "relevant" hides waste.

Each "reason" must be one short sentence.`;


/** Classify search terms for relevance. Always returns one entry per
 *  input term (errors route to 'uncertain' fallback). */
export async function classifySearchTermRelevance(
  terms: readonly string[],
  customer: CustomerProfileRow,
  opts: ClassifySearchTermOptions = {},
): Promise<SearchTermRelevanceClassification> {
  const unique = Array.from(new Set(terms.map(t => t.trim()).filter(t => t.length > 0)));
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
      text: `${SYSTEM_PROMPT_HEAD}\n\n${buildCustomerContextWithDepth(customer)}`,
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    },
  ];

  try {
    const stream = client.beta.messages.stream({
      model: getModelId('haiku', provider),
      max_tokens: 4096,
      temperature: 0,
      ...(isCustomProvider() ? {} : { betas: getBetasForProvider(provider) }),
      system: systemBlocks,
      tools: [TOOL_DEFINITION],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: `Search terms (one per line):\n${unique.join('\n')}`,
        },
      ],
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

function safeCreateClient(opts: ClassifySearchTermOptions): Anthropic | null {
  try {
    return createLLMClient({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.apiBaseURL ? { apiBaseURL: opts.apiBaseURL } : {}),
    });
  } catch {
    return null;
  }
}

function emptyByCategory(): Record<RelevanceCategory, ReadonlyArray<string>> {
  return { relevant: [], irrelevant: [], uncertain: [] };
}

function fallbackUncertain(terms: readonly string[], reason: string): SearchTermRelevanceClassification {
  const classifications = terms.map(term => ({ term, category: 'uncertain' as const, reason }));
  return {
    classifications,
    byCategory: { relevant: [], irrelevant: [], uncertain: terms.slice() },
  };
}

export function parseClassification(
  inputTerms: readonly string[], rawInput: unknown,
): SearchTermRelevanceClassification {
  const seen = new Map<string, ClassifiedSearchTerm>();
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const arr = (rawInput as { classifications?: unknown }).classifications;
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const term = typeof r['term'] === 'string' ? r['term'].trim() : '';
        const category = typeof r['category'] === 'string' ? r['category'] : '';
        const reason = typeof r['reason'] === 'string' ? r['reason'] : '';
        if (!term) continue;
        if (!isRelevanceCategory(category)) continue;
        const key = term.toLowerCase();
        if (!seen.has(key)) seen.set(key, { term, category, reason });
      }
    }
  }
  const classifications: ClassifiedSearchTerm[] = [];
  for (const t of inputTerms) {
    const key = t.toLowerCase();
    const found = seen.get(key);
    classifications.push(found ?? {
      term: t, category: 'uncertain',
      reason: 'Model did not return a classification for this term.',
    });
  }
  const byCategory: Record<RelevanceCategory, string[]> =
    { relevant: [], irrelevant: [], uncertain: [] };
  for (const c of classifications) byCategory[c.category].push(c.term);
  return { classifications, byCategory };
}

function isRelevanceCategory(s: string): s is RelevanceCategory {
  return s === 'relevant' || s === 'irrelevant' || s === 'uncertain';
}
