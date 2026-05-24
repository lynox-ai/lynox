import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { RetrievalEngine } from './retrieval-engine.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { LocalProvider } from './embedding.js';
import { EntityResolver } from './entity-resolver.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * PR #569 cleanup-owe: direct tests for the RetrievalEngine.setAnthropicClient
 * setter that's invoked by KnowledgeLayer.setAnthropicClient during a runtime
 * provider switch. Without these, a regression that drops the propagation
 * would only surface as an EU-residency leak in HyDE retrieval calls.
 */
describe('RetrievalEngine.setAnthropicClient — provider-switch propagation', () => {
  let tempDir: string;
  let db: AgentMemoryDb;
  let engine: RetrievalEngine;
  const scope: MemoryScopeRef = { type: 'context', id: 'test-retrieval' };

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-retrieval-setter-'));
    const embedding = new LocalProvider();
    db = new AgentMemoryDb(join(tempDir, 'test.db'));
    db.setEmbeddingDimensions(embedding.dimensions);
    const entityResolver = new EntityResolver(db, embedding);
    engine = new RetrievalEngine(db, embedding, entityResolver, undefined, undefined);
  });

  afterAll(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('updates the internal anthropicClient field with the new reference', () => {
    const fakeClient = { beta: { messages: { stream: () => ({}) } } } as unknown as Anthropic;
    engine.setAnthropicClient(fakeClient);

    const stored = (engine as unknown as { anthropicClient: Anthropic | undefined }).anthropicClient;
    expect(stored).toBe(fakeClient);
  });

  it('accepts undefined to clear the client (e.g. on switch back to anthropic without key)', () => {
    const fakeClient = { beta: { messages: { stream: () => ({}) } } } as unknown as Anthropic;
    engine.setAnthropicClient(fakeClient);
    engine.setAnthropicClient(undefined);

    const stored = (engine as unknown as { anthropicClient: Anthropic | undefined }).anthropicClient;
    expect(stored).toBeUndefined();
  });

  it('overwrites successive client references (each call replaces, not merges)', () => {
    const c1 = { beta: { messages: { stream: () => ({}) } }, _id: 'c1' } as unknown as Anthropic;
    const c2 = { beta: { messages: { stream: () => ({}) } }, _id: 'c2' } as unknown as Anthropic;

    engine.setAnthropicClient(c1);
    expect((engine as unknown as { anthropicClient: Anthropic | undefined }).anthropicClient).toBe(c1);

    engine.setAnthropicClient(c2);
    expect((engine as unknown as { anthropicClient: Anthropic | undefined }).anthropicClient).toBe(c2);
  });

  it('a HyDE-enabled retrieve() routes through the NEW client after setAnthropicClient', async () => {
    // Old client: tracks calls but errors out (so we'd notice if it's still active).
    const oldCalls: unknown[] = [];
    const oldClient = {
      beta: {
        messages: {
          stream: (params: unknown) => {
            oldCalls.push(params);
            return {
              finalMessage: () => Promise.resolve({
                content: [{ type: 'text', text: 'OLD-HYDE-ANSWER' }],
              }),
            };
          },
        },
      },
    } as unknown as Anthropic;

    // New client: tracks calls and returns a sentinel HyDE answer.
    const newCalls: unknown[] = [];
    const newClient = {
      beta: {
        messages: {
          stream: (params: unknown) => {
            newCalls.push(params);
            return {
              finalMessage: () => Promise.resolve({
                content: [{ type: 'text', text: 'NEW-HYDE-ANSWER' }],
              }),
            };
          },
        },
      },
    } as unknown as Anthropic;

    engine.setAnthropicClient(oldClient);
    engine.setAnthropicClient(newClient); // swap

    // Query must be >= 20 chars to trigger HyDE branch.
    const query = 'What database does the platform use for analytics?';
    await engine.retrieve(query, [scope], {
      topK: 5,
      threshold: 0.1,
      useHyDE: true,
      useGraphExpansion: false,
    });

    // The OLD client must NOT have been called after the swap.
    expect(oldCalls).toHaveLength(0);
    // The NEW client must have received the HyDE call.
    expect(newCalls.length).toBeGreaterThanOrEqual(1);
  });
});
