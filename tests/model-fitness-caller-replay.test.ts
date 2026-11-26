/**
 * Unit coverage for the forced-tool caller replay (`scripts/model-fitness/caller-replay.ts`):
 * how a captured main-agent body becomes each caller's input, how a call's outcome is read
 * from the counters and from what the caller returns, and the positive control every run
 * starts with. No model is called.
 */
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import {
  CALLER_SITES, CONTROL_MODEL, boundaryChecks, deriveCallerInputs, endsTurnToolNames, inputFor, noToolStubClient, outcomeOf,
  parseSearchResults, plannedCalls, positiveControl, quotaOf, runCaller,
} from '../scripts/model-fitness/caller-replay.js';
import { withWireRules } from '../src/core/llm-wire-rules.js';
import { wrapUntrustedData } from '../src/core/data-boundary.js';
import { CAPTURE_FALLBACK_MAX_TOKENS, CAPTURE_TOOL_NAME } from '../src/core/capture-fallback.js';
import { FOLLOW_UP_FALLBACK_MAX_TOKENS, FOLLOW_UP_TOOL_NAME } from '../src/core/follow-up-fallback.js';
import { getBetasForProvider } from '../src/types/config.js';
import type { RerankOutcome } from '../src/integrations/search/search-reranker.js';

/** A model whose forced choice the boundary leaves alone, so it does not check the reply. */
const UNCHECKED_MODEL = 'claude-haiku-5-5';

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

const searchTurn = (resultId: string, action = 'search'): BetaMessageParam[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'web_research', input: { action, query: 'shopify admin api' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: resultId, content: [{ type: 'text', text: SEARCH_TEXT }] }] },
];

const body: BetaMessageParam[] = [
  { role: 'user', content: 'How do I connect my shop?' },
  ...searchTurn('tu1'),
  { role: 'assistant', content: [{ type: 'text', text: 'Create a custom app, then connect it here.' }] },
  { role: 'user', content: 'Plan the import of my products.' },
];

type Reply = { content: Array<Record<string, unknown>>; usage: { input_tokens: number; output_tokens: number }; stop_reason: string };

/** A wire-ruled stub client that answers `reply` and records the params it was sent. */
function stubClient(reply: Reply): { client: Anthropic; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const surface = (): Record<string, unknown> => ({
    create: async (p: Record<string, unknown>) => { sent.push(p); return reply; },
    stream: (p: Record<string, unknown>) => { sent.push(p); return { finalMessage: async () => reply }; },
  });
  return { client: withWireRules({ messages: surface(), beta: { messages: surface() } } as unknown as Anthropic), sent };
}
const textReply: Reply = { content: [{ type: 'text', text: 'No.' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' };
const toolReply = (name: string, input: unknown = {}): Reply => ({ content: [{ type: 'tool_use', id: 'x', name, input }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use' });

describe('parseSearchResults', () => {
  it('reads title, url and snippet of each result the search tool printed', () => {
    expect(parseSearchResults(SEARCH_TEXT)).toEqual([
      { title: 'Shopify Admin API', url: 'https://shopify.dev/docs/api/admin', snippet: 'The Admin API lets you build apps.' },
      { title: 'Rate limits', url: 'https://shopify.dev/docs/api/usage/rate-limits', snippet: 'Calls are limited per app.' },
    ]);
  });

  it('reads the results inside the untrusted-data wrapper the tool result arrives in', () => {
    expect(parseSearchResults(wrapUntrustedData(SEARCH_TEXT, 'web_research'))).toHaveLength(2);
  });

  it('finds nothing in text that is not a result list', () => {
    expect(parseSearchResults('No results found.')).toEqual([]);
  });
});

describe('deriveCallerInputs', () => {
  it('takes the last finished turn, the latest request and the last search from a body', () => {
    const inputs = deriveCallerInputs(body);
    expect(inputs.turn).toEqual({ question: 'How do I connect my shop?', answer: 'Create a custom app, then connect it here.' });
    expect(inputs.goal).toBe('Plan the import of my products.');
    expect(inputs.search?.query).toBe('shopify admin api');
    expect(inputs.search?.results).toHaveLength(2);
  });

  it('passes over an assistant message that calls a tool, whose text is a preamble and not an answer', () => {
    const midTurn: BetaMessageParam[] = [
      ...body,
      { role: 'assistant', content: [{ type: 'text', text: 'Let me look that up.' }, { type: 'tool_use', id: 'tu2', name: 'web_research', input: { action: 'fetch', url: 'https://a.example' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'page' }] },
    ];
    expect(deriveCallerInputs(midTurn).turn?.answer).toBe('Create a custom app, then connect it here.');
  });

  it('takes a final answer that calls a turn-ending tool beside its text as the answer', () => {
    const withChips: BetaMessageParam[] = [
      { role: 'user', content: 'Q?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Final answer.' }, { type: 'tool_use', id: 'f1', name: FOLLOW_UP_TOOL_NAME, input: { suggestions: [] } }] },
    ];
    expect(deriveCallerInputs(withChips).turn).toEqual({ question: 'Q?', answer: 'Final answer.' });
  });

  it('passes over text beside an ordinary tool call, and beside a turn-ending one mixed with it', () => {
    const preamble = (calls: string[]): BetaMessageParam[] => [
      { role: 'user', content: 'Earlier?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer.' }] },
      { role: 'user', content: 'Q?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, ...calls.map((name, i) => ({ type: 'tool_use' as const, id: `c${String(i)}`, name, input: {} }))] },
    ];
    expect(deriveCallerInputs(preamble(['web_research'])).turn?.answer).toBe('Earlier answer.');
    expect(deriveCallerInputs(preamble([FOLLOW_UP_TOOL_NAME, 'web_research'])).turn?.answer).toBe('Earlier answer.');
  });

  it('finds the turn-ending tools on the tool entries, not by a fixed name', () => {
    expect(endsTurnToolNames().has(FOLLOW_UP_TOOL_NAME)).toBe(true);
    expect(endsTurnToolNames().has('web_research')).toBe(false);
    expect([...endsTurnToolNames({ a: { endsTurn: true, definition: { name: 'x' } }, b: { endsTurn: false, definition: { name: 'y' } }, c: 5 })]).toEqual(['x']);
  });

  it('reads only text blocks as the answer', () => {
    const withOther: BetaMessageParam[] = [
      { role: 'user', content: 'Q?' },
      { role: 'assistant', content: [{ type: 'redacted_note', text: 'not shown' } as never, { type: 'text', text: 'A.' }] },
    ];
    expect(deriveCallerInputs(withOther).turn?.answer).toBe('A.');
  });

  it('gives no turn when no assistant text has been written yet, and no search without one', () => {
    expect(deriveCallerInputs([{ role: 'user', content: 'Hello' }])).toEqual({ goal: 'Hello' });
  });

  it('takes a search only with its own result, and only a search action', () => {
    expect(deriveCallerInputs([{ role: 'user', content: 'q' }, ...searchTurn('other-id')]).search).toBeUndefined();
    expect(deriveCallerInputs([{ role: 'user', content: 'q' }, ...searchTurn('tu1', 'fetch')]).search).toBeUndefined();
    expect(deriveCallerInputs([{ role: 'user', content: 'q' }, ...searchTurn('tu1')]).search?.results).toHaveLength(2);
  });

  it('takes no search whose result list has fewer than two results', () => {
    const one: BetaMessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'web_research', input: { action: 'search', query: 'q' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '1. **Only**\n   https://a.example\n   one' }] },
    ];
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

  it('calls a reply that is both a miss and cut off a cut-off: the budget lost the call', () => {
    expect(outcomeOf('dag-planner', zero, { miss: { 'dag-planner': 1 }, cut: { 'dag-planner': 1 } })).toBe('cut_off');
  });
});

describe('quotaOf', () => {
  it('counts misses over the calls that answered, leaving no_result, errors and skips out', () => {
    expect(quotaOf({ called: 5, missed: 2, cut_off: 1, no_result: 4, error: 3, skipped: 7 })).toEqual({ missed: 2, answered: 8 });
  });
});

describe('boundaryChecks', () => {
  it('is true for a model that rejects a forced choice and false for one that takes it', () => {
    expect(boundaryChecks(CONTROL_MODEL)).toBe(true);
    expect(boundaryChecks(UNCHECKED_MODEL)).toBe(false);
  });
});

describe('runCaller on the agent passes', () => {
  const turn = { turn: { question: 'q', answer: 'a' } };

  it('sends the follow-up pass with its forced tool, its budget and the provider betas', async () => {
    const { client, sent } = stubClient(toolReply(FOLLOW_UP_TOOL_NAME, { suggestions: [] }));
    expect((await runCaller('agent.follow_up', turn, UNCHECKED_MODEL, 'stub', { client })).outcome).toBe('called');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      model: UNCHECKED_MODEL,
      max_tokens: FOLLOW_UP_FALLBACK_MAX_TOKENS,
      tool_choice: { type: 'tool', name: FOLLOW_UP_TOOL_NAME },
      betas: getBetasForProvider('anthropic'),
    });
  });

  it('sends the capture pass with its own budget', async () => {
    const { client, sent } = stubClient(toolReply(CAPTURE_TOOL_NAME, { facts: [] }));
    await runCaller('agent.capture', turn, UNCHECKED_MODEL, 'stub', { client });
    expect(sent[0]!['max_tokens']).toBe(CAPTURE_FALLBACK_MAX_TOKENS);
  });

  it('counts a text-only capture reply as a miss through the boundary', async () => {
    const { client, sent } = stubClient(textReply);
    expect(await runCaller('agent.capture', turn, CONTROL_MODEL, 'stub', { client })).toEqual({ outcome: 'missed' });
    // The boundary relaxed the forced choice the pass sent.
    expect(sent[0]!['tool_choice']).toEqual({ type: 'auto' });
  });

  it('sends the capture pass with its own forced tool on a model that takes it', async () => {
    const { client, sent } = stubClient(toolReply(CAPTURE_TOOL_NAME, { facts: [] }));
    expect((await runCaller('agent.capture', turn, UNCHECKED_MODEL, 'stub', { client })).outcome).toBe('called');
    expect(sent[0]!['tool_choice']).toEqual({ type: 'tool', name: CAPTURE_TOOL_NAME });
  });

  it('reads the reply itself on a model the boundary does not check, and finds the miss', async () => {
    const { client } = stubClient(textReply);
    expect(await runCaller('agent.follow_up', turn, UNCHECKED_MODEL, 'stub', { client })).toEqual({ outcome: 'missed', reason: 'no tool call in the reply' });
  });

  it('counts a call of a different tool as a miss on a model the boundary does not check', async () => {
    const { client } = stubClient(toolReply('something_else'));
    expect((await runCaller('agent.capture', turn, UNCHECKED_MODEL, 'stub', { client })).outcome).toBe('missed');
  });

  it('skips a caller without input and sends nothing', async () => {
    const { client, sent } = stubClient(textReply);
    expect((await runCaller('agent.capture', {}, CONTROL_MODEL, 'stub', { client })).outcome).toBe('skipped');
    expect(sent).toHaveLength(0);
  });
});

describe('runCaller on the helper', () => {
  it('counts a text-only reply as a miss on a model the boundary does not check', async () => {
    const { client } = stubClient(textReply);
    expect(await runCaller('llm-helper', { goal: 'g' }, UNCHECKED_MODEL, 'stub', { client })).toEqual({ outcome: 'missed', reason: 'no tool call in the reply' });
  });

  it('runs the helper on the candidate model', async () => {
    const { client, sent } = stubClient(toolReply('extract', { summary: 's', object: 'o' }));
    expect((await runCaller('llm-helper', { goal: 'g' }, UNCHECKED_MODEL, 'stub', { client })).outcome).toBe('called');
    expect(sent[0]!['model']).toBe(UNCHECKED_MODEL);
  });
});

describe('runCaller on the reranker and the planner, which catch their own failures', () => {
  const search = { search: { query: 'q', results: [{ title: 'a', url: 'https://a.example', snippet: 'a' }, { title: 'b', url: 'https://b.example', snippet: 'b' }] } };
  const rerankReturning = (skipReason: RerankOutcome['skipReason']) => {
    const seen: unknown[][] = [];
    const rerank = (async (...args: unknown[]) => { seen.push(args); return { results: [], droppedCount: 0, meanScore: null, durationMs: 1, ...(skipReason ? { skipReason } : {}) }; }) as never;
    return { rerank, seen };
  };

  it('pins the reranker to the candidate model', async () => {
    const { rerank, seen } = rerankReturning(undefined);
    expect((await runCaller('search-reranker', search, 'claude-sonnet-5-5', 'k', { rerank })).outcome).toBe('called');
    expect(seen[0]![3]).toMatchObject({ provider: 'anthropic', openaiModelId: 'claude-sonnet-5-5', modelPinnedByProfile: true });
  });

  it('reads a caught timeout or API error as an error, never as a clean call', async () => {
    for (const reason of ['timeout', 'llm-error', 'stopped'] as const) {
      expect(await runCaller('search-reranker', search, 'm', 'k', { rerank: rerankReturning(reason).rerank })).toEqual({ outcome: 'error', reason });
    }
  });

  it('reads an unusable reranker reply as no result, and a cut-off one as cut off', async () => {
    expect((await runCaller('search-reranker', search, 'm', 'k', { rerank: rerankReturning('malformed').rerank })).outcome).toBe('no_result');
    expect((await runCaller('search-reranker', search, 'm', 'k', { rerank: rerankReturning('cut-off').rerank })).outcome).toBe('cut_off');
  });

  it('runs the planner on the candidate model and reads a null plan as no result', async () => {
    const seen: unknown[][] = [];
    const planNull = (async (...args: unknown[]) => { seen.push(args); return null; }) as never;
    expect((await runCaller('dag-planner', { goal: 'g' }, 'claude-opus-5-5', 'k', { planDAG: planNull })).outcome).toBe('no_result');
    expect(seen[0]![1]).toMatchObject({ model: 'claude-opus-5-5', provider: 'anthropic' });
    const planSome = (async () => ({ steps: [] })) as never;
    expect((await runCaller('dag-planner', { goal: 'g' }, 'm', 'k', { planDAG: planSome })).outcome).toBe('called');
  });
});

describe('the positive control', () => {
  it('counts a text-only reply from a model that rejects a forced choice as a miss', async () => {
    expect(await positiveControl()).toBe(true);
  });

  it('is fed by a stub whose two surfaces are separate objects', () => {
    const c = noToolStubClient();
    expect(c.messages).not.toBe((c as unknown as { beta: { messages: unknown } }).beta.messages);
  });
});
