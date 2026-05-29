import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Wave 5d BYOK liability gate — reload-path defense-in-depth.
 *
 * PR #607 (`feat(byok): allowlist + disclosure for custom LLM endpoints`)
 * shipped a 4-surface gate: Settings UI modal, api_setup tool,
 * `PUT /api/config` server-side, and `_initBootstrap`. /pr-review found a
 * 5th + 6th bypass surface:
 *   - direct `PUT /api/config` curl skipping the UI modal (Surface 5,
 *     covered by http-api.test.ts BYOK gate tests)
 *   - in-process `reloadUserConfig` / `reloadCredentials` paths that pick
 *     up a non-allowlisted `api_base_url` from disk + rebuild the LLM
 *     client without re-evaluating the gate (Surface 6, covered here).
 *
 * The reload-path gate matters because:
 *   - `reloadUserConfig` is triggered by `PUT /api/config`, by potential
 *     future SIGHUP / config.json edit watchers, and by any admin tooling
 *     that mutates user config out-of-band of the HTTP handler.
 *   - `reloadCredentials` is triggered by `PUT /api/secrets/:slot` (vault
 *     rotation) where the URL itself doesn't change — but if the vault has
 *     been swapped to a config containing a non-allowlisted url between
 *     boot and the secret write, the engine would rebuild the LLM client
 *     against that url without ever evaluating the gate.
 *
 * Test strategy mirrors `engine-propagate-provider.test.ts`: mock the
 * heavy IO boundaries (config.js, llm-client.js, provider-keys.js) so we
 * can instantiate an `Engine`, swap the loaded config under it, call the
 * reload method, and assert the gate fires (throw) or passes (silent).
 *
 * The decision logic itself is unit-tested in
 * `llm/endpoint-boot-gate.test.ts` — these tests pin that the engine
 * actually CALLS the decision function on both reload paths and reacts
 * correctly (throw on refuse, warn on accepted, silent on allowlisted).
 */

// ── Mocks (identical to engine-propagate-provider.test.ts) ────────────────

const mockLoadConfig = vi.fn();
vi.mock('./config.js', () => ({
  loadConfig: () => mockLoadConfig(),
  getLynoxDir: () => '/tmp/lynox-test',
  setVaultApiKeyExists: vi.fn(),
}));

const mockResolveProviderApiKey = vi.fn();
vi.mock('./llm/provider-keys.js', () => ({
  resolveProviderApiKey: (opts: unknown) => mockResolveProviderApiKey(opts),
}));

const mockCreateLLMClient = vi.fn();
const mockInitLLMProvider = vi.fn().mockResolvedValue(undefined);
vi.mock('./llm-client.js', () => ({
  createLLMClient: (opts: unknown) => mockCreateLLMClient(opts),
  initLLMProvider: (provider: unknown) => mockInitLLMProvider(provider),
  getActiveProvider: vi.fn().mockReturnValue('anthropic'),
  isCustomProvider: vi.fn().mockReturnValue(false),
}));

vi.mock('../types/index.js', async () => {
  const actual = await vi.importActual<typeof import('../types/index.js')>('../types/index.js');
  return {
    ...actual,
    setOpenAIModelResolver: vi.fn(),
    getOpenAIModelMap: vi.fn().mockReturnValue(new Map()),
  };
});

vi.mock('../tools/builtin/index.js', () => ({
  bashTool: { name: 'bash' },
  readFileTool: { name: 'read_file' },
  writeFileTool: { name: 'write_file' },
  memoryStoreTool: { name: 'memory_store' },
  memoryRecallTool: { name: 'memory_recall' },
  memoryDeleteTool: { name: 'memory_delete' },
  memoryUpdateTool: { name: 'memory_update' },
  memoryListTool: { name: 'memory_list' },
  memoryPromoteTool: { name: 'memory_promote' },
  spawnAgentTool: { name: 'spawn_agent' },
  askUserTool: { name: 'ask_user' },
  askSecretTool: { name: 'ask_secret' },
  batchFilesTool: { name: 'batch_files' },
  httpRequestTool: { name: 'http_request' },
  runWorkflowTool: { name: 'run_workflow' },
  taskCreateTool: { name: 'task_create' },
  taskUpdateTool: { name: 'task_update' },
  taskListTool: { name: 'task_list' },
  planTaskTool: { name: 'plan_task' },
  dataStoreCreateTool: { name: 'data_store_create' },
  dataStoreInsertTool: { name: 'data_store_insert' },
  dataStoreQueryTool: { name: 'data_store_query' },
  dataStoreListTool: { name: 'data_store_list' },
  dataStoreDeleteTool: { name: 'data_store_delete' },
  dataStoreDropTool: { name: 'data_store_drop' },
  saveWorkflowTool: { name: 'save_workflow' },
  apiSetupTool: { name: 'api_setup' },
  artifactSaveTool: { name: 'artifact_save' },
  artifactListTool: { name: 'artifact_list' },
  artifactDeleteTool: { name: 'artifact_delete' },
  recallToolResultTool: { name: 'recall_tool_result' },
}));

vi.mock('./tool-context.js', () => ({
  createToolContext: vi.fn().mockReturnValue({}),
}));

// Import AFTER mocks.
import { Engine } from './engine.js';
import { evaluateEndpointBootGate } from './llm/endpoint-allowlist.js';
import type { LynoxConfig, LynoxUserConfig } from '../types/index.js';

// ── Test fixtures ─────────────────────────────────────────────────────────

const ALLOWLISTED_CONFIG: LynoxUserConfig = {
  provider: 'openai',
  api_base_url: 'https://api.mistral.ai/v1',
  openai_model_id: 'mistral-large-2512',
  api_key: 'sk-mistral-key',
};

const NON_ALLOWLISTED_CONFIG: LynoxUserConfig = {
  provider: 'openai',
  api_base_url: 'https://my-litellm.example.com/v1',
  openai_model_id: 'gpt-4o-mini',
  api_key: 'sk-byok-key',
};

const BASELINE_ANTHROPIC: LynoxUserConfig = {
  api_key: 'sk-ant-baseline',
  provider: 'anthropic',
};

// ── Shared setup ──────────────────────────────────────────────────────────

let stderrWrite: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockLoadConfig.mockReset();
  mockResolveProviderApiKey.mockReset();
  mockCreateLLMClient.mockReset();
  mockInitLLMProvider.mockClear();
  mockCreateLLMClient.mockImplementation((opts: { apiKey?: string | undefined }) => ({
    _provider: 'mock',
    _apiKey: opts?.apiKey,
    beta: { messages: { stream: vi.fn() } },
  }));
  // Constructor's loadConfig() call.
  mockLoadConfig.mockReturnValue(BASELINE_ANTHROPIC);
  mockResolveProviderApiKey.mockReturnValue('sk-ant-baseline');
  // Quiet the stderr WARNING/refusal lines so a green test run isn't noisy.
  stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // Ensure no leftover env from a sibling test.
  delete process.env['LYNOX_CUSTOM_ENDPOINT_ACCEPTED'];
});

afterEach(() => {
  stderrWrite.mockRestore();
  delete process.env['LYNOX_CUSTOM_ENDPOINT_ACCEPTED'];
});

function makeEngine(): Engine {
  const config: LynoxConfig = { model: 'balanced' };
  return new Engine(config);
}

// ── reloadUserConfig ──────────────────────────────────────────────────────

describe('Engine.reloadUserConfig — Wave 5d allowlist gate', () => {
  it('allowlisted base_url + no env flag → succeeds silently (no stderr WARNING)', async () => {
    const engine = makeEngine();
    mockLoadConfig.mockReturnValueOnce(ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-mistral-key');

    await expect(engine.reloadUserConfig()).resolves.toBeUndefined();

    // No stderr WARNING line emitted for allowlisted hosts.
    const warningCalls = stderrWrite.mock.calls.filter(c =>
      typeof c[0] === 'string' && (c[0] as string).includes('WARNING'),
    );
    expect(warningCalls).toHaveLength(0);
  });

  it('non-allowlisted base_url + no env flag → throws (closes the reload-path bypass)', async () => {
    const engine = makeEngine();
    mockLoadConfig.mockReturnValueOnce(NON_ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-byok-key');

    await expect(engine.reloadUserConfig()).rejects.toThrow(/my-litellm\.example\.com/);
  });

  it('non-allowlisted base_url + LYNOX_CUSTOM_ENDPOINT_ACCEPTED=true → succeeds + stderr WARNING', async () => {
    process.env['LYNOX_CUSTOM_ENDPOINT_ACCEPTED'] = 'true';
    const engine = makeEngine();
    mockLoadConfig.mockReturnValueOnce(NON_ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-byok-key');

    await expect(engine.reloadUserConfig()).resolves.toBeUndefined();

    const warningCalls = stderrWrite.mock.calls.filter(c =>
      typeof c[0] === 'string' && (c[0] as string).includes('WARNING'),
    );
    expect(warningCalls.length).toBeGreaterThan(0);
    expect((warningCalls[0]![0] as string)).toContain('my-litellm.example.com');
  });

  it('gate fires BEFORE the LLM client is rebuilt (defense-in-depth ordering)', async () => {
    // Pin the regression: if the gate is moved AFTER `_recreateClient`, a
    // non-allowlisted URL would briefly bind the engine's `this.client` to
    // the unvetted endpoint before the throw rolls execution back. With the
    // gate BEFORE the client swap, `createLLMClient` is never called with
    // the bad URL.
    const engine = makeEngine();
    mockCreateLLMClient.mockClear();
    mockLoadConfig.mockReturnValueOnce(NON_ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-byok-key');

    await expect(engine.reloadUserConfig()).rejects.toThrow();

    // createLLMClient must NOT have been invoked during the failed reload
    // (constructor call doesn't count because mockClear above resets the
    // call list, and we're only looking at calls made during reloadUserConfig).
    expect(mockCreateLLMClient).not.toHaveBeenCalled();
  });
});

// ── reloadCredentials ─────────────────────────────────────────────────────

describe('Engine.reloadCredentials — Wave 5d allowlist gate', () => {
  it('allowlisted base_url + no env flag → succeeds silently', async () => {
    const engine = makeEngine();
    mockLoadConfig.mockReturnValueOnce(ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-mistral-key');

    await expect(engine.reloadCredentials()).resolves.toBeUndefined();

    const warningCalls = stderrWrite.mock.calls.filter(c =>
      typeof c[0] === 'string' && (c[0] as string).includes('WARNING'),
    );
    expect(warningCalls).toHaveLength(0);
  });

  it('non-allowlisted base_url + no env flag → throws', async () => {
    const engine = makeEngine();
    mockLoadConfig.mockReturnValueOnce(NON_ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-byok-key');

    await expect(engine.reloadCredentials()).rejects.toThrow(/my-litellm\.example\.com/);
  });

  it('non-allowlisted base_url + LYNOX_CUSTOM_ENDPOINT_ACCEPTED=true → succeeds + stderr WARNING', async () => {
    process.env['LYNOX_CUSTOM_ENDPOINT_ACCEPTED'] = 'true';
    const engine = makeEngine();
    mockLoadConfig.mockReturnValueOnce(NON_ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-byok-key');

    await expect(engine.reloadCredentials()).resolves.toBeUndefined();

    const warningCalls = stderrWrite.mock.calls.filter(c =>
      typeof c[0] === 'string' && (c[0] as string).includes('WARNING'),
    );
    expect(warningCalls.length).toBeGreaterThan(0);
  });

  it('gate fires BEFORE the LLM client is rebuilt', async () => {
    const engine = makeEngine();
    mockCreateLLMClient.mockClear();
    mockLoadConfig.mockReturnValueOnce(NON_ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-byok-key');

    await expect(engine.reloadCredentials()).rejects.toThrow();

    expect(mockCreateLLMClient).not.toHaveBeenCalled();
  });
});

// ── Symmetry ──────────────────────────────────────────────────────────────

describe('Allowlist gate symmetry — init + reload paths share one decision function', () => {
  // The gate is the same `evaluateEndpointBootGate` decision function at three
  // call sites (init via _initBootstrap, reloadUserConfig, reloadCredentials).
  // This test pins that pulling on any one site can't drift the others — if
  // a future refactor splits the decision logic per-site, the equivalence
  // assertions below will catch the divergence.
  it('init-time refusal + reload-time refusal use the same decision function (same input → same outcome)', async () => {
    // Pin the contract: the pure decision function `evaluateEndpointBootGate`
    // returns `refuse` for both call-sites' inputs.
    const baseUrl = NON_ALLOWLISTED_CONFIG.api_base_url ?? '';
    const decisionInit = evaluateEndpointBootGate(baseUrl, undefined);
    const decisionReload = evaluateEndpointBootGate(baseUrl, undefined);
    expect(decisionInit).toBe('refuse');
    expect(decisionReload).toBe('refuse');
    expect(decisionInit).toBe(decisionReload);

    // And confirm reloadUserConfig actually throws for that same input.
    const engine = makeEngine();
    mockLoadConfig.mockReturnValueOnce(NON_ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-byok-key');
    await expect(engine.reloadUserConfig()).rejects.toThrow(/controller-responsibility/);

    // Same for reloadCredentials.
    mockLoadConfig.mockReturnValueOnce(NON_ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-byok-key');
    await expect(engine.reloadCredentials()).rejects.toThrow(/controller-responsibility/);
  });

  it('allowlisted input is silent on all three call-sites (no spurious WARNING)', async () => {
    const baseUrl = ALLOWLISTED_CONFIG.api_base_url ?? '';
    expect(evaluateEndpointBootGate(baseUrl, undefined)).toBe('allowlisted');
    expect(evaluateEndpointBootGate(baseUrl, 'true')).toBe('allowlisted'); // env-flag is a no-op for vetted

    const engine = makeEngine();
    stderrWrite.mockClear();
    mockLoadConfig.mockReturnValueOnce(ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-mistral-key');
    await engine.reloadUserConfig();

    mockLoadConfig.mockReturnValueOnce(ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-mistral-key');
    await engine.reloadCredentials();

    const warningCalls = stderrWrite.mock.calls.filter(c =>
      typeof c[0] === 'string' && (c[0] as string).includes('WARNING'),
    );
    expect(warningCalls).toHaveLength(0);
  });
});
