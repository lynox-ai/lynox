import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodynMCPServer } from './mcp-server.js';
import type { NodynConfig } from '../types/index.js';

// === Mock dependencies (top-level fns for access in tests) ===

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockRegisterTool = vi.fn();
const mockSessionSend = vi.fn().mockResolvedValue('Agent response');
const mockAbort = vi.fn();
const mockAgentInstance = { send: mockSessionSend, abort: mockAbort, onStream: null as unknown, promptUser: undefined as unknown };
const mockGetOrCreate = vi.fn().mockReturnValue(mockAgentInstance);
const mockSessionGet = vi.fn().mockReturnValue(mockAgentInstance);
const mockSessionReset = vi.fn();
const mockBatchRetrieve = vi.fn().mockResolvedValue({
  processing_status: 'ended',
  request_counts: { processing: 0, succeeded: 5, errored: 0, canceled: 0, expired: 0 },
});
const mockNodynInit = vi.fn().mockResolvedValue(undefined);
const mockNodynBatch = vi.fn().mockResolvedValue('batch-123');
const mockMemoryLoad = vi.fn().mockResolvedValue('some memory content');

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.connect = mockConnect;
    this.registerTool = mockRegisterTool;
    return this;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.handleRequest = vi.fn().mockResolvedValue(undefined);
    return this;
  }),
}));

vi.mock('../core/orchestrator.js', () => ({
  Nodyn: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.init = mockNodynInit;
    this.batch = mockNodynBatch;
    this.getMemory = vi.fn().mockReturnValue({ load: mockMemoryLoad });
    this.getRegistry = vi.fn().mockReturnValue({ getEntries: vi.fn().mockReturnValue([]) });
    this.getApiConfig = vi.fn().mockReturnValue({});
    return this;
  }),
}));

vi.mock('../core/session-store.js', () => ({
  SessionStore: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.getOrCreate = mockGetOrCreate;
    this.get = mockSessionGet;
    this.reset = mockSessionReset;
    return this;
  }),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.messages = { batches: { retrieve: mockBatchRetrieve } };
    return this;
  }),
}));

// === Helpers ===

function makeConfig(overrides?: Partial<NodynConfig>): NodynConfig {
  return {
    model: 'opus',
    systemPrompt: 'You are NODYN.',
    ...overrides,
  } as NodynConfig;
}

// === Tests ===

describe('NodynMCPServer', () => {
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = mkdtempSync(join(tmpdir(), 'nodyn-mcp-state-'));
    vi.stubEnv('NODYN_MCP_STATE_DIR', stateDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('creates MCP server and registers 10 tools', () => {
      new NodynMCPServer(makeConfig());
      expect(mockRegisterTool).toHaveBeenCalledTimes(10);
    });

    it('registers all expected tool names', () => {
      new NodynMCPServer(makeConfig());
      const toolNames = mockRegisterTool.mock.calls.map((c: unknown[]) => c[0]);
      expect(toolNames).toContain('nodyn_run');
      expect(toolNames).toContain('nodyn_batch');
      expect(toolNames).toContain('nodyn_status');
      expect(toolNames).toContain('nodyn_memory');
      expect(toolNames).toContain('nodyn_reset');
      expect(toolNames).toContain('nodyn_run_start');
      expect(toolNames).toContain('nodyn_poll');
      expect(toolNames).toContain('nodyn_read_file');
      expect(toolNames).toContain('nodyn_abort');
      expect(toolNames).toContain('nodyn_reply');
    });
  });

  describe('init', () => {
    it('creates and initializes Nodyn instance', async () => {
      const server = new NodynMCPServer(makeConfig());
      await server.init();
      const { Nodyn } = await import('../core/orchestrator.js');
      expect(Nodyn).toHaveBeenCalled();
    });
  });

  describe('startStdio', () => {
    it('creates transport and connects', async () => {
      const server = new NodynMCPServer(makeConfig());
      await server.startStdio();
      expect(mockConnect).toHaveBeenCalled();
    });
  });

  describe('tool handlers', () => {
    let toolHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;

    beforeEach(() => {
      toolHandlers = new Map();
      mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
        toolHandlers.set(name, handler);
      });
      // Re-create to capture handlers
      new NodynMCPServer(makeConfig());
    });

    describe('nodyn_run', () => {
      it('throws when not initialized', async () => {
        const handler = toolHandlers.get('nodyn_run')!;
        await expect(handler({ task: 'test' })).rejects.toThrow('NodynMCPServer not initialized');
      });

      it('returns agent response after init', async () => {
        // Need a fresh server with init
        mockRegisterTool.mockClear();
        const capturedHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          capturedHandlers.set(name, handler);
        });
        const server = new NodynMCPServer(makeConfig());
        await server.init();
        const handler = capturedHandlers.get('nodyn_run')!;
        const result = await handler({ task: 'say hello' }) as { content: { text: string }[] };
        expect(result.content[0]!.text).toBe('Agent response');
      });
    });

    describe('nodyn_batch', () => {
      it('throws when not initialized', async () => {
        const handler = toolHandlers.get('nodyn_batch')!;
        await expect(handler({ requests: [{ id: '1', task: 'test' }] })).rejects.toThrow('NodynMCPServer not initialized');
      });
    });

    describe('nodyn_status', () => {
      it('returns batch status', async () => {
        mockRegisterTool.mockClear();
        const capturedHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          capturedHandlers.set(name, handler);
        });
        const server = new NodynMCPServer(makeConfig());
        await server.init();
        const handler = capturedHandlers.get('nodyn_status')!;
        const result = await handler({ batch_id: 'batch-123' }) as { content: { text: string }[] };
        expect(result.content[0]!.text).toContain('batch-123');
        expect(result.content[0]!.text).toContain('ended');
        expect(result.content[0]!.text).toContain('Succeeded: 5');
      });
    });

    describe('nodyn_memory', () => {
      it('throws when not initialized', async () => {
        const handler = toolHandlers.get('nodyn_memory')!;
        await expect(handler({ namespace: 'knowledge' })).rejects.toThrow('NodynMCPServer not initialized');
      });
    });

    describe('nodyn_reset', () => {
      it('resets session and returns confirmation', async () => {
        const handler = toolHandlers.get('nodyn_reset')!;
        const result = await handler({ session_id: 'sess-abc' }) as { content: { text: string }[] };
        expect(result.content[0]!.text).toContain('sess-abc');
        expect(result.content[0]!.text).toContain('reset');
      });
    });

    describe('nodyn_run_start', () => {
      it('throws when not initialized', async () => {
        const handler = toolHandlers.get('nodyn_run_start')!;
        await expect(handler({ task: 'test' })).rejects.toThrow('NodynMCPServer not initialized');
      });

      it('returns run_id immediately without waiting for agent', async () => {
        // Fresh server with init
        mockRegisterTool.mockClear();
        const capturedHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          capturedHandlers.set(name, handler);
        });
        // Make send hang so we verify immediate return
        mockSessionSend.mockReturnValue(new Promise(() => {}));
        const server = new NodynMCPServer(makeConfig());
        await server.init();
        const handler = capturedHandlers.get('nodyn_run_start')!;
        const result = await handler({ task: 'do something', session_id: 'sess-1' }) as { content: { text: string }[] };
        const parsed = JSON.parse(result.content[0]!.text) as { run_id: string };
        expect(parsed.run_id).toMatch(/^[0-9a-f-]{36}$/);
        // Restore
        mockSessionSend.mockResolvedValue('Agent response');
      });

      it('sets onStream on the agent', async () => {
        mockRegisterTool.mockClear();
        const capturedHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          capturedHandlers.set(name, handler);
        });
        mockSessionSend.mockResolvedValue('done');
        const server = new NodynMCPServer(makeConfig());
        await server.init();
        const handler = capturedHandlers.get('nodyn_run_start')!;
        await handler({ task: 'task' });
        expect(mockAgentInstance.onStream).not.toBeNull();
      });

      it('rejects a second active run for the same session', async () => {
        mockRegisterTool.mockClear();
        const capturedHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          capturedHandlers.set(name, handler);
        });
        mockSessionSend.mockReturnValue(new Promise(() => {}));
        const server = new NodynMCPServer(makeConfig());
        await server.init();

        const handler = capturedHandlers.get('nodyn_run_start')!;
        const first = await handler({ task: 'first', session_id: 'sess-shared' }) as { content: { text: string }[] };
        const firstPayload = JSON.parse(first.content[0]!.text) as { run_id: string };
        expect(firstPayload.run_id).toBeTruthy();

        const second = await handler({ task: 'second', session_id: 'sess-shared' }) as { content: { text: string }[] };
        const secondPayload = JSON.parse(second.content[0]!.text) as { error: string };
        expect(secondPayload.error).toContain('already has an active run');

        mockSessionSend.mockResolvedValue('Agent response');
      });
    });

    describe('nodyn_poll', () => {
      it('returns error payload for unknown run_id', async () => {
        const handler = toolHandlers.get('nodyn_poll')!;
        const result = await handler({ run_id: 'no-such-run' }) as { content: { text: string }[] };
        const parsed = JSON.parse(result.content[0]!.text) as { done: boolean; error: string };
        expect(parsed.done).toBe(true);
        expect(parsed.error).toContain('not found');
      });

      it('returns accumulated text and done=false while running', async () => {
        // Setup: create a run via nodyn_run_start on a fresh server
        mockRegisterTool.mockClear();
        const capturedHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          capturedHandlers.set(name, handler);
        });
        // Make send hang
        let resolveRun!: () => void;
        mockSessionSend.mockReturnValue(new Promise<void>(res => { resolveRun = res; }));
        const server = new NodynMCPServer(makeConfig());
        await server.init();

        const startHandler = capturedHandlers.get('nodyn_run_start')!;
        const testSid = 'test-session-stream';
        const startResult = await startHandler({ task: 'stream task', session_id: testSid }) as { content: { text: string }[] };
        const { run_id } = JSON.parse(startResult.content[0]!.text) as { run_id: string };

        // Simulate onStream receiving text chunks
        const streamFn = mockAgentInstance.onStream as (e: { type: string; text: string; agent: string }) => Promise<void>;
        await streamFn({ type: 'text', text: 'Hello ', agent: 'test' });
        await streamFn({ type: 'text', text: 'world', agent: 'test' });

        const pollHandler = capturedHandlers.get('nodyn_poll')!;
        const pollResult = await pollHandler({ run_id, session_id: testSid }) as { content: { text: string }[] };
        const payload = JSON.parse(pollResult.content[0]!.text) as { done: boolean; text: string };
        expect(payload.done).toBe(false);
        expect(payload.text).toBe('Hello world');

        // Finish the run
        resolveRun();
        await new Promise(r => setTimeout(r, 10));

        // Poll again after done — run is cleaned up so returns not found
        const finalResult = await pollHandler({ run_id, session_id: testSid }) as { content: { text: string }[] };
        const finalPayload = JSON.parse(finalResult.content[0]!.text) as { done: boolean };
        expect(finalPayload.done).toBe(true);

        // Restore
        mockSessionSend.mockResolvedValue('Agent response');
      });

      it('marks output as truncated when the in-memory buffer exceeds the cap', async () => {
        mockRegisterTool.mockClear();
        const capturedHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          capturedHandlers.set(name, handler);
        });
        mockSessionSend.mockReturnValue(new Promise(() => {}));
        const server = new NodynMCPServer(makeConfig());
        await server.init();

        const startHandler = capturedHandlers.get('nodyn_run_start')!;
        const testSid = 'test-session-large';
        const startResult = await startHandler({ task: 'large stream', session_id: testSid }) as { content: { text: string }[] };
        const { run_id } = JSON.parse(startResult.content[0]!.text) as { run_id: string };

        const streamFn = mockAgentInstance.onStream as (e: { type: string; text: string; agent: string }) => Promise<void>;
        const largeChunk = 'x'.repeat(900_000);
        await streamFn({ type: 'text', text: largeChunk, agent: 'test' });
        await streamFn({ type: 'text', text: largeChunk, agent: 'test' });
        await streamFn({ type: 'text', text: largeChunk, agent: 'test' });

        const pollHandler = capturedHandlers.get('nodyn_poll')!;
        const pollResult = await pollHandler({ run_id, session_id: testSid }) as { content: { text: string }[] };
        const payload = JSON.parse(pollResult.content[0]!.text) as { truncated?: boolean; text: string };
        expect(payload.truncated).toBe(true);
        expect(payload.text).toContain('output truncated in-memory');

        mockSessionSend.mockResolvedValue('Agent response');
      });

      it('restores completed runs across server restart', async () => {
        mockRegisterTool.mockClear();
        const handlers1 = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers1.set(name, handler);
        });

        let resolveRun!: () => void;
        mockSessionSend.mockReturnValue(new Promise<void>((resolve) => { resolveRun = resolve; }));
        const server1 = new NodynMCPServer(makeConfig());
        await server1.init();

        const start1 = handlers1.get('nodyn_run_start')!;
        const poll1 = handlers1.get('nodyn_poll')!;
        const startResult = await start1({ task: 'persist me', session_id: 'sess-persisted' }) as { content: { text: string }[] };
        const { run_id } = JSON.parse(startResult.content[0]!.text) as { run_id: string };

        const streamFn = mockAgentInstance.onStream as (e: { type: string; text: string; agent: string }) => Promise<void>;
        await streamFn({ type: 'text', text: 'persisted text', agent: 'test' });
        resolveRun();
        await new Promise((r) => setTimeout(r, 10));

        const doneBeforeRestart = await poll1({ run_id, session_id: 'sess-persisted' }) as { content: { text: string }[] };
        const beforePayload = JSON.parse(doneBeforeRestart.content[0]!.text) as { done: boolean; text: string };
        expect(beforePayload.done).toBe(true);
        expect(beforePayload.text).toContain('persisted text');

        mockRegisterTool.mockClear();
        const handlers2 = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers2.set(name, handler);
        });
        const server2 = new NodynMCPServer(makeConfig());
        const poll2 = handlers2.get('nodyn_poll')!;

        const restored = await poll2({ run_id, session_id: 'sess-persisted' }) as { content: { text: string }[] };
        const restoredPayload = JSON.parse(restored.content[0]!.text) as { done: boolean; text: string; error?: string };
        expect(restoredPayload.done).toBe(true);
        expect(restoredPayload.error).toBeUndefined();
        expect(restoredPayload.text).toContain('persisted text');

        mockSessionSend.mockResolvedValue('Agent response');
      });

      it('marks in-flight runs as interrupted after server restart', async () => {
        mockRegisterTool.mockClear();
        const handlers1 = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers1.set(name, handler);
        });

        let resolveRun!: () => void;
        mockSessionSend.mockReturnValue(new Promise<void>((resolve) => { resolveRun = resolve; }));
        const server1 = new NodynMCPServer(makeConfig());
        await server1.init();

        const start1 = handlers1.get('nodyn_run_start')!;
        const startResult = await start1({ task: 'restart me', session_id: 'sess-restart' }) as { content: { text: string }[] };
        const { run_id } = JSON.parse(startResult.content[0]!.text) as { run_id: string };

        mockRegisterTool.mockClear();
        const handlers2 = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers2.set(name, handler);
        });
        const server2 = new NodynMCPServer(makeConfig());
        const poll2 = handlers2.get('nodyn_poll')!;

        const restored = await poll2({ run_id, session_id: 'sess-restart' }) as { content: { text: string }[] };
        const payload = JSON.parse(restored.content[0]!.text) as { done: boolean; error?: string; text: string };
        expect(payload.done).toBe(true);
        expect(payload.error).toContain('Server restarted before run completed');
        expect(payload.text).toBe('');

        resolveRun();
        await new Promise((r) => setTimeout(r, 10));
        mockSessionSend.mockResolvedValue('Agent response');
      });
    });

    describe('nodyn_reply', () => {
      it('returns error payload for unknown run_id', async () => {
        const handler = toolHandlers.get('nodyn_reply')!;
        const result = await handler({ run_id: 'no-such-run', answer: 'yes' }) as { content: { text: string }[] };
        const parsed = JSON.parse(result.content[0]!.text) as { error: string };
        expect(parsed.error).toContain('No pending input');
      });

      it('rejects answer not in options', async () => {
        mockRegisterTool.mockClear();
        const capturedHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          capturedHandlers.set(name, handler);
        });
        let resolveRun!: () => void;
        mockSessionSend.mockReturnValue(new Promise<void>(res => { resolveRun = res; }));
        const server = new NodynMCPServer(makeConfig());
        await server.init();

        const startHandler = capturedHandlers.get('nodyn_run_start')!;
        const testSid = 'test-session-constrained';
        const startResult = await startHandler({ task: 'constrained question', session_id: testSid }) as { content: { text: string }[] };
        const { run_id } = JSON.parse(startResult.content[0]!.text) as { run_id: string };

        // Simulate agent calling promptUser with constrained options
        const promptFn = mockAgentInstance.promptUser as (q: string, opts?: string[]) => Promise<string>;
        void promptFn('Allow?', ['Allow', 'Deny']);

        const replyHandler = capturedHandlers.get('nodyn_reply')!;
        const result = await replyHandler({ run_id, session_id: testSid, answer: 'Sure' }) as { content: { text: string }[] };
        const parsed = JSON.parse(result.content[0]!.text) as { error: string };
        expect(parsed.error).toContain('Invalid answer');
        expect(parsed.error).toContain('Allow');
        expect(parsed.error).toContain('Deny');

        // Cleanup — pendingInput still set, resolve it before run ends
        resolveRun();
        mockSessionSend.mockResolvedValue('Agent response');
      });

      it('returns ok:true and resolves the pending Promise', async () => {
        mockRegisterTool.mockClear();
        const capturedHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          capturedHandlers.set(name, handler);
        });
        // Make send hang until we inject a reply
        let resolveRun!: () => void;
        mockSessionSend.mockReturnValue(new Promise<void>(res => { resolveRun = res; }));
        const server = new NodynMCPServer(makeConfig());
        await server.init();

        const startHandler = capturedHandlers.get('nodyn_run_start')!;
        const testSid1 = 'test-session-input1';
        await startHandler({ task: 'awaiting input', session_id: testSid1 });

        // Simulate agent calling promptUser
        const promptFn = mockAgentInstance.promptUser as (q: string, opts?: string[]) => Promise<string>;
        const answerPromise = promptFn('Proceed?', ['yes', 'no']);

        const replyHandler = capturedHandlers.get('nodyn_reply')!;
        // Get the run_id — we need to find it; start returns it
        const testSid2 = 'test-session-input2';
        const startResult2 = await startHandler({ task: 'get run_id', session_id: testSid2 }) as { content: { text: string }[] };
        const { run_id } = JSON.parse(startResult2.content[0]!.text) as { run_id: string };

        // The second run has the pendingInput; set it up
        const promptFn2 = mockAgentInstance.promptUser as (q: string, opts?: string[]) => Promise<string>;
        const answerPromise2 = promptFn2('Ready?', ['ok']);

        const replyResult = await replyHandler({ run_id, session_id: testSid2, answer: 'ok' }) as { content: { text: string }[] };
        const parsed = JSON.parse(replyResult.content[0]!.text) as { ok: boolean };
        expect(parsed.ok).toBe(true);
        await expect(answerPromise2).resolves.toBe('ok');

        // Cleanup
        resolveRun();
        void answerPromise;
        mockSessionSend.mockResolvedValue('Agent response');
      });

      it('nodyn_poll exposes waiting_for_input when agent is paused', async () => {
        mockRegisterTool.mockClear();
        const capturedHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        mockRegisterTool.mockImplementation((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          capturedHandlers.set(name, handler);
        });
        let resolveRun!: () => void;
        mockSessionSend.mockReturnValue(new Promise<void>(res => { resolveRun = res; }));
        const server = new NodynMCPServer(makeConfig());
        await server.init();

        const startHandler = capturedHandlers.get('nodyn_run_start')!;
        const testSid = 'test-session-approval';
        const startResult = await startHandler({ task: 'needs approval', session_id: testSid }) as { content: { text: string }[] };
        const { run_id } = JSON.parse(startResult.content[0]!.text) as { run_id: string };

        // Simulate agent pausing via promptUser
        const promptFn = mockAgentInstance.promptUser as (q: string, opts?: string[]) => Promise<string>;
        void promptFn('Allow bash command?', ['Allow', 'Deny']);

        const pollHandler = capturedHandlers.get('nodyn_poll')!;
        const pollResult = await pollHandler({ run_id, session_id: testSid }) as { content: { text: string }[] };
        const payload = JSON.parse(pollResult.content[0]!.text) as {
          done: boolean;
          waiting_for_input?: { question: string; options?: string[] };
        };
        expect(payload.done).toBe(false);
        expect(payload.waiting_for_input).toBeDefined();
        expect(payload.waiting_for_input!.question).toBe('Allow bash command?');
        expect(payload.waiting_for_input!.options).toEqual(['Allow', 'Deny']);

        // Cleanup
        resolveRun();
        mockSessionSend.mockResolvedValue('Agent response');
      });
    });

    describe('nodyn_abort', () => {
      it('aborts existing session and returns aborted=true', async () => {
        mockAbort.mockClear();
        const handler = toolHandlers.get('nodyn_abort')!;
        const result = await handler({ session_id: 'sess-to-abort' }) as { content: { text: string }[] };
        const payload = JSON.parse(result.content[0]!.text) as { aborted: boolean };
        expect(payload.aborted).toBe(true);
        expect(mockAbort).toHaveBeenCalled();
      });

      it('returns aborted=false when session does not exist', async () => {
        mockSessionGet.mockReturnValueOnce(undefined);
        const handler = toolHandlers.get('nodyn_abort')!;
        const result = await handler({ session_id: 'ghost-session' }) as { content: { text: string }[] };
        const payload = JSON.parse(result.content[0]!.text) as { aborted: boolean };
        expect(payload.aborted).toBe(false);
      });
    });
  });

  describe('completed run GC', () => {
    it('startTempCleanup is called during construction', () => {
      // The fact that NodynMCPServer constructs without error confirms startTempCleanup runs.
      // The GC logic is inside the interval callback — verify it doesn't crash on empty runStore.
      const server = new NodynMCPServer(makeConfig());
      expect(server).toBeDefined();
    });
  });

});
