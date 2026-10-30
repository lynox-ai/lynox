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
const pool = vi.hoisted(() => ({ on: false }));
vi.mock('./llm/provider-keys.js', () => ({
  resolveProviderApiKey: (opts: unknown) => mockResolveProviderApiKey(opts),
  poolSuppliesLLMKeys: () => pool.on,
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
  calendarReadTool: { definition: { name: 'calendar_read' }, handler: vi.fn() },
  CALENDAR_FEED_PREFIX: 'CALENDAR_FEED_',
  suggestFollowUpsTool: { name: 'suggest_follow_ups' },
}));

vi.mock('./tool-context.js', () => ({
  createToolContext: vi.fn().mockReturnValue({}),
  // A reload re-applies the egress settings onto the ToolContext.
  applyEnforceHttps: vi.fn(),
  applyNetworkPolicy: vi.fn(),
}));

// Inbox bootstrap mock — every call returns a fresh sentinel runtime
// shaped like InboxRuntime (only the fields the engine touches).
const mockBootstrapInbox = vi.fn();
vi.mock('../integrations/inbox/bootstrap.js', () => ({
  bootstrapInbox: (opts: unknown) => mockBootstrapInbox(opts),
}));

import { Engine, RESTORE_INBOX_BOUND_MS, SHUTDOWN_INBOX_CLASSIFY_MS, SHUTDOWN_INBOX_CUTOFF_MS } from './engine.js';
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
    pool.on = false;
  });

  /** Switches the engine from Anthropic to Mistral, so the inbox is bootstrapped again for the EU
   *  region, with `vault` as the secret store; returns the options that bootstrap got. */
  async function rebootstrapToEu(vault: Record<string, string>): Promise<{ mistralApiKey?: string; meteredHost?: unknown; engine: Engine }> {
    const engine = new Engine({ model: 'balanced' });
    const handle = engine as unknown as {
      _inboxRuntime: MockRuntime | null; _mailStateDb: unknown; _inboxLlmRegion: 'us' | 'eu' | null;
      _inboxRebootstrapInflight: Promise<void> | null; secretStore: { resolve(n: string): string | null } | null;
    };
    handle._inboxRuntime = makeRuntime('us-runtime');
    handle._mailStateDb = { __sentinel: 'mail-db' };
    handle._inboxLlmRegion = 'us';
    handle.secretStore = { resolve: (n) => vault[n] ?? null };
    mockBootstrapInbox.mockReturnValueOnce(makeRuntime('eu-runtime'));
    mockLoadConfig.mockReturnValueOnce({ provider: 'openai', api_base_url: 'https://api.mistral.ai/v1', openai_model_id: 'mistral-large-2512' });
    mockResolveProviderApiKey.mockReturnValueOnce('sk-mistral-new');
    await engine.reloadCredentials();
    if (handle._inboxRebootstrapInflight) await handle._inboxRebootstrapInflight;
    expect(mockBootstrapInbox).toHaveBeenCalledTimes(1);
    return { ...(mockBootstrapInbox.mock.calls[0]![0] as { mistralApiKey?: string; meteredHost?: unknown }), engine };
  }

  describe('the EU classifier on a pool tier: which Mistral key, and whether the instance is debited', () => {
    it('uses the pool\'s key, not the user\'s own vault key, and debits the instance', async () => {
      pool.on = true;
      process.env['MISTRAL_API_KEY'] = 'sk-pool';
      const opts = await rebootstrapToEu({ MISTRAL_API_KEY: 'sk-own' });
      expect(opts.mistralApiKey).toBe('sk-pool');
      expect(opts.meteredHost).toBe(opts.engine);
    });

    it('uses a key set for the inbox on purpose, and does not debit the instance for it', async () => {
      pool.on = true;
      process.env['MISTRAL_API_KEY'] = 'sk-pool';
      const opts = await rebootstrapToEu({ LYNOX_INBOX_MISTRAL_API_KEY: 'sk-inbox' });
      expect(opts.mistralApiKey).toBe('sk-inbox');
      expect(opts.meteredHost, 'the user already pays Mistral').toBeUndefined();
    });

    it('the US classifier, on the pool\'s Anthropic client, is debited as before', async () => {
      pool.on = true;
      const engine = new Engine({ model: 'balanced' });
      const handle = engine as unknown as {
        _inboxRuntime: MockRuntime | null; _mailStateDb: unknown; _inboxLlmRegion: 'us' | 'eu' | null;
        _inboxRebootstrapInflight: Promise<void> | null;
      };
      handle._inboxRuntime = makeRuntime('eu-runtime');
      handle._mailStateDb = { __sentinel: 'mail-db' };
      handle._inboxLlmRegion = 'eu';
      mockBootstrapInbox.mockReturnValueOnce(makeRuntime('us-runtime'));
      mockLoadConfig.mockReturnValueOnce({ provider: 'anthropic' });
      await engine.reloadCredentials();
      if (handle._inboxRebootstrapInflight) await handle._inboxRebootstrapInflight;
      const opts = mockBootstrapInbox.mock.calls[0]![0] as { llmRegion: string; meteredHost?: unknown };
      expect(opts.llmRegion).toBe('us');
      expect(opts.meteredHost).toBe(engine);
    });

    it('the US classifier off a pool tier, on the user\'s own client, is not debited', async () => {
      const engine = new Engine({ model: 'balanced' });
      const handle = engine as unknown as {
        _inboxRuntime: MockRuntime | null; _mailStateDb: unknown; _inboxLlmRegion: 'us' | 'eu' | null;
        _inboxRebootstrapInflight: Promise<void> | null;
      };
      handle._inboxRuntime = makeRuntime('eu-runtime');
      handle._mailStateDb = { __sentinel: 'mail-db' };
      handle._inboxLlmRegion = 'eu';
      mockBootstrapInbox.mockReturnValueOnce(makeRuntime('us-runtime'));
      mockLoadConfig.mockReturnValueOnce({ provider: 'anthropic' });
      await engine.reloadCredentials();
      if (handle._inboxRebootstrapInflight) await handle._inboxRebootstrapInflight;
      const opts = mockBootstrapInbox.mock.calls[0]![0] as { llmRegion: string; meteredHost?: unknown };
      expect(opts.llmRegion).toBe('us');
      expect(opts.meteredHost).toBeUndefined();
    });

    it('off a pool tier keeps the vault key first and debits nothing (control)', async () => {
      process.env['MISTRAL_API_KEY'] = 'sk-env';
      const opts = await rebootstrapToEu({ MISTRAL_API_KEY: 'sk-own' });
      expect(opts.mistralApiKey).toBe('sk-own');
      expect(opts.meteredHost).toBeUndefined();
    });
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
    const config: LynoxConfig = { model: 'balanced' };
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
    const config: LynoxConfig = { model: 'balanced' };
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
    const config: LynoxConfig = { model: 'balanced' };
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
    const config: LynoxConfig = { model: 'balanced' };
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

  /**
   * A migration restore's shutdown that meets a rebootstrap mid-drain: the old runtime's backlog
   * is drained the short way, so the rebootstrap settles instead of holding the restore for as
   * long as classifying the backlog takes.
   */
  async function engineMidRebootstrap(shortDrain: 'releases' | 'hangs'): Promise<{ engine: Engine; usRuntime: MockRuntime; releaseDrain: () => void }> {
    process.env['MISTRAL_API_KEY'] = 'sk-mistral-test';
    const engine = new Engine({ model: 'balanced' });
    const usRuntime = makeRuntime('us-runtime');
    const engineHandle = engine as unknown as {
      _inboxRuntime: MockRuntime | null;
      _mailStateDb: unknown;
      _inboxLlmRegion: 'us' | 'eu' | null;
      _inboxRebootstrapInflight: Promise<void> | null;
    };
    engineHandle._inboxRuntime = usRuntime;
    engineHandle._mailStateDb = { __sentinel: 'mail-db' };
    engineHandle._inboxLlmRegion = 'us';

    // The old runtime's plain drain holds (a backlog being classified); drained the short way it
    // releases the held drain too, as the queue does, unless its running jobs hang.
    let releaseDrain!: () => void;
    const heldDrain = new Promise<void>((resolve) => { releaseDrain = resolve; });
    usRuntime.shutdown.mockImplementation((opts?: { deadLetterBacklog?: boolean; within?: unknown }) => {
      if ((opts?.deadLetterBacklog === true || opts?.within !== undefined) && shortDrain === 'releases') { releaseDrain(); return Promise.resolve(); }
      return heldDrain;
    });
    mockBootstrapInbox.mockReturnValueOnce(makeRuntime('eu-runtime'));
    mockLoadConfig.mockReturnValueOnce({ provider: 'openai', api_base_url: 'https://api.mistral.ai/v1', openai_model_id: 'mistral-large-2512' } satisfies LynoxUserConfig);
    mockResolveProviderApiKey.mockReturnValueOnce('sk-mistral-new');
    await engine.reloadCredentials();
    await Promise.resolve();
    expect(engineHandle._inboxRebootstrapInflight, 'fixture: rebootstrap mid-drain').not.toBeNull();
    return { engine, usRuntime, releaseDrain };
  }

  it('a restore shutdown drains the runtime a rebootstrap is retiring the short way', async () => {
    const { engine, usRuntime, releaseDrain } = await engineMidRebootstrap('releases');
    try {
      const outcome = await Promise.race([
        engine.shutdown({ inboxBacklog: 'dead-letter' }).then(() => 'settled' as const),
        new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 2_000)),
      ]);
      expect(outcome, 'restore shutdown stuck behind the retiring runtime\'s plain drain').toBe('settled');
      expect(usRuntime.shutdown).toHaveBeenCalledWith({ deadLetterBacklog: true });
    } finally {
      releaseDrain();
    }
  });

  it('a signal shutdown gives the retiring and the live runtime one deadline: classify, then cut off', async () => {
    const { engine, usRuntime, releaseDrain } = await engineMidRebootstrap('releases');
    try {
      const before = Date.now();
      await engine.shutdown({ inboxBacklog: 'bounded' });
      const after = Date.now();
      const euRuntime = mockBootstrapInbox.mock.results[0]?.value as MockRuntime;
      const [retiring] = usRuntime.shutdown.mock.calls.find((c) => (c[0] as { within?: unknown } | undefined)?.within !== undefined) ?? [];
      const [live] = euRuntime.shutdown.mock.calls[0] ?? [];
      const within = (retiring as { within: { classifyUntil: number; cutOffAt: number } } | undefined)?.within;
      expect(within, 'retiring runtime not drained within the deadline').toBeDefined();
      expect(within!.classifyUntil).toBeGreaterThanOrEqual(before + SHUTDOWN_INBOX_CLASSIFY_MS);
      expect(within!.classifyUntil).toBeLessThanOrEqual(after + SHUTDOWN_INBOX_CLASSIFY_MS);
      expect(within!.cutOffAt - within!.classifyUntil).toBe(SHUTDOWN_INBOX_CUTOFF_MS - SHUTDOWN_INBOX_CLASSIFY_MS);
      // The live runtime shares the deadline; it does not start a new one after the rebootstrap.
      expect(live).toEqual({ within });
      // Classify first, then cut off; the deadlines themselves lie inside the container's 10 s grace.
      expect(SHUTDOWN_INBOX_CLASSIFY_MS).toBeLessThan(SHUTDOWN_INBOX_CUTOFF_MS);
      expect(SHUTDOWN_INBOX_CUTOFF_MS).toBeLessThan(10_000);
    } finally {
      releaseDrain();
    }
  });

  it('a retiring runtime whose running jobs hang ends the restore shutdown at the bound', async () => {
    const { engine, releaseDrain } = await engineMidRebootstrap('hangs');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let outcome: 'pending' | 'settled' | Error = 'pending';
      engine.shutdown({ inboxBacklog: 'dead-letter' }).then(() => { outcome = 'settled'; }, (err: unknown) => { outcome = err as Error; });
      await vi.advanceTimersByTimeAsync(RESTORE_INBOX_BOUND_MS);
      expect(outcome, 'retiring runtime\'s drain not under the bound').toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/inbox shutdown did not settle within 60 s/);
    } finally {
      vi.useRealTimers();
      releaseDrain();
    }
  });
});
