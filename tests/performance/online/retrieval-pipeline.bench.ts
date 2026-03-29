/**
 * Online Benchmark: Retrieval pipeline
 *
 * Measures the full retrieval pipeline: embed query -> vector search ->
 * graph expansion -> merge -> score -> MMR.
 * Uses real ONNX embeddings + SQLite (AgentMemoryDb). HyDE step requires API key.
 *
 * Run: pnpm bench:online
 */
import { bench, describe, beforeAll, afterAll } from 'vitest';
import { AgentMemoryDb } from '../../../src/core/agent-memory-db.js';
import { OnnxProvider } from '../../../src/core/embedding.js';
import { RetrievalEngine } from '../../../src/core/retrieval-engine.js';
import { EntityResolver } from '../../../src/core/entity-resolver.js';
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, hasApiKey } from '../../online/setup.js';
import { createBenchDir } from '../setup.js';
import { join } from 'node:path';

const SKIP = !hasApiKey();

describe.skipIf(SKIP)('Online: Retrieval Pipeline', () => {
  let db: AgentMemoryDb;
  let embedding: OnnxProvider;
  let resolver: EntityResolver;
  let engine: RetrievalEngine;
  let engineNoHyDE: RetrievalEngine;
  let cleanup: () => void;

  beforeAll(async () => {
    const tmp = createBenchDir('lynox-bench-retrieval-');
    cleanup = tmp.cleanup;

    db = new AgentMemoryDb(join(tmp.path, 'bench.db'));
    embedding = new OnnxProvider('multilingual-e5-small');
    db.setEmbeddingDimensions(embedding.dimensions);
    resolver = new EntityResolver(db);

    const client = new Anthropic({ apiKey: getApiKey() });
    engine = new RetrievalEngine(db, embedding, resolver, client);
    engineNoHyDE = new RetrievalEngine(db, embedding, resolver);

    // Seed with realistic business data
    const memories = [
      { text: 'Client James runs example-store.com and wants BYOK support.', ns: 'knowledge' },
      { text: 'PostgreSQL 16 was chosen for JSONB path queries.', ns: 'knowledge' },
      { text: 'SvelteKit is the frontend framework, Tailwind CSS v4 for styling.', ns: 'knowledge' },
      { text: 'Auth uses Lucia v3 with Arctic and SvelteKit, no Clerk.', ns: 'knowledge' },
      { text: 'Agent memory uses SQLite (better-sqlite3) with multilingual-e5-small embeddings.', ns: 'knowledge' },
      { text: 'Deployment target is Cloudflare Workers + D1 for the web layer.', ns: 'knowledge' },
      { text: 'The pricing model is CHF 49/mo solo, CHF 149/mo team.', ns: 'knowledge' },
      { text: 'Run database migrations before deploying new versions.', ns: 'methods' },
    ];

    for (const m of memories) {
      const emb = await embedding.embed(m.text);
      db.createMemory({
        text: m.text,
        namespace: m.ns,
        scopeType: 'context',
        scopeId: 'bench',
        embedding: emb,
      });
    }
  });

  afterAll(() => {
    db.close();
    cleanup();
  });

  const scope = { type: 'context' as const, id: 'bench' };

  bench('retrieve (vector only, no HyDE)', async () => {
    await engineNoHyDE.retrieve('What database does the project use?', [scope], {
      topK: 5,
      threshold: 0.3,
      useHyDE: false,
      useGraphExpansion: false,
    });
  });

  bench('retrieve (vector + graph expansion)', async () => {
    await engineNoHyDE.retrieve('What database does the project use?', [scope], {
      topK: 5,
      threshold: 0.3,
      useHyDE: false,
      useGraphExpansion: true,
    });
  });

  bench('retrieve (vector + HyDE)', async () => {
    await engine.retrieve('What database does the project use?', [scope], {
      topK: 5,
      threshold: 0.3,
      useHyDE: true,
      useGraphExpansion: false,
    });
  });
});
