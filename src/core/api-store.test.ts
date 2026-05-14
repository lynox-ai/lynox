import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ApiStore } from './api-store.js';
import type { ApiProfile } from './api-store.js';

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lynox-api-store-test-'));
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

    it('includes compact profile summary', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).toContain('Test API');
      expect(output).toContain('A test API for unit testing.');
      expect(output).toContain('api.test.com');
      expect(output).toContain('[bearer]');
      expect(output).toContain('2 endpoints');
    });

    it('does not include full details in summary', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).not.toContain('POST /search');
      expect(output).not.toContain('Always use JSON body');
      expect(output).not.toContain('Do not use GET for mutations');
    });

    it('wraps in api_profiles tags', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).toContain('<api_profiles>');
      expect(output).toContain('</api_profiles>');
    });

    it('formatProfile returns full details', () => {
      store.register(SAMPLE_PROFILE);
      const profile = store.get('test-api')!;
      const output = store.formatProfile(profile);
      expect(output).toContain('POST /search');
      expect(output).toContain('GET /items/{id}');
      expect(output).toContain('Always use JSON body');
      expect(output).toContain('Include pagination params');
      expect(output).toContain('Do not use GET for mutations');
      expect(output).toContain('5/s');
      expect(output).toContain('100/min');
      expect(output).toContain('Bearer Token');
    });
  });

  describe('getAll', () => {
    it('returns all profiles', () => {
      store.register(SAMPLE_PROFILE);
      store.register({ ...SAMPLE_PROFILE, id: 'other', base_url: 'https://other.com' });
      expect(store.getAll()).toHaveLength(2);
    });
  });

  describe('v2 schema migration', () => {
    let tmpDir: string;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      tmpDir = createTmpDir();
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });
    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      stderrSpy.mockRestore();
    });

    it('injects {parallel_ok: true} default for v1 profiles and emits migration log', () => {
      writeFileSync(join(tmpDir, 'legacy.json'), JSON.stringify(SAMPLE_PROFILE));
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(1);
      const profile = store.get('test-api');
      expect(profile?.concurrency).toEqual({ parallel_ok: true });
      expect(profile?.output_volume).toBeUndefined();

      const logs = stderrSpy.mock.calls.flat().filter((s): s is string => typeof s === 'string');
      expect(logs.some(s => s.includes('profile "test-api" is v1'))).toBe(true);
    });

    it('does not migrate or log when profile is already v2', () => {
      const v2Profile: ApiProfile = {
        ...SAMPLE_PROFILE,
        id: 'v2-api',
        concurrency: { parallel_ok: false, max_in_flight: 1 },
        output_volume: 'large',
        cost: { model: 'per_call', rate_usd: 0.0006 },
        provenance: { source: 'manual', schema_version: 2 },
      };
      writeFileSync(join(tmpDir, 'v2.json'), JSON.stringify(v2Profile));
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(1);

      const profile = store.get('v2-api');
      expect(profile?.concurrency?.parallel_ok).toBe(false);
      expect(profile?.concurrency?.max_in_flight).toBe(1);
      expect(profile?.output_volume).toBe('large');
      expect(profile?.cost?.rate_usd).toBe(0.0006);
      expect(profile?.provenance?.schema_version).toBe(2);

      const logs = stderrSpy.mock.calls.flat().filter((s): s is string => typeof s === 'string');
      expect(logs.some(s => s.includes('is v1'))).toBe(false);
    });

    it('preserves explicit v1 concurrency override even without provenance', () => {
      const profileWithConcurrency: ApiProfile = {
        ...SAMPLE_PROFILE,
        id: 'pinned',
        concurrency: { parallel_ok: false },
      };
      writeFileSync(join(tmpDir, 'pinned.json'), JSON.stringify(profileWithConcurrency));
      store.loadFromDirectory(tmpDir);

      const profile = store.get('pinned');
      expect(profile?.concurrency?.parallel_ok).toBe(false);
    });

    it('loads the reference DataForSEO v2 profile from examples/', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const refPath = resolve(here, '../../examples/api-profiles/dataforseo.v2.json');
      const raw = readFileSync(refPath, 'utf-8');
      const profile = JSON.parse(raw) as ApiProfile;

      writeFileSync(join(tmpDir, 'dataforseo.json'), raw);
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(1);

      expect(profile.concurrency?.parallel_ok).toBe(false);
      expect(profile.auth?.type).toBe('basic');
      expect(profile.auth?.basic_format).toBe('pre_encoded_b64');
      expect(profile.cost?.model).toBe('per_call');
      expect(profile.output_volume).toBe('large');
      expect(profile.provenance?.schema_version).toBe(2);

      const logs = stderrSpy.mock.calls.flat().filter((s): s is string => typeof s === 'string');
      expect(logs.some(s => s.includes('is v1'))).toBe(false);
    });
  });

  describe('formatProfile v2 fields', () => {
    it('renders concurrency, output_volume, cost, provenance, vault_keys, basic_format', () => {
      const p: ApiProfile = {
        ...SAMPLE_PROFILE,
        id: 'rendered',
        auth: {
          type: 'basic',
          basic_format: 'pre_encoded_b64',
          vault_keys: ['DATAFORSEO_TOKEN'],
        },
        concurrency: { parallel_ok: false, max_in_flight: 1, batchable_via_endpoint: '/v3/batch' },
        output_volume: 'large',
        cost: { model: 'per_call', rate_usd: 0.0006 },
        provenance: {
          source: 'manual',
          source_url: 'https://docs.example.com',
          validated_at: '2026-05-14T22:30:00Z',
          schema_version: 2,
        },
      };
      store.register(p);
      const out = store.formatProfile(store.get('rendered')!);
      expect(out).toContain('pre-encoded Base64');
      expect(out).toContain('DATAFORSEO_TOKEN');
      expect(out).toContain('parallel_ok=false');
      expect(out).toContain('max_in_flight: 1');
      expect(out).toContain('batchable_via_endpoint: /v3/batch');
      expect(out).toContain('Output volume: large');
      expect(out).toContain('Cost: per_call @ $0.0006');
      expect(out).toContain('source=manual');
      expect(out).toContain('schema_version=2');
    });

    it('renders oauth2 auth label without leaking vault_keys when absent', () => {
      const p: ApiProfile = {
        ...SAMPLE_PROFILE,
        id: 'oauth-render',
        auth: { type: 'oauth2', vault_keys: ['GOOGLE_REFRESH_TOKEN'] },
      };
      store.register(p);
      const out = store.formatProfile(store.get('oauth-render')!);
      expect(out).toContain('OAuth2');
      expect(out).toContain('GOOGLE_REFRESH_TOKEN');
    });
  });
});
