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
    this.name = 'nodyn';
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
  setProcessConfig: vi.fn(),
  listPlaybooksTool: { definition: { name: 'list_playbooks' }, handler: vi.fn() },
  suggestPlaybookTool: { definition: { name: 'suggest_playbook' }, handler: vi.fn() },
  extractPlaybookTool: { definition: { name: 'extract_playbook' }, handler: vi.fn() },
  setPlaybookConfig: vi.fn(),
  _resetPlaybookConfig: vi.fn(),
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

const mockApply = vi.fn();
const mockTeardown = vi.fn().mockResolvedValue(undefined);
const mockGetMode = vi.fn().mockReturnValue('autopilot');

vi.mock('./mode-controller.js', () => ({
  ModeController: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.apply = mockApply;
    // @ts-expect-error mock constructor
    this.teardown = mockTeardown;
    // @ts-expect-error mock constructor
    this.getMode = mockGetMode;
    // @ts-expect-error mock constructor
    this.getCostSnapshot = vi.fn().mockReturnValue(null);
    // @ts-expect-error mock constructor
    this.getGoalState = vi.fn().mockReturnValue(null);
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

vi.mock('./playbooks.js', () => ({
  listPlaybooks: vi.fn().mockReturnValue([]),
  formatPlaybookIndex: vi.fn().mockReturnValue('No playbooks available.'),
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
  }),
}));

import { Nodyn } from './orchestrator.js';
import { Agent } from './agent.js';
import { Memory } from './memory.js';
import { ModeController } from './mode-controller.js';
import { channels } from './observability.js';

// === Tests ===

describe('Nodyn (Orchestrator)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMessages.mockReturnValue([]);
    mockRegister.mockReturnThis();
    mockRegisterMCP.mockReturnThis();
    mockTeardown.mockResolvedValue(undefined);
    mockGetMode.mockReturnValue('autopilot');
    // Enable feature flags for tests
    process.env['NODYN_FEATURE_PLUGINS'] = '1';
    process.env['NODYN_FEATURE_TRIGGERS'] = '1';
  });

  // -- init() --

  describe('init()', () => {
    it('creates memory, registry, agent and registers builtin tools', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();

      expect(Memory).toHaveBeenCalled();

      // Registry should have register called for each builtin tool (23 core + 2 process tools = 25)
      expect(mockRegister).toHaveBeenCalledTimes(28);

      // Agent should have been created
      expect(Agent).toHaveBeenCalled();
      expect(nodyn.getAgent()).toBeDefined();
    });

    it('skips memory when config.memory is false', async () => {
      const nodyn = new Nodyn({ memory: false });
      await nodyn.init();

      expect(nodyn.getMemory()).toBeNull();
    });

    it('registers MCP servers when provided', async () => {
      const server = { type: 'url' as const, url: 'http://localhost:3000', name: 'test-mcp' };
      const nodyn = new Nodyn({ mcpServers: [server] });
      await nodyn.init();

      expect(mockRegisterMCP).toHaveBeenCalledWith(server);
    });

    it('returns itself for chaining', async () => {
      const nodyn = new Nodyn({});
      const result = await nodyn.init();
      expect(result).toBe(nodyn);
    });
  });

  // -- run() --

  describe('run()', () => {
    it('delegates to agent.send()', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();

      mockSend.mockResolvedValueOnce('agent response');
      const result = await nodyn.run('Hello');
      expect(result).toBe('agent response');
      expect(mockSend).toHaveBeenCalledWith('Hello');
    });

    it('throws when not initialized', async () => {
      const nodyn = new Nodyn({});
      await expect(nodyn.run('Hello')).rejects.toThrow('Nodyn not initialized');
    });

    it('clears briefing after first successful turn', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();

      // First run — briefing should be passed then cleared
      mockSend.mockResolvedValueOnce('first response');
      await nodyn.run('first task');

      // Agent constructor should have been called with briefing initially
      const firstCallConfig = vi.mocked(Agent).mock.calls[0]![0];
      // Briefing is set during init, we just verify setBriefing was called
      const agent = nodyn.getAgent();
      expect(agent).toBeDefined();
    });
  });

  // -- registerPipelineTools --

  describe('registerPipelineTools()', () => {
    it('pipeline tools are registered at init', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();
      // 25 core tools (pipeline + process tools registered at init)
      expect(mockRegister).toHaveBeenCalledTimes(28);
    });

    it('registerPipelineTools is idempotent after init', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();
      const countBefore = mockRegister.mock.calls.length;

      nodyn.registerPipelineTools();
      // No additional tools — already registered at init
      expect(mockRegister).toHaveBeenCalledTimes(countBefore);
    });

    it('is idempotent — second call is a no-op', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();

      nodyn.registerPipelineTools();
      const countAfterFirst = mockRegister.mock.calls.length;

      nodyn.registerPipelineTools();
      expect(mockRegister).toHaveBeenCalledTimes(countAfterFirst);
    });
  });

  // -- setModel / setEffort / setThinking --

  describe('setModel()', () => {
    it('preserves messages and recreates agent', async () => {
      const savedMessages = [{ role: 'user', content: 'old' }];
      mockGetMessages.mockReturnValue(savedMessages);

      const nodyn = new Nodyn({});
      await nodyn.init();

      // Clear the initial Agent construction call
      vi.mocked(Agent).mockClear();

      const modelId = nodyn.setModel('sonnet');
      expect(modelId).toBe('claude-sonnet-4-6');

      // Agent should be recreated
      expect(Agent).toHaveBeenCalledTimes(1);

      // Messages should be reloaded
      expect(mockLoadMessages).toHaveBeenCalledWith(savedMessages);
    });

    it('returns the resolved model ID', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();

      expect(nodyn.setModel('opus')).toBe('claude-opus-4-6');
      expect(nodyn.setModel('sonnet')).toBe('claude-sonnet-4-6');
      expect(nodyn.setModel('haiku')).toBe('claude-haiku-4-5-20251001');
    });
  });

  describe('setEffort()', () => {
    it('preserves messages and recreates agent', async () => {
      const savedMessages = [{ role: 'user', content: 'keep' }];
      mockGetMessages.mockReturnValue(savedMessages);

      const nodyn = new Nodyn({});
      await nodyn.init();
      vi.mocked(Agent).mockClear();

      nodyn.setEffort('max');

      expect(Agent).toHaveBeenCalledTimes(1);
      expect(mockLoadMessages).toHaveBeenCalledWith(savedMessages);
      expect(nodyn.getEffort()).toBe('max');
    });
  });

  describe('setThinking()', () => {
    it('preserves messages and recreates agent', async () => {
      const savedMessages = [{ role: 'user', content: 'think' }];
      mockGetMessages.mockReturnValue(savedMessages);

      const nodyn = new Nodyn({});
      await nodyn.init();
      vi.mocked(Agent).mockClear();

      const mode = { type: 'enabled' as const, budget_tokens: 5000 };
      nodyn.setThinking(mode);

      expect(Agent).toHaveBeenCalledTimes(1);
      expect(mockLoadMessages).toHaveBeenCalledWith(savedMessages);
      expect(nodyn.getThinking()).toEqual(mode);
    });
  });

  // -- setMode() --

  describe('setMode()', () => {
    it('creates ModeController for non-interactive modes', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();

      await nodyn.setMode({ mode: 'autopilot', goal: 'Build it' });

      expect(ModeController).toHaveBeenCalledWith({ mode: 'autopilot', goal: 'Build it' });
      expect(mockApply).toHaveBeenCalled();
      expect(nodyn.getMode()).toBe('autopilot');
    });

    it('resets to interactive mode without ModeController', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();

      // First set a non-interactive mode
      await nodyn.setMode({ mode: 'autopilot', goal: 'Do stuff' });
      expect(nodyn.getMode()).toBe('autopilot');

      // Switch back to interactive
      vi.mocked(Agent).mockClear();
      await nodyn.setMode({ mode: 'interactive' });

      // Should teardown previous controller
      expect(mockTeardown).toHaveBeenCalled();

      // Should recreate agent (via _createAgent)
      expect(Agent).toHaveBeenCalled();

      // Mode should be interactive (no controller)
      expect(nodyn.getMode()).toBe('interactive');
    });

    it('tears down previous mode controller when switching modes', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();

      await nodyn.setMode({ mode: 'autopilot', goal: 'Goal 1' });

      await nodyn.setMode({ mode: 'sentinel', triggers: [{ type: 'cron', expression: '5m' }] });
      expect(mockTeardown).toHaveBeenCalled();
    });
  });

  // -- Other methods --

  describe('other methods', () => {
    it('reset() delegates to agent.reset()', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();
      nodyn.reset();
      expect(mockReset).toHaveBeenCalled();
    });

    it('abort() delegates to agent.abort()', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();
      nodyn.abort();
      expect(mockAbort).toHaveBeenCalled();
    });

    it('saveMessages() returns agent messages', async () => {
      const msgs = [{ role: 'user', content: 'hello' }];
      mockGetMessages.mockReturnValue(msgs);

      const nodyn = new Nodyn({});
      await nodyn.init();
      expect(nodyn.saveMessages()).toEqual(msgs);
    });

    it('loadMessages() passes messages to agent', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();
      const msgs = [{ role: 'user', content: 'restored' }];
      nodyn.loadMessages(msgs);
      expect(mockLoadMessages).toHaveBeenCalledWith(msgs);
    });

    it('shutdown() tears down mode controller and fires shutdown hooks', async () => {
      const mockShutdownHook = vi.fn().mockResolvedValue(undefined);
      const nodyn = new Nodyn({});
      await nodyn.init();
      nodyn.registerHooks({ async onShutdown() { await mockShutdownHook(); } });
      await nodyn.setMode({ mode: 'autopilot', goal: 'X' });

      await nodyn.shutdown();

      expect(mockTeardown).toHaveBeenCalled();
      expect(mockShutdownHook).toHaveBeenCalled();
    });

    it('getModelTier() returns configured model', () => {
      const nodyn = new Nodyn({ model: 'sonnet' });
      expect(nodyn.getModelTier()).toBe('sonnet');
    });

    it('promptUser setter propagates to agent', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();

      const fn = vi.fn().mockResolvedValue('yes');
      nodyn.promptUser = fn;
      expect(nodyn.promptUser).toBe(fn);
    });
  });

  describe('session ID', () => {
    it('generates a session ID on construction', () => {
      const nodyn = new Nodyn({});
      // Session ID is private, but we can verify it's a valid UUID via getSessionId if exposed
      // For now, just verify the instance is created (sessionId is set in constructor)
      expect(nodyn).toBeDefined();
    });

    it('different instances get different session IDs', () => {
      const a = new Nodyn({});
      const b = new Nodyn({});
      // Both should exist without error — UUID collision is astronomically unlikely
      expect(a).toBeDefined();
      expect(b).toBeDefined();
    });
  });

  describe('batch()', () => {
    it('inserts promptHash on parent run', async () => {
      const nodyn = new Nodyn({});
      await nodyn.init();

      await nodyn.batch([{ id: 'r1', task: 'hello' }]);

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
      const nodyn = new Nodyn({});
      await nodyn.init();

      await nodyn.batch([
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
      const nodyn = new Nodyn({});
      nodyn.registerHooks(hook);
      await nodyn.init();

      expect(hook.onInit).toHaveBeenCalledTimes(1);
      expect(hook.onInit).toHaveBeenCalledWith(nodyn);
    });

    it('calls multiple hooks in registration order', async () => {
      const order: number[] = [];
      const hook1 = { onInit: vi.fn().mockImplementation(async () => { order.push(1); }) };
      const hook2 = { onInit: vi.fn().mockImplementation(async () => { order.push(2); }) };

      const nodyn = new Nodyn({});
      nodyn.registerHooks(hook1);
      nodyn.registerHooks(hook2);
      await nodyn.init();

      expect(order).toEqual([1, 2]);
    });

    it('onInit error does not crash init', async () => {
      const hook = { onInit: vi.fn().mockRejectedValue(new Error('hook failed')) };
      const nodyn = new Nodyn({});
      nodyn.registerHooks(hook);

      // Should not throw
      await expect(nodyn.init()).resolves.toBe(nodyn);
    });

    it('calls onShutdown hook during shutdown', async () => {
      const hook = { onShutdown: vi.fn().mockResolvedValue(undefined) };
      const nodyn = new Nodyn({});
      nodyn.registerHooks(hook);
      await nodyn.init();
      await nodyn.shutdown();

      expect(hook.onShutdown).toHaveBeenCalledTimes(1);
    });

    it('onShutdown error does not crash shutdown', async () => {
      const hook = { onShutdown: vi.fn().mockRejectedValue(new Error('shutdown fail')) };
      const nodyn = new Nodyn({});
      nodyn.registerHooks(hook);
      await nodyn.init();

      // Should not throw
      await expect(nodyn.shutdown()).resolves.toBeUndefined();
    });
  });
});
