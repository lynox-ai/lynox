/**
 * Telegram notification channel — delivers notifications via Telegram bot.
 * Uses a minimal bot interface to avoid coupling to Telegraf.
 */

import type {
  NotificationChannel,
  NotificationMessage,
} from '../../core/notification-router.js';

// ---------------------------------------------------------------------------
// Module-level storage for task follow-ups (callback handler retrieval)
// ---------------------------------------------------------------------------

const taskFollowUps = new Map<string, Array<{ label: string; task: string }>>();

export function getTaskFollowUp(taskId: string, index: number): { label: string; task: string } | undefined {
  return taskFollowUps.get(taskId)?.[index];
}

// ---------------------------------------------------------------------------
// Module-level storage for task inquiries (question callback handler)
// ---------------------------------------------------------------------------

const taskInquiries = new Map<string, { options?: string[] | undefined }>();

export function getTaskInquiry(taskId: string): { options?: string[] | undefined } | undefined {
  return taskInquiries.get(taskId);
}

export function clearTaskInquiry(taskId: string): void {
  taskInquiries.delete(taskId);
}

// ---------------------------------------------------------------------------
// Minimal bot interface (matches Telegraf instance shape)
// ---------------------------------------------------------------------------

interface TelegramBotLike {
  telegram: {
    sendMessage(
      chatId: number,
      text: string,
      extra?: Record<string, unknown>,
    ): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export class TelegramNotificationChannel implements NotificationChannel {
  readonly name = 'telegram';

  constructor(
    private readonly bot: TelegramBotLike,
    private readonly chatId: number,
  ) {}

  async send(msg: NotificationMessage): Promise<boolean> {
    try {
      // Use ❓ icon for inquiry messages, otherwise priority-based icon
      const icon = msg.inquiry
        ? '\u{2753}'
        : msg.priority === 'high'
          ? '\u{1F534}'
          : msg.priority === 'low'
            ? '\u{1F4A4}'
            : '\u{1F4CB}';

      const header = `${icon} <b>${escapeHtml(msg.title)}</b>`;
      const body = escapeHtml(msg.body);
      const taskRef = msg.taskId
        ? `\n\n<i>Task: ${escapeHtml(msg.taskId)}</i>`
        : '';
      const text = `${header}\n\n${body}${taskRef}`;

      // Telegram message limit is 4096 chars
      const truncated =
        text.length > 4000 ? text.slice(0, 4000) + '\u2026' : text;

      const extra: Record<string, unknown> = { parse_mode: 'HTML' };

      // Inquiry messages: store inquiry state and build inline keyboard
      if (msg.inquiry && msg.taskId) {
        taskInquiries.set(msg.taskId, { options: msg.inquiry.options });
        if (msg.inquiry.options && msg.inquiry.options.length > 0) {
          extra['reply_markup'] = {
            inline_keyboard: [msg.inquiry.options.map((opt, i) => ({
              text: opt,
              callback_data: `q:${msg.taskId}:${i}`,
            }))],
          };
        }
        // If no options, the message text itself serves as the prompt
        // (user replies via the button-based flow only in v1)
      } else if (msg.followUps && msg.followUps.length > 0 && msg.taskId) {
        taskFollowUps.set(msg.taskId, msg.followUps);
        extra['reply_markup'] = {
          inline_keyboard: [msg.followUps.map((f, i) => ({
            text: f.label,
            callback_data: `t:${msg.taskId}:${i}`,
          }))],
        };
      }

      await this.bot.telegram.sendMessage(this.chatId, truncated, extra);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
