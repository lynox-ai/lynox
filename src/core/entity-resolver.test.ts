import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentMemoryDb } from './agent-memory-db.js';
import { EntityResolver, toEntityRecord } from './entity-resolver.js';
import type { MemoryScopeRef } from '../types/index.js';

describe('EntityResolver', () => {
  let tempDir: string;
  let db: AgentMemoryDb;
  let resolver: EntityResolver;
  const scopes: MemoryScopeRef[] = [
    { type: 'context', id: 'proj1' },
    { type: 'global', id: 'global' },
  ];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-resolver-test-'));
    db = new AgentMemoryDb(join(tempDir, 'test.db'));
    db.setEmbeddingDimensions(3);
    resolver = new EntityResolver(db);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── resolve() ───────────────────────────────────────────────

  describe('resolve', () => {
    it('creates new entity when none exists', async () => {
      const result = await resolver.resolve('Acme Corp', 'organization', scopes);
      expect(result).not.toBeNull();
      expect(result!.canonicalName).toBe('Acme Corp');
      expect(result!.entityType).toBe('organization');
      expect(result!.mentionCount).toBe(1);
      expect(result!.scopeType).toBe('context');
      expect(result!.scopeId).toBe('proj1');
    });

    it('returns null for names shorter than 2 characters', async () => {
      const result = await resolver.resolve('A', 'person', scopes);
      expect(result).toBeNull();
    });

    it('returns null for empty/whitespace names', async () => {
      expect(await resolver.resolve('', 'person', scopes)).toBeNull();
      expect(await resolver.resolve('  ', 'person', scopes)).toBeNull();
    });

    it('matches existing entity by exact canonical name (case-insensitive)', async () => {
      const first = await resolver.resolve('Thomas', 'person', scopes);
      const second = await resolver.resolve('thomas', 'person', scopes);
      expect(second!.id).toBe(first!.id);
      // DB row is read before increment — check DB directly for final count
      const row = db.getEntity(first!.id);
      expect(row!.mention_count).toBe(2);
    });

    it('matches existing entity by alias', async () => {
      const first = await resolver.resolve('Thomas Mueller', 'person', scopes);
      db.addEntityAlias(first!.id, 'Tom');
      const second = await resolver.resolve('Tom', 'person', scopes);
      expect(second!.id).toBe(first!.id);
    });

    it('increments mention count on each resolve', async () => {
      await resolver.resolve('lynox', 'project', scopes);
      await resolver.resolve('lynox', 'project', scopes);
      await resolver.resolve('lynox', 'project', scopes);
      const entity = db.findEntityByCanonicalName('lynox');
      expect(entity!.mention_count).toBe(3);
    });

    it('falls back to canonical match without scope filter', async () => {
      // Create entity in a different scope
      db.createEntity({
        canonicalName: 'SharedEntity',
        entityType: 'concept',
        scopeType: 'user',
        scopeId: 'user1',
      });
      // Resolve with scopes that don't include 'user'
      const result = await resolver.resolve('SharedEntity', 'concept', scopes);
      expect(result).not.toBeNull();
      expect(result!.canonicalName).toBe('SharedEntity');
    });

    it('adds alias on fallback canonical match', async () => {
      const id = db.createEntity({
        canonicalName: 'Existing',
        entityType: 'concept',
        scopeType: 'user',
        scopeId: 'u1',
      });
      await resolver.resolve('Existing', 'concept', scopes);
      const entity = db.getEntity(id);
      const aliases = JSON.parse(entity!.aliases) as string[];
      expect(aliases).toContain('Existing');
    });

    it('returns null when createIfMissing is false and no match', async () => {
      const result = await resolver.resolve('Unknown', 'person', scopes, {
        createIfMissing: false,
      });
      expect(result).toBeNull();
      expect(db.getEntityCount()).toBe(0);
    });

    it('prefers context scope when creating entity', async () => {
      const result = await resolver.resolve('Test', 'concept', [
        { type: 'global', id: 'global' },
        { type: 'context', id: 'myproj' },
      ]);
      expect(result!.scopeType).toBe('context');
      expect(result!.scopeId).toBe('myproj');
    });

    it('falls back to first non-global scope when no context scope', async () => {
      const result = await resolver.resolve('Test', 'concept', [
        { type: 'global', id: 'global' },
        { type: 'user', id: 'user1' },
      ]);
      expect(result!.scopeType).toBe('user');
      expect(result!.scopeId).toBe('user1');
    });

    it('uses global scope as last resort', async () => {
      const result = await resolver.resolve('Test', 'concept', [
        { type: 'global', id: 'global' },
      ]);
      expect(result!.scopeType).toBe('global');
      expect(result!.scopeId).toBe('global');
    });

    it('stores description when provided', async () => {
      const result = await resolver.resolve('React', 'concept', scopes, {
        description: 'JavaScript UI library',
      });
      expect(result!.description).toBe('JavaScript UI library');
      const row = db.getEntity(result!.id);
      expect(row!.description).toBe('JavaScript UI library');
    });

    it('sets empty description when not provided', async () => {
      const result = await resolver.resolve('NoDesc', 'concept', scopes);
      expect(result!.description).toBe('');
    });

    it('handles empty scopes array gracefully', async () => {
      const result = await resolver.resolve('Test', 'concept', []);
      expect(result).not.toBeNull();
      expect(result!.scopeType).toBe('context');
      expect(result!.scopeId).toBe('');
    });
  });

  // ── merge() ─────────────────────────────────────────────────

  describe('merge', () => {
    it('merges source into target and deletes source', async () => {
      const source = await resolver.resolve('Tom', 'person', scopes);
      const target = await resolver.resolve('Thomas Mueller', 'person', scopes);
      await resolver.merge(source!.id, target!.id);

      expect(db.getEntity(source!.id)).toBeNull();
      const merged = db.getEntity(target!.id);
      expect(merged).not.toBeNull();
      const aliases = JSON.parse(merged!.aliases) as string[];
      expect(aliases).toContain('Tom');
      expect(aliases).toContain('Thomas Mueller');
    });

    it('transfers mention count from source to target', async () => {
      const source = await resolver.resolve('src', 'concept', scopes);
      // Add extra mentions
      db.incrementEntityMentions(source!.id);
      db.incrementEntityMentions(source!.id);
      const target = await resolver.resolve('tgt', 'concept', scopes);

      await resolver.merge(source!.id, target!.id);
      const merged = db.getEntity(target!.id);
      // target had 1 mention + source had 3 mentions = 4
      expect(merged!.mention_count).toBe(4);
    });

    it('no-ops when source does not exist', async () => {
      const target = await resolver.resolve('Target', 'concept', scopes);
      await resolver.merge('nonexistent-id', target!.id);
      // Should not throw, target unchanged
      const row = db.getEntity(target!.id);
      expect(row).not.toBeNull();
    });

    it('adds source canonical name as target alias', async () => {
      const source = await resolver.resolve('OldName', 'person', scopes);
      const target = await resolver.resolve('NewName', 'person', scopes);
      await resolver.merge(source!.id, target!.id);

      const merged = db.getEntity(target!.id);
      const aliases = JSON.parse(merged!.aliases) as string[];
      expect(aliases).toContain('OldName');
    });
  });

  // ── toEntityRecord() ────────────────────────────────────────

  describe('toEntityRecord', () => {
    it('converts EntityRow to EntityRecord', () => {
      const id = db.createEntity({
        canonicalName: 'Test Entity',
        entityType: 'organization',
        aliases: ['test', 'Test Entity'],
        description: 'A test',
        scopeType: 'context',
        scopeId: 'proj1',
      });
      const row = db.getEntity(id)!;
      const record = toEntityRecord(row);
      expect(record.id).toBe(id);
      expect(record.canonicalName).toBe('Test Entity');
      expect(record.entityType).toBe('organization');
      expect(record.aliases).toEqual(['test', 'Test Entity']);
      expect(record.description).toBe('A test');
      expect(record.scopeType).toBe('context');
      expect(record.scopeId).toBe('proj1');
      expect(record.mentionCount).toBe(1);
      expect(typeof record.firstSeenAt).toBe('string');
      expect(typeof record.lastSeenAt).toBe('string');
    });
  });
});
