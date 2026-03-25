import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeRun, hasActiveRun, resolveInput, abortRun, getFollowUpTask, _resetRunnerState } from './telegram-runner.js';
import { sessionMap, runQueue } from './telegram-session.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockBot() {
  return {
    telegram: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue({}),
    },
  } as unknown as import('telegraf').Telegraf;
}

function createMockSession() {
  let _onStream: ((event: unknown) => void) | null = null;
  let _promptUser: unknown = null;
  let _messages: unknown[] = [];

  return {
    run: vi.fn().mockResolvedValue('Task completed successfully.'),
    abort: vi.fn(),
    reset: vi.fn().mockImplementation(() => { _messages = []; }),
    saveMessages: vi.fn().mockImplementation(() => [..._messages]),
    loadMessages: vi.fn().mockImplementation((msgs: unknown[]) => { _messages = [...msgs]; }),
    get onStream() { return _onStream; },
    set onStream(fn: unknown) { _onStream = fn as typeof _onStream; },
    get promptUser() { return _promptUser; },
    set promptUser(fn: unknown) { _promptUser = fn; },
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    getModelTier: vi.fn().mockReturnValue('sonnet'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('telegram-runner', () => {
  let bot: ReturnType<typeof createMockBot>;
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    bot = createMockBot();
    session = createMockSession();
    _resetRunnerState();
    sessionMap.clearAll();
    runQueue.reset();
  });

  describe('executeRun', () => {
    it('sends status message and result', async () => {
      await executeRun(bot, session as never, 123, 'test task');

      // Status message sent
      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
        123,
        expect.stringContaining('Thinking'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );

      // Result sent
      const calls = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const resultCall = calls.find((c: unknown[]) =>
        typeof c[1] === 'string' && (c[1] as string).includes('Task completed successfully'),
      );
      expect(resultCall).toBeDefined();

      // Status updated to done
      expect(bot.telegram.editMessageText).toHaveBeenCalledWith(
        123, 42, undefined,
        expect.stringContaining('Done'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );

      // Run cleaned up
      expect(hasActiveRun(123)).toBe(false);
    });

    it('rejects concurrent runs', async () => {
      // Start a run that blocks
      const blockingSession = createMockSession();
      blockingSession.run.mockReturnValue(new Promise(() => {})); // never resolves

      // Start first run (don't await — it will block)
      void executeRun(bot, blockingSession as never, 456, 'blocking');

      // Wait a tick for the first run to register in activeRuns
      await new Promise(r => setTimeout(r, 10));

      // Try to start another — should get "busy" reply
      await executeRun(bot, session as never, 456, 'second task');

      // Should get friendly "busy" message
      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
        456,
        expect.stringContaining('still working'),
      );

      // Clean up: abort the blocking run
      await abortRun(456, blockingSession as never);
    });

    it('handles errors', async () => {
      session.run.mockRejectedValue(new Error('Something failed'));

      await executeRun(bot, session as never, 789, 'failing task');

      // Error status update
      expect(bot.telegram.editMessageText).toHaveBeenCalledWith(
        789, 42, undefined,
        expect.stringContaining('Error'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );

      // Error message sent
      const calls = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const errorCall = calls.find((c: unknown[]) =>
        typeof c[1] === 'string' && (c[1] as string).includes('Something failed'),
      );
      expect(errorCall).toBeDefined();
    });

    it('tracks tool calls and shows done status with tool list', async () => {
      session.run.mockImplementation(async () => {
        const handler = session.onStream as ((event: Record<string, unknown>) => void) | null;
        if (handler) {
          handler({ type: 'tool_call', name: 'bash', input: { command: 'npm test' }, agent: 'test' });
          handler({ type: 'tool_result', name: 'bash', result: 'All tests passed', agent: 'test' });
          handler({ type: 'tool_call', name: 'read_file', input: { path: 'src/index.ts' }, agent: 'test' });
          handler({ type: 'tool_result', name: 'read_file', result: 'file content here', agent: 'test' });
        }
        return 'done';
      });

      await executeRun(bot, session as never, 100, 'tool task');

      // Done status should include tool list
      const editCalls = (bot.telegram.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
      const doneCall = editCalls.find((c: unknown[]) =>
        typeof c[3] === 'string' && (c[3] as string).includes('Done'),
      );
      expect(doneCall).toBeDefined();
      const doneText = doneCall![3] as string;
      expect(doneText).toContain('Running command');
      expect(doneText).toContain('Reading file');
      expect(doneText).toContain('✅');
    });

    it('shows failed tool with ❌ in done status', async () => {
      session.run.mockImplementation(async () => {
        const handler = session.onStream as ((event: Record<string, unknown>) => void) | null;
        if (handler) {
          handler({ type: 'tool_call', name: 'bash', input: { command: 'bad cmd' }, agent: 'test' });
          handler({ type: 'tool_result', name: 'bash', result: 'Error: command not found', agent: 'test' });
        }
        return 'failed tool result';
      });

      await executeRun(bot, session as never, 101, 'fail tool task');

      const editCalls = (bot.telegram.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
      const doneCall = editCalls.find((c: unknown[]) =>
        typeof c[3] === 'string' && (c[3] as string).includes('Done'),
      );
      expect(doneCall).toBeDefined();
      expect(doneCall![3] as string).toContain('❌');
    });

    it('shows tool input previews in status', async () => {
      session.run.mockImplementation(async () => {
        const handler = session.onStream as ((event: Record<string, unknown>) => void) | null;
        if (handler) {
          handler({ type: 'tool_call', name: 'bash', input: { command: 'npm test' }, agent: 'test' });
          handler({ type: 'tool_result', name: 'bash', result: 'ok', agent: 'test' });
        }
        return 'done';
      });

      await executeRun(bot, session as never, 102, 'preview task');

      const editCalls = (bot.telegram.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
      const doneCall = editCalls.find((c: unknown[]) =>
        typeof c[3] === 'string' && (c[3] as string).includes('Done'),
      );
      expect(doneCall).toBeDefined();
      expect(doneCall![3] as string).toContain('npm test');
    });

    it('always posts result as one clean message', async () => {
      const longResult = 'This is the complete result text.';
      session.run.mockImplementation(async () => {
        const handler = session.onStream as ((event: Record<string, unknown>) => void) | null;
        if (handler) {
          // Text events are ignored — result posted as one message at the end
          handler({ type: 'text', text: 'This is ', agent: 'test' });
          handler({ type: 'text', text: 'the complete result text.', agent: 'test' });
        }
        return longResult;
      });

      await executeRun(bot, session as never, 103, 'text task');

      const calls = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const resultCall = calls.find((c: unknown[]) =>
        typeof c[1] === 'string' && (c[1] as string).includes('complete result text'),
      );
      expect(resultCall).toBeDefined();
    });

    it('attaches follow-up keyboard to result message', async () => {
      session.run.mockImplementation(async () => {
        const handler = session.onStream as ((event: Record<string, unknown>) => void) | null;
        if (handler) {
          handler({ type: 'tool_call', name: 'bash', input: { command: 'npm test' }, agent: 'test' });
          handler({ type: 'tool_result', name: 'bash', result: 'ok', agent: 'test' });
        }
        return 'Tests passed. Here are the next steps.';
      });

      await executeRun(bot, session as never, 105, 'test task');

      // Follow-up keyboard should be attached to a result message, not a separate "Suggestions:" message
      const calls = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const withKeyboard = calls.find((c: unknown[]) =>
        c[2] && typeof c[2] === 'object' && 'reply_markup' in (c[2] as object),
      );
      expect(withKeyboard).toBeDefined();
      // No separate "Suggestions:" message
      const suggestionsMsg = calls.find((c: unknown[]) =>
        typeof c[1] === 'string' && (c[1] as string).includes('Suggestions'),
      );
      expect(suggestionsMsg).toBeUndefined();
    });

    it('attaches follow-up keyboard to error message', async () => {
      session.run.mockRejectedValue(new Error('Build failed'));

      await executeRun(bot, session as never, 106, 'failing task');

      const calls = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const errorWithKeyboard = calls.find((c: unknown[]) =>
        typeof c[1] === 'string' && (c[1] as string).includes('Build failed')
        && c[2] && typeof c[2] === 'object' && 'reply_markup' in (c[2] as object),
      );
      expect(errorWithKeyboard).toBeDefined();
    });

    it('does not post separate messages for thinking or tools', async () => {
      session.run.mockImplementation(async () => {
        const handler = session.onStream as ((event: Record<string, unknown>) => void) | null;
        if (handler) {
          handler({ type: 'thinking', thinking: 'Let me think about this', agent: 'test' });
          handler({ type: 'thinking_done', agent: 'test' });
          handler({ type: 'tool_call', name: 'bash', input: { command: 'echo hi' }, agent: 'test' });
          handler({ type: 'tool_result', name: 'bash', result: 'hi', agent: 'test' });
          handler({ type: 'spawn', agents: ['worker1'], agent: 'test' });
        }
        return 'done';
      });

      await executeRun(bot, session as never, 107, 'quiet task');

      const calls = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      // Should only have: status msg, result msg, suggestions msg — no thinking/tool/spawn msgs
      const thinkingMsg = calls.find((c: unknown[]) =>
        typeof c[1] === 'string' && (c[1] as string).includes('💭'),
      );
      const spawnMsg = calls.find((c: unknown[]) =>
        typeof c[1] === 'string' && (c[1] as string).includes('🔀'),
      );
      expect(thinkingMsg).toBeUndefined();
      expect(spawnMsg).toBeUndefined();
    });
  });

  describe('resolveInput', () => {
    it('returns false when no active run', () => {
      expect(resolveInput(999, 'answer')).toBe(false);
    });

    it('resolves pending input during a run', async () => {
      let capturedAnswer = '';

      session.run.mockImplementation(async () => {
        // Trigger promptUser
        if (session.promptUser) {
          const answer = await (session.promptUser as (q: string) => Promise<string>)('Choose one');
          capturedAnswer = answer;
        }
        return 'result';
      });

      const runPromise = executeRun(bot, session as never, 200, 'input task');

      // Wait a tick for promptUser to be called
      await new Promise(r => setTimeout(r, 50));

      // Resolve the input
      const resolved = resolveInput(200, 'my answer');
      expect(resolved).toBe(true);

      await runPromise;
      expect(capturedAnswer).toBe('my answer');
    });
  });

  describe('abortRun', () => {
    it('calls session.abort()', async () => {
      const blockingSession = createMockSession();
      blockingSession.run.mockReturnValue(new Promise(() => {}));

      const runPromise = executeRun(bot, blockingSession as never, 300, 'long task');

      // Wait for run to start
      await new Promise(r => setTimeout(r, 10));

      await abortRun(300, blockingSession as never);
      expect(blockingSession.abort).toHaveBeenCalled();
    });
  });

  describe('hasActiveRun', () => {
    it('returns false when no run', () => {
      expect(hasActiveRun(999)).toBe(false);
    });
  });

  describe('getFollowUpTask', () => {
    it('returns null when no follow-ups exist', () => {
      expect(getFollowUpTask(999, 0)).toBeNull();
    });

    it('returns null for invalid index', () => {
      expect(getFollowUpTask(999, 99)).toBeNull();
    });
  });

  describe('rate limiting', () => {
    it('logs rate limit errors from editStatus instead of swallowing', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      // Make editMessageText always fail with 429
      bot.telegram.editMessageText = vi.fn()
        .mockRejectedValue({ code: 429, message: 'Too Many Requests' });

      session.run.mockImplementation(async () => {
        const handler = session.onStream as ((event: Record<string, unknown>) => void) | null;
        if (handler) {
          // Fire rapid tool calls to trigger editStatus
          handler({ type: 'tool_call', name: 'bash', input: {}, agent: 'test' });
          // Wait for MIN_EDIT_INTERVAL to pass
          await new Promise(r => setTimeout(r, 3100));
          handler({ type: 'tool_call', name: 'read_file', input: {}, agent: 'test' });
          await new Promise(r => setTimeout(r, 100));
        }
        return 'done';
      });

      await executeRun(bot, session as never, 500, 'rate limit task');

      const stderrCalls = stderrSpy.mock.calls.map(c => String(c[0]));
      const hasRateLimitLog = stderrCalls.some(c => c.includes('rate limited'));
      expect(hasRateLimitLog).toBe(true);

      stderrSpy.mockRestore();
    });

    it('ignores message-not-modified errors silently', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      bot.telegram.editMessageText = vi.fn()
        .mockRejectedValue(new Error('400: Bad Request: message is not modified'));

      session.run.mockImplementation(async () => {
        const handler = session.onStream as ((event: Record<string, unknown>) => void) | null;
        if (handler) {
          handler({ type: 'tool_call', name: 'bash', input: {}, agent: 'test' });
          await new Promise(r => setTimeout(r, 3100));
          handler({ type: 'tool_call', name: 'bash', input: {}, agent: 'test' });
          await new Promise(r => setTimeout(r, 100));
        }
        return 'done';
      });

      await executeRun(bot, session as never, 501, 'unchanged task');

      const stderrCalls = stderrSpy.mock.calls.map(c => String(c[0]));
      const hasEditError = stderrCalls.some(c => c.includes('editStatus failed'));
      expect(hasEditError).toBe(false);

      stderrSpy.mockRestore();
    });
  });

  describe('stale timeout', () => {
    it('aborts run when no stream events for stale period', async () => {
      vi.useFakeTimers();

      const blockingSession = createMockSession();
      // Run that blocks forever
      blockingSession.run.mockReturnValue(new Promise(() => {}));

      const runPromise = executeRun(bot, blockingSession as never, 600, 'stale task');

      // Wait for run to register
      await vi.advanceTimersByTimeAsync(10);
      expect(hasActiveRun(600)).toBe(true);

      // Advance past stale timeout (5 min check interval is 30s)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 30_000);

      expect(blockingSession.abort).toHaveBeenCalled();

      // Stale message sent
      const calls = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const staleCall = calls.find((c: unknown[]) =>
        typeof c[1] === 'string' && (c[1] as string).includes('timed out'),
      );
      expect(staleCall).toBeDefined();

      vi.useRealTimers();
    });
  });

  describe('handler restoration', () => {
    it('restores previous promptUser after run', async () => {
      const originalPromptUser = vi.fn().mockResolvedValue('original');
      session.promptUser = originalPromptUser as never;

      await executeRun(bot, session as never, 700, 'restore task');

      expect(session.promptUser).toBe(originalPromptUser);
    });

    it('restores previous onStream after run', async () => {
      const originalOnStream = vi.fn();
      session.onStream = originalOnStream;

      await executeRun(bot, session as never, 701, 'restore task');

      expect(session.onStream).toBe(originalOnStream);
    });

    it('restores handlers even on error', async () => {
      const originalOnStream = vi.fn();
      const originalPromptUser = vi.fn().mockResolvedValue('original');
      session.onStream = originalOnStream;
      session.promptUser = originalPromptUser as never;

      session.run.mockRejectedValue(new Error('boom'));

      await executeRun(bot, session as never, 702, 'error task');

      expect(session.onStream).toBe(originalOnStream);
      expect(session.promptUser).toBe(originalPromptUser);
    });
  });
});
