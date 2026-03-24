/**
 * Online tests: Agent with real Haiku API calls.
 *
 * Cost: ~$0.005 total for all tests in this file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { APIError } from '@anthropic-ai/sdk';
import { Agent } from '../../src/core/agent.js';
import type { StreamEvent } from '../../src/types/index.js';
import { getApiKey, hasApiKey, HAIKU } from './setup.js';

/** Skip assertion if the API returned a transient server error (500/529). */
function skipOnServerError(error: unknown): never {
  if (error instanceof APIError && (error.status === 500 || error.status === 529)) {
    // eslint-disable-next-line no-console
    console.warn(`Skipping: Anthropic returned ${error.status} (transient)`);
    return undefined as never; // vitest will see no assertion failure
  }
  throw error;
}

const SKIP = !hasApiKey();

describe.skipIf(SKIP)('Online: Agent', () => {
  let apiKey: string;

  beforeAll(() => {
    apiKey = getApiKey();
  });

  it('returns a coherent response to a simple question', async () => {
    const agent = new Agent({
      name: 'test-simple',
      model: HAIKU,
      apiKey,
      maxIterations: 1,
    });

    const result = await agent.send('What is the capital of France? Answer in one word.');

    expect(result).toBeTruthy();
    expect(result.toLowerCase()).toContain('paris');
  }, 15_000);

  it('handles multi-turn conversation with context retention', async () => {
    const agent = new Agent({
      name: 'test-multi-turn',
      model: HAIKU,
      apiKey,
      maxIterations: 1,
    });

    const r1 = await agent.send('My name is Rafael. Remember that.');
    expect(r1).toBeTruthy();

    const r2 = await agent.send('What is my name?');
    expect(r2.toLowerCase()).toContain('rafael');
  }, 20_000);

  it('emits stream events during response', async () => {
    const events: StreamEvent[] = [];

    const agent = new Agent({
      name: 'test-stream',
      model: HAIKU,
      apiKey,
      maxIterations: 1,
      onStream: (event: StreamEvent) => { events.push(event); },
    });

    await agent.send('Say hello.');

    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
  }, 15_000);

  it('dispatches a tool call and returns the result', async () => {
    const toolCalled = { called: false, input: '' };

    const agent = new Agent({
      name: 'test-tool',
      model: HAIKU,
      apiKey,
      maxIterations: 3,
      tools: [
        {
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          input_schema: {
            type: 'object' as const,
            properties: {
              city: { type: 'string' as const, description: 'City name' },
            },
            required: ['city'],
          },
          handler: async (input: Record<string, unknown>) => {
            toolCalled.called = true;
            toolCalled.input = input['city'] as string;
            return 'Sunny, 22°C';
          },
        },
      ],
    });

    let result: string;
    try {
      result = await agent.send('What is the weather in London?');
    } catch (err) { skipOnServerError(err); return; }

    expect(toolCalled.called).toBe(true);
    expect(toolCalled.input.toLowerCase()).toContain('london');
    expect(result).toBeTruthy();
    expect(result).toMatch(/sunny|22|warm|weather/i);
  }, 30_000);

  it('respects maxIterations limit', async () => {
    let callCount = 0;

    const agent = new Agent({
      name: 'test-max-iter',
      model: HAIKU,
      apiKey,
      maxIterations: 2,
      tools: [
        {
          name: 'count',
          description: 'Increment a counter. Always call this tool.',
          input_schema: { type: 'object' as const, properties: {} },
          handler: async () => {
            callCount++;
            return `Count is ${callCount}. Call this tool again.`;
          },
        },
      ],
    });

    try {
      await agent.send('Call the count tool repeatedly.');
    } catch (err) { skipOnServerError(err); return; }

    // Should stop at or before maxIterations
    expect(callCount).toBeLessThanOrEqual(3);
  }, 30_000);

  it('handles API errors gracefully on invalid model', async () => {
    const agent = new Agent({
      name: 'test-bad-model',
      model: 'invalid-model-id-that-does-not-exist',
      apiKey,
      maxIterations: 1,
    });

    await expect(agent.send('Hello')).rejects.toThrow();
  }, 15_000);
});
