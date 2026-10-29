import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// fetchWithValidatedRedirects resolves the host before it connects; a public address keeps the
// resolver out of the test (see api-setup.test.ts).
vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) },
}));

let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({ getLynoxDir: () => mockLynoxDir }));

vi.mock('../../core/llm-helper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/llm-helper.js')>();
  return { ...actual, callForStructuredJson: vi.fn() };
});

import { apiSetupTool } from './api-setup.js';
import { MAX_REQUESTS_PER_SESSION } from './http.js';
import { ApiStore } from '../../core/api-store.js';
import * as llmHelper from '../../core/llm-helper.js';
import { setPinnedTransportForTests } from '../../core/network-guard.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';
import { testAuditLog } from '../../../tests/helpers/audit-log.js';

/**
 * Row 1005: api_setup's own fetches (the docs page, its linked sections, the OpenAPI spec) charge
 * the conversation's request budget, which `http_request` shares. Each now asks the budget before
 * it goes out, so none goes out past the limit (ux U-051 for the texts).
 */
describe('api_setup and the request limit', () => {
  const ORIGINAL_FLAG = process.env.LYNOX_FEATURE_API_SETUP_V2;
  const mockedExtract = vi.mocked(llmHelper.callForStructuredJson);
  let restorePinnedTransport: (() => void) | undefined;

  const agentAt = (httpRequests: number): { sessionCounters: { httpRequests: number } } & Record<string, unknown> => {
    const apiStore = new ApiStore();
    return {
      principal: OWNER_PRINCIPAL,
      sessionCounters: { httpRequests },
      toolContext: {
        auditLog: testAuditLog().log, apiStore, vaultNameBindings: bindingsAsMigrated(apiStore),
        dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null, userConfig: {},
        tools: [], streamHandler: null, networkPolicy: undefined, allowedHosts: undefined,
        allowedWildcards: [], rateLimitProvider: null, hourlyRateLimit: Infinity, dailyRateLimit: Infinity,
        isolationEnvOverride: undefined, isolationMinimalEnv: false,
      },
    };
  };

  const LANDING = '<html><body><a href="/v3/rate-limits">Rate limits</a><a href="/v3/pricing">Pricing details</a></body></html>';
  const OPENAPI = { openapi: '3.0.1', info: { title: 'Fake API' }, servers: [{ url: 'https://api.fake.com/v1' }], paths: { '/users': { get: { summary: 'List users' } } } };

  function spyFetch(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://docs.example.com/api') return new Response(LANDING, { status: 200, headers: { 'content-type': 'text/html' } });
      if (url === 'https://api.fake.com/openapi.json') return new Response(JSON.stringify(OPENAPI), { status: 200 });
      return new Response(`SECTION ${url}`, { status: 200 });
    });
  }
  const fetched = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((c) => String(c[0]));

  const NOT_READ = `Some linked docs sections were not read: this conversation reached its limit of ${String(MAX_REQUESTS_PER_SESSION)} HTTP requests. The profile is built from the sections read so far and may miss endpoints. When you present it, tell the user that in one sentence.`;
  const blocked = (what: string): string => `Blocked: this conversation or run has reached its limit of ${String(MAX_REQUESTS_PER_SESSION)} HTTP requests (http_request); no further one goes out from it, so api_setup cannot fetch ${what}. Do not try to continue this work yourself. If a user is in this conversation, tell them in one sentence that the setup of this API could not start here and that they can start it in a new chat.`;

  beforeEach(() => {
    mockLynoxDir = mkdtempSync(join(tmpdir(), 'lynox-api-setup-limit-'));
    process.env.LYNOX_FEATURE_API_SETUP_V2 = '1';
    mockedExtract.mockReset();
    mockedExtract.mockResolvedValue({ data: { description: 'API', auth: { type: 'bearer' } }, inputTokens: 1, outputTokens: 1, costUsd: 0.001, model: 'claude-sonnet-4-6', tier: 'balanced' });
    restorePinnedTransport = setPinnedTransportForTests(async (input) => {
      const init: RequestInit = { method: input.method, headers: input.headers };
      if (input.signal) init.signal = input.signal;
      return (globalThis.fetch as typeof fetch)(input.url, init);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restorePinnedTransport?.();
    if (ORIGINAL_FLAG === undefined) delete process.env.LYNOX_FEATURE_API_SETUP_V2;
    else process.env.LYNOX_FEATURE_API_SETUP_V2 = ORIGINAL_FLAG;
    rmSync(mockLynoxDir, { recursive: true, force: true });
  });

  describe('docs_url', () => {
    it('fetches nothing at the limit, and says why', async () => {
      const spy = spyFetch();
      const agent = agentAt(MAX_REQUESTS_PER_SESSION);
      const result = await apiSetupTool.handler({ action: 'bootstrap', docs_url: 'https://docs.example.com/api' }, agent as never);
      expect(fetched(spy)).toEqual([]);
      expect(result).toBe(blocked('the docs page'));
      expect(agent.sessionCounters.httpRequests).toBe(MAX_REQUESTS_PER_SESSION);
    });

    it('below the limit, fetches the page and both sections, and says nothing about the limit', async () => {
      const spy = spyFetch();
      const agent = agentAt(MAX_REQUESTS_PER_SESSION - 3);
      const result = await apiSetupTool.handler({ action: 'bootstrap', docs_url: 'https://docs.example.com/api' }, agent as never);
      expect(fetched(spy)).toHaveLength(3);
      expect(result).toContain('Bootstrapped draft profile');
      expect(result).not.toContain('were not read');
      expect(agent.sessionCounters.httpRequests).toBe(MAX_REQUESTS_PER_SESSION);
    });
  });

  describe('linked sections', () => {
    it('reads no section once the page used the last request, and tells the model', async () => {
      const spy = spyFetch();
      const agent = agentAt(MAX_REQUESTS_PER_SESSION - 1);
      const result = await apiSetupTool.handler({ action: 'bootstrap', docs_url: 'https://docs.example.com/api' }, agent as never);
      expect(fetched(spy)).toEqual(['https://docs.example.com/api']);
      expect(result).toContain(NOT_READ);
      expect(agent.sessionCounters.httpRequests).toBe(MAX_REQUESTS_PER_SESSION);
    });

    it('stops after the section that used the last request', async () => {
      const spy = spyFetch();
      const agent = agentAt(MAX_REQUESTS_PER_SESSION - 2);
      const result = await apiSetupTool.handler({ action: 'bootstrap', docs_url: 'https://docs.example.com/api' }, agent as never);
      expect(fetched(spy)).toHaveLength(2);
      expect(result).toContain('Included 1 linked section(s)');
      expect(result).toContain(NOT_READ);
      expect(agent.sessionCounters.httpRequests).toBe(MAX_REQUESTS_PER_SESSION);
    });
  });

  describe('openapi_url', () => {
    it('fetches nothing at the limit, and says why', async () => {
      const spy = spyFetch();
      const agent = agentAt(MAX_REQUESTS_PER_SESSION);
      const result = await apiSetupTool.handler({ action: 'bootstrap', openapi_url: 'https://api.fake.com/openapi.json' }, agent as never);
      expect(fetched(spy)).toEqual([]);
      expect(result).toBe(blocked('the OpenAPI spec'));
    });

    it('below the limit, fetches the spec', async () => {
      const spy = spyFetch();
      const agent = agentAt(MAX_REQUESTS_PER_SESSION - 1);
      const result = await apiSetupTool.handler({ action: 'bootstrap', openapi_url: 'https://api.fake.com/openapi.json' }, agent as never);
      expect(fetched(spy)).toEqual(['https://api.fake.com/openapi.json']);
      expect(result).toContain('Bootstrapped draft profile');
      expect(agent.sessionCounters.httpRequests).toBe(MAX_REQUESTS_PER_SESSION);
    });
  });

  // A text check, so it is rough: it counts, it does not pair. A fifth fetch that only charges
  // the budget makes the counts differ until someone adds its check.
  it('every charge of the budget in api-setup.ts has a check', () => {
    const src = readFileSync(join(__dirname, 'api-setup.ts'), 'utf-8');
    const charges = src.match(/sessionCounters\.httpRequests\+\+/g) ?? [];
    const checks = src.match(/requestLimitReached\(agent\)/g) ?? [];
    expect(charges).toHaveLength(4);
    expect(checks).toHaveLength(charges.length);
  });
});
