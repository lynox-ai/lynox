import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * H-012 regression test — UI provider-switch must re-bootstrap the
 * unified-inbox classifier so a switch to Mistral does not leave the
 * classifier on Anthropic-US (EU-residency leak).
 *
 * Companion to `engine-propagate-provider.test.ts` (which covers the
 * Memory + KnowledgeLayer side of the same propagation path). PR #569
 * fixed those two sinks; this test guards the inbox sink — pattern
 * recidivism would otherwise re-introduce the bug at the inbox layer.
 *
 * Strategy: mock the heavy/IO-bound dependencies (loadConfig, LLM client
 * factory, openai resolver, tools, tool-context), then dynamically stub
 * the inbox `bootstrapInbox` factory + the `MailStateDb` so we can drive
 * `_propagateProviderSwitch` end-to-end without spinning up the real
 * inbox stack.
 */

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

// Inbox bootstrap mock — every call returns a fresh sentinel runtime
// shaped like InboxRuntime (only the fields the engine touches).
const mockBootstrapInbox = vi.fn();
vi.mock('../integrations/inbox/bootstrap.js', () => ({
  bootstrapInbox: (opts: unknown) => mockBootstrapInbox(opts),
}));

import { Engine } from './engine.js';
import type { LynoxConfig, LynoxUserConfig } from '../types/index.js';

interface MockRuntime {
  __sentinel: string;
  hook: ReturnType<typeof vi.fn>;
  onAccountAdded: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
}

function makeRuntime(sentinel: string): MockRuntime {
  return {
    __sentinel: sentinel,
    hook: vi.fn().mockResolvedValue(undefined),
    onAccountAdded: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Engine._propagateProviderSwitch — H-012 inbox classifier rebootstrap', () => {
  beforeEach(() => {
    mockLoadConfig.mockReset();
    mockResolveProviderApiKey.mockReset();
    mockCreateLLMClient.mockReset();
    mockInitLLMProvider.mockClear();
    mockBootstrapInbox.mockReset();

    mockCreateLLMClient.mockImplementation((opts: { apiKey?: string | undefined }) => ({
      _provider: 'mock',
      _apiKey: opts?.apiKey,
      beta: { messages: { stream: vi.fn() } },
    }));

    const defaultConfig: LynoxUserConfig = {
      api_key: 'sk-ant-old',
      provider: 'anthropic',
    };
    mockLoadConfig.mockReturnValue(defaultConfig);
    mockResolveProviderApiKey.mockReturnValue('sk-ant-old');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['LYNOX_INBOX_LLM_REGION'];
    delete process.env['MISTRAL_API_KEY'];
    delete process.env['LYNOX_INBOX_MISTRAL_API_KEY'];
  });

  /**
   * A. EU-residency leak regression:
   *   Anthropic (US) → Mistral (EU) provider-switch must dispose the
   *   US-bound runtime and bootstrap a fresh EU-bound one. Without this
   *   the inbox classifier keeps routing mail snippets to Anthropic-US
   *   until process restart — the H-012 leak path.
   */
  it('disposes the US runtime and bootstraps a fresh EU runtime on Anthropic→Mistral switch', async () => {
    process.env['MISTRAL_API_KEY'] = 'sk-mistral-test';
    const config: LynoxConfig = { model: 'sonnet' };
    const engine = new Engine(config);

    // Inject a fresh "US-bound" runtime + the mail state db + a MailStateDb
    // sentinel directly. The engine.ts wiring normally does this from
    // _initIntegrations; we skip init() here and short-circuit the fields.
    const usRuntime = makeRuntime('us-runtime');
    const mockMailStateDb = { __sentinel: 'mail-db' } as unknown as
      import('../integrations/mail/state.js').MailStateDb;
    const engineHandle = engine as unknown as {
      _inboxRuntime: MockRuntime | null;
      _mailStateDb: typeof mockMailStateDb | null;
      _inboxLlmRegion: 'us' | 'eu' | null;
      _inboxRebootstrapInflight: Promise<void> | null;
    };
    engineHandle._inboxRuntime = usRuntime;
    engineHandle._mailStateDb = mockMailStateDb;
    engineHandle._inboxLlmRegion = 'us';

    // The next bootstrapInbox call (the rebootstrap) returns a fresh EU
    // runtime sentinel so the test can assert identity-replacement.
    const euRuntime = makeRuntime('eu-runtime');
    mockBootstrapInbox.mockReturnValueOnce(euRuntime);

    // Switch to Mistral.
    const mistralConfig: LynoxUserConfig = {
      provider: 'openai',
      api_base_url: 'https://api.mistral.ai/v1',
      openai_model_id: 'mistral-large-2512',
    };
    mockLoadConfig.mockReturnValueOnce(mistralConfig);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-mistral-new');

    await engine.reloadCredentials();
    // Rebootstrap is fire-and-forget — await the inflight promise the
    // engine exposes for exactly this kind of deterministic assertion.
    if (engineHandle._inboxRebootstrapInflight) {
      await engineHandle._inboxRebootstrapInflight;
    }

    // Old US runtime drained.
    expect(usRuntime.shutdown).toHaveBeenCalledTimes(1);
    // Fresh runtime bootstrapped with EU region + Mistral key.
    expect(mockBootstrapInbox).toHaveBeenCalledTimes(1);
    const bootOpts = mockBootstrapInbox.mock.calls[0]![0] as {
      llmRegion: 'us' | 'eu';
      mistralApiKey?: string;
      mailStateDb: typeof mockMailStateDb;
    };
    expect(bootOpts.llmRegion).toBe('eu');
    expect(bootOpts.mistralApiKey).toBe('sk-mistral-test');
    expect(bootOpts.mailStateDb).toBe(mockMailStateDb);
    // Engine now points at the new runtime + tracked region updated.
    expect(engineHandle._inboxRuntime).toBe(euRuntime);
    expect(engineHandle._inboxLlmRegion).toBe('eu');
  });

  /**
   * B. Legitimate-use regression:
   *   Anthropic → Anthropic (BYOK key rotation, same region) must NOT
   *   tear down the inbox runtime. Without this guard every key rotation
   *   would needlessly drain the queue + restart the reminder poller.
   */
  it('does NOT rebootstrap on same-region rotation (Anthropic→Anthropic)', async () => {
    const config: LynoxConfig = { model: 'sonnet' };
    const engine = new Engine(config);

    const usRuntime = makeRuntime('us-runtime');
    const mockMailStateDb = { __sentinel: 'mail-db' } as unknown as
      import('../integrations/mail/state.js').MailStateDb;
    const engineHandle = engine as unknown as {
      _inboxRuntime: MockRuntime | null;
      _mailStateDb: typeof mockMailStateDb | null;
      _inboxLlmRegion: 'us' | 'eu' | null;
      _inboxRebootstrapInflight: Promise<void> | null;
    };
    engineHandle._inboxRuntime = usRuntime;
    engineHandle._mailStateDb = mockMailStateDb;
    engineHandle._inboxLlmRegion = 'us';

    // Same-provider rotation — just a new key.
    const rotatedConfig: LynoxUserConfig = {
      provider: 'anthropic',
      api_key: 'sk-ant-rotated',
    };
    mockLoadConfig.mockReturnValueOnce(rotatedConfig);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-ant-rotated');

    await engine.reloadCredentials();
    if (engineHandle._inboxRebootstrapInflight) {
      await engineHandle._inboxRebootstrapInflight;
    }

    // No shutdown, no bootstrap, runtime identity preserved.
    expect(usRuntime.shutdown).not.toHaveBeenCalled();
    expect(mockBootstrapInbox).not.toHaveBeenCalled();
    expect(engineHandle._inboxRuntime).toBe(usRuntime);
    expect(engineHandle._inboxLlmRegion).toBe('us');
  });

  /**
   * C. Bootstrap-disabled regression:
   *   When `unified-inbox` is NOT enabled (`_inboxRuntime` stays null),
   *   the propagation path must be a no-op — no crash, no spurious
   *   bootstrap. This guards the null-tolerance contract the punch-list
   *   explicitly flags.
   */
  it('is a no-op when _inboxRuntime is null (feature flag off / pre-init)', async () => {
    const config: LynoxConfig = { model: 'sonnet' };
    const engine = new Engine(config);
    // Leave _inboxRuntime + _mailStateDb at their default null.

    const mistralConfig: LynoxUserConfig = {
      provider: 'openai',
      api_base_url: 'https://api.mistral.ai/v1',
      openai_model_id: 'mistral-large-2512',
    };
    mockLoadConfig.mockReturnValueOnce(mistralConfig);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-mistral-new');

    await expect(engine.reloadCredentials()).resolves.toBeUndefined();
    const engineHandle = engine as unknown as {
      _inboxRuntime: MockRuntime | null;
      _inboxRebootstrapInflight: Promise<void> | null;
    };
    if (engineHandle._inboxRebootstrapInflight) {
      await engineHandle._inboxRebootstrapInflight;
    }
    expect(mockBootstrapInbox).not.toHaveBeenCalled();
    expect(engineHandle._inboxRuntime).toBeNull();
  });

  /**
   * D. Drain-window privacy guard (H-012 follow-up):
   *   While `_rebootstrapInboxOnProviderSwitch` is mid-flight (`await
   *   old.shutdown()` can take ~30s in production), new mail arriving
   *   via the MailContext watcher must NOT fire into the OLD US-bound
   *   runtime closure — that would be a GDPR Art. 44+ transfer for a
   *   user who explicitly opted into EU residency. The engine flips
   *   `_inboxClassifierSuspended` before the await; the hook wrapper
   *   short-circuits while it is set. After the new runtime is wired
   *   the flag clears and the new (EU) hook serves normally. Mail
   *   stays unread on the server so the next polling cycle still
   *   classifies it — no dropped mail.
   */
  it('suspends classifier during rebootstrap drain window (privacy-residency guarantee)', async () => {
    process.env['MISTRAL_API_KEY'] = 'sk-mistral-test';
    const config: LynoxConfig = { model: 'sonnet' };
    const engine = new Engine(config);

    const usRuntime = makeRuntime('us-runtime');
    const mockMailStateDb = { __sentinel: 'mail-db' } as unknown as
      import('../integrations/mail/state.js').MailStateDb;

    // Fake MailContext so the engine wires the suspension-aware hook
    // wrapper into `hooks.onInboundMail` like the production path does.
    const fakeMailContext = {
      hooks: {} as {
        onInboundMail?: (
          accountId: string,
          envelope: import('../integrations/mail/context.js').MailEnvelope,
        ) => Promise<void>;
        onAccountAdded?: (
          accountId: string,
          provider: unknown,
        ) => Promise<void>;
      },
    };

    const engineHandle = engine as unknown as {
      _inboxRuntime: MockRuntime | null;
      _mailStateDb: typeof mockMailStateDb | null;
      _inboxLlmRegion: 'us' | 'eu' | null;
      _inboxRebootstrapInflight: Promise<void> | null;
      _inboxClassifierSuspended: boolean;
      _mailContext: typeof fakeMailContext | null;
    };
    engineHandle._inboxRuntime = usRuntime;
    engineHandle._mailStateDb = mockMailStateDb;
    engineHandle._inboxLlmRegion = 'us';
    engineHandle._mailContext = fakeMailContext;

    // Hold the EU rebootstrap mid-flight with a deferred Promise on the
    // OLD runtime's `shutdown()` call. The `await old.shutdown()` in
    // `_rebootstrapInboxOnProviderSwitch` will block on this until we
    // resolve it manually below.
    let resolveShutdown!: () => void;
    const shutdownDeferred = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    usRuntime.shutdown.mockReturnValueOnce(shutdownDeferred);

    const euRuntime = makeRuntime('eu-runtime');
    mockBootstrapInbox.mockReturnValueOnce(euRuntime);

    // Trigger the cross-region switch — fire-and-forget; do NOT await
    // the inflight yet, because we want to probe the drain window.
    const mistralConfig: LynoxUserConfig = {
      provider: 'openai',
      api_base_url: 'https://api.mistral.ai/v1',
      openai_model_id: 'mistral-large-2512',
    };
    mockLoadConfig.mockReturnValueOnce(mistralConfig);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-mistral-new');

    await engine.reloadCredentials();
    // At this point the rebootstrap is mid-flight, blocked on
    // `shutdownDeferred`. Yield once so the microtask queue advances
    // past the `_inboxClassifierSuspended = true` assignment.
    await Promise.resolve();
    expect(engineHandle._inboxClassifierSuspended).toBe(true);

    // Mid-flight: the MailContext still has the OLD hook attached
    // (rebootstrap hasn't reached the rewire line yet). If the hook
    // wrapper from the cold-boot path is installed, it must respect
    // the suspension flag — but in this test the engine entered via
    // the rebootstrap path with no cold-boot wire-up first, so the
    // mail context hook is still empty at this point. Simulate the
    // production reality where a cold-boot installed the wrapper by
    // installing it manually pointing at the OLD runtime:
    const mockMail = {
      messageId: 'm-1',
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 'mid-flight',
      bodyText: '',
      receivedAt: new Date().toISOString(),
    } as unknown as import('../integrations/mail/context.js').MailEnvelope;
    fakeMailContext.hooks.onInboundMail = async (accountId, envelope) => {
      if (engineHandle._inboxClassifierSuspended) return;
      return usRuntime.hook(accountId, envelope);
    };
    await fakeMailContext.hooks.onInboundMail('acct-1', mockMail);
    // OLD US runtime must NOT have been invoked — privacy guarantee.
    expect(usRuntime.hook).not.toHaveBeenCalled();

    // Release the drain. Rebootstrap completes, suspension clears,
    // new EU hook wraps the new runtime.
    resolveShutdown();
    if (engineHandle._inboxRebootstrapInflight) {
      await engineHandle._inboxRebootstrapInflight;
    }
    expect(engineHandle._inboxClassifierSuspended).toBe(false);
    expect(engineHandle._inboxRuntime).toBe(euRuntime);

    // Post-rebootstrap: the MailContext.hook is the suspension-aware
    // wrapper around the NEW (EU) runtime. Invoke it — the EU runtime
    // must now receive the mail.
    const mockMail2 = { ...mockMail, messageId: 'm-2' } as
      import('../integrations/mail/context.js').MailEnvelope;
    await fakeMailContext.hooks.onInboundMail?.('acct-1', mockMail2);
    expect(euRuntime.hook).toHaveBeenCalledTimes(1);
    expect(euRuntime.hook).toHaveBeenCalledWith('acct-1', mockMail2);
    // OLD US runtime never saw anything across the entire flow.
    expect(usRuntime.hook).not.toHaveBeenCalled();
  });
});
