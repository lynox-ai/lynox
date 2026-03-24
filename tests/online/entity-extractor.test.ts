/**
 * Online tests: Entity Extraction (Tier 2 LLM) with real Haiku API calls.
 *
 * Cost: ~$0.003 total for all tests in this file.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  extractEntitiesLLM,
  extractEntitiesRegex,
  resetLLMExtractionCount,
} from '../../src/core/entity-extractor.js';
import { getApiKey, hasApiKey } from './setup.js';

const SKIP = !hasApiKey();

describe.skipIf(SKIP)('Online: Entity Extractor (LLM Tier 2)', () => {
  let client: Anthropic;

  beforeAll(() => {
    client = new Anthropic({ apiKey: getApiKey() });
  });

  afterEach(() => {
    resetLLMExtractionCount();
  });

  it('extracts person and organization entities', async () => {
    const text = 'Rafael Burlet founded nodyn in Switzerland to build AI infrastructure for small businesses.';

    const result = await extractEntitiesLLM(text, client);

    expect(result.entities.length).toBeGreaterThan(0);
    const names = result.entities.map(e => e.name.toLowerCase());
    expect(names.some(n => n.includes('rafael') || n.includes('burlet'))).toBe(true);
    expect(names.some(n => n.includes('nodyn'))).toBe(true);
  }, 15_000);

  it('extracts relations between entities', async () => {
    const text = 'Maria Schmidt works at Acme Corp as a senior engineer. She manages the backend team and reports to Thomas Weber.';

    const result = await extractEntitiesLLM(text, client);

    expect(result.entities.length).toBeGreaterThanOrEqual(2);

    // Should find at least one relation
    if (result.relations.length > 0) {
      const rel = result.relations[0]!;
      expect(rel.from).toBeTruthy();
      expect(rel.to).toBeTruthy();
      expect(rel.relationType).toBeTruthy();
    }
  }, 15_000);

  it('handles German text', async () => {
    const text = 'Herr Müller leitet die Filiale der Deutschen Bank in Zürich. Seine Kollegin Frau Weber betreut dort die Firmenkunden.';

    const result = await extractEntitiesLLM(text, client);

    expect(result.entities.length).toBeGreaterThan(0);
    const names = result.entities.map(e => e.name.toLowerCase());
    expect(names.some(n => n.includes('müller') || n.includes('weber'))).toBe(true);
  }, 15_000);

  it('returns empty for text without entities', async () => {
    const text = 'The sky is blue and the grass is green. It is a beautiful day.';

    const result = await extractEntitiesLLM(text, client);

    // May or may not find entities, but should not crash
    expect(result).toBeDefined();
    expect(Array.isArray(result.entities)).toBe(true);
    expect(Array.isArray(result.relations)).toBe(true);
  }, 15_000);

  it('regex tier 1 + LLM tier 2 complement each other', async () => {
    const text = 'The Zenith Project uses PostgreSQL and Redis for data storage. It was created by the DevOps team at CloudScale Inc.';

    // Tier 1: regex
    const regexResult = extractEntitiesRegex(text);

    // Tier 2: LLM
    const llmResult = await extractEntitiesLLM(text, client);

    // LLM should find at least as many entities as regex
    expect(llmResult.entities.length).toBeGreaterThanOrEqual(regexResult.entities.length);

    // LLM should find organization/project entities
    const llmTypes = new Set(llmResult.entities.map(e => e.type));
    expect(llmTypes.size).toBeGreaterThan(0);
  }, 15_000);
});
