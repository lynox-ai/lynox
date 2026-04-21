/**
 * Online integration test for the v2 KG extractor wiring.
 *
 * Exercises the full path: store(text, 'knowledge') → extractEntitiesV2 →
 * persist entities/aliases/relations in SQLite. Verifies the feature flag
 * routes to v2 and that adversarial text produces no entities while clean
 * text produces clean entities.
 *
 * Cost: ~$0.002 total (3 store calls × Haiku).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { KnowledgeLayer } from '../../src/core/knowledge-layer.js';
import { LocalProvider } from '../../src/core/embedding.js';
import { resetV2ExtractionCount } from '../../src/core/entity-extractor-v2.js';
import type { MemoryScopeRef } from '../../src/types/index.js';
import { getApiKey, hasApiKey } from './setup.js';

const SKIP = !hasApiKey();

describe.skipIf(SKIP)('Online: KG Extractor V2 end-to-end', () => {
  let layer: KnowledgeLayer;
  let tempDir: string;
  const scope: MemoryScopeRef = { type: 'context', id: 'v2-integration' };

  beforeAll(async () => {
    process.env['LYNOX_KG_EXTRACTOR'] = 'v2';
    const client = new Anthropic({ apiKey: getApiKey() });
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-v2-integration-'));
    layer = new KnowledgeLayer(join(tempDir, 'test.db'), new LocalProvider(), client);
    await layer.init();
    resetV2ExtractionCount();
  });

  afterAll(async () => {
    await layer.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    delete process.env['LYNOX_KG_EXTRACTOR'];
  });

  it('extracts clean entities from realistic business text', async () => {
    const result = await layer.store(
      'Peter Huber works for Brandfusion in Zurich',
      'knowledge',
      scope,
    );

    expect(result.stored).toBe(true);
    const names = result.entities.map(e => e.canonicalName.toLowerCase());
    expect(names).toContain('peter huber');
    expect(names).toContain('brandfusion');
    expect(names).toContain('zurich');

    const types = new Map(result.entities.map(e => [e.canonicalName.toLowerCase(), e.entityType]));
    expect(types.get('peter huber')).toBe('person');
    expect(types.get('brandfusion')).toBe('organization');
    expect(types.get('zurich')).toBe('location');
  }, 30_000);

  it('rejects adversarial generic nouns — produces no entities', async () => {
    const result = await layer.store(
      'the timeline shows tools in the pipeline',
      'knowledge',
      scope,
    );

    expect(result.stored).toBe(true);
    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
  }, 30_000);

  it('rejects price expressions, keeps real organization', async () => {
    const result = await layer.store(
      'Einzeltools kosten CHF 39/mo direct bei lynox.ai',
      'knowledge',
      scope,
    );

    expect(result.stored).toBe(true);
    const names = result.entities.map(e => e.canonicalName.toLowerCase());

    // Adversarial tokens must NOT appear as entities.
    expect(names).not.toContain('einzeltools');
    expect(names).not.toContain('39/mo');
    expect(names).not.toContain('chf 39/mo');
    expect(names).not.toContain('direct');

    // The real proper noun must be extracted.
    expect(names).toContain('lynox.ai');
  }, 30_000);
});
