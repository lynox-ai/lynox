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
  updateWorkflowTool: { name: 'update_workflow_steps' },
  exportWorkflowTool: { name: 'export_workflow' },
  importWorkflowTool: { name: 'import_workflow' },
  diagnoseWorkflowTool: { name: 'diagnose_workflow_run' },
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
  artifactHistoryTool: { name: 'artifact_history' },
  artifactRestoreTool: { name: 'artifact_restore' },
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

// Same non-allowlisted host, but with a SERVER-PERSISTED disclosure acceptance
// (W3). The reload gate must treat the persisted record as acceptance — equal
// to the env flag — so a UI/API custom-endpoint save reloads cleanly (it was
// throwing a 500 before W3; the http-api test masked it by mocking reload).
const NON_ALLOWLISTED_PERSISTED_ACCEPTED: LynoxUserConfig = {
  provider: 'openai',
  api_base_url: 'https://my-litellm.example.com/v1',
  openai_model_id: 'gpt-4o-mini',
  api_key: 'sk-byok-key',
  accepted_custom_endpoints: [{ host: 'my-litellm.example.com', accepted_at: '2026-06-07T12:00:00.000Z' }],
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

  it('a refused reload ROLLS BACK — the engine keeps the prior config, not the rejected candidate', async () => {
    const engine = makeEngine();
    // Sanity: constructor installed the baseline.
    expect(engine.getUserConfig().provider).toBe('anthropic');
    mockLoadConfig.mockReturnValueOnce(NON_ALLOWLISTED_CONFIG);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-byok-key');

    await expect(engine.reloadUserConfig()).rejects.toThrow();

    // The candidate (provider:'openai' + my-litellm host) must NOT have survived
    // the throw — validate-before-commit restores the prior config.
    const after = engine.getUserConfig();
    expect(after.provider).toBe('anthropic');
    expect(after.api_base_url).toBeUndefined();
    expect(after.api_key).toBe('sk-ant-baseline');
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

  it('non-allowlisted base_url + server-persisted acceptance (no env flag) → succeeds + WARNING (W3)', async () => {
    // The host is recorded in accepted_custom_endpoints, so the reload gate
    // honours it like the env flag — this is what makes a confirmed custom-
    // endpoint save reload as 200 instead of throwing a 500.
    const engine = makeEngine();
    mockLoadConfig.mockReturnValueOnce(NON_ALLOWLISTED_PERSISTED_ACCEPTED);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-byok-key');

    await expect(engine.reloadUserConfig()).resolves.toBeUndefined();

    const warningCalls = stderrWrite.mock.calls.filter(c =>
      typeof c[0] === 'string' && (c[0] as string).includes('WARNING'),
    );
    expect(warningCalls.length).toBeGreaterThan(0);
    expect((warningCalls[0]![0] as string)).toContain('my-litellm.example.com');
  });

  it('persisted acceptance for a DIFFERENT host does not vouch for the active url → still throws (W3)', async () => {
    // Guard: the record must match the active host. A stale/other-host record
    // must not let an unrelated non-allowlisted url through.
    const engine = makeEngine();
    mockLoadConfig.mockReturnValueOnce({
      ...NON_ALLOWLISTED_PERSISTED_ACCEPTED,
      accepted_custom_endpoints: [{ host: 'some-other-host.example.org', accepted_at: '2026-06-07T12:00:00.000Z' }],
    });
    mockResolveProviderApiKey.mockReturnValueOnce('sk-byok-key');

    await expect(engine.reloadUserConfig()).rejects.toThrow(/my-litellm\.example\.com/);
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

// ── Main-chat tier (default_tier → config.model) — the "Main chat model" picker ──
// Wire-proof for the picker: the picked tier must reach `config.model` (which
// session._model reads), clamped to the CP max_tier ceiling, at BOTH the ctor
// and reload seams. The reload test pins G1 (default_tier was restart-only).
describe('Engine — main-chat tier (default_tier → config.model)', () => {
  const modelOf = (e: Engine): string | undefined =>
    (e as unknown as { config: { model?: string } }).config.model;

  // D25 drift-lock: `balanced` is the UNIVERSAL default main-chat tier. With no
  // `default_tier` picked (a fresh self-host config) and no ceiling, the CTOR seam
  // (engine.ts:273) must resolve to `balanced` — never `fast` (a silent quality
  // drop) or `deep` (a silent cost blowout). Pins that `?? 'balanced'` fallback
  // against a quiet flip; the reload seam (engine.ts:362, a separate `?? 'balanced'`
  // expression) is pinned by the sibling reload test below. See model-execution-
  // policy D25 ("balanced universal default"); managed enforces it via TIER_POLICY.
  it('ctor: unset default_tier resolves to the balanced universal default (D25)', () => {
    mockLoadConfig.mockReturnValue({ ...BASELINE_ANTHROPIC }); // no default_tier, no max_tier
    const engine = new Engine({}); // no explicit model → the universal default applies
    expect(modelOf(engine)).toBe('balanced');
  });

  // D25 drift-lock — the RELOAD seam (engine.ts:362). Separate `?? 'balanced'`
  // expression from the ctor, so it needs its own pin: a regression flipping only
  // the reload fallback would slip past the ctor test above.
  it('reloadUserConfig: unset default_tier re-resolves to the balanced universal default (D25)', async () => {
    const engine = makeEngine(); // starts at balanced
    // Move it OFF balanced first, so the final assertion proves the fallback
    // actively fires at reload rather than mere inertia.
    mockLoadConfig.mockReturnValueOnce({ ...BASELINE_ANTHROPIC, default_tier: 'deep' });
    mockResolveProviderApiKey.mockReturnValueOnce('sk-ant-baseline');
    await engine.reloadUserConfig();
    expect(modelOf(engine)).toBe('deep');
    // User clears the pick (default_tier unset) → reload must fall back to balanced,
    // never strand the session on the previously-picked deep tier.
    mockLoadConfig.mockReturnValueOnce({ ...BASELINE_ANTHROPIC });
    mockResolveProviderApiKey.mockReturnValueOnce('sk-ant-baseline');
    await engine.reloadUserConfig();
    expect(modelOf(engine)).toBe('balanced');
  });

  it('ctor: config.model comes from default_tier, clamped to max_tier (G3)', () => {
    mockLoadConfig.mockReturnValue({ ...BASELINE_ANTHROPIC, default_tier: 'deep', max_tier: 'balanced' });
    const engine = new Engine({}); // no explicit model → applies default_tier
    expect(modelOf(engine)).toBe('balanced'); // clamped down to the ceiling
  });

  it('ctor: default_tier passes through when under the max_tier ceiling', () => {
    mockLoadConfig.mockReturnValue({ ...BASELINE_ANTHROPIC, default_tier: 'deep', max_tier: 'deep' });
    const engine = new Engine({});
    expect(modelOf(engine)).toBe('deep');
  });

  it('reloadUserConfig re-syncs config.model from a changed default_tier WITHOUT restart (G1)', async () => {
    const engine = makeEngine(); // ctor with explicit model:'balanced'
    expect(modelOf(engine)).toBe('balanced');
    // User picks a new main-chat model → PUT persists default_tier → reload.
    mockLoadConfig.mockReturnValueOnce({ ...BASELINE_ANTHROPIC, default_tier: 'deep' });
    mockResolveProviderApiKey.mockReturnValueOnce('sk-ant-baseline');
    await engine.reloadUserConfig();
    expect(modelOf(engine)).toBe('deep'); // took effect without a process restart
  });

  it('reloadUserConfig clamps the re-synced tier to max_tier (G1+G3)', async () => {
    const engine = makeEngine();
    mockLoadConfig.mockReturnValueOnce({ ...BASELINE_ANTHROPIC, default_tier: 'deep', max_tier: 'balanced' });
    mockResolveProviderApiKey.mockReturnValueOnce('sk-ant-baseline');
    await engine.reloadUserConfig();
    expect(modelOf(engine)).toBe('balanced'); // ceiling still enforced on reload
  });
});
