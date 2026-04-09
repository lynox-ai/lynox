import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { apiSetupTool } from './api-setup.js';
import { ApiStore } from '../../core/api-store.js';
import type { ApiProfile } from '../../core/api-store.js';

// Mock getLynoxDir to use temp dir
let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({
  getLynoxDir: () => mockLynoxDir,
}));

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lynox-api-setup-test-'));
}

const SAMPLE_PROFILE: ApiProfile = {
  id: 'test-api',
  name: 'Test API',
  base_url: 'https://api.test.com/v1',
  description: 'A test API.',
  auth: { type: 'bearer' },
  rate_limit: { requests_per_minute: 60 },
  endpoints: [
    { method: 'POST', path: '/search', description: 'Search items' },
  ],
  guidelines: ['Always POST'],
  avoid: ['No GET for mutations'],
};

function createMockAgent(apiStore?: ApiStore | null) {
  return {
    toolContext: {
      apiStore: apiStore ?? null,
      dataStore: null,
      taskManager: null,
      knowledgeLayer: null,
      runHistory: null,
      userConfig: {},
      tools: [],
      streamHandler: null,
      networkPolicy: undefined,
      allowedHosts: undefined,
      allowedWildcards: [],
      rateLimitProvider: null,
      hourlyRateLimit: Infinity,
      dailyRateLimit: Infinity,
      isolationEnvOverride: undefined,
      isolationMinimalEnv: false,
    },
  } as never;
}

describe('api_setup tool', () => {
  beforeEach(() => {
    mockLynoxDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(mockLynoxDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a profile file', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        { action: 'create', profile: SAMPLE_PROFILE },
        agent,
      );
      expect(result).toContain('Created API profile');
      expect(result).toContain('test-api');

      const filePath = join(mockLynoxDir, 'apis', 'test-api.json');
      expect(existsSync(filePath)).toBe(true);

      const saved = JSON.parse(readFileSync(filePath, 'utf-8')) as ApiProfile;
      expect(saved.id).toBe('test-api');
      expect(saved.name).toBe('Test API');
    });

    it('hot-reloads into ApiStore', async () => {
      const store = new ApiStore();
      const agent = createMockAgent(store);
      await apiSetupTool.handler({ action: 'create', profile: SAMPLE_PROFILE }, agent);
      expect(store.get('test-api')).toBeDefined();
      expect(store.getByHostname('api.test.com')).toBeDefined();
    });

    it('rejects missing required fields', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        { action: 'create', profile: { id: 'x', name: '', base_url: '', description: '' } as ApiProfile },
        agent,
      );
      expect(result).toContain('Validation error');
      expect(result).toContain('Missing required field');
    });

    it('rejects invalid id', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        { action: 'create', profile: { ...SAMPLE_PROFILE, id: 'INVALID ID!' } },
        agent,
      );
      expect(result).toContain('Invalid id');
    });

    it('rejects invalid base_url', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        { action: 'create', profile: { ...SAMPLE_PROFILE, base_url: 'not-a-url' } },
        agent,
      );
      expect(result).toContain('Invalid base_url');
    });

    it('rejects invalid auth type', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        { action: 'create', profile: { ...SAMPLE_PROFILE, auth: { type: 'oauth' as 'bearer' } } },
        agent,
      );
      expect(result).toContain('Invalid auth type');
    });

    it('requires profile object', async () => {
      const agent = createMockAgent();
      const result = await apiSetupTool.handler({ action: 'create' }, agent);
      expect(result).toContain('required');
    });
  });

  describe('update', () => {
    it('overwrites existing profile', async () => {
      const store = new ApiStore();
      const agent = createMockAgent(store);
      await apiSetupTool.handler({ action: 'create', profile: SAMPLE_PROFILE }, agent);

      const updated = { ...SAMPLE_PROFILE, name: 'Updated API' };
      const result = await apiSetupTool.handler({ action: 'update', profile: updated }, agent);
      expect(result).toContain('Updated API profile');

      const saved = JSON.parse(readFileSync(join(mockLynoxDir, 'apis', 'test-api.json'), 'utf-8')) as ApiProfile;
      expect(saved.name).toBe('Updated API');
    });
  });

  describe('delete', () => {
    it('deletes an existing profile', async () => {
      const agent = createMockAgent(new ApiStore());
      await apiSetupTool.handler({ action: 'create', profile: SAMPLE_PROFILE }, agent);
      const filePath = join(mockLynoxDir, 'apis', 'test-api.json');
      expect(existsSync(filePath)).toBe(true);

      const result = await apiSetupTool.handler({ action: 'delete', id: 'test-api' }, agent);
      expect(result).toContain('Deleted');
      expect(existsSync(filePath)).toBe(false);
    });

    it('reports missing profile', async () => {
      const agent = createMockAgent();
      const result = await apiSetupTool.handler({ action: 'delete', id: 'nope' }, agent);
      expect(result).toContain('not found');
    });

    it('requires id', async () => {
      const agent = createMockAgent();
      const result = await apiSetupTool.handler({ action: 'delete' }, agent);
      expect(result).toContain('required');
    });
  });

  describe('list', () => {
    it('shows empty message when no profiles', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler({ action: 'list' }, agent);
      expect(result).toContain('No API profiles');
    });

    it('lists registered profiles', async () => {
      const store = new ApiStore();
      store.register(SAMPLE_PROFILE);
      const agent = createMockAgent(store);
      const result = await apiSetupTool.handler({ action: 'list' }, agent);
      expect(result).toContain('test-api');
      expect(result).toContain('Test API');
    });
  });
});
