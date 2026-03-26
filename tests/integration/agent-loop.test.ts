import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolEntry, StreamEvent } from '../../src/types/index.js';

// === Mocks ===

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        stream: vi.fn(),
      },
    };
  }
  class APIError extends Error {
    status: number;
    error: unknown;
    headers: unknown;
    constructor(status: number, error: unknown, message: string | undefined, headers: unknown) {
      super(message ?? String(error));
      this.status = status;
      this.error = error;
      this.headers = headers;
      this.name = 'APIError';
    }
  }
  return { default: MockAnthropic, APIError };
});

const mockProcess = vi.fn();

vi.mock('../../src/core/stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

vi.mock('../../src/tools/permission-guard.js', () => ({
  isDangerous: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/core/observability.js', () => ({
  channels: {
    toolStart: { publish: vi.fn() },
    toolEnd: { publish: vi.fn() },
  },
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));

import { Agent } from '../../src/core/agent.js';

// === Helpers ===

function endTurnResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function maxTokensResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function toolUseResponse(tools: Array<{ id: string; name: string; input: unknown }>) {
  return {
    content: tools.map(t => ({
      type: 'tool_use' as const,
      id: t.id,
      name: t.name,
      input: t.input,
    })),
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function makeTool(name: string, handler?: ToolEntry['handler']): ToolEntry {
  return {
    definition: {
      name,
      description: `Test tool ${name}`,
      input_schema: { type: 'object' as const, properties: {} },
    },
    handler: handler ?? vi.fn().mockResolvedValue('tool result'),
  };
}

function makeMemoryMock() {
  return {
    load: vi.fn(),
    save: vi.fn(),
    append: vi.fn(),
    delete: vi.fn().mockResolvedValue(0),
    update: vi.fn().mockResolvedValue(false),
    render: vi.fn().mockReturnValue(''),
    hasContent: vi.fn().mockReturnValue(false),
    loadAll: vi.fn(),
    maybeUpdate: vi.fn(),
    appendScoped: vi.fn(),
    loadScoped: vi.fn(),
    deleteScoped: vi.fn().mockResolvedValue(0),
    updateScoped: vi.fn().mockResolvedValue(false),
  };
}

// === Tests ===

describe('Agent Loop Integration', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `lynox-agent-int-${prefix}-`));
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  // -- 1. Single tool round-trip with real filesystem --

  it('single tool round-trip: reads a real temp file via tool handler', async () => {
    const tmpDir = makeTmpDir('read');
    const filePath = join(tmpDir, 'data.txt');
    writeFileSync(filePath, 'hello from disk');

    const readFileTool = makeTool(
      'read_file',
      async (input: unknown) => {
        const { path } = input as { path: string };
        return readFileSync(path, 'utf-8');
      },
    );

    mockProcess
      .mockResolvedValueOnce(
        toolUseResponse([{ id: 'tu_1', name: 'read_file', input: { path: filePath } }]),
      )
      .mockResolvedValueOnce(endTurnResponse('Done'));

    const agent = new Agent({
      name: 'test-read',
      model: 'claude-sonnet-4-6',
      tools: [readFileTool],
    });
    const result = await agent.send('Read the file');

    expect(result).toBe('Done');
    // Verify the tool handler was called with the correct input
    const messages = agent.getMessages();
    // Messages: user, assistant(tool_use), user(tool_results), assistant(end_turn)
    expect(messages).toHaveLength(4);
    const toolResultsMsg = messages[2] as {
      content: Array<{ type: string; tool_use_id: string; content: string }>;
    };
    const fileResult = toolResultsMsg.content.find(r => r.tool_use_id === 'tu_1');
    expect(fileResult).toBeDefined();
    expect(fileResult!.content).toBe('hello from disk');
  });

  // -- 2. Multi-tool parallel dispatch: one succeeds, one throws --

  it('multi-tool parallel dispatch: one succeeds, one throws', async () => {
    let successCalled = false;
    let failCalled = false;

    const successTool = makeTool('good_tool', async () => {
      successCalled = true;
      return 'success-result';
    });
    const failTool = makeTool('bad_tool', async () => {
      failCalled = true;
      throw new Error('handler-boom');
    });

    mockProcess
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_good', name: 'good_tool', input: {} },
          { type: 'tool_use', id: 'tu_bad', name: 'bad_tool', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 50 },
      })
      .mockResolvedValueOnce(endTurnResponse('All handled'));

    const agent = new Agent({
      name: 'test-parallel',
      model: 'claude-sonnet-4-6',
      tools: [successTool, failTool],
    });
    const result = await agent.send('Use both tools');

    expect(result).toBe('All handled');
    expect(successCalled).toBe(true);
    expect(failCalled).toBe(true);

    // Verify tool results in message history
    const messages = agent.getMessages();
    const toolResultsMsg = messages[2] as {
      content: Array<{ type: string; tool_use_id: string; content: string; is_error?: boolean }>;
    };
    const goodResult = toolResultsMsg.content.find(r => r.tool_use_id === 'tu_good');
    expect(goodResult).toBeDefined();
    expect(goodResult!.is_error).toBeUndefined();
    expect(goodResult!.content).toBe('success-result');

    const badResult = toolResultsMsg.content.find(r => r.tool_use_id === 'tu_bad');
    expect(badResult).toBeDefined();
    expect(badResult!.is_error).toBe(true);
    expect(badResult!.content).toContain('handler-boom');
  });

  // -- 3. max_tokens continuation --

  it('max_tokens continuation: continues the loop when continuationPrompt is set', async () => {
    mockProcess
      .mockResolvedValueOnce(maxTokensResponse('partial'))
      .mockResolvedValueOnce(endTurnResponse('complete'));

    const agent = new Agent({
      name: 'test-continuation',
      model: 'claude-sonnet-4-6',
      continuationPrompt: 'Continue',
    });
    const result = await agent.send('Write something long');

    expect(result).toBe('complete');
    expect(mockProcess).toHaveBeenCalledTimes(2);
  });

  // -- 4. Stream event collection --
  // Note: `tool_call` and `turn_end` events are emitted by the StreamProcessor
  // (mocked here), so only Agent-emitted events (`tool_result`, `error`,
  // `continuation`) are verifiable through the `onStream` callback.

  it('stream event collection: emits tool_result event via onStream', async () => {
    const events: StreamEvent[] = [];

    const tool = makeTool('echo_tool', async () => 'echoed');

    mockProcess
      .mockResolvedValueOnce(
        toolUseResponse([{ id: 'tu_stream', name: 'echo_tool', input: { msg: 'hi' } }]),
      )
      .mockResolvedValueOnce(endTurnResponse('Final answer'));

    const agent = new Agent({
      name: 'test-stream',
      model: 'claude-sonnet-4-6',
      tools: [tool],
      onStream: (event: StreamEvent) => {
        events.push(event);
      },
    });
    await agent.send('Use the tool');

    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('tool_result');

    // Verify the tool_result event has the correct shape
    const toolResultEvent = events.find(e => e.type === 'tool_result') as
      | { type: 'tool_result'; name: string; result: string; agent: string }
      | undefined;
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent!.name).toBe('echo_tool');
    expect(toolResultEvent!.result).toBe('echoed');
    expect(toolResultEvent!.agent).toBe('test-stream');
  });

  // -- 5. Unregistered tool fallback --

  it('unregistered tool fallback: returns error result without crashing', async () => {
    mockProcess
      .mockResolvedValueOnce(
        toolUseResponse([{ id: 'tu_missing', name: 'unknown_tool', input: { x: 1 } }]),
      )
      .mockResolvedValueOnce(endTurnResponse('Recovered'));

    const agent = new Agent({
      name: 'test-unknown',
      model: 'claude-sonnet-4-6',
      tools: [], // no tools registered
    });
    const result = await agent.send('Call unknown tool');

    expect(result).toBe('Recovered');

    // Verify tool result contains error
    const messages = agent.getMessages();
    const toolResultsMsg = messages[2] as {
      content: Array<{ content: string; is_error: boolean }>;
    };
    expect(toolResultsMsg.content[0]!.content).toContain('Tool not found: unknown_tool');
    expect(toolResultsMsg.content[0]!.is_error).toBe(true);
  });

  // -- 6. Memory integration --

  it('memory integration: calls maybeUpdate with the final response text', async () => {
    const memory = makeMemoryMock();

    mockProcess.mockResolvedValueOnce(endTurnResponse('The answer is 42'));

    const agent = new Agent({
      name: 'test-memory',
      model: 'claude-sonnet-4-6',
      memory,
    });
    const result = await agent.send('What is the meaning of life?');

    expect(result).toBe('The answer is 42');
    expect(memory.maybeUpdate).toHaveBeenCalledWith('The answer is 42', 0);
  });

  // -- 7. maxIterations boundary --

  it('maxIterations boundary: stops after N iterations', async () => {
    const tool = makeTool('loop_tool');

    // Return tool_use every time to keep the loop going
    mockProcess.mockResolvedValue(
      toolUseResponse([{ id: 'tu_iter', name: 'loop_tool', input: {} }]),
    );

    const agent = new Agent({
      name: 'test-maxiter',
      model: 'claude-sonnet-4-6',
      tools: [tool],
      maxIterations: 2,
      // No continuationPrompt → should stop at maxIterations
    });
    const result = await agent.send('Loop forever');

    // After 2 iterations with tool_use, it falls through and returns extractText([]) which is ''
    expect(result).toBe('');
    expect(mockProcess).toHaveBeenCalledTimes(2);
  });

  // -- 8. Abort mid-loop --

  it('abort mid-loop: restores messages to snapshot', async () => {
    mockProcess.mockImplementation(() => {
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('Aborted')), 10);
      });
    });

    const agent = new Agent({ name: 'test-abort', model: 'claude-sonnet-4-6' });

    // Pre-populate with one message
    agent.loadMessages([{ role: 'user', content: 'old' }]);
    expect(agent.getMessages()).toHaveLength(1);

    // Start send, then abort
    const sendPromise = agent.send('new message');
    // Small delay to allow the user message to be pushed
    await new Promise(r => setTimeout(r, 5));
    agent.abort();

    const result = await sendPromise;
    expect(result).toBe('');
    // Messages should be restored to snapshot (only 'old')
    expect(agent.getMessages()).toHaveLength(1);
    expect(agent.getMessages()[0]).toEqual({ role: 'user', content: 'old' });
  });
});
