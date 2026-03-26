import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KuzuGraph } from './knowledge-graph.js';

describe('KuzuGraph', () => {
  let graph: KuzuGraph;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-kg-test-'));
    graph = new KuzuGraph(join(tempDir, 'test-graph'));
    await graph.init();
  });

  afterEach(async () => {
    await graph.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('lifecycle', () => {
    it('initializes and reports ready', () => {
      expect(graph.isReady).toBe(true);
    });

    it('can be closed and reopened', async () => {
      await graph.close();
      expect(graph.isReady).toBe(false);

      const graph2 = new KuzuGraph(join(tempDir, 'test-graph'));
      await graph2.init();
      expect(graph2.isReady).toBe(true);
      await graph2.close();
    });

    it('init is idempotent', async () => {
      await graph.init(); // second call should be safe
      expect(graph.isReady).toBe(true);
    });
  });

  describe('entity operations', () => {
    it('creates and finds an entity by canonical name', async () => {
      await graph.createEntity({
        canonicalName: 'Thomas Weber',
        entityType: 'person',
        scopeType: 'context',
        scopeId: 'test-project',
      });

      const found = await graph.findEntityByCanonicalName('Thomas Weber');
      expect(found).not.toBeNull();
      expect(found!['e.canonical_name']).toBe('Thomas Weber');
      expect(found!['e.entity_type']).toBe('person');
    });

    it('finds entity by alias', async () => {
      await graph.createEntity({
        canonicalName: 'Thomas Weber',
        entityType: 'person',
        aliases: ['Thomas', 'Thomas Weber', 'Herr Weber'],
        scopeType: 'context',
        scopeId: 'test-project',
      });

      const found = await graph.findEntityByAlias('Herr Weber');
      expect(found).not.toBeNull();
      expect(found!['e.canonical_name']).toBe('Thomas Weber');
    });

    it('increments mention count', async () => {
      const id = await graph.createEntity({
        canonicalName: 'TestEntity',
        entityType: 'concept',
        scopeType: 'global',
        scopeId: 'global',
      });

      await graph.incrementEntityMentions(id);
      await graph.incrementEntityMentions(id);

      const found = await graph.findEntityByCanonicalName('TestEntity');
      expect(Number(found!['e.mention_count'])).toBe(3); // 1 initial + 2 increments
    });

    it('adds alias to existing entity', async () => {
      const id = await graph.createEntity({
        canonicalName: 'acme-shop.ch',
        entityType: 'organization',
        aliases: ['acme-shop.ch'],
        scopeType: 'context',
        scopeId: 'test',
      });

      await graph.addEntityAlias(id, 'Acme Shop');

      const found = await graph.findEntityByAlias('Acme Shop');
      expect(found).not.toBeNull();
    });

    it('counts entities', async () => {
      expect(await graph.getEntityCount()).toBe(0);

      await graph.createEntity({
        canonicalName: 'Entity1',
        entityType: 'concept',
        scopeType: 'global',
        scopeId: 'global',
      });
      await graph.createEntity({
        canonicalName: 'Entity2',
        entityType: 'person',
        scopeType: 'global',
        scopeId: 'global',
      });

      expect(await graph.getEntityCount()).toBe(2);
    });
  });

  describe('memory operations', () => {
    it('creates a memory and counts it', async () => {
      expect(await graph.getActiveMemoryCount()).toBe(0);

      await graph.createMemory({
        text: 'PostgreSQL is required for this project.',
        namespace: 'knowledge',
        scopeType: 'context',
        scopeId: 'test',
        embedding: [0.1, 0.2, 0.3],
      });

      expect(await graph.getActiveMemoryCount()).toBe(1);
    });

    it('supersedes a memory', async () => {
      const oldId = await graph.createMemory({
        text: 'Project uses MySQL.',
        namespace: 'knowledge',
        scopeType: 'context',
        scopeId: 'test',
        embedding: [0.1, 0.2, 0.3],
      });

      const newId = await graph.createMemory({
        text: 'Project uses PostgreSQL.',
        namespace: 'knowledge',
        scopeType: 'context',
        scopeId: 'test',
        embedding: [0.4, 0.5, 0.6],
      });

      await graph.supersedMemory(oldId, newId);

      // Old memory should not count as active
      expect(await graph.getActiveMemoryCount()).toBe(1);
    });

    it('updates retrieval metadata', async () => {
      const id = await graph.createMemory({
        text: 'Test memory.',
        namespace: 'knowledge',
        scopeType: 'context',
        scopeId: 'test',
        embedding: [0.1, 0.2, 0.3],
      });

      await graph.updateMemoryRetrieved(id);
      await graph.updateMemoryRetrieved(id);

      const row = await graph.queryOne(
        'MATCH (m:Memory) WHERE m.id = $id RETURN m.retrieval_count',
        { id },
      );
      expect(Number(row!['m.retrieval_count'])).toBe(2);
    });
  });

  describe('relationship operations', () => {
    it('creates MENTIONS relationship', async () => {
      const memId = await graph.createMemory({
        text: 'Thomas is a client.',
        namespace: 'knowledge',
        scopeType: 'context',
        scopeId: 'test',
        embedding: [0.1, 0.2, 0.3],
      });

      const entId = await graph.createEntity({
        canonicalName: 'Thomas',
        entityType: 'person',
        scopeType: 'context',
        scopeId: 'test',
      });

      await graph.createMention(memId, entId);

      const memories = await graph.getMemoriesMentioningEntity(entId);
      expect(memories).toHaveLength(1);
      expect(memories[0]!['m.text']).toBe('Thomas is a client.');
    });

    it('creates RELATES_TO relationship', async () => {
      const e1 = await graph.createEntity({
        canonicalName: 'Thomas',
        entityType: 'person',
        scopeType: 'context',
        scopeId: 'test',
      });

      const e2 = await graph.createEntity({
        canonicalName: 'acme-shop.ch',
        entityType: 'organization',
        scopeType: 'context',
        scopeId: 'test',
      });

      await graph.createRelation(e1, e2, 'owns', 'Thomas owns acme-shop.ch', 'mem-1');

      expect(await graph.getRelationCount()).toBe(1);
    });

    it('creates and increments COOCCURS', async () => {
      const e1 = await graph.createEntity({
        canonicalName: 'A',
        entityType: 'concept',
        scopeType: 'global',
        scopeId: 'global',
      });
      const e2 = await graph.createEntity({
        canonicalName: 'B',
        entityType: 'concept',
        scopeType: 'global',
        scopeId: 'global',
      });

      await graph.updateCooccurrence(e1, e2);
      await graph.updateCooccurrence(e1, e2);

      const row = await graph.queryOne(
        `MATCH (a:Entity)-[r:COOCCURS]-(b:Entity)
         WHERE a.id = $aId AND b.id = $bId
         RETURN r.count`,
        { aId: e1, bId: e2 },
      );
      expect(Number(row!['r.count'])).toBe(2);
    });
  });

  describe('similarity search', () => {
    it('finds similar memories by embedding', async () => {
      await graph.createMemory({
        text: 'PostgreSQL is the database.',
        namespace: 'knowledge',
        scopeType: 'context',
        scopeId: 'test',
        embedding: [1.0, 0.0, 0.0],
      });

      await graph.createMemory({
        text: 'SvelteKit is the frontend.',
        namespace: 'knowledge',
        scopeType: 'context',
        scopeId: 'test',
        embedding: [0.0, 1.0, 0.0],
      });

      const results = await graph.findSimilarMemories(
        [0.9, 0.1, 0.0], // close to first memory
        5,
        0.5,
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!['m.text']).toBe('PostgreSQL is the database.');
      expect(results[0]!._similarity).toBeGreaterThan(0.9);
    });

    it('respects namespace filter', async () => {
      await graph.createMemory({
        text: 'Knowledge entry.',
        namespace: 'knowledge',
        scopeType: 'context',
        scopeId: 'test',
        embedding: [1.0, 0.0, 0.0],
      });

      await graph.createMemory({
        text: 'Methods entry.',
        namespace: 'methods',
        scopeType: 'context',
        scopeId: 'test',
        embedding: [0.9, 0.1, 0.0],
      });

      const results = await graph.findSimilarMemories(
        [1.0, 0.0, 0.0],
        5,
        0.5,
        { namespace: 'knowledge' },
      );

      expect(results).toHaveLength(1);
      expect(results[0]!['m.namespace']).toBe('knowledge');
    });

    it('excludes inactive memories when requested', async () => {
      const id = await graph.createMemory({
        text: 'Old fact.',
        namespace: 'knowledge',
        scopeType: 'context',
        scopeId: 'test',
        embedding: [1.0, 0.0, 0.0],
      });

      await graph.supersedMemory(id, 'new-id');

      const results = await graph.findSimilarMemories(
        [1.0, 0.0, 0.0],
        5,
        0.5,
        { activeOnly: true },
      );

      expect(results).toHaveLength(0);
    });
  });

  describe('stats', () => {
    it('returns correct counts', async () => {
      expect(await graph.getActiveMemoryCount()).toBe(0);
      expect(await graph.getEntityCount()).toBe(0);
      expect(await graph.getRelationCount()).toBe(0);
      expect(await graph.getCommunityCount()).toBe(0);
    });
  });
});
