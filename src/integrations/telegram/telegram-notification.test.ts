import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationMessage } from '../../core/notification-router.js';
import { TelegramNotificationChannel } from './telegram-notification.js';
import { getTaskInquiry, clearTaskInquiry } from './telegram-callbacks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBot() {
  return {
    telegram: {
      sendMessage: vi
        .fn<
          (
            chatId: number,
            text: string,
            extra?: Record<string, unknown>,
          ) => Promise<{ message_id: number }>
        >()
        .mockResolvedValue({ message_id: 1 }),
    },
  };
}

const CHAT_ID = 42;

const MSG: NotificationMessage = {
  title: 'Daily Report',
  body: 'Revenue is up 12% this week.',
  priority: 'normal',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramNotificationChannel', () => {
  let bot: ReturnType<typeof makeBot>;
  let channel: TelegramNotificationChannel;

  beforeEach(() => {
    bot = makeBot();
    channel = new TelegramNotificationChannel(bot, CHAT_ID);
  });

  it('has name "telegram"', () => {
    expect(channel.name).toBe('telegram');
  });

  it('formats message as HTML and sends via bot', async () => {
    await channel.send(MSG);

    expect(bot.telegram.sendMessage).toHaveBeenCalledOnce();

    const [chatId, text, extra] = bot.telegram.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(CHAT_ID);
    expect(text).toContain('<b>Daily Report</b>');
    expect(text).toContain('Revenue is up 12% this week.');
    expect(extra).toEqual({ parse_mode: 'HTML' });
  });

  it('returns true on success', async () => {
    const result = await channel.send(MSG);
    expect(result).toBe(true);
  });

  it('returns false when bot.telegram.sendMessage throws', async () => {
    bot.telegram.sendMessage.mockRejectedValue(new Error('network timeout'));

    const result = await channel.send(MSG);
    expect(result).toBe(false);
  });

  it('shows red circle icon for high priority', async () => {
    await channel.send({ ...MSG, priority: 'high' });

    const text = bot.telegram.sendMessage.mock.calls[0]![1];
    expect(text).toMatch(/^\u{1F534}/u);
  });

  it('shows sleeping icon for low priority', async () => {
    await channel.send({ ...MSG, priority: 'low' });

    const text = bot.telegram.sendMessage.mock.calls[0]![1];
    expect(text).toMatch(/^\u{1F4A4}/u);
  });

  it('shows clipboard icon for normal priority', async () => {
    await channel.send(MSG);

    const text = bot.telegram.sendMessage.mock.calls[0]![1];
    expect(text).toMatch(/^\u{1F4CB}/u);
  });

  it('truncates messages longer than 4000 chars', async () => {
    const longMsg: NotificationMessage = {
      title: 'Big',
      body: 'x'.repeat(5000),
      priority: 'normal',
    };

    await channel.send(longMsg);

    const text = bot.telegram.sendMessage.mock.calls[0]![1];
    expect(text.length).toBeLessThanOrEqual(4001); // 4000 + ellipsis char
    expect(text.endsWith('\u2026')).toBe(true);
  });

  it('escapes HTML special chars in title and body', async () => {
    const htmlMsg: NotificationMessage = {
      title: '<script>alert("xss")</script>',
      body: 'A & B > C < D',
      priority: 'normal',
    };

    await channel.send(htmlMsg);

    const text = bot.telegram.sendMessage.mock.calls[0]![1];
    expect(text).toContain('&lt;script&gt;alert("xss")&lt;/script&gt;');
    expect(text).toContain('A &amp; B &gt; C &lt; D');
    // Must not contain raw HTML tags from user input
    expect(text).not.toContain('<script>');
  });

  it('includes task reference when taskId is provided', async () => {
    const taskMsg: NotificationMessage = {
      ...MSG,
      taskId: 'task-abc-123',
    };

    await channel.send(taskMsg);

    const text = bot.telegram.sendMessage.mock.calls[0]![1];
    expect(text).toContain('<i>Task: task-abc-123</i>');
  });

  it('omits task reference when taskId is not provided', async () => {
    await channel.send(MSG);

    const text = bot.telegram.sendMessage.mock.calls[0]![1];
    expect(text).not.toContain('Task:');
  });

  // -------------------------------------------------------------------------
  // Inquiry flow
  // -------------------------------------------------------------------------

  describe('inquiry flow', () => {
    it('send() with inquiry builds inline keyboard with q: callback data', async () => {
      const inquiryMsg: NotificationMessage = {
        title: 'Choose next step',
        body: 'What should I do next?',
        priority: 'normal',
        taskId: 'task-inq-1',
        inquiry: {
          question: 'What should I do next?',
          options: ['Option A', 'Option B', 'Option C'],
        },
      };

      await channel.send(inquiryMsg);

      const extra = bot.telegram.sendMessage.mock.calls[0]![2] as Record<string, unknown>;
      expect(extra).toBeDefined();
      expect(extra['reply_markup']).toBeDefined();

      const markup = extra['reply_markup'] as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(markup.inline_keyboard).toHaveLength(1);

      const buttons = markup.inline_keyboard[0]!;
      expect(buttons).toHaveLength(3);
      expect(buttons[0]!.text).toBe('Option A');
      expect(buttons[0]!.callback_data).toBe('q:task-inq-1:0');
      expect(buttons[1]!.text).toBe('Option B');
      expect(buttons[1]!.callback_data).toBe('q:task-inq-1:1');
      expect(buttons[2]!.text).toBe('Option C');
      expect(buttons[2]!.callback_data).toBe('q:task-inq-1:2');
    });

    it('send() with inquiry and options builds buttons for each option', async () => {
      const inquiryMsg: NotificationMessage = {
        title: 'Confirm action',
        body: 'Proceed with deployment?',
        priority: 'normal',
        taskId: 'task-inq-2',
        inquiry: {
          question: 'Proceed with deployment?',
          options: ['Yes', 'No'],
        },
      };

      await channel.send(inquiryMsg);

      const extra = bot.telegram.sendMessage.mock.calls[0]![2] as Record<string, unknown>;
      const markup = extra['reply_markup'] as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
      const buttons = markup.inline_keyboard[0]!;
      expect(buttons).toHaveLength(2);
      expect(buttons[0]!.text).toBe('Yes');
      expect(buttons[1]!.text).toBe('No');
    });

    it('getTaskInquiry() returns stored inquiry after send', async () => {
      const inquiryMsg: NotificationMessage = {
        title: 'Pick one',
        body: 'Which report format?',
        priority: 'normal',
        taskId: 'task-inq-3',
        inquiry: {
          question: 'Which report format?',
          options: ['PDF', 'CSV'],
        },
      };

      await channel.send(inquiryMsg);

      const stored = getTaskInquiry('task-inq-3');
      expect(stored).toBeDefined();
      expect(stored!.options).toEqual(['PDF', 'CSV']);
    });

    it('clearTaskInquiry() removes the entry', async () => {
      const inquiryMsg: NotificationMessage = {
        title: 'Pick one',
        body: 'Which report format?',
        priority: 'normal',
        taskId: 'task-inq-4',
        inquiry: {
          question: 'Which report format?',
          options: ['PDF', 'CSV'],
        },
      };

      await channel.send(inquiryMsg);
      expect(getTaskInquiry('task-inq-4')).toBeDefined();

      clearTaskInquiry('task-inq-4');
      expect(getTaskInquiry('task-inq-4')).toBeUndefined();
    });

    it('send() with inquiry uses question mark icon instead of priority icon', async () => {
      const inquiryMsg: NotificationMessage = {
        title: 'User Input Needed',
        body: 'Please confirm the target.',
        priority: 'high',
        taskId: 'task-inq-5',
        inquiry: {
          question: 'Please confirm the target.',
          options: ['Production', 'Staging'],
        },
      };

      await channel.send(inquiryMsg);

      const text = bot.telegram.sendMessage.mock.calls[0]![1];
      // Should use question mark icon (U+2753), not the red circle (U+1F534) for high priority
      expect(text).toMatch(/^\u{2753}/u);
      expect(text).not.toMatch(/^\u{1F534}/u);
    });

    it('send() with inquiry but no options does not add reply_markup', async () => {
      const inquiryMsg: NotificationMessage = {
        title: 'Free-form Question',
        body: 'What is your budget?',
        priority: 'normal',
        taskId: 'task-inq-6',
        inquiry: {
          question: 'What is your budget?',
        },
      };

      await channel.send(inquiryMsg);

      const extra = bot.telegram.sendMessage.mock.calls[0]![2] as Record<string, unknown>;
      // parse_mode is set but no reply_markup when no options
      expect(extra['parse_mode']).toBe('HTML');
      expect(extra['reply_markup']).toBeUndefined();
    });

    it('send() with inquiry stores entry even without options', async () => {
      const inquiryMsg: NotificationMessage = {
        title: 'Open Question',
        body: 'Describe your requirements.',
        priority: 'normal',
        taskId: 'task-inq-7',
        inquiry: {
          question: 'Describe your requirements.',
        },
      };

      await channel.send(inquiryMsg);

      const stored = getTaskInquiry('task-inq-7');
      expect(stored).toBeDefined();
      expect(stored!.options).toBeUndefined();
    });
  });
});
