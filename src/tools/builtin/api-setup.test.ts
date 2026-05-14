import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { apiSetupTool } from './api-setup.js';
import { ApiStore } from '../../core/api-store.js';
import type { ApiProfile } from '../../core/api-store.js';
import * as llmHelper from '../../core/llm-helper.js';

// Mock getLynoxDir to use temp dir
let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({
  getLynoxDir: () => mockLynoxDir,
}));

// Partial-mock the llm-helper module so docs_url bootstrap tests can stub
// `callForStructuredJson` while keeping the real BudgetError class for
// instanceof checks.
vi.mock('../../core/llm-helper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/llm-helper.js')>();
  return {
    ...actual,
    callForStructuredJson: vi.fn(),
  };
});

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
      expect(result).toContain('Invalid auth.type');
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

    it('honors network deny-all from ToolContext (no agent escape)', async () => {
      // Regression: before this PR, fetchWithValidatedRedirects was called
      // without the agent's ToolContext, so air-gapped engines could still
      // pull arbitrary OpenAPI specs via api_setup. Now ctx is threaded.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('fetch should never be invoked when network is denied'),
      );
      try {
        const agent = createMockAgent(new ApiStore()) as unknown as {
          toolContext: { networkPolicy: 'deny-all' };
        };
        agent.toolContext.networkPolicy = 'deny-all';
        const result = await apiSetupTool.handler(
          { action: 'bootstrap', openapi_url: 'https://api.fake.com/openapi.json' },
          agent as never,
        );
        expect(result.toLowerCase()).toMatch(/network|air-gapped|denied|blocked/);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('create — v2 schema validation', () => {
    function withV2(overrides: Partial<ApiProfile>): ApiProfile {
      return { ...SAMPLE_PROFILE, ...overrides };
    }

    it('accepts a fully-populated v2 profile', async () => {
      const store = new ApiStore();
      const agent = createMockAgent(store);
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({
            concurrency: { parallel_ok: false, max_in_flight: 1 },
            output_volume: 'large',
            cost: { model: 'per_call', rate_usd: 0.0006 },
            provenance: { source: 'manual', schema_version: 2 },
          }),
        },
        agent,
      );
      expect(result).toContain('Created API profile');
      expect(store.get('test-api')?.cost?.rate_usd).toBe(0.0006);
    });

    it('rejects oauth2 without vault_keys', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({ auth: { type: 'oauth2' } }),
        },
        agent,
      );
      expect(result).toContain('auth.vault_keys is required for auth.type="oauth2"');
    });

    it('accepts oauth2 with vault_keys', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({ auth: { type: 'oauth2', vault_keys: ['GOOGLE_REFRESH_TOKEN'] } }),
        },
        agent,
      );
      expect(result).toContain('Created API profile');
    });

    it('rejects invalid auth.basic_format', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({
            auth: { type: 'basic', basic_format: 'hex' as 'pre_encoded_b64' },
          }),
        },
        agent,
      );
      expect(result).toContain('Invalid auth.basic_format');
    });

    it('rejects non-boolean concurrency.parallel_ok', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({
            concurrency: { parallel_ok: 'yes' as unknown as boolean },
          }),
        },
        agent,
      );
      expect(result).toContain('concurrency.parallel_ok');
    });

    it('rejects negative concurrency.max_in_flight', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({
            concurrency: { parallel_ok: true, max_in_flight: -1 },
          }),
        },
        agent,
      );
      expect(result).toContain('concurrency.max_in_flight');
    });

    it('rejects non-integer concurrency.max_in_flight', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({
            concurrency: { parallel_ok: true, max_in_flight: 1.5 },
          }),
        },
        agent,
      );
      expect(result).toContain('concurrency.max_in_flight');
    });

    it('rejects unknown output_volume', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({ output_volume: 'huge' as 'large' }),
        },
        agent,
      );
      expect(result).toContain('output_volume');
    });

    it('rejects unknown cost.model', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({
            cost: { model: 'per_sneeze' as 'per_call', rate_usd: 0.01 },
          }),
        },
        agent,
      );
      expect(result).toContain('cost.model');
    });

    it('accepts cost.rate_usd: 0 (free-tier API)', async () => {
      const store = new ApiStore();
      const agent = createMockAgent(store);
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({
            id: 'free-tier',
            cost: { model: 'per_call', rate_usd: 0 },
          }),
        },
        agent,
      );
      expect(result).toContain('Created API profile');
      expect(store.get('free-tier')?.cost?.rate_usd).toBe(0);
    });

    it('rejects negative cost.rate_usd', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({
            cost: { model: 'per_call', rate_usd: -0.01 },
          }),
        },
        agent,
      );
      expect(result).toContain('cost.rate_usd');
    });

    it('rejects non-positive cost.output_ratio', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({
            cost: { model: 'per_token', rate_usd: 0.001, output_ratio: 0 },
          }),
        },
        agent,
      );
      expect(result).toContain('cost.output_ratio');
    });

    it('rejects unknown provenance.source', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({
            provenance: { source: 'scraped' as 'manual', schema_version: 2 },
          }),
        },
        agent,
      );
      expect(result).toContain('provenance.source');
    });

    it('rejects wrong provenance.schema_version', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        {
          action: 'create',
          profile: withV2({
            provenance: { source: 'manual', schema_version: 3 as 2 },
          }),
        },
        agent,
      );
      expect(result).toContain('schema_version');
    });
  });

  describe('bootstrap — docs_url path (Phase B)', () => {
    const ORIGINAL_FLAG = process.env.LYNOX_FEATURE_API_SETUP_V2;
    const mockedExtract = vi.mocked(llmHelper.callForStructuredJson);

    beforeEach(() => {
      process.env.LYNOX_FEATURE_API_SETUP_V2 = '1';
      mockedExtract.mockReset();
    });

    afterEach(() => {
      if (ORIGINAL_FLAG === undefined) delete process.env.LYNOX_FEATURE_API_SETUP_V2;
      else process.env.LYNOX_FEATURE_API_SETUP_V2 = ORIGINAL_FLAG;
    });

    function mockFetchOk(body: string): ReturnType<typeof vi.spyOn> {
      return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(body, { status: 200, statusText: 'OK', headers: { 'content-type': 'text/html' } }),
      );
    }

    function stubExtraction(data: Record<string, unknown>, costUsd = 0.001): void {
      mockedExtract.mockResolvedValue({ data, inputTokens: 1000, outputTokens: 200, costUsd });
    }

    it('returns a draft v2 profile from a DataForSEO-style docs page', async () => {
      const fetchSpy = mockFetchOk('<html>DataForSEO docs body...</html>');
      stubExtraction({
        description: 'REST API for SEO data (SERP, keyword volume, backlinks)',
        auth: { type: 'basic', basic_format: 'pre_encoded_b64', instructions: 'Base64 login:password' },
        rate_limit: { requests_per_second: 2 },
        concurrency: { parallel_ok: false },
        output_volume: 'large',
        cost: { model: 'per_call', rate_usd: 0.0006 },
        notes: ['Docs say: "no parallel requests per account"'],
      });

      try {
        const agent = createMockAgent(new ApiStore());
        const result = await apiSetupTool.handler(
          { action: 'bootstrap', docs_url: 'https://docs.dataforseo.com/v3/' },
          agent,
        );
        expect(result).toContain('Bootstrapped draft profile');
        expect(result).toContain('"base_url": "https://docs.dataforseo.com"');
        expect(result).toContain('"parallel_ok": false');
        expect(result).toContain('"basic_format": "pre_encoded_b64"');
        expect(result).toContain('"model": "per_call"');
        expect(result).toContain('"output_volume": "large"');
        expect(result).toContain('"schema_version": 2');
        expect(result).not.toContain('"vault_keys"');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('produces parallel_ok=true / output_volume=streaming for an Anthropic-style docs page', async () => {
      const fetchSpy = mockFetchOk('<html>Anthropic docs...</html>');
      stubExtraction({
        description: 'Anthropic Messages API',
        auth: { type: 'bearer' },
        concurrency: { parallel_ok: true, max_in_flight: 10 },
        output_volume: 'streaming',
        cost: { model: 'per_token', rate_usd: 0.0000008 },
      });

      try {
        const agent = createMockAgent(new ApiStore());
        const result = await apiSetupTool.handler(
          { action: 'bootstrap', docs_url: 'https://docs.anthropic.com/en/api/messages' },
          agent,
        );
        expect(result).toContain('"parallel_ok": true');
        expect(result).toContain('"max_in_flight": 10');
        expect(result).toContain('"output_volume": "streaming"');
        expect(result).toContain('"model": "per_token"');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('drops attacker-injected vault_keys / id / name / base_url and surfaces a security note', async () => {
      const fetchSpy = mockFetchOk('<html>Attacker docs page...</html>');
      stubExtraction({
        description: 'Innocent-looking API',
        auth: { type: 'bearer', vault_keys: ['LYNOX_ADMIN_TOKEN'] },
        id: 'attacker-controlled-id',
        name: 'Attacker Name',
        base_url: 'https://evil.example.com',
        concurrency: { parallel_ok: true },
      });

      try {
        const agent = createMockAgent(new ApiStore());
        const result = await apiSetupTool.handler(
          { action: 'bootstrap', docs_url: 'https://api.legitimate.com/docs' },
          agent,
        );
        expect(result).toContain('"base_url": "https://api.legitimate.com"');
        expect(result).not.toContain('LYNOX_ADMIN_TOKEN');
        expect(result).not.toContain('evil.example.com');
        expect(result).not.toContain('attacker-controlled-id');
        expect(result).toContain('Security note: dropped');
        expect(result).toContain('auth.vault_keys');
        expect(result).toContain('base_url');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('flags truncation in notes when the docs body exceeds 250 KB', async () => {
      const bigBody = 'x'.repeat(300 * 1024);
      const fetchSpy = mockFetchOk(bigBody);
      stubExtraction({
        description: 'A big API',
        auth: { type: 'bearer' },
      });

      try {
        const agent = createMockAgent(new ApiStore());
        const result = await apiSetupTool.handler(
          { action: 'bootstrap', docs_url: 'https://docs.huge.example.com' },
          agent,
        );
        expect(result).toContain('Docs body was truncated');
        expect(result).toMatch(/exceeded \d+ bytes and was truncated/);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('returns a feature-flag error when api-setup-v2 is off', async () => {
      delete process.env.LYNOX_FEATURE_API_SETUP_V2;
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler(
        { action: 'bootstrap', docs_url: 'https://docs.dataforseo.com/v3/' },
        agent,
      );
      expect(result).toContain('feature flag');
      expect(result).toContain('api-setup-v2');
    });

    it('surfaces a clear error when the docs page returns 404', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('', { status: 404, statusText: 'Not Found' }),
      );
      try {
        const agent = createMockAgent(new ApiStore());
        const result = await apiSetupTool.handler(
          { action: 'bootstrap', docs_url: 'https://docs.example.com/missing' },
          agent,
        );
        expect(result).toContain('failed to fetch docs page');
        expect(result).toContain('404');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('surfaces a budget-exceeded error from the extractor', async () => {
      const fetchSpy = mockFetchOk('<html>some docs</html>');
      mockedExtract.mockRejectedValueOnce(
        new llmHelper.BudgetError('Input estimate 200000 tokens exceeds maxInputTokens=100000', {
          estimatedInputTokens: 200_000,
          estimatedCostUsd: 0.20,
        }),
      );

      try {
        const agent = createMockAgent(new ApiStore());
        const result = await apiSetupTool.handler(
          { action: 'bootstrap', docs_url: 'https://docs.huge.example.com' },
          agent,
        );
        expect(result).toContain('extraction budget exceeded');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('requires docs_url OR openapi_url for the bootstrap action', async () => {
      const agent = createMockAgent(new ApiStore());
      const result = await apiSetupTool.handler({ action: 'bootstrap' }, agent);
      expect(result).toContain('docs_url');
      expect(result).toContain('openapi_url');
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
