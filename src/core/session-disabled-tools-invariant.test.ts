/**
 * P1-PR-D: disabled_tools invariant — narrow-only, never widens.
 *
 * Pins the semantic invariant in `session.ts:957` (the `_createAgent` merge):
 *
 *   excludeTools: [
 *     ...(userConfig.disabled_tools ?? []),
 *     ...(this.agentOverrides.excludeTools ?? []),
 *   ]
 *
 * Property under test: the resulting Agent `excludeTools` is the *union* of
 * `userConfig.disabled_tools` (set in Settings → Privacy → Tool-Toggles) and
 * the session-level `agentOverrides.excludeTools` (e.g. spawn-agent isolation,
 * pipeline child agents). The merge MUST be a pure union — neither side can
 * narrow the other, neither side can re-enable a tool the other disabled.
 *
 * Why this matters (PRD-IA-CONSOLIDATION-V2 Round-1 Security finding S7):
 * The Tool-Toggles UI ships server-side enforcement: a disabled tool is never
 * passed to the Agent, so a prompt-injected agent cannot call it. A future
 * refactor that silently widens (e.g. by switching to a Set-difference, by
 * branching on `agentOverrides.excludeTools.length === 0`, or by adding an
 * `enable_tools` field that opens the gate) would defeat this guarantee.
 * These tests must fail noisily for any such drift.
 *
 * Test strategy: a real Engine + Session, with Agent + heavy dependencies
 * mocked so we can inspect the Agent constructor's `excludeTools` argument.
 * The `loadConfig` shim is the only seam needed to inject controlled
 * `disabled_tools` per-test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mocks ===

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.beta = { messages: { stream: vi.fn() } };
    // @ts-expect-error mock constructor
    this.messages = { batches: { create: vi.fn(), retrieve: vi.fn(), results: vi.fn() } };
  }),
}));

vi.mock('./agent.js', () => ({
  Agent: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.send = vi.fn().mockResolvedValue('response');
    // @ts-expect-error mock constructor
    this.reset = vi.fn();
    // @ts-expect-error mock constructor
    this.abort = vi.fn();
    // @ts-expect-error mock constructor
    this.getMessages = vi.fn().mockReturnValue([]);
    // @ts-expect-error mock constructor
    this.loadMessages = vi.fn();
    // @ts-expect-error mock constructor
    this.setContinuationPrompt = vi.fn();
    // @ts-expect-error mock constructor
    this.setKnowledgeContext = vi.fn();
    // @ts-expect-error mock constructor
    this.setBriefing = vi.fn();
    // @ts-expect-error mock constructor
    this.setEffort = vi.fn();
    // @ts-expect-error mock constructor
    this.setThinking = vi.fn();
    // @ts-expect-error mock constructor
    this.promptUser = undefined;
    // @ts-expect-error mock constructor
    this.promptTabs = undefined;
    // @ts-expect-error mock constructor
    this.onStream = null;
    // @ts-expect-error mock constructor
    this.name = 'lynox';
    // @ts-expect-error mock constructor
    this.model = 'claude-sonnet-4-6';
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
  dataStoreDropTool: { definition: { name: 'data_store_drop' }, handler: vi.fn() },
  artifactSaveTool: { definition: { name: 'artifact_save' }, handler: vi.fn() },
  artifactListTool: { definition: { name: 'artifact_list' }, handler: vi.fn() },
  artifactDeleteTool: { definition: { name: 'artifact_delete' }, handler: vi.fn() },
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
    this.tools = vi.fn().mockReturnValue([]);
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
    this.listCollections = vi.fn().mockReturnValue([]);
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

vi.mock('./run-history.js', () => ({
  RunHistory: vi.fn().mockImplementation(function () {
    // @ts-expect-error mock constructor
    this.insertRun = vi.fn().mockReturnValue('run-123');
    // @ts-expect-error mock constructor
    this.insertPromptSnapshot = vi.fn();
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

// `loadConfig()` is the seam through which we inject `disabled_tools` for each
// test. We mock the module up-front and then re-assign the implementation per
// test via the local `currentUserConfig` reference. Importantly:
//   - `disabled_tools` lives on LynoxUserConfig (loaded from disk in prod), NOT
//     on LynoxConfig (Engine constructor arg). The Engine reads it via
//     `loadConfig()` in its constructor, so mocking this is the cleanest way
//     to drive the merge under test without writing temp config files.
//   - `saveUserConfig` is also mocked to a no-op so any code path that writes
//     back during the run doesn't try to touch disk.
import type { LynoxUserConfig } from '../types/index.js';
let currentUserConfig: LynoxUserConfig = {};

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    loadConfig: vi.fn(() => currentUserConfig),
    reloadConfig: vi.fn(),
    saveUserConfig: vi.fn(),
  };
});

import { Engine } from './engine.js';
import { Agent } from './agent.js';

// === Helpers ===

type AgentCtorCall = { excludeTools?: string[] | undefined };
const agentCtor = Agent as unknown as { mock: { calls: Array<Array<AgentCtorCall>> } };

async function createEngineWithDisabledTools(disabledTools: string[] | undefined): Promise<Engine> {
  currentUserConfig = disabledTools === undefined ? {} : { disabled_tools: disabledTools };
  const engine = new Engine({} as import('../types/index.js').LynoxConfig);
  await engine.init();
  return engine;
}

function lastAgentExcludeTools(): readonly string[] {
  const lastCall = agentCtor.mock.calls.at(-1);
  expect(lastCall, 'Agent constructor was never called').toBeDefined();
  const config = lastCall![0];
  expect(config, 'Agent ctor config arg missing').toBeDefined();
  return config!.excludeTools ?? [];
}

// === Tests ===

describe('disabled_tools invariant: narrow-only, never widens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegister.mockReturnThis();
    mockRegisterMCP.mockReturnThis();
    currentUserConfig = {};
  });

  // -- Positive: each side independently narrows the tool surface --

  it('userConfig.disabled_tools alone propagates into Agent.excludeTools', async () => {
    // Settings → Privacy → Tool-Toggles disables mail_send.
    // Session has no agentOverrides.excludeTools (default session).
    const engine = await createEngineWithDisabledTools(['mail_send']);
    engine.createSession(); // Agent is constructed by Session, not by Engine.init()
    const exclude = lastAgentExcludeTools();
    expect(exclude).toContain('mail_send');
  });

  it('agentOverrides.excludeTools alone propagates into Agent.excludeTools', async () => {
    // No user-level Tool-Toggles, but a session-level isolation excludes
    // mail_send (e.g. an isolated researcher sub-agent).
    const engine = await createEngineWithDisabledTools(undefined);
    const session = engine.createSession();
    session._recreateAgent({ excludeTools: ['mail_send'] });
    const exclude = lastAgentExcludeTools();
    expect(exclude).toContain('mail_send');
  });

  // -- The S7 invariant: empty disabled_tools does NOT widen the surface --

  it('empty disabled_tools cannot re-enable a session-excluded tool', async () => {
    // S7 core property: an empty `disabled_tools` array on the user config
    // must not act as an enable-list. If a future refactor changed the merge
    // from union to "user-list overrides session-list when non-empty/empty",
    // this test would fail.
    const engine = await createEngineWithDisabledTools([]);
    const session = engine.createSession();
    session._recreateAgent({ excludeTools: ['mail_send'] });
    const exclude = lastAgentExcludeTools();
    expect(exclude).toContain('mail_send');
  });

  it('undefined disabled_tools cannot re-enable a session-excluded tool', async () => {
    // Same property as above but for `disabled_tools === undefined`, the
    // shape a fresh `~/.lynox/config.json` (or a managed user who never
    // touched the Tool-Toggles UI) produces.
    const engine = await createEngineWithDisabledTools(undefined);
    const session = engine.createSession();
    session._recreateAgent({ excludeTools: ['mail_send'] });
    const exclude = lastAgentExcludeTools();
    expect(exclude).toContain('mail_send');
  });

  it('empty session excludeTools cannot re-enable a user-disabled tool', async () => {
    // Inverse direction of S7: a session with no `excludeTools` override
    // (the default) must still honour the user's Tool-Toggles. This catches
    // the "session-override wins" refactor anti-pattern.
    const engine = await createEngineWithDisabledTools(['mail_send']);
    const session = engine.createSession();
    session._recreateAgent({}); // explicit no-op recreate, mirrors setModel/setEffort flow
    const exclude = lastAgentExcludeTools();
    expect(exclude).toContain('mail_send');
  });

  // -- Union semantics: both sides combine, neither subtracts --

  it('merge is a union of both sides (concat, no de-duplication required)', async () => {
    // The merge is a plain concat. We assert UNION semantics — every name
    // from either side appears in the result. We do NOT pin de-duplication
    // (the Agent rebuilds a Set anyway, so the source array can carry
    // duplicates without behavioural impact).
    const engine = await createEngineWithDisabledTools(['mail_send', 'http_request']);
    const session = engine.createSession();
    session._recreateAgent({ excludeTools: ['spawn_agent', 'bash'] });
    const exclude = lastAgentExcludeTools();
    expect(new Set(exclude)).toEqual(new Set(['mail_send', 'http_request', 'spawn_agent', 'bash']));
  });

  it('overlapping entries on both sides keep the tool excluded (no cancellation)', async () => {
    // Defensive: the same tool name appearing on BOTH sides must not somehow
    // cancel out. Sanity check against a hypothetical XOR-style merge.
    const engine = await createEngineWithDisabledTools(['mail_send']);
    const session = engine.createSession();
    session._recreateAgent({ excludeTools: ['mail_send'] });
    const exclude = lastAgentExcludeTools();
    expect(exclude).toContain('mail_send');
  });

  // -- The hard property: tool surface only shrinks across recreations --

  it('a recreate with empty overrides cannot widen the surface beyond user config', async () => {
    // Simulates a setModel/setEffort flow on a managed tenant where the user
    // has disabled mail_send. Each _recreateAgent must re-emit the user's
    // disabled list — a regression that dropped the userConfig read would
    // silently re-enable mail_send mid-session.
    const engine = await createEngineWithDisabledTools(['mail_send']);
    const session = engine.createSession();

    // Initial agent (created during engine.createSession()) carries the
    // user-disabled list.
    const initialExclude = lastAgentExcludeTools();
    expect(initialExclude).toContain('mail_send');

    // Now recreate (e.g. user changed model) — same constraint must hold.
    session._recreateAgent({});
    const afterRecreateExclude = lastAgentExcludeTools();
    expect(afterRecreateExclude).toContain('mail_send');
  });

  it('successive recreations with different session overrides never re-enable user disables', async () => {
    // Long-running session where multiple sub-agent isolations come and go.
    // Even after a recreate that clears excludeTools, the user's
    // Tool-Toggles must remain in force.
    const engine = await createEngineWithDisabledTools(['mail_send']);
    const session = engine.createSession();

    session._recreateAgent({ excludeTools: ['spawn_agent'] });
    expect(lastAgentExcludeTools()).toContain('mail_send');
    expect(lastAgentExcludeTools()).toContain('spawn_agent');

    session._recreateAgent({}); // session-level isolation lifted
    const exclude = lastAgentExcludeTools();
    expect(exclude).toContain('mail_send'); // user disable still in force
    expect(exclude).not.toContain('spawn_agent'); // session disable correctly lifted
  });
});
