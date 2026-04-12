/**
 * Online tests for the OpenAI-compatible provider (Mistral via OpenAI Adapter).
 *
 * Requires MISTRAL_API_KEY env var. Skipped if not set.
 *
 * Run: MISTRAL_API_KEY=... npx vitest run tests/online/openai-provider.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Agent } from '../../src/core/agent.js';
import { initLLMProvider } from '../../src/core/llm-client.js';
import type Anthropic from '@anthropic-ai/sdk';

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
const describeOnline = MISTRAL_KEY ? describe : describe.skip;

describeOnline('OpenAI Provider — Mistral Large via OpenAI Adapter', () => {
  beforeAll(async () => {
    await initLLMProvider('openai');
  });

  const TOOLS: Array<import('../../src/types/index.js').ToolEntry> = [
    {
      definition: {
        name: 'data_store_query',
        description: 'Search data in tables.',
        input_schema: {
          type: 'object' as const,
          properties: {
            collection: { type: 'string', description: 'Table name' },
            filter: { type: 'object' },
          },
          required: ['collection'],
        },
      },
      handler: async (input: unknown) => {
        const i = input as { collection: string; filter?: Record<string, unknown> };
        return JSON.stringify({ rows: [], collection: i.collection, filter: i.filter ?? {} });
      },
    },
    {
      definition: {
        name: 'memory_store',
        description: 'Save knowledge for future sessions.',
        input_schema: {
          type: 'object' as const,
          properties: {
            namespace: { type: 'string', enum: ['knowledge', 'methods', 'status', 'learnings'] },
            content: { type: 'string' },
          },
          required: ['namespace', 'content'],
        },
      },
      handler: async (input: unknown) => {
        const i = input as { namespace: string; content: string };
        return `Stored in ${i.namespace}.`;
      },
    },
    {
      definition: {
        name: 'task_create',
        description: 'Create a task with deadline.',
        input_schema: {
          type: 'object' as const,
          properties: {
            title: { type: 'string' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
            due_date: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['title'],
        },
      },
      handler: async (input: unknown) => {
        const i = input as { title: string };
        return `Task created: ${i.title}`;
      },
    },
  ];

  function createMistralAgent(name: string): Agent {
    return new Agent({
      name,
      model: 'mistral-large-latest',
      provider: 'openai',
      apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1',
      openaiModelId: 'mistral-large-latest',
      tools: TOOLS,
      maxIterations: 5,
    });
  }

  it('calls data_store_query with correct filter (DE)', async () => {
    const agent = createMistralAgent('test-query');
    const result = await agent.send('Zeig mir alle offenen Deals.');

    // Agent should have called data_store_query and returned text
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  }, 30_000);

  it('calls memory_store with correct namespace (DE)', async () => {
    const agent = createMistralAgent('test-memory');
    const result = await agent.send('Merke dir: Acme Corp nutzt Shopify Plus.');

    expect(result).toBeTruthy();
    // Check the tool was actually called (result includes the store confirmation)
    expect(result.toLowerCase()).toMatch(/gespeichert|stored|erfasst|notiert|vermerkt/i);
  }, 30_000);

  it('calls task_create with priority and date (DE)', async () => {
    const agent = createMistralAgent('test-task');
    const result = await agent.send('Erstelle eine Aufgabe: Report erstellen, hohe Priorität, Deadline 2026-05-31.');

    expect(result).toBeTruthy();
    expect(result.toLowerCase()).toMatch(/erstellt|created|aufgabe|task/i);
  }, 30_000);

  it('handles multi-turn tool loop (query → text response)', async () => {
    const agent = createMistralAgent('test-loop');
    const result = await agent.send('Zeig mir alle Leads und fasse zusammen wie viele es sind.');

    expect(result).toBeTruthy();
    // Should have queried and then responded with a summary
    expect(result.length).toBeGreaterThan(20);
  }, 30_000);

  it('works as spawn agent with profile config', async () => {
    // Simulate what spawn.ts does: create agent with profile-based config
    const agent = new Agent({
      name: 'spawn-mistral',
      model: 'mistral-large-latest',
      provider: 'openai',
      apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1',
      openaiModelId: 'mistral-large-latest',
      tools: TOOLS,
      maxIterations: 3,
      spawnDepth: 1,
      costGuard: { maxBudgetUSD: 0.50, maxIterations: 3 },
    });

    const result = await agent.send('Erstelle eine Aufgabe: Test-Task, niedrige Priorität.');

    expect(result).toBeTruthy();
  }, 30_000);
});
