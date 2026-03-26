/**
 * Benchmark: Knowledge Graph (LadybugDB / Kuzu)
 *
 * Measures graph initialization, entity/memory creation,
 * relation creation, and query performance.
 */
import { bench, describe, beforeAll, afterAll } from 'vitest';
import { KuzuGraph } from '../../src/core/knowledge-graph.js';
import { createBenchDir } from './setup.js';
import { join } from 'node:path';

let graph: KuzuGraph;
let cleanup: () => void;
let entityIds: string[] = [];
let memoryIds: string[] = [];

beforeAll(async () => {
  const tmp = createBenchDir('lynox-bench-kg-');
  cleanup = tmp.cleanup;
  graph = new KuzuGraph(join(tmp.path, 'kg'));
  await graph.init();

  // Seed data for query benchmarks
  for (let i = 0; i < 50; i++) {
    const eid = await graph.createEntity({
      canonicalName: `Entity_${i}`,
      entityType: i % 4 === 0 ? 'person' : i % 4 === 1 ? 'organization' : i % 4 === 2 ? 'technology' : 'project',
      scopeType: 'context',
      scopeId: 'bench',
      description: `Test entity number ${i} for benchmarking purposes.`,
      embedding: Array.from({ length: 384 }, (_, j) => Math.sin((i + j) * 0.1)),
    });
    entityIds.push(eid);
  }

  for (let i = 0; i < 100; i++) {
    const mid = await graph.createMemory({
      text: `Memory entry ${i}: This is benchmark data about topic ${i % 10}.`,
      namespace: ['knowledge', 'methods', 'project-state', 'learnings'][i % 4]!,
      scopeType: 'context',
      scopeId: 'bench',
      embedding: Array.from({ length: 384 }, (_, j) => Math.cos((i + j) * 0.1)),
    });
    memoryIds.push(mid);
  }

  // Create some mentions and relations
  for (let i = 0; i < 50; i++) {
    await graph.createMention(memoryIds[i * 2]!, entityIds[i]!);
  }
  for (let i = 0; i < 20; i++) {
    await graph.createRelation(
      entityIds[i]!, entityIds[i + 1]!,
      'works_with', `Relation ${i}`, memoryIds[i]!,
    );
  }
});

afterAll(async () => {
  await graph.close();
  cleanup();
});

describe('Knowledge Graph — init', () => {
  bench('init fresh database', async () => {
    const tmp = createBenchDir('lynox-bench-kg-init-');
    const fresh = new KuzuGraph(join(tmp.path, 'kg'));
    await fresh.init();
    await fresh.close();
    tmp.cleanup();
  }, { iterations: 3, warmupIterations: 0 });
});

describe('Knowledge Graph — create operations', () => {
  let counter = 1000;

  bench('createEntity', async () => {
    await graph.createEntity({
      canonicalName: `BenchEntity_${counter++}`,
      entityType: 'technology',
      scopeType: 'context',
      scopeId: 'bench',
    });
  });

  bench('createMemory', async () => {
    await graph.createMemory({
      text: `Benchmark memory entry ${counter++}`,
      namespace: 'knowledge',
      scopeType: 'context',
      scopeId: 'bench',
      embedding: Array.from({ length: 384 }, (_, j) => Math.sin(counter + j)),
    });
  });

  bench('createMention', async () => {
    const mid = memoryIds[counter % memoryIds.length]!;
    const eid = entityIds[counter % entityIds.length]!;
    counter++;
    await graph.createMention(mid, eid);
  });
});

describe('Knowledge Graph — queries', () => {
  bench('query all entities (MATCH + RETURN)', async () => {
    await graph.query('MATCH (e:Entity) RETURN e.id, e.canonical_name, e.entity_type LIMIT 50');
  });

  bench('query entities by type (parameterized)', async () => {
    await graph.query(
      'MATCH (e:Entity) WHERE e.entity_type = $type RETURN e.id, e.canonical_name LIMIT 20',
      { type: 'technology' },
    );
  });

  bench('query memories by namespace', async () => {
    await graph.query(
      'MATCH (m:Memory) WHERE m.namespace = $ns AND m.is_active = true RETURN m.id, m.text LIMIT 20',
      { ns: 'knowledge' },
    );
  });

  bench('query entity neighbors (1-hop)', async () => {
    await graph.query(
      `MATCH (e:Entity)-[r:RELATES_TO]-(neighbor:Entity)
       WHERE e.id = $eid
       RETURN neighbor.id, neighbor.canonical_name, r.relation_type`,
      { eid: entityIds[5]! },
    );
  });

  bench('query memory→entity mentions', async () => {
    await graph.query(
      `MATCH (m:Memory)-[:MENTIONS]->(e:Entity)
       WHERE m.namespace = $ns
       RETURN m.id, e.canonical_name
       LIMIT 30`,
      { ns: 'knowledge' },
    );
  });

  bench('queryScalar (entity count)', async () => {
    await graph.queryScalar<bigint>('MATCH (e:Entity) RETURN COUNT(e)');
  });
});
