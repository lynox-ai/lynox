import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchIndex } from './batch-index.js';
import type { BatchEntry } from './batch-index.js';

describe('BatchIndex', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nodyn-batch-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const entry: BatchEntry = {
    submitted_at: '2025-01-01T00:00:00Z',
    request_count: 5,
    label: 'test batch',
  };

  describe('load', () => {
    it('returns empty object when file does not exist', async () => {
      const index = new BatchIndex(dir);
      const data = await index.load();
      expect(data).toEqual({});
    });

    it('parses existing file', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dir, 'batch-index.json'), JSON.stringify({ id1: entry }));
      const index = new BatchIndex(dir);
      const data = await index.load();
      expect(data['id1']).toEqual(entry);
    });

    it('caches after first load', async () => {
      const index = new BatchIndex(dir);
      const data1 = await index.load();
      const data2 = await index.load();
      expect(data1).toEqual(data2);
    });
  });

  describe('save', () => {
    it('creates file and persists entry', async () => {
      const index = new BatchIndex(dir);
      await index.save('batch-1', entry);

      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(join(dir, 'batch-index.json'), 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, BatchEntry>;
      expect(parsed['batch-1']).toEqual(entry);
    });

    it('appends new entries without removing existing', async () => {
      const index = new BatchIndex(dir);
      await index.save('a', entry);
      await index.save('b', { ...entry, label: 'second' });

      const data = await index.load();
      expect(data['a']).toBeDefined();
      expect(data['b']).toBeDefined();
    });

    it('overwrites entry with same id', async () => {
      const index = new BatchIndex(dir);
      await index.save('x', entry);
      const updated = { ...entry, label: 'updated' };
      await index.save('x', updated);

      const data = await index.load();
      expect(data['x']?.label).toBe('updated');
    });
  });

  describe('get', () => {
    it('returns null for unknown id', async () => {
      const index = new BatchIndex(dir);
      expect(await index.get('unknown')).toBeNull();
    });

    it('returns entry after save', async () => {
      const index = new BatchIndex(dir);
      await index.save('found', entry);
      const result = await index.get('found');
      expect(result).toEqual(entry);
    });
  });
});
