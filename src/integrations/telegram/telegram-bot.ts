// === Telegram Bot ===
// Telegraf setup, message routing, commands.

import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { executeRun, hasActiveRun, resolveInput, abortRun, getFollowUpTask } from './telegram-runner.js';
import { getTaskInquiry, clearTaskInquiry, getTaskFollowUp } from './telegram-callbacks.js';
import { sessionMap, startEvictionTimer, stopEvictionTimer } from './telegram-session.js';
import type { TelegramEngine } from './telegram-session.js';
import { t, detectLang } from './telegram-i18n.js';
import { getErrorMessage } from '../../core/utils.js';
import { createRateLimiterFromEnv } from '../../core/rate-limiter.js';
import { wrapUntrustedData } from '../../core/data-boundary.js';

// --- Voice transcription via whisper.cpp ---

const WHISPER_PATHS = [
  '/usr/local/bin/whisper-cli',
  '/opt/homebrew/bin/whisper-cli',
];
const WHISPER_MODEL_PATHS = [
  '/usr/share/whisper/ggml-base.bin',
  join(process.env['HOME'] ?? '', '.local/share/whisper/ggml-base.bin'),
];

const WHISPER_CLI = WHISPER_PATHS.find(p => existsSync(p));
const WHISPER_MODEL = WHISPER_MODEL_PATHS.find(p => existsSync(p));
const HAS_WHISPER = !!WHISPER_CLI && !!WHISPER_MODEL;

function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

async function transcribeAudio(buffer: Buffer, filename: string): Promise<string | null> {
  if (!HAS_WHISPER) return null;

  const id = randomUUID().slice(0, 8);
  const inputPath = join('/tmp', `whisper-in-${id}-${filename}`);
  const wavPath = join('/tmp', `whisper-${id}.wav`);
  const cleanup = () => {
    try { unlinkSync(inputPath); } catch { /* ok */ }
    try { unlinkSync(wavPath); } catch { /* ok */ }
  };
  try {
    writeFileSync(inputPath, buffer);
    await runCommand('ffmpeg', [
      '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath,
    ]);
    const { stdout } = await runCommand(WHISPER_CLI!, [
      '-m', WHISPER_MODEL!, '-f', wavPath, '--language', 'auto', '--no-timestamps',
    ]);
    const text = stdout.trim();
    cleanup();
    return text || null;
  } catch (err: unknown) {
    cleanup();
    process.stderr.write(`Whisper transcription failed: ${getErrorMessage(err)}\n`);
    return null;
  }
}

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
    if (process.env['NODYN_TELEGRAM_OPEN_ACCESS'] === 'true') {
      process.stderr.write('\n⚠ SECURITY WARNING: NODYN_TELEGRAM_OPEN_ACCESS=true — bot is accessible to ALL Telegram users.\n  Set TELEGRAM_ALLOWED_CHAT_IDS env var to restrict access.\n\n');
    } else {
      // Setup mode: show chat ID to any user, don't process tasks
      process.stderr.write('\nNODYN Telegram: Setup mode — no TELEGRAM_ALLOWED_CHAT_IDS configured.\n  Bot will show chat IDs to users. Set the IDs and restart.\n\n');
      bot.use((ctx, next) => {
        const chatId = ctx.chat?.id;
        if (chatId !== undefined) {
          void ctx.reply(
            `🔧 <b>Setup</b>\n\n`
            + `Your chat ID is: <code>${chatId}</code>\n\n`
            + `Add this to your deployment:\n`
            + `<code>TELEGRAM_ALLOWED_CHAT_IDS=${chatId}</code>\n\n`
            + `Then restart nodyn.`,
            { parse_mode: 'HTML' },
          );
        }
        return next();
      });
      // Don't register any commands or handlers — just the setup middleware
      startEvictionTimer();
      await bot.launch();
      process.stderr.write('NODYN Telegram bot running (setup mode).\n');
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

  bot.command('secret', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    void ctx.reply(t('cmd.secret', lang), { parse_mode: 'HTML' });
  });

  bot.command('cost', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    const chatId = ctx.chat.id;
    if (!sessionMap.has(chatId)) {
      void ctx.reply(`\uD83D\uDCB0 <b>${t('cost.session', lang)}:</b> $0.0000`, { parse_mode: 'HTML' });
      return;
    }
    const session = sessionMap.getOrCreate(chatId, engine, TELEGRAM_SYSTEM_PROMPT_SUFFIX);
    const u = session.usage;
    const inputCost = (u.input_tokens * 15 + u.cache_creation_input_tokens * 18.75 + u.cache_read_input_tokens * 1.5) / 1_000_000;
    const outputCost = (u.output_tokens * 75) / 1_000_000;
    const total = inputCost + outputCost;
    void ctx.reply(
      `\uD83D\uDCB0 <b>${t('cost.session', lang)}:</b> $${total.toFixed(4)}`,
      { parse_mode: 'HTML' },
    );
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
        const { captureUserFeedback, isSentryEnabled } = await import('../../core/sentry.js');
        if (!isSentryEnabled()) {
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
      const task = `Analyze the file at: ${fileLink.href}\nFilename: ${file.file_name ?? 'unknown'}\n${caption}`.trim();
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
      const caption = ctx.message.caption || 'Analyze this image.';
      const content: unknown[] = [
        { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
        { type: 'text', text: caption },
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
      const text = await transcribeAudio(buffer, `voice-${chatId}.ogg`);
      if (!text) {
        void ctx.reply(t('msg.voice_failed', lang));
        return;
      }

      const caption = ctx.message.caption ?? '';
      // Wrap transcribed text as untrusted — voice content could contain injection if whisper model is manipulated
      const task = `[Voice message]: ${wrapUntrustedData(text, 'telegram:voice_transcription')}\n${caption}`.trim();
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
        if (parsed.v) {
          resolveInput(chatId, parsed.v);
          ack(`Selected: ${parsed.v}`);
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
  process.stderr.write('NODYN Telegram bot starting (long polling)…\n');

  // Graceful stop — store reference for cleanup
  signalHandler = () => {
    void bot?.stop('SIGTERM');
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);

  startEvictionTimer();
  await bot.launch();
  process.stderr.write('NODYN Telegram bot running.\n');
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
