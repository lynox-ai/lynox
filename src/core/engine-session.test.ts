import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

const mockBatchCreate = vi.fn().mockResolvedValue({ id: 'batch-abc' });

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.beta = { messages: { stream: vi.fn() } };
    // @ts-expect-error mock constructor
    this.messages = {
      batches: {
        create: mockBatchCreate,
        retrieve: vi.fn(),
        results: vi.fn(),
      },
    };
  }),
}));

const mockSend = vi.fn().mockResolvedValue('response');
const mockReset = vi.fn();
const mockAbort = vi.fn();
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockLoadMessages = vi.fn();
const mockSetContinuationPrompt = vi.fn();
const mockSetKnowledgeContext = vi.fn();

vi.mock('./agent.js', () => ({
  Agent: vi.fn().mockImplementation(function (config: { toolResultBlobStore?: unknown }) {
    // @ts-expect-error mock constructor — capture the Session-owned blob store
    // so compaction tests can assert recall round-trips through the real store.
    this.toolResultBlobStore = config?.toolResultBlobStore;
    // @ts-expect-error mock constructor
    this.send = mockSend;
    // @ts-expect-error mock constructor
    this.reset = mockReset;
    // @ts-expect-error mock constructor
    this.abort = mockAbort;
    // @ts-expect-error mock constructor
    this.getMessages = mockGetMessages;
    // @ts-expect-error mock constructor — mirrors the pre-PR1 char-estimate so
    // Session.getContextUsagePercent behaves identically under the mock.
    this.getEstimatedOccupancyTokens = () => JSON.stringify(mockGetMessages() ?? []).length / 3.5;
    // @ts-expect-error mock constructor
    this.loadMessages = mockLoadMessages;
    // @ts-expect-error mock constructor
    this.setContinuationPrompt = mockSetContinuationPrompt;
    // @ts-expect-error mock constructor
    this.setKnowledgeContext = mockSetKnowledgeContext;
    // @ts-expect-error mock constructor
    this.setBriefing = vi.fn();
    // @ts-expect-error mock constructor
    this.promptUser = undefined;
    // @ts-expect-error mock constructor
    this.promptTabs = undefined;
    // @ts-expect-error mock constructor
    this.onStream = null;
    // @ts-expect-error mock constructor
    this.name = 'lynox';
    // @ts-expect-error mock constructor
    this.model = 'claude-opus-4-6';
    // @ts-expect-error mock constructor
    this.memory = null;
    // @ts-expect-error mock constructor
    this.tools = [];
    // @ts-expect-error mock constructor
    this.setEffort = vi.fn();
    // @ts-expect-error mock constructor
    this.setThinking = vi.fn();
  }),
}));

vi.mock('./memory.js', () => ({
  Memory: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.load = vi.fn();
    // @ts-expect-error mock constructor
    this.save = vi.fn();
    // @ts-expect-error mock constructor
    this.append = vi.fn();
    // @ts-expect-error mock constructor
    this.render = vi.fn().mockReturnValue('');
    // @ts-expect-error mock constructor
    this.loadAll = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error mock constructor
    this.maybeUpdate = vi.fn();
    // @ts-expect-error mock constructor
    this.appendScoped = vi.fn();
    // @ts-expect-error mock constructor
    this.loadScoped = vi.fn().mockResolvedValue(null);
    // @ts-expect-error mock constructor
    this.deleteScoped = vi.fn().mockResolvedValue(0);
    // @ts-expect-error mock constructor
    this.updateScoped = vi.fn().mockResolvedValue(false);
    // @ts-expect-error mock constructor
    this.setActiveScopes = vi.fn();
    // @ts-expect-error mock constructor
    this.setAutoScope = vi.fn();
  }),
}));

vi.mock('./batch-index.js', () => ({
  BatchIndex: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.save = vi.fn();
    // @ts-expect-error mock constructor
    this.load = vi.fn();
    // @ts-expect-error mock constructor
    this.list = vi.fn();
  }),
}));

const mockRegister = vi.fn().mockReturnThis();

vi.mock('../tools/registry.js', () => ({
  ToolRegistry: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.register = mockRegister;
    // @ts-expect-error mock constructor
    this.getEntries = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.find = vi.fn();
  }),
}));

vi.mock('../tools/builtin/index.js', () => ({
  bashTool: { definition: { name: 'bash' }, handler: vi.fn() },
  readFileTool: { definition: { name: 'read_file' }, handler: vi.fn() },
  writeFileTool: { definition: { name: 'write_file' }, handler: vi.fn() },
  editFileTool: { definition: { name: 'edit_file' }, handler: vi.fn() },
  memoryStoreTool: { definition: { name: 'memory_store' }, handler: vi.fn() },
  memoryRecallTool: { definition: { name: 'memory_recall' }, handler: vi.fn() },
  memoryDeleteTool: { definition: { name: 'memory_delete' }, handler: vi.fn() },
  memoryUpdateTool: { definition: { name: 'memory_update' }, handler: vi.fn() },
  memoryListTool: { definition: { name: 'memory_list' }, handler: vi.fn() },
  memoryPromoteTool: { definition: { name: 'memory_promote' }, handler: vi.fn() },
  spawnAgentTool: { definition: { name: 'spawn_agent' }, handler: vi.fn() },
  askUserTool: { definition: { name: 'ask_user' }, handler: vi.fn() },
  askSecretTool: { definition: { name: 'ask_secret' }, handler: vi.fn() },
  batchFilesTool: { definition: { name: 'batch_files' }, handler: vi.fn() },
  httpRequestTool: { definition: { name: 'http_request' }, handler: vi.fn() },
  runWorkflowTool: { definition: { name: 'run_workflow' }, handler: vi.fn() },
  setPipelineConfig: vi.fn(),
  setPlanTaskConfig: vi.fn(),
  taskCreateTool: { definition: { name: 'task_create' }, handler: vi.fn() },
  taskUpdateTool: { definition: { name: 'task_update' }, handler: vi.fn() },
  taskListTool: { definition: { name: 'task_list' }, handler: vi.fn() },
  setTaskManager: vi.fn(),
  planTaskTool: { definition: { name: 'plan_task' }, handler: vi.fn() },
  saveWorkflowTool: { definition: { name: 'save_workflow' }, handler: vi.fn() },
  setProcessConfig: vi.fn(),
  apiSetupTool: { definition: { name: 'api_setup' }, handler: vi.fn() },
  dataStoreCreateTool: { definition: { name: 'data_store_create' }, handler: vi.fn() },
  dataStoreInsertTool: { definition: { name: 'data_store_insert' }, handler: vi.fn() },
  dataStoreQueryTool: { definition: { name: 'data_store_query' }, handler: vi.fn() },
  dataStoreListTool: { definition: { name: 'data_store_list' }, handler: vi.fn() },
  dataStoreDeleteTool: { definition: { name: 'data_store_delete' }, handler: vi.fn() },
  dataStoreDropTool: { definition: { name: 'data_store_drop' }, handler: vi.fn() },
  artifactSaveTool: { definition: { name: 'artifact_save' }, handler: vi.fn() },
  artifactListTool: { definition: { name: 'artifact_list' }, handler: vi.fn() },
  artifactDeleteTool: { definition: { name: 'artifact_delete' }, handler: vi.fn() },
  artifactHistoryTool: { definition: { name: 'artifact_history' }, handler: vi.fn() },
  artifactRestoreTool: { definition: { name: 'artifact_restore' }, handler: vi.fn() },
  recallToolResultTool: { definition: { name: 'recall_tool_result' }, handler: vi.fn() },
}));

vi.mock('../integrations/mail/state.js', () => ({
  MailStateDb: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.close = vi.fn();
  }),
}));

vi.mock('../integrations/mail/context.js', () => ({
  MailContext: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.init = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error mock constructor
    this.tools = vi.fn().mockReturnValue([
      { definition: { name: 'mail_search' }, handler: vi.fn() },
      { definition: { name: 'mail_read' }, handler: vi.fn() },
      { definition: { name: 'mail_send' }, handler: vi.fn() },
      { definition: { name: 'mail_reply' }, handler: vi.fn() },
      { definition: { name: 'mail_triage' }, handler: vi.fn() },
    ]);
    // @ts-expect-error mock constructor
    this.close = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('./changeset.js', () => ({
  ChangesetManager: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.active = true;
    // @ts-expect-error mock constructor
    this.backupBeforeWrite = vi.fn();
    // @ts-expect-error mock constructor
    this.hasChanges = vi.fn().mockReturnValue(false);
    // @ts-expect-error mock constructor
    this.getChanges = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.rollbackAll = vi.fn();
    // @ts-expect-error mock constructor
    this.acceptAll = vi.fn();
    // @ts-expect-error mock constructor
    this.cleanup = vi.fn();
  }),
}));

vi.mock('./task-manager.js', () => ({
  TaskManager: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.getBriefingSummary = vi.fn().mockReturnValue('');
    // @ts-expect-error mock constructor
    this.create = vi.fn();
    // @ts-expect-error mock constructor
    this.complete = vi.fn();
    // @ts-expect-error mock constructor
    this.update = vi.fn();
    // @ts-expect-error mock constructor
    this.list = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.getWeekSummary = vi.fn().mockReturnValue({ overdue: [], dueToday: [], dueThisWeek: [], inProgress: [] });
  }),
  setPipelineModeLookup: vi.fn(),
}));

vi.mock('./artifact-store.js', () => ({
  ArtifactStore: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.save = vi.fn();
    // @ts-expect-error mock constructor
    this.list = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.delete = vi.fn();
  }),
}));

vi.mock('./data-store.js', () => ({
  CRM_OVERLAP_NAMES: new Set(['contacts', 'companies', 'people', 'deals', 'interactions']),
  DataStore: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.listCollections = vi.fn().mockReturnValue([
      { name: 'test', scopeType: 'global', scopeId: '', recordCount: 1, updatedAt: '2026-01-01' },
    ]);
    // @ts-expect-error mock constructor
    this.createCollection = vi.fn();
    // @ts-expect-error mock constructor
    this.insertRecord = vi.fn();
    // @ts-expect-error mock constructor
    this.query = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.deleteCollection = vi.fn();
    // @ts-expect-error mock constructor
    this.dropEmptyCrmOverlaps = vi.fn().mockReturnValue([]);
  }),
}));

vi.mock('./embedding.js', () => ({
  createEmbeddingProvider: vi.fn().mockReturnValue({
    name: 'onnx',
    dimensions: 384,
    embed: vi.fn().mockResolvedValue(new Array(384).fill(0)),
  }),
}));

vi.mock('./project.js', () => ({
  detectProjectRoot: vi.fn().mockReturnValue({ root: '/mock/project', id: 'abc123def456' }),
  generateBriefing: vi.fn().mockReturnValue(''),
  buildFileManifest: vi.fn().mockReturnValue(new Map()),
  diffManifest: vi.fn().mockReturnValue({ added: [], modified: [], removed: [] }),
  formatManifestDiff: vi.fn().mockReturnValue(''),
  saveManifest: vi.fn(),
  loadManifest: vi.fn().mockReturnValue(null),
}));

const mockInsertRun = vi.fn().mockReturnValue('run-123');
const mockInsertPromptSnapshot = vi.fn();

vi.mock('./run-history.js', () => ({
  RunHistory: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.insertRun = mockInsertRun;
    // @ts-expect-error mock constructor
    this.insertPromptSnapshot = mockInsertPromptSnapshot;
    // @ts-expect-error mock constructor
    this.updateRun = vi.fn();
    // @ts-expect-error mock constructor
    this.insertToolCall = vi.fn();
    // @ts-expect-error mock constructor
    this.getEmbeddings = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.getEmbeddingsFiltered = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.getEmbeddingsMultiScopeFiltered = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.getEmbeddingsByScope = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.insertScope = vi.fn();
    // @ts-expect-error mock constructor
    this.getScope = vi.fn().mockReturnValue(null);
    // @ts-expect-error mock constructor
    this.listScopes = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.close = vi.fn();
    // @ts-expect-error mock constructor
    this.getDb = vi.fn().mockReturnValue({
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
      exec: vi.fn(),
      transaction: vi.fn().mockImplementation((fn: unknown) => fn),
    });
  }),
}));

import { Engine } from './engine.js';
import { Session } from './session.js';
import { Agent } from './agent.js';
import { Memory } from './memory.js';
// === Helper ===

async function createEngineAndSession(config: Record<string, unknown> = {}): Promise<{ engine: Engine; session: Session }> {
  const engine = new Engine(config as import('../types/index.js').LynoxConfig);
  await engine.init();
  const session = engine.createSession();
  return { engine, session };
}

// === Tests ===

describe('Engine + Session (Orchestrator)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMessages.mockReturnValue([]);
    mockRegister.mockReturnThis();
    // Enable feature flags for tests
    process.env['LYNOX_FEATURE_PLUGINS'] = '1';
    process.env['LYNOX_FEATURE_TRIGGERS'] = '1';
  });

  // -- init() --

  describe('init()', () => {
    it('creates memory, registry, and registers builtin tools; session creates agent', async () => {
      const { session } = await createEngineAndSession();

      expect(Memory).toHaveBeenCalled();

      // Registry should have register called for each builtin tool.
      // 32 builtin always (incl. edit_file); +1 `web_research` from the
      // DuckDuckGo HTML-scrape fallback that lands whenever SearXNG isn't
      // configured; +5 mail tools when vault is available.
      expect([35, 40]).toContain(mockRegister.mock.calls.length);

      // Agent should have been created by Session
      expect(Agent).toHaveBeenCalled();
      expect(session.getAgent()).toBeDefined();
    });

    it('skips memory when config.memory is false', async () => {
      const { engine } = await createEngineAndSession({ memory: false });

      expect(engine.getMemory()).toBeNull();
    });

    it('returns itself for chaining', async () => {
      const engine = new Engine({} as import('../types/index.js').LynoxConfig);
      const result = await engine.init();
      expect(result).toBe(engine);
    });
  });

  // -- run() --

  describe('run()', () => {
    it('delegates to agent.send() with a per-turn current-time prefix', async () => {
      const { session } = await createEngineAndSession();

      mockSend.mockResolvedValueOnce('agent response');
      const result = await session.run('Hello');
      expect(result).toBe('agent response');
      // Session prepends a `[Now: <iso>]` marker to every user message so the
      // model sees wallclock-accurate time even when the cached system prompt
      // is hour-truncated. See prompts.ts:withCurrentTimePrefix.
      expect(mockSend).toHaveBeenCalledWith(
        expect.stringMatching(/^\[Now: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]\n\nHello$/),
        { suppressTools: false },
      );
    });

    it('session always has an agent after construction', async () => {
      const { session } = await createEngineAndSession();
      expect(session.getAgent()).toBeDefined();
    });

    it('clears briefing after first successful turn', async () => {
      const { session } = await createEngineAndSession();

      // First run — briefing should be passed then cleared
      mockSend.mockResolvedValueOnce('first response');
      await session.run('first task');

      // Agent constructor should have been called with briefing initially
      const firstCallConfig = vi.mocked(Agent).mock.calls[0]![0];
      // Briefing is set during init, we just verify setBriefing was called
      const agent = session.getAgent();
      expect(agent).toBeDefined();
    });

    it('keeps the main agent on the configured tier — no per-turn auto-downgrade', async () => {
      // Regression: the removed _isSimpleTask heuristic downgraded the main
      // agent to Haiku for any task text < 25 chars. "gemini und search"
      // (17 chars) is a research follow-up — it must run on the configured tier,
      // not silently drop to Haiku and then run multi-step web research there.
      const { session } = await createEngineAndSession();
      expect(session.getModelTier()).toBe('balanced');

      vi.mocked(Agent).mockClear();
      mockSend.mockResolvedValueOnce('response');
      await session.run('gemini und search');

      expect(session.getModelTier()).toBe('balanced');
      // No Agent may be reconstructed with a downgraded Haiku model mid-run.
      const downgraded = vi.mocked(Agent).mock.calls.some(
        (call) => call[0]?.model?.includes('haiku') === true,
      );
      expect(downgraded).toBe(false);
    });

    it('keeps the configured tier for short factual-shaped queries', async () => {
      // The old heuristic also downgraded "zeig …" / "was ist …" lookups < 80 chars.
      const { session } = await createEngineAndSession();

      vi.mocked(Agent).mockClear();
      mockSend.mockResolvedValueOnce('response');
      await session.run('zeig mir die neuesten infos');

      expect(session.getModelTier()).toBe('balanced');
      const downgraded = vi.mocked(Agent).mock.calls.some(
        (call) => call[0]?.model?.includes('haiku') === true,
      );
      expect(downgraded).toBe(false);
    });

    it('exposes the completed run usage via getLastRunUsage()', async () => {
      // Regression (SSE-drop fallback): the `done` event echoes
      // getLastRunUsage() so the per-message footer survives a lost turn_end
      // frame. Null before any run; populated with the run summary after.
      const { session } = await createEngineAndSession();
      expect(session.getLastRunUsage()).toBeNull();

      mockSend.mockResolvedValueOnce('response');
      await session.run('hello');

      const usage = session.getLastRunUsage();
      expect(usage).not.toBeNull();
      expect(usage).toMatchObject({
        tokensIn: expect.any(Number),
        tokensOut: expect.any(Number),
        cacheRead: expect.any(Number),
        cacheWrite: expect.any(Number),
        costUsd: expect.any(Number),
        model: 'claude-sonnet-4-6',
      });
    });
  });

  // -- registerPipelineTools --

  describe('registerPipelineTools()', () => {
    it('pipeline tools are registered at init', async () => {
      await createEngineAndSession();
      // 32 builtin always (incl. edit_file); +1 `web_research` from the
      // DuckDuckGo HTML-scrape fallback that lands whenever SearXNG isn't
      // configured; +5 mail tools when vault is available.
      expect([35, 40]).toContain(mockRegister.mock.calls.length);
    });

    it('registerPipelineTools is idempotent after init', async () => {
      const { engine } = await createEngineAndSession();
      const countBefore = mockRegister.mock.calls.length;

      engine.registerPipelineTools();
      // No additional tools — already registered at init
      expect(mockRegister).toHaveBeenCalledTimes(countBefore);
    });

    it('is idempotent — second call is a no-op', async () => {
      const { engine } = await createEngineAndSession();

      engine.registerPipelineTools();
      const countAfterFirst = mockRegister.mock.calls.length;

      engine.registerPipelineTools();
      expect(mockRegister).toHaveBeenCalledTimes(countAfterFirst);
    });
  });

  // -- setModel / setEffort / setThinking --

  describe('setModel()', () => {
    it('preserves messages and recreates agent', async () => {
      const savedMessages = [{ role: 'user', content: 'old' }];
      mockGetMessages.mockReturnValue(savedMessages);

      const { session } = await createEngineAndSession();

      // Clear the initial Agent construction call
      vi.mocked(Agent).mockClear();

      const modelId = session.setModel('balanced');
      expect(modelId).toBe('claude-sonnet-4-6');

      // Agent should be recreated
      expect(Agent).toHaveBeenCalledTimes(1);

      // Messages should be reloaded
      expect(mockLoadMessages).toHaveBeenCalledWith(savedMessages);
    });

    it('returns the resolved model ID', async () => {
      const { session } = await createEngineAndSession();

      expect(session.setModel('deep')).toBe('claude-opus-4-6');
      expect(session.setModel('balanced')).toBe('claude-sonnet-4-6');
      expect(session.setModel('fast')).toBe('claude-haiku-4-5-20251001');
    });
  });

  describe('setEffort()', () => {
    it('preserves messages and recreates agent', async () => {
      const savedMessages = [{ role: 'user', content: 'keep' }];
      mockGetMessages.mockReturnValue(savedMessages);

      const { session } = await createEngineAndSession();
      vi.mocked(Agent).mockClear();

      session.setEffort('max');

      expect(Agent).toHaveBeenCalledTimes(1);
      expect(mockLoadMessages).toHaveBeenCalledWith(savedMessages);
      expect(session.getEffort()).toBe('max');
    });
  });

  describe('setThinking()', () => {
    it('preserves messages and recreates agent', async () => {
      const savedMessages = [{ role: 'user', content: 'think' }];
      mockGetMessages.mockReturnValue(savedMessages);

      const { session } = await createEngineAndSession();
      vi.mocked(Agent).mockClear();

      const mode = { type: 'enabled' as const, budget_tokens: 5000 };
      session.setThinking(mode);

      expect(Agent).toHaveBeenCalledTimes(1);
      expect(mockLoadMessages).toHaveBeenCalledWith(savedMessages);
      expect(session.getThinking()).toEqual(mode);
    });
  });

  // -- Other methods --

  describe('other methods', () => {
    it('reset() delegates to agent.reset()', async () => {
      const { session } = await createEngineAndSession();
      session.reset();
      expect(mockReset).toHaveBeenCalled();
    });

    it('abort() delegates to agent.abort()', async () => {
      const { session } = await createEngineAndSession();
      session.abort();
      expect(mockAbort).toHaveBeenCalled();
    });

    it('saveMessages() returns agent messages', async () => {
      const msgs = [{ role: 'user', content: 'hello' }];
      mockGetMessages.mockReturnValue(msgs);

      const { session } = await createEngineAndSession();
      expect(session.saveMessages()).toEqual(msgs);
    });

    it('loadMessages() passes messages to agent', async () => {
      const { session } = await createEngineAndSession();
      const msgs = [{ role: 'user', content: 'restored' }];
      session.loadMessages(msgs);
      expect(mockLoadMessages).toHaveBeenCalledWith(msgs);
    });

    it('shutdown() fires shutdown hooks', async () => {
      const mockShutdownHook = vi.fn().mockResolvedValue(undefined);
      const { engine, session } = await createEngineAndSession();
      engine.registerHooks({ async onShutdown() { await mockShutdownHook(); } });

      await session.shutdown();

      expect(mockShutdownHook).toHaveBeenCalled();
    });

    it('getModelTier() returns configured model', async () => {
      const { session } = await createEngineAndSession({ model: 'balanced' });
      expect(session.getModelTier()).toBe('balanced');
    });

    it('getContextUsagePercent honours agent.model — [1m] suffix unlocks 1M window', async () => {
      const { session } = await createEngineAndSession();
      const agentMock = (session as unknown as {
        agent: { model: string; getEstimatedOccupancyTokens: () => number };
      }).agent;
      agentMock.getEstimatedOccupancyTokens = () => 100_000;

      agentMock.model = 'claude-sonnet-4-6';
      expect(session.getContextUsagePercent()).toBe(50);

      agentMock.model = 'claude-sonnet-4-6[1m]';
      expect(session.getContextUsagePercent()).toBe(10);

      agentMock.model = 'claude-opus-4-6[1m]';
      expect(session.getContextUsagePercent()).toBe(10);
    });

    it('promptUser setter propagates to agent', async () => {
      const { session } = await createEngineAndSession();

      const fn = vi.fn().mockResolvedValue('yes');
      session.promptUser = fn;
      expect(session.promptUser).toBe(fn);
    });

    it('_recreateAgent preserves promptSecret set on the session', async () => {
      // Regression: session.run() can call _recreateAgent() (e.g. when the
      // changeset manager kicks in or the tool registry has changed). The
      // recreate path used to drop promptSecret because _createAgent did
      // not read it back from this._promptSecret — it only forwarded the
      // initial constructor arg. ask_secret then returned "Secure secret
      // input is not available in this context" on managed instances.
      const { Agent } = await import('./agent.js');
      const agentCtor = Agent as unknown as { mock: { calls: Array<Array<Record<string, unknown>>> } };

      const { session } = await createEngineAndSession();

      const fn = vi.fn().mockResolvedValue(true);
      session.promptSecret = fn;

      const callsBefore = agentCtor.mock.calls.length;
      session._recreateAgent();
      const ctorArgs = agentCtor.mock.calls[callsBefore]?.[0];
      expect(typeof ctorArgs?.['promptSecret']).toBe('function');
    });
  });

  describe('session ID', () => {
    it('generates a session ID on construction', async () => {
      const { session } = await createEngineAndSession();
      // sessionId is readonly on Session
      expect(session.sessionId).toBeDefined();
      expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('different sessions get different session IDs', async () => {
      const engine = new Engine({} as import('../types/index.js').LynoxConfig);
      await engine.init();
      const a = engine.createSession();
      const b = engine.createSession();
      expect(a.sessionId).not.toBe(b.sessionId);
    });
  });

  describe('batch()', () => {
    it('inserts promptHash on parent run', async () => {
      const { engine } = await createEngineAndSession();

      await engine.batch([{ id: 'r1', task: 'hello' }]);

      // Parent insertRun should have been called with a non-empty promptHash
      expect(mockInsertRun).toHaveBeenCalledWith(
        expect.objectContaining({
          runType: 'batch_parent',
          promptHash: expect.stringMatching(/^[a-f0-9]{16}$/),
        }),
      );
      // Snapshot should have been persisted
      expect(mockInsertPromptSnapshot).toHaveBeenCalledWith(
        expect.stringMatching(/^[a-f0-9]{16}$/),
        'default',
        expect.any(String),
      );
    });

    it('inserts promptHash on child runs', async () => {
      const { engine } = await createEngineAndSession();

      await engine.batch([
        { id: 'r1', task: 'task one' },
        { id: 'r2', task: 'task two' },
      ]);

      // Parent + 2 children = 3 insertRun calls
      expect(mockInsertRun).toHaveBeenCalledTimes(3);

      // All child calls should have matching promptHash and batch_item type
      const childCalls = mockInsertRun.mock.calls.filter(
        (c: unknown[]) => (c[0] as Record<string, unknown>).runType === 'batch_item',
      );
      expect(childCalls).toHaveLength(2);
      for (const call of childCalls) {
        expect((call[0] as Record<string, unknown>).promptHash).toMatch(/^[a-f0-9]{16}$/);
        expect((call[0] as Record<string, unknown>).batchParentId).toBe('run-123');
      }
    });
  });

  // -- registerHooks() --

  describe('registerHooks()', () => {
    it('calls onInit hook during init', async () => {
      const hook = { onInit: vi.fn().mockResolvedValue(undefined) };
      const engine = new Engine({} as import('../types/index.js').LynoxConfig);
      engine.registerHooks(hook);
      await engine.init();

      expect(hook.onInit).toHaveBeenCalledTimes(1);
      expect(hook.onInit).toHaveBeenCalledWith(engine);
    });

    it('calls multiple hooks in registration order', async () => {
      const order: number[] = [];
      const hook1 = { onInit: vi.fn().mockImplementation(async () => { order.push(1); }) };
      const hook2 = { onInit: vi.fn().mockImplementation(async () => { order.push(2); }) };

      const engine = new Engine({} as import('../types/index.js').LynoxConfig);
      engine.registerHooks(hook1);
      engine.registerHooks(hook2);
      await engine.init();

      expect(order).toEqual([1, 2]);
    });

    it('onInit error does not crash init', async () => {
      const hook = { onInit: vi.fn().mockRejectedValue(new Error('hook failed')) };
      const engine = new Engine({} as import('../types/index.js').LynoxConfig);
      engine.registerHooks(hook);

      // Should not throw
      await expect(engine.init()).resolves.toBe(engine);
    });

    it('calls onShutdown hook during shutdown', async () => {
      const hook = { onShutdown: vi.fn().mockResolvedValue(undefined) };
      const engine = new Engine({} as import('../types/index.js').LynoxConfig);
      engine.registerHooks(hook);
      await engine.init();
      await engine.shutdown();

      expect(hook.onShutdown).toHaveBeenCalledTimes(1);
    });

    it('onShutdown error does not crash shutdown', async () => {
      const hook = { onShutdown: vi.fn().mockRejectedValue(new Error('shutdown fail')) };
      const engine = new Engine({} as import('../types/index.js').LynoxConfig);
      engine.registerHooks(hook);
      await engine.init();

      // Should not throw
      await expect(engine.shutdown()).resolves.toBeUndefined();
    });
  });

  // -- compact() — Phase 2 Context Hygiene --

  describe('compact() recall blob store', () => {
    /** A history with one oversized + one small tool result. */
    function historyWithBigResult(bigChars = 6_000): unknown[] {
      return [
        { role: 'user', content: 'fetch the data' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-big', name: 'http_request', input: {} },
            { type: 'tool_use', id: 'tu-small', name: 'read_file', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-big', content: 'D'.repeat(bigChars) },
            { type: 'tool_result', tool_use_id: 'tu-small', content: 'tiny' },
          ],
        },
        { role: 'assistant', content: 'done' },
      ];
    }

    it('evicts a large tool result and lists a recall handle in the synthetic context', async () => {
      const { session } = await createEngineAndSession();
      mockGetMessages.mockReturnValue(historyWithBigResult());
      vi.spyOn(session, 'run').mockResolvedValue('SUMMARY TEXT');

      const result = await session.compact();
      expect(result.success).toBe(true);

      // The synthetic context handed to loadMessages must mention the handle.
      const synthetic = mockLoadMessages.mock.calls.at(-1)?.[0] as Array<{ content: unknown }>;
      const joined = JSON.stringify(synthetic);
      expect(joined).toContain('recall_tool_result');
      expect(joined).toContain('tr-1');
      expect(joined).toContain('http_request');
      // The small result is NOT promoted to a handle.
      expect(joined).not.toContain('read_file');
    });

    it('runs the summary with tools suppressed and frames it as an authoritative record', async () => {
      const { session } = await createEngineAndSession();
      mockSend.mockClear();
      mockLoadMessages.mockClear();
      // run() is NOT spied here — we want the real noTools threading through to send().
      mockSend.mockResolvedValueOnce('**Open task**: wait for the user to say "go"');

      const result = await session.compact();
      expect(result.success).toBe(true);
      // noTools wiring: the summarization turn must suppress ALL tools so the
      // summary comes back as text, never an artifact pointer.
      expect(mockSend).toHaveBeenCalledWith(expect.any(String), { suppressTools: true });
      // Framing: summary injected as an AUTHORITATIVE user record (ground truth),
      // not the agent's own un-backed assistant claim.
      const loaded = mockLoadMessages.mock.calls.at(-1)?.[0] as Array<{ role: string; content: string }>;
      expect(loaded[0]!.role).toBe('user');
      expect(loaded[0]!.content).toContain('FAITHFUL, AUTHORITATIVE record');
      expect(loaded[0]!.content).toContain('Open task');
    });

    it('recall_tool_result round-trips the evicted payload by id', async () => {
      const { session } = await createEngineAndSession();
      const payload = 'D'.repeat(6_000);
      mockGetMessages.mockReturnValue(historyWithBigResult());
      vi.spyOn(session, 'run').mockResolvedValue('SUMMARY');

      await session.compact();

      // The Session-owned blob store is captured on the mock Agent.
      const agent = session.getAgent() as unknown as {
        toolResultBlobStore?: import('./tool-result-blob-store.js').ToolResultBlobStore;
      };
      const store = agent.toolResultBlobStore!;
      expect(store.size).toBe(1);

      const { recallToolResultTool } = await import('../tools/builtin/recall-tool-result.js');
      const recalled = await recallToolResultTool.handler(
        { id: 'tr-1' },
        { toolResultBlobStore: store } as unknown as import('../types/index.js').IAgent,
      );
      expect(recalled).toBe(payload);
    });

    it('clears the store at the next compaction so an old handle is hard-dropped', async () => {
      const { session } = await createEngineAndSession();
      mockGetMessages.mockReturnValue(historyWithBigResult());
      vi.spyOn(session, 'run').mockResolvedValue('SUMMARY');

      await session.compact();
      const agent = session.getAgent() as unknown as {
        toolResultBlobStore?: import('./tool-result-blob-store.js').ToolResultBlobStore;
      };
      const store = agent.toolResultBlobStore!;
      expect(store.get('tr-1')).toBeDefined();

      // Second compaction with no large results — start-of-compact clear must
      // hard-drop the prior window's blob.
      mockGetMessages.mockReturnValue([{ role: 'assistant', content: 'short' }]);
      await session.compact();
      expect(store.get('tr-1')).toBeUndefined();
      expect(store.size).toBe(0);
    });

    it('honors a custom tool_result_blob_threshold_chars from userConfig', async () => {
      // 2 KB result — below the 4 KB default, above a 1 KB custom threshold.
      const { engine, session } = await createEngineAndSession();
      // userConfig is loaded from disk, not the engine ctor — mutate it directly.
      engine.getUserConfig().tool_result_blob_threshold_chars = 1_024;
      mockGetMessages.mockReturnValue(historyWithBigResult(2_048));
      vi.spyOn(session, 'run').mockResolvedValue('SUMMARY');

      await session.compact();
      const agent = session.getAgent() as unknown as {
        toolResultBlobStore?: import('./tool-result-blob-store.js').ToolResultBlobStore;
      };
      expect(agent.toolResultBlobStore!.size).toBe(1);

      // And with the default 4 KB threshold the same 2 KB result is left alone.
      delete engine.getUserConfig().tool_result_blob_threshold_chars;
    });

    it('does not add a recall block when no result exceeds the threshold', async () => {
      const { session } = await createEngineAndSession();
      mockGetMessages.mockReturnValue([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]);
      vi.spyOn(session, 'run').mockResolvedValue('SUMMARY');

      await session.compact();
      const synthetic = mockLoadMessages.mock.calls.at(-1)?.[0] as unknown[];
      // Just the 2 standard summary messages, no recall block.
      expect(synthetic).toHaveLength(2);
      expect(JSON.stringify(synthetic)).not.toContain('recall_tool_result');
    });
  });

  describe('compaction pressure: prepare-offer vs safety-net', () => {
    type AutoCompact = { _autoCompactIfNeeded(): Promise<void> };

    it('offers compaction ONCE in the prepare zone [80,90) and does NOT auto-compact', async () => {
      const { session } = await createEngineAndSession();
      const events: Array<{ type: string; usagePercent?: number }> = [];
      session.onStream = (e) => { events.push(e as { type: string }); return Promise.resolve(); };
      vi.spyOn(session, 'getContextUsagePercent').mockReturnValue(83);
      const compactSpy = vi.spyOn(session, 'compact');

      await (session as unknown as AutoCompact)._autoCompactIfNeeded();
      await (session as unknown as AutoCompact)._autoCompactIfNeeded(); // still 83% — must not re-offer

      const offers = events.filter(e => e.type === 'compaction_offer');
      expect(offers).toHaveLength(1);
      expect(offers[0]!.usagePercent).toBe(83);
      expect(compactSpy).not.toHaveBeenCalled();
    });

    it('re-arms the offer after usage drops back below the prepare threshold', async () => {
      const { session } = await createEngineAndSession();
      const events: Array<{ type: string }> = [];
      session.onStream = (e) => { events.push(e as { type: string }); return Promise.resolve(); };
      const usage = vi.spyOn(session, 'getContextUsagePercent');

      usage.mockReturnValue(82);
      await (session as unknown as AutoCompact)._autoCompactIfNeeded(); // offer #1
      usage.mockReturnValue(40);
      await (session as unknown as AutoCompact)._autoCompactIfNeeded(); // drop → re-arm
      usage.mockReturnValue(85);
      await (session as unknown as AutoCompact)._autoCompactIfNeeded(); // offer #2

      expect(events.filter(e => e.type === 'compaction_offer')).toHaveLength(2);
    });

    it('auto-compacts as a last-resort safety net at >=90% (with confirmScope)', async () => {
      const { session } = await createEngineAndSession();
      vi.spyOn(session, 'getContextUsagePercent').mockReturnValue(92);
      const compactSpy = vi.spyOn(session, 'compact').mockResolvedValue({ success: true, summary: 'S' });

      await (session as unknown as AutoCompact)._autoCompactIfNeeded();

      expect(compactSpy).toHaveBeenCalledWith(undefined, { confirmScope: true });
    });

    it('does nothing below the prepare threshold', async () => {
      const { session } = await createEngineAndSession();
      const events: Array<{ type: string }> = [];
      session.onStream = (e) => { events.push(e as { type: string }); return Promise.resolve(); };
      vi.spyOn(session, 'getContextUsagePercent').mockReturnValue(50);
      const compactSpy = vi.spyOn(session, 'compact');

      await (session as unknown as AutoCompact)._autoCompactIfNeeded();

      expect(events.filter(e => e.type === 'compaction_offer')).toHaveLength(0);
      expect(compactSpy).not.toHaveBeenCalled();
    });
  });
});
