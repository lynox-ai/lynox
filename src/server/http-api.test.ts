import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';

// === Mock dependencies ===

const mockSessionRun = vi.fn().mockResolvedValue('Agent response');
const mockSessionAbort = vi.fn();
const mockSessionReset = vi.fn();
const mockMemoryLoad = vi.fn().mockResolvedValue('knowledge content');
const mockMemorySave = vi.fn().mockResolvedValue(undefined);
const mockMemoryAppend = vi.fn().mockResolvedValue(undefined);
const mockMemoryUpdate = vi.fn().mockResolvedValue(true);
const mockMemoryDelete = vi.fn().mockResolvedValue(2);
const mockSecretListNames = vi.fn().mockReturnValue(['ANTHROPIC_API_KEY']);
const mockSecretSet = vi.fn();
const mockSecretDelete = vi.fn().mockReturnValue(true);
const mockHistoryGetRecentRuns = vi.fn().mockReturnValue([{ id: 'run-1', task_text: 'test', status: 'completed' }]);
const mockHistorySearchRuns = vi.fn().mockReturnValue([]);
const mockHistoryGetRun = vi.fn().mockReturnValue({ id: 'run-1', task_text: 'test' });
const mockHistoryGetRunToolCalls = vi.fn().mockReturnValue([]);
const mockHistoryGetStats = vi.fn().mockReturnValue({ total_runs: 5 });
const mockHistoryGetCostByDay = vi.fn().mockReturnValue([]);
const mockTaskList = vi.fn().mockReturnValue([]);
const mockTaskCreate = vi.fn().mockReturnValue({ id: 'task-1', title: 'Test' });
const mockTaskUpdate = vi.fn().mockReturnValue({ id: 'task-1', title: 'Updated' });
const mockTaskComplete = vi.fn().mockReturnValue({ id: 'task-1', status: 'completed' });
const mockGoogleIsAuthenticated = vi.fn().mockReturnValue(false);
const mockGoogleStartRedirectAuth = vi.fn().mockReturnValue({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=test-state', state: 'test-state' });
const mockGoogleExchangeRedirectCode = vi.fn().mockResolvedValue(undefined);
const mockGoogleAuth = {
  isAuthenticated: mockGoogleIsAuthenticated,
  startRedirectAuth: mockGoogleStartRedirectAuth,
  exchangeRedirectCode: mockGoogleExchangeRedirectCode,
  getAccountInfo: vi.fn().mockReturnValue({}),
  startDeviceFlow: vi.fn(),
  getScopes: vi.fn().mockReturnValue([]),
  getTokenExpiry: vi.fn().mockReturnValue(null),
};

const mockSessionInstance = {
  run: mockSessionRun,
  abort: mockSessionAbort,
  reset: mockSessionReset,
  onStream: null as unknown,
  promptUser: null as unknown,
  getModelTier: vi.fn().mockReturnValue('sonnet'),
  getChangesetManager: vi.fn().mockReturnValue(null),
  getAgent: vi.fn().mockReturnValue(null),
  sessionId: 'mock-session-id',
};
const mockGetOrCreate = vi.fn().mockReturnValue(mockSessionInstance);
const mockSessionGet = vi.fn().mockReturnValue(mockSessionInstance);
const mockSessionStoreReset = vi.fn();

vi.mock('../core/engine.js', () => ({
  Engine: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.init = vi.fn().mockReturnValue(Promise.resolve(this));
    this.startWorkerLoop = vi.fn();
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.createSession = vi.fn().mockReturnValue(mockSessionInstance);
    this.getMemory = vi.fn().mockReturnValue({
      load: mockMemoryLoad,
      save: mockMemorySave,
      append: mockMemoryAppend,
      update: mockMemoryUpdate,
      delete: mockMemoryDelete,
    });
    this.getSecretStore = vi.fn().mockReturnValue({
      listNames: mockSecretListNames,
      set: mockSecretSet,
      recordConsent: vi.fn(),
      deleteSecret: mockSecretDelete,
      resolve: vi.fn().mockReturnValue(null),
    });
    this.getRunHistory = vi.fn().mockReturnValue({
      getRecentRuns: mockHistoryGetRecentRuns,
      searchRuns: mockHistorySearchRuns,
      getRun: mockHistoryGetRun,
      getRunToolCalls: mockHistoryGetRunToolCalls,
      getStats: mockHistoryGetStats,
      getCostByDay: mockHistoryGetCostByDay,
    });
    this.getTaskManager = vi.fn().mockReturnValue({
      list: mockTaskList,
      create: mockTaskCreate,
      update: mockTaskUpdate,
      complete: mockTaskComplete,
    });
    this.getThreadStore = vi.fn().mockReturnValue(null);
    this.getPromptStore = vi.fn().mockReturnValue(null);
    this.getGoogleAuth = vi.fn().mockReturnValue(mockGoogleAuth);
    this.reloadGoogle = vi.fn().mockResolvedValue(true);
    this.reloadUserConfig = vi.fn().mockResolvedValue(undefined);
    this.getUserConfig = vi.fn().mockReturnValue({});
    return this;
  }),
}));

vi.mock('../core/session-store.js', () => ({
  SessionStore: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.getOrCreate = mockGetOrCreate;
    this.get = mockSessionGet;
    this.reset = mockSessionStoreReset;
    this.setRunningCheck = vi.fn();
    this.startEviction = vi.fn();
    this.stopEviction = vi.fn();
    return this;
  }),
}));

vi.mock('../core/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({ default_tier: 'opus' }),
  readUserConfig: vi.fn().mockReturnValue({
    default_tier: 'opus', thinking_mode: 'adaptive',
    api_key: 'sk-ant-secret-key', telegram_bot_token: '12345:ABC',
  }),
  saveUserConfig: vi.fn(),
  reloadConfig: vi.fn(),
}));

// === Import after mocks ===

const { LynoxHTTPApi } = await import('./http-api.js');

// === Helpers ===

const TEST_SECRET = 'test-bearer-token-12345';
const TEST_PORT = 13100; // high port to avoid conflicts

let api: InstanceType<typeof LynoxHTTPApi>;
let baseUrl: string;

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_SECRET}` };
}

async function jsonFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = { ...authHeaders(), ...opts.headers } as Record<string, string>;
  if (opts.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${baseUrl}${path}`, { ...opts, headers });
}

// === Setup/Teardown ===

beforeAll(async () => {
  vi.stubEnv('LYNOX_HTTP_SECRET', TEST_SECRET);
  vi.stubEnv('LYNOX_TRUST_PROXY', 'true');
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  api = new LynoxHTTPApi();
  await api.init();
  await api.start(TEST_PORT);
  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  // Wait for server to be ready
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) break;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 100));
  }
});

afterAll(async () => {
  await api.shutdown();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Re-set defaults after clearAllMocks
  mockSessionGet.mockReturnValue(mockSessionInstance);
  mockSessionRun.mockResolvedValue('Agent response');
  mockSecretListNames.mockReturnValue(['ANTHROPIC_API_KEY']);
  mockSecretDelete.mockReturnValue(true);
  mockHistoryGetRecentRuns.mockReturnValue([{ id: 'run-1', task_text: 'test', status: 'completed' }]);
  mockHistoryGetRun.mockReturnValue({ id: 'run-1', task_text: 'test' });
  mockHistoryGetStats.mockReturnValue({ total_runs: 5 });
  mockTaskCreate.mockReturnValue({ id: 'task-1', title: 'Test' });
  mockTaskUpdate.mockReturnValue({ id: 'task-1', title: 'Updated' });
  mockTaskComplete.mockReturnValue({ id: 'task-1', status: 'completed' });
  mockMemoryLoad.mockResolvedValue('knowledge content');
  mockMemoryUpdate.mockResolvedValue(true);
  mockMemoryDelete.mockResolvedValue(2);
});

// === Tests ===

describe('LynoxHTTPApi', () => {
  describe('health', () => {
    it('returns ok without auth', async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('ok');
    });
  });

  describe('auth', () => {
    it('rejects requests without auth', async () => {
      const res = await fetch(`${baseUrl}/api/secrets`);
      expect(res.status).toBe(401);
    });

    it('rejects requests with wrong token', async () => {
      const res = await fetch(`${baseUrl}/api/secrets`, {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    });

    it('accepts requests with correct token', async () => {
      const res = await jsonFetch('/api/secrets');
      expect(res.status).toBe(200);
    });

    it('lets public WhatsApp paths through without bearer token', async () => {
      // Meta hits the webhook unauthenticated (it carries its own HMAC signature).
      // The pre-login UI hits /status to decide whether to render WA surfaces.
      // All three must reach their handler instead of being 401'd by the auth gate.
      const status = await fetch(`${baseUrl}/api/whatsapp/status`);
      expect(status.status).not.toBe(401);

      const webhookGet = await fetch(`${baseUrl}/api/webhooks/whatsapp`);
      expect(webhookGet.status).not.toBe(401);

      const webhookPost = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(webhookPost.status).not.toBe(401);
    });
  });

  describe('CORS', () => {
    it('responds to OPTIONS preflight', async () => {
      const res = await fetch(`${baseUrl}/api/secrets`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      // With LYNOX_HTTP_SECRET set and no LYNOX_ALLOWED_ORIGINS, CORS is restricted (no wildcard)
      expect(res.headers.get('access-control-allow-methods')).toBe('GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    });
  });

  describe('HEAD', () => {
    it('HEAD falls back to GET handler', async () => {
      const res = await fetch(`${baseUrl}/api/config`, {
        method: 'HEAD',
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      // HEAD response must have no body
      const body = await res.text();
      expect(body).toBe('');
    });
  });

  describe('404', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await jsonFetch('/api/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('sessions', () => {
    it('creates a session', async () => {
      const res = await jsonFetch('/api/sessions', { method: 'POST', body: '{}' });
      expect(res.status).toBe(201);
      const body = await res.json() as { sessionId: string };
      expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('deletes a session', async () => {
      mockSessionGet.mockReturnValue(mockSessionInstance);
      const res = await jsonFetch('/api/sessions/test-session', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(mockSessionAbort).toHaveBeenCalled();
    });

    it('returns 404 for unknown session delete', async () => {
      mockSessionGet.mockReturnValue(undefined);
      const res = await jsonFetch('/api/sessions/nonexistent', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  describe('runs', () => {
    it('returns 404 for run on unknown session', async () => {
      mockSessionGet.mockReturnValue(undefined);
      const res = await jsonFetch('/api/sessions/bad/run', {
        method: 'POST',
        body: JSON.stringify({ task: 'hello' }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 400 for run without task', async () => {
      const res = await jsonFetch('/api/sessions/test/run', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('streams SSE events for a run', async () => {
      // Make run complete immediately
      mockSessionRun.mockImplementation(async () => {
        // Simulate a stream event
        const onStream = mockSessionInstance.onStream as ((e: unknown) => Promise<void>) | null;
        if (onStream) {
          await onStream({ type: 'text', text: 'Hello world', agent: 'lynox' });
        }
        return 'Hello world';
      });

      const res = await jsonFetch('/api/sessions/test/run', {
        method: 'POST',
        body: JSON.stringify({ task: 'say hello' }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');

      const text = await res.text();
      expect(text).toContain('event: text');
      expect(text).toContain('Hello world');
      expect(text).toContain('event: done');
    });

    it('reply returns 404 for no pending prompt', async () => {
      const res = await jsonFetch('/api/sessions/test/reply', {
        method: 'POST',
        body: JSON.stringify({ answer: 'yes' }),
      });
      expect(res.status).toBe(404);
    });

    it('abort returns 200', async () => {
      const res = await jsonFetch('/api/sessions/test/abort', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(mockSessionAbort).toHaveBeenCalled();
    });
  });

  describe('memory', () => {
    it('GET loads namespace', async () => {
      const res = await jsonFetch('/api/memory/knowledge');
      expect(res.status).toBe(200);
      const body = await res.json() as { content: string };
      expect(body.content).toBe('knowledge content');
    });

    it('PUT saves namespace', async () => {
      const res = await jsonFetch('/api/memory/knowledge', {
        method: 'PUT',
        body: JSON.stringify({ content: 'new content' }),
      });
      expect(res.status).toBe(200);
      expect(mockMemorySave).toHaveBeenCalledWith('knowledge', 'new content');
    });

    it('POST appends to namespace', async () => {
      const res = await jsonFetch('/api/memory/knowledge/append', {
        method: 'POST',
        body: JSON.stringify({ text: 'appended' }),
      });
      expect(res.status).toBe(200);
      expect(mockMemoryAppend).toHaveBeenCalledWith('knowledge', 'appended');
    });

    it('PATCH updates namespace', async () => {
      const res = await jsonFetch('/api/memory/knowledge', {
        method: 'PATCH',
        body: JSON.stringify({ old: 'old text', new: 'new text' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { updated: boolean };
      expect(body.updated).toBe(true);
    });

    it('DELETE deletes from namespace', async () => {
      const res = await jsonFetch('/api/memory/knowledge?pattern=test');
      // GET first to verify it works, then DELETE
      const delRes = await jsonFetch('/api/memory/knowledge?pattern=test', { method: 'DELETE' });
      expect(delRes.status).toBe(200);
      const body = await delRes.json() as { deleted: number };
      expect(body.deleted).toBe(2);
    });
  });

  describe('secrets', () => {
    it('GET lists secret names', async () => {
      const res = await jsonFetch('/api/secrets');
      expect(res.status).toBe(200);
      const body = await res.json() as { names: string[] };
      expect(body.names).toContain('ANTHROPIC_API_KEY');
    });

    it('PUT stores a secret', async () => {
      const res = await jsonFetch('/api/secrets/NEW_KEY', {
        method: 'PUT',
        body: JSON.stringify({ value: 'secret-value' }),
      });
      expect(res.status).toBe(200);
      expect(mockSecretSet).toHaveBeenCalledWith('NEW_KEY', 'secret-value');
    });

    it('PUT rejects empty value', async () => {
      const res = await jsonFetch('/api/secrets/NEW_KEY', {
        method: 'PUT',
        body: JSON.stringify({ value: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('DELETE removes a secret', async () => {
      const res = await jsonFetch('/api/secrets/OLD_KEY', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = await res.json() as { deleted: boolean };
      expect(body.deleted).toBe(true);
    });
  });

  describe('config', () => {
    it('GET returns user config with secrets redacted', async () => {
      const res = await jsonFetch('/api/config');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body['default_tier']).toBe('opus');
      // Secrets must be stripped, replaced with _configured flags
      expect(body['api_key']).toBeUndefined();
      expect(body['telegram_bot_token']).toBeUndefined();
      expect(body['api_key_configured']).toBe(true);
      expect(body['telegram_bot_token_configured']).toBe(true);
    });

    it('PUT saves user config', async () => {
      const res = await jsonFetch('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ default_tier: 'sonnet' }),
      });
      expect(res.status).toBe(200);
    });

    it('PUT in managed mode rejects locked-field changes', async () => {
      vi.stubEnv('LYNOX_MANAGED_MODE', 'managed');
      try {
        const res = await jsonFetch('/api/config', {
          method: 'PUT',
          body: JSON.stringify({ default_tier: 'haiku' }), // mock effective is 'opus'
        });
        expect(res.status).toBe(403);
        const body = await res.json() as { error: string };
        expect(body.error).toContain('default_tier');
      } finally {
        vi.unstubAllEnvs();
        vi.stubEnv('LYNOX_HTTP_SECRET', TEST_SECRET);
        vi.stubEnv('LYNOX_TRUST_PROXY', 'true');
        vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
      }
    });

    it('PUT in managed mode allows no-op locked-field re-send (regression v1.3.5)', async () => {
      // Web UI re-sends every field on every save. A no-op write of `default_tier`
      // (same value as effective config) must NOT block unrelated updates like
      // changing `experience` from 'business' to 'developer'.
      vi.stubEnv('LYNOX_MANAGED_MODE', 'managed');
      try {
        const res = await jsonFetch('/api/config', {
          method: 'PUT',
          body: JSON.stringify({ default_tier: 'opus', experience: 'developer' }), // mock effective is 'opus'
        });
        expect(res.status).toBe(200);
      } finally {
        vi.unstubAllEnvs();
        vi.stubEnv('LYNOX_HTTP_SECRET', TEST_SECRET);
        vi.stubEnv('LYNOX_TRUST_PROXY', 'true');
        vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
      }
    });
  });

  describe('history', () => {
    it('GET /api/history/runs returns recent runs', async () => {
      const res = await jsonFetch('/api/history/runs');
      expect(res.status).toBe(200);
      const body = await res.json() as { runs: unknown[] };
      expect(body.runs).toHaveLength(1);
    });

    it('GET /api/history/runs with query searches', async () => {
      mockHistorySearchRuns.mockReturnValue([{ id: 'r-2', task_text: 'search result' }]);
      const res = await jsonFetch('/api/history/runs?q=search');
      expect(res.status).toBe(200);
      expect(mockHistorySearchRuns).toHaveBeenCalledWith('search', 20, 0);
    });

    it('GET /api/history/runs/:id returns run detail', async () => {
      const res = await jsonFetch('/api/history/runs/run-1');
      expect(res.status).toBe(200);
      const body = await res.json() as { id: string };
      expect(body.id).toBe('run-1');
    });

    it('GET /api/history/runs/:id returns 404 for unknown', async () => {
      mockHistoryGetRun.mockReturnValue(undefined);
      const res = await jsonFetch('/api/history/runs/nonexistent');
      expect(res.status).toBe(404);
    });

    it('GET /api/history/runs/:id/tool-calls returns tool calls', async () => {
      const res = await jsonFetch('/api/history/runs/run-1/tool-calls');
      expect(res.status).toBe(200);
    });

    it('GET /api/history/stats returns stats', async () => {
      const res = await jsonFetch('/api/history/stats');
      expect(res.status).toBe(200);
      const body = await res.json() as { total_runs: number };
      expect(body.total_runs).toBe(5);
    });

    it('GET /api/history/cost/daily returns cost data', async () => {
      const res = await jsonFetch('/api/history/cost/daily?days=7');
      expect(res.status).toBe(200);
      expect(mockHistoryGetCostByDay).toHaveBeenCalledWith(7);
    });
  });

  describe('tasks', () => {
    it('GET lists tasks', async () => {
      const res = await jsonFetch('/api/tasks');
      expect(res.status).toBe(200);
    });

    it('POST creates a task', async () => {
      const res = await jsonFetch('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: 'New Task' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { id: string };
      expect(body.id).toBe('task-1');
    });

    it('PATCH updates a task', async () => {
      const res = await jsonFetch('/api/tasks/task-1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'Updated' }),
      });
      expect(res.status).toBe(200);
    });

    it('PATCH returns 404 for unknown task', async () => {
      mockTaskUpdate.mockReturnValue(undefined);
      const res = await jsonFetch('/api/tasks/nonexistent', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'X' }),
      });
      expect(res.status).toBe(404);
    });

    it('POST /api/tasks/:id/complete completes a task', async () => {
      const res = await jsonFetch('/api/tasks/task-1/complete', { method: 'POST' });
      expect(res.status).toBe(200);
    });
  });

  describe('secrets/status', () => {
    it('GET /api/secrets/status returns category booleans', async () => {
      mockSecretListNames.mockReturnValue(['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);
      const res = await jsonFetch('/api/secrets/status');
      expect(res.status).toBe(200);
      const body = await res.json() as { configured: Record<string, boolean>; count: number };
      expect(body.configured.api_key).toBe(true);
      expect(body.configured.telegram).toBe(true);
      expect(body.configured.search).toBe(false);
      expect(body.count).toBe(2);
    });
  });

  describe('admin scope', () => {
    it('single-token mode grants admin by default', async () => {
      // LYNOX_HTTP_ADMIN_SECRET is not set — LYNOX_HTTP_SECRET is admin
      const res = await jsonFetch('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ default_tier: 'sonnet' }),
      });
      expect(res.status).toBe(200);
    });

    it('rejects destructive endpoint with user token when admin secret is set', async () => {
      vi.stubEnv('LYNOX_HTTP_ADMIN_SECRET', 'admin-secret-token-99999');
      try {
        // Use the regular LYNOX_HTTP_SECRET (user scope)
        const res = await jsonFetch('/api/config', {
          method: 'PUT',
          body: JSON.stringify({ default_tier: 'sonnet' }),
        });
        expect(res.status).toBe(403);
      } finally {
        vi.unstubAllEnvs();
        vi.stubEnv('LYNOX_HTTP_SECRET', TEST_SECRET);
      }
    });

    it('allows destructive endpoint with admin token', async () => {
      const adminToken = 'admin-secret-token-99999';
      vi.stubEnv('LYNOX_HTTP_ADMIN_SECRET', adminToken);
      try {
        const res = await fetch(`${baseUrl}/api/config`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ default_tier: 'sonnet' }),
        });
        expect(res.status).toBe(200);
      } finally {
        vi.unstubAllEnvs();
        vi.stubEnv('LYNOX_HTTP_SECRET', TEST_SECRET);
      }
    });
  });

  describe('Google OAuth callback', () => {
    beforeEach(() => {
      mockGoogleIsAuthenticated.mockReturnValue(false);
      mockGoogleStartRedirectAuth.mockReturnValue({
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=test-state',
        state: 'test-state',
      });
      mockGoogleExchangeRedirectCode.mockResolvedValue(undefined);
      vi.stubEnv('ORIGIN', 'https://test.example.com');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.stubEnv('LYNOX_HTTP_SECRET', TEST_SECRET);
      vi.stubEnv('LYNOX_TRUST_PROXY', 'true');
      vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
    });

    it('successful exchange renders meta-refresh (not inline script — engine API CSP blocks it)', async () => {
      // Prime singleton state by invoking the auth-start endpoint
      const startRes = await jsonFetch('/api/google/auth', {
        method: 'POST',
        body: JSON.stringify({ scopeMode: 'read' }),
      });
      expect(startRes.status).toBe(200);

      const cbRes = await fetch(`${baseUrl}/api/google/callback?code=valid-code&state=test-state`);
      expect(cbRes.status).toBe(200);
      expect(cbRes.headers.get('content-type')).toContain('text/html');

      const body = await cbRes.text();
      expect(body).toContain('meta http-equiv="refresh"');
      expect(body).toContain('https://test.example.com/app/settings/integrations');
      // CSP `default-src 'none'` blocks inline scripts — must not regress
      expect(body).not.toContain('<script>');
      expect(mockGoogleExchangeRedirectCode).toHaveBeenCalledWith('valid-code', expect.stringContaining('/api/google/callback'));
    });

    it('reload after success — state mismatch but already authenticated → renders success, no re-exchange', async () => {
      // Simulate the "user reloads the callback URL after success" case:
      // state slot already cleared by the earlier successful exchange.
      mockGoogleIsAuthenticated.mockReturnValue(true);

      const cbRes = await fetch(`${baseUrl}/api/google/callback?code=stale-code&state=stale-state`);
      expect(cbRes.status).toBe(200);

      const body = await cbRes.text();
      expect(body).toContain('meta http-equiv="refresh"');
      expect(body).toContain('/app/settings/integrations');
      // Idempotent — must NOT re-exchange the (already-spent) code
      expect(mockGoogleExchangeRedirectCode).not.toHaveBeenCalled();
    });

    it('CSRF — state mismatch and not authenticated → 400 error', async () => {
      mockGoogleIsAuthenticated.mockReturnValue(false);

      const cbRes = await fetch(`${baseUrl}/api/google/callback?code=any&state=wrong`);
      expect(cbRes.status).toBe(400);

      const body = await cbRes.text();
      expect(body).toContain('Invalid callback');
      expect(mockGoogleExchangeRedirectCode).not.toHaveBeenCalled();
    });

    it('Google error param (e.g. ?error=access_denied) → 400 with error surfaced', async () => {
      const cbRes = await fetch(`${baseUrl}/api/google/callback?error=access_denied`);
      expect(cbRes.status).toBe(400);

      const body = await cbRes.text();
      expect(body).toContain('access_denied');
      expect(body).toContain('You can close this tab');
      expect(mockGoogleExchangeRedirectCode).not.toHaveBeenCalled();
    });

    it('Google error param is HTML-escaped (XSS guard)', async () => {
      // Google never sends this in practice, but the handler must escape
      // anything that arrives in the error querystring.
      const malicious = '<script>alert(1)</script>';
      const cbRes = await fetch(`${baseUrl}/api/google/callback?error=${encodeURIComponent(malicious)}`);
      expect(cbRes.status).toBe(400);

      const body = await cbRes.text();
      expect(body).not.toContain('<script>alert(1)</script>');
      expect(body).toContain('&lt;script&gt;');
    });

    it('exchange failure → 500 with sanitized error message', async () => {
      // Prime state so the request passes the state check and hits the try/catch
      const startRes = await jsonFetch('/api/google/auth', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect(startRes.status).toBe(200);

      mockGoogleExchangeRedirectCode.mockRejectedValueOnce(new Error('token endpoint unreachable'));

      const cbRes = await fetch(`${baseUrl}/api/google/callback?code=valid&state=test-state`);
      expect(cbRes.status).toBe(500);

      const body = await cbRes.text();
      expect(body).toContain('token endpoint unreachable');
      expect(mockGoogleExchangeRedirectCode).toHaveBeenCalledTimes(1);
    });
  });

  describe('rate limiting', () => {
    it('loopback gets higher rate limit (spoofed X-Forwarded-For ignored for limit tier)', async () => {
      // Security: rate limiter uses socket IP (not X-Forwarded-For) for loopback detection.
      // Loopback gets RATE_MAX_LOOPBACK (600), so 130 requests should all succeed.
      const fakeIp = '203.0.113.42';
      const promises = Array.from({ length: 130 }, () =>
        fetch(`${baseUrl}/api/secrets`, {
          headers: { ...authHeaders(), 'X-Forwarded-For': fakeIp },
        }).then(r => r.status)
      );
      const statuses = await Promise.all(promises);
      // All should pass — loopback socket gets the higher 600-request limit
      expect(statuses).not.toContain(429);
      expect(statuses.every(s => s === 200)).toBe(true);
    });
  });
});
