import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * PR #569 cleanup-owe — end-to-end propagation test for the engine-level
 * EU-residency provider-switch path.
 *
 * Without this test the individual Memory.setClient / KnowledgeLayer.setAnthropicClient
 * tests still pass but a regression where `Engine.reloadCredentials()` stops
 * calling `_propagateProviderSwitch` would slip through silently — and that
 * is precisely the GDPR / EU-residency leak the PR #569 setters exist to
 * prevent (Memory consolidation + KG entity-extraction + HyDE retrieval all
 * embed user content in LLM prompts, so a stale client = data crossing
 * jurisdiction boundaries until container restart).
 *
 * Strategy: mock `loadConfig`, `resolveProviderApiKey`, `createLLMClient`, and
 * the openai resolver so we can instantiate an `Engine` cheaply, inject mock
 * `memory` + `knowledgeLayer` instances into the private fields, and verify
 * that `reloadCredentials()` invokes both setters with the new provider
 * config.
 */

// ── Mock the heavy/IO-bound dependencies pulled in via the Engine module
// chain. We never run `engine.init()` here — we go straight from
// `new Engine(...)` to `engine.reloadCredentials()` with injected mocks.

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

// Mock tools index to avoid loading the entire tool surface.
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

// Import AFTER mocks are registered.
import { Engine } from './engine.js';
import type { LynoxConfig, LynoxUserConfig } from '../types/index.js';

describe('Engine.reloadCredentials — provider-switch end-to-end propagation', () => {
  beforeEach(() => {
    mockLoadConfig.mockReset();
    mockResolveProviderApiKey.mockReset();
    mockCreateLLMClient.mockReset();
    mockInitLLMProvider.mockClear();

    // Sentinel client returned by createLLMClient — we only need a value
    // that's identity-comparable when propagated into KnowledgeLayer.
    mockCreateLLMClient.mockImplementation((opts: { apiKey?: string | undefined }) => ({
      _provider: 'mock',
      _apiKey: opts?.apiKey,
      beta: { messages: { stream: vi.fn() } },
    }));

    // Default config: anthropic provider with an old key.
    const defaultConfig: LynoxUserConfig = {
      api_key: 'sk-ant-old',
      provider: 'anthropic',
    };
    mockLoadConfig.mockReturnValue(defaultConfig);
    mockResolveProviderApiKey.mockReturnValue('sk-ant-old');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls Memory.setClient AND KnowledgeLayer.setAnthropicClient when reloadCredentials switches to Mistral', async () => {
    // Construct a minimal Engine (constructor calls loadConfig + createLLMClient
    // once each — covered by the mocks above).
    const config: LynoxConfig = { model: 'sonnet' };
    const engine = new Engine(config);

    // Inject mock memory + knowledgeLayer into the private fields so
    // _propagateProviderSwitch has targets to call.
    const memorySetClient = vi.fn();
    const knowledgeSetAnthropic = vi.fn();
    (engine as unknown as {
      memory: { setClient: typeof memorySetClient } | null;
      knowledgeLayer: { setAnthropicClient: typeof knowledgeSetAnthropic } | null;
    }).memory = { setClient: memorySetClient };
    (engine as unknown as {
      memory: { setClient: typeof memorySetClient } | null;
      knowledgeLayer: { setAnthropicClient: typeof knowledgeSetAnthropic } | null;
    }).knowledgeLayer = { setAnthropicClient: knowledgeSetAnthropic };

    // Now simulate a provider switch to Mistral. reloadCredentials() reads
    // a fresh config from disk via loadConfig.
    const mistralConfig: LynoxUserConfig = {
      provider: 'openai',
      api_base_url: 'https://api.mistral.ai/v1',
      openai_model_id: 'mistral-large-2512',
    };
    mockLoadConfig.mockReturnValueOnce(mistralConfig);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-mistral-new');

    await engine.reloadCredentials();

    // Memory.setClient must be invoked with the new Mistral provider config.
    expect(memorySetClient).toHaveBeenCalledTimes(1);
    expect(memorySetClient).toHaveBeenCalledWith({
      apiKey: 'sk-mistral-new',
      apiBaseURL: 'https://api.mistral.ai/v1',
      provider: 'openai',
      openaiModelId: 'mistral-large-2512',
    });

    // KnowledgeLayer.setAnthropicClient must be invoked with the freshly
    // created client (the same instance the engine's `client` field now holds).
    expect(knowledgeSetAnthropic).toHaveBeenCalledTimes(1);
    const passedClient = knowledgeSetAnthropic.mock.calls[0]![0];
    expect(passedClient).toBe(engine.client);
    expect(passedClient).toMatchObject({ _provider: 'mock', _apiKey: 'sk-mistral-new' });
  });

  it('also calls both setters on a same-provider key rotation (BYOK refresh)', async () => {
    const config: LynoxConfig = { model: 'sonnet' };
    const engine = new Engine(config);

    const memorySetClient = vi.fn();
    const knowledgeSetAnthropic = vi.fn();
    (engine as unknown as {
      memory: { setClient: typeof memorySetClient } | null;
      knowledgeLayer: { setAnthropicClient: typeof knowledgeSetAnthropic } | null;
    }).memory = { setClient: memorySetClient };
    (engine as unknown as {
      memory: { setClient: typeof memorySetClient } | null;
      knowledgeLayer: { setAnthropicClient: typeof knowledgeSetAnthropic } | null;
    }).knowledgeLayer = { setAnthropicClient: knowledgeSetAnthropic };

    // Same provider, new key — the regression we want to catch is if the
    // engine ever shortcircuits propagation when only the key changes.
    const rotatedConfig: LynoxUserConfig = {
      provider: 'anthropic',
      api_key: 'sk-ant-rotated',
    };
    mockLoadConfig.mockReturnValueOnce(rotatedConfig);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-ant-rotated');

    await engine.reloadCredentials();

    expect(memorySetClient).toHaveBeenCalledTimes(1);
    expect(memorySetClient).toHaveBeenCalledWith({
      apiKey: 'sk-ant-rotated',
      apiBaseURL: undefined,
      provider: 'anthropic',
      openaiModelId: undefined,
    });
    expect(knowledgeSetAnthropic).toHaveBeenCalledTimes(1);
  });

  it('does NOT throw when memory + knowledgeLayer are still null (pre-init reloadCredentials)', async () => {
    const config: LynoxConfig = { model: 'sonnet' };
    const engine = new Engine(config);
    // Leave memory + knowledgeLayer as the default null — simulates a
    // reloadCredentials() that fires before _initMemoryAndKnowledge has run.

    mockLoadConfig.mockReturnValueOnce({
      provider: 'anthropic',
      api_key: 'sk-ant-fresh',
    } satisfies LynoxUserConfig);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-ant-fresh');

    await expect(engine.reloadCredentials()).resolves.toBeUndefined();
  });

  // ── #42 — configVersion increments + Session stale-detection ──
  // Without this counter, a long-lived Session.agent (captured at construct
  // time) keeps calling the previous provider after a UI provider-switch.
  it('getConfigVersion increments on every _recreateClient (reloadCredentials path)', async () => {
    const config: LynoxConfig = { model: 'sonnet' };
    const engine = new Engine(config);
    const initial = engine.getConfigVersion();

    // First reload — same provider, fresh key.
    mockLoadConfig.mockReturnValueOnce({
      provider: 'anthropic',
      api_key: 'sk-ant-rotated-1',
    } satisfies LynoxUserConfig);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-ant-rotated-1');
    await engine.reloadCredentials();
    const afterFirst = engine.getConfigVersion();
    expect(afterFirst).toBeGreaterThan(initial);

    // Second reload — provider switch to Mistral.
    mockLoadConfig.mockReturnValueOnce({
      provider: 'openai',
      api_base_url: 'https://api.mistral.ai/v1',
    } satisfies LynoxUserConfig);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-mistral-new');
    await engine.reloadCredentials();
    expect(engine.getConfigVersion()).toBeGreaterThan(afterFirst);
  });

  it('reloadUserConfig increments configVersion when the provider actually changes', async () => {
    const config: LynoxConfig = { model: 'sonnet' };
    const engine = new Engine(config);
    const initial = engine.getConfigVersion();

    // reloadUserConfig only calls _recreateClient when api_key / api_base_url
    // / provider differs from the previous config. Switch provider to force it.
    mockLoadConfig.mockReturnValueOnce({
      provider: 'openai',
      api_base_url: 'https://api.mistral.ai/v1',
    } satisfies LynoxUserConfig);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-mistral-switch');
    await engine.reloadUserConfig();
    expect(engine.getConfigVersion()).toBeGreaterThan(initial);
  });
});
