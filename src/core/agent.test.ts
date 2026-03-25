import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolEntry, StreamEvent } from '../types/index.js';

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

vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

vi.mock('../tools/permission-guard.js', () => ({
  isDangerous: vi.fn().mockReturnValue(null),
}));

vi.mock('./observability.js', () => ({
  channels: {
    toolStart: { publish: vi.fn() },
    toolEnd: { publish: vi.fn() },
    contentTruncation: { hasSubscribers: true, publish: vi.fn() },
  },
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));

import { Agent } from './agent.js';
import { isDangerous } from '../tools/permission-guard.js';

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

function thinkingResponse(thinking: string, text: string) {
  return {
    content: [
      { type: 'thinking' as const, thinking },
      { type: 'text' as const, text },
    ],
    stop_reason: 'end_turn',
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

// === Tests ===

describe('Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- send() --

  describe('send()', () => {
    it('pushes user message and returns text from end_turn response', async () => {
      mockProcess.mockResolvedValueOnce(endTurnResponse('Hello'));

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      const result = await agent.send('Hi');

      expect(result).toBe('Hello');
      const messages = agent.getMessages();
      expect(messages[0]).toEqual({ role: 'user', content: 'Hi' });
      expect(messages[1]).toMatchObject({ role: 'assistant' });
    });

    it('resets continuationCount on each send', async () => {
      // First call: trigger max_tokens with continuation, then end_turn
      mockProcess
        .mockResolvedValueOnce(maxTokensResponse('partial'))
        .mockResolvedValueOnce(endTurnResponse('done1'));

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        continuationPrompt: 'Continue',
      });
      await agent.send('task1');
      expect(mockProcess).toHaveBeenCalledTimes(2);

      // Second call: should also allow continuation (count was reset)
      mockProcess.mockClear();
      mockProcess
        .mockResolvedValueOnce(maxTokensResponse('partial'))
        .mockResolvedValueOnce(endTurnResponse('done2'));
      const result = await agent.send('task2');
      expect(result).toBe('done2');
      expect(mockProcess).toHaveBeenCalledTimes(2);
    });

    it('restores messages to snapshot length on abort', async () => {
      mockProcess.mockImplementation(() => {
        return new Promise((_resolve, reject) => {
          // Simulate delayed rejection after abort
          setTimeout(() => reject(new Error('Aborted')), 10);
        });
      });

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });

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

  // -- _loop() behavior via send() --

  describe('_loop() behavior', () => {
    it('end_turn: extracts text and calls memory.maybeUpdate', async () => {
      const memory = {
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

      mockProcess.mockResolvedValueOnce(endTurnResponse('The answer is 42'));

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        memory,
      });
      const result = await agent.send('Question');
      expect(result).toBe('The answer is 42');
      expect(memory.maybeUpdate).toHaveBeenCalledWith('The answer is 42', 0);
    });

    it('max_tokens with continuationPrompt: continues the loop', async () => {
      mockProcess
        .mockResolvedValueOnce(maxTokensResponse('part1'))
        .mockResolvedValueOnce(endTurnResponse('part2'));

      const onStream = vi.fn();
      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        continuationPrompt: 'Please continue',
        onStream,
      });
      const result = await agent.send('Write a story');
      expect(result).toBe('part2');
      expect(mockProcess).toHaveBeenCalledTimes(2);

      // Should emit continuation event
      expect(onStream).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'continuation', iteration: 1 }),
      );
    });

    it('max_tokens without continuationPrompt: returns text without continuation', async () => {
      mockProcess.mockResolvedValueOnce(maxTokensResponse('truncated'));

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        // No continuationPrompt
      });
      const result = await agent.send('Write something');
      expect(result).toBe('truncated');
      expect(mockProcess).toHaveBeenCalledTimes(1);
    });

    it('tool_use: dispatches tools and continues loop', async () => {
      const tool = makeTool('test_tool');
      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu_1', name: 'test_tool', input: { x: 1 } }]))
        .mockResolvedValueOnce(endTurnResponse('Done'));

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        tools: [tool],
      });
      const result = await agent.send('Use the tool');
      expect(result).toBe('Done');
      expect(tool.handler).toHaveBeenCalledWith({ x: 1 }, agent);
      expect(mockProcess).toHaveBeenCalledTimes(2);
    });

    it('thinking blocks are stripped from message history', async () => {
      mockProcess.mockResolvedValueOnce(thinkingResponse('Let me think...', 'Result'));

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      const result = await agent.send('Think about this');
      expect(result).toBe('Result');

      const messages = agent.getMessages();
      const assistantMsg = messages[1];
      expect(assistantMsg).toBeDefined();
      // Content should not contain thinking blocks
      const content = (assistantMsg as { content: Array<{ type: string }> }).content;
      const hasThinking = content.some(b => b.type === 'thinking');
      expect(hasThinking).toBe(false);
      // But should contain text block
      const hasText = content.some(b => b.type === 'text');
      expect(hasText).toBe(true);
    });

    it('maxIterations: stops after N iterations', async () => {
      // Return tool_use every time to keep the loop going
      const tool = makeTool('loop_tool');
      mockProcess.mockResolvedValue(
        toolUseResponse([{ id: 'tu_iter', name: 'loop_tool', input: {} }]),
      );

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        tools: [tool],
        maxIterations: 3,
        // No continuationPrompt → should stop at maxIterations
      });
      const result = await agent.send('Loop forever');
      // After 3 iterations with tool_use, it falls through and returns extractText([]) which is ''
      expect(result).toBe('');
      expect(mockProcess).toHaveBeenCalledTimes(3);
    });

    it('maxIterations with continuationPrompt: recurses after hitting limit', async () => {
      const tool = makeTool('loop_tool');
      // 3 iterations of tool_use (hits maxIterations), then continuation → end_turn
      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu_1', name: 'loop_tool', input: {} }]))
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu_2', name: 'loop_tool', input: {} }]))
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu_3', name: 'loop_tool', input: {} }]))
        .mockResolvedValueOnce(endTurnResponse('Finally done'));

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        tools: [tool],
        maxIterations: 3,
        continuationPrompt: 'Keep going',
      });
      const result = await agent.send('Loop then stop');
      expect(result).toBe('Finally done');
      expect(mockProcess).toHaveBeenCalledTimes(4);
    });
  });

  // -- _dispatchTools() via tool_use response --

  describe('_dispatchTools()', () => {
    it('Promise.allSettled: one tool fails, others succeed', async () => {
      const successTool = makeTool('good_tool', vi.fn().mockResolvedValue('success'));
      const failTool = makeTool('bad_tool', vi.fn().mockRejectedValue(new Error('boom')));

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
        name: 'test',
        model: 'claude-sonnet-4-6',
        tools: [successTool, failTool],
      });
      const result = await agent.send('Use both tools');
      expect(result).toBe('All handled');

      // Both tools should have been called
      expect(successTool.handler).toHaveBeenCalled();
      expect(failTool.handler).toHaveBeenCalled();

      // Check that tool results were pushed as user message
      const messages = agent.getMessages();
      // Messages: user, assistant(tool_use), user(tool_results), assistant(end_turn)
      const toolResultsMsg = messages[2];
      expect(toolResultsMsg).toBeDefined();
      const results = (toolResultsMsg as { content: Array<{ type: string; tool_use_id: string; is_error?: boolean }> }).content;
      // The good tool should succeed
      const goodResult = results.find(r => r.tool_use_id === 'tu_good');
      expect(goodResult).toBeDefined();
      expect(goodResult!.is_error).toBeUndefined();
      // The bad tool should have is_error
      const badResult = results.find(r => r.tool_use_id === 'tu_bad');
      expect(badResult).toBeDefined();
      expect(badResult!.is_error).toBe(true);
    });

    it('tool not found: returns error result', async () => {
      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu_missing', name: 'nonexistent', input: {} }]))
        .mockResolvedValueOnce(endTurnResponse('OK'));

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        tools: [], // no tools registered
      });
      const result = await agent.send('Use nonexistent tool');
      expect(result).toBe('OK');

      const messages = agent.getMessages();
      const toolResultsMsg = messages[2];
      const results = (toolResultsMsg as { content: Array<{ content: string; is_error: boolean }> }).content;
      expect(results[0]!.content).toContain('Tool not found: nonexistent');
      expect(results[0]!.is_error).toBe(true);
    });

    it('isDangerous + promptUser: y allows execution', async () => {
      vi.mocked(isDangerous).mockReturnValueOnce('Dangerous: rm -rf /');
      const tool = makeTool('bash', vi.fn().mockResolvedValue('executed'));
      const promptUser = vi.fn().mockResolvedValue('y');

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu_bash', name: 'bash', input: { command: 'rm -rf /' } }]))
        .mockResolvedValueOnce(endTurnResponse('Done'));

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        tools: [tool],
        promptUser,
      });
      const result = await agent.send('Delete everything');
      expect(result).toBe('Done');
      expect(promptUser).toHaveBeenCalledWith('Dangerous: rm -rf /', ['Allow', 'Deny', '\x00']);
      expect(tool.handler).toHaveBeenCalled();
    });

    it('isDangerous + promptUser: deny blocks execution', async () => {
      vi.mocked(isDangerous).mockReturnValueOnce('Dangerous command');
      const tool = makeTool('bash', vi.fn().mockResolvedValue('executed'));
      const promptUser = vi.fn().mockResolvedValue('no');

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu_bash', name: 'bash', input: {} }]))
        .mockResolvedValueOnce(endTurnResponse('Denied'));

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        tools: [tool],
        promptUser,
      });
      const result = await agent.send('Do dangerous thing');
      expect(result).toBe('Denied');
      expect(promptUser).toHaveBeenCalled();
      expect(tool.handler).not.toHaveBeenCalled();

      // Check error in tool results
      const messages = agent.getMessages();
      const toolResultsMsg = messages[2];
      const results = (toolResultsMsg as { content: Array<{ content: string; is_error: boolean }> }).content;
      expect(results[0]!.content).toContain('Permission denied by user');
      expect(results[0]!.is_error).toBe(true);
    });

    it('isDangerous without promptUser: blocks with non-interactive denial', async () => {
      vi.mocked(isDangerous).mockReturnValueOnce('Dangerous');
      const tool = makeTool('bash');

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu_1', name: 'bash', input: {} }]))
        .mockResolvedValueOnce(endTurnResponse('OK'));

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        tools: [tool],
        // no promptUser
      });
      await agent.send('Dangerous');

      const messages = agent.getMessages();
      const toolResultsMsg = messages[2];
      const results = (toolResultsMsg as { content: Array<{ content: string; is_error: boolean }> }).content;
      expect(results[0]!.content).toContain('Permission denied (non-interactive)');
      expect(results[0]!.is_error).toBe(true);
      expect(tool.handler).not.toHaveBeenCalled();
    });
  });

  // -- Other methods --

  describe('other methods', () => {
    it('throws on negative maxIterations', () => {
      expect(() => new Agent({ name: 'test', model: 'claude-sonnet-4-6', maxIterations: -1 }))
        .toThrow('maxIterations must be >= 0');
      expect(() => new Agent({ name: 'test', model: 'claude-sonnet-4-6', maxIterations: -100 }))
        .toThrow('maxIterations must be >= 0');
      expect(() => new Agent({ name: 'test', model: 'claude-sonnet-4-6', maxIterations: 0 }))
        .not.toThrow();
    });

    it('reset() clears messages', async () => {
      mockProcess.mockResolvedValueOnce(endTurnResponse('Hi'));

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      await agent.send('Hello');
      expect(agent.getMessages().length).toBeGreaterThan(0);

      agent.reset();
      expect(agent.getMessages()).toHaveLength(0);
    });

    it('getMessages() returns a copy', async () => {
      mockProcess.mockResolvedValueOnce(endTurnResponse('Hi'));

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      await agent.send('Hello');

      const messages1 = agent.getMessages();
      const messages2 = agent.getMessages();
      expect(messages1).toEqual(messages2);
      expect(messages1).not.toBe(messages2); // different array references
    });

    it('loadMessages() loads messages', () => {
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      const msgs = [
        { role: 'user' as const, content: 'Q1' },
        { role: 'assistant' as const, content: 'A1' },
      ];
      agent.loadMessages(msgs);
      expect(agent.getMessages()).toEqual(msgs);
      // Should be a copy, not the same array
      expect(agent.getMessages()).not.toBe(msgs);
    });

    it('retries on overloaded error (529) with backoff', async () => {
      const { APIError: MockAPIError } = await import('@anthropic-ai/sdk');
      // Speed up retries for testing
      (Agent as unknown as { RETRY_BASE_MS: number }).RETRY_BASE_MS = 1;

      mockProcess
        .mockRejectedValueOnce(new MockAPIError(529, undefined, 'Overloaded', undefined))
        .mockRejectedValueOnce(new MockAPIError(529, undefined, 'Overloaded', undefined))
        .mockResolvedValueOnce(endTurnResponse('Recovered'));

      const onStream = vi.fn();
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', onStream });
      const result = await agent.send('Hello');
      expect(result).toBe('Recovered');
      expect(mockProcess).toHaveBeenCalledTimes(3);

      const errorCalls = onStream.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === 'error',
      );
      expect(errorCalls).toHaveLength(2);
      expect((errorCalls[0]![0] as { message: string }).message).toContain('retrying');
      (Agent as unknown as { RETRY_BASE_MS: number }).RETRY_BASE_MS = 2000;
    });

    it('retries on SSE overloaded_error (status undefined)', async () => {
      const { APIError: MockAPIError } = await import('@anthropic-ai/sdk');
      (Agent as unknown as { RETRY_BASE_MS: number }).RETRY_BASE_MS = 1;

      // SSE stream errors arrive with status=undefined and error body
      mockProcess
        .mockRejectedValueOnce(new MockAPIError(undefined as unknown as number, { type: 'overloaded_error', message: 'Overloaded' }, undefined, undefined))
        .mockResolvedValueOnce(endTurnResponse('Recovered'));

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      const result = await agent.send('Hello');
      expect(result).toBe('Recovered');
      expect(mockProcess).toHaveBeenCalledTimes(2);
      (Agent as unknown as { RETRY_BASE_MS: number }).RETRY_BASE_MS = 2000;
    });

    it('retries on rate limit error (429)', async () => {
      const { APIError: MockAPIError } = await import('@anthropic-ai/sdk');
      (Agent as unknown as { RETRY_BASE_MS: number }).RETRY_BASE_MS = 1;

      mockProcess
        .mockRejectedValueOnce(new MockAPIError(429, undefined, 'Rate limited', undefined))
        .mockResolvedValueOnce(endTurnResponse('OK'));

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      const result = await agent.send('Hello');
      expect(result).toBe('OK');
      expect(mockProcess).toHaveBeenCalledTimes(2);
      (Agent as unknown as { RETRY_BASE_MS: number }).RETRY_BASE_MS = 2000;
    });

    it('throws non-retryable errors immediately', async () => {
      const { APIError: MockAPIError } = await import('@anthropic-ai/sdk');

      mockProcess.mockRejectedValueOnce(new MockAPIError(400, undefined, 'Bad request', undefined));

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      await expect(agent.send('Hello')).rejects.toThrow('Bad request');
      expect(mockProcess).toHaveBeenCalledTimes(1);
    });

    it('throws after exhausting all retries', async () => {
      const { APIError: MockAPIError } = await import('@anthropic-ai/sdk');
      (Agent as unknown as { RETRY_BASE_MS: number }).RETRY_BASE_MS = 1;

      mockProcess.mockImplementation(async () => {
        throw new MockAPIError(529, undefined, 'Overloaded', undefined);
      });

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      await expect(agent.send('Hello')).rejects.toThrow('Overloaded');
      expect(mockProcess).toHaveBeenCalledTimes(4); // 1 + MAX_RETRIES(3)
      (Agent as unknown as { RETRY_BASE_MS: number }).RETRY_BASE_MS = 2000;
    });

    it('setContinuationPrompt() updates the prompt', async () => {
      // Initially no continuation: max_tokens returns text directly
      mockProcess.mockResolvedValueOnce(maxTokensResponse('truncated'));

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      let result = await agent.send('Task');
      expect(result).toBe('truncated');
      expect(mockProcess).toHaveBeenCalledTimes(1);

      // Set continuation prompt: now max_tokens should continue
      agent.reset();
      mockProcess.mockClear();
      agent.setContinuationPrompt('Keep going');
      mockProcess
        .mockResolvedValueOnce(maxTokensResponse('partial'))
        .mockResolvedValueOnce(endTurnResponse('complete'));
      result = await agent.send('Task2');
      expect(result).toBe('complete');
      expect(mockProcess).toHaveBeenCalledTimes(2);
    });
  });

  describe('Knowledge context (knowledgeContext)', () => {
    it('knowledgeContext string uses knowledge block instead of memory.render()', async () => {
      const memory = {
        load: vi.fn(),
        save: vi.fn(),
        append: vi.fn(),
        delete: vi.fn().mockResolvedValue(0),
        update: vi.fn().mockResolvedValue(false),
        render: vi.fn().mockReturnValue('should not appear'),
        hasContent: vi.fn().mockReturnValue(true),
        loadAll: vi.fn(),
        maybeUpdate: vi.fn(),
        appendScoped: vi.fn(),
        loadScoped: vi.fn(),
        deleteScoped: vi.fn().mockResolvedValue(0),
        updateScoped: vi.fn().mockResolvedValue(false),
      };

      mockProcess.mockResolvedValueOnce(endTurnResponse('OK'));

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        memory,
        knowledgeContext: '<relevant_context>test context</relevant_context>',
      });
      await agent.send('Hello');

      // memory.render() should NOT be called since knowledgeContext is set
      expect(memory.render).not.toHaveBeenCalled();
    });

    it('knowledgeContext undefined produces no memory block (no full dump)', async () => {
      const memory = {
        load: vi.fn(),
        save: vi.fn(),
        append: vi.fn(),
        delete: vi.fn().mockResolvedValue(0),
        update: vi.fn().mockResolvedValue(false),
        render: vi.fn().mockReturnValue('memory content'),
        hasContent: vi.fn().mockReturnValue(true),
        loadAll: vi.fn(),
        maybeUpdate: vi.fn(),
        appendScoped: vi.fn(),
        loadScoped: vi.fn(),
        deleteScoped: vi.fn().mockResolvedValue(0),
        updateScoped: vi.fn().mockResolvedValue(false),
      };

      mockProcess.mockResolvedValueOnce(endTurnResponse('OK'));

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        memory,
        // knowledgeContext: undefined (default)
      });
      await agent.send('Hello');

      // memory.render() should NOT be called — no full dump fallback
      expect(memory.render).not.toHaveBeenCalled();
    });

    it('knowledgeContext empty string produces no Block 2', async () => {
      const memory = {
        load: vi.fn(),
        save: vi.fn(),
        append: vi.fn(),
        delete: vi.fn().mockResolvedValue(0),
        update: vi.fn().mockResolvedValue(false),
        render: vi.fn().mockReturnValue('should not appear'),
        hasContent: vi.fn().mockReturnValue(true),
        loadAll: vi.fn(),
        maybeUpdate: vi.fn(),
        appendScoped: vi.fn(),
        loadScoped: vi.fn(),
        deleteScoped: vi.fn().mockResolvedValue(0),
        updateScoped: vi.fn().mockResolvedValue(false),
      };

      mockProcess.mockResolvedValueOnce(endTurnResponse('OK'));

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        memory,
        knowledgeContext: '',
      });
      await agent.send('Hello');

      // memory.render() should NOT be called
      expect(memory.render).not.toHaveBeenCalled();
    });

    it('setKnowledgeContext() updates the context', async () => {
      const memory = {
        load: vi.fn(),
        save: vi.fn(),
        append: vi.fn(),
        delete: vi.fn().mockResolvedValue(0),
        update: vi.fn().mockResolvedValue(false),
        render: vi.fn().mockReturnValue('fallback'),
        hasContent: vi.fn().mockReturnValue(true),
        loadAll: vi.fn(),
        maybeUpdate: vi.fn(),
        appendScoped: vi.fn(),
        loadScoped: vi.fn(),
        deleteScoped: vi.fn().mockResolvedValue(0),
        updateScoped: vi.fn().mockResolvedValue(false),
      };

      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        memory,
        // knowledgeContext: undefined initially
      });

      // Set knowledge context
      agent.setKnowledgeContext('<relevant_context>set via setter</relevant_context>');

      mockProcess.mockResolvedValueOnce(endTurnResponse('OK'));
      await agent.send('Hello');

      // memory.render() should NOT be called since knowledgeContext was set
      expect(memory.render).not.toHaveBeenCalled();
    });
  });

  describe('secret middleware', () => {
    function makeSecretStore(overrides: Partial<import('../types/index.js').SecretStoreLike> = {}): import('../types/index.js').SecretStoreLike {
      const store: import('../types/index.js').SecretStoreLike = {
        getMasked: vi.fn().mockReturnValue('***1234'),
        resolve: vi.fn().mockReturnValue('actual-secret-val'),
        listNames: vi.fn().mockReturnValue(['MY_KEY']),
        containsSecret: vi.fn().mockReturnValue(false),
        maskSecrets: vi.fn().mockImplementation((t: string) => t),
        recordConsent: vi.fn(),
        hasConsent: vi.fn().mockReturnValue(false),
        isExpired: vi.fn().mockReturnValue(false),
        extractSecretNames: vi.fn().mockImplementation((input: unknown) => {
          const text = JSON.stringify(input);
          const names: string[] = [];
          const pattern = /\bsecret:([A-Z_][A-Z0-9_]*)\b/g;
          let match;
          while ((match = pattern.exec(text)) !== null) {
            if (!names.includes(match[1]!)) names.push(match[1]!);
          }
          return names;
        }),
        resolveSecretRefs: vi.fn().mockImplementation((input: unknown) => {
          const text = JSON.stringify(input);
          const resolved = text.replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, (_m, name: string) => {
            const value = store.resolve(name);
            return value !== null ? String(value).replace(/["\\\n\r\t]/g, c => {
              if (c === '"') return '\\"';
              if (c === '\\') return '\\\\';
              if (c === '\n') return '\\n';
              if (c === '\r') return '\\r';
              if (c === '\t') return '\\t';
              return c;
            }) : `secret:${name}`;
          });
          try { return JSON.parse(resolved) as unknown; }
          catch { return input; }
        }),
        ...overrides,
      };
      return store;
    }

    it('resolves secret:KEY_NAME in tool input after consent', async () => {
      const store = makeSecretStore({ hasConsent: vi.fn().mockReturnValue(true) });
      const tool = makeTool('http_request', vi.fn().mockResolvedValue('ok'));
      const promptUser = vi.fn().mockResolvedValue('Allow');

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{
          id: 'tu_1', name: 'http_request',
          input: { url: 'https://api.example.com', headers: { Authorization: 'Bearer secret:MY_KEY' } },
        }]))
        .mockResolvedValueOnce(endTurnResponse('Done'));

      const agent = new Agent({
        name: 'test', model: 'claude-sonnet-4-6',
        tools: [tool], promptUser, secretStore: store,
      });
      await agent.send('Call API');

      // Tool should have been called with resolved secret
      expect(tool.handler).toHaveBeenCalled();
      const callArgs = (tool.handler as ReturnType<typeof vi.fn>).mock.calls[0]! as [unknown, unknown];
      const input = callArgs[0] as { headers: { Authorization: string } };
      expect(input.headers.Authorization).toBe('Bearer actual-secret-val');
    });

    it('shows consent dialog on first use of a secret', async () => {
      const store = makeSecretStore();
      const tool = makeTool('http_request', vi.fn().mockResolvedValue('ok'));
      const promptUser = vi.fn().mockResolvedValue('Allow');

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{
          id: 'tu_1', name: 'http_request',
          input: { url: 'https://api.example.com', headers: { Authorization: 'secret:MY_KEY' } },
        }]))
        .mockResolvedValueOnce(endTurnResponse('Done'));

      const agent = new Agent({
        name: 'test', model: 'claude-sonnet-4-6',
        tools: [tool], promptUser, secretStore: store,
      });
      await agent.send('Call API');

      expect(promptUser).toHaveBeenCalledWith(
        expect.stringContaining('MY_KEY'),
        ['Allow', 'Deny', '\x00'],
      );
      expect(store.recordConsent).toHaveBeenCalledWith('MY_KEY');
    });

    it('denies secret use in non-interactive mode', async () => {
      const store = makeSecretStore();
      const tool = makeTool('http_request', vi.fn().mockResolvedValue('ok'));

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{
          id: 'tu_1', name: 'http_request',
          input: { headers: { Authorization: 'secret:MY_KEY' } },
        }]))
        .mockResolvedValueOnce(endTurnResponse('OK'));

      const agent = new Agent({
        name: 'test', model: 'claude-sonnet-4-6',
        tools: [tool], secretStore: store,
        // no promptUser
      });
      await agent.send('Call API');

      expect(tool.handler).not.toHaveBeenCalled();
      const messages = agent.getMessages();
      const toolResults = messages[2] as { content: Array<{ content: string; is_error: boolean }> };
      expect(toolResults.content[0]!.content).toContain('Secret use denied (non-interactive)');
    });

    it('strips secrets from tool results', async () => {
      const store = makeSecretStore({
        hasConsent: vi.fn().mockReturnValue(true),
        maskSecrets: vi.fn().mockImplementation((t: string) => t.replace('leaked-secret', '***cret')),
      });
      const tool = makeTool('bash', vi.fn().mockResolvedValue('output contains leaked-secret here'));

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu_1', name: 'bash', input: { command: 'echo test' } }]))
        .mockResolvedValueOnce(endTurnResponse('Done'));

      const agent = new Agent({
        name: 'test', model: 'claude-sonnet-4-6',
        tools: [tool], secretStore: store,
      });
      await agent.send('Run command');

      const messages = agent.getMessages();
      const toolResults = messages[2] as { content: Array<{ content: string }> };
      expect(toolResults.content[0]!.content).toContain('***cret');
      expect(toolResults.content[0]!.content).not.toContain('leaked-secret');
    });

    it('strips secrets from error messages', async () => {
      const store = makeSecretStore({
        hasConsent: vi.fn().mockReturnValue(true),
        maskSecrets: vi.fn().mockImplementation((t: string) => t.replace('secret-in-error', '***rror')),
      });
      const tool = makeTool('bash', vi.fn().mockRejectedValue(new Error('Failed with secret-in-error')));

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu_1', name: 'bash', input: { command: 'fail' } }]))
        .mockResolvedValueOnce(endTurnResponse('Done'));

      const agent = new Agent({
        name: 'test', model: 'claude-sonnet-4-6',
        tools: [tool], secretStore: store,
      });
      await agent.send('Fail');

      const messages = agent.getMessages();
      const toolResults = messages[2] as { content: Array<{ content: string; is_error: boolean }> };
      expect(toolResults.content[0]!.content).toContain('***rror');
      expect(toolResults.content[0]!.content).not.toContain('secret-in-error');
    });

    it('no effect without secretStore', async () => {
      const tool = makeTool('http_request', vi.fn().mockResolvedValue('result with secret:FAKE'));

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{
          id: 'tu_1', name: 'http_request',
          input: { headers: { Authorization: 'secret:MY_KEY' } },
        }]))
        .mockResolvedValueOnce(endTurnResponse('Done'));

      const agent = new Agent({
        name: 'test', model: 'claude-sonnet-4-6',
        tools: [tool],
        // no secretStore
      });
      await agent.send('Call API');

      // Tool should be called with original input (unresolved)
      expect(tool.handler).toHaveBeenCalled();
      const callArgs = (tool.handler as ReturnType<typeof vi.fn>).mock.calls[0]! as [unknown, unknown];
      const input = callArgs[0] as { headers: { Authorization: string } };
      expect(input.headers.Authorization).toBe('secret:MY_KEY');
    });
  });

  describe('unlimited iterations (maxIterations: 0)', () => {
    it('loops until end_turn with no cap', async () => {
      // 5 tool_use rounds then end_turn — should complete without hitting any cap
      const tool = makeTool('my_tool');
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', maxIterations: 0, tools: [tool] });

      for (let i = 0; i < 5; i++) {
        mockProcess.mockResolvedValueOnce(toolUseResponse([{ id: `t${i}`, name: 'my_tool', input: {} }]));
      }
      mockProcess.mockResolvedValueOnce(endTurnResponse('done'));

      const result = await agent.send('Task');
      expect(result).toBe('done');
      expect(mockProcess).toHaveBeenCalledTimes(6);
    });

    it('never triggers continuation prompt when unlimited', async () => {
      const events: string[] = [];
      const tool = makeTool('my_tool');
      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        maxIterations: 0,
        continuationPrompt: 'Keep going',
        onStream: async (e) => { events.push(e.type); },
        tools: [tool],
      });

      for (let i = 0; i < 5; i++) {
        mockProcess.mockResolvedValueOnce(toolUseResponse([{ id: `t${i}`, name: 'my_tool', input: {} }]));
      }
      mockProcess.mockResolvedValueOnce(endTurnResponse('done'));

      const result = await agent.send('Task');
      expect(result).toBe('done');
      expect(events).not.toContain('continuation');
    });

    it('still handles max_tokens within unlimited loop when continuationPrompt is set', async () => {
      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        maxIterations: 0,
        continuationPrompt: 'Keep going',
      });

      // max_tokens → continuation → end_turn
      mockProcess
        .mockResolvedValueOnce(maxTokensResponse('partial'))
        .mockResolvedValueOnce(endTurnResponse('complete'));

      const result = await agent.send('Task');
      expect(result).toBe('complete');
      expect(mockProcess).toHaveBeenCalledTimes(2);
    });
  });

  describe('toolEnd publish includes input', () => {
    it('publishes truncated input on tool success', async () => {
      const { channels } = await import('./observability.js');
      const tool = makeTool('my_tool', vi.fn().mockResolvedValue('ok'));

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu1', name: 'my_tool', input: { key: 'value' } }]))
        .mockResolvedValueOnce(endTurnResponse('done'));

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [tool] });
      await agent.send('go');

      const calls = vi.mocked(channels.toolEnd.publish).mock.calls;
      const successCall = calls.find(c => (c[0] as { success: boolean }).success === true);
      expect(successCall).toBeDefined();
      const data = successCall![0] as { input?: string };
      expect(data.input).toContain('key');
      expect(data.input).toContain('value');
    });

    it('publishes truncated input on tool failure', async () => {
      const { channels } = await import('./observability.js');
      const tool = makeTool('fail_tool', vi.fn().mockRejectedValue(new Error('oops')));

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu2', name: 'fail_tool', input: { cmd: 'bad' } }]))
        .mockResolvedValueOnce(endTurnResponse('handled'));

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [tool] });
      await agent.send('go');

      const calls = vi.mocked(channels.toolEnd.publish).mock.calls;
      const failCall = calls.find(c => (c[0] as { success: boolean }).success === false);
      expect(failCall).toBeDefined();
      const data = failCall![0] as { input?: string };
      expect(data.input).toContain('cmd');
      expect(data.input).toContain('bad');
    });

    it('truncates input to 2000 chars', async () => {
      const { channels } = await import('./observability.js');
      const bigInput = { data: 'x'.repeat(3000) };
      const tool = makeTool('big_tool', vi.fn().mockResolvedValue('ok'));

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ id: 'tu3', name: 'big_tool', input: bigInput }]))
        .mockResolvedValueOnce(endTurnResponse('done'));

      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [tool] });
      await agent.send('go');

      const calls = vi.mocked(channels.toolEnd.publish).mock.calls;
      const call = calls.find(c => (c[0] as { name: string }).name === 'big_tool');
      expect(call).toBeDefined();
      const data = call![0] as { input?: string };
      expect(data.input!.length).toBeLessThanOrEqual(2000);
    });
  });

  describe('ABSOLUTE_MAX_ITERATIONS', () => {
    it('terminates loop at 500 iterations with error event', async () => {
      const tool = makeTool('loop_tool');
      const events: string[] = [];
      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        tools: [tool],
        maxIterations: 0, // unlimited
        onStream: async (e) => { events.push(e.type); },
      });

      // Always return tool_use to keep looping
      mockProcess.mockResolvedValue(
        toolUseResponse([{ id: 'tu_loop', name: 'loop_tool', input: {} }]),
      );

      const result = await agent.send('Loop forever');
      expect(result).toBe('');
      // Should have called API exactly 500 times
      expect(mockProcess).toHaveBeenCalledTimes(500);
      expect(events).toContain('error');
    });
  });

  describe('MAX_MESSAGE_COUNT', () => {
    it('does not truncate 400 messages', async () => {
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      const msgs = [];
      for (let i = 0; i < 400; i++) {
        msgs.push({ role: (i % 2 === 0 ? 'user' : 'assistant') as const, content: `msg ${i}` });
      }
      agent.loadMessages(msgs);

      mockProcess.mockResolvedValueOnce(endTurnResponse('done'));
      await agent.send('new');

      // 400 + 1 (new user) + 1 (assistant response) = 402, under 500 limit
      const messages = agent.getMessages();
      expect(messages.length).toBeGreaterThanOrEqual(400);
    });

    it('truncates 600 messages to approximately 300', async () => {
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      const msgs = [];
      for (let i = 0; i < 600; i++) {
        msgs.push({ role: (i % 2 === 0 ? 'user' : 'assistant') as const, content: `msg ${i}` });
      }
      agent.loadMessages(msgs);

      mockProcess.mockResolvedValueOnce(endTurnResponse('done'));
      await agent.send('new');

      const messages = agent.getMessages();
      // Should be substantially reduced from 600+ — roughly 300 (60% of 500) + 2 (placeholder + new)
      expect(messages.length).toBeLessThan(400);
      expect(messages.length).toBeGreaterThan(200);
      // Should contain the placeholder message
      const hasPlaceholder = messages.some(m =>
        typeof m.content === 'string' && m.content.includes('earlier message(s) were removed'),
      );
      expect(hasPlaceholder).toBe(true);
    });
  });

  describe('context_pressure event', () => {
    it('emits context_pressure when messages are truncated', async () => {
      const events: StreamEvent[] = [];
      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        onStream: (e: StreamEvent) => { events.push(e); },
      });

      // Fill up message history with enough data to trigger truncation
      // CONTEXT_WINDOW for claude-sonnet-4-6 = 200_000
      // Budget is 85% = 170_000 tokens. Each char ~ 0.25 tokens.
      // So we need ~680_000 chars of messages to trigger.
      const bigContent = 'x'.repeat(200_000);
      for (let i = 0; i < 5; i++) {
        agent.loadMessages([
          ...agent.getMessages(),
          { role: 'user', content: bigContent },
          { role: 'assistant', content: [{ type: 'text' as const, text: bigContent }] },
        ]);
      }

      mockProcess.mockResolvedValueOnce(endTurnResponse('final'));
      await agent.send('new task');

      const pressureEvents = events.filter(e => e.type === 'context_pressure');
      expect(pressureEvents.length).toBeGreaterThanOrEqual(1);
      const pe = pressureEvents[0] as { type: 'context_pressure'; droppedMessages: number; usagePercent: number };
      expect(pe.droppedMessages).toBeGreaterThan(0);
      expect(pe.usagePercent).toBeGreaterThanOrEqual(0);
    });
  });

  describe('tool result truncation', () => {
    it('truncates oversized tool results at default limit', async () => {
      const hugeResult = 'x'.repeat(100_000); // 100K chars, over 80K default
      const tool = makeTool('bash', vi.fn().mockResolvedValue(hugeResult));
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [tool] });

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ name: 'bash', input: { command: 'cat big' } }]))
        .mockResolvedValueOnce(endTurnResponse('done'));
      await agent.send('read big file');

      const msgs = agent.getMessages();
      // Find the tool_result message
      const toolResultMsg = msgs.find(m =>
        m.role === 'user' && Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some(b => b.type === 'tool_result'),
      );
      expect(toolResultMsg).toBeDefined();
      const blocks = toolResultMsg!.content as Array<{ type: string; content: string }>;
      const resultBlock = blocks.find(b => b.type === 'tool_result')!;
      // Should be truncated: 80K limit + suffix
      expect(resultBlock.content.length).toBeLessThan(hugeResult.length);
      expect(resultBlock.content).toContain('truncated');
      expect(resultBlock.content).toContain('100000');
    });

    it('does not truncate tool results under the limit', async () => {
      const normalResult = 'x'.repeat(1000); // 1K chars, well under 80K
      const tool = makeTool('bash', vi.fn().mockResolvedValue(normalResult));
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [tool] });

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ name: 'bash', input: { command: 'echo hi' } }]))
        .mockResolvedValueOnce(endTurnResponse('done'));
      await agent.send('echo hi');

      const msgs = agent.getMessages();
      const toolResultMsg = msgs.find(m =>
        m.role === 'user' && Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some(b => b.type === 'tool_result'),
      );
      const blocks = toolResultMsg!.content as Array<{ type: string; content: string }>;
      const resultBlock = blocks.find(b => b.type === 'tool_result')!;
      expect(resultBlock.content).toBe(normalResult);
    });

    it('publishes contentTruncation event when truncating', async () => {
      const { channels } = await import('./observability.js');
      const publishSpy = vi.mocked(channels.contentTruncation.publish);
      publishSpy.mockClear();

      const hugeResult = 'x'.repeat(100_000);
      const tool = makeTool('bash', vi.fn().mockResolvedValue(hugeResult));
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [tool] });

      mockProcess
        .mockResolvedValueOnce(toolUseResponse([{ name: 'bash', input: { command: 'cat big' } }]))
        .mockResolvedValueOnce(endTurnResponse('done'));
      await agent.send('read');

      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        source: 'tool_result',
        toolName: 'bash',
        originalLength: 100_000,
        truncatedTo: 80_000,
      }));
    });
  });

  describe('context_budget event', () => {
    it('emits context_budget when usage exceeds 70%', async () => {
      const events: StreamEvent[] = [];
      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6', // 200K context
        onStream: (e: StreamEvent) => { events.push(e); },
      });

      // Fill message history to ~73% of context (200K × 0.73 × 3.5 chars/token ≈ 511K chars)
      // Use 85K per message (6 × 85K = 510K) — stays above 70% but below 85% truncation threshold
      const bigContent = 'x'.repeat(85_000);
      for (let i = 0; i < 3; i++) {
        agent.loadMessages([
          ...agent.getMessages(),
          { role: 'user', content: bigContent },
          { role: 'assistant', content: [{ type: 'text' as const, text: bigContent }] },
        ]);
      }

      mockProcess.mockResolvedValueOnce(endTurnResponse('done'));
      await agent.send('task');

      const budgetEvents = events.filter(e => e.type === 'context_budget');
      expect(budgetEvents.length).toBeGreaterThanOrEqual(1);
      const be = budgetEvents[0] as { type: 'context_budget'; systemTokens: number; toolTokens: number;
        messageTokens: number; totalTokens: number; maxTokens: number; usagePercent: number };
      expect(be.maxTokens).toBe(200_000);
      expect(be.usagePercent).toBeGreaterThan(70);
      expect(be.systemTokens).toBeGreaterThan(0);
      expect(be.messageTokens).toBeGreaterThan(0);
    });

    it('does not emit context_budget when usage is low', async () => {
      const events: StreamEvent[] = [];
      const agent = new Agent({
        name: 'test',
        model: 'claude-sonnet-4-6',
        onStream: (e: StreamEvent) => { events.push(e); },
      });

      mockProcess.mockResolvedValueOnce(endTurnResponse('done'));
      await agent.send('hello');

      const budgetEvents = events.filter(e => e.type === 'context_budget');
      expect(budgetEvents.length).toBe(0);
    });
  });
});
