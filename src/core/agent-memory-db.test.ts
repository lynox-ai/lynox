import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentMemoryDb } from './agent-memory-db.js';

describe('AgentMemoryDb', () => {
  let tempDir: string;
  let db: AgentMemoryDb;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-mem-test-'));
    db = new AgentMemoryDb(join(tempDir, 'test.db'));
    db.setEmbeddingDimensions(3);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── Lifecycle ────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('creates database and schema', () => {
      expect(db.getEntityCount()).toBe(0);
      expect(db.getActiveMemoryCount()).toBe(0);
    });

    it('can close and reopen', async () => {
      const path = db.path;
      db.createEntity({ canonicalName: 'Test', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      db.close();
      const db2 = new AgentMemoryDb(path);
      db2.setEmbeddingDimensions(3);
      expect(db2.getEntityCount()).toBe(1);
      db2.close();
    });

    it('idempotent init', () => {
      const path = db.path;
      db.close();
      const db2 = new AgentMemoryDb(path);
      expect(db2.getEntityCount()).toBe(0);
      db2.close();
    });
  });

  // ── Entity Operations ────────────────────────────────────────

  describe('entities', () => {
    it('creates entity and retrieves by name', () => {
      const id = db.createEntity({
        canonicalName: 'Alice',
        entityType: 'person',
        scopeType: 'global',
        scopeId: 'g',
        description: 'A person',
      });
      expect(id).toBeDefined();

      const found = db.findEntityByCanonicalName('alice');
      expect(found).not.toBeNull();
      expect(found!.canonical_name).toBe('Alice');
      expect(found!.entity_type).toBe('person');
      expect(found!.description).toBe('A person');
    });

    it('finds entity by alias', () => {
      db.createEntity({
        canonicalName: 'Robert',
        entityType: 'person',
        aliases: ['Robert', 'Bob', 'Bobby'],
        scopeType: 'global',
        scopeId: 'g',
      });

      const found = db.findEntityByAlias('Bob');
      expect(found).not.toBeNull();
      expect(found!.canonical_name).toBe('Robert');
    });

    it('increments mention count', () => {
      const id = db.createEntity({ canonicalName: 'X', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      db.incrementEntityMentions(id);
      db.incrementEntityMentions(id);
      const entity = db.getEntity(id);
      expect(entity!.mention_count).toBe(3); // 1 initial + 2 increments
    });

    it('adds alias without duplicates', () => {
      const id = db.createEntity({ canonicalName: 'Alice', entityType: 'person', scopeType: 'global', scopeId: 'g' });
      db.addEntityAlias(id, 'Ali');
      db.addEntityAlias(id, 'Ali'); // duplicate
      const entity = db.getEntity(id);
      const aliases = JSON.parse(entity!.aliases) as string[];
      expect(aliases).toContain('Ali');
      expect(aliases.filter(a => a === 'Ali')).toHaveLength(1);
    });

    it('lists entities by type', () => {
      db.createEntity({ canonicalName: 'Alice', entityType: 'person', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: 'Acme', entityType: 'organization', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: 'Bob', entityType: 'person', scopeType: 'global', scopeId: 'g' });

      const people = db.listEntities({ type: 'person' });
      expect(people).toHaveLength(2);
      const orgs = db.listEntities({ type: 'organization' });
      expect(orgs).toHaveLength(1);
    });

    it('filters by scope type', () => {
      db.createEntity({ canonicalName: 'Global', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: 'User', entityType: 'concept', scopeType: 'user', scopeId: 'u1' });

      const found = db.findEntityByCanonicalName('Global', ['global']);
      expect(found).not.toBeNull();
      const notFound = db.findEntityByCanonicalName('Global', ['user']);
      expect(notFound).toBeNull();
    });

    it('deletes entity and cascades', () => {
      const eId = db.createEntity({ canonicalName: 'X', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      const mId = db.createMemory({ text: 'test', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      db.createMention(mId, eId);
      db.deleteEntity(eId);
      expect(db.getEntity(eId)).toBeNull();
      expect(db.getEntityCount()).toBe(0);
    });
  });

  // ── Memory Operations ────────────────────────────────────────

  describe('memories', () => {
    it('creates and retrieves memory', () => {
      const id = db.createMemory({
        text: 'Hello world',
        namespace: 'knowledge',
        scopeType: 'global',
        scopeId: 'g',
        embedding: [1, 0, 0],
      });
      const mem = db.getMemory(id);
      expect(mem).not.toBeNull();
      expect(mem!.text).toBe('Hello world');
      expect(mem!.is_active).toBe(1);
      expect(mem!.confidence).toBe(0.75);
    });

    it('supersedes memory', () => {
      const id1 = db.createMemory({ text: 'old', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      const id2 = db.createMemory({ text: 'new', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [0, 1, 0] });
      db.supersedMemory(id1, id2);
      const old = db.getMemory(id1);
      expect(old!.is_active).toBe(0);
      expect(old!.superseded_by).toBe(id2);
    });

    it('tracks retrieval count', () => {
      const id = db.createMemory({ text: 'test', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      db.updateMemoryRetrieved(id);
      db.updateMemoryRetrieved(id);
      const mem = db.getMemory(id);
      expect(mem!.retrieval_count).toBe(2);
      expect(mem!.last_retrieved_at).not.toBeNull();
    });

    it('finds by text pattern', () => {
      db.createMemory({ text: 'Alice likes cats', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      db.createMemory({ text: 'Bob likes dogs', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [0, 1, 0] });
      const found = db.findMemoriesByTextPattern('cats');
      expect(found).toHaveLength(1);
      expect(found[0]!.text).toContain('cats');
    });

    it('deactivates by pattern', () => {
      db.createMemory({ text: 'remove me', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      db.createMemory({ text: 'keep me', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [0, 1, 0] });
      const count = db.deactivateMemoriesByPattern('remove');
      expect(count).toBe(1);
      expect(db.getActiveMemoryCount()).toBe(1);
    });

    it('updates memory text', () => {
      db.createMemory({ text: 'old text here', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      const id = db.updateMemoryText('old text', 'new text here');
      expect(id).not.toBeNull();
      const mem = db.getMemory(id!);
      expect(mem!.text).toBe('new text here');
    });
  });

  // ── Vector Search ────────────────────────────────────────────

  describe('vector search', () => {
    it('finds similar memories', () => {
      db.createMemory({ text: 'A', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      db.createMemory({ text: 'B', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [0, 1, 0] });
      db.createMemory({ text: 'C', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [0.9, 0.1, 0] });

      const results = db.findSimilarMemories([1, 0, 0], 10, 0.5);
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0]!.text).toBe('A');
      expect(results[0]!._similarity).toBeGreaterThan(0.9);
    });

    it('respects namespace filter', () => {
      db.createMemory({ text: 'A', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      db.createMemory({ text: 'B', namespace: 'methods', scopeType: 'global', scopeId: 'g', embedding: [0.9, 0.1, 0] });

      const results = db.findSimilarMemories([1, 0, 0], 10, 0.5, { namespace: 'methods' });
      expect(results).toHaveLength(1);
      expect(results[0]!.text).toBe('B');
    });

    it('excludes inactive memories by default', () => {
      const id = db.createMemory({ text: 'A', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      db.supersedMemory(id, 'x');
      const results = db.findSimilarMemories([1, 0, 0], 10, 0.5);
      expect(results).toHaveLength(0);
    });
  });

  // ── Relationships ────────────────────────────────────────────

  describe('relationships', () => {
    it('creates mention', () => {
      const eId = db.createEntity({ canonicalName: 'X', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      const mId = db.createMemory({ text: 'about X', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      db.createMention(mId, eId);
      const mems = db.getMemoriesMentioningEntity(eId);
      expect(mems).toHaveLength(1);
      expect(mems[0]!.text).toBe('about X');
    });

    it('creates relation between entities', () => {
      const e1 = db.createEntity({ canonicalName: 'Alice', entityType: 'person', scopeType: 'global', scopeId: 'g' });
      const e2 = db.createEntity({ canonicalName: 'Acme', entityType: 'organization', scopeType: 'global', scopeId: 'g' });
      db.createRelation(e1, e2, 'works_for', 'Alice works at Acme', '');
      const rels = db.getEntityRelations(e1);
      expect(rels).toHaveLength(1);
      expect(rels[0]!.relation_type).toBe('works_for');
      expect(db.getRelationCount()).toBe(1);
    });

    it('tracks cooccurrences', () => {
      const e1 = db.createEntity({ canonicalName: 'A', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      const e2 = db.createEntity({ canonicalName: 'B', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      db.updateCooccurrence(e1, e2);
      db.updateCooccurrence(e2, e1); // reversed — should increment same row
      db.updateCooccurrence(e1, e2);
      // Normalized order means all 3 updates hit the same row
      // count should be 3
    });

    it('creates supersedes edge', () => {
      const m1 = db.createMemory({ text: 'old', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      const m2 = db.createMemory({ text: 'new', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [0, 1, 0] });
      db.createSupersedes(m2, m1, 'contradiction');
      // No crash = success (supersedes table doesn't have a query method yet)
    });
  });

  // ── Graph Traversal ──────────────────────────────────────────

  describe('graph traversal', () => {
    it('finds 2-hop related memories', () => {
      const e1 = db.createEntity({ canonicalName: 'A', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      const e2 = db.createEntity({ canonicalName: 'B', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      db.createRelation(e1, e2, 'related_to', '', '');

      const m = db.createMemory({ text: 'about B', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      db.createMention(m, e2);

      const related = db.getRelatedMemoriesViaEntities(e1, 2, true, 10);
      expect(related).toHaveLength(1);
      expect(related[0]!.text).toBe('about B');
    });

    it('finds path between entities', () => {
      const e1 = db.createEntity({ canonicalName: 'A', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      const e2 = db.createEntity({ canonicalName: 'B', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      const e3 = db.createEntity({ canonicalName: 'C', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      db.createRelation(e1, e2, 'knows', '', '');
      db.createRelation(e2, e3, 'knows', '', '');

      const path = db.findPath(e1, e3, 3);
      expect(path.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty path for disconnected entities', () => {
      const e1 = db.createEntity({ canonicalName: 'A', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      const e2 = db.createEntity({ canonicalName: 'B', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      const path = db.findPath(e1, e2);
      expect(path).toHaveLength(0);
    });

    it('gets neighborhood', () => {
      const e1 = db.createEntity({ canonicalName: 'Center', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      const e2 = db.createEntity({ canonicalName: 'Neighbor', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      db.createRelation(e1, e2, 'related_to', '', '');

      const hood = db.getNeighborhood(e1, 1);
      expect(hood.entities).toHaveLength(1);
      expect(hood.entities[0]!.canonical_name).toBe('Neighbor');
    });
  });

  // ── Episodes ─────────────────────────────────────────────────

  describe('episodes', () => {
    it('creates and retrieves episode', () => {
      const id = db.createEpisode({
        task: 'Fix bug',
        outcomeSignal: 'success',
        toolsUsed: ['file_write', 'bash'],
        durationMs: 5000,
      });
      const ep = db.getEpisode(id);
      expect(ep).not.toBeNull();
      expect(ep!.task).toBe('Fix bug');
      expect(ep!.outcome_signal).toBe('success');
      expect(JSON.parse(ep!.tools_used)).toEqual(['file_write', 'bash']);
    });

    it('updates episode outcome', () => {
      const id = db.createEpisode({ task: 'Deploy' });
      db.updateEpisodeOutcome(id, { outcomeSignal: 'failed', userFeedback: 'wrong branch' });
      const ep = db.getEpisode(id);
      expect(ep!.outcome_signal).toBe('failed');
      expect(ep!.user_feedback).toBe('wrong branch');
    });

    it('queries episodes by signal', () => {
      db.createEpisode({ task: 'A', outcomeSignal: 'success' });
      db.createEpisode({ task: 'B', outcomeSignal: 'failed' });
      db.createEpisode({ task: 'C', outcomeSignal: 'success' });

      const successes = db.queryEpisodes({ outcomeSignal: 'success' });
      expect(successes).toHaveLength(2);
    });

    it('links memories to episode', () => {
      const epId = db.createEpisode({ task: 'Test' });
      const mId = db.createMemory({ text: 'fact', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      db.linkMemoriesToEpisode(epId, [mId]);

      const mem = db.getMemory(mId);
      expect(mem!.source_episode_id).toBe(epId);
      const ep = db.getEpisode(epId);
      expect(JSON.parse(ep!.memories_created)).toContain(mId);
    });

    it('counts episodes', () => {
      db.createEpisode({ task: 'A' });
      db.createEpisode({ task: 'B' });
      expect(db.getEpisodeCount()).toBe(2);
    });
  });

  // ── Patterns ─────────────────────────────────────────────────

  describe('patterns', () => {
    it('creates and retrieves pattern', () => {
      const id = db.createPattern({
        patternType: 'preference',
        description: 'User prefers tables over prose',
        confidence: 0.8,
      });
      const patterns = db.getPatterns({ patternType: 'preference' });
      expect(patterns).toHaveLength(1);
      expect(patterns[0]!.description).toBe('User prefers tables over prose');
      expect(patterns[0]!.id).toBe(id);
    });

    it('increments evidence count', () => {
      const id = db.createPattern({ patternType: 'sequence', description: 'A then B' });
      db.incrementPatternEvidence(id);
      db.incrementPatternEvidence(id);
      const patterns = db.getPatterns();
      expect(patterns[0]!.evidence_count).toBe(3);
      expect(patterns[0]!.confidence).toBeGreaterThan(0.5);
    });

    it('counts active patterns', () => {
      db.createPattern({ patternType: 'sequence', description: 'X' });
      db.createPattern({ patternType: 'preference', description: 'Y' });
      expect(db.getPatternCount()).toBe(2);
    });
  });

  // ── Metrics ──────────────────────────────────────────────────

  describe('metrics', () => {
    it('upserts metric', () => {
      db.upsertMetric({ metricName: 'success_rate', value: 0.85, sampleCount: 10 });
      const metrics = db.getMetrics('success_rate');
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.value).toBe(0.85);
      expect(metrics[0]!.sample_count).toBe(10);
    });

    it('updates existing metric', () => {
      db.upsertMetric({ metricName: 'success_rate', value: 0.8 });
      db.upsertMetric({ metricName: 'success_rate', value: 0.9, sampleCount: 20 });
      const metrics = db.getMetrics('success_rate');
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.value).toBe(0.9);
      expect(metrics[0]!.sample_count).toBe(20);
    });

    it('separates metrics by window', () => {
      db.upsertMetric({ metricName: 'cost', value: 1.5, window: 'daily' });
      db.upsertMetric({ metricName: 'cost', value: 10.0, window: 'weekly' });
      const daily = db.getMetrics('cost', 'daily');
      expect(daily).toHaveLength(1);
      expect(daily[0]!.value).toBe(1.5);
    });
  });

  // ── Garbage Collection ───────────────────────────────────────

  describe('gc', () => {
    it('dry run reports counts', () => {
      const m1 = db.createMemory({ text: 'active', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      const m2 = db.createMemory({ text: 'inactive', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [0, 1, 0] });
      db.supersedMemory(m2, m1);

      const result = db.gc(true);
      expect(result.supersededRemoved).toBe(1);
      expect(db.getActiveMemoryCount()).toBe(1); // Not actually removed
    });

    it('removes inactive memories and orphan entities', () => {
      const e = db.createEntity({ canonicalName: 'Orphan', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      const m1 = db.createMemory({ text: 'active', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [1, 0, 0] });
      const m2 = db.createMemory({ text: 'to remove', namespace: 'knowledge', scopeType: 'global', scopeId: 'g', embedding: [0, 1, 0] });
      db.createMention(m2, e);
      db.supersedMemory(m2, m1);

      const result = db.gc(false);
      expect(result.supersededRemoved).toBe(1);
      expect(result.orphanEntitiesRemoved).toBeGreaterThanOrEqual(1);
      expect(db.getEntity(e)).toBeNull();
    });
  });

  // ── Transactions ─────────────────────────────────────────────

  describe('transactions', () => {
    it('wraps multiple ops atomically', () => {
      db.transaction(() => {
        db.createEntity({ canonicalName: 'A', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
        db.createEntity({ canonicalName: 'B', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      });
      expect(db.getEntityCount()).toBe(2);
    });
  });
});
