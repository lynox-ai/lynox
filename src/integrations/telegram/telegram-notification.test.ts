import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationMessage } from '../../core/notification-router.js';
import { TelegramNotificationChannel } from './telegram-notification.js';

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
            extra?: { parse_mode?: string | undefined },
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
});
