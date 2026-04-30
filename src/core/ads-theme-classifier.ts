/**
 * Phase-B theme-token classifier.
 *
 * Replaces the legacy `THEME_STOPWORDS` hardcoded list with a single
 * Haiku call that judges every audit-surfaced theme token against the
 * customer profile. Output buckets:
 *
 *   - actionable  — real product/service category in the customer's
 *                   country/language: "kefir", "wasserfilter", "beton".
 *                   Goes straight into the theme-coverage finding and
 *                   becomes a NEW asset_group proposal in blueprint.
 *   - funnel      — universal commerce intent without semantic content
 *                   ("kaufen", "online", "günstig"). Dropped.
 *   - irrelevant  — wrong language / wrong country / not a category at
 *                   all ("water" for a Swiss-DE shop, "deutschland"
 *                   from an off-target spillover). Dropped.
 *   - uncertain   — model can't decide. Survives into the finding +
 *                   blueprint, but blueprint adds a Phase-A review
 *                   marker so the operator confirms before emit.
 *
 * Caching: the customer profile is the largest, slowest-changing part
 * of the prompt. It lives in the system block with `cache_control`
 * so cycle 2+ for the same customer hits Anthropic's prompt cache;
 * only the variable token-list in the user message is fresh tokens.
 *
 * Fail-safe: any error (no API key, network, malformed output) routes
 * EVERY input token to `uncertain` so the operator sees them all in
 * the Phase-A review dialog rather than silently disappearing.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaTextBlockParam, BetaCacheControlEphemeral,
} from '@anthropic-ai/sdk/resources/beta/messages.js';
import type { CustomerProfileRow } from './ads-data-store.js';
import { createLLMClient, getActiveProvider, isCustomProvider } from './llm-client.js';
import { getBetasForProvider, getModelId } from '../types/index.js';

export type ThemeCategory = 'actionable' | 'funnel' | 'irrelevant' | 'uncertain';

export interface ClassifiedToken {
  token: string;
  category: ThemeCategory;
  reason: string;
}

export interface ThemeClassification {
  classifications: ReadonlyArray<ClassifiedToken>;
  /** Convenience accessor: tokens by category. */
  byCategory: Readonly<Record<ThemeCategory, ReadonlyArray<string>>>;
}

export interface ClassifyOptions {
  apiKey?: string | undefined;
  apiBaseURL?: string | undefined;
  /** Inject for tests. When provided, no real API call happens. */
  client?: Anthropic | undefined;
}

const TOOL_NAME = 'classify_theme_tokens';

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description: 'Classify each candidate theme token as actionable, funnel, irrelevant, or uncertain.',
  input_schema: {
    type: 'object' as const,
    properties: {
      classifications: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            token: { type: 'string' as const },
            category: {
              type: 'string' as const,
              enum: ['actionable', 'funnel', 'irrelevant', 'uncertain'],
            },
            reason: { type: 'string' as const, description: 'One short sentence why.' },
          },
          required: ['token', 'category', 'reason'],
        },
      },
    },
    required: ['classifications'],
  },
};

const SYSTEM_PROMPT_HEAD = `You are a Google Ads strategist classifying candidate "theme" tokens for asset-group expansion.

Each theme token was extracted from PMax search-term clusters that did NOT match an existing asset group.
Your job is to decide which tokens are real product/service categories (worth a NEW asset group) and which are noise.

Bucket every token into exactly one of:
- "actionable": a concrete product, service, ingredient, brand-adjacent category in the customer's market and language. Examples: "kefir", "wasserfilter", "kombucha".
- "funnel": universal commerce intent, generic adjectives, or shop-modifiers without semantic content. Examples: "kaufen", "online", "günstig", "shop", "preis", "test", "vergleich", "best".
- "irrelevant": wrong language for the customer's market, off-target country/region, generic non-category words, or pure noise. Examples: "water" for a German-only Swiss shop, "deutschland" for a Swiss-only shop, "info", "anleitung".
- "uncertain": the token could plausibly be either actionable or funnel/irrelevant given the customer profile, OR you do not have enough context. The operator will manually decide.

Lean toward "uncertain" rather than guessing — operators correct uncertain calls, but they cannot recover an "irrelevant" silent-drop.

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

/** Classify candidate theme tokens for a customer. Always returns a
 *  classification for EVERY input token (errors → 'uncertain' fallback). */
export async function classifyThemeTokens(
  tokens: readonly string[],
  customer: CustomerProfileRow,
  opts: ClassifyOptions = {},
): Promise<ThemeClassification> {
  const unique = Array.from(new Set(tokens.map(t => t.trim()).filter(t => t.length > 0)));
  if (unique.length === 0) {
    return { classifications: [], byCategory: emptyByCategory() };
  }

  const client = opts.client ?? safeCreateClient(opts);
  if (!client) return fallbackUncertain(unique, 'no LLM client available');

  const provider = getActiveProvider();
  const cacheControl: BetaCacheControlEphemeral | undefined = isCustomProvider()
    ? undefined
    : ({ type: 'ephemeral', ttl: '1h' } as unknown as BetaCacheControlEphemeral);

  // System prompt is the cache prefix: instructions + customer profile.
  // The customer profile changes only when the customer profile itself
  // is edited, so cycle-N+1 for the same customer hits the cache.
  const systemBlocks: BetaTextBlockParam[] = [
    {
      type: 'text',
      text: `${SYSTEM_PROMPT_HEAD}\n\n${buildCustomerContext(customer)}`,
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
          content: `Candidate tokens (one per line):\n${unique.join('\n')}`,
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

function safeCreateClient(opts: ClassifyOptions): Anthropic | null {
  try {
    return createLLMClient({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.apiBaseURL ? { apiBaseURL: opts.apiBaseURL } : {}),
    });
  } catch {
    return null;
  }
}

function emptyByCategory(): Record<ThemeCategory, ReadonlyArray<string>> {
  return { actionable: [], funnel: [], irrelevant: [], uncertain: [] };
}

function fallbackUncertain(tokens: readonly string[], reason: string): ThemeClassification {
  const classifications = tokens.map(token => ({ token, category: 'uncertain' as const, reason }));
  return {
    classifications,
    byCategory: { actionable: [], funnel: [], irrelevant: [], uncertain: tokens.slice() },
  };
}

/** Parse the classifier tool output. Tolerates partial / malformed
 *  responses by routing missing tokens to 'uncertain'. */
export function parseClassification(
  inputTokens: readonly string[], rawInput: unknown,
): ThemeClassification {
  const seen = new Map<string, ClassifiedToken>();
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const arr = (rawInput as { classifications?: unknown }).classifications;
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const token = typeof r['token'] === 'string' ? r['token'].trim().toLowerCase() : '';
        const category = typeof r['category'] === 'string' ? r['category'] : '';
        const reason = typeof r['reason'] === 'string' ? r['reason'] : '';
        if (!token) continue;
        if (!isThemeCategory(category)) continue;
        if (!seen.has(token)) seen.set(token, { token, category, reason });
      }
    }
  }
  // Backfill any input token the model omitted as 'uncertain'.
  const classifications: ClassifiedToken[] = [];
  for (const t of inputTokens) {
    const key = t.toLowerCase();
    const found = seen.get(key);
    classifications.push(found ?? {
      token: t, category: 'uncertain',
      reason: 'Model did not return a classification for this token.',
    });
  }
  const byCategory: Record<ThemeCategory, string[]> =
    { actionable: [], funnel: [], irrelevant: [], uncertain: [] };
  for (const c of classifications) byCategory[c.category].push(c.token);
  return { classifications, byCategory };
}

function isThemeCategory(s: string): s is ThemeCategory {
  return s === 'actionable' || s === 'funnel' || s === 'irrelevant' || s === 'uncertain';
}
