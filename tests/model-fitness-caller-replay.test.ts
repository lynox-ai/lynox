/**
 * Unit coverage for the forced-tool caller replay (`scripts/model-fitness/caller-replay.ts`):
 * how a captured main-agent body becomes each caller's input, how the counters decide a
 * call's outcome, and the positive control every run starts with. No model is called.
 */
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import {
  CALLER_SITES, CONTROL_MODEL, deriveCallerInputs, inputFor, noToolStubClient, outcomeOf, parseSearchResults,
  plannedCalls, positiveControl, runCaller,
} from '../scripts/model-fitness/caller-replay.js';
import { withWireRules } from '../src/core/llm-wire-rules.js';
import { FOLLOW_UP_TOOL_NAME } from '../src/core/follow-up-fallback.js';

const SEARCH_TEXT = [
  '1. **Shopify Admin API**',
  '   https://shopify.dev/docs/api/admin',
  '   The Admin API lets you build apps.',
  '   Published: 2026-01-01',
  '',
  '2. **Rate limits**',
  '   https://shopify.dev/docs/api/usage/rate-limits',
  '   Calls are limited per app.',
  '   ---',
  '   full page text',
].join('\n');

const body: BetaMessageParam[] = [
  { role: 'user', content: 'How do I connect my shop?' },
  { role: 'assistant', content: [
    { type: 'tool_use', id: 'tu1', name: 'web_research', input: { action: 'search', query: 'shopify admin api' } },
  ] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: SEARCH_TEXT }] }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Create a custom app, then connect it here.' }] },
  { role: 'user', content: 'Plan the import of my products.' },
];

describe('parseSearchResults', () => {
  it('reads title, url and snippet of each result the search tool printed', () => {
    expect(parseSearchResults(SEARCH_TEXT)).toEqual([
      { title: 'Shopify Admin API', url: 'https://shopify.dev/docs/api/admin', snippet: 'The Admin API lets you build apps.' },
      { title: 'Rate limits', url: 'https://shopify.dev/docs/api/usage/rate-limits', snippet: 'Calls are limited per app.' },
    ]);
  });

  it('finds nothing in text that is not a result list', () => {
    expect(parseSearchResults('No results found.')).toEqual([]);
  });
});

describe('deriveCallerInputs', () => {
  it('takes the last answered turn, the latest request and the last search from a body', () => {
    const inputs = deriveCallerInputs(body);
    expect(inputs.turn).toEqual({ question: 'How do I connect my shop?', answer: 'Create a custom app, then connect it here.' });
    expect(inputs.goal).toBe('Plan the import of my products.');
    expect(inputs.search?.query).toBe('shopify admin api');
    expect(inputs.search?.results).toHaveLength(2);
  });

  it('gives no turn when no assistant text has been written yet, and no search without one', () => {
    const inputs = deriveCallerInputs([{ role: 'user', content: 'Hello' }]);
    expect(inputs).toEqual({ goal: 'Hello' });
  });

  it('takes no search whose result list has fewer than two results', () => {
    const one = body.map((m) => m.role === 'user' && Array.isArray(m.content)
      ? { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'tu1', content: '1. **Only**\n   https://a.example\n   one' }] }
      : m);
    expect(deriveCallerInputs(one).search).toBeUndefined();
  });
});

describe('inputFor and plannedCalls', () => {
  it('runs each caller only on a body that has its input', () => {
    const inputs = deriveCallerInputs([{ role: 'user', content: 'Hello' }]);
    expect(CALLER_SITES.filter((s) => inputFor(s, inputs))).toEqual(['llm-helper', 'dag-planner']);
  });

  it('counts one call per body, site with input and model', () => {
    const full = deriveCallerInputs(body);
    const bare = deriveCallerInputs([{ role: 'user', content: 'Hello' }]);
    expect(plannedCalls([full, bare], ['m1', 'm2'])).toBe((5 + 2) * 2);
  });
});

describe('outcomeOf', () => {
  const zero = { miss: {}, cut: {} };
  it('reads a miss, a cut-off and a clean call from the counters of its own site', () => {
    expect(outcomeOf('dag-planner', zero, { miss: { 'dag-planner': 1 }, cut: {} })).toBe('missed');
    expect(outcomeOf('dag-planner', zero, { miss: {}, cut: { 'dag-planner': 1 } })).toBe('cut_off');
    expect(outcomeOf('dag-planner', zero, { miss: { 'llm-helper': 3 }, cut: {} })).toBe('called');
  });
});

describe('the positive control', () => {
  it('counts a text-only reply from a model that rejects a forced choice as a miss', async () => {
    expect(await positiveControl()).toBe(true);
  });

  it('counts a reply that calls the tool as called, on the same path', async () => {
    const reply = {
      content: [{ type: 'tool_use', id: 'x', name: FOLLOW_UP_TOOL_NAME, input: { suggestions: [] } }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'tool_use',
    };
    const messages = { create: async () => reply, stream: () => ({ finalMessage: async () => reply }) };
    const client = withWireRules({ messages, beta: { messages } } as unknown as Anthropic);
    const r = await runCaller('agent.follow_up', { turn: { question: 'q', answer: 'a' } }, CONTROL_MODEL, 'stub', client);
    expect(r.outcome).toBe('called');
  });

  it('skips a caller without input and sends nothing', async () => {
    let sent = 0;
    const counting = noToolStubClient();
    const orig = counting.beta.messages.stream.bind(counting.beta.messages);
    (counting.beta.messages as unknown as { stream: unknown }).stream = (...a: unknown[]) => { sent++; return (orig as (...x: unknown[]) => unknown)(...a); };
    expect((await runCaller('agent.capture', {}, CONTROL_MODEL, 'stub', counting)).outcome).toBe('skipped');
    expect(sent).toBe(0);
  });
});
