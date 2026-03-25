// === Telegram Bot ===
// Telegraf setup, message routing, commands.

import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { StreamHandler } from '../../types/index.js';
import { executeRun, hasActiveRun, resolveInput, abortRun, getFollowUpTask } from './telegram-runner.js';
import { chatSessions, startEvictionTimer, stopEvictionTimer } from './telegram-session.js';
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

// Duck-typed Session interface — avoids importing Session directly (circular)
interface NodynInstance {
  run(task: string | unknown[]): Promise<string>;
  abort(): void;
  reset(): void;
  saveMessages(): unknown[];
  loadMessages(msgs: unknown[]): void;
  onStream: StreamHandler | null;
  set promptUser(fn: ((question: string, options?: string[]) => Promise<string>) | null);
  readonly usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  getModelTier(): string;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;    // 4MB — Claude's limit is ~5MB base64
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10MB — practical limit for file analysis

export interface TelegramBotOptions {
  token: string;
  allowedChatIds?: number[] | undefined;
  nodyn: NodynInstance;
}

let bot: Telegraf | null = null;
let signalHandler: (() => void) | null = null;

export async function startTelegramBot(options: TelegramBotOptions): Promise<void> {
  const { token, allowedChatIds, nodyn } = options;

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
    const isNew = !chatSessions.has(chatId);
    let finalTask = task;
    if (isNew && typeof task === 'string') {
      finalTask = `[First interaction with this user. Be warm and welcoming. Ask about their business if relevant. Respond in the user's language.]\n\n${task}`;
    }
    void executeRun(bot!, nodyn, chatId, finalTask, lang).finally(() => {
      rateLimiter.release(userId);
    });
  }

  // --- Commands ---
  bot.command('start', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    const isNew = !chatSessions.has(ctx.chat.id);
    void ctx.reply(t(isNew ? 'cmd.start_new' : 'cmd.start', lang), { parse_mode: 'HTML' });
  });

  bot.command('clear', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    chatSessions.clear(ctx.chat.id);
    void ctx.reply(t('cmd.clear', lang));
  });

  bot.command('help', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    void ctx.reply(t('cmd.help', lang), { parse_mode: 'HTML' });
  });

  bot.command('stop', (ctx) => {
    const lang = detectLang(ctx.from?.language_code);
    if (hasActiveRun(ctx.chat.id)) {
      void abortRun(ctx.chat.id, nodyn, bot!);
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
    const u = nodyn.usage;
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

    let parsed: { t: string; v?: string; i?: number };
    try {
      parsed = JSON.parse(data) as { t: string; v?: string; i?: number };
    } catch {
      ack();
      return;
    }

    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
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
          void abortRun(chatId, nodyn, bot!);
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
        void executeRun(bot!, nodyn, chatId, followUpTask, cbLang).finally(() => {
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
