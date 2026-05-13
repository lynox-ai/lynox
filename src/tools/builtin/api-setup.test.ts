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

  describe('bootstrap', () => {
    const FAKE_OPENAPI = {
      openapi: '3.0.1',
      info: { title: 'Fake API', description: 'A fake API for testing.' },
      servers: [{ url: 'https://api.fake.com/v1' }],
      paths: {
        '/users': {
          get: { summary: 'List users' },
          post: { summary: 'Create user' },
        },
        '/users/{id}': {
          get: { summary: 'Get user by id' },
          delete: { summary: 'Delete user' },
        },
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'Use a bearer token.' },
        },
      },
    };

    it('requires openapi_url', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler({ action: 'bootstrap' }, agent);
      expect(result).toContain('openapi_url');
    });

    it('parses an OpenAPI 3.x spec into a draft profile', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(FAKE_OPENAPI), { status: 200, statusText: 'OK' }),
      );

      try {
        const agent = createMockAgent(new ApiStore());
        const result = await apiSetupTool.handler(
          { action: 'bootstrap', openapi_url: 'https://api.fake.com/openapi.json' },
          agent,
        );
        expect(result).toContain('Bootstrapped draft profile');
        expect(result).toContain('Fake API');
        expect(result).toContain('api.fake.com/v1');
        expect(result).toContain('auth: bearer');
        expect(result).toContain('endpoints: 4');
        // Draft JSON block present
        expect(result).toContain('```json');
        // Should not persist anything yet — file must not exist
        const filePath = join(mockLynoxDir, 'apis', 'fake-api.json');
        expect(existsSync(filePath)).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('rejects non-OpenAPI-3 specs', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ swagger: '2.0', info: { title: 'old' } }), {
          status: 200,
          statusText: 'OK',
        }),
      );

      try {
        const agent = createMockAgent(new ApiStore());
        const result = await apiSetupTool.handler(
          { action: 'bootstrap', openapi_url: 'https://example.com/swagger.json' },
          agent,
        );
        expect(result).toContain('unsupported spec version');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('reports a fetch failure', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('', { status: 404, statusText: 'Not Found' }),
      );

      try {
        const agent = createMockAgent(new ApiStore());
        const result = await apiSetupTool.handler(
          { action: 'bootstrap', openapi_url: 'https://example.com/missing.json' },
          agent,
        );
        expect(result).toContain('failed to fetch');
        expect(result).toContain('404');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('refuses to fetch a private-IP openapi_url (SSRF guard)', async () => {
      // No fetch mock — validateUrl must reject before any network call.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('fetch should never be invoked for a private-IP URL'),
      );
      try {
        const agent = createMockAgent(new ApiStore());
        const result = await apiSetupTool.handler(
          { action: 'bootstrap', openapi_url: 'http://169.254.169.254/latest/meta-data/' },
          agent,
        );
        expect(result.toLowerCase()).toMatch(/blocked|private ip/);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('refuses to follow a redirect to a private IP', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'http://10.0.0.1/spec.json' },
        }),
      );
      try {
        const agent = createMockAgent(new ApiStore());
        const result = await apiSetupTool.handler(
          { action: 'bootstrap', openapi_url: 'https://api.fake.com/openapi.json' },
          agent,
        );
        expect(result.toLowerCase()).toMatch(/blocked|private ip/);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('refine', () => {
    it('requires id and refine patch', async () => {
      const agent = createMockAgent(new ApiStore());
      const noId = await apiSetupTool.handler({ action: 'refine', refine: { addNotes: ['x'] } }, agent);
      expect(noId).toContain('id');
      const noPatch = await apiSetupTool.handler({ action: 'refine', id: 'test-api' }, agent);
      expect(noPatch).toContain('refine');
    });

    it('additively appends guidelines/avoid/notes', async () => {
      const store = new ApiStore();
      const agent = createMockAgent(store);
      await apiSetupTool.handler({ action: 'create', profile: SAMPLE_PROFILE }, agent);

      const result = await apiSetupTool.handler(
        {
          action: 'refine',
          id: 'test-api',
          refine: {
            addGuidelines: ['Always paginate with limit<=100'],
            addAvoid: ['No nested filters'],
            addNotes: ['Returns JSON:API envelope'],
          },
        },
        agent,
      );
      expect(result).toContain('+1 guidelines');
      expect(result).toContain('+1 avoid');
      expect(result).toContain('+1 notes');

      const saved = JSON.parse(
        readFileSync(join(mockLynoxDir, 'apis', 'test-api.json'), 'utf-8'),
      ) as ApiProfile;
      expect(saved.guidelines).toContain('Always POST');
      expect(saved.guidelines).toContain('Always paginate with limit<=100');
      expect(saved.avoid?.length).toBe(2);
    });

    it('merges new endpoints by method+path key', async () => {
      const store = new ApiStore();
      const agent = createMockAgent(store);
      await apiSetupTool.handler({ action: 'create', profile: SAMPLE_PROFILE }, agent);

      await apiSetupTool.handler(
        {
          action: 'refine',
          id: 'test-api',
          refine: {
            addEndpoints: [
              { method: 'POST', path: '/search', description: 'UPDATED search desc' },
              { method: 'GET', path: '/items', description: 'List items' },
            ],
          },
        },
        agent,
      );

      const saved = JSON.parse(
        readFileSync(join(mockLynoxDir, 'apis', 'test-api.json'), 'utf-8'),
      ) as ApiProfile;
      expect(saved.endpoints?.length).toBe(2);
      expect(saved.endpoints?.find(e => e.method === 'POST' && e.path === '/search')?.description).toBe(
        'UPDATED search desc',
      );
      expect(saved.endpoints?.find(e => e.path === '/items')).toBeDefined();
    });

    it('sets response_shape and round-trips it', async () => {
      const store = new ApiStore();
      const agent = createMockAgent(store);
      await apiSetupTool.handler({ action: 'create', profile: SAMPLE_PROFILE }, agent);

      await apiSetupTool.handler(
        {
          action: 'refine',
          id: 'test-api',
          refine: {
            response_shape: {
              kind: 'reduce',
              include: ['data[].id', 'data[].name'],
              max_array_items: 5,
            },
          },
        },
        agent,
      );

      const saved = JSON.parse(
        readFileSync(join(mockLynoxDir, 'apis', 'test-api.json'), 'utf-8'),
      ) as ApiProfile;
      expect(saved.response_shape?.kind).toBe('reduce');
      expect(saved.response_shape?.max_array_items).toBe(5);
      expect(saved.response_shape?.include).toEqual(['data[].id', 'data[].name']);
    });

    it('rejects invalid shape kind', async () => {
      const store = new ApiStore();
      const agent = createMockAgent(store);
      await apiSetupTool.handler({ action: 'create', profile: SAMPLE_PROFILE }, agent);
      const result = await apiSetupTool.handler(
        {
          action: 'refine',
          id: 'test-api',
          refine: {
            response_shape: { kind: 'project' as 'reduce' },
          },
        },
        agent,
      );
      expect(result).toContain('Invalid response_shape.kind');
    });

    it('rejects invalid reducer', async () => {
      const store = new ApiStore();
      const agent = createMockAgent(store);
      await apiSetupTool.handler({ action: 'create', profile: SAMPLE_PROFILE }, agent);
      const result = await apiSetupTool.handler(
        {
          action: 'refine',
          id: 'test-api',
          refine: {
            response_shape: {
              kind: 'reduce',
              reduce: { 'items': 'median' as 'avg' },
            },
          },
        },
        agent,
      );
      expect(result).toContain('Invalid reducer');
    });
  });
});
