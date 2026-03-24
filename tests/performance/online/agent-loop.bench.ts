/**
 * Online Benchmark: Agent loop iteration
 *
 * Measures real API round-trip time for agent send() calls.
 * Requires API key (~$0.01 per full run).
 *
 * Run: pnpm bench:online
 */
import { bench, describe, beforeAll } from 'vitest';
import { Agent } from '../../../src/core/agent.js';
import type { StreamEvent } from '../../../src/types/index.js';
import { getApiKey, hasApiKey, HAIKU } from '../../online/setup.js';

const SKIP = !hasApiKey();

describe.skipIf(SKIP)('Online: Agent Loop', () => {
  let apiKey: string;

  beforeAll(() => {
    apiKey = getApiKey();
  });

  bench('single send() — simple question', async () => {
    const agent = new Agent({
      name: 'bench-simple',
      model: HAIKU,
      apiKey,
      maxIterations: 1,
    });
    await agent.send('What is 2+2? Answer with just the number.');
  }, { iterations: 3, warmupIterations: 1 });

  bench('single send() — with streaming', async () => {
    const events: StreamEvent[] = [];
    const agent = new Agent({
      name: 'bench-stream',
      model: HAIKU,
      apiKey,
      maxIterations: 1,
      onStream: (e: StreamEvent) => { events.push(e); },
    });
    await agent.send('List 3 colors. Be brief.');
  }, { iterations: 3, warmupIterations: 1 });

  bench('multi-turn (2 turns)', async () => {
    const agent = new Agent({
      name: 'bench-multi',
      model: HAIKU,
      apiKey,
      maxIterations: 1,
    });
    await agent.send('Remember: the project name is Acme.');
    await agent.send('What project name did I mention?');
  }, { iterations: 2, warmupIterations: 0 });

  bench('single send() — with tool dispatch', async () => {
    const agent = new Agent({
      name: 'bench-tool',
      model: HAIKU,
      apiKey,
      maxIterations: 2,
      tools: [{
        definition: {
          name: 'get_time',
          description: 'Returns the current time.',
          input_schema: { type: 'object' as const, properties: {} },
        },
        handler: async () => new Date().toISOString(),
      }],
    });
    await agent.send('What time is it? Use the get_time tool.');
  }, { iterations: 2, warmupIterations: 0 });
});
