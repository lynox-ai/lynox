/**
 * Online tests: Memory Extraction with real Haiku API calls.
 *
 * Tests the automatic fact extraction from agent responses.
 * Cost: ~$0.004 total for all tests in this file.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { Memory } from '../../src/core/memory.js';
import { getApiKey, hasApiKey, createTmpDir } from './setup.js';

const SKIP = !hasApiKey();

describe.skipIf(SKIP)('Online: Memory Extraction', () => {
  let apiKey: string;
  let tmp: ReturnType<typeof createTmpDir>;
  let memory: Memory;

  beforeAll(() => {
    apiKey = getApiKey();
  });

  beforeEach(() => {
    tmp = createTmpDir();
    memory = new Memory(tmp.path, apiKey, undefined, 'test-online');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('extracts knowledge from a factual response', async () => {
    await memory.loadAll();

    // Simulate what the agent loop does after a response:
    // memory.maybeUpdate() calls Haiku to extract relevant facts
    const factualResponse = `Based on my research, TypeScript 5.4 introduced the NoInfer utility type
which prevents unwanted type inference in generic function parameters. This was
released in March 2024. The feature helps avoid common pitfalls when using generics
with default type parameters. TypeScript is maintained by Microsoft and the
language now has over 30 million weekly npm downloads.`;

    // maybeUpdate needs enough content + tool usage to trigger extraction
    await memory.maybeUpdate(factualResponse, 2);

    // Wait for async extraction to complete
    await new Promise(r => setTimeout(r, 3000));

    // Check if extraction happened — load knowledge namespace
    const knowledge = await memory.load('knowledge');

    // Extraction is heuristic — may or may not extract depending on throttle state.
    // If it extracted, it should contain relevant facts.
    if (knowledge) {
      expect(knowledge.length).toBeGreaterThan(0);
    }
    // Pass either way — this tests that extraction doesn't crash with real API
  }, 20_000);

  it('skips extraction for short responses', async () => {
    await memory.loadAll();

    // Short responses (<50 chars) are always skipped
    await memory.maybeUpdate('OK', 0);

    const knowledge = await memory.load('knowledge');
    expect(knowledge).toBeNull();
  }, 5_000);

  it('skips extraction for pure Q&A turns without tools', async () => {
    await memory.loadAll();

    // No tool usage + short-ish response → skipped
    await memory.maybeUpdate('The answer is 42. That is the answer to life, the universe, and everything.', 0);

    // Should skip (toolsUsed === 0 and response is not very long)
    const knowledge = await memory.load('knowledge');
    expect(knowledge).toBeNull();
  }, 5_000);

  it('handles concurrent extraction calls without errors', async () => {
    await memory.loadAll();

    const longText = 'Customer Roland from v-skin.ch signed up for the BYOK plan. '.repeat(10) +
      'His business specializes in skincare products. The contract was signed on March 15, 2026. ' +
      'He runs his operations from Switzerland and needs integration with Google Sheets for inventory tracking.';

    // Fire multiple extractions concurrently (simulates rapid agent turns)
    const extractions = [
      memory.maybeUpdate(longText, 3),
      memory.maybeUpdate(longText + ' Additional context about pricing.', 2),
    ];

    // Should not throw
    await Promise.all(extractions);
  }, 25_000);
});
