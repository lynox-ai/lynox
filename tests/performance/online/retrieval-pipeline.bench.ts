/**
 * Online Benchmark: Retrieval pipeline
 *
 * Measures the full retrieval pipeline: embed query → vector search →
 * graph expansion → merge → score → MMR.
 * Uses real ONNX embeddings + LadybugDB. HyDE step requires API key.
 *
 * Run: pnpm bench:online
 */
import { bench, describe, beforeAll, afterAll } from 'vitest';
import { KuzuGraph } from '../../../src/core/knowledge-graph.js';
import { OnnxProvider } from '../../../src/core/embedding.js';
import { RetrievalEngine } from '../../../src/core/retrieval-engine.js';
import { EntityResolver } from '../../../src/core/entity-resolver.js';
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, hasApiKey } from '../../online/setup.js';
import { createBenchDir } from '../setup.js';
import { join } from 'node:path';

const SKIP = !hasApiKey();

describe.skipIf(SKIP)('Online: Retrieval Pipeline', () => {
  let graph: KuzuGraph;
  let embedding: OnnxProvider;
  let resolver: EntityResolver;
  let engine: RetrievalEngine;
  let engineNoHyDE: RetrievalEngine;
  let cleanup: () => void;

  beforeAll(async () => {
    const tmp = createBenchDir('lynox-bench-retrieval-');
    cleanup = tmp.cleanup;

    graph = new KuzuGraph(join(tmp.path, 'kg'));
    await graph.init();

    embedding = new OnnxProvider('multilingual-e5-small');
    resolver = new EntityResolver(graph);

    const client = new Anthropic({ apiKey: getApiKey() });
    engine = new RetrievalEngine(graph, embedding, resolver, client);
    engineNoHyDE = new RetrievalEngine(graph, embedding, resolver);

    // Seed with realistic business data
    const memories = [
      { text: 'Client James runs example-store.com and wants BYOK support.', ns: 'knowledge' },
      { text: 'PostgreSQL 16 was chosen for JSONB path queries.', ns: 'knowledge' },
      { text: 'SvelteKit is the frontend framework, Tailwind CSS v4 for styling.', ns: 'knowledge' },
      { text: 'Auth uses Lucia v3 with Arctic and SvelteKit, no Clerk.', ns: 'knowledge' },
      { text: 'Knowledge Graph uses LadybugDB (Kuzu fork) with multilingual-e5-small embeddings.', ns: 'knowledge' },
      { text: 'Always run tests with LYNOX_DEBUG enabled for verification.', ns: 'methods' },
      { text: 'Never mock the database in integration tests.', ns: 'learnings' },
      { text: 'PRDs and business docs go to pro/docs/internal/, never public core.', ns: 'methods' },
      { text: 'Docker image uses node:22-slim for onnxruntime glibc compatibility.', ns: 'knowledge' },
      { text: 'Merge freeze begins 2026-03-05 for mobile release cut.', ns: 'project-state' },
      { text: 'Sprint 1 tech debt: Tasks 1-3 done (type safety, error chaining).', ns: 'project-state' },
      { text: 'Telegram bot uses follow-up buttons and rich status messages.', ns: 'knowledge' },
      { text: 'Entity extraction has two tiers: regex (zero cost) and Haiku LLM.', ns: 'methods' },
      { text: 'Contradiction detection uses vector similarity >0.80 + heuristic checks.', ns: 'methods' },
      { text: 'Pipeline steps use minimal tool sets to save ~3000 tokens/turn.', ns: 'learnings' },
    ];

    // Create entities
    const entityIds: string[] = [];
    const entities = [
      { name: 'James', type: 'person' },
      { name: 'PostgreSQL', type: 'technology' },
      { name: 'SvelteKit', type: 'technology' },
      { name: 'Lucia v3', type: 'technology' },
      { name: 'LadybugDB', type: 'technology' },
      { name: 'Docker', type: 'technology' },
      { name: 'example-store.com', type: 'organization' },
      { name: 'lynox', type: 'project' },
    ];

    for (const ent of entities) {
      const vec = await embedding.embed(ent.name);
      const id = await graph.createEntity({
        canonicalName: ent.name,
        entityType: ent.type,
        scopeType: 'context',
        scopeId: 'bench',
        embedding: vec,
      });
      entityIds.push(id);
    }

    // Create memories with real embeddings + mentions
    for (let i = 0; i < memories.length; i++) {
      const m = memories[i]!;
      const vec = await embedding.embed(m.text);
      const mid = await graph.createMemory({
        text: m.text,
        namespace: m.ns,
        scopeType: 'context',
        scopeId: 'bench',
        embedding: vec,
      });
      // Link first 8 memories to entities
      if (i < entityIds.length) {
        await graph.createMention(mid, entityIds[i]!);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await graph.close();
    cleanup();
  });

  bench('retrieve without HyDE', async () => {
    await engineNoHyDE.retrieve(
      'What database does the project use?',
      [{ type: 'context', id: 'bench' }],
      { useHyDE: false, useGraphExpansion: true },
    );
  }, { iterations: 3, warmupIterations: 1 });

  bench('retrieve with HyDE (Haiku call)', async () => {
    await engine.retrieve(
      'What database does the project use?',
      [{ type: 'context', id: 'bench' }],
      { useHyDE: true, useGraphExpansion: true },
    );
  }, { iterations: 3, warmupIterations: 1 });

  bench('retrieve with graph expansion', async () => {
    await engineNoHyDE.retrieve(
      'Tell me about SvelteKit and the frontend stack',
      [{ type: 'context', id: 'bench' }],
      { useHyDE: false, useGraphExpansion: true },
    );
  }, { iterations: 3, warmupIterations: 1 });

  bench('retrieve narrow namespace (methods only)', async () => {
    await engineNoHyDE.retrieve(
      'What are the best practices for testing?',
      [{ type: 'context', id: 'bench' }],
      { useHyDE: false, namespace: 'methods' },
    );
  }, { iterations: 3, warmupIterations: 1 });
});
