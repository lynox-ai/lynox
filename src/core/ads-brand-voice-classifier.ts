/**
 * Tier-2 LLM brand-voice drift classifier for the
 * `brand_voice_drift` finding evidence.
 *
 * Each RSA copy line gets one of:
 *   - "on_brand"   — matches the customer's brand voice and tone
 *   - "drift"      — uses forbidden phrases or wrong tone
 *   - "uncertain"  — model can't decide cleanly
 *
 * Without a populated customer.brand_voice the audit-engine doesn't
 * even produce candidates — the Tier-1 pre-pass returns empty. This
 * classifier therefore can ASSUME the brand voice fields exist.
 *
 * Same caching pattern as the other classifiers — customer profile
 * (especially brand_voice) in cached system prompt, copy lines in
 * variable user message.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaTextBlockParam, BetaCacheControlEphemeral,
} from '@anthropic-ai/sdk/resources/beta/messages.js';
import type { CustomerProfileRow } from './ads-data-store.js';
import { createLLMClient, getActiveProvider, isCustomProvider } from './llm-client.js';
import { getBetasForProvider, getModelId } from '../types/index.js';
import { buildCustomerContextWithDepth } from './ads-customer-profile-context.js';

export type BrandVoiceCategory = 'on_brand' | 'drift' | 'uncertain';

export interface ClassifiedBrandVoiceLine {
  text: string;
  category: BrandVoiceCategory;
  reason: string;
}

export interface BrandVoiceClassification {
  classifications: ReadonlyArray<ClassifiedBrandVoiceLine>;
  byCategory: Readonly<Record<BrandVoiceCategory, ReadonlyArray<string>>>;
}

export interface ClassifyBrandVoiceOptions {
  apiKey?: string | undefined;
  apiBaseURL?: string | undefined;
  client?: Anthropic | undefined;
}

const TOOL_NAME = 'classify_brand_voice_drift';

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description: 'Classify each ad copy line as on_brand, drift, or uncertain against the customer brand voice.',
  input_schema: {
    type: 'object' as const,
    properties: {
      classifications: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            text: { type: 'string' as const },
            category: {
              type: 'string' as const,
              enum: ['on_brand', 'drift', 'uncertain'],
            },
            reason: { type: 'string' as const, description: 'One short sentence why.' },
          },
          required: ['text', 'category', 'reason'],
        },
      },
    },
    required: ['classifications'],
  },
};

const SYSTEM_PROMPT_HEAD = `You are a brand-voice consistency reviewer. The customer has documented their brand voice — tone, signature phrases, things to avoid. Your job is to flag ad copy lines that drift away from that voice.

Bucket every line into exactly one of:
- "on_brand": matches the documented tone and avoids the do_not_use list. Includes lines that don't strictly need to use signature_phrases — neutral on-brand is fine.
- "drift": clearly violates do_not_use, or uses tone that contradicts the customer's documented tone (e.g. salesy when tone says "no marketing fluff", or formal when tone says "casual").
- "uncertain": ambiguous — could be either depending on the rest of the campaign context.

Defensive bias: when in doubt, return "uncertain". A wrong "on_brand" lets bad copy ship; a wrong "drift" makes the operator manually re-check copy that was actually fine.

Each "reason" must be one short sentence and reference the specific brand-voice rule the line violates or upholds.`;

interface InputItem { text: string }

export async function classifyBrandVoiceDrift(
  items: readonly InputItem[],
  customer: CustomerProfileRow,
  opts: ClassifyBrandVoiceOptions = {},
): Promise<BrandVoiceClassification> {
  const seen = new Set<string>();
  const unique: InputItem[] = [];
  for (const it of items) {
    const t = it.text.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ text: t });
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
      text: `${SYSTEM_PROMPT_HEAD}\n\n${buildCustomerContextWithDepth(customer)}`,
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    },
  ];

  const userMessage = `Ad copy lines (one per line):\n${unique.map(u => u.text).join('\n')}`;

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

function safeCreateClient(opts: ClassifyBrandVoiceOptions): Anthropic | null {
  try {
    return createLLMClient({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.apiBaseURL ? { apiBaseURL: opts.apiBaseURL } : {}),
    });
  } catch { return null; }
}

function emptyByCategory(): Record<BrandVoiceCategory, ReadonlyArray<string>> {
  return { on_brand: [], drift: [], uncertain: [] };
}

function fallbackUncertain(items: readonly InputItem[], reason: string): BrandVoiceClassification {
  const classifications = items.map(it => ({
    text: it.text, category: 'uncertain' as const, reason,
  }));
  return {
    classifications,
    byCategory: { on_brand: [], drift: [], uncertain: items.map(i => i.text) },
  };
}

export function parseClassification(
  inputItems: readonly InputItem[], rawInput: unknown,
): BrandVoiceClassification {
  const seen = new Map<string, ClassifiedBrandVoiceLine>();
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const arr = (rawInput as { classifications?: unknown }).classifications;
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const text = typeof r['text'] === 'string' ? r['text'].trim() : '';
        const category = typeof r['category'] === 'string' ? r['category'] : '';
        const reason = typeof r['reason'] === 'string' ? r['reason'] : '';
        if (!text) continue;
        if (!isBrandVoiceCategory(category)) continue;
        const key = text.toLowerCase();
        if (!seen.has(key)) seen.set(key, { text, category, reason });
      }
    }
  }
  const classifications: ClassifiedBrandVoiceLine[] = [];
  for (const it of inputItems) {
    const found = seen.get(it.text.toLowerCase());
    classifications.push(found ?? {
      text: it.text, category: 'uncertain',
      reason: 'Model did not return a classification for this line.',
    });
  }
  const byCategory: Record<BrandVoiceCategory, string[]> =
    { on_brand: [], drift: [], uncertain: [] };
  for (const c of classifications) byCategory[c.category].push(c.text);
  return { classifications, byCategory };
}

function isBrandVoiceCategory(s: string): s is BrandVoiceCategory {
  return s === 'on_brand' || s === 'drift' || s === 'uncertain';
}
