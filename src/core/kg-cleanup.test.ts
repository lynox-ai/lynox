import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentMemoryDb } from './agent-memory-db.js';
import { isCleanupTarget, cleanupBadEntities } from './kg-cleanup.js';

describe('kg-cleanup', () => {
  describe('isCleanupTarget', () => {
    it('rejects single-word stopwords', () => {
      expect(isCleanupTarget('in')).toBe(true);
      expect(isCleanupTarget('tools')).toBe(true);
      expect(isCleanupTarget('Tools')).toBe(true); // case-insensitive
      expect(isCleanupTarget('sync')).toBe(true);
      expect(isCleanupTarget('provides')).toBe(true);
      expect(isCleanupTarget('generates')).toBe(true);
      expect(isCleanupTarget('validation')).toBe(true);
      expect(isCleanupTarget('setup')).toBe(true);
      expect(isCleanupTarget('project')).toBe(true);
      expect(isCleanupTarget('timeline')).toBe(true);
      expect(isCleanupTarget('einzeltools')).toBe(true);
    });

    it('rejects pricing fragments', () => {
      expect(isCleanupTarget('39/mo')).toBe(true);
      expect(isCleanupTarget('99/mo')).toBe(true);
      expect(isCleanupTarget('20/mo')).toBe(true);
      expect(isCleanupTarget('CHF 39/mo')).toBe(true);
      expect(isCleanupTarget('$200/year')).toBe(true);
      expect(isCleanupTarget('EUR 49/month')).toBe(true);
      expect(isCleanupTarget('10/k')).toBe(true);
      expect(isCleanupTarget('5/hour')).toBe(true);
    });

    it('rejects slash enums where either half is generic', () => {
      expect(isCleanupTarget('create/update')).toBe(true);
      expect(isCleanupTarget('open/closed')).toBe(false); // neither in stopwords
      expect(isCleanupTarget('process/launch')).toBe(true);
    });

    it('rejects empty / whitespace-only names', () => {
      expect(isCleanupTarget('')).toBe(true);
      expect(isCleanupTarget('   ')).toBe(true);
    });

    it('keeps legitimate proper nouns', () => {
      expect(isCleanupTarget('Peter Huber')).toBe(false);
      expect(isCleanupTarget('lynox.ai')).toBe(false);
      expect(isCleanupTarget('Mistral AI')).toBe(false);
      expect(isCleanupTarget('Hetzner')).toBe(false);
      expect(isCleanupTarget('Zurich')).toBe(false);
      expect(isCleanupTarget('GDPR')).toBe(false);
    });

    it('keeps multi-word phrases that contain stopwords', () => {
      // We only reject SINGLE-word stopwords. "Personal Access Token" must survive.
      expect(isCleanupTarget('Personal Access Token')).toBe(false);
      expect(isCleanupTarget('GitHub Tools')).toBe(false);
      expect(isCleanupTarget('Project Apollo')).toBe(false);
    });

    it('keeps real org/repo slash patterns', () => {
      expect(isCleanupTarget('lynox-ai/lynox')).toBe(false);
      expect(isCleanupTarget('vercel/next.js')).toBe(false);
      expect(isCleanupTarget('foo-bar/baz-qux')).toBe(false);
    });

    it('does not over-match numeric-only or compound names', () => {
      expect(isCleanupTarget('39')).toBe(false); // bare number — no slash → keep
      expect(isCleanupTarget('v1.2.3')).toBe(false);
      expect(isCleanupTarget('Q4 2026')).toBe(false);
    });
  });

  describe('cleanupBadEntities', () => {
    let tempDir: string;
    let db: AgentMemoryDb;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'lynox-kg-cleanup-test-'));
      db = new AgentMemoryDb(join(tempDir, 'test.db'));
      db.setEmbeddingDimensions(3);
    });

    afterEach(async () => {
      db.close();
      await rm(tempDir, { recursive: true, force: true });
    });

    it('purges bad entities and keeps good ones', () => {
      // Bad — should be removed
      db.createEntity({ canonicalName: 'in', entityType: 'person', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: 'tools', entityType: 'location', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: '39/mo', entityType: 'project', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: 'CHF 39/mo', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: 'create/update', entityType: 'project', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: 'sync', entityType: 'person', scopeType: 'global', scopeId: 'g' });
      // Good — should survive
      db.createEntity({ canonicalName: 'Peter Huber', entityType: 'person', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: 'Personal Access Token', entityType: 'concept', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: 'Hetzner', entityType: 'organization', scopeType: 'global', scopeId: 'g' });

      expect(db.getEntityCount()).toBe(9);

      const result = cleanupBadEntities(db);

      expect(result.scanned).toBe(9);
      expect(result.matched).toBe(6);
      expect(result.purged).toBe(6);
      expect(db.getEntityCount()).toBe(3);

      // Verify the good ones survived by name
      expect(db.findEntityByCanonicalName('peter huber')).not.toBeNull();
      expect(db.findEntityByCanonicalName('personal access token')).not.toBeNull();
      expect(db.findEntityByCanonicalName('hetzner')).not.toBeNull();
    });

    it('dryRun reports matches without deleting', () => {
      db.createEntity({ canonicalName: 'in', entityType: 'person', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: '99/mo', entityType: 'project', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: 'Hetzner', entityType: 'organization', scopeType: 'global', scopeId: 'g' });

      const result = cleanupBadEntities(db, { dryRun: true });

      expect(result.scanned).toBe(3);
      expect(result.matched).toBe(2);
      expect(result.purged).toBe(0);
      expect(db.getEntityCount()).toBe(3); // nothing deleted
      expect(result.sample.map(s => s.name).sort()).toEqual(['99/mo', 'in']);
    });

    it('is idempotent: second run finds nothing to purge', () => {
      db.createEntity({ canonicalName: 'in', entityType: 'person', scopeType: 'global', scopeId: 'g' });
      db.createEntity({ canonicalName: 'Hetzner', entityType: 'organization', scopeType: 'global', scopeId: 'g' });

      const first = cleanupBadEntities(db);
      expect(first.purged).toBe(1);

      const second = cleanupBadEntities(db);
      expect(second.scanned).toBe(1);
      expect(second.matched).toBe(0);
      expect(second.purged).toBe(0);
    });

    it('handles empty db gracefully', () => {
      const result = cleanupBadEntities(db);
      expect(result).toEqual({ scanned: 0, matched: 0, purged: 0, sample: [] });
    });

    it('caps the sample at 20 even when matches exceed that', () => {
      for (let i = 0; i < 30; i++) {
        db.createEntity({ canonicalName: `${i}/mo`, entityType: 'project', scopeType: 'global', scopeId: 'g' });
      }
      const result = cleanupBadEntities(db, { dryRun: true });
      expect(result.matched).toBe(30);
      expect(result.sample.length).toBe(20);
    });
  });
});
