import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock telegraf module — class must be defined inside vi.mock factory
// because vi.mock is hoisted to the top of the file
// ---------------------------------------------------------------------------

const mockUse = vi.fn();
const mockCommand = vi.fn();
const mockOn = vi.fn();
const mockLaunch = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();
const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
const mockEditMessageText = vi.fn().mockResolvedValue({});

vi.mock('telegraf', () => {
  return {
    Telegraf: class {
      use = mockUse;
      command = mockCommand;
      on = mockOn;
      launch = mockLaunch;
      stop = mockStop;
      telegram = {
        sendMessage: mockSendMessage,
        editMessageText: mockEditMessageText,
      };
    },
  };
});

vi.mock('telegraf/filters', () => ({
  message: (type: string) => type,
}));

// Mock the runner to isolate bot tests
vi.mock('./telegram-runner.js', () => ({
  executeRun: vi.fn(),
  hasActiveRun: vi.fn().mockReturnValue(false),
  resolveInput: vi.fn().mockReturnValue(false),
  abortRun: vi.fn(),
  getFollowUpTask: vi.fn().mockReturnValue(null),
}));

import { startTelegramBot, stopTelegramBot } from './telegram-bot.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('telegram-bot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['NODYN_TELEGRAM_OPEN_ACCESS'] = 'true';
  });

  afterEach(() => {
    delete process.env['NODYN_TELEGRAM_OPEN_ACCESS'];
  });

  it('creates bot and registers handlers', async () => {
    const nodyn = {
      run: vi.fn(),
      abort: vi.fn(),
      onStream: null,
      promptUser: null,
    };

    await startTelegramBot({ token: 'test-token', nodyn: nodyn as never });

    // Should register commands
    expect(mockCommand).toHaveBeenCalledWith('start', expect.any(Function));
    expect(mockCommand).toHaveBeenCalledWith('help', expect.any(Function));
    expect(mockCommand).toHaveBeenCalledWith('stop', expect.any(Function));
    expect(mockCommand).toHaveBeenCalledWith('status', expect.any(Function));

    // Should register message handlers
    expect(mockOn).toHaveBeenCalledWith('text', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('document', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('photo', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('callback_query', expect.any(Function));

    // Should launch
    expect(mockLaunch).toHaveBeenCalled();

    await stopTelegramBot();
  });

  it('sets up allowedChatIds middleware when provided', async () => {
    const nodyn = {
      run: vi.fn(),
      abort: vi.fn(),
      onStream: null,
      promptUser: null,
    };

    await startTelegramBot({
      token: 'test-token',
      allowedChatIds: [123, 456],
      nodyn: nodyn as never,
    });

    // Should have registered middleware
    expect(mockUse).toHaveBeenCalled();

    await stopTelegramBot();
  });

  it('does not set up allowlist middleware with NODYN_TELEGRAM_OPEN_ACCESS', async () => {
    const nodyn = {
      run: vi.fn(),
      abort: vi.fn(),
      onStream: null,
      promptUser: null,
    };

    await startTelegramBot({ token: 'test-token', nodyn: nodyn as never });

    // Should not register allowlist middleware (open access mode)
    expect(mockUse).not.toHaveBeenCalled();

    await stopTelegramBot();
  });

  it('starts in setup mode without allowedChatIds', async () => {
    delete process.env['NODYN_TELEGRAM_OPEN_ACCESS'];
    const nodyn = {
      run: vi.fn(),
      abort: vi.fn(),
      onStream: null,
      promptUser: null,
    };

    // Should NOT throw — starts in setup mode instead
    await startTelegramBot({ token: 'test-token', nodyn: nodyn as never });
    await stopTelegramBot();
  });

  it('stopTelegramBot calls bot.stop()', async () => {
    const nodyn = {
      run: vi.fn(),
      abort: vi.fn(),
      onStream: null,
      promptUser: null,
    };

    await startTelegramBot({ token: 'test-token', nodyn: nodyn as never });
    await stopTelegramBot();

    expect(mockStop).toHaveBeenCalledWith('shutdown');
  });

  it('cleans up signal listeners on stop', async () => {
    const nodyn = {
      run: vi.fn(),
      abort: vi.fn(),
      onStream: null,
      promptUser: null,
    };

    const removeListenerSpy = vi.spyOn(process, 'removeListener');

    await startTelegramBot({ token: 'test-token', nodyn: nodyn as never });
    await stopTelegramBot();

    expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(removeListenerSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    removeListenerSpy.mockRestore();
  });

  it('does not leak signal listeners across multiple start/stop cycles', async () => {
    const nodyn = {
      run: vi.fn(),
      abort: vi.fn(),
      onStream: null,
      promptUser: null,
    };

    const sigintBefore = process.listenerCount('SIGINT');

    await startTelegramBot({ token: 'test-token', nodyn: nodyn as never });
    await stopTelegramBot();
    await startTelegramBot({ token: 'test-token', nodyn: nodyn as never });
    await stopTelegramBot();

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
  });

  it('registers callback_query handler that supports follow-up type', async () => {
    const nodyn = {
      run: vi.fn(),
      abort: vi.fn(),
      onStream: null,
      promptUser: null,
    };

    await startTelegramBot({ token: 'test-token', nodyn: nodyn as never });

    // callback_query handler should be registered
    expect(mockOn).toHaveBeenCalledWith('callback_query', expect.any(Function));

    // Get the callback handler
    const cbCall = mockOn.mock.calls.find(
      (c: unknown[]) => c[0] === 'callback_query',
    );
    expect(cbCall).toBeDefined();

    // Simulate a follow-up callback with no matching task (expired)
    const cbHandler = cbCall![1] as (ctx: unknown) => void;
    const mockCtx = {
      callbackQuery: { data: JSON.stringify({ t: 'f', i: 0 }) },
      chat: { id: 123 },
      answerCbQuery: vi.fn().mockResolvedValue(undefined),
    };
    cbHandler(mockCtx);

    // Should answer with friendly expiration message since getFollowUpTask returns null
    expect(mockCtx.answerCbQuery).toHaveBeenCalledWith('These suggestions are no longer current. Just send me your next request!');

    await stopTelegramBot();
  });
});
