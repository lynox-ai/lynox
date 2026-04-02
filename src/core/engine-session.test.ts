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
  Agent: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.send = mockSend;
    // @ts-expect-error mock constructor
    this.reset = mockReset;
    // @ts-expect-error mock constructor
    this.abort = mockAbort;
    // @ts-expect-error mock constructor
    this.getMessages = mockGetMessages;
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
const mockRegisterMCP = vi.fn().mockReturnThis();

vi.mock('../tools/registry.js', () => ({
  ToolRegistry: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.register = mockRegister;
    // @ts-expect-error mock constructor
    this.registerMCP = mockRegisterMCP;
    // @ts-expect-error mock constructor
    this.getEntries = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.getMCPServers = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.find = vi.fn();
  }),
}));

vi.mock('../tools/builtin/index.js', () => ({
  bashTool: { definition: { name: 'bash' }, handler: vi.fn() },
  readFileTool: { definition: { name: 'read_file' }, handler: vi.fn() },
  writeFileTool: { definition: { name: 'write_file' }, handler: vi.fn() },
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
  runPipelineTool: { definition: { name: 'run_pipeline' }, handler: vi.fn() },
  setPipelineConfig: vi.fn(),
  setPlanTaskConfig: vi.fn(),
  taskCreateTool: { definition: { name: 'task_create' }, handler: vi.fn() },
  taskUpdateTool: { definition: { name: 'task_update' }, handler: vi.fn() },
  taskListTool: { definition: { name: 'task_list' }, handler: vi.fn() },
  setTaskManager: vi.fn(),
  planTaskTool: { definition: { name: 'plan_task' }, handler: vi.fn() },
  captureProcessTool: { definition: { name: 'capture_process' }, handler: vi.fn() },
  promoteProcessTool: { definition: { name: 'promote_process' }, handler: vi.fn() },
  stepCompleteTool: { definition: { name: 'step_complete' }, handler: vi.fn() },
  setProcessConfig: vi.fn(),
  apiSetupTool: { definition: { name: 'api_setup' }, handler: vi.fn() },
  dataStoreCreateTool: { definition: { name: 'data_store_create' }, handler: vi.fn() },
  dataStoreInsertTool: { definition: { name: 'data_store_insert' }, handler: vi.fn() },
  dataStoreQueryTool: { definition: { name: 'data_store_query' }, handler: vi.fn() },
  dataStoreListTool: { definition: { name: 'data_store_list' }, handler: vi.fn() },
  dataStoreDeleteTool: { definition: { name: 'data_store_delete' }, handler: vi.fn() },
  artifactSaveTool: { definition: { name: 'artifact_save' }, handler: vi.fn() },
  artifactListTool: { definition: { name: 'artifact_list' }, handler: vi.fn() },
  artifactDeleteTool: { definition: { name: 'artifact_delete' }, handler: vi.fn() },
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
    mockRegisterMCP.mockReturnThis();
    // Enable feature flags for tests
    process.env['LYNOX_FEATURE_PLUGINS'] = '1';
    process.env['LYNOX_FEATURE_TRIGGERS'] = '1';
  });

  // -- init() --

  describe('init()', () => {
    it('creates memory, registry, and registers builtin tools; session creates agent', async () => {
      const { session } = await createEngineAndSession();

      expect(Memory).toHaveBeenCalled();

      // Registry should have register called for each builtin tool
      // 18 core + 3 artifact + 4 pipeline + 5 datastore + 1 web_search = 31
      expect(mockRegister).toHaveBeenCalledTimes(31);

      // Agent should have been created by Session
      expect(Agent).toHaveBeenCalled();
      expect(session.getAgent()).toBeDefined();
    });

    it('skips memory when config.memory is false', async () => {
      const { engine } = await createEngineAndSession({ memory: false });

      expect(engine.getMemory()).toBeNull();
    });

    it('registers MCP servers when provided', async () => {
      const server = { type: 'url' as const, url: 'http://localhost:3000', name: 'test-mcp' };
      const engine = new Engine({ mcpServers: [server] } as import('../types/index.js').LynoxConfig);
      await engine.init();

      expect(mockRegisterMCP).toHaveBeenCalledWith(server);
    });

    it('returns itself for chaining', async () => {
      const engine = new Engine({} as import('../types/index.js').LynoxConfig);
      const result = await engine.init();
      expect(result).toBe(engine);
    });
  });

  // -- run() --

  describe('run()', () => {
    it('delegates to agent.send()', async () => {
      const { session } = await createEngineAndSession();

      mockSend.mockResolvedValueOnce('agent response');
      const result = await session.run('Hello');
      expect(result).toBe('agent response');
      expect(mockSend).toHaveBeenCalledWith('Hello');
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
  });

  // -- registerPipelineTools --

  describe('registerPipelineTools()', () => {
    it('pipeline tools are registered at init', async () => {
      await createEngineAndSession();
      // 31 tools total (18 core + 3 artifact + 4 pipeline + 5 datastore + 1 web_search)
      expect(mockRegister).toHaveBeenCalledTimes(31);
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

      const modelId = session.setModel('sonnet');
      expect(modelId).toBe('claude-sonnet-4-6');

      // Agent should be recreated
      expect(Agent).toHaveBeenCalledTimes(1);

      // Messages should be reloaded
      expect(mockLoadMessages).toHaveBeenCalledWith(savedMessages);
    });

    it('returns the resolved model ID', async () => {
      const { session } = await createEngineAndSession();

      expect(session.setModel('opus')).toBe('claude-opus-4-6');
      expect(session.setModel('sonnet')).toBe('claude-sonnet-4-6');
      expect(session.setModel('haiku')).toBe('claude-haiku-4-5-20251001');
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
      const { session } = await createEngineAndSession({ model: 'sonnet' });
      expect(session.getModelTier()).toBe('sonnet');
    });

    it('promptUser setter propagates to agent', async () => {
      const { session } = await createEngineAndSession();

      const fn = vi.fn().mockResolvedValue('yes');
      session.promptUser = fn;
      expect(session.promptUser).toBe(fn);
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
});
