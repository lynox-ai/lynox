import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ApiStore } from './api-store.js';
import type { ApiProfile } from './api-store.js';

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'nodyn-api-store-test-'));
}

const SAMPLE_PROFILE: ApiProfile = {
  id: 'test-api',
  name: 'Test API',
  base_url: 'https://api.test.com/v1',
  description: 'A test API for unit testing.',
  auth: { type: 'bearer' },
  rate_limit: { requests_per_second: 5, requests_per_minute: 100 },
  endpoints: [
    { method: 'POST', path: '/search', description: 'Search for items' },
    { method: 'GET', path: '/items/{id}', description: 'Get item by ID' },
  ],
  guidelines: ['Always use JSON body', 'Include pagination params'],
  avoid: ['Do not use GET for mutations', 'Do not exceed 50 items per request'],
  notes: ['Responses are paginated', 'Rate limit resets every minute'],
};

describe('ApiStore', () => {
  let store: ApiStore;

  beforeEach(() => {
    store = new ApiStore();
  });

  describe('register', () => {
    it('registers a profile and retrieves by id', () => {
      store.register(SAMPLE_PROFILE);
      expect(store.size).toBe(1);
      expect(store.get('test-api')).toEqual(SAMPLE_PROFILE);
    });

    it('retrieves by hostname', () => {
      store.register(SAMPLE_PROFILE);
      const found = store.getByHostname('api.test.com');
      expect(found).toEqual(SAMPLE_PROFILE);
    });

    it('returns undefined for unknown id', () => {
      expect(store.get('nope')).toBeUndefined();
    });

    it('returns undefined for unknown hostname', () => {
      expect(store.getByHostname('unknown.com')).toBeUndefined();
    });
  });

  describe('loadFromDirectory', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = createTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('loads profiles from directory', () => {
      writeFileSync(join(tmpDir, 'test.json'), JSON.stringify(SAMPLE_PROFILE));
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(1);
      expect(store.get('test-api')).toBeDefined();
    });

    it('skips non-json files', () => {
      writeFileSync(join(tmpDir, 'readme.txt'), 'not a profile');
      writeFileSync(join(tmpDir, 'test.json'), JSON.stringify(SAMPLE_PROFILE));
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(1);
    });

    it('skips profiles with missing required fields', () => {
      writeFileSync(join(tmpDir, 'bad.json'), JSON.stringify({ id: 'bad' }));
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(0);
    });

    it('skips invalid JSON', () => {
      writeFileSync(join(tmpDir, 'broken.json'), '{bad json');
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(0);
    });

    it('returns 0 for nonexistent directory', () => {
      const loaded = store.loadFromDirectory('/tmp/nonexistent-dir-abc123');
      expect(loaded).toBe(0);
    });

    it('loads multiple profiles', () => {
      const profile2: ApiProfile = { ...SAMPLE_PROFILE, id: 'second-api', name: 'Second', base_url: 'https://api2.test.com' };
      writeFileSync(join(tmpDir, 'first.json'), JSON.stringify(SAMPLE_PROFILE));
      writeFileSync(join(tmpDir, 'second.json'), JSON.stringify(profile2));
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(2);
      expect(store.size).toBe(2);
    });
  });

  describe('rate limiting', () => {
    it('allows requests under limit', () => {
      store.register(SAMPLE_PROFILE); // 5/s, 100/min
      const result = store.checkRateLimit('api.test.com');
      expect(result).toBeNull();
    });

    it('blocks after exceeding per-second limit', () => {
      store.register({ ...SAMPLE_PROFILE, rate_limit: { requests_per_second: 2 } });
      expect(store.checkRateLimit('api.test.com')).toBeNull(); // 1
      expect(store.checkRateLimit('api.test.com')).toBeNull(); // 2
      const blocked = store.checkRateLimit('api.test.com');     // 3 → blocked
      expect(blocked).toBeTruthy();
      expect(blocked).toContain('rate limit');
      expect(blocked).toContain('api.test.com');
    });

    it('returns null for unknown hosts', () => {
      store.register(SAMPLE_PROFILE);
      expect(store.checkRateLimit('unknown.com')).toBeNull();
    });

    it('does not rate limit profiles without limits', () => {
      store.register({ ...SAMPLE_PROFILE, rate_limit: undefined });
      expect(store.checkRateLimit('api.test.com')).toBeNull();
      expect(store.checkRateLimit('api.test.com')).toBeNull();
      expect(store.checkRateLimit('api.test.com')).toBeNull();
    });
  });

  describe('formatForSystemPrompt', () => {
    it('returns empty string when no profiles', () => {
      expect(store.formatForSystemPrompt()).toBe('');
    });

    it('includes profile name and description', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).toContain('Test API');
      expect(output).toContain('A test API for unit testing.');
      expect(output).toContain('api.test.com');
    });

    it('includes endpoints', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).toContain('POST /search');
      expect(output).toContain('GET /items/{id}');
    });

    it('includes guidelines', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).toContain('Always use JSON body');
      expect(output).toContain('Include pagination params');
    });

    it('includes avoid section', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).toContain('Do not use GET for mutations');
    });

    it('includes rate limit info', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).toContain('5/s');
      expect(output).toContain('100/min');
    });

    it('includes auth type', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).toContain('Bearer Token');
    });

    it('wraps in api_profiles tags', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).toContain('<api_profiles>');
      expect(output).toContain('</api_profiles>');
    });
  });

  describe('getAll', () => {
    it('returns all profiles', () => {
      store.register(SAMPLE_PROFILE);
      store.register({ ...SAMPLE_PROFILE, id: 'other', base_url: 'https://other.com' });
      expect(store.getAll()).toHaveLength(2);
    });
  });
});
