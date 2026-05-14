// === Telegram Bot ===
// Telegraf setup, message routing, commands.

import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { executeRun, hasActiveRun, resolveInput, resolveInputByIndex, abortRun, getFollowUpTask } from './telegram-runner.js';
import { getTaskInquiry, clearTaskInquiry, getTaskFollowUp } from './telegram-callbacks.js';
import { sessionMap, startEvictionTimer, stopEvictionTimer } from './telegram-session.js';
import type { TelegramEngine } from './telegram-session.js';
import { t, detectLang } from './telegram-i18n.js';
import { createRateLimiterFromEnv } from '../../core/rate-limiter.js';
import { wrapChannelMessage } from '../../core/data-boundary.js';
import { HAS_WHISPER, transcribe, extractSessionContext } from '../../core/transcribe.js';
import type { Engine } from '../../core/engine.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;    // 4MB — Claude's limit is ~5MB base64
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10MB — practical limit for file analysis

/** System prompt suffix injected into every per-chat Session. */
const TELEGRAM_SYSTEM_PROMPT_SUFFIX = '\n\n## Telegram Mode\nYou are running inside a Telegram bot. The user communicates with you via Telegram messages.\n- Files you create with write_file are automatically sent to the user as Telegram documents. Just write the file — no extra steps needed.\n- Voice messages from the user are automatically transcribed and sent to you as text.\n- You cannot send images or media directly — only text replies and files via write_file.\n- Keep responses concise — Telegram messages are split at 4096 characters.\n- Do NOT ask the user to set up Telegram, email, or other integrations — you are already connected.\n\n### Follow-up suggestions\nAt the very end of every response, include a `<follow_ups>` block with 2-4 contextual follow-up actions the user might want to take next. Use the user\'s language for labels.\n\nFormat:\n<follow_ups>[{"label":"Short label","task":"Full task description for the agent"}]</follow_ups>\n\nRules:\n- Labels: 2-4 words, max 20 characters (these become Telegram buttons)\n- Tasks: complete instructions that the agent can execute independently\n- Be contextual — suggest actions that make sense given what just happened\n- No filler — if nothing useful comes to mind, output an empty array\n- Always place the block as the very last thing in your response';

export interface TelegramBotOptions {
  token: string;
  allowedChatIds?: number[] | undefined;
  engine: TelegramEngine;
}

let bot: Telegraf | null = null;
let signalHandler: (() => void) | null = null;

export async function startTelegramBot(options: TelegramBotOptions): Promise<void> {
  const { token, allowedChatIds, engine } = options;

  bot = new Telegraf(token);

  // --- Security: chat ID allowlist ---
  const setupMode = !allowedChatIds || allowedChatIds.length === 0;
  if (setupMode) {
    if (process.env['LYNOX_TELEGRAM_OPEN_ACCESS'] === 'true') {
      process.stderr.write(
        '\n🛑 LYNOX_TELEGRAM_OPEN_ACCESS is no longer supported.\n'
        + '  Open access gives every Telegram user full engine access (bash, files, memory).\n'
        + '  Set TELEGRAM_ALLOWED_CHAT_IDS instead. Start the bot without it to see your chat ID.\n\n',
      );
      throw new Error('LYNOX_TELEGRAM_OPEN_ACCESS removed for security. Use TELEGRAM_ALLOWED_CHAT_IDS.');
    } else {
      // Setup mode: show chat ID to any user, don't process tasks
      process.stderr.write('\nLYNOX Telegram: Setup mode — no TELEGRAM_ALLOWED_CHAT_IDS configured.\n  Bot will show chat IDs to users. Set the IDs and restart.\n\n');
      bot.use((ctx, next) => {
        const chatId = ctx.chat?.id;
        if (chatId !== undefined) {
          void ctx.reply(
            `🔧 <b>Setup</b>\n\n`
            + `Your chat ID is: <code>${chatId}</code>\n\n`
            + `Add this to your deployment:\n`
            + `<code>TELEGRAM_ALLOWED_CHAT_IDS=${chatId}</code>\n\n`
            + `Then restart lynox.`,
            { parse_mode: 'HTML' },
          );
        }
        return next();
      });
      // Don't register any commands or handlers — just the setup middleware
      startEvictionTimer();
      await bot.launch();
      process.stderr.write('LYNOX Telegram bot running (setup mode).\n');
      return;
    }
  }
  if (allowedChatIds && allowedChatIds.length > 0) {
    const allowed = new Set(allowedChatIds);
    bot.use((ctx, next) => {
      const chatId = ctx.chat?.id;
      if (chatId !== undefined && !allowed.has(chatId)) {
        process.stderr.write(`Telegram: unauthorized chat ID ${chatId}\n`);
        void ctx.reply('⛔ Unauthorized.');
        return;
      }
      return next();
    });
  }

  // --- Rate limiting ---
  const rateLimiter = createRateLimiterFromEnv();

  /** Wrap executeRun with rate limiter acquire/release. */
  function rateLimitedRun(chatId: number, task: string | unknown[], langCode: string | undefined, replyFn: (msg: string) => void): void {
    const userId = String(chatId);
    const lang = detectLang(langCode);
    const result = rateLimiter.acquire(userId);
    if (!result.allowed) {
      replyFn(`\u23F3 ${result.reason}`);
      return;
    }
    // Onboarding: if first interaction, prepend a warm context note
    const isNew = !sessionMap.has(chatId);
    let finalTask = task;
    if (isNew && typeof task === 'string') {
      finalTask = `[First interaction with this user. Be warm and welcoming. Ask about their business if relevant. Respond in the user's language.]\n\n${task}`;
    }
    const session = sessionMap.getOrCreate(chatId, engine, TELEGRAM_SYSTEM_PROMPT_SUFFIX);
    void executeRun(bot!, session, chatId, finalTask, lang).finally(() => {
      rateLimiter.release(userId);
    });
  }

  // --- Commands ---
  bot.command('start', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    const isNew = !sessionMap.has(ctx.chat.id);
    void ctx.reply(t(isNew ? 'cmd.start_new' : 'cmd.start', lang), { parse_mode: 'HTML' });
  });

  bot.command('clear', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    sessionMap.clear(ctx.chat.id);
    void ctx.reply(t('cmd.clear', lang));
  });

  bot.command('help', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    void ctx.reply(t('cmd.help', lang), { parse_mode: 'HTML' });
  });

  bot.command('stop', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    const chatId = ctx.chat.id;
    if (hasActiveRun(chatId)) {
      const session = sessionMap.getOrCreate(chatId, engine, TELEGRAM_SYSTEM_PROMPT_SUFFIX);
      void abortRun(chatId, session, bot!);
    } else {
      void ctx.reply(t('cmd.stop_none', lang));
    }
  });

  bot.command('cost', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    void ctx.reply(t('cmd.cost_webui', lang), { parse_mode: 'HTML' });
  });

  bot.command('google', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    void ctx.reply(t('cmd.use_webui', lang), { parse_mode: 'HTML' });
  });

  bot.command('status', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    if (hasActiveRun(ctx.chat.id)) {
      void ctx.reply(t('cmd.status_running', lang));
    } else {
      void ctx.reply(t('cmd.status_idle', lang));
    }
  });

  bot.command('bug', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    const text = ctx.message.text.replace(/^\/bug\s*/, '').trim();

    if (!text) {
      void ctx.reply(t('cmd.bug_usage', lang), { parse_mode: 'HTML' });
      return;
    }

    void (async () => {
      try {
        const { captureUserFeedback, isErrorReportingEnabled } = await import('../../core/error-reporting.js');
        if (!isErrorReportingEnabled()) {
          void ctx.reply(t('cmd.bug_disabled', lang));
          return;
        }

        const userName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || `telegram:${ctx.chat.id}`;
        const eventId = await captureUserFeedback({
          name: userName,
          comments: text,
        });

        if (eventId) {
          void ctx.reply(t('cmd.bug_sent', lang));
        } else {
          void ctx.reply(t('cmd.bug_failed', lang));
        }
      } catch {
        void ctx.reply(t('cmd.bug_failed', lang));
      }
    })();
  });

  // --- Text messages ---
  bot.on(message('text'), (ctx) => {
    if (ctx.message.from.is_bot) return;

    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const langCode = ctx.from?.language_code;
    const lang = detectLang(langCode);

    if (resolveInput(chatId, text)) return;

    if (hasActiveRun(chatId)) {
      void ctx.reply(t('msg.busy', lang));
      return;
    }

    rateLimitedRun(chatId, text, langCode, (msg) => void ctx.reply(msg));
  });

  // --- Document messages ---
  bot.on(message('document'), async (ctx) => {
    if (ctx.message.from.is_bot) return;

    const chatId = ctx.chat.id;
    const langCode = ctx.from?.language_code;
    const lang = detectLang(langCode);

    if (hasActiveRun(chatId)) {
      void ctx.reply(t('msg.busy', lang));
      return;
    }

    try {
      const file = ctx.message.document;
      if (file.file_size !== undefined && file.file_size > MAX_DOCUMENT_BYTES) {
        void ctx.reply(t('msg.file_too_large', lang));
        return;
      }
      const fileLink = await ctx.telegram.getFileLink(file.file_id);
      const caption = ctx.message.caption ?? '';
      // Filename + caption are both attacker-controlled — a Telegram user
      // can rename the file or set any caption text before forwarding it.
      // The download URL itself is generated by Telegram and trusted.
      const untrusted = wrapChannelMessage({
        source: `telegram:document:${chatId}`,
        fields: { Filename: file.file_name ?? 'unknown', Caption: caption },
      });
      const task = `Analyze the file at: ${fileLink.href}\n${untrusted}`.trim();
      rateLimitedRun(chatId, task, langCode, (msg) => void ctx.reply(msg));
    } catch {
      void ctx.reply(t('msg.file_error', lang));
    }
  });

  // --- Photo messages (Vision — sends image as base64 content block) ---
  bot.on(message('photo'), async (ctx) => {
    if (ctx.message.from.is_bot) return;

    const chatId = ctx.chat.id;
    const langCode = ctx.from?.language_code;
    const lang = detectLang(langCode);

    if (hasActiveRun(chatId)) {
      void ctx.reply(t('msg.busy', lang));
      return;
    }

    try {
      const photo = ctx.message.photo[ctx.message.photo.length - 1]!;
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const response = await fetch(fileLink.href);
      if (!response.ok) {
        void ctx.reply(t('msg.image_error', lang));
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_IMAGE_BYTES) {
        void ctx.reply(t('msg.image_error', lang));
        return;
      }
      const base64 = buffer.toString('base64');
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
      // The caption ships next to the image as an instruction-like text
      // block, so a user-supplied caption needs the same untrusted wrap
      // every other inbound channel uses. The fallback string is our own
      // hardcoded default and stays trusted.
      const userCaption = ctx.message.caption ?? '';
      const captionText = userCaption
        ? wrapChannelMessage({
            source: `telegram:image:${chatId}`,
            fields: { Caption: userCaption },
          })
        : 'Analyze this image.';
      const content: unknown[] = [
        { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
        { type: 'text', text: captionText },
      ];
      rateLimitedRun(chatId, content, langCode, (msg) => void ctx.reply(msg));
    } catch {
      void ctx.reply(t('msg.image_error', lang));
    }
  });

  // --- Voice messages ---
  bot.on(message('voice'), async (ctx) => {
    if (ctx.message.from.is_bot) return;

    const chatId = ctx.chat.id;
    const langCode = ctx.from?.language_code;
    const lang = detectLang(langCode);

    if (hasActiveRun(chatId)) {
      void ctx.reply(t('msg.busy', lang));
      return;
    }

    if (!HAS_WHISPER) {
      void ctx.reply(t('msg.voice_unavailable', lang));
      return;
    }

    try {
      const voice = ctx.message.voice;
      const fileLink = await ctx.telegram.getFileLink(voice.file_id);
      const response = await fetch(fileLink.href);
      if (!response.ok) {
        void ctx.reply('Could not download voice message.');
        return;
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);


      void ctx.reply(t('msg.voice_transcribing', lang));
      // Session context: CRM contacts + API profile names + recent thread titles +
      // KG entities let the session glossary correct proper-noun mishearings for
      // this user's vocabulary. The Telegram TelegramEngine exposes the same
      // store getters as the full Engine class, so the cast is structural-safe.
      const sessionContext = extractSessionContext(engine as unknown as Engine, String(chatId));
      const text = await transcribe(buffer, `voice-${chatId}.ogg`, {
        language: lang,
        session: sessionContext,
      });
      if (!text) {
        void ctx.reply(t('msg.voice_failed', lang));
        return;
      }

      const caption = ctx.message.caption ?? '';
      // Wrap transcript AND caption together — caption was previously
      // appended raw, which let a sender attach "Ignore previous
      // instructions" to a benign voice note and have it land in the
      // trusted framing.
      const task = wrapChannelMessage({
        source: `telegram:voice:${chatId}`,
        fields: { 'Voice transcript': text, Caption: caption },
      });
      rateLimitedRun(chatId, task, langCode, (msg) => void ctx.reply(msg));
    } catch {
      void ctx.reply(t('msg.voice_failed', lang));
    }
  });

  // --- Callback queries (inline keyboard buttons) ---
  bot.on('callback_query', (ctx) => {
    // Safe wrapper — answerCbQuery throws on stale/expired queries
    const ack = (text?: string): void => {
      void ctx.answerCbQuery(text).catch(() => {});
    };

    const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!data) {
      ack();
      return;
    }

    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      ack();
      return;
    }

    // Inquiry callbacks: q:<taskId>:<optionIndex>
    if (data.startsWith('q:')) {
      const parts = data.split(':');
      const taskId = parts[1];
      const optionIndex = parseInt(parts[2] ?? '0', 10);
      if (taskId) {
        void (async () => {
          const { escapeHtml } = await import('./telegram-formatter.js');
          const inquiry = getTaskInquiry(taskId);
          if (inquiry) {
            const answer = inquiry.options?.[optionIndex] ?? String(optionIndex);
            const workerLoop = engine.getWorkerLoop();
            if (workerLoop?.resolveTaskInput(taskId, answer)) {
              clearTaskInquiry(taskId);
              ack('Answered');
              // Edit the question message to show it was answered
              try {
                const msg = ctx.callbackQuery.message;
                if (msg) {
                  await ctx.telegram.editMessageText(
                    chatId, msg.message_id, undefined,
                    `\u2705 <b>Answered:</b> ${escapeHtml(answer)}`,
                    { parse_mode: 'HTML' },
                  );
                }
              } catch { /* best-effort edit */ }
            } else {
              ack('Question expired');
            }
          } else {
            ack('Question expired');
          }
        })();
      } else {
        ack();
      }
      return;
    }

    // Task follow-up callbacks use colon-delimited format: t:<taskId>:<index>
    if (data.startsWith('t:')) {
      const parts = data.split(':');
      const taskId = parts[1];
      const index = parseInt(parts[2] ?? '0', 10);
      if (taskId) {
        void (async () => {
          const followUp = getTaskFollowUp(taskId, index);
          if (followUp) {
            if (hasActiveRun(chatId)) {
              ack('A task is already running.');
              return;
            }
            const rl = rateLimiter.acquire(String(chatId));
            if (!rl.allowed) {
              ack(rl.reason ?? 'Rate limit reached.');
              return;
            }
            ack('Starting…');
            const contextualTask = `[Following up on background task "${taskId}"]\n\n${followUp.task}`;
            const cbLang = detectLang(ctx.from?.language_code);
            const cbSession = sessionMap.getOrCreate(chatId, engine, TELEGRAM_SYSTEM_PROMPT_SUFFIX);
            void executeRun(bot!, cbSession, chatId, contextualTask, cbLang).finally(() => {
              rateLimiter.release(String(chatId));
            });
          } else {
            ack(t('msg.followup_expired', detectLang(ctx.from?.language_code)));
          }
        })();
      } else {
        ack();
      }
      return;
    }

    // JSON-encoded callbacks (existing format)
    let parsed: { t: string; v?: string; i?: number };
    try {
      parsed = JSON.parse(data) as { t: string; v?: string; i?: number };
    } catch {
      ack();
      return;
    }

    switch (parsed.t) {
      case 'a': // Answer
        // Preferred encoding: integer index against run.pendingInput.options
        // (callback_data stays ≤12 bytes regardless of option length).
        if (typeof parsed.i === 'number') {
          if (resolveInputByIndex(chatId, parsed.i)) {
            ack('Selected');
          } else {
            ack('Question expired');
          }
          break;
        }
        // Legacy fallback: full value in `v`. Kept so a Telegram client
        // that still has an old in-flight prompt button can answer; new
        // prompts emit only the index form. Check the resolve result so a
        // stale click after the run has ended acks "Question expired"
        // instead of misleadingly echoing "Selected: …".
        if (parsed.v) {
          if (resolveInput(chatId, parsed.v)) {
            ack(`Selected: ${parsed.v}`);
          } else {
            ack('Question expired');
          }
        } else {
          ack();
        }
        break;

      case 's': // Stop
        if (hasActiveRun(chatId)) {
          const stopSession = sessionMap.getOrCreate(chatId, engine, TELEGRAM_SYSTEM_PROMPT_SUFFIX);
          void abortRun(chatId, stopSession, bot!);
          ack('Stopping…');
        } else {
          ack('No active task.');
        }
        break;

      case 'f': { // Follow-up suggestion
        const index = typeof parsed.i === 'number' ? parsed.i : -1;
        const followUpTask = getFollowUpTask(chatId, index);
        if (!followUpTask) {
          ack(t('msg.followup_expired', detectLang(ctx.from?.language_code)));
          break;
        }
        if (hasActiveRun(chatId)) {
          ack('A task is already running.');
          break;
        }
        const rl = rateLimiter.acquire(String(chatId));
        if (!rl.allowed) {
          ack(rl.reason ?? 'Rate limit reached.');
          break;
        }
        ack('Starting…');
        const cbLang = detectLang(ctx.from?.language_code);
        const fuSession = sessionMap.getOrCreate(chatId, engine, TELEGRAM_SYSTEM_PROMPT_SUFFIX);
        void executeRun(bot!, fuSession, chatId, followUpTask, cbLang).finally(() => {
          rateLimiter.release(String(chatId));
        });
        break;
      }

      default:
        ack();
    }
  });

  // --- Launch (long polling) ---
  process.stderr.write('LYNOX Telegram bot starting (long polling)…\n');

  // Graceful stop — store reference for cleanup
  signalHandler = () => {
    void bot?.stop('SIGTERM');
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);

  startEvictionTimer();
  await bot.launch();
  process.stderr.write('LYNOX Telegram bot running.\n');
}

/** Return the live Telegraf instance (or null if not started). */
export function getTelegramBot(): Telegraf | null {
  return bot;
}

export async function stopTelegramBot(): Promise<void> {
  stopEvictionTimer();
  if (signalHandler) {
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    signalHandler = null;
  }
  if (bot) {
    bot.stop('shutdown');
    bot = null;
  }
}
